import type { IAdaptiveCard } from '@microsoft/teams.cards';
import { PROTOCOL_VERSION } from '../../src/protocol/types.js';
import type { DeliveryRequest } from '../../src/protocol/types.js';
import type { OutgoingTeamsMessage } from '../../src/teams/format.js';
import { expectedEvent } from './incoming.js';

export const finalDelivery = {
  protocolVersion: PROTOCOL_VERSION,
  deliveryId: 'delivery-fixture-final',
  idempotencyId: 'idempotency-fixture-final',
  originatingEventId: expectedEvent.externalEventId,
  taskRef: { namespace: 'fixture', name: 'fixture-task' },
  sessionRef: { namespace: 'fixture', name: 'fixture-session' },
  kind: 'final',
  accountId: expectedEvent.accountId,
  contextId: expectedEvent.contextId,
  replyTarget: expectedEvent.replyTarget,
  text: 'Project summary\n\n- Review open issues\n- Run `npm test`\n\nこんにちは 🧑🏽‍💻',
} satisfies DeliveryRequest;

export const errorDelivery = {
  protocolVersion: PROTOCOL_VERSION,
  deliveryId: 'delivery-fixture-error',
  idempotencyId: 'idempotency-fixture-error',
  originatingEventId: expectedEvent.externalEventId,
  kind: 'error',
  accountId: expectedEvent.accountId,
  contextId: expectedEvent.contextId,
  replyTarget: expectedEvent.replyTarget,
  text: 'This request could not be completed.',
} satisfies DeliveryRequest;

// Synthetic protocol-bounded input large enough to exercise real card shortening.
export const oversizedDelivery = {
  ...finalDelivery,
  deliveryId: 'delivery-fixture-oversized',
  idempotencyId: 'idempotency-fixture-oversized',
  text: 'Synthetic reply section\n\n- Review open issues\n- Run `npm test`\n\nこんにちは 🧑🏽‍💻 e\u0301\n\n'.repeat(400),
} satisfies DeliveryRequest;

const finalCard = {
  type: 'AdaptiveCard',
  version: '1.4',
  fallbackText: 'Orka reply: Project summary - Review open issues - Run `npm test` こんにちは 🧑🏽‍💻',
  body: [
    { type: 'TextBlock', text: 'Orka reply', weight: 'Bolder', wrap: true },
    { type: 'TextBlock', text: 'Project summary\n\n- Review open issues\n- Run `npm test`\n\nこんにちは 🧑🏽‍💻', wrap: true },
  ],
} satisfies IAdaptiveCard;

const errorCard = {
  type: 'AdaptiveCard',
  version: '1.4',
  fallbackText: 'Orka could not complete the request: This request could not be completed.',
  body: [
    { type: 'TextBlock', text: 'Orka could not complete the request', weight: 'Bolder', wrap: true },
    { type: 'TextBlock', text: 'This request could not be completed.', wrap: true },
  ],
} satisfies IAdaptiveCard;

// Explicit annotation lets tests inspect optional activity text, while each card
// has already been checked independently instead of flowing through SDK any.
export const finalMessage: OutgoingTeamsMessage = {
  type: 'message',
  attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: finalCard }],
};

export const errorMessage: OutgoingTeamsMessage = {
  type: 'message',
  attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: errorCard }],
};
