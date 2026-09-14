import { integer } from '../storage/table/codec.js';
import { TableError } from '../storage/table/types.js';
import type { DataKey } from '../storage/table/types.js';
import { MAX_INBOX_RECORDS, MAX_INBOX_TIME } from './table-types.js';
import type { EffectiveEventState, EventPayload, InboxState, SealPayload } from './table-types.js';

export function initialState(): InboxState {
  return { journal: 'teams-inbox', schema: 1, fingerprintVersion: 1, records: 0, bodies: 0,
    lastNow: 0, restartEpoch: 1, currentGeneration: null, handoffClockArm: null };
}
export function sealKey(generation: number): DataKey {
  return { type: 'control', id: `generation:${integer(generation, 1, MAX_INBOX_RECORDS)}` };
}
/** State is structurally decoded/trusted; the supplied clock and epoch are external scalars.
 * Open processes this clock before preparing restartEpoch. Empty calls never start groups. */
export function advanceClock(state: Readonly<InboxState>, time: number, epoch: number): { state: InboxState; seal?: SealPayload } {
  integer(time, 0, MAX_INBOX_TIME); integer(epoch, 1, Number.MAX_SAFE_INTEGER);
  const next: InboxState = { ...state, lastNow: Math.max(state.lastNow, time),
    handoffClockArm: state.handoffClockArm === null ? null : { ...state.handoffClockArm } };
  if (time >= state.lastNow || state.currentGeneration === null) return { state: next };
  next.currentGeneration = null;
  return { state: next, seal: { schema: 1, kind: 'generation-seal', generation: state.currentGeneration,
    lastOrder: state.records, watermark: state.lastNow, observation: time, epoch, reason: 'clock-regression' } };
}
/** Structurally decoded inputs only. These local cross-reference fences are not a complete
 * graph audit. Missing seals cannot enable active rows; terminal/explicit rows need no seal
 * to remain ineligible. A supplied seal must match, even for those sticky physical states. */
export function projectEvent(event: Readonly<Omit<EventPayload, 'body'>>, state: Readonly<InboxState>, seal?: Readonly<SealPayload>): EffectiveEventState {
  if (event.order > state.records || event.received > state.lastNow || event.attemptEpoch > state.restartEpoch) {
    throw new TableError('corrupt');
  }
  if (seal && (seal.generation !== event.generation || event.order > seal.lastOrder || seal.lastOrder > state.records ||
      seal.watermark > state.lastNow || event.received > seal.watermark || event.attemptEpoch > seal.epoch ||
      (state.currentGeneration !== null && seal.lastOrder >= state.currentGeneration))) throw new TableError('corrupt');
  const physical = { state: event.state, reason: event.reason, attemptId: event.attemptId };
  if (event.state === 'terminal' || event.state === 'blocked') return physical;
  if (!seal && event.generation !== state.currentGeneration) throw new TableError('corrupt');
  // Frozen seal watermark wins over all later clocks, including subsequent generations.
  if (event.deadline <= (seal?.watermark ?? state.lastNow)) return { ...physical, state: 'blocked', reason: 'deadline' };
  if (seal) return { ...physical, state: 'blocked', reason: seal.reason };
  if (event.state === 'forwarding' && event.attemptEpoch < state.restartEpoch) return { ...physical, state: 'pending', attemptId: null };
  return physical;
}
