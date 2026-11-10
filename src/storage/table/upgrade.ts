import { randomUUID } from 'node:crypto';
import { auditConfig, auditFields, signalAborted, subscribeAuditAbort } from './audit.js';
import { runAuditTraversal } from './audit-traversal.js';
import { OwnedTableClient, UpgradeTableClient } from './client.js';
import type { WorkContext } from './client.js';
import { bindTable, data, dataRow, digest, fail, hex, metadataV2 } from './codec.js';
import { metadataV3 } from './codec-v3.js';
import { encodeUpgradeAudit, upgradeAuditId, upgradePlan } from './upgrade-codec.js';
import type { FormatUpgradeAudit } from './upgrade-codec.js';
import { OWNED_AUDIT_BUDGET_EXHAUSTED, TableError } from './types.js';
import type { ForeignInspectionBudget, ForeignInspectionOptions, StoredRecordV2, TableBinding, TableDependencies } from './types.js';
import { createInboxAuditProjection } from '../../ingress/table-audit.js';
import { InboxIndex } from '../../ingress/table-index.js';
import { auditV2Startup } from '../../delivery/table-codec.js';

/** Explicit one-way library transition. No acquire, initialization, listener or provider effect. */
export function upgradeTableIngressV2(binding: TableBinding, dependencies: TableDependencies, budget: ForeignInspectionBudget,
  maxIndexBytes: number, upgradeAttestationDigest: string, options?: ForeignInspectionOptions): Promise<void> {
  return upgrade('ingress', binding, dependencies, budget, upgradeAttestationDigest, options, maxIndexBytes).catch(safeFailure);
}
export function upgradeTableDeliveryV2(binding: TableBinding, dependencies: TableDependencies, budget: ForeignInspectionBudget,
  upgradeAttestationDigest: string, options?: ForeignInspectionOptions): Promise<void> {
  return upgrade('delivery', binding, dependencies, budget, upgradeAttestationDigest, options).catch(safeFailure);
}
function safeFailure(error: unknown): never { throw error instanceof TableError ? error : new TableError('invalid-input'); }
async function upgrade(kind: 'ingress' | 'delivery', binding: TableBinding, dependencies: TableDependencies,
  budget: ForeignInspectionBudget, attestation: string, options?: ForeignInspectionOptions, maxIndexBytes?: number): Promise<void> {
  // Capture identity, descriptors and budgets before dependency reflection or any await.
  const b = auditFields(binding, ['account', 'table', 'kind', 'storeId', 'scope']);
  b.scope = auditFields(b.scope, kind === 'ingress' ? ['appId', 'tenantId', 'orkaBaseUrl', 'gatewayNamespace', 'gatewayName'] : ['appId', 'tenantId']);
  const snapshot = b as TableBinding; const bound = bindTable(snapshot);
  if (bound.kind !== kind) fail();
  const intent = hex(attestation);
  const config = auditConfig<2>({ passes: 2, record() {}, endPass() {}, finalize() {} }, budget, options);
  const native = { token: dependencies.token, ...(dependencies.request ? { request: dependencies.request } : {}) };
  const index = kind === 'ingress' ? new InboxIndex(maxIndexBytes!) : undefined;
  const projection = index ? createInboxAuditProjection(snapshot as TableBinding & { kind: 'ingress' }, index) : undefined;
  const old = new OwnedTableClient(bound, native, 2); const cross = new UpgradeTableClient(bound, native);
  const controller = new AbortController(); const abort = () => controller.abort();
  const remove = config.signal ? subscribeAuditAbort(config.signal, abort) : () => {};
  if (config.signal && signalAborted(config.signal)) abort();
  const deadline = performance.now() + config.maxDurationMs;
  const timer = setTimeout(abort, config.maxDurationMs);
  const check = () => { if (controller.signal.aborted || performance.now() >= deadline) throw new TableError('incomplete'); };
  const context = (): WorkContext => { check(); return { signal: controller.signal,
    deadline: Math.min(deadline, performance.now() + config.requestTimeoutMs) }; };
  try {
    const prior = await old.read('M', context());
    if (!prior) throw new TableError('missing');
    if (prior.value.kind !== 'metadata') fail();
    const m = prior.value;
    if (m.owner) throw new TableError('busy');
    if (m.epoch === Number.MAX_SAFE_INTEGER) fail();
    const same = (r: StoredRecordV2 | undefined) => !!r && r.row === 'M' && r.value.kind === 'metadata' &&
      r.etag === prior.etag && r.value.digest === m.digest;
    const contradiction = (): never => { throw new TableError('unresolved'); };
    const seed = digest(['orka-recovery-data-v2', bound.bytes.toString('base64')]);
    const folds = [seed, seed]; const counts = [0, 0]; const versions = ['', '']; const records: StoredRecordV2[] = [];
    let used = 0;
    await runAuditTraversal(config, { check,
      authority: async () => { if (!same(await old.read('M', context()))) contradiction(); check(); },
      page: (cursor, allowance) => old.page(context(), cursor, allowance), matches: r => same(r as StoredRecordV2), contradiction,
      exhaust: abort,
      record(pass, input) {
        const record = input as StoredRecordV2; const i = pass - 1;
        versions[i] = digest(['upgrade-version', versions[i], record.row, record.etag, record.timestamp, record.value.digest]);
        if (record.value.kind === 'data') {
          folds[i] = digest(['orka-recovery-row-v2', folds[i], record.row, record.value.digest]); counts[i]!++;
        }
        if (m.epoch === 0) { if (record.row !== 'M') contradiction(); return; }
        if (projection) projection.visitor.record(pass, record);
        else if (pass === 1) {
          used += 256 + record.row.length * 2 + record.etag.length * 2 +
            (record.value.kind === 'data' ? record.value.payload.length : record.value.state.length + record.value.result.length);
          if (used > config.maxTrackingBytes) throw OWNED_AUDIT_BUDGET_EXHAUSTED;
          records.push(record);
        }
      },
      endPass(pass) { if (m.epoch > 0) projection?.visitor.endPass(pass); },
    });
    if (versions[0] !== versions[1] || folds[0] !== folds[1] || counts[0] !== counts[1]) contradiction();
    if (m.epoch > 0) {
      if (projection) projection.visitor.finalize();
      else {
        // Validate the unowned graph at its next-epoch projection, without acquiring
        // or persisting that projection. This retains both old recovery commitments.
        const projected = records.map(r => r.row === 'M' ? { ...r, value: { ...m, owner: randomUUID(), epoch: m.epoch + 1, operation: 'acquire' as const } } : r);
        auditV2Startup(bound, projected);
      }
    }
    projection?.dispose(); records.length = 0;
    check(); if (!same(await old.read('M', context()))) contradiction();
    const invocation = randomUUID();
    const a: FormatUpgradeAudit = { schema: 1, kind: 'format-upgrade-audit', invocation, epoch: m.epoch,
      originalMDigest: m.digest, previousInvocation: m.invocation, previousOperation: m.operation, previousPlan: m.plan,
      dataDigest: digest(['orka-recovery-data-end-v2', folds[0], counts[0]]), dataRowCount: counts[0]!, upgradeAttestationDigest: intent };
    const audit = data(bound, { type: 'control', id: upgradeAuditId(invocation) }, encodeUpgradeAudit(a));
    const next = metadataV3(bound, { ...m, lease: undefined, operation: 'format-upgrade', invocation, plan: upgradePlan(a, audit.digest) });
    const writeContext = context();
    try { await cross.writeUpgrade(prior, next, audit, writeContext); } catch { /* ACK is never commit authority. */ }
    // Native/token work has drained, but server commit can still be delayed. Only
    // exact expected M+audit or a confirmed competing V2 barrier resolves that race.
    const cleanupDeadline = performance.now() + Math.min(30000, config.maxDurationMs);
    const cleanup = (): WorkContext => ({ signal: new AbortController().signal,
      deadline: Math.min(cleanupDeadline, performance.now() + config.requestTimeoutMs) });
    let barrier: ReturnType<typeof metadataV2> | undefined;
    for (let attempt = 0; attempt < 4 && performance.now() < cleanupDeadline; attempt++) {
      let observed: StoredRecordV2 | undefined;
      try { observed = await cross.readMetadata(cleanup()); } catch { continue; }
      if (observed?.value.kind !== 'metadata') break;
      if (observed.value.digest === next.digest && 'lease' in observed.value) {
        const row = await cross.read(dataRow(bound, { type: audit.type, id: audit.id }), cleanup()).catch(() => undefined);
        if (row?.value.kind === 'data' && row.value.digest === audit.digest && row.value.payload.equals(audit.payload)) return;
        break;
      }
      if (barrier && observed.value.digest === barrier.digest && !('lease' in observed.value)) throw new TableError('not-submitted');
      if (!same(observed) || 'lease' in observed.value) break;
      if (!barrier) {
        const id = randomUUID(); barrier = metadataV2(bound, { ...m, operation: 'barrier', invocation: id,
          plan: digest(['barrier', m.digest, next.digest, id]) });
        try { await old.write(barrier, prior.etag, [], cleanup()); } catch { /* Read back; never retry the upgrade. */ }
      }
    }
    throw new TableError('unresolved');
  } catch (error) {
    if (error === OWNED_AUDIT_BUDGET_EXHAUSTED || (controller.signal.aborted && error instanceof TableError && error.code === 'unavailable'))
      throw new TableError('incomplete');
    throw error instanceof TableError ? error : new TableError('invalid-input');
  } finally {
    clearTimeout(timer); remove(); projection?.dispose();
    await Promise.all([old.close(), cross.close()]);
  }
}
