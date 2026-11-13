import type { DeliveryRequest } from '../protocol/types.js';
import type { DeliveryJournalPort, JournalScope } from '../delivery/types.js';
import type { SessionCorrelationPort } from '../delivery/session-correlation.js';
import type { ReplyRoute } from '../ingress/types.js';
import type { OutgoingTeamsMessage } from '../teams/format.js';
import type { MembersResult } from './meeting-roster.js';

export interface DeliveryResponse {
  status: 'delivered' | 'retryableError' | 'nonRetryableError';
  providerMessageId?: string;
  message?: string;
}
export interface DeliveryContext { signal?: AbortSignal; deadline?: number; authority?: import('../storage/table/types.js').LeaseAuthority }
export type ProviderResult = { kind: 'delivered'; providerMessageId: string } | { kind: 'retryable' | 'unknown' };
export type ProviderRoute = Pick<ReplyRoute, 'serviceUrl' | 'conversation'>;
export type ControlRecipient = { id: string; isTargeted?: true };
export type ProviderMessage = OutgoingTeamsMessage | { type: 'message'; replyToId?: string; recipient?: ControlRecipient; attachments: [{
  contentType: 'application/vnd.microsoft.card.oauth'; content: { text: string; connectionName: string;
    tokenExchangeResource: { id: string; uri: string; providerId: 'Azure Active Directory v2' }; buttons: [] };
}] };
export interface ProviderSender {
  getMembers?(route: Readonly<ReplyRoute>, context?: DeliveryContext): Promise<MembersResult>;
  send(route: Readonly<ProviderRoute>, message: Readonly<ProviderMessage>, context?: DeliveryContext): Promise<ProviderResult>;
  stop(): Promise<void>;
}
export interface DispatcherOptions {
  authority?: import('../storage/table/types.js').LeaseAuthority;
  interimDelivery?: boolean;
  meetingDrafts?: boolean;
  journal: DeliveryJournalPort;
  correlation?: SessionCorrelationPort;
  scope: Readonly<JournalScope>;
  getRoute: (replyTarget: string) => ReplyRoute | undefined | Promise<ReplyRoute | undefined>;
  serviceUrls: readonly string[];
  recipientIds: readonly string[];
  sender: ProviderSender;
}
export interface DeliveryDispatcher {
  readonly healthy: boolean;
  deliver(request: Readonly<DeliveryRequest>, context?: DeliveryContext): Promise<DeliveryResponse>;
  stop(): Promise<void>; // Cancel/drain owned work and sender, never caller-owned stores.
}
