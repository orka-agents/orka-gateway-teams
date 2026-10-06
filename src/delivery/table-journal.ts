import { randomUUID } from 'node:crypto';
import { bindTable, integer, object } from '../storage/table/codec.js';
import { createTableKernel, createTableKernelV2 } from '../storage/table/owner.js';
import { DEFAULT_LIMITS, TableError } from '../storage/table/types.js';
import type { BoundTable, DataAction, DataKey, Plan, PlannerView, PlannerViewV2, TableBinding, TableDependencies, TableLimits } from '../storage/table/types.js';
import type { DeliveryRequest } from '../protocol/types.js';
import { requestIdentity, validateClaim, validateOutcome, validateScope } from './identity.js';
import type { RequestIdentity } from './identity.js';
import { audit, auditV2Startup, corrupt, countSessionControls, decodeAlias, decodeOperation, decodeResult, decodeSessionControl, effectiveState, encode, marker, sessionControlId, validateMarker } from './table-codec.js';
import type { Operation, Result } from './table-codec.js';
import { DeliveryJournalError } from './types.js';
import type { BeginDeliveryResult, DeliveryClaim, DeliveryJournalPort, DeliveryOutcome, JournalScope, SettlementResult } from './types.js';
import { sessionCorrelationLimit, validateSessionObservation } from './session-correlation.js';
import type { SessionCorrelationPort, SessionObservation, SessionObservationResult } from './session-correlation.js';

/** Journal budget includes active and queued identity-only snapshots. Kernel limits
 * independently bound each physical operation; no request body is retained here. */
export interface TableDeliveryJournalLimits { maxPending?: number; maxPendingBytes?: number; maxSessions?: number; kernel?: Partial<TableLimits> }
type Snapshot = { operation: 'begin'; identity: RequestIdentity } | { operation: 'settle'; claim: DeliveryClaim; outcome: DeliveryOutcome } |
  { operation: 'observe-session'; observation: SessionObservation };
type JobResult = BeginDeliveryResult | SettlementResult | SessionObservationResult;
type Job = { snapshot: Snapshot; bytes: number; resolve: (value: JobResult) => void; reject: (error: DeliveryJournalError) => void };
type Lifecycle = 'new' | 'initializing' | 'opening' | 'ready' | 'failed' | 'closing' | 'closed';
/** Startup-only safe diagnostic; the public journal error code remains unavailable. */
export class TableDeliveryStartupFailure extends DeliveryJournalError {
  readonly startupReason = 'incomplete' as const;
  constructor() { super('unavailable'); }
}
const aliasKey = (id: string): DataKey => ({ type: 'alias', id });
const operationKey = (id: string): DataKey => ({ type: 'delivery', id });
function safeError(error: unknown): DeliveryJournalError {
  try {
    if (error instanceof DeliveryJournalError) {
      const code = error.code;
      switch (code) {
        case 'invalid-input': case 'missing': case 'exists': case 'busy': case 'scope-mismatch':
        case 'unsupported-schema': case 'corrupt': case 'unavailable': case 'closed':
          return new DeliveryJournalError(code);
      }
    } else if (error instanceof TableError) {
      const code = error.code;
      switch (code) {
        case 'invalid-input': case 'corrupt': case 'missing': case 'exists': case 'busy': case 'closed':
          return new DeliveryJournalError(code);
      }
    }
  } catch { /* Caller exceptions can throw during classification; discard them. */ }
  return new DeliveryJournalError('unavailable');
}

/** Synchronous, I/O-free construction retains possible ownership after failed open.
 * Only initialize accepts generic empty genesis; normal open never adopts it. */
export function createTableDeliveryJournal(binding: TableBinding, dependencies: TableDependencies, limits: TableDeliveryJournalLimits = {}) {
  try {
    const bound = bindTable(binding); if (binding.kind !== 'delivery') throw new DeliveryJournalError('invalid-input');
    return new TableDeliveryJournal(binding, dependencies, limits, 1, bound);
  } catch (error) { throw safeError(error); }
}
/** Explicit metadata V2; no migration, fallback or runtime backend selection. */
export function createTableDeliveryJournalV2(binding: TableBinding, dependencies: TableDependencies, limits: TableDeliveryJournalLimits = {}) {
  try {
    // Validate the original closed shape before copying; do not hide invalid descriptors.
    bindTable(binding); if (binding.kind !== 'delivery') throw new DeliveryJournalError('invalid-input');
    const snapshot = { ...binding, scope: validateScope(binding.scope) };
    const bound = bindTable(snapshot);
    // Limits/dependency reflection must not split kernel, request and recovery identity.
    return new TableDeliveryJournal(snapshot, dependencies, limits, 2, bound);
  } catch (error) { throw safeError(error); }
}
type Storage = { format: 1; kernel: ReturnType<typeof createTableKernel> } | { format: 2; kernel: ReturnType<typeof createTableKernelV2> };
type DomainPlanner = (view: PlannerView | PlannerViewV2) => Plan;
class TableDeliveryJournal implements DeliveryJournalPort, SessionCorrelationPort {
  private readonly storage: Storage;
  private get kernel() { return this.storage.kernel; }
  private readonly scope: JournalScope;
  private readonly maxPending: number;
  private readonly maxPendingBytes: number;
  private readonly maxSessions: number;
  private sessionCount = 0;
  private lifecycle: Lifecycle = 'new';
  private epoch = 0;
  private pending = 0;
  private pendingBytes = 0;
  private readonly queue: Job[] = [];
  private active = false;
  private startup?: Promise<void>;
  private startupProof: 'none' | 'pending' | 'validated' | 'invalidated' = 'none';
  private closing?: Promise<void>;
  private drained?: () => void;
  constructor(binding: Extract<TableBinding, { kind: 'delivery' }>, dependencies: TableDependencies, limits: TableDeliveryJournalLimits, format: 1 | 2, private readonly bound: BoundTable) {
    object(limits, ['maxPending', 'maxPendingBytes', 'maxSessions', 'kernel']);
    this.maxSessions = sessionCorrelationLimit(limits.maxSessions);
    this.maxPending = integer(limits.maxPending ?? DEFAULT_LIMITS.maxPending, 1, 1024);
    this.maxPendingBytes = integer(limits.maxPendingBytes ?? DEFAULT_LIMITS.maxPendingBytes, 1, 256 * 1024 * 1024);
    this.scope = validateScope(binding.scope);
    this.storage = format === 1 ? { format, kernel: createTableKernel(binding, dependencies, limits.kernel) } :
      { format, kernel: createTableKernelV2(binding, dependencies, limits.kernel) };
  }
  status() {
    return Object.freeze({ lifecycle: this.lifecycle, pending: this.pending, pendingBytes: this.pendingBytes, kernel: this.kernel.status() });
  }
  initialize(): Promise<void> { return this.start(true); }
  open(): Promise<void> { return this.start(false); }
  private start(initialize: boolean): Promise<void> {
    if (this.lifecycle !== 'new') return Promise.reject(new DeliveryJournalError(this.lifecycle === 'closed' || this.closing ? 'closed' : 'unavailable'));
    this.lifecycle = initialize ? 'initializing' : 'opening';
    // Debt exists before acquisition can submit, even before Exit necessity is known.
    if (this.storage.format === 2) this.startupProof = 'pending';
    this.startup = this.startOwned(initialize); return this.startup;
  }
  private async startOwned(initialize: boolean): Promise<void> {
    try {
      if (initialize) await this.kernel.initialize();
      await this.kernel.acquire();
      if (this.storage.format === 2) {
        const records = await this.storage.kernel.scan();
        this.epoch = this.domain(() => auditV2Startup(this.bound, records, initialize));
        this.sessionCount = this.domain(() => countSessionControls(records, this.maxSessions));
      } else {
        const records = await this.storage.kernel.scan();
        this.epoch = this.domain(() => audit(records, initialize));
        this.sessionCount = this.domain(() => countSessionControls(records, this.maxSessions));
      }
      if (this.closing || this.startupProof === 'invalidated') throw new DeliveryJournalError('closed');
      // No await between validation, lifecycle recheck and discharge. Same-handle
      // epoch-one empty genesis is a complete proof too; normal open cannot adopt it.
      if (this.startupProof === 'pending') this.startupProof = 'validated';
      if (initialize) {
        const result = await this.kernel.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({
          state: marker(), result: encode({ schema: 1, operation: 'initialize' }), actions: [],
        }));
        if (result.kind !== 'committed') throw new DeliveryJournalError('unavailable');
        await this.kernel.close(); this.lifecycle = 'closed';
      } else this.lifecycle = 'ready';
    } catch (error) {
      await this.retire();
      if (!initialize && error instanceof TableError && error.code === 'incomplete') throw new TableDeliveryStartupFailure();
      throw safeError(error);
    }
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
  observeSession(input: Readonly<SessionObservation>): Promise<SessionObservationResult> {
    this.check(); const observation = validateSessionObservation(input);
    return this.enqueue({ operation: 'observe-session', observation }) as Promise<SessionObservationResult>;
  }
  private check(): void {
    if (this.closing || this.lifecycle === 'closed') throw new DeliveryJournalError('closed');
    if (this.lifecycle !== 'ready') throw new DeliveryJournalError('unavailable');
  }
  private enqueue(snapshot: Snapshot): Promise<JobResult> {
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
  private finish(job: Job, outcome: { result: JobResult } | { error: DeliveryJournalError }): void {
    this.active = false; this.pending--; this.pendingBytes -= job.bytes;
    if ('error' in outcome) job.reject(outcome.error); else job.resolve(outcome.result);
    this.drained?.(); this.pump();
  }
  private rejectQueued(): void {
    for (const job of this.queue.splice(0)) {
      this.pending--; this.pendingBytes -= job.bytes; job.reject(new DeliveryJournalError(this.closing ? 'closed' : 'unavailable'));
    }
  }
  private guardStartupRelease(): void {
    if (this.startupProof !== 'pending') return;
    this.startupProof = 'invalidated'; this.kernel.invalidate();
  }
  private async retire(): Promise<void> {
    if (!this.closing) this.lifecycle = 'failed'; this.rejectQueued();
    // Never await journal.close here: it awaits this active journal operation.
    // Kernel close instead tracks actual work/reconciliation/native transport drain,
    // including work whose caller promise has already rejected on its timer.
    this.guardStartupRelease();
    await this.kernel.close().catch(() => undefined);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifecycle = 'closing';
    const drained = new Promise<void>(resolve => { if (this.active) this.drained = resolve; else resolve(); });
    // Must precede the FIRST kernel.close: it schedules release before startup drains.
    this.guardStartupRelease();
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
  private async run(snapshot: Snapshot): Promise<JobResult> {
    try {
      const result = snapshot.operation === 'begin' ? await this.beginIdentity(snapshot.identity) :
        snapshot.operation === 'settle' ? await this.settleSnapshot(snapshot.claim, snapshot.outcome) : await this.observeSnapshot(snapshot.observation);
      this.check(); return result;
    } catch (error) { await this.retire(); throw safeError(error); }
  }
  private async mutate(keys: readonly DataKey[], snapshot: Snapshot, planner: DomainPlanner): Promise<Result> {
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
  private async observeSnapshot(observation: SessionObservation): Promise<SessionObservationResult> {
    const key: DataKey = { type: 'control', id: sessionControlId(observation.sessionDigest) };
    const beforeCount = this.sessionCount;
    // Retained observations and capacity rejection are GET-only. Kernel read
    // fences owned authority before/after lookup; the same FIFO keeps count and
    // immutable first-origin evidence stable without manufacturing an M write.
    const retained = await this.kernel.read(key);
    if (retained) return this.domain(() => {
      const existing = decodeSessionControl(retained);
      if (existing.sessionDigest !== observation.sessionDigest || beforeCount < 1) corrupt();
      return { kind: 'observed', continuation: existing.firstOriginDigest !== observation.originDigest };
    });
    if (beforeCount === this.maxSessions) return { kind: 'full' };
    const saved = await this.mutate([key], { operation: 'observe-session', observation }, view => {
      validateMarker(view.state); const record = view.records[0];
      // Absence cannot change between the fenced read and this owned FIFO plan.
      if (record || beforeCount >= this.maxSessions) corrupt();
      const created = true;
      const result: SessionObservationResult = { kind: 'observed', continuation: false };
      const actions: DataAction[] = [{ kind: 'create', key, payload: encode({ schema: 1, kind: 'session-observation',
        sessionDigest: observation.sessionDigest, firstOriginDigest: observation.originDigest }) }];
      return { state: marker(), result: encode({ schema: 1, operation: 'observe-session', observation, result, created,
        maxSessions: this.maxSessions, sessionCount: beforeCount + Number(created) }), actions };
    });
    if (saved.operation !== 'observe-session' || saved.observation.sessionDigest !== observation.sessionDigest ||
        saved.observation.originDigest !== observation.originDigest || saved.maxSessions !== this.maxSessions ||
        saved.sessionCount !== beforeCount + Number(saved.created)) return this.domain(corrupt);
    // The kernel's exact-M committed/reconciled result, never the SDK ACK, publishes capacity.
    this.sessionCount = saved.sessionCount;
    return saved.result;
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
