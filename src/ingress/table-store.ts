import { auditConfig } from '../storage/table/audit.js';
import { bindTable, initializationDigestV2, integer, object } from '../storage/table/codec.js';
import { createTableKernelV2 } from '../storage/table/index.js';
import { DEFAULT_LIMITS, OWNED_AUDIT_BUDGET_EXHAUSTED, TableError } from '../storage/table/types.js';
import type { OwnedAuditBudget, TableBinding, TableDependencies, TableErrorCode, TableLimits } from '../storage/table/types.js';
import { identity, validatePolicy, validateScope } from './codec.js';
import type { EventEnvelope } from '../protocol/types.js';
import { admissionBound, admissionSources, admission, claimIdentity, commandBytes, FRAME_BYTES, readCommand, settlement } from './table-input.js';
import type { Settlement } from './table-input.js';
import { IngressStoreError } from './types.js';
import type { AdmissionResult, IngressClaim, IngressForwardingGrant, IngressPolicy, IngressPort, IngressReceipt, IngressScope, ReplyRoute } from './types.js';
import { auditInbox } from './table-audit.js';
import type { AuditedInbox } from './table-audit.js';
import { InboxIndex } from './table-index.js';
import type { IndexWorkingCredit } from './table-index.js';
import { decodeRoute, encodeState, encodeSeal } from './table-codec.js';
import { encodeResult, stateDigest } from './table-result.js';
import { advanceClock, initialState, projectEvent, sealKey } from './table-state.js';
import { MAX_INBOX_TIME } from './table-types.js';
import type { ExplicitBlockReason, InboxResultClaim, InboxState, OrdinaryInboxResult } from './table-types.js';
import { mutate, scratch, corrupt, checkRow, admissionKeys, admitPlan, operationKeys, operationPlan } from './table-mutations.js';
import type { OperationCommand } from './table-mutations.js';

export interface TableIngressStoreOptions {
  audit: OwnedAuditBudget; maxIndexBytes: number; policy?: IngressPolicy; now?: (this: void) => number;
  maxPending?: number; maxPendingBytes?: number; kernel?: Partial<TableLimits>;
}
type Lifecycle = 'new' | 'initializing' | 'opening' | 'ready' | 'failed' | 'closing' | 'closed';
type Job = { input: Buffer | undefined; bytes: number; deadline: number; hold?: boolean; resolve: (value: unknown) => void; reject: (error: TableError) => void };
interface Frame {
  credit: IndexWorkingCredit; bytes: number; ownsReservation: boolean;
  state: 'claiming' | 'granted' | 'revalidating' | 'retired' | 'consumed' | 'finalizing' | 'continuation' | 'released';
  permission: boolean; validated: boolean; finalDeadline?: number; continuation?: Job | undefined;
  sampling: 'none' | 'started' | 'captured' | 'failed'; time?: number; claim?: InboxResultClaim | undefined;
}
function safeError(error: unknown): TableError {
  if (error === OWNED_AUDIT_BUDGET_EXHAUSTED) return new TableError('incomplete');
  try {
    if (error instanceof TableError || error instanceof IngressStoreError) {
      const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
      const allowed = error instanceof TableError ? ['invalid-input', 'corrupt', 'missing', 'exists', 'busy', 'unavailable', 'incomplete', 'unresolved', 'not-submitted', 'unready', 'closed'] :
        ['invalid-input', 'corrupt', 'missing', 'exists', 'busy', 'closed'];
      if (typeof code === 'string' && allowed.includes(code)) return new TableError(code as TableErrorCode);
    }
  } catch { /* Caller validation exceptions are not trusted error objects. */ }
  return new TableError('unavailable');
}
function factoryError(error: unknown): TableError {
  try {
    return error instanceof TableError ? safeError(error) : new TableError('invalid-input');
  } catch { return new TableError('invalid-input'); }
}
function fields(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  object(value, keys); const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value as object)) result[key] = Object.getOwnPropertyDescriptor(value, key)!.value;
  return result;
}
function copyString(value: string): string { const b = Buffer.alloc(Buffer.byteLength(value)); b.write(value); return b.toString('utf8'); }

/** Synchronous retained ownership handle. Fixed validated configuration owns its
 * own strings independently of record-index credits. No runtime/backend selector. */
export function createTableIngressStore(binding: TableBinding, dependencies: TableDependencies, options: TableIngressStoreOptions) {
  try {
    const b = fields(binding, ['account', 'table', 'storeId', 'kind', 'scope']);
    const s = validateScope(fields(b.scope)); bindTable({ ...b, scope: s } as TableBinding);
    if (b.kind !== 'ingress') throw new TableError('invalid-input');
    const scope = Object.freeze(Object.fromEntries(Object.entries(s).map(([key, value]) => [key, copyString(value)]))) as Readonly<IngressScope>;
    const snapshot: TableBinding = { kind: 'ingress', account: copyString(b.account as string), table: copyString(b.table as string), storeId: copyString(b.storeId as string), scope };
    const o = fields(options, ['audit', 'maxIndexBytes', 'policy', 'now', 'maxPending', 'maxPendingBytes', 'kernel']);
    const a = auditConfig<2>({ passes: 2, record() {}, endPass() {}, finalize() {} }, o.audit as OwnedAuditBudget);
    const limits = o.kernel === undefined ? {} : fields(o.kernel, Object.keys(DEFAULT_LIMITS));
    const resolved = { ...DEFAULT_LIMITS, ...limits } as TableLimits;
    if (o.now !== undefined && typeof o.now !== 'function') throw new TableError('invalid-input');
    const d = fields(dependencies, ['token', 'request']);
    if (typeof d.token !== 'function' || (d.request !== undefined && typeof d.request !== 'function')) throw new TableError('invalid-input');
    const config = { audit: { maxPages: a.maxPages, maxPageBytes: a.maxPageBytes, maxDurationMs: a.maxDurationMs, maxTrackingBytes: a.maxTrackingBytes },
      maxIndexBytes: integer(o.maxIndexBytes, 1, 1024 * 1024 * 1024), policy: validatePolicy(o.policy === undefined ? undefined : fields(o.policy)),
      now: (o.now ?? Date.now) as (this: void) => number,
      maxPending: integer(o.maxPending ?? 96, 1, 96), maxPendingBytes: integer(o.maxPendingBytes ?? 32 * 1024 * 1024, 1, 32 * 1024 * 1024), kernel: resolved };
    return new TableIngressStore(snapshot, d as unknown as TableDependencies, config);
  } catch (error) { throw factoryError(error); }
}
type Config = Required<TableIngressStoreOptions> & { kernel: TableLimits };
class TableIngressStore implements IngressPort {
  get scope(): Readonly<IngressScope> { return this.binding.scope as Readonly<IngressScope>; }
  private readonly kernel;
  private readonly bound;
  private readonly binding: TableBinding;
  private lifecycle: Lifecycle = 'new';
  private audited: AuditedInbox | undefined;
  private index: InboxIndex | undefined;
  private epoch = 0;
  private knowledge: 'clear' | 'unknown' | 'possible' | 'armed' = 'clear';
  private debt = false;
  private pending = 0; private pendingBytes = 0;
  private queue: Job[] = []; private active = false; private drained: (() => void) | undefined;
  private frame: Frame | undefined;
  private startup: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private cleanup: Promise<void> | undefined;
  constructor(binding: TableBinding, dependencies: TableDependencies, private readonly config: Config) {
    this.binding = binding; this.bound = bindTable(binding);
    this.kernel = createTableKernelV2(binding, dependencies, config.kernel);
  }
  status() { return Object.freeze({ lifecycle: this.lifecycle, pending: this.pending, pendingBytes: this.pendingBytes,
    kernel: this.kernel.status(), index: this.index?.diagnostics() }); }
  initialize(): Promise<void> { return this.start(true); }
  open(): Promise<void> { return this.start(false); }
  private start(initialize: boolean): Promise<void> {
    if (this.lifecycle !== 'new') return Promise.reject(new TableError(this.closing || this.lifecycle === 'closed' ? 'closed' : 'unready'));
    this.lifecycle = initialize ? 'initializing' : 'opening';
    this.startup = this.startOwned(initialize); return this.startup;
  }
  private intake(): void {
    if (this.closing || this.lifecycle === 'closed' || this.lifecycle === 'closing') throw new TableError('closed');
    if (this.lifecycle !== 'ready') throw new TableError('unready');
  }
  private liveStartup(): void {
    if (this.lifecycle === 'closing' || this.lifecycle === 'closed') throw new TableError('closed');
    if (this.lifecycle === 'failed') throw new TableError('unready');
  }
  private deadline(): number { return performance.now() + this.config.kernel.callTimeoutMs; }
  private phase(deadline: number): number {
    const status = this.kernel.status();
    if (status.lifecycle === 'poisoned' || this.lifecycle === 'failed' || this.cleanup) throw new TableError('unresolved');
    if (status.ownership !== 'owned' || this.lifecycle === 'closed') throw new TableError('unready');
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new TableError('incomplete');
    return Math.min(remaining, this.config.kernel.callTimeoutMs);
  }
  private owner() {
    return { kernel: this.kernel, index: this.index!, bound: this.bound, phase: (deadline: number) => this.phase(deadline),
      submitting: (state: Readonly<InboxState>) => { if (state.handoffClockArm && this.knowledge === 'clear') this.knowledge = 'possible'; },
      confirmed: (state: Readonly<InboxState>) => { this.knowledge = state.handoffClockArm ? 'armed' : 'clear'; if (!state.handoffClockArm) this.debt = false; },
      cancelled: () => { this.knowledge = this.index!.state().handoffClockArm ? 'armed' : 'clear'; },
      failure: (error: unknown) => this.failure(error) };
  }
  private async startOwned(initialize: boolean): Promise<void> {
    try {
      if (initialize) { await this.kernel.initialize(); this.liveStartup(); }
      this.knowledge = 'unknown'; await this.kernel.acquire(); this.liveStartup();
      if (initialize) await this.genesis();
      else {
        this.audited = await auditInbox(this.kernel, this.binding, this.config.audit, this.config.maxIndexBytes,
          { requestTimeoutMs: this.config.kernel.callTimeoutMs });
        this.index = this.audited.index;
        this.epoch = this.audited.header.metadata.epoch;
        if (this.audited.header.state.handoffClockArm) corrupt();
        this.knowledge = 'clear'; this.liveStartup();
        // Header M/state/result are now historical. Current domain state comes
        // only from the coherently published index; kernel owns the live M fence.
        const deadline = this.deadline(); const time = this.sample();
        const keys = scratch(this.index, () => {
          const clock = advanceClock(this.index!.state(), time, this.epoch);
          return clock.seal ? [sealKey(clock.seal.generation)] : [];
        });
        await mutate(this.owner(), keys, Buffer.alloc(0), deadline, () => {
          const prior = this.index!.state(); const clock = advanceClock(prior, time, this.epoch); clock.state.restartEpoch = this.epoch;
          const state = encodeState(clock.state);
          return { next: clock.state, state, result: encodeResult({ schema: 1, operation: 'open', epoch: this.epoch,
            basis: this.basis(prior), clock: { time }, decision: { kind: 'opened' }, postStateDigest: stateDigest(this.bound, state) }),
            actions: clock.seal ? [{ kind: 'create', key: sealKey(clock.seal.generation), payload: encodeSeal(sealKey(clock.seal.generation), clock.seal) }] : [] };
        });
      }
      this.liveStartup();
      if (initialize) {
        await this.kernel.close(); this.dispose();
        if (this.closing) throw new TableError('closed');
        this.lifecycle = 'closed';
      }
      else this.lifecycle = 'ready';
    } catch (error) { await this.failure(error); this.dispose(); throw safeError(error); }
  }
  private sample(): number {
    const now = this.config.now; let value: number;
    try { value = now(); } catch { throw new TableError('unavailable'); }
    return integer(value, 0, MAX_INBOX_TIME);
  }
  private basis(state: InboxState): Exclude<OrdinaryInboxResult['basis'], null> {
    return { records: state.records, bodies: state.bodies, lastNow: state.lastNow, restartEpoch: state.restartEpoch,
      currentGeneration: state.currentGeneration, arm: state.handoffClockArm };
  }
  private async genesis(): Promise<void> {
    const index = new InboxIndex(this.config.maxIndexBytes); this.index = index;
    await this.kernel.auditOwned({ passes: 2,
      record: (pass, row): undefined => {
        if (row.row !== 'M' || row.value.kind !== 'metadata') corrupt();
        if (pass === 1) index.begin();
        scratch(index, () => {
          const m = row.value;
          if (m.kind !== 'metadata' || m.epoch !== 1 || m.exit !== undefined || m.state.length || m.result.length ||
              m.initDigest !== initializationDigestV2(this.bound, m.initId)) corrupt();
        });
      }, endPass: pass => { index.endPass(pass); }, finalize: () => { index.finishBuild(initialState()); },
    }, { ...this.config.audit, maxDurationMs: this.config.kernel.callTimeoutMs }, { requestTimeoutMs: this.config.kernel.callTimeoutMs });
    this.knowledge = 'clear'; this.epoch = 1; this.liveStartup();
    await mutate(this.owner(), [], Buffer.alloc(0), this.deadline(), () => {
      const next = initialState(); const state = encodeState(next);
      return { next, state, result: encodeResult({ schema: 1, operation: 'initialize', epoch: 1, basis: null, clock: null,
        decision: { kind: 'initialized' }, postStateDigest: stateDigest(this.bound, state) }), actions: [] };
    }, true);
  }
  private async failure(error: unknown): Promise<void> {
    if (!this.closing) this.lifecycle = 'failed';
    this.rejectQueued();
    if (this.frame) this.frame.permission = false;
    const code = safeError(error).code;
    if (this.knowledge !== 'clear' || this.debt || code === 'corrupt' || code === 'unresolved') this.kernel.invalidate();
    this.cleanup ??= this.kernel.close();
    await this.cleanup.catch(() => undefined);
  }
  private dispose(): void {
    // No borrowed header is cached outside its owner. Drop index reference before
    // disposing the owner which releases both the retained header and the index.
    const index = this.index; this.index = undefined;
    if (this.audited) { this.audited.dispose(); this.audited = undefined; } else index?.dispose();
  }
  admit(event: Readonly<EventEnvelope>, route: Readonly<ReplyRoute>): Promise<AdmissionResult> {
    try {
      this.intake(); const deadline = this.deadline();
      // Descriptor values are captured once under scratch, before reserving
      // encoded queue storage. Only primitive source references survive here;
      // no caller descriptor is read again after the reservation.
      const sources = scratch(this.index!, () => admissionSources(event, route));
      const bound = admissionBound(sources); this.reserve(bound);
      try {
        const input = scratch(this.index!, () => commandBytes(admission(sources, this.scope)));
        return this.enqueue(input, bound, input.buffer.byteLength, deadline) as Promise<AdmissionResult>;
      } catch (error) { this.release(bound); throw error; }
    } catch (error) { throw safeError(error); }
  }
  getRoute(target: string): Promise<ReplyRoute | undefined> {
    try {
      this.intake(); const deadline = this.deadline(); identity(target); const bound = 1024; this.reserve(bound);
      try {
        const input = commandBytes({ operation: 'route', target });
        return this.enqueue(input, bound, input.buffer.byteLength, deadline) as Promise<ReplyRoute | undefined>;
      }
      catch (error) { this.release(bound); throw error; }
    } catch (error) { throw safeError(error); }
  }
  claimForForwarding(): Promise<IngressForwardingGrant | undefined> {
    this.intake(); const deadline = this.deadline(); this.reserve(FRAME_BYTES);
    try { return this.enqueue(commandBytes({ operation: 'claim' }), FRAME_BYTES, FRAME_BYTES, deadline) as Promise<IngressForwardingGrant | undefined>; }
    catch (error) { this.release(FRAME_BYTES); throw safeError(error); }
  }
  complete(claim: Readonly<IngressClaim>, receipt: Readonly<IngressReceipt>): Promise<boolean> { return this.settle('complete', claim, receipt); }
  retry(claim: Readonly<IngressClaim>, delayMs: number): Promise<boolean> { return this.settle('retry', claim, delayMs); }
  block(claim: Readonly<IngressClaim>, reason: ExplicitBlockReason): Promise<boolean> { return this.settle('block', claim, reason); }
  private settle(operation: Settlement['operation'], claim: Readonly<IngressClaim>, value: Readonly<IngressReceipt> | number | ExplicitBlockReason): Promise<boolean> {
    try {
      this.intake(); const deadline = this.deadline(); const identity = claimIdentity(claim); const command = settlement(operation, identity, value);
      this.intake(); const frame = this.frame;
      const matching = frame?.claim && !frame.continuation && frame.state !== 'released' &&
        frame.claim.eventId === identity.eventId && frame.claim.attemptId === identity.attemptId && frame.claim.attempt === identity.attempt;
      if (!matching) this.reserve(FRAME_BYTES);
      let input: Buffer;
      try { input = scratch(this.index!, () => commandBytes(command)); if (input.length > FRAME_BYTES) corrupt(); }
      catch (error) { if (!matching) this.release(FRAME_BYTES); throw error; }
      if (!matching) return this.enqueue(input, FRAME_BYTES, input.buffer.byteLength, deadline) as Promise<boolean>;
      // Exactly one continuation uses the frame's already reserved small space.
      // Validation and reservation precede the synchronous permission withdrawal.
      return this.continueFrame(frame, input, deadline);
    } catch (error) { throw safeError(error); }
  }
  private continueFrame(frame: Frame, input: Buffer, deadline: number): Promise<boolean> {
    // This promise environment receives only owned bytes/authority, never the
    // argument-taking settlement frame or the caller's claim/event graph.
    return new Promise((resolve, reject) => {
      frame.continuation = { input, bytes: input.length, deadline, resolve: result => resolve(result as boolean), reject };
      this.retire(frame);
    });
  }
  private async claimJob(job: Job): Promise<IngressForwardingGrant | undefined> {
    const index = this.index!;
    const frame: Frame = { credit: index.reserveWorking('frame', 1024 * 1024), bytes: job.bytes, ownsReservation: false,
      state: 'claiming', permission: false, validated: false, sampling: 'none' };
    this.frame = frame;
    let body: EventEnvelope | undefined; let claimed = false;
    try {
      const time = this.sample(); const command = { operation: 'claim' as const };
      const keys = scratch(index, () => operationKeys(index, command, time, this.epoch));
      await mutate(this.owner(), keys, job.input!, job.deadline, view => {
        const planned = operationPlan(index, this.bound, view, keys, command, time, this.epoch);
        claimed = planned.outcome === 'claimed'; return planned.plan;
      }, false, (_key, fresh) => { body = fresh; });
      if (!claimed) { this.releaseFrame(frame); return undefined; }
      const identity = scratch(index, () => {
        const state = index.state(); const arm = state.handoffClockArm; if (!arm) corrupt();
        const event = index.eventByOrder(arm.order)!;
        return { eventId: event.externalEventId, attemptId: event.attemptId!, attempt: event.attempt };
      });
      frame.claim = identity; frame.ownsReservation = true; job.hold = true;
      if (this.lifecycle !== 'ready' || frame.finalDeadline !== undefined) { body = undefined; this.retire(frame); return undefined; }
      if (!body) corrupt();
      frame.state = 'granted'; frame.permission = true;
      const claim: IngressClaim = { externalEventId: identity.eventId, attemptId: identity.attemptId, attempt: identity.attempt, event: body };
      body = undefined;
      // Callbacks are made in a different lexical frame with ONLY private authority.
      return { claim, ...this.permission(frame) };
    } catch (error) { body = undefined; await this.failure(error); this.releaseFrame(frame); throw error; }
  }
  private permission(frame: Frame): Omit<IngressForwardingGrant, 'claim'> {
    return { revalidate: () => this.revalidate(frame), take: () => this.take(frame), retire: () => this.retire(frame) };
  }
  private revalidate(frame: Frame): boolean | Promise<boolean> {
    if (frame !== this.frame || !frame.permission || this.lifecycle !== 'ready') return false;
    if (this.active || frame.state === 'revalidating') return Promise.reject(new TableError('not-submitted'));
    frame.state = 'revalidating'; frame.validated = false; this.active = true;
    return this.revalidateOwned(frame, this.deadline());
  }
  private async revalidateOwned(frame: Frame, deadline: number): Promise<boolean> {
    try {
      const eligible = await this.frameMutation(frame, 'revalidate', this.sample(), deadline);
      const allowed = eligible && frame.permission && this.lifecycle === 'ready';
      frame.validated = allowed;
      if (allowed) frame.state = 'granted'; else this.retire(frame);
      return allowed;
    } catch (error) { await this.failure(error); this.retire(frame); throw safeError(error); }
    finally { this.active = false; this.pump(); }
  }
  private localEligible(frame: Frame, time?: number): boolean {
    if (frame !== this.frame || this.lifecycle !== 'ready' || this.cleanup || this.kernel.status().ownership !== 'owned' ||
        this.kernel.status().lifecycle !== 'envelope-audited') return false;
    return scratch(this.index!, () => {
      const prior = this.index!.state(); const arm = prior.handoffClockArm; if (!arm || !frame.claim || arm.attemptId !== frame.claim.attemptId || arm.ownerEpoch !== this.epoch) return false;
      const event = this.index!.eventByOrder(arm.order); if (!event || event.externalEventId !== frame.claim.eventId || event.attempt !== frame.claim.attempt) return false;
      const clock = time === undefined ? { state: prior } : advanceClock(prior, time, this.epoch);
      return projectEvent(event, clock.state, clock.seal?.generation === event.generation ? clock.seal : this.index!.sealByGeneration(event.generation)).state === 'forwarding';
    });
  }
  private take(frame: Frame): boolean {
    if (!frame.permission) return false;
    frame.permission = false; frame.state = 'consumed'; // one use, including failed eligibility
    try {
      if (!frame.validated || !this.localEligible(frame)) return false;
      frame.sampling = 'started'; this.debt = true;
      const time = this.sample(); frame.time = time; frame.sampling = 'captured';
      return frame.finalDeadline === undefined && this.localEligible(frame, time);
    } catch (error) {
      if (frame.sampling === 'started') frame.sampling = 'failed';
      this.kernel.invalidate(); if (!this.closing) this.lifecycle = 'failed'; this.rejectQueued(); throw safeError(error);
    } finally { this.retire(frame); }
  }
  private retire(frame: Frame): void {
    if (frame !== this.frame || frame.state === 'released') return;
    frame.permission = false;
    if (frame.state !== 'claiming' && frame.state !== 'revalidating' && frame.state !== 'finalizing' && frame.state !== 'continuation') frame.state = 'retired';
    if (frame.finalDeadline !== undefined) return;
    frame.finalDeadline = this.deadline();
    // Never execute storage or another clock inside synchronous take/retire/POST handoff.
    queueMicrotask(() => this.pump());
  }
  private async frameMutation(frame: Frame, operation: 'revalidate' | 'handoff-finalize', time: number | null, deadline: number): Promise<boolean> {
    this.phase(deadline);
    const command: OperationCommand = scratch(this.index!, () => {
      const arm = this.index!.state().handoffClockArm; if (!arm || arm.attemptId !== frame.claim?.attemptId) corrupt(); return { operation, armId: arm.id };
    });
    const keys = scratch(this.index!, () => operationKeys(this.index!, command, time, this.epoch)); let eligible = false;
    await mutate(this.owner(), keys, Buffer.alloc(0), deadline, view => {
      const planned = operationPlan(this.index!, this.bound, view, keys, command, time, this.epoch); eligible = planned.outcome === true; return planned.plan;
    });
    return eligible;
  }
  private async finalizeFrame(frame: Frame): Promise<void> {
    let failure: TableError | undefined;
    try {
      frame.state = 'finalizing';
      if (frame.sampling === 'started' || frame.sampling === 'failed' || this.cleanup) throw new TableError('unresolved');
      await this.frameMutation(frame, 'handoff-finalize', frame.sampling === 'captured' ? frame.time! : null, frame.finalDeadline!);
      if (frame.continuation) {
        frame.state = 'continuation'; const continuation = frame.continuation;
        const result = await this.run(continuation);
        if (this.lifecycle === 'ready') continuation.resolve(result); else continuation.reject(new TableError('closed'));
        continuation.input = undefined; frame.continuation = undefined;
      }
    } catch (error) { failure = safeError(error); await this.failure(error); }
    finally {
      if (frame.continuation) { frame.continuation.input = undefined; frame.continuation.reject(failure ?? new TableError('closed')); frame.continuation = undefined; }
      this.releaseFrame(frame);
    }
  }
  private releaseFrame(frame: Frame): void {
    if (frame.state === 'released') return;
    frame.permission = false; frame.claim = undefined; frame.state = 'released';
    this.index!.releaseWorking(frame.credit);
    if (frame.ownsReservation) this.release(frame.bytes);
    if (this.frame === frame) this.frame = undefined;
  }
  private reserve(bytes: number): void {
    this.intake();
    if (this.pending >= this.config.maxPending || bytes > this.config.maxPendingBytes - this.pendingBytes) throw new TableError('not-submitted');
    this.pending++; this.pendingBytes += bytes;
  }
  private release(bytes: number): void { this.pending--; this.pendingBytes -= bytes; }
  private enqueue(input: Buffer, bound: number, retained = input.buffer.byteLength, deadline = this.deadline()): Promise<unknown> {
    this.intake();
    this.pendingBytes -= bound - retained;
    return new Promise((resolve, reject) => {
      this.queue.push({ input, bytes: retained, deadline, resolve, reject }); this.pump();
    });
  }
  private pump(): void {
    if (this.active) return;
    if (this.frame) {
      if (this.frame.finalDeadline !== undefined) {
        this.active = true; void this.finalizeFrame(this.frame).finally(() => { this.active = false; this.idle(); this.pump(); });
      }
      return;
    }
    if (this.lifecycle !== 'ready') { this.idle(); return; }
    const job = this.queue.shift(); if (!job) return; this.active = true;
    void this.run(job).then(result => this.finish(job, { result }), error => this.finish(job, { error: safeError(error) }));
  }
  private finish(job: Job, outcome: { result: unknown } | { error: TableError }): void {
    job.input = undefined; if (!job.hold) this.release(job.bytes); this.active = false;
    if ('error' in outcome) job.reject(outcome.error);
    else if (this.lifecycle !== 'ready') job.reject(new TableError(this.closing ? 'closed' : 'unready'));
    else job.resolve(outcome.result);
    this.idle(); this.pump();
  }
  private rejectQueued(): void {
    for (const job of this.queue.splice(0)) { job.input = undefined; this.release(job.bytes); job.reject(new TableError(this.closing || this.lifecycle === 'closing' ? 'closed' : 'unready')); }
  }
  private idle(): void { if (!this.active && !this.frame) { this.drained?.(); this.drained = undefined; } }
  private async run(job: Job): Promise<unknown> {
    try {
      // Queue wait belongs to the operation deadline, before any clock sample.
      this.phase(job.deadline);
      const operation = scratch(this.index!, () => readCommand(job.input!).operation);
      let outcome: unknown;
      if (operation === 'route') outcome = await this.routeJob(job.input!, job.deadline);
      else if (operation === 'admit') {
        const time = this.sample();
        await mutate(this.owner(), admissionKeys(this.index!, job.input!, time, this.epoch), job.input!, job.deadline, view => {
          const planned = admitPlan(this.index!, this.bound, this.scope, this.config.policy, view.input, time, this.epoch);
          outcome = planned.outcome; return planned.plan;
        });
      } else if (operation === 'claim') outcome = await this.claimJob(job);
      else {
        const time = this.sample();
        const keys = scratch(this.index!, () => operationKeys(this.index!, readCommand(job.input!) as Settlement, time, this.epoch));
        await mutate(this.owner(), keys, job.input!, job.deadline, view => {
          const planned = operationPlan(this.index!, this.bound, view, keys, readCommand(view.input) as Settlement, time, this.epoch);
          outcome = planned.outcome; return planned.plan;
        });
      }
      return outcome;
    } catch (error) { await this.failure(error); throw safeError(error); }
  }
  private async routeJob(input: Buffer, deadline: number): Promise<ReplyRoute | undefined> {
    const index = this.index!; const credit = index.reserveWorking('derivedKeys', 64 * 1024);
    try {
      const key = scratch(index, () => {
        const c = readCommand(input); if (c.operation !== 'route') corrupt(); return { type: 'route' as const, id: copyString(c.target) };
      });
      const row = await this.kernel.read(key, { timeoutMs: this.phase(deadline) });
      return scratch(index, () => {
        this.phase(deadline); checkRow(index, this.bound, key, row);
        return row?.value.kind === 'data' ? decodeRoute(key, row.value.payload).route : undefined;
      });
    } catch (error) {
      // This catch is outside the row's scope. Only safe failure and the small
      // key credit survive a possibly early kernel rejection through drain.
      const safe = safeError(error); await this.failure(safe); throw safe;
    } finally { index.releaseWorking(credit); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifecycle = 'closing';
    this.rejectQueued();
    if (this.frame) this.retire(this.frame);
    this.closing = (async () => {
      await this.startup?.catch(() => undefined);
      if (this.active || this.frame) await new Promise<void>(resolve => { this.drained = resolve; this.pump(); });
      if (this.knowledge !== 'clear' || this.debt) this.kernel.invalidate();
      try { await this.kernel.close(); }
      finally { this.dispose(); this.lifecycle = 'closed'; }
    })();
    return this.closing;
  }
}
