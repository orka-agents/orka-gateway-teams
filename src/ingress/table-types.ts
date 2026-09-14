import type { EventEnvelope } from '../protocol/types.js';
import type { AdmissionResult, IngressPolicy, IngressReceipt, ReplyRoute } from './types.js';
import { MAX_REPLAY_WINDOW_MS } from './codec.js';

export const MAX_INBOX_RECORDS = 100000;
export const MAX_INBOX_TIME = Number.MAX_SAFE_INTEGER - MAX_REPLAY_WINDOW_MS;
export const MAX_EVENT_PAYLOAD_BYTES = 140 * 1024;
export const MAX_ROUTE_PAYLOAD_BYTES = 16 * 1024;
export const MAX_SEAL_PAYLOAD_BYTES = 1024;
export const MAX_INBOX_STATE_BYTES = 4 * 1024;
export const MAX_INBOX_RESULT_BYTES = 4 * 1024;
export const MAX_INBOX_RECOVERY_RESULT_BYTES = 1024;

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
/** Decoded, body-free evidence. Physical state represents body presence. */
export interface EventSummary extends Omit<EventPayload, 'body'> { externalEventId: string }
/** Callers have completed row, reference, counter, generation and epoch validation. */
export interface InboxGraph {
  eventById(id: string): EventSummary | undefined;
  eventByTarget(target: string): EventSummary | undefined;
  eventByOrder(order: number): EventSummary | undefined;
  sealByGeneration(generation: number): SealPayload | undefined;
}
export interface InboxResultBasis {
  records: number; bodies: number; lastNow: number; restartEpoch: number;
  currentGeneration: number | null; arm: HandoffClockArm | null;
}
export interface InboxResultClaim { eventId: string; attemptId: string; attempt: number }
interface OrdinaryResultBase { schema: 1; epoch: number; postStateDigest: string }
interface SampledResultBase extends OrdinaryResultBase { basis: InboxResultBasis; clock: { time: number } }
export type OrdinaryInboxResult =
  (OrdinaryResultBase & { operation: 'initialize'; basis: null; clock: null; decision: { kind: 'initialized' } }) |
  (SampledResultBase & (
    { operation: 'open'; decision: { kind: 'opened' } } |
    { operation: 'admit'; decision: { eventId: string; replyTarget: string; fingerprint: string; policy: IngressPolicy; outcome: AdmissionResult } } |
    { operation: 'claim'; decision: { kind: 'empty' } | ({ kind: 'claimed' } & InboxResultClaim) } |
    { operation: 'complete'; decision: { claim: InboxResultClaim; receipt: IngressReceipt; applied: boolean } } |
    { operation: 'retry'; decision: { claim: InboxResultClaim; delayMs: number; applied: boolean } } |
    { operation: 'block'; decision: { claim: InboxResultClaim; reason: ExplicitBlockReason; applied: boolean } } |
    { operation: 'revalidate'; decision: { armId: string; eligible: boolean } } |
    { operation: 'handoff-finalize'; decision: { armId: string; sampling: 'captured'; domainEligible: boolean } }
  )) |
  (OrdinaryResultBase & { operation: 'handoff-finalize'; basis: InboxResultBasis; clock: null;
    decision: { armId: string; sampling: 'none'; domainEligible: null } });
export interface InboxRecoveryResult {
  schema: 1; operation: 'operator-recovery'; invocation: string; oldEpoch: number; originalMDigest: string;
  disposition: { kind: 'inbox-unarmed' } |
    { kind: 'inbox-clock-uncertain'; armId: string; generation: number; watermark: number };
  postStateDigest: string; postDataDigest: string; dataRowCount: number;
}
export type InboxResult = OrdinaryInboxResult | InboxRecoveryResult;
/** Body-free projection, not a forwarding grant. Only old forwarding loses its effective ID. */
export interface EffectiveEventState {
  state: EventPayload['state']; reason: ExplicitBlockReason | SealReason | 'deadline' | null; attemptId: string | null;
}
