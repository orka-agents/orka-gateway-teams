import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { auditConfig, auditFields, containCallbackPromise } from './audit.js';
import { LeaseTransitionTableClient, RecoveryTableClient } from './client.js';
import { decodeExpiryAudit, encodeExpiryAudit, encodeLease, expiryAuditId, metadataV3 } from './codec-v3.js';
import { expiryClock } from './lease-takeover.js';
import { bindTable, bytes, data, dataRow, digest, etag, fail, hex, initializationDigestV2, integer, metadataV2, recoveryAuditId, encodeRecoveryAudit, uuid } from './codec.js';
import { createTableForeignInspectorV2, createTableForeignInspectorV3 } from './inspection.js';
import { MAX_STATE_BYTES, TableError } from './types.js';
import type { DataAction, ForeignInspectionBudget, ForeignInspectionOptions, ForeignInspectionVisitorV2, ForeignOwnerFenceV2,
  OperatorReclaimDispositionV2, StoredRecordV2, StoredRecordV3, MetadataV3, TableBinding, TableDependencies, TableLeaseDependencies } from './types.js';

/** A submitted recovery without conclusive readback remains uncertain. */
export class TableRecoveryUncertainError extends TableError {
  constructor() { super('unresolved'); }
}

/** A one-use storage transport, not a domain recovery validator or termination proof.
 * The caller MUST supply a trusted complete domain-aware two-pass visitor, independently validated
 * disposition and attestation digest. Do not pass user JSON directly as either argument. */
export function createTableOperatorReclaimerV2(binding: TableBinding, dependencies: TableDependencies, expected: Readonly<ForeignOwnerFenceV2>) {
  return createReclaimer(binding, dependencies, expected, 2, false);
}
export function createTableOperatorReclaimerV3(binding: TableBinding, dependencies: TableLeaseDependencies, expected: Readonly<ForeignOwnerFenceV2>) {
  return createReclaimer(binding, dependencies, expected, 3, false);
}
export function createTableLeaseExpirerV3(binding: TableBinding, dependencies: TableLeaseDependencies, expected: Readonly<ForeignOwnerFenceV2>) {
  return createReclaimer(binding, dependencies, expected, 3, true);
}
type Disposition = Omit<OperatorReclaimDispositionV2, 'operatorAttestationDigest'> & { operatorAttestationDigest?: string };
function createReclaimer(binding: TableBinding, dependencies: TableLeaseDependencies, expected: Readonly<ForeignOwnerFenceV2>, format: 2 | 3, expiry: boolean) {
  let bound; let fence: ForeignOwnerFenceV2; let client: RecoveryTableClient | LeaseTransitionTableClient; let inspector: ReturnType<typeof createTableForeignInspectorV2>;
  const time = expiry ? expiryClock(dependencies.leaseClock) : undefined;
  try {
    const b = auditFields(binding, ['account', 'table', 'storeId', 'kind', 'scope']);
    b.scope = auditFields(b.scope, b.kind === 'ingress' ? ['appId', 'tenantId', 'orkaBaseUrl', 'gatewayNamespace', 'gatewayName'] : ['appId', 'tenantId']);
    bound = bindTable(b as TableBinding);
    const f = auditFields(expected, ['initId', 'initDigest', 'owner', 'epoch', 'mDigest', 'etag']);
    if (Object.keys(f).length !== 6) fail();
    fence = { initId: uuid(f.initId), initDigest: hex(f.initDigest), owner: uuid(f.owner),
      epoch: integer(f.epoch, 1, Number.MAX_SAFE_INTEGER), mDigest: hex(f.mDigest), etag: etag(f.etag) };
    if (fence.initDigest !== initializationDigestV2(bound, fence.initId) || fence.epoch === Number.MAX_SAFE_INTEGER) fail();
    client = format === 2 ? new RecoveryTableClient(bound, dependencies) : new LeaseTransitionTableClient(bound, dependencies);
    inspector = (format === 2 ? createTableForeignInspectorV2 : createTableForeignInspectorV3)(b as TableBinding, dependencies, fence);
  } catch { throw new TableError('invalid-input'); }
  let consumed = false; let closing: Promise<void> | undefined; let active: Promise<void> | undefined;
  let outcome: 'none' | 'own-commit' | 'foreign-clear' = 'none';
  const matches = (row: StoredRecordV2 | undefined) => !!row && row.row === 'M' && row.value.kind === 'metadata' &&
    row.value.owner === fence.owner && row.value.epoch === fence.epoch && row.value.initId === fence.initId &&
    row.value.initDigest === fence.initDigest && row.value.digest === fence.mDigest && row.etag === fence.etag;
  const observe = async (context: { signal: AbortSignal; deadline: number }): Promise<StoredRecordV2> => {
    const current = await client.read('M', context);
    if (current?.value.kind === 'metadata' && current.value.owner === '') throw new TableError('busy');
    if (!matches(current)) throw new TableError('unresolved');
    if (expiry) {
      const m = current!.value as MetadataV3;
      if (!m.lease || !time!.safe(m.lease.expiresAt)) throw new TableError('busy');
    }
    return current!;
  };
  return {
    transitionOutcome() { return outcome; },
    reclaim(visitor: ForeignInspectionVisitorV2, budget: ForeignInspectionBudget, disposition: Disposition,
      options?: ForeignInspectionOptions): Promise<void> {
      if (closing) return Promise.reject(new TableError('closed'));
      if (consumed) return Promise.reject(new TableError('not-submitted'));
      consumed = true;
      active = (async () => {
        let prior: StoredRecordV2 | undefined; let writeAttempted = false;
        try {
          const d = auditFields(disposition, ['state', 'dispositionDigest', 'operatorAttestationDigest', 'seal', 'complete']);
          if (Object.keys(d).length < (expiry ? 3 : 4) || typeof d.complete !== 'function' || (d.seal !== undefined && bound.kind !== 'ingress')) fail();
          const state = bytes(d.state, MAX_STATE_BYTES);
          const dispositionDigest = hex(d.dispositionDigest); const operatorAttestationDigest = expiry ? undefined : hex(d.operatorAttestationDigest);
          if (expiry && d.operatorAttestationDigest !== undefined) fail();
          const complete = d.complete as OperatorReclaimDispositionV2['complete'];
          let seal: DataAction | undefined;
          if (d.seal !== undefined) {
            const a = auditFields(d.seal, ['kind', 'key', 'payload']);
            if (a.kind !== 'create' || Object.keys(a).length !== 3) fail();
            const key = auditFields(a.key, ['type', 'id']);
            if (Object.keys(key).length !== 2 || key.type !== 'control' || typeof key.id !== 'string' || !/^generation:[1-9][0-9]*$/u.test(key.id)) fail();
            seal = { kind: 'create', key: { type: 'control', id: key.id }, payload: bytes(a.payload, 256 * 1024) };
          }
          const config = auditConfig<2>(visitor, budget, options);
          if (config.passes !== 2) fail();
          const duration = config.maxDurationMs;
          const context: import('./client.js').WorkContext = { signal: config.signal ?? new AbortController().signal, deadline: performance.now() + duration };
          prior = await observe(context);
          const invocation = randomUUID();
          const oldLease = (prior.value as MetadataV3).lease;
          const observedAt = expiry ? time!.now() : undefined;
          const auditPayload = expiry ? encodeExpiryAudit({ schema: 1, kind: 'lease-expiry-audit', invocation,
            oldOwner: fence.owner, oldEpoch: fence.epoch, originalMDigest: fence.mDigest, dispositionDigest, lease: oldLease!, observedAt: observedAt! }) :
            encodeRecoveryAudit({ schema: 1, kind: 'operator-recovery-audit', invocation,
              oldOwner: fence.owner, oldEpoch: fence.epoch, originalMDigest: fence.mDigest, dispositionDigest, operatorAttestationDigest: operatorAttestationDigest! });
          const audit = data(bound, { type: 'control', id: expiry ? expiryAuditId(invocation) : recoveryAuditId(invocation) }, auditPayload);
          const additions = [audit, ...(seal ? [data(bound, seal.key, seal.payload)] : [])].map(value =>
            ({ row: dataRow(bound, { type: value.type, id: value.id }), digest: value.digest })).sort((a, b) => a.row < b.row ? -1 : a.row > b.row ? 1 : 0);
          const seed = digest(['orka-recovery-data-v2', bound.bytes.toString('base64')]);
          let preFold = seed; let preCount = 0;
          let fold = seed; let count = 0; let added = 0;
          const push = (row: string, rowDigest: string) => { fold = digest(['orka-recovery-row-v2', fold, row, rowDigest]); count++; };
          const before = (row: string) => { while (added < additions.length && additions[added]!.row < row) {
            push(additions[added]!.row, additions[added]!.digest); added++;
          } if (additions[added]?.row === row) fail(); };
          const invoke = (fn: (this: void, ...args: never[]) => undefined, ...args: unknown[]) => { const output: unknown = Reflect.apply(fn, undefined, args);
            if (output !== undefined) { containCallbackPromise(output); fail(); } };
          const audited: ForeignInspectionVisitorV2 = { passes: 2,
            record(pass, record) { if (pass === 2 && record.row !== 'M') {
              if (record.value.kind !== 'data') fail(); before(record.row); push(record.row, record.value.digest);
              preFold = digest(['orka-recovery-row-v2', preFold, record.row, record.value.digest]); preCount++;
            } invoke(config.record, pass, record); },
            endPass(pass) { invoke(config.endPass, pass); if (pass === 2) before('\uffff'); },
            finalize() { invoke(config.finalize); },
          };
          await inspector.inspect(audited, { maxPages: config.maxPages, maxPageBytes: config.maxPageBytes,
            maxDurationMs: config.maxDurationMs, maxTrackingBytes: config.maxTrackingBytes },
          { ...(config.signal ? { signal: config.signal } : {}), requestTimeoutMs: config.requestTimeoutMs });
          if (closing || context.signal.aborted) throw new TableError('incomplete');
          prior = await observe(context); // Inspector completion alone is never authority to write.
          if (closing || context.signal.aborted || performance.now() >= context.deadline) throw new TableError('incomplete');
          const summary = Object.freeze({ postDataDigest: digest(['orka-recovery-data-end-v2', fold, count]), dataRowCount: count,
            auditId: invocation, auditDigest: audit.digest });
          const finish = (summary: Parameters<OperatorReclaimDispositionV2['complete']>[0]) => {
            let completed: unknown;
            try { completed = Reflect.apply(complete, undefined, [summary]); } catch (error) {
              containCallbackPromise(error); throw new TableError('unresolved');
            }
            if (types.isPromise(completed)) { containCallbackPromise(completed); fail(); }
            const output = auditFields(completed, ['result', 'domainDispositionDigest']);
            if (Object.keys(output).length !== 2) fail();
            return { result: bytes(output.result, MAX_STATE_BYTES), domainDispositionDigest: hex(output.domainDispositionDigest) };
          };
          const { result, domainDispositionDigest } = finish(summary);
          const operation = expiry ? 'lease-expiry' as const : 'recover' as const;
          const plan = digest([operation, fence.mDigest, invocation, audit.digest, domainDispositionDigest,
            state.toString('base64'), result.toString('base64'), seal ? [seal.key.id, Buffer.from(seal.payload).toString('base64')] : null]);
          const original = prior.value;
          if (original.kind !== 'metadata') throw new TableError('unresolved');
          const common = { oldOwner: fence.owner, oldEpoch: fence.epoch, invocation, originalMDigest: fence.mDigest,
            planDigest: plan, domainDispositionDigest, auditId: invocation, auditDigest: audit.digest };
          const value = { ...original, owner: '', invocation, operation, state, result, plan,
            exit: expiry ? { ...common, kind: 'lease-expiry' as const, lease: oldLease!, observedAt: observedAt! } :
              { ...common, kind: 'operator-recovery' as const, operatorAttestationDigest: operatorAttestationDigest! } };
          const next = format === 2 ? metadataV2(bound, value) : metadataV3(bound, { ...value, lease: undefined });
          if (closing || context.signal.aborted || performance.now() >= context.deadline) throw new TableError('incomplete');
          writeAttempted = true;
          if (expiry && !time!.safe(oldLease!.expiresAt)) throw new TableError('busy');
          context.authorizeWrite = () => !closing && (!expiry || time!.safe(oldLease!.expiresAt));
          try { await client.writeRecover(prior as StoredRecordV3, next as MetadataV3, audit, seal, context); } catch { /* ACK is never commit authority. */ }
          // Reconcile on an independent bounded context, after the native write has actually drained.
          const cleanup = { signal: new AbortController().signal, deadline: performance.now() + 30000 };
          let observedM: StoredRecordV2 | undefined; let observedAudit: StoredRecordV2 | undefined;
          try { observedM = await client.read('M', cleanup); observedAudit = await client.read(`control_${Buffer.from(audit.id).toString('base64url')}`, cleanup); } catch { /* Ambiguous: no retry. */ }
          if (observedM?.value.kind === 'metadata' && observedM.value.digest === next.digest && observedM.value.operation === operation &&
              observedM.value.owner === '' && observedM.value.epoch === fence.epoch && observedAudit?.value.kind === 'data' &&
              observedAudit.value.digest === audit.digest && observedAudit.value.payload.equals(audit.payload)) { outcome = 'own-commit'; return; }
          if (expiry && observedM?.value.kind === 'metadata') {
            const m = observedM.value; const x = m.exit;
            if (m.owner && m.epoch > fence.epoch) throw new TableError('busy');
            if (m.owner || m.operation !== 'lease-expiry' || m.epoch !== fence.epoch || m.initId !== fence.initId || m.initDigest !== fence.initDigest ||
                x?.kind !== 'lease-expiry' || x.oldOwner !== fence.owner || x.originalMDigest !== fence.mDigest || !m.state.equals(state) ||
                !encodeLease(x.lease).equals(encodeLease(oldLease))) throw new TableError('unresolved');
            const foreignRow = dataRow(bound, { type: 'control', id: expiryAuditId(x.auditId) });
            const foreign = await client.read(foreignRow, cleanup);
            if (foreign?.value.kind !== 'data' || foreign.value.digest !== x.auditDigest) throw new TableError('unresolved');
            const a = decodeExpiryAudit(foreign.value.payload);
            if (a.invocation !== x.invocation || a.oldOwner !== x.oldOwner || a.oldEpoch !== x.oldEpoch || a.originalMDigest !== x.originalMDigest ||
                a.dispositionDigest !== dispositionDigest || a.observedAt !== x.observedAt || !encodeLease(a.lease).equals(encodeLease(x.lease))) fail();
            const sealRow = seal ? dataRow(bound, seal.key) : undefined;
            const sealDigest = seal ? data(bound, seal.key, seal.payload).digest : undefined;
            const p = [seed, seed]; const q = [seed, seed]; const counts = [0, 0]; const olds = [0, 0]; const seen = [0, 0];
            const proofDuration = Math.floor(Math.min(context.deadline, cleanup.deadline) - performance.now());
            if (proofDuration < 1) throw new TableError('incomplete');
            const proof = createTableForeignInspectorV3(binding, dependencies, { ...fence, owner: '', mDigest: m.digest, etag: observedM.etag });
            try { await proof.inspect({ passes: 2,
              record(pass, row) { if (row.row === 'M') return; const i = pass - 1;
                if (row.value.kind !== 'data') fail();
                p[i] = digest(['orka-recovery-row-v2', p[i], row.row, row.value.digest]); counts[i]!++;
                if (row.row === foreignRow) { if (row.value.digest !== x.auditDigest) fail(); seen[i]!++; }
                else if (row.row === sealRow) { if (row.value.digest !== sealDigest) fail(); seen[i]!++; }
                else { q[i] = digest(['orka-recovery-row-v2', q[i], row.row, row.value.digest]); olds[i]!++; }
              }, endPass() {}, finalize() {
                if (p[0] !== p[1] || q[0] !== preFold || q[1] !== preFold || olds.some(n => n !== preCount) ||
                    counts[0] !== counts[1] || seen.some(n => n !== 1 + (seal ? 1 : 0))) fail();
              },
            }, { maxPages: config.maxPages, maxPageBytes: config.maxPageBytes, maxTrackingBytes: config.maxTrackingBytes,
              maxDurationMs: proofDuration },
            { ...(config.signal ? { signal: config.signal } : {}), requestTimeoutMs: config.requestTimeoutMs }); }
            finally { await proof.close(); }
            const checked = finish({ postDataDigest: digest(['orka-recovery-data-end-v2', p[0], counts[0]]), dataRowCount: counts[0]!,
              auditId: x.auditId, auditDigest: x.auditDigest });
            const foreignPlan = digest([operation, fence.mDigest, x.invocation, x.auditDigest, checked.domainDispositionDigest,
              state.toString('base64'), checked.result.toString('base64'), seal ? [seal.key.id, Buffer.from(seal.payload).toString('base64')] : null]);
            if (!checked.result.equals(m.result) || checked.domainDispositionDigest !== x.domainDispositionDigest || m.plan !== foreignPlan) fail();
            outcome = 'foreign-clear'; return;
          }
          throw new TableError('unresolved');
        } catch (error) {
          if (writeAttempted && error instanceof TableError && error.code === 'unresolved') throw new TableRecoveryUncertainError();
          throw error instanceof TableError ? error : new TableError('invalid-input');
        }
      })();
      return active;
    },
    close(): Promise<void> {
      closing ??= Promise.resolve(active).catch(() => {}).then(async () => {
        const drained = await Promise.allSettled([inspector.close(), client.close()]);
        if (drained.some(result => result.status === 'rejected')) throw new TableError('unavailable');
      }); return closing;
    },
  };
}
