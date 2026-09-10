import { MessageActivity } from '@microsoft/teams.api';
import { PROTOCOL_VERSION } from '../../src/protocol/types.js';
import type { EventEnvelope } from '../../src/protocol/types.js';
import type { ConversionContext } from '../../src/teams/convert.js';

export const conversionContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  replyTarget: 'rt_fixture_personal_1',
} satisfies ConversionContext;

export const personalMessage = new MessageActivity('Summarize this project.\n\nこんにちは 🧑🏽‍💻', {
  id: 'fixture-message-1',
  channelId: 'msteams',
  serviceUrl: 'https://teams-service.example.invalid/',
  from: { id: '29:fixture-person', name: 'Example Person', role: 'user' },
  recipient: { id: '28:fixture-app', name: 'Orka', role: 'bot' },
  conversation: {
    id: '19:fixture-personal',
    conversationType: 'personal',
    tenantId: conversionContext.tenantId,
  },
  channelData: { tenant: { id: conversionContext.tenantId } },
});

// Independent expected wire example, not the result of a converter implementation.
export const expectedEvent = {
  protocolVersion: PROTOCOL_VERSION,
  externalEventId: 'teams:v1:a4e643cbbb0d029bc04f9432b734fd0d0af2e1aa33002e05ef9b74fcc0bc0a98',
  eventType: 'text',
  accountId: '11111111-1111-4111-8111-111111111111',
  contextId: '19:fixture-personal',
  sender: { id: '29:fixture-person', displayName: 'Example Person' },
  text: 'Summarize this project.\n\nこんにちは 🧑🏽‍💻',
  replyTarget: 'rt_fixture_personal_1',
} satisfies EventEnvelope;
