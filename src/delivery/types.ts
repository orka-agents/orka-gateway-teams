import type { DeliveryRequest } from '../protocol/types.js';

export interface JournalScope { appId: string; tenantId: string }
export interface DeliveryClaim { idempotencyId: string; attemptId: string }
export type TerminalOutcome =
  | { kind: 'delivered'; providerMessageId: string }
  | { kind: 'rejected' }
  | { kind: 'unknown' };
export type DeliveryOutcome = TerminalOutcome | { kind: 'retryable' };
export type BeginDeliveryResult =
  | { kind: 'claimed'; claim: DeliveryClaim }
  | { kind: 'inFlight' }
  | { kind: 'conflict' }
  | TerminalOutcome;
export type SettlementResult = 'recorded' | 'unchanged' | 'stale';
export interface DeliveryJournal {
  begin(request: Readonly<DeliveryRequest>): BeginDeliveryResult;
  settle(claim: Readonly<DeliveryClaim>, outcome: Readonly<DeliveryOutcome>): SettlementResult;
  close(): void;
}

/** Runtime orchestration port; the public SQLite journal remains synchronous.
 * Promises cover actual durable work/reconciliation, not caller timeout races.
 * Implementations snapshot inputs before queuing and reject storage poison.
 */
export interface DeliveryJournalPort {
  begin(request: Readonly<DeliveryRequest>): BeginDeliveryResult | Promise<BeginDeliveryResult>;
  settle(claim: Readonly<DeliveryClaim>, outcome: Readonly<DeliveryOutcome>): SettlementResult | Promise<SettlementResult>;
  close(): void | Promise<void>;
}

const messages = {
  'invalid-input': 'Invalid delivery journal input.',
  missing: 'Delivery journal storage is missing.',
  exists: 'Delivery journal storage already exists.',
  busy: 'Delivery journal is already owned.',
  'scope-mismatch': 'Delivery journal scope does not match.',
  'unsupported-schema': 'Delivery journal schema is unsupported.',
  corrupt: 'Delivery journal storage is invalid.',
  unavailable: 'Delivery journal storage is unavailable.',
  closed: 'Delivery journal is closed.',
} as const;
export type DeliveryJournalErrorCode = keyof typeof messages;

export class DeliveryJournalError extends Error {
  constructor(readonly code: DeliveryJournalErrorCode, options?: ErrorOptions) {
    super(messages[code], options);
    this.name = 'DeliveryJournalError';
  }
}
