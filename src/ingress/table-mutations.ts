import { randomUUID } from 'node:crypto';
import { data, dataRow, integer } from '../storage/table/codec.js';
import { OWNED_AUDIT_BUDGET_EXHAUSTED, TableError } from '../storage/table/types.js';
import type { BoundTable, DataAction, DataKey, Plan, PlannerViewV2, StoredRecordV2 } from '../storage/table/types.js';
import type { TableKernelV2 } from '../storage/table/index.js';
import { digest as bodyDigest, encode, fingerprint } from './codec.js';
import type { IngressPolicy, IngressScope, AdmissionResult } from './types.js';
import { readCommand } from './table-input.js';
import type { Command } from './table-input.js';
import { advanceClock, projectEvent, sealKey } from './table-state.js';
import { encodeResult, stateDigest } from './table-result.js';
import { decodeEvent, decodeRoute, decodeSeal, encodeEvent, encodeRoute, encodeSeal, encodeState } from './table-codec.js';
import type { InboxIndex, IndexDeltaInput, IndexWorkingCredit, PreparedIndexDelta } from './table-index.js';
import type { EventPayload, EventSummary, InboxState, InboxResultBasis, OrdinaryInboxResult } from './table-types.js';
import { MAX_EVENT_PAYLOAD_BYTES, MAX_ROUTE_PAYLOAD_BYTES, MAX_SEAL_PAYLOAD_BYTES } from './table-types.js';

export interface MutationOwner {
  kernel: TableKernelV2; index: InboxIndex; bound: BoundTable;
  phase(deadline: number): number;
  submitting(state: Readonly<InboxState>): void;
  confirmed(state: Readonly<InboxState>): void;
  cancelled(): void;
  failure(error: unknown): Promise<void>;
}
export interface DomainPlan extends Plan { next: InboxState }
interface Changed { key: DataKey; payload: Buffer; digest: string }
export function corrupt(): never { throw new TableError('corrupt'); }
export function basis(state: InboxState): InboxResultBasis {
  return { records: state.records, bodies: state.bodies, lastNow: state.lastNow, restartEpoch: state.restartEpoch,
    currentGeneration: state.currentGeneration, arm: state.handoffClockArm };
}
function keyCopy(key: DataKey): DataKey {
  const bytes = Buffer.alloc(Buffer.byteLength(key.id)); bytes.write(key.id);
  return { type: key.type, id: bytes.toString('utf8') };
}
export function admissionKeys(index: InboxIndex, input: Buffer, time: number, epoch: number): DataKey[] {
  return scratch(index, () => {
    const c = readCommand(input); if (c.operation !== 'admit') corrupt();
    const keys: DataKey[] = [{ type: 'event', id: c.event.externalEventId }, { type: 'route', id: c.event.replyTarget }];
    const existing = index.eventById(c.event.externalEventId);
    if (existing && existing.replyTarget !== c.event.replyTarget) keys.push({ type: 'route', id: existing.replyTarget });
    const clock = advanceClock(index.state(), time, epoch);
    if (clock.seal) keys.push(sealKey(clock.seal.generation));
    return keys.map(keyCopy);
  });
}
export function admitPlan(index: InboxIndex, bound: BoundTable, scope: Readonly<IngressScope>, policy: IngressPolicy,
  input: Buffer, time: number, epoch: number): { plan: DomainPlan; outcome: AdmissionResult } {
  const c = readCommand(input); if (c.operation !== 'admit') corrupt();
  const prior = index.state(); if (prior.handoffClockArm) corrupt();
  const clock = advanceClock(prior, time, epoch); const next = clock.state;
  const existing = index.eventById(c.event.externalEventId); const target = index.routeByTarget(c.event.replyTarget);
  const hash = fingerprint(c.event, c.route, scope); const actions: DataAction[] = [];
  let outcome: AdmissionResult;
  if (existing) outcome = existing.fingerprint === hash ? { kind: 'duplicate', replyTarget: existing.replyTarget } : { kind: 'conflict' };
  else if (target) outcome = { kind: 'conflict' };
  else if (time < prior.lastNow || prior.records >= policy.maxRecords || prior.bodies >= policy.maxPending) outcome = { kind: 'full' };
  else {
    next.records++; next.bodies++; next.currentGeneration ??= next.records;
    const event: EventPayload = { schema: 1, fingerprintVersion: 1, replyTarget: c.event.replyTarget, fingerprint: hash,
      bodyDigest: bodyDigest(encode(c.event)), body: c.event, state: 'pending', received: time, deadline: time + policy.replayWindowMs,
      nextAttempt: time, attempt: 0, attemptId: null, attemptEpoch: 0, order: next.records, generation: next.currentGeneration, receipt: null, reason: null };
    const eventKey: DataKey = { type: 'event', id: c.event.externalEventId }; const routeKey: DataKey = { type: 'route', id: c.event.replyTarget };
    actions.push({ kind: 'create', key: eventKey, payload: encodeEvent(eventKey, event) }, { kind: 'create', key: routeKey,
      payload: encodeRoute(routeKey, { schema: 1, externalEventId: c.event.externalEventId, route: c.route, routeDigest: bodyDigest(encode(c.route)) }) });
    outcome = { kind: 'accepted', replyTarget: keyCopy(routeKey).id };
  }
  if (clock.seal) actions.push({ kind: 'create', key: sealKey(clock.seal.generation), payload: encodeSeal(sealKey(clock.seal.generation), clock.seal) });
  const state = encodeState(next);
  const result = encodeResult({ schema: 1, operation: 'admit', epoch, basis: basis(prior), clock: { time },
    decision: { eventId: c.event.externalEventId, replyTarget: c.event.replyTarget, fingerprint: hash, policy, outcome }, postStateDigest: stateDigest(bound, state) });
  return { plan: { next, state, result, actions }, outcome };
}
export type FrameCommand = { operation: 'revalidate'; armId: string } | { operation: 'handoff-finalize'; armId: string };
export type OperationCommand = Exclude<Command, { operation: 'route' | 'admit' }> | FrameCommand;
export function operationKeys(index: InboxIndex, c: OperationCommand, time: number | null, epoch: number): DataKey[] {
  const prior = index.state(); const clock = time === null ? { state: prior } : advanceClock(prior, time, epoch);
  const target = c.operation === 'claim' ? index.firstDue(time!, clock.state, clock.seal ? { seal: clock.seal } : undefined) :
    'claim' in c ? index.eventById(c.claim.eventId) : prior.handoffClockArm ? index.eventByOrder(prior.handoffClockArm.order) : corrupt();
  const keys: DataKey[] = [];
  if (target) {
    keys.push({ type: 'event', id: target.externalEventId }, { type: 'route', id: target.replyTarget });
    if (index.sealByGeneration(target.generation)) keys.push(sealKey(target.generation));
  } else if ('claim' in c) keys.push({ type: 'event', id: c.claim.eventId });
  if (clock.seal) keys.push(sealKey(clock.seal.generation));
  return keys.map(keyCopy);
}
export function operationPlan(index: InboxIndex, bound: BoundTable, view: PlannerViewV2, keys: DataKey[], c: OperationCommand,
  time: number | null, epoch: number): { plan: DomainPlan; outcome: boolean | 'claimed' | undefined } {
  const prior = index.state(); const clock = time === null ? { state: prior } : advanceClock(prior, time, epoch); const next = clock.state;
  const frame = c.operation === 'revalidate' || c.operation === 'handoff-finalize';
  if (frame ? !prior.handoffClockArm || prior.handoffClockArm.id !== c.armId : prior.handoffClockArm !== null) corrupt();
  const selected = c.operation === 'claim' ? index.firstDue(time!, next, clock.seal ? { seal: clock.seal } : undefined) :
    'claim' in c ? index.eventById(c.claim.eventId) : index.eventByOrder(prior.handoffClockArm!.order);
  const effective = (event: EventSummary) => projectEvent(event, next,
    clock.seal?.generation === event.generation ? clock.seal : index.sealByGeneration(event.generation));
  const actions: DataAction[] = []; let outcome: boolean | 'claimed' | undefined;
  let saved: OrdinaryInboxResult;
  const base = { schema: 1 as const, epoch, basis: basis(prior), clock: { time: time! }, postStateDigest: '' };
  const replace = (update: (event: EventPayload) => EventPayload) => {
    const n = keys.findIndex(key => key.type === 'event' && key.id === selected!.externalEventId);
    const row = view.records[n]; if (!row || row.value.kind !== 'data') corrupt();
    const key = keys[n]!;
    // Preserve the fresh planner body, not a fabricated projection or another read.
    const event = update(decodeEvent(key, row.value.payload));
    actions.push({ kind: 'replace', key, etag: row.etag, payload: encodeEvent(key, event) });
  };
  if (c.operation === 'claim') {
    if (!selected) saved = { ...base, operation: 'claim', decision: { kind: 'empty' } };
    else {
      const attempt = integer(selected.attempt, 0, Number.MAX_SAFE_INTEGER - 1) + 1; const attemptId = randomUUID();
      next.handoffClockArm = { id: randomUUID(), ownerEpoch: epoch, generation: selected.generation, order: selected.order, attemptId };
      replace(event => ({ ...event, state: 'forwarding', attempt, attemptId, attemptEpoch: epoch }));
      saved = { ...base, operation: 'claim', decision: { kind: 'claimed', eventId: selected.externalEventId, attemptId, attempt } }; outcome = 'claimed';
    }
  } else if (c.operation === 'revalidate' || c.operation === 'handoff-finalize') {
    const arm = prior.handoffClockArm!;
    if (!selected || selected.state !== 'forwarding' || selected.attemptId !== arm.attemptId || selected.attemptEpoch !== epoch || selected.generation !== arm.generation) corrupt();
    const eligible = effective(selected).state === 'forwarding'; outcome = eligible;
    if (c.operation === 'revalidate') saved = { ...base, operation: c.operation, decision: { armId: c.armId, eligible } };
    else {
      next.handoffClockArm = null;
      saved = time === null ? { ...base, operation: c.operation, clock: null, decision: { armId: c.armId, sampling: 'none', domainEligible: null } } :
        { ...base, operation: c.operation, decision: { armId: c.armId, sampling: 'captured', domainEligible: eligible } };
    }
  } else {
    const applied = !!selected && selected.attemptId === c.claim.attemptId && selected.attempt === c.claim.attempt &&
      selected.attemptEpoch === epoch && effective(selected).state === 'forwarding';
    outcome = applied;
    if (applied) {
      if (c.operation === 'complete') { next.bodies--; replace(event => ({ ...event, state: 'terminal', body: null, receipt: c.receipt })); }
      else if (c.operation === 'retry') replace(event => ({ ...event, state: 'pending', nextAttempt: Math.min(Number.MAX_SAFE_INTEGER, time! + c.delayMs) }));
      else replace(event => ({ ...event, state: 'blocked', reason: c.reason }));
    }
    saved = c.operation === 'complete' ? { ...base, operation: c.operation, decision: { claim: c.claim, receipt: c.receipt, applied } } :
      c.operation === 'retry' ? { ...base, operation: c.operation, decision: { claim: c.claim, delayMs: c.delayMs, applied } } :
        { ...base, operation: c.operation, decision: { claim: c.claim, reason: c.reason, applied } };
  }
  if (clock.seal) actions.push({ kind: 'create', key: sealKey(clock.seal.generation), payload: encodeSeal(sealKey(clock.seal.generation), clock.seal) });
  const state = encodeState(next); saved.postStateDigest = stateDigest(bound, state);
  return { plan: { next, state, result: encodeResult(saved), actions }, outcome };
}
export function scratch<T>(index: InboxIndex, work: () => T): T {
  const credit = index.reserveWorking('scratch', 2240 * 1024);
  try { return work(); } finally { index.releaseWorking(credit); }
}
function version(row: StoredRecordV2) { return { etag: row.etag, digest: row.value.digest, timestamp: row.timestamp }; }
function exists(index: InboxIndex, key: DataKey): boolean {
  return key.type === 'event' ? !!index.eventById(key.id) : key.type === 'route' ? !!index.routeByTarget(key.id) :
    key.type === 'control' && /^generation:[1-9][0-9]*$/u.test(key.id) ? !!index.sealByGeneration(Number(key.id.slice(11))) : corrupt();
}
/** One fresh row at a time. Exact envelope version binds all previously audited
 * domain fields; decoding again also checks canonical payload/encoding lengths. */
export function checkRow(index: InboxIndex, bound: BoundTable, key: DataKey, row: StoredRecordV2 | undefined): void {
  if (!exists(index, key)) { if (row) corrupt(); return; }
  if (!row || row.row !== dataRow(bound, key) || row.value.kind !== 'data' || row.value.type !== key.type || row.value.id !== key.id) corrupt();
  index.checkVersion(key, version(row));
  const payload = row.value.payload;
  if (key.type === 'event') {
    const { body } = decodeEvent(key, payload); const lengths = index.eventLengths(key.id);
    if (lengths.payloadBytes !== payload.length || lengths.bodyEncodingBytes !== (body === null ? 0 : encode(body).length)) corrupt();
  } else if (key.type === 'route') {
    const route = decodeRoute(key, payload); const expected = index.routeByTarget(key.id)!;
    if (route.externalEventId !== expected.externalEventId || route.routeDigest !== expected.routeDigest ||
        payload.length !== expected.payloadBytes || encode(route.route).length !== expected.routeEncodingBytes) corrupt();
  } else decodeSeal(key, payload);
}

/** Exact planner bytes and index delta share one 512KiB quota. No asynchronous
 * planner or per-refresh timeout reset. Failed confirmed work is never replayed. */
export async function mutate(owner: MutationOwner, keys: DataKey[], input: Buffer, deadline: number,
  planner: (view: PlannerViewV2) => DomainPlan, genesis = false,
  claimBody?: (key: DataKey, body: NonNullable<ReturnType<typeof decodeEvent>['body']>) => void): Promise<void> {
  const { index, kernel, bound } = owner;
  let delta: IndexWorkingCredit | undefined; let derived: IndexWorkingCredit | undefined;
  let token: PreparedIndexDelta | undefined; let committed = false; let plannerError: unknown;
  let changed: Changed[] = []; let next: InboxState | undefined;
  try {
    delta = index.reserveWorking('delta', 480 * 1024);
    derived = index.reserveWorking('derivedKeys', 64 * 1024);
    const result = await kernel.mutate({ input, keys }, view => {
      try { return scratch(index, () => {
        owner.phase(deadline);
        // Kernel rows have a larger generic cap. Reject oversized companions
        // before parsing ANY body, so their raw snapshots cannot inflate the
        // one-record decoding scratch overlap.
        for (const row of view.records) if (row?.value.kind === 'data') {
          const cap = row.value.type === 'event' ? MAX_EVENT_PAYLOAD_BYTES : row.value.type === 'route' ? MAX_ROUTE_PAYLOAD_BYTES : MAX_SEAL_PAYLOAD_BYTES;
          if (row.value.payload.length > cap) corrupt();
        }
        if (genesis ? view.state.length !== 0 : !encodeState(index.state()).equals(view.state)) corrupt();
        for (let i = 0; i < keys.length; i++) checkRow(index, bound, keys[i]!, view.records[i]);
        const plan = planner(view); next = plan.next;
        const proposed: IndexDeltaInput = { state: next, manifest: [] };
        const actions: DataAction[] = [];
        for (const action of plan.actions) {
          const key = keyCopy(action.key); const payload = action.payload;
          // All producers are private synchronous domain encoders. Keep their
          // exact Buffer instead of making a second retained payload set. Its
          // full backing capacity (including small slabs) shares delta with the
          // kernel's planner-input copy and staged index slots.
          if (!Buffer.isBuffer(payload)) corrupt();
          const expected = data(bound, key, payload).digest;
          changed.push({ key, payload, digest: expected });
          actions.push(action.kind === 'create' ? { kind: 'create', key, payload } : { kind: 'replace', key, payload, etag: action.etag });
          if (key.type === 'event') {
            const { body, ...event } = decodeEvent(key, payload);
            proposed.event = { event: { ...event, externalEventId: key.id }, payloadBytes: payload.length, bodyEncodingBytes: body ? encode(body).length : 0 };
          } else if (key.type === 'route') {
            const r = decodeRoute(key, payload);
            proposed.route = { replyTarget: key.id, externalEventId: r.externalEventId, routeDigest: r.routeDigest,
              botId: r.route.bot.id, conversationId: r.route.conversation.id, routeEncodingBytes: encode(r.route).length, payloadBytes: payload.length };
          } else proposed.seal = { seal: decodeSeal(key, payload), payloadBytes: payload.length };
        }
        proposed.manifest = changed.map(c => ({ key: c.key, digest: c.digest }));
        token = index.prepare(proposed); owner.phase(deadline); owner.submitting(next);
        return { state: plan.state, result: plan.result, actions };
      }); } catch (error) {
        plannerError = error === OWNED_AUDIT_BUDGET_EXHAUSTED ? new TableError('incomplete') :
          error instanceof TableError && ['incomplete', 'unready', 'unresolved', 'closed'].includes(error.code) ? new TableError(error.code) : new TableError('corrupt');
        throw error;
      }
    }, { timeoutMs: owner.phase(deadline) });
    if (result.kind !== 'committed') { owner.cancelled(); throw new TableError('not-submitted'); }
    if (!token || !next) corrupt();
    index.confirm(token); committed = true; owner.confirmed(next);
    for (const expected of changed) {
      // This awaited helper's full row dies before the next row's read begins.
      await refresh(expected);
    }
    owner.phase(deadline); index.publish(token); token = undefined;
  } catch (error) {
    const safe = plannerError ?? error;
    await owner.failure(safe); // Actual native drain precedes releasing any survivor credit.
    throw safe;
  } finally {
    if (token) { if (committed) index.discardConfirmed(token); else index.abort(token); }
    changed = []; next = undefined;
    if (derived) index.releaseWorking(derived);
    if (delta) index.releaseWorking(delta);
  }
  async function refresh(expected: Changed): Promise<void> {
    const row = await kernel.read(expected.key, { timeoutMs: owner.phase(deadline) });
    scratch(index, () => {
      owner.phase(deadline);
      if (!row || row.row !== dataRow(bound, expected.key) || row.value.kind !== 'data' ||
          row.value.type !== expected.key.type || row.value.id !== expected.key.id || row.value.digest !== expected.digest ||
          !row.value.payload.equals(expected.payload)) corrupt();
      // Equality with exact private bytes proves ALL prepared domain fields and lengths.
      if (expected.key.type === 'event') {
        const event = decodeEvent(expected.key, row.value.payload);
        if (claimBody && event.body) claimBody(expected.key, event.body);
      } else if (expected.key.type === 'route') decodeRoute(expected.key, row.value.payload);
      else decodeSeal(expected.key, row.value.payload);
      index.refresh(token!, expected.key, version(row));
    });
  }
}
