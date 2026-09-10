// Orka 0c8ab6fb: internal/gateway/protocol/types.go.
// Wire types are not runtime validation; validate external inputs before use.
export const PROTOCOL_VERSION = 'orka.gateway.v1' as const;
export const MAX_HTTP_BODY_BYTES = 256 * 1024;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_IDENTITY_BYTES = 256;
export const MAX_METADATA_ENTRIES = 32;
export const MAX_METADATA_KEY_BYTES = 256;
export const MAX_METADATA_VALUE_BYTES = 256;
export const MAX_ADAPTER_RESPONSE_BYTES = 64 * 1024;

export interface Sender {
  id: string;
  displayName?: string;
}

export interface ResourceReference {
  namespace: string;
  name: string;
}

export interface EventEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  externalEventId: string;
  eventType: 'text';
  accountId: string;
  contextId: string;
  threadId?: string;
  sender: Sender;
  text: string;
  replyTarget?: string;
  occurredAt?: string;
  receivedAt?: string;
  metadata?: Record<string, string>;
}

export interface DeliveryRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  deliveryId: string;
  idempotencyId: string;
  originatingEventId: string;
  taskRef?: ResourceReference;
  sessionRef?: ResourceReference;
  kind: 'final' | 'error';
  accountId: string;
  contextId: string;
  threadId?: string;
  replyTarget: string;
  text: string;
  metadata?: Record<string, string>;
}
