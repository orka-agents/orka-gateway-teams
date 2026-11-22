import type { EventEnvelope } from '../protocol/types.js';

export interface IngressScope { appId: string; tenantId: string; orkaBaseUrl: string; gatewayNamespace: string; gatewayName: string }
interface RouteBase { serviceUrl: string; channelId: 'msteams'; bot: { id: string; role: 'bot' } }
interface Conversation { id: string; tenantId: string }
/** Personal persisted bytes stay unchanged; shared routes retain the winning requester. */
export type ReplyRoute = RouteBase & (
  { conversation: Conversation & { conversationType: 'personal' }; requester?: never; threadId?: never } |
  { conversation: Conversation & { conversationType: 'groupChat' }; requester: { id: string; displayName?: string }; threadId?: never } |
  { conversation: Conversation & { conversationType: 'channel' }; requester: { id: string; displayName?: string }; threadId: string }
);
export interface IngressPolicy { maxPending: number; maxRecords: number; replayWindowMs: number }
export interface IngressReceipt { status: 'accepted' | 'duplicate' | 'rejected' | 'deadLettered'; eventId: string; state: string }
export interface IngressClaim { externalEventId: string; attemptId: string; attempt: number; event: EventEnvelope }
export type AdmissionResult = { kind: 'accepted' | 'duplicate'; replyTarget: string } | { kind: 'conflict' | 'full' };
export interface IngressStore {
  readonly scope: Readonly<IngressScope>;
  admit(event: Readonly<EventEnvelope>, route: Readonly<ReplyRoute>): AdmissionResult;
  claim(): IngressClaim | undefined;
  complete(claim: Readonly<IngressClaim>, receipt: Readonly<IngressReceipt>): boolean;
  retry(claim: Readonly<IngressClaim>, delayMs: number): boolean;
  block(claim: Readonly<IngressClaim>, reason: 'conflict' | 'invalid-event' | 'redirect'): boolean;
  getRoute(replyTarget: string): ReplyRoute | undefined;
  close(): void;
}
/** Owner-local, one-use permission, separate from the unchanged public claim.
 * revalidate owns/drains any storage reconciliation. take MUST synchronously
 * recheck current owner/attempt, persisted replay eligibility and quarantine
 * after that await, consuming permission even on failure. retire never awaits.
 */
export interface IngressForwardingGrant {
  readonly claim: Readonly<IngressClaim>;
  revalidate(): boolean | Promise<boolean>;
  take(): boolean;
  retire(): void;
}
/** Operation promises own actual work/reconciliation, not caller timeout races.
 * Implementations snapshot inputs before queuing and reject storage poison;
 * ineligible grants must not revive records or authorize another handoff.
 */
export interface IngressPort {
  readonly scope: Readonly<IngressScope>;
  admit(event: Readonly<EventEnvelope>, route: Readonly<ReplyRoute>): AdmissionResult | Promise<AdmissionResult>;
  claimForForwarding(): IngressForwardingGrant | undefined | Promise<IngressForwardingGrant | undefined>;
  complete(claim: Readonly<IngressClaim>, receipt: Readonly<IngressReceipt>): boolean | Promise<boolean>;
  retry(claim: Readonly<IngressClaim>, delayMs: number): boolean | Promise<boolean>;
  block(claim: Readonly<IngressClaim>, reason: 'conflict' | 'invalid-event' | 'redirect'): boolean | Promise<boolean>;
  getRoute(replyTarget: string): ReplyRoute | undefined | Promise<ReplyRoute | undefined>;
  close(): void | Promise<void>;
}
export interface StoreOptions { policy?: IngressPolicy; now?: () => number }
/** `reason` is a fixed code for logs (an HTTP status, a Node error code or a word below), never a value. */
export type OrkaPostResult = { kind: 'receipt'; receipt: IngressReceipt } | { kind: 'retry'; retryAfterMs?: number; reason?: string } | { kind: 'blocked'; reason: 'conflict' | 'invalid-event' | 'redirect' };
/** One forward attempt that was put back: the step it stopped at and why. `delayMs` is absent when the inbox sets the delay itself. */
export interface ForwardRetry { stage: 'check' | 'grant' | 'inbox' | 'post'; reason: string; attempt: number; delayMs?: number }
// Storage codes of this gateway, then Node's connection and certificate codes.
const reasonCodes = new Set(['busy', 'unavailable', 'unready', 'conflict', 'corrupt', 'closed', 'invalid-input', 'operation-conflict', 'not-submitted',
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EPROTO',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SOCKET_CONNECTION_TIMEOUT']);
/** A code from an error for logs: its own `code` only when it is on the fixed list, otherwise the fallback. */
export function reasonCode(error: unknown, fallback = 'error'): string {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && reasonCodes.has(code) ? code : fallback;
}
export type OrkaPostPreparation = { kind: 'ready'; gatewayGrantRef: string } | Exclude<OrkaPostResult, { kind: 'receipt' }>;
export interface OrkaClient {
  /** Resolve asynchronous delegated authority before the inbox's final forwarding check. */
  prepare?(event: Readonly<EventEnvelope>, signal?: AbortSignal): Promise<OrkaPostPreparation>;
  post(event: Readonly<EventEnvelope>, signal?: AbortSignal, preparation?: Extract<OrkaPostPreparation, { kind: 'ready' }>): Promise<OrkaPostResult>;
}

const messages = {
  'invalid-input': 'Invalid ingress input.', missing: 'Ingress storage is missing.',
  exists: 'Ingress storage already exists.', busy: 'Ingress storage is already owned.',
  'scope-mismatch': 'Ingress scope does not match.', 'unsupported-schema': 'Ingress schema is unsupported.',
  corrupt: 'Ingress storage is invalid.', unavailable: 'Ingress storage is unavailable.', closed: 'Ingress store is closed.',
} as const;
export type IngressStoreErrorCode = keyof typeof messages;
export class IngressStoreError extends Error {
  constructor(readonly code: IngressStoreErrorCode, options?: ErrorOptions) {
    super(messages[code], options); this.name = 'IngressStoreError';
  }
}
