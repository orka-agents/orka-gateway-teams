import type { EventEnvelope } from '../protocol/types.js';
import type { IngressReceipt, ReplyRoute } from './types.js';
import { MAX_REPLAY_WINDOW_MS } from './codec.js';

export const MAX_INBOX_RECORDS = 100000;
export const MAX_INBOX_TIME = Number.MAX_SAFE_INTEGER - MAX_REPLAY_WINDOW_MS;
export const MAX_EVENT_PAYLOAD_BYTES = 140 * 1024;
export const MAX_ROUTE_PAYLOAD_BYTES = 16 * 1024;
export const MAX_SEAL_PAYLOAD_BYTES = 1024;
export const MAX_INBOX_STATE_BYTES = 4 * 1024;

export type ExplicitBlockReason = 'conflict' | 'invalid-event' | 'redirect';
export type SealReason = 'clock-regression' | 'clock-uncertain';
export interface HandoffClockArm {
  id: string; ownerEpoch: number; generation: number; order: number; attemptId: string;
}
export interface InboxState {
  journal: 'teams-inbox'; schema: 1; fingerprintVersion: 1;
  records: number; bodies: number; lastNow: number; restartEpoch: number;
  currentGeneration: number | null; handoffClockArm: HandoffClockArm | null;
}
/** The external event ID is the physical key, not a second outer payload field. */
export interface EventPayload {
  schema: 1; fingerprintVersion: 1; replyTarget: string; fingerprint: string; bodyDigest: string;
  body: (EventEnvelope & { replyTarget: string }) | null;
  state: 'pending' | 'forwarding' | 'blocked' | 'terminal';
  received: number; deadline: number; nextAttempt: number; attempt: number; attemptId: string | null;
  attemptEpoch: number; order: number; generation: number; receipt: IngressReceipt | null; reason: ExplicitBlockReason | null;
}
export interface RoutePayload { schema: 1; externalEventId: string; route: ReplyRoute; routeDigest: string }
export interface SealPayload {
  schema: 1; kind: 'generation-seal'; generation: number; lastOrder: number;
  watermark: number; observation: number | null; epoch: number; reason: SealReason;
}
/** Body-free projection, not a forwarding grant. Only old forwarding loses its effective ID. */
export interface EffectiveEventState {
  state: EventPayload['state']; reason: ExplicitBlockReason | SealReason | 'deadline' | null; attemptId: string | null;
}
