import type { DeliveryRequest } from '../protocol/types.js';
import type { DeliveryJournal, JournalScope } from '../delivery/types.js';
import type { ReplyRoute } from '../ingress/types.js';
import type { OutgoingTeamsMessage } from '../teams/format.js';

export interface DeliveryResponse {
  status: 'delivered' | 'retryableError' | 'nonRetryableError';
  providerMessageId?: string;
  message?: string;
}
export interface DeliveryContext { signal?: AbortSignal; deadline?: number }
export type ProviderResult = { kind: 'delivered'; providerMessageId: string } | { kind: 'retryable' | 'unknown' };
export interface ProviderSender {
  send(route: Readonly<ReplyRoute>, message: Readonly<OutgoingTeamsMessage>, context?: DeliveryContext): Promise<ProviderResult>;
  stop(): Promise<void>;
}
export interface DispatcherOptions {
  journal: DeliveryJournal;
  scope: Readonly<JournalScope>;
  getRoute: (replyTarget: string) => ReplyRoute | undefined;
  serviceUrls: readonly string[];
  recipientIds: readonly string[];
  sender: ProviderSender;
}
export interface DeliveryDispatcher {
  readonly healthy: boolean;
  deliver(request: Readonly<DeliveryRequest>, context?: DeliveryContext): Promise<DeliveryResponse>;
  stop(): Promise<void>; // Cancel/drain owned work and sender, never caller-owned stores.
}
