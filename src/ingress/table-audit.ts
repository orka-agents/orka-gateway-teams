import { decodeUpgradeAudit, domainExit, isUpgradeAudit, upgradeEvidence } from '../storage/table/upgrade-codec.js';
import type { TableKernelV2, TableKernelV3 } from '../storage/table/index.js';
import { decodeExpiryAudit, domainFingerprint, expiryAuditId } from '../storage/table/codec-v3.js';
import { TableError } from '../storage/table/types.js';
import { auditConfig, signalAborted } from '../storage/table/audit.js';
import { bindTable, digest, initializationDigestV2, object, decodeRecoveryAudit, recoveryAuditId } from '../storage/table/codec.js';
import type { BoundTable, ForeignInspectionVisitorV2, MetadataV2, MetadataV3, OwnedAuditBudget, OwnedAuditOptions, StoredRecordV2, TableBinding } from '../storage/table/types.js';
import { InboxIndex } from './table-index.js';
import type { IndexVersion, IndexWorkingCredit } from './table-index.js';
import { routeEvidence, routeFields } from './table-index-slots.js';
import { decodeEvent, decodeRoute, decodeSeal, decodeState, encodeSeal } from './table-codec.js';
import { encode, fingerprint, matchRoute, validateScope } from './codec.js';
import { decodeResult, validateResult } from './table-result.js';
import { sealKey } from './table-state.js';
import type { IngressScope } from './types.js';
import type { InboxState } from './table-types.js';

export interface InboxAuditHeader {
  metadata: Readonly<MetadataV2>; state: Readonly<InboxState>; version: Readonly<IndexVersion>;
}
/** Private audit result, NOT Ready or permission to open an armed inbox.
 * The meta credit owns header data until dispose. The store must drop every
 * borrowed header reference before disposal and charge any independent copies. */
export interface AuditedInbox {
  readonly index: InboxIndex; readonly header: Readonly<InboxAuditHeader>; dispose(): void;
}
class InboxAuditResult implements AuditedInbox {
  #header: InboxAuditHeader | undefined;
  constructor(readonly index: InboxIndex, header: InboxAuditHeader, private readonly credit: IndexWorkingCredit) { this.#header = header; }
  get header(): Readonly<InboxAuditHeader> {
    if (!this.#header) throw new TableError('corrupt'); return this.#header;
  }
  dispose(): void {
    if (!this.#header) return;
    this.#header = undefined; this.index.releaseWorking(this.credit); this.index.dispose();
  }
}

/** One private owned job; no initializer, writer, lease, grant or Ready transition.
 * Caller owns the validated binding's shared string sources through completion
 * (including while queued); the auditor retains no source object or Buffer.
 * Owned-job credits cover fresh serialization, header copies and all callbacks.
 * Store normal-open MUST refuse every retained arm, even a valid sealed arm. */
export function auditInbox(kernel: TableKernelV2 | TableKernelV3, binding: TableBinding, budget: OwnedAuditBudget,
  maxIndexBytes: number, options?: OwnedAuditOptions): Promise<AuditedInbox> {
  // Snapshot only immutable scalar/string sources at the external boundary.
  // Their pre-job lifetime belongs to the private caller's input reservation;
  // no caller object, backing buffer or newly serialized binding is queued.
  try {
    object(binding, ['account', 'table', 'kind', 'storeId', 'scope']);
    if (binding.kind !== 'ingress') throw new TableError('invalid-input');
    object(binding.scope); validateScope(binding.scope); bindTable(binding);
    const scope = Object.freeze({ appId: binding.scope.appId, tenantId: binding.scope.tenantId, orkaBaseUrl: binding.scope.orkaBaseUrl,
      gatewayNamespace: binding.scope.gatewayNamespace, gatewayName: binding.scope.gatewayName });
    const snapshot = { account: binding.account, table: binding.table, storeId: binding.storeId, kind: 'ingress' as const, scope };
    // Descriptor/native-brand validation is synchronous, before any admission.
    // The private async frame receives only snapshots, never original arguments.
    const config = auditConfig<2>({ passes: 2, record() {}, endPass() {}, finalize() {} }, budget, options);
    return runAudit(kernel, snapshot, new InboxIndex(maxIndexBytes), { maxPages: config.maxPages, maxPageBytes: config.maxPageBytes,
      maxDurationMs: config.maxDurationMs, maxTrackingBytes: config.maxTrackingBytes, signal: config.signal, requestTimeoutMs: config.requestTimeoutMs });
  } catch { return Promise.reject(new TableError('invalid-input')); }
}

/** Shared trusted domain validator for owned and foreign two-pass traversals.
 * This never grants ownership or forwarding permission. */
export function createInboxAuditProjection(snapshot: TableBinding & { kind: 'ingress'; scope: Readonly<IngressScope> }, index: InboxIndex) {
  const scope = snapshot.scope;
  let meta: IndexWorkingCredit | undefined; let scratch: IndexWorkingCredit | undefined;
  let header: InboxAuditHeader | undefined; let bound: BoundTable | undefined;
  let upgrade: ReturnType<typeof upgradeEvidence> | undefined;
  let fold = ''; let count = 0; let referencedAudit = 0; let referencedDispositionDigest: string | undefined;
  const versions = ['', '']; const versionCounts = [0, 0];
  const visitor: ForeignInspectionVisitorV2 = { passes: 2, record(this: void, pass: 1 | 2, record: Readonly<StoredRecordV2>): undefined {
      if (record.value.kind === 'data') {
        if (!header) throw new TableError('corrupt');
        const d = record.value; const key = { type: d.type, id: d.id };
        const formatUpgrade = isUpgradeAudit(record);
        if (pass === 1) {
          upgrade!.record(record);
          const saved = decodeResult(header.metadata.result);
          const omit = formatUpgrade && (saved.operation === 'initialize' ||
            ((saved.operation === 'operator-recovery' || saved.operation === 'lease-expiry') && saved.oldEpoch <= decodeUpgradeAudit(d.payload).epoch));
          if (!omit) { fold = digest(['orka-recovery-row-v2', fold, record.row, d.digest]); count++; }
        }
        // Index slots prove graph versions; this ordered proof also covers the
        // append-only audit subtype without retaining an unbounded audit index.
        versions[pass - 1] = digest(['orka-inbox-audit-version-v1', versions[pass - 1], record.row,
          record.etag, record.timestamp, d.digest]); versionCounts[pass - 1]!++;
        const version = { etag: record.etag, digest: d.digest, timestamp: record.timestamp };
        const transitionAudit = d.type === 'control' && (d.id.startsWith('control_recovery:') || d.id.startsWith('control_lease_expiry:'));
        if (pass === 2 && !transitionAudit && !formatUpgrade) index.seePass2(key, version);
        if (formatUpgrade) return;
        if (d.type === 'event') {
          const { body, ...event } = decodeEvent(key, d.payload);
          if (pass === 1) index.addEvent({ event: { ...event, externalEventId: d.id },
            bodyEncodingBytes: body === null ? 0 : encode(body).length, payloadBytes: d.payload.length, version });
          else if (body !== null) {
            const route = index.routeByTarget(event.replyTarget);
            if (!route || route.externalEventId !== d.id) throw new TableError('corrupt');
            const summary = routeEvidence(route, scope.tenantId);
            matchRoute(body, summary, scope);
            if (fingerprint(body, summary, scope) !== event.fingerprint) throw new TableError('corrupt');
          }
        } else if (d.type === 'route') {
          const r = decodeRoute(key, d.payload);
          if (r.route.conversation.tenantId !== scope.tenantId) throw new TableError('corrupt');
          if (pass === 1) index.addRoute({ replyTarget: d.id, externalEventId: r.externalEventId, botId: r.route.bot.id,
            conversationId: r.route.conversation.id, ...routeFields(r.route), routeDigest: r.routeDigest, routeEncodingBytes: encode(r.route).length,
            payloadBytes: d.payload.length, version });
        } else if (transitionAudit) {
          const expiry = d.id.startsWith('control_lease_expiry:');
          const audit = expiry ? decodeExpiryAudit(d.payload) : decodeRecoveryAudit(d.payload);
          const kind = expiry ? 'lease-expiry' : 'operator-recovery';
          const m = header.metadata; const x = domainExit(m);
          if ((expiry && !('lease' in m)) || (expiry ? expiryAuditId(audit.invocation) : recoveryAuditId(audit.invocation)) !== d.id ||
              audit.oldEpoch > m.epoch ||
              (audit.oldEpoch === m.epoch && (m.owner !== '' || x?.kind !== kind || x.auditId !== audit.invocation)) ||
              (x?.kind === 'clean-release' && audit.oldEpoch === x.oldEpoch)) throw new TableError('corrupt');
          if (x && x.kind !== 'clean-release' && x.invocation === audit.invocation && x.oldEpoch === audit.oldEpoch &&
              (x.kind !== kind || !x.auditId || !x.auditDigest)) throw new TableError('corrupt');
          if (x && x.kind !== 'clean-release' && x.auditId === audit.invocation) {
            if (x.kind !== kind || x.invocation !== audit.invocation || x.auditDigest !== d.digest ||
                x.oldOwner !== audit.oldOwner || x.oldEpoch !== audit.oldEpoch || x.originalMDigest !== audit.originalMDigest) throw new TableError('corrupt');
            if (x.kind === 'operator-recovery' && (!('operatorAttestationDigest' in audit) ||
                x.operatorAttestationDigest !== audit.operatorAttestationDigest)) throw new TableError('corrupt');
            if (x.kind === 'lease-expiry' && (!('lease' in audit) || x.observedAt !== audit.observedAt ||
                !encode(x.lease).equals(encode(audit.lease)))) throw new TableError('corrupt');
            if (pass === 1) { referencedAudit++; referencedDispositionDigest = audit.dispositionDigest; }
          }
        } else {
          const seal = decodeSeal(key, d.payload);
          if (seal.epoch > header.metadata.epoch) throw new TableError('corrupt');
          if (pass === 1) index.addSeal({ seal, payloadBytes: d.payload.length, version });
        }
        return;
      }
      if (pass === 1) {
        index.begin(); meta = index.reserveWorking('meta', 60 * 1024);
        scratch = index.reserveWorking('scratch', 2240 * 1024);
        bound = bindTable(snapshot);
        fold = digest(['orka-recovery-data-v2', bound.bytes.toString('base64')]);
        const m = record.value;
        upgrade = upgradeEvidence(bound, m);
        if (initializationDigestV2(bound, m.initId) !== m.initDigest || !m.state.length || !m.result.length ||
            m.state.length > 4096 || m.result.length > 4096) throw new TableError('corrupt');
        const state = Buffer.alloc(m.state.length); state.set(m.state);
        const result = Buffer.alloc(m.result.length); result.set(m.result);
        const decoded = decodeState(state); decodeResult(result);
        if (decoded.restartEpoch > m.epoch) throw new TableError('corrupt');
        if (decoded.handoffClockArm) Object.freeze(decoded.handoffClockArm);
        header = Object.freeze({ metadata: Object.freeze({ ...m, state, result, exit: m.exit ? Object.freeze({ ...m.exit,
          ...(m.exit.kind === 'lease-expiry' ? { lease: Object.freeze({ ...m.exit.lease }) } : {}) }) : undefined }),
          state: Object.freeze(decoded), version: Object.freeze({ etag: record.etag, digest: m.digest, timestamp: record.timestamp }) });
      }
      // No second-pass M copy. Kernel proves both snapshots against its same fence.
    }, endPass(this: void, pass: 1 | 2): undefined { index.endPass(pass); }, finalize(this: void): undefined {
      if (versions[0] !== versions[1] || versionCounts[0] !== versionCounts[1]) throw new TableError('corrupt');
      upgrade!.finish();
      const x = domainExit(header!.metadata);
      if (x && x.kind !== 'clean-release' && x.auditId !== undefined && (x.auditId !== x.invocation || referencedAudit !== 1)) throw new TableError('corrupt');
      const h = header!; index.finishBuild(h.state);
      const result = decodeResult(h.metadata.result);
      for (let order = 1; order <= h.state.records;) {
        const event = index.eventByOrder(order)!; const seal = index.sealByGeneration(event.generation);
        if (!seal) break;
        // Only recovery can seal after the last prepared domain epoch. A later
        // unarmed recovery may preserve that final uncertainty interval before
        // any successful open; its older result/Exit need not still be retained.
        if (seal.epoch > h.state.restartEpoch && !((result.operation === 'operator-recovery' || result.operation === 'lease-expiry') &&
            seal.reason === 'clock-uncertain' && seal.epoch <= result.oldEpoch &&
            seal.lastOrder === h.state.records && h.state.currentGeneration === null)) throw new TableError('corrupt');
        order = seal.lastOrder + 1;
      }
      const arm = h.state.handoffClockArm;
      if (arm) {
        const event = index.eventByOrder(arm.order);
        if (arm.ownerEpoch !== h.state.restartEpoch || !event || event.state !== 'forwarding' ||
            event.generation !== arm.generation || event.attemptId !== arm.attemptId || event.attemptEpoch !== arm.ownerEpoch) throw new TableError('corrupt');
      }
      validateResult({ binding: bound!, metadata: h.metadata, state: h.state, graph: index,
        postDataDigest: digest(['orka-recovery-data-end-v2', fold, count]), dataRowCount: count });
      if (x && x.kind !== 'clean-release' && x.auditId !== undefined &&
          (result.operation === 'operator-recovery' || result.operation === 'lease-expiry')) {
        const seal = result.disposition.kind === 'inbox-clock-uncertain' ? index.sealByGeneration(result.disposition.generation) : undefined;
        // A regression seal predates reclaim; only a new uncertain seal is in
        // the writer's disposition commitment. Compare exact canonical bytes.
        const createdSeal = seal?.reason === 'clock-uncertain' ? encodeSeal(sealKey(seal.generation), seal).toString('base64') : null;
        if (referencedDispositionDigest !== digest(['orka-inbox-recovery-disposition-v1', bound!.bytes.toString('base64'),
          result.originalMDigest, h.metadata.state.toString('base64'), createdSeal])) throw new TableError('corrupt');
      }
    } };
  return {
    visitor,
    /** Owned V3 audits may renew M between pages. Publish only a later kernel-
     * checked fence with the exact same domain; foreign proofs stay exact-M. */
    refreshMetadata(record: Readonly<StoredRecordV2>): void {
      if (!header || !bound || record.value.kind !== 'metadata' || !('lease' in record.value) ||
          domainFingerprint(bound, header.metadata as MetadataV3) !== domainFingerprint(bound, record.value as MetadataV3)) throw new TableError('corrupt');
      const m = record.value;
      header = Object.freeze({ ...header,
        metadata: Object.freeze({ ...m, state: Buffer.from(m.state), result: Buffer.from(m.result), exit: m.exit ? Object.freeze({ ...m.exit,
          ...(m.exit.kind === 'lease-expiry' ? { lease: Object.freeze({ ...m.exit.lease }) } : {}) }) : undefined }),
        version: Object.freeze({ etag: record.etag, digest: m.digest, timestamp: record.timestamp }) });
    },
    proof(): Readonly<{ versions: string; count: number }> {
      if (versions[0] !== versions[1] || versionCounts[0] !== versionCounts[1]) throw new TableError('corrupt');
      return { versions: versions[0]!, count: versionCounts[0]! };
    },
    result(): AuditedInbox { if (!header || !meta || !bound) throw new TableError('corrupt'); return new InboxAuditResult(index, header, meta); },
    releaseScratch(): void { if (scratch) { index.releaseWorking(scratch); scratch = undefined; } },
    dispose(): void { header = undefined; this.releaseScratch(); index.dispose(); },
  };
}

async function runAudit(kernel: TableKernelV2 | TableKernelV3, snapshot: TableBinding & { kind: 'ingress'; scope: Readonly<IngressScope> },
  index: InboxIndex, config: OwnedAuditBudget & { signal: AbortSignal | undefined; requestTimeoutMs: number }): Promise<AuditedInbox> {
  const projection = createInboxAuditProjection(snapshot, index);
  let published = false;
  const deadline = performance.now() + config.maxDurationMs;
  try {
    await kernel.auditOwned(projection.visitor, { maxPages: config.maxPages, maxPageBytes: config.maxPageBytes,
      maxDurationMs: config.maxDurationMs, maxTrackingBytes: config.maxTrackingBytes },
    { ...(config.signal ? { signal: config.signal } : {}), requestTimeoutMs: config.requestTimeoutMs });
    if ('lease' in projection.result().header.metadata) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) throw new TableError('incomplete');
      const current = await kernel.read('M', { ...(config.signal ? { signal: config.signal } : {}), timeoutMs: Math.min(remaining, config.requestTimeoutMs) });
      if (!current) throw new TableError('corrupt');
      projection.refreshMetadata(current);
    }
    const status = kernel.status();
    if (status.lifecycle === 'poisoned') throw new TableError('unresolved');
    if (status.lifecycle !== 'envelope-audited' || status.ownership !== 'owned' || performance.now() >= deadline ||
        (config.signal && signalAborted(config.signal))) throw new TableError('incomplete');
    const result = projection.result(); published = true; return result;
  } finally {
    projection.releaseScratch();
    if (!published) projection.dispose();
  }
}
