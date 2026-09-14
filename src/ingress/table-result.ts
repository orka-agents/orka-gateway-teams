import { bytes, digest, fail, integer, object, rawJSON } from '../storage/table/codec.js';
import { TableError } from '../storage/table/types.js';
import type { BoundTable, MetadataV2 } from '../storage/table/types.js';
import { encode, identity, validatePolicy, validateReceipt } from './codec.js';
import { decodeState, encodeState } from './table-codec.js';
import { advanceClock, initialState, projectEvent } from './table-state.js';
import { MAX_INBOX_RECORDS, MAX_INBOX_RESULT_BYTES, MAX_INBOX_RECOVERY_RESULT_BYTES, MAX_INBOX_TIME } from './table-types.js';
import type { EventSummary, HandoffClockArm, InboxGraph, InboxRecoveryResult, InboxResult, InboxResultBasis, InboxResultClaim, InboxState, OrdinaryInboxResult } from './table-types.js';
import type { AdmissionResult } from './types.js';

/** Already envelope/row/reference/counter/generation/epoch audited inputs. The auditor
 * supplies the complete ordered physical-data fold/count, never a selected-row fold.
 * This predicate is retained-decision consistency, not historical authentication or Ready. */
export interface ResultValidationContext {
  binding: Readonly<BoundTable>; metadata: Readonly<MetadataV2>; state: Readonly<InboxState>;
  graph: InboxGraph; postDataDigest: string; dataRowCount: number;
}
function boundary<T>(code: 'invalid-input' | 'corrupt', work: () => T): T {
  try { return work(); } catch { throw new TableError(code); }
}
function shape(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const v = object(value, keys); if (Object.keys(v).length !== keys.length) fail(); return v;
}
function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) fail(); return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) fail(); return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value; }
function claim(value: unknown): InboxResultClaim {
  const v = shape(value, ['eventId', 'attemptId', 'attempt']);
  return { eventId: identity(v.eventId), attemptId: uuid(v.attemptId), attempt: integer(v.attempt, 1, Number.MAX_SAFE_INTEGER) };
}
function basis(value: unknown): InboxResultBasis {
  const v = shape(value, ['records', 'bodies', 'lastNow', 'restartEpoch', 'currentGeneration', 'arm']);
  // Reuse the state codec's structural scalar/arm rules, including sealed arms.
  const state = decodeState(encodeState({ ...initialState(), records: v.records, bodies: v.bodies, lastNow: v.lastNow,
    restartEpoch: v.restartEpoch, currentGeneration: v.currentGeneration, handoffClockArm: v.arm } as InboxState));
  return { records: state.records, bodies: state.bodies, lastNow: state.lastNow, restartEpoch: state.restartEpoch,
    currentGeneration: state.currentGeneration, arm: state.handoffClockArm };
}
function outcome(value: unknown): AdmissionResult {
  const v = object(value);
  if (v.kind === 'accepted' || v.kind === 'duplicate') {
    shape(v, ['kind', 'replyTarget']); return { kind: v.kind, replyTarget: identity(v.replyTarget) };
  }
  shape(v, ['kind']); if (v.kind !== 'conflict' && v.kind !== 'full') fail(); return { kind: v.kind };
}
function recoveryResult(value: unknown): InboxRecoveryResult {
  const v = shape(value, ['schema', 'operation', 'invocation', 'oldEpoch', 'originalMDigest', 'disposition', 'postStateDigest', 'postDataDigest', 'dataRowCount']);
  if (v.schema !== 1 || v.operation !== 'operator-recovery') fail();
  const d = object(v.disposition); let disposition: InboxRecoveryResult['disposition'];
  if (d.kind === 'inbox-unarmed') { shape(d, ['kind']); disposition = { kind: 'inbox-unarmed' }; }
  else {
    shape(d, ['kind', 'armId', 'generation', 'watermark']); if (d.kind !== 'inbox-clock-uncertain') fail();
    disposition = { kind: 'inbox-clock-uncertain', armId: uuid(d.armId), generation: integer(d.generation, 1, MAX_INBOX_RECORDS),
      watermark: integer(d.watermark, 0, MAX_INBOX_TIME) };
  }
  return { schema: 1, operation: 'operator-recovery', invocation: uuid(v.invocation), oldEpoch: integer(v.oldEpoch, 1, Number.MAX_SAFE_INTEGER),
    originalMDigest: hex(v.originalMDigest), disposition, postStateDigest: hex(v.postStateDigest), postDataDigest: hex(v.postDataDigest),
    dataRowCount: integer(v.dataRowCount, 0, Number.MAX_SAFE_INTEGER) };
}
function normalize(value: unknown): InboxResult {
  if (object(value).operation === 'operator-recovery') return recoveryResult(value);
  const v = shape(value, ['schema', 'operation', 'epoch', 'basis', 'clock', 'decision', 'postStateDigest']);
  if (v.schema !== 1) fail();
  const epoch = integer(v.epoch, 1, Number.MAX_SAFE_INTEGER);
  const prior = v.basis === null ? null : basis(v.basis);
  const clock = v.clock === null ? null : { time: integer(shape(v.clock, ['time']).time, 0, MAX_INBOX_TIME) };
  const d = object(v.decision); let decision: OrdinaryInboxResult['decision'];
  if (v.operation === 'initialize') {
    shape(d, ['kind']); if (d.kind !== 'initialized' || prior !== null || clock !== null) fail(); decision = { kind: 'initialized' };
  } else {
    if (prior === null || (clock === null && v.operation !== 'handoff-finalize')) fail();
    switch (v.operation) {
      case 'open':
        shape(d, ['kind']); if (d.kind !== 'opened') fail(); decision = { kind: 'opened' }; break;
      case 'admit':
        shape(d, ['eventId', 'replyTarget', 'fingerprint', 'policy', 'outcome']); object(d.policy);
        decision = { eventId: identity(d.eventId), replyTarget: identity(d.replyTarget), fingerprint: hex(d.fingerprint),
          policy: validatePolicy(d.policy), outcome: outcome(d.outcome) }; break;
      case 'claim':
        if (d.kind === 'empty') { shape(d, ['kind']); decision = { kind: 'empty' }; }
        else {
          shape(d, ['kind', 'eventId', 'attemptId', 'attempt']); if (d.kind !== 'claimed') fail();
          decision = { kind: 'claimed', ...claim({ eventId: d.eventId, attemptId: d.attemptId, attempt: d.attempt }) };
        }
        break;
      case 'complete':
        shape(d, ['claim', 'receipt', 'applied']); object(d.receipt);
        decision = { claim: claim(d.claim), receipt: validateReceipt(d.receipt), applied: boolean(d.applied) }; break;
      case 'retry':
        shape(d, ['claim', 'delayMs', 'applied']);
        decision = { claim: claim(d.claim), delayMs: integer(d.delayMs, 0, Number.MAX_SAFE_INTEGER), applied: boolean(d.applied) }; break;
      case 'block':
        shape(d, ['claim', 'reason', 'applied']); if (d.reason !== 'conflict' && d.reason !== 'invalid-event' && d.reason !== 'redirect') fail();
        decision = { claim: claim(d.claim), reason: d.reason, applied: boolean(d.applied) }; break;
      case 'revalidate':
        shape(d, ['armId', 'eligible']); decision = { armId: uuid(d.armId), eligible: boolean(d.eligible) }; break;
      case 'handoff-finalize':
        shape(d, ['armId', 'sampling', 'domainEligible']);
        if (d.sampling === 'none') {
          if (clock !== null || d.domainEligible !== null) fail(); decision = { armId: uuid(d.armId), sampling: 'none', domainEligible: null };
        } else {
          if (d.sampling !== 'captured' || clock === null) fail();
          decision = { armId: uuid(d.armId), sampling: 'captured', domainEligible: boolean(d.domainEligible) };
        }
        break;
      default: return fail();
    }
  }
  return { schema: 1, operation: v.operation, epoch, basis: prior, clock, decision, postStateDigest: hex(v.postStateDigest) } as OrdinaryInboxResult;
}
/** Encoders normalize closed canonical order; decoders require the exact physical bytes. */
export function encodeResult(value: Readonly<InboxResult>): Buffer {
  return boundary('invalid-input', () => {
    const result = normalize(value);
    return bytes(encode(result), result.operation === 'operator-recovery' ? MAX_INBOX_RECOVERY_RESULT_BYTES : MAX_INBOX_RESULT_BYTES);
  });
}
export function decodeResult(input: Uint8Array): InboxResult {
  return boundary('corrupt', () => {
    const raw = bytes(input, MAX_INBOX_RESULT_BYTES); const result = normalize(rawJSON(raw));
    if (!encodeResult(result).equals(raw)) fail(); return result;
  });
}
/** Hash exact canonical state bytes, not a reconstructed or re-ordered state object. */
export function stateDigest(binding: Readonly<BoundTable>, stateBytes: Uint8Array,
  kind: 'ordinary' | 'operator-recovery' = 'ordinary'): string {
  return boundary('invalid-input', () => {
    if (kind !== 'ordinary' && kind !== 'operator-recovery') fail();
    decodeState(stateBytes);
    return digest([kind === 'ordinary' ? 'orka-inbox-state-v1' : 'orka-recovery-state-v2', binding.bytes.toString('base64'),
      Buffer.from(stateBytes).toString('base64')]);
  });
}
function same(a: unknown, b: unknown): boolean { return encode(a).equals(encode(b)); }
function effective(event: EventSummary, state: Readonly<InboxState>, graph: InboxGraph) {
  return projectEvent(event, state, graph.sealByGeneration(event.generation));
}
function firstDue(state: Readonly<InboxState>, graph: InboxGraph, time: number, selected?: EventSummary): EventSummary | undefined {
  for (let order = 1; order <= state.records; order++) {
    const row = graph.eventByOrder(order); if (!row) fail();
    // Only selection's effective preclaim state is known. No historical UUID/body is invented.
    const event = selected?.order === order ? { ...row, state: 'pending' as const } : row;
    if (effective(event, state, graph).state === 'pending' && event.nextAttempt <= time) return event;
  }
  return undefined;
}
function matches(event: EventSummary | undefined, input: InboxResultClaim, epoch: number): event is EventSummary {
  return event !== undefined && event.externalEventId === input.eventId && event.attemptId === input.attemptId &&
    event.attempt === input.attempt && event.attemptEpoch === epoch;
}
function armed(arm: HandoffClockArm | null, id: string, epoch: number, graph: InboxGraph): EventSummary {
  if (!arm || arm.id !== id || arm.ownerEpoch !== epoch) fail();
  const event = graph.eventByOrder(arm.order);
  if (!event || event.state !== 'forwarding' || event.generation !== arm.generation || event.attemptId !== arm.attemptId || event.attemptEpoch !== epoch) fail();
  return event;
}
function ordinaryResult(result: OrdinaryInboxResult, state: Readonly<InboxState>, graph: InboxGraph, dataRowCount: number): void {
  if (result.epoch !== state.restartEpoch) fail();
  if (result.operation === 'initialize') {
    if (result.epoch !== 1 || dataRowCount !== 0 || !same(state, initialState())) fail(); return;
  }
  const prior = result.basis;
  if (result.operation === 'open' ? prior.restartEpoch >= result.epoch : prior.restartEpoch !== result.epoch) fail();
  const before: InboxState = { ...initialState(), records: prior.records, bodies: prior.bodies, lastNow: prior.lastNow,
    restartEpoch: prior.restartEpoch, currentGeneration: prior.currentGeneration, handoffClockArm: prior.arm };
  const transition = result.clock === null ? { state: before } : advanceClock(before, result.clock.time, result.epoch);
  const expected = transition.state; expected.restartEpoch = result.epoch;
  if (transition.seal && !same(graph.sealByGeneration(transition.seal.generation), transition.seal)) fail();
  if (result.operation !== 'revalidate' && result.operation !== 'handoff-finalize' && prior.arm !== null) fail();
  switch (result.operation) {
    case 'open': break; // No arm adoption/clearing and no per-row restart rewrite.
    case 'admit': {
      const d = result.decision; const event = graph.eventById(d.eventId); const target = graph.eventByTarget(d.replyTarget);
      if (d.outcome.kind === 'accepted') {
        if (!event || event.order !== prior.records + 1 || target?.externalEventId !== event.externalEventId ||
            d.outcome.replyTarget !== d.replyTarget || event.replyTarget !== d.replyTarget || event.fingerprint !== d.fingerprint ||
            result.clock.time < prior.lastNow || prior.records >= d.policy.maxRecords || prior.bodies >= d.policy.maxPending ||
            event.state !== 'pending' || event.attempt !== 0 || event.attemptId !== null || event.attemptEpoch !== 0 ||
            event.receipt !== null || event.reason !== null || event.received !== result.clock.time ||
            event.nextAttempt !== result.clock.time || event.deadline !== result.clock.time + d.policy.replayWindowMs) fail();
        // Only this newest event/route pair is omitted from pre-admission absence.
        expected.records++; expected.bodies++; expected.currentGeneration ??= expected.records;
        if (event.generation !== expected.currentGeneration) fail();
      } else {
        const kind = event ? (event.fingerprint === d.fingerprint ? 'duplicate' : 'conflict') : target ? 'conflict' :
          result.clock.time < prior.lastNow || prior.records >= d.policy.maxRecords || prior.bodies >= d.policy.maxPending ? 'full' : undefined;
        if (d.outcome.kind !== kind || (d.outcome.kind === 'duplicate' && d.outcome.replyTarget !== event?.replyTarget)) fail();
      }
      break;
    }
    case 'claim': {
      const d = result.decision;
      if (d.kind === 'empty') { if (firstDue(state, graph, result.clock.time)) fail(); }
      else {
        const event = graph.eventById(d.eventId);
        if (!matches(event, d, result.epoch) || event.state !== 'forwarding' || !state.handoffClockArm) fail();
        integer(event.attempt - 1, 0, Number.MAX_SAFE_INTEGER - 1);
        if (armed(state.handoffClockArm, state.handoffClockArm.id, result.epoch, graph).externalEventId !== d.eventId ||
            firstDue(state, graph, result.clock.time, event)?.externalEventId !== d.eventId) fail();
        expected.handoffClockArm = state.handoffClockArm;
      }
      break;
    }
    case 'complete': case 'retry': case 'block': {
      const d = result.decision; const event = graph.eventById(d.claim.eventId);
      if (!d.applied) {
        if (matches(event, d.claim, result.epoch) && effective(event, state, graph).state === 'forwarding') fail();
      } else {
        if (!matches(event, d.claim, result.epoch) || effective({ ...event, state: 'forwarding', reason: null, receipt: null }, state, graph).state !== 'forwarding') fail();
        if (result.operation === 'complete') {
          if (event.state !== 'terminal' || !same(event.receipt, result.decision.receipt) || event.reason !== null) fail(); expected.bodies--;
        } else if (result.operation === 'retry') {
          if (event.state !== 'pending' || event.receipt !== null || event.reason !== null ||
              event.nextAttempt !== Math.min(Number.MAX_SAFE_INTEGER, result.clock.time + result.decision.delayMs)) fail();
        } else if (event.state !== 'blocked' || event.receipt !== null || event.reason !== result.decision.reason) fail();
      }
      break;
    }
    case 'revalidate': case 'handoff-finalize': {
      const d = result.decision; const event = armed(prior.arm, d.armId, result.epoch, graph);
      if (result.operation === 'revalidate') {
        if (result.decision.eligible !== (effective(event, state, graph).state === 'forwarding')) fail();
      } else {
        if (result.decision.sampling === 'captured' && result.decision.domainEligible !== (effective(event, state, graph).state === 'forwarding')) fail();
        expected.handoffClockArm = null;
      }
      break;
    }
  }
  if (!same(expected, state)) fail();
}
function recoveryConsistency(result: InboxRecoveryResult, context: ResultValidationContext, state: Readonly<InboxState>): void {
  const { binding, metadata, graph, postDataDigest, dataRowCount } = context;
  if (state.handoffClockArm !== null || state.restartEpoch > result.oldEpoch || result.oldEpoch > metadata.epoch ||
      result.postStateDigest !== stateDigest(binding, metadata.state, 'operator-recovery') ||
      result.postDataDigest !== postDataDigest || result.dataRowCount !== dataRowCount) fail();
  const d = result.disposition;
  if (d.kind === 'inbox-clock-uncertain') {
    const seal = graph.sealByGeneration(d.generation);
    if (!seal || seal.generation !== d.generation || seal.lastOrder !== state.records || state.currentGeneration !== null ||
        d.watermark !== state.lastNow || seal.watermark > d.watermark || seal.epoch > result.oldEpoch) fail();
    // An existing regression remains proved at its frozen watermark. A newly
    // uncertain interval records only the prior durable watermark, never a sample.
    if (seal.reason === 'clock-uncertain' && (seal.observation !== null || seal.watermark !== d.watermark || seal.epoch !== result.oldEpoch)) fail();
    for (let order = d.generation; order <= seal.lastOrder; order++) {
      const event = graph.eventByOrder(order); if (!event || event.generation !== d.generation) fail();
      const projected = projectEvent(event, state, seal);
      if (event.state === 'terminal' || event.state === 'blocked') {
        if (projected.state !== event.state || projected.reason !== event.reason) fail();
      } else if (projected.state !== 'blocked' || projected.reason !== (event.deadline <= seal.watermark ? 'deadline' : seal.reason)) fail();
    }
  }
  const x = metadata.exit;
  if (!x) fail();
  // A later clean exit can replace recovery evidence without touching domain bytes.
  // A later inbox recovery cannot: both dispositions must install a new result.
  // Same-invocation/epoch evidence therefore always requires exact correlation.
  if (x.kind === 'operator-recovery' || x.invocation === result.invocation || x.oldEpoch <= result.oldEpoch) {
    if (x.kind !== 'operator-recovery' || x.invocation !== result.invocation || x.oldEpoch !== result.oldEpoch ||
        x.originalMDigest !== result.originalMDigest ||
        x.domainDispositionDigest !== digest(['orka-inbox-recovery-v2', binding.bytes.toString('base64'), metadata.result.toString('base64')])) fail();
  }
}
/** Validates committed decisions, never a caller Boolean, POST, or forwarding grant. */
export function validateResult(context: ResultValidationContext): void {
  boundary('corrupt', () => {
    const { binding, metadata, state, graph, postDataDigest, dataRowCount } = context;
    const physical = decodeState(metadata.state);
    if (!encodeState(state).equals(metadata.state)) fail();
    integer(metadata.epoch, 1, Number.MAX_SAFE_INTEGER); hex(postDataDigest); integer(dataRowCount, 0, 3 * MAX_INBOX_RECORDS);
    const result = decodeResult(metadata.result);
    if (result.operation === 'operator-recovery') { recoveryConsistency(result, context, physical); return; }
    if (result.epoch > metadata.epoch || result.postStateDigest !== stateDigest(binding, metadata.state)) fail();
    // An older retained operator Exit is not a commitment to this new ordinary state.
    ordinaryResult(result, physical, graph, dataRowCount);
  });
}
