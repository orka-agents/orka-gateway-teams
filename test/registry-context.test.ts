import assert from 'node:assert/strict';
import test from 'node:test';
import { startReceiver } from '../src/ingress/server.js';
import type { AdmissionContext } from '../src/ingress/server.js';
import { activity, authFixture, deferred, post, receiverConfig, scope } from './support/ingress-auth.js';
import { eventually } from './support/table-service.js';

test('authenticated context keeps personal event bytes but normalizes bot mentions for commands', async t => {
  const auth = await authFixture(t); let context: AdmissionContext | undefined; let text = ''; let sender = '';
  const receiver = await startReceiver(receiverConfig, { scope, admit(event, _route, current) {
    context = current; text = event.text; sender = event.sender.id; return { kind: 'accepted', replyTarget: event.replyTarget! };
  } }, auth.dependencies); t.after(() => receiver.stop());
  const input = activity(); input.from.aadObjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  input.text = ' <at>Orka</at> use primary ';
  input.entities = [{ type: 'mention', text: '<at>Orka</at>', mentioned: { id: input.recipient.id } }];
  const before = performance.now(); assert.equal((await post(receiver.port, auth.token(), input)).status, 200);
  assert.ok(context); assert.equal(context.commandText, 'use primary'); assert.equal(context.activityId, input.id);
  assert.equal(context.subject.objectId, input.from.aadObjectId); assert.equal(sender, input.from.id); assert.equal(text, input.text);
  assert.ok(context.deadline >= before && context.deadline <= performance.now() + 10000);
});

test('original request deadline includes authentication and cancellation reaches held sink', async t => {
  const auth = await authFixture(t); const gate = deferred<void>(); auth.delayStrict(gate.promise);
  const hold = deferred<void>(); let context: AdmissionContext | undefined;
  const receiver = await startReceiver(receiverConfig, { scope, async admit(event, _route, current) {
    context = current; await hold.promise; return { kind: 'accepted', replyTarget: event.replyTarget! };
  } }, auth.dependencies); t.after(async () => { gate.resolve(); hold.resolve(); await receiver.stop(); });
  const response = post(receiver.port, auth.token()).catch(() => undefined);
  await eventually(() => auth.strictRequests() > 0); const authenticating = performance.now();
  gate.resolve(); await eventually(() => !!context);
  assert.ok(context!.deadline <= authenticating + 10000);
  const stop = receiver.stop(); await eventually(() => context!.signal.aborted); hold.resolve(); await stop; await response;
});

test('control sends borrow the same confined sender and token source as target callbacks', async t => {
  const auth = await authFixture(t); let bound = false; let sends = 0;
  const receiver = await startReceiver(receiverConfig, { scope,
    bindControlSender(sender) { bound = true; this.admit = async event => {
      const result = await sender.send({ serviceUrl: receiverConfig.serviceUrls[0]!, conversation: {
        id: event.contextId, tenantId: scope.tenantId, conversationType: 'personal' } }, { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
          type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: 'control', wrap: true }] } }] });
      assert.equal(result.kind, 'delivered'); return { kind: 'accepted', replyTarget: event.replyTarget! };
    }; }, admit: () => ({ kind: 'full' }) }, { ...auth.dependencies, botToken: async () => 'synthetic-only',
    providerPost: async (_url, _body, config) => { assert.equal(config.token, 'synthetic-only'); sends++; return { status: 201, data: Buffer.from('{"id":"receipt"}') }; } }, { targets: [{ id: 'primary',
      journal: { begin: () => ({ kind: 'inFlight' }), settle: () => 'stale', close: () => {} }, getRoute: () => undefined }] });
  t.after(() => receiver.stop()); assert.equal(bound, true);
  assert.equal((await post(receiver.port, auth.token())).status, 200); assert.equal(sends, 1);
});
