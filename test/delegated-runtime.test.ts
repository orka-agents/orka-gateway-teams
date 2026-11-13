import assert from 'node:assert/strict';
import test from 'node:test';
import { startReceiver } from '../src/ingress/server.js';
import type { AdmissionContext } from '../src/ingress/server.js';
import { createProviderSender } from '../src/outbound/sender.js';
import type { OutgoingTeamsMessage } from '../src/teams/format.js';
import { activity, authFixture, post, receiverConfig, scope } from './support/ingress-auth.js';

const oid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('authenticated exchange invokes return explicit structured200/412 and never become events', async t => {
  const auth = await authFixture(t); let events = 0; let invokes = 0; let reject = false;
  const receiver = await startReceiver(receiverConfig, { scope,
    admit() { events++; return { kind: 'full' }; },
    async exchange(_input, context) {
      invokes++; assert.equal(context.subject.objectId, oid);
      return { status: reject ? 412 : 200, body: { id: 'opaque-challenge', connectionName: 'workiq', ...(reject ? { failureDetail: 'signin-required' } : {}) } };
    } }, auth.dependencies);
  t.after(() => receiver.stop());
  const input = { ...activity(), type: 'invoke', name: 'signin/tokenExchange', from: { ...activity().from, aadObjectId: oid },
    value: { id: 'opaque-challenge', token: 'synthetic-private-token', connectionName: 'workiq' } };
  let response = await post(receiver.port, auth.token(), input);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { id: 'opaque-challenge', connectionName: 'workiq' });
  reject = true; response = await post(receiver.port, auth.token(), input);
  assert.equal(response.status, 412); assert.deepEqual(await response.json(), { id: 'opaque-challenge', connectionName: 'workiq', failureDetail: 'signin-required' });
  const missingTenant = { ...input, channelData: {} };
  assert.equal((await post(receiver.port, auth.token(), missingTenant)).status, 403);
  assert.equal((await post(receiver.port, auth.token(), { ...input, from: { id: '29:other' } })).status, 403);
  assert.equal((await post(receiver.port, 'not-authenticated', input)).status, 401);
  assert.equal(events, 0); assert.equal(invokes, 2);
});

test('request context keeps delegated tenant evidence and Teams recipient separate from shared sender oid', async t => {
  const auth = await authFixture(t); let context: AdmissionContext | undefined;
  const receiver = await startReceiver(receiverConfig, { scope, admit(_e, _r, ctx) { context = ctx; return { kind: 'accepted', replyTarget: 'rt' }; } }, auth.dependencies);
  t.after(() => receiver.stop());
  const input = activity(); input.from.aadObjectId = oid;
  input.conversation.conversationType = 'groupChat'; input.text = '<at>Orka</at> do work';
  input.entities = [{ type: 'mention', text: '<at>Orka</at>', mentioned: { id: input.recipient.id } }];
  assert.equal((await post(receiver.port, auth.token(), input)).status, 200);
  assert.equal(context?.delegatedTenant, true); assert.deepEqual(context?.controlRecipient, { id: input.from.id, isTargeted: true });
});

test('sender-targeted group card uses SDK documented targeted endpoint and exact recipient; never room fallback', async () => {
  let url = ''; let body: Record<string, unknown> | undefined;
  const sender = createProviderSender(async () => 'synthetic-bot-token', { post: async (target, bytes) => {
    url = target; body = JSON.parse(bytes.toString()) as Record<string, unknown>;
    return { status: 201, data: Buffer.from('{"id":"receipt"}') };
  } });
  const message = { type: 'message', recipient: { id: '29:teams-sender', isTargeted: true }, attachments: [{
    contentType: 'application/vnd.microsoft.card.oauth', content: { text: 'Sign in', connectionName: 'workiq',
      tokenExchangeResource: { id: 'opaque', uri: 'api://gateway', providerId: 'Azure Active Directory v2' }, buttons: [] } }] } as unknown as OutgoingTeamsMessage;
  const result = await sender.send({ serviceUrl: receiverConfig.serviceUrls[0]!, conversation: {
    id: '19:group', tenantId: scope.tenantId, conversationType: 'groupChat' } }, message);
  assert.equal(result.kind, 'delivered'); assert.ok(url.endsWith('/activities?isTargetedActivity=true'));
  assert.deepEqual(body?.recipient, { id: '29:teams-sender', isTargeted: true }); await sender.stop();
});
