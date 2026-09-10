import type { IMessageActivityInput } from '@microsoft/teams.api';
import type { IAdaptiveCard } from '@microsoft/teams.cards';
import type { DeliveryRequest } from '../protocol/types.js';

export const MAX_OUTGOING_MESSAGE_BYTES = 20 * 1024;

export type OutgoingTeamsMessage = IMessageActivityInput & {
  text?: '';
  attachments: [{
    contentType: 'application/vnd.microsoft.card.adaptive';
    content: IAdaptiveCard;
  }];
};

/**
 * #551 supplies the deterministic, non-mutating formatter. The delivery has
 * already been validated. Budget the complete serialized message, not just text.
 * Destination, persistence, credentials, sending, and retries belong to the caller.
 */
export type FormatDelivery = (delivery: Readonly<DeliveryRequest>) => OutgoingTeamsMessage;
