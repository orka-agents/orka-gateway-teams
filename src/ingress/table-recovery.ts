import { auditConfig, auditFields } from '../storage/table/audit.js';
import { bindTable, digest, etag, hex, integer, uuid } from '../storage/table/codec.js';
import { createTableForeignInspectorV2, createTableForeignInspectorV3 } from '../storage/table/inspection.js';
import { createTableOperatorReclaimerV2, createTableOperatorReclaimerV3, createTableLeaseExpirerV3 } from '../storage/table/recovery.js';
import { TableError } from '../storage/table/types.js';
import type { DataAction, ForeignInspectionBudget, ForeignInspectionOptions, ForeignOwnerFenceV2, MetadataV3, TableBinding, TableDependencies, TableLeaseDependencies } from '../storage/table/types.js';
import { validateScope } from './codec.js';
import { createInboxAuditProjection } from './table-audit.js';
import type { InboxAuditHeader } from './table-audit.js';
import { encodeSeal, encodeState } from './table-codec.js';
import { InboxIndex } from './table-index.js';
import { encodeResult, stateDigest, validateResult } from './table-result.js';
import { sealKey } from './table-state.js';
import type { InboxRecoveryResult, SealPayload } from './table-types.js';

/** Audit the foreign domain twice, then submit a single fenced recovery batch.
 * Neither inspection nor recovery opens an inbox or grants forwarding permission. */
export async function reclaimTableIngress(binding: TableBinding, dependencies: TableDependencies,
  expected: Readonly<ForeignOwnerFenceV2>, budget: ForeignInspectionBudget, maxIndexBytes: number,
  operatorAttestationDigest: string, options?: ForeignInspectionOptions): Promise<void> {
  return recoverIngress(2, binding, dependencies, expected, budget, maxIndexBytes, operatorAttestationDigest, options);
}

/** Manual recovery still requires independently retained termination evidence. */
export function reclaimTableIngressV3(binding: TableBinding, dependencies: TableLeaseDependencies,
  expected: Readonly<ForeignOwnerFenceV2>, budget: ForeignInspectionBudget, maxIndexBytes: number,
  operatorAttestationDigest: string, options?: ForeignInspectionOptions): Promise<void> {
  return recoverIngress(3, binding, dependencies, expected, budget, maxIndexBytes, operatorAttestationDigest, options);
}

/** Automatic expiry proves the lease boundary, never operator intent or process death. */
export function expireTableIngressV3(binding: TableBinding, dependencies: TableLeaseDependencies,
  expected: Readonly<ForeignOwnerFenceV2>, budget: ForeignInspectionBudget, maxIndexBytes: number,
  options?: ForeignInspectionOptions): Promise<void> {
  return recoverIngress('expiry', binding, dependencies, expected, budget, maxIndexBytes, undefined, options);
}

async function recoverIngress(mode: 2 | 3 | 'expiry', binding: TableBinding, dependencies: TableLeaseDependencies,
  expected: Readonly<ForeignOwnerFenceV2>, budget: ForeignInspectionBudget, maxIndexBytes: number,
  operatorAttestationDigest: string | undefined, options?: ForeignInspectionOptions): Promise<void> {
  let snapshot: TableBinding & { kind: 'ingress' }; let fence: ForeignOwnerFenceV2;
  let limits: ForeignInspectionBudget; let safeOptions: ForeignInspectionOptions;
  let bound: ReturnType<typeof bindTable>;
  try {
    const b = auditFields(binding, ['account', 'table', 'kind', 'storeId', 'scope']);
    if (b.kind !== 'ingress' || Object.keys(b).length !== 5) throw new TableError('invalid-input');
    const scope = validateScope(auditFields(b.scope, ['appId', 'tenantId', 'orkaBaseUrl', 'gatewayNamespace', 'gatewayName']));
    snapshot = { kind: 'ingress', account: b.account as string, table: b.table as string, storeId: b.storeId as string, scope };
    bound = bindTable(snapshot);
    const f = auditFields(expected, ['initId', 'initDigest', 'owner', 'epoch', 'mDigest', 'etag']);
    if (Object.keys(f).length !== 6) throw new TableError('invalid-input');
    fence = { initId: uuid(f.initId), initDigest: hex(f.initDigest), owner: uuid(f.owner),
      epoch: integer(f.epoch, 1, Number.MAX_SAFE_INTEGER), mDigest: hex(f.mDigest), etag: etag(f.etag) };
    if (mode !== 'expiry') hex(operatorAttestationDigest);
    const config = auditConfig<2>({ passes: 2, record() {}, endPass() {}, finalize() {} }, budget, options);
    limits = { maxPages: config.maxPages, maxPageBytes: config.maxPageBytes, maxDurationMs: config.maxDurationMs,
      maxTrackingBytes: config.maxTrackingBytes };
    safeOptions = { ...(config.signal ? { signal: config.signal } : {}), requestTimeoutMs: config.requestTimeoutMs };
  } catch { throw new TableError('invalid-input'); }
  let first: InboxIndex;
  try { first = new InboxIndex(maxIndexBytes); } catch { throw new TableError('invalid-input'); }
  const initial = createInboxAuditProjection(snapshot, first);
  // First audit determines the disposition. The storage API requires state/seal
  // before its own inspection, so its subsequent complete audit must independently
  // reproduce the same domain proof before this disposition can be submitted.
  let inspector: ReturnType<typeof createTableForeignInspectorV2>;
  let expirer: ReturnType<typeof createTableLeaseExpirerV3> | undefined;
  try {
    // One paired clock guard covers the first proof as well as final submission.
    if (mode === 'expiry') expirer = createTableLeaseExpirerV3(snapshot, dependencies, fence);
    inspector = (mode === 2 ? createTableForeignInspectorV2 : createTableForeignInspectorV3)(snapshot, dependencies, fence);
  } catch (error) { initial.dispose(); await expirer?.close(); throw error; }
  try {
    await inspector.inspect(initial.visitor, limits, safeOptions);
    initial.releaseScratch();
    let header: Readonly<InboxAuditHeader> | undefined = initial.result().header;
    const firstTimestamp = header.version.timestamp;
    const expiredLease = mode === 'expiry' ? (header.metadata as MetadataV3).lease : undefined;
    const proof = initial.proof();
    const old = header.state;
    const arm = old.handoffClockArm;
    const existing = arm ? first.sealByGeneration(arm.generation) : undefined;
    if (arm && (arm.ownerEpoch !== old.restartEpoch || old.restartEpoch > fence.epoch ||
        (existing && existing.reason !== 'clock-regression') ||
        (old.currentGeneration !== arm.generation && !(old.currentGeneration === null && existing)))) throw new TableError('unresolved');
    const post = { ...old, handoffClockArm: null, currentGeneration: arm ? null : old.currentGeneration };
    const state = encodeState(post);
    const sealPayload: SealPayload | undefined = arm && !existing ? { schema: 1, kind: 'generation-seal', generation: arm.generation,
      lastOrder: old.records, watermark: old.lastNow, observation: null, epoch: fence.epoch, reason: 'clock-uncertain' } : undefined;
    const seal: DataAction | undefined = sealPayload ? { kind: 'create', key: sealKey(sealPayload.generation),
      payload: encodeSeal(sealKey(sealPayload.generation), sealPayload) } : undefined;
    const disposition: InboxRecoveryResult['disposition'] = arm ? { kind: 'inbox-clock-uncertain', armId: arm.id,
      generation: arm.generation, watermark: old.lastNow } : { kind: 'inbox-unarmed' };
    const encoded = state.toString('base64');
    const dispositionDigest = digest(['orka-inbox-recovery-disposition-v1', bound.bytes.toString('base64'), fence.mDigest,
      encoded, seal ? Buffer.from(seal.payload).toString('base64') : null]);
    // An external operator supplies the attestation; the independently compared
    // foreign proofs authorize the disposition but cannot attest operator intent.
    const attestation = operatorAttestationDigest;
    // Do not retain the first foreign transport after its complete drain.
    await inspector.close();
    // The first graph is no longer needed. Reserve its bounded metadata-derived
    // values from the second index budget while the disposition remains live.
    header = undefined;
    initial.dispose();
    const second = new InboxIndex(maxIndexBytes - 60 * 1024);
    const check = createInboxAuditProjection(snapshot, second);
    let transport: ReturnType<typeof createTableOperatorReclaimerV2>;
    try { transport = expirer ?? (mode === 2 ? createTableOperatorReclaimerV2 : createTableOperatorReclaimerV3)(snapshot, dependencies, fence); }
    catch (error) { check.dispose(); throw error; }
    try {
      const visitor = check.visitor;
      await transport.reclaim({ passes: 2,
        record(pass, record): undefined { visitor.record(pass, record); },
        endPass(pass): undefined { visitor.endPass(pass); },
        finalize(): undefined {
          visitor.finalize();
          const h = check.result().header; const again = check.proof();
          if (h.version.digest !== fence.mDigest || h.version.etag !== fence.etag ||
              h.version.timestamp !== firstTimestamp || again.versions !== proof.versions || again.count !== proof.count) throw new TableError('corrupt');
        },
      }, limits, {
        state, dispositionDigest, ...(mode === 'expiry' ? {} : { operatorAttestationDigest: attestation! }), ...(seal ? { seal } : {}),
        complete(summary) {
          if (summary.dataRowCount !== proof.count + 1 + (seal ? 1 : 0)) throw new TableError('corrupt');
          const operation = mode === 'expiry' ? 'lease-expiry' : 'operator-recovery';
          const result = encodeResult({ schema: 1, operation, invocation: summary.auditId,
            oldEpoch: fence.epoch, originalMDigest: fence.mDigest, disposition,
            postStateDigest: stateDigest(bound, state, 'operator-recovery'), postDataDigest: summary.postDataDigest,
            dataRowCount: summary.dataRowCount });
          const domainDispositionDigest = digest(['orka-inbox-recovery-v2', bound.bytes.toString('base64'), result.toString('base64')]);
          validateResult({ binding: bound,
            metadata: { ...check.result().header.metadata, epoch: fence.epoch, owner: '', operation: mode === 'expiry' ? 'lease-expiry' : 'recover', state, result,
              exit: { oldOwner: fence.owner, oldEpoch: fence.epoch, invocation: summary.auditId,
                originalMDigest: fence.mDigest, planDigest: fence.mDigest, domainDispositionDigest,
                auditId: summary.auditId, auditDigest: summary.auditDigest,
                ...(mode === 'expiry' ? { kind: 'lease-expiry', lease: expiredLease!, observedAt: dependencies.leaseClock?.wallNow() ?? Date.now() } :
                  { kind: 'operator-recovery', operatorAttestationDigest: attestation! }) } },
            state: post,
            graph: { eventByOrder: n => second.eventByOrder(n), eventById: id => second.eventById(id),
              eventByTarget: id => second.eventByTarget(id),
              sealByGeneration: n => sealPayload?.generation === n ? sealPayload : second.sealByGeneration(n) },
            postDataDigest: summary.postDataDigest, dataRowCount: summary.dataRowCount });
          return { result, domainDispositionDigest };
        },
      }, safeOptions);
    } finally { check.dispose(); await transport.close(); }
  } finally { initial.dispose(); await Promise.all([inspector.close(), expirer?.close()]); }
}
