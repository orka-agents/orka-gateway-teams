import type { EventEnvelope } from '../protocol/types.js';

export interface IngressScope { appId: string; tenantId: string; orkaBaseUrl: string; gatewayNamespace: string; gatewayName: string }
export interface ReplyRoute { serviceUrl: string; channelId: 'msteams'; bot: { id: string; role: 'bot' }; conversation: { id: string; conversationType: 'personal'; tenantId: string } }
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
export interface StoreOptions { policy?: IngressPolicy; now?: () => number }
export type OrkaPostResult = { kind: 'receipt'; receipt: IngressReceipt } | { kind: 'retry'; retryAfterMs?: number } | { kind: 'blocked'; reason: 'conflict' | 'invalid-event' | 'redirect' };
export interface OrkaClient { post(event: Readonly<EventEnvelope>, signal?: AbortSignal): Promise<OrkaPostResult> }

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
