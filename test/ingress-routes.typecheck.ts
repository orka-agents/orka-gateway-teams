import type { ReplyRoute } from '../src/ingress/types.js';

const base = { serviceUrl: 'https://synthetic.example.invalid/', channelId: 'msteams' as const, bot: { id: 'bot', role: 'bot' as const } };
const conversation = { id: 'chat', tenantId: 'tenant' };
const personal: ReplyRoute = { ...base, conversation: { ...conversation, conversationType: 'personal' } };
const group: ReplyRoute = { ...base, conversation: { ...conversation, conversationType: 'groupChat' }, requester: { id: 'person' } };
const channel: ReplyRoute = { ...base, conversation: { ...conversation, conversationType: 'channel' }, requester: { id: 'person', displayName: 'Label' }, threadId: 'root' };
// @ts-expect-error A shared route cannot silently lose the winning requester.
const missingRequester: ReplyRoute = { ...base, conversation: { ...conversation, conversationType: 'groupChat' } };
// @ts-expect-error Channel routing requires a thread root.
const missingThread: ReplyRoute = { ...base, conversation: { ...conversation, conversationType: 'channel' }, requester: { id: 'person' } };
// @ts-expect-error Group routing has no thread scope.
const groupThread: ReplyRoute = { ...base, conversation: { ...conversation, conversationType: 'groupChat' }, requester: { id: 'person' }, threadId: 'root' };
// @ts-expect-error Personal route bytes cannot contain shared requester fields.
const personalRequester: ReplyRoute = { ...base, conversation: { ...conversation, conversationType: 'personal' }, requester: { id: 'person' } };
// @ts-expect-error Conversation scope is a closed union.
const unknown: ReplyRoute = { ...base, conversation: { ...conversation, conversationType: 'meeting' }, requester: { id: 'person' } };
void [personal, group, channel, missingRequester, missingThread, groupThread, personalRequester, unknown];
