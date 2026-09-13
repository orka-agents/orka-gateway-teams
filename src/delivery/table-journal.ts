import { randomUUID } from 'node:crypto';
import { bindTable, integer, object } from '../storage/table/codec.js';
import { createTableKernel } from '../storage/table/owner.js';
import { DEFAULT_LIMITS, TableError } from '../storage/table/types.js';
import type { DataAction, DataKey, Planner, TableBinding, TableDependencies, TableLimits } from '../storage/table/types.js';
import type { DeliveryRequest } from '../protocol/types.js';
import { requestIdentity, validateClaim, validateOutcome, validateScope } from './identity.js';
import type { RequestIdentity } from './identity.js';
import { audit, corrupt, decodeAlias, decodeOperation, decodeResult, effectiveState, encode, marker, validateMarker } from './table-codec.js';
import type { Operation, Result } from './table-codec.js';
import { DeliveryJournalError } from './types.js';
import type { BeginDeliveryResult, DeliveryClaim, DeliveryJournalPort, DeliveryOutcome, JournalScope, SettlementResult } from './types.js';

/** Journal budget includes active and queued identity-only snapshots. Kernel limits
 * independently bound each physical operation; no request body is retained here. */
export interface TableDeliveryJournalLimits { maxPending?: number; maxPendingBytes?: number; kernel?: Partial<TableLimits> }
type Snapshot = { operation: 'begin'; identity: RequestIdentity } | { operation: 'settle'; claim: DeliveryClaim; outcome: DeliveryOutcome };
type Job = { snapshot: Snapshot; bytes: number; resolve: (value: BeginDeliveryResult | SettlementResult) => void; reject: (error: DeliveryJournalError) => void };
type Lifecycle = 'new' | 'initializing' | 'opening' | 'ready' | 'failed' | 'closing' | 'closed';
const aliasKey = (id: string): DataKey => ({ type: 'alias', id });
const operationKey = (id: string): DataKey => ({ type: 'delivery', id });
function safeError(error: unknown): DeliveryJournalError {
  if (error instanceof DeliveryJournalError) return new DeliveryJournalError(error.code);
  if (error instanceof TableError && ['invalid-input', 'corrupt', 'missing', 'exists', 'busy', 'closed'].includes(error.code))
    return new DeliveryJournalError(error.code as 'invalid-input' | 'corrupt' | 'missing' | 'exists' | 'busy' | 'closed');
  return new DeliveryJournalError('unavailable');
}

/** Synchronous, I/O-free construction retains possible ownership after failed open.
 * Only initialize accepts generic empty genesis; normal open never adopts it. */
export function createTableDeliveryJournal(binding: TableBinding, dependencies: TableDependencies, limits: TableDeliveryJournalLimits = {}) {
  try {
    bindTable(binding); if (binding.kind !== 'delivery') throw new DeliveryJournalError('invalid-input');
    return new TableDeliveryJournal(binding, dependencies, limits);
  } catch (error) { throw safeError(error); }
}
class TableDeliveryJournal implements DeliveryJournalPort {
  private readonly kernel: ReturnType<typeof createTableKernel>;
  private readonly scope: JournalScope;
  private readonly maxPending: number;
  private readonly maxPendingBytes: number;
  private lifecycle: Lifecycle = 'new';
  private epoch = 0;
  private pending = 0;
  private pendingBytes = 0;
  private readonly queue: Job[] = [];
  private active = false;
  private startup?: Promise<void>;
  private closing?: Promise<void>;
  private drained?: () => void;
  constructor(binding: Extract<TableBinding, { kind: 'delivery' }>, dependencies: TableDependencies, limits: TableDeliveryJournalLimits) {
    object(limits, ['maxPending', 'maxPendingBytes', 'kernel']);
    this.maxPending = integer(limits.maxPending ?? DEFAULT_LIMITS.maxPending, 1, 1024);
    this.maxPendingBytes = integer(limits.maxPendingBytes ?? DEFAULT_LIMITS.maxPendingBytes, 1, 256 * 1024 * 1024);
    this.scope = validateScope(binding.scope);
    this.kernel = createTableKernel(binding, dependencies, limits.kernel);
  }
  status() {
    return Object.freeze({ lifecycle: this.lifecycle, pending: this.pending, pendingBytes: this.pendingBytes, kernel: this.kernel.status() });
  }
  initialize(): Promise<void> { return this.start(true); }
  open(): Promise<void> { return this.start(false); }
  private start(initialize: boolean): Promise<void> {
    if (this.lifecycle !== 'new') return Promise.reject(new DeliveryJournalError(this.lifecycle === 'closed' || this.closing ? 'closed' : 'unavailable'));
    this.lifecycle = initialize ? 'initializing' : 'opening';
    this.startup = this.startOwned(initialize); return this.startup;
  }
  private async startOwned(initialize: boolean): Promise<void> {
    try {
      if (initialize) await this.kernel.initialize();
      await this.kernel.acquire();
      const records = await this.kernel.scan();
      this.epoch = this.domain(() => audit(records, initialize));
      if (this.closing) throw new DeliveryJournalError('closed');
      if (initialize) {
        const result = await this.kernel.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({
          state: marker(), result: encode({ schema: 1, operation: 'initialize' }), actions: [],
        }));
        if (result.kind !== 'committed') throw new DeliveryJournalError('unavailable');
        await this.kernel.close(); this.lifecycle = 'closed';
      } else this.lifecycle = 'ready';
    } catch (error) { await this.retire(); throw safeError(error); }
  }
  begin(request: Readonly<DeliveryRequest>): Promise<BeginDeliveryResult> {
    // Deliberately not async: no suspended frame or queued closure retains request.
    this.check(); const identity = requestIdentity(request, this.scope);
    return this.enqueue({ operation: 'begin', identity }) as Promise<BeginDeliveryResult>;
  }
  settle(inputClaim: Readonly<DeliveryClaim>, inputOutcome: Readonly<DeliveryOutcome>): Promise<SettlementResult> {
    this.check(); const claim = validateClaim(inputClaim); const outcome = validateOutcome(inputOutcome);
    return this.enqueue({ operation: 'settle', claim, outcome }) as Promise<SettlementResult>;
  }
  private check(): void {
    if (this.closing || this.lifecycle === 'closed') throw new DeliveryJournalError('closed');
    if (this.lifecycle !== 'ready') throw new DeliveryJournalError('unavailable');
  }
  private enqueue(snapshot: Snapshot): Promise<BeginDeliveryResult | SettlementResult> {
    const bytes = encode(snapshot).length;
    if (this.pending >= this.maxPending || this.pendingBytes + bytes > this.maxPendingBytes) return Promise.reject(new DeliveryJournalError('busy'));
    return new Promise((resolve, reject) => {
      this.pending++; this.pendingBytes += bytes; this.queue.push({ snapshot, bytes, resolve, reject }); this.pump();
    });
  }
  private pump(): void {
    if (this.active || this.lifecycle !== 'ready') return;
    const job = this.queue.shift(); if (!job) return; this.active = true;
    void this.run(job.snapshot).then(result => this.finish(job, { result }), error => this.finish(job, { error: safeError(error) }));
  }
  private finish(job: Job, outcome: { result: BeginDeliveryResult | SettlementResult } | { error: DeliveryJournalError }): void {
    this.active = false; this.pending--; this.pendingBytes -= job.bytes;
    if ('error' in outcome) job.reject(outcome.error); else job.resolve(outcome.result);
    this.drained?.(); this.pump();
  }
  private rejectQueued(): void {
    for (const job of this.queue.splice(0)) {
      this.pending--; this.pendingBytes -= job.bytes; job.reject(new DeliveryJournalError(this.closing ? 'closed' : 'unavailable'));
    }
  }
  private async retire(): Promise<void> {
    if (!this.closing) this.lifecycle = 'failed'; this.rejectQueued();
    // Never await journal.close here: it awaits this active journal operation.
    // Kernel close instead tracks actual work/reconciliation/native transport drain,
    // including work whose caller promise has already rejected on its timer.
    await this.kernel.close().catch(() => undefined);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifecycle = 'closing';
    const drained = new Promise<void>(resolve => { if (this.active) this.drained = resolve; else resolve(); });
    const kernelClose = this.kernel.close();
    this.closing = Promise.allSettled([kernelClose, drained, this.startup]).then(results => {
      this.lifecycle = 'closed';
      if (results[0]!.status === 'rejected') throw new DeliveryJournalError('unavailable');
    });
    this.rejectQueued(); return this.closing;
  }
  private domain<T>(action: () => T): T {
    try { return action(); } catch (error) {
      this.kernel.invalidate(); throw error;
    }
  }
  private async run(snapshot: Snapshot): Promise<BeginDeliveryResult | SettlementResult> {
    try {
      const result = snapshot.operation === 'begin' ? await this.beginIdentity(snapshot.identity) : await this.settleSnapshot(snapshot.claim, snapshot.outcome);
      this.check(); return result;
    } catch (error) { await this.retire(); throw safeError(error); }
  }
  private async mutate(keys: readonly DataKey[], snapshot: Snapshot, planner: Planner): Promise<Result> {
    this.check(); let domainError: unknown;
    const result = await this.kernel.mutate({ input: encode(snapshot), keys }, view => {
      try { return planner(view); } catch (error) {
        domainError = error; this.kernel.invalidate(); throw error;
      }
    }).catch(error => { throw domainError ?? error; });
    if (result.kind !== 'committed') throw new DeliveryJournalError('unavailable');
    return this.domain(() => decodeResult(result.result));
  }
  private async beginIdentity(key: RequestIdentity): Promise<BeginDeliveryResult> {
    // Discover at most two alias targets, then reread the entire finite graph inside
    // the M-fenced mutation. Drift/corruption is not retried or hidden by conflict.
    const aliases = [...new Set([key.idempotencyId, key.deliveryId])];
    const discovered = new Map<string, string | undefined>();
    for (const id of aliases) {
      const record = await this.kernel.read(aliasKey(id));
      discovered.set(id, record ? this.domain(() => decodeAlias(record).idempotencyId) : undefined);
    }
    const targets = new Set([key.idempotencyId, ...[...discovered.values()].filter((id): id is string => id !== undefined)]);
    const aliasIds = [...new Set([...aliases, ...targets])];
    const keys = [...aliasIds.map(aliasKey), ...[...targets].map(operationKey)]; // <=7 unique keys
    const saved = await this.mutate(keys, { operation: 'begin', identity: key }, view => {
      validateMarker(view.state);
      const rows = new Map(keys.map((k, i) => [`${k.type}:${k.id}`, view.records[i]]));
      const alias = (id: string) => { const r = rows.get(`alias:${id}`); return r ? decodeAlias(r).idempotencyId : undefined; };
      for (const id of aliases) if (alias(id) !== discovered.get(id)) corrupt();
      const operations = new Map<string, Operation>();
      for (const id of targets) {
        const record = rows.get(`delivery:${id}`);
        if (record) { const op = decodeOperation(record, this.epoch); if (alias(id) !== id) corrupt(); operations.set(id, op); }
      }
      for (const id of aliasIds) { const target = alias(id); if (target !== undefined && !operations.has(target)) corrupt(); }
      const stable = alias(key.idempotencyId); const delivery = alias(key.deliveryId);
      const existing = operations.get(key.idempotencyId); const actions: DataAction[] = [];
      let result: BeginDeliveryResult;
      if ((stable && stable !== key.idempotencyId) || (delivery && delivery !== key.idempotencyId) || (existing && existing.digest !== key.digest)) result = { kind: 'conflict' };
      else {
        if (!existing && (stable || delivery)) corrupt();
        const state = existing && effectiveState(existing, this.epoch);
        if (!existing || state === 'ready') {
          const operation: Operation = { schema: 1, fingerprint: 1, digest: key.digest, attemptId: randomUUID(), attemptEpoch: this.epoch, state: 'sending', providerMessageId: null };
          const row = rows.get(`delivery:${key.idempotencyId}`);
          actions.push(row ? { kind: 'replace', key: operationKey(key.idempotencyId), etag: row.etag, payload: encode(operation) } :
            { kind: 'create', key: operationKey(key.idempotencyId), payload: encode(operation) });
          result = { kind: 'claimed', claim: { idempotencyId: key.idempotencyId, attemptId: operation.attemptId } };
        } else if (state === 'sending') result = { kind: 'inFlight' };
        else if (state === 'delivered') result = { kind: 'delivered', providerMessageId: existing.providerMessageId! };
        else result = { kind: state as 'rejected' | 'unknown' };
        for (const id of aliases) if (alias(id) === undefined) actions.push({ kind: 'create', key: aliasKey(id), payload: encode({ schema: 1, idempotencyId: key.idempotencyId }) });
      }
      return { state: marker(), result: encode({ schema: 1, operation: 'begin', identity: key, result }), actions };
    });
    if (saved.operation !== 'begin') return this.domain(corrupt); return saved.result;
  }
  private async settleSnapshot(claim: DeliveryClaim, outcome: DeliveryOutcome): Promise<SettlementResult> {
    const saved = await this.mutate([operationKey(claim.idempotencyId), aliasKey(claim.idempotencyId)], { operation: 'settle', claim, outcome }, view => {
      validateMarker(view.state); const [record, self] = view.records; const actions: DataAction[] = [];
      const operation = record ? decodeOperation(record, this.epoch) : undefined;
      const target = self ? decodeAlias(self).idempotencyId : undefined;
      if (operation && target !== claim.idempotencyId) corrupt();
      // A missing operation may have an alias to a different stable operation:
      // SQLite settle looks up only the claimed operation in that case.
      if (!operation && target === claim.idempotencyId) corrupt();
      let result: SettlementResult = 'stale';
      if (operation && operation.attemptId === claim.attemptId) {
        const state = outcome.kind === 'retryable' ? 'ready' : outcome.kind;
        const providerMessageId = outcome.kind === 'delivered' ? outcome.providerMessageId : null;
        if (effectiveState(operation, this.epoch) !== 'sending') {
          if (effectiveState(operation, this.epoch) === state && operation.providerMessageId === providerMessageId) result = 'unchanged';
        } else {
          actions.push({ kind: 'replace', key: operationKey(claim.idempotencyId), etag: record!.etag, payload: encode({ ...operation, state, providerMessageId }) }); result = 'recorded';
        }
      }
      return { state: marker(), result: encode({ schema: 1, operation: 'settle', claim, outcome, result }), actions };
    });
    if (saved.operation !== 'settle') return this.domain(corrupt); return saved.result;
  }
}
