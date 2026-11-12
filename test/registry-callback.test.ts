import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { startReceiver } from '../src/ingress/server.js';
import { startTargetOutboundServer } from '../src/outbound/server.js';
import { finalDelivery } from './fixtures/outgoing.js';
import { authFixture, deferred, receiverConfig, scope, serviceUrl } from './support/ingress-auth.js';
import { eventually } from './support/table-service.js';

async function fixture(t: test.TestContext, holdToken = false) {
  const directory = mkdtempSync(join(tmpdir(), 'registry-callback-')); const auth = await authFixture(t);
  const gate = deferred<void>(); let tokens = 0; let posts = 0; const routes = [0, 0]; let ready = true;
  const journalScope = { appId: scope.appId, tenantId: scope.tenantId };
  const journals = ['primary', 'tools'].map(id => { const path = join(directory, id); initializeDeliveryJournal(path, journalScope); return openDeliveryJournal(path, journalScope); });
  const receiver = await startReceiver(receiverConfig, { scope, admit() { return { kind: 'full' }; } }, {
    ...auth.dependencies, botToken: async () => { tokens++; if (holdToken) await gate.promise; return 'synthetic-only'; },
    providerPost: async () => ({ status: 201, data: Buffer.from(JSON.stringify({ id: `receipt-${++posts}` })) }),
  }, { targets: journals.map((journal, i) => ({ id: i ? 'tools' : 'primary', journal, getRoute() {
    routes[i]!++; return { serviceUrl, channelId: 'msteams', bot: { id: receiverConfig.recipientIds[0]!, role: 'bot' },
      conversation: { id: finalDelivery.contextId, conversationType: 'personal', tenantId: scope.tenantId } };
  } })) });
  const api = await startTargetOutboundServer({ host: '127.0.0.1', port: 0 }, ['primary', 'tools'].map((id, i) => ({
    prefix: `/targets/${id}`, bearerToken: `callback-${id}`, dispatcher: receiver.outbounds!.get(id)!, scope: journalScope,
  })), () => ready);
  t.after(async () => { gate.resolve(); await api.stop(); await receiver.stop(); journals.forEach(j => j.close()); rmSync(directory, { recursive: true, force: true }); });
  const call = (path: string, token: string, body?: unknown) => fetch(`http://127.0.0.1:${api.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { receiver, api, journals, routes, gate, call, posts: () => posts, tokens: () => tokens, unready() { ready = false; } };
}

test('colliding delivery/session/reply IDs use distinct journals and receipts through one SDK sender', async t => {
  const f = await fixture(t);
  for (const [prefix, id, receipt] of [['/targets/primary', 'primary', 'receipt-1'], ['/targets/tools', 'tools', 'receipt-2']]) {
    const response = await f.call(`${prefix}/v1/deliveries`, `callback-${id}`, finalDelivery);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'delivered', providerMessageId: receipt });
    const replay = await f.call(`${prefix}/v1/deliveries`, `callback-${id}`, { ...finalDelivery, deliveryId: 'alias' });
    assert.deepEqual(await replay.json(), { status: 'delivered', providerMessageId: receipt });
  }
  assert.deepEqual(f.routes, [1, 1]); assert.equal(f.posts(), 2); assert.equal(f.tokens(), 2);
});
test('callback path bearer is checked before routes, body, readiness and any other slot', async t => {
  const f = await fixture(t); f.unready();
  for (const [prefix, wrong] of [['/targets/primary', 'callback-tools'], ['/targets/tools', 'callback-primary']] as const) {
    assert.equal((await f.call(`${prefix}/v1/deliveries`, wrong, { targetId: 'tools' })).status, 401);
    assert.equal((await f.call(`${prefix}/v1/health`, wrong)).status, 401);
  }
  assert.deepEqual(f.routes, [0, 0]); assert.equal(f.tokens(), 0);
});
test('prefixed health/capabilities are exact; unknown paths authenticate and never touch storage', async t => {
  const f = await fixture(t);
  for (const [prefix, id] of [['/targets/primary', 'primary'], ['/targets/tools', 'tools']]) {
    assert.equal((await f.call(`${prefix}/v1/health`, `callback-${id}`)).status, 200);
    const c = await (await f.call(`${prefix}/v1/capabilities`, `callback-${id}`)).json() as any;
    assert.equal(c.capabilities.idempotentDelivery, true);
  }
  for (const path of ['/v1/health', '/v1/capabilities', '/v1/deliveries', '/unknown', '/targets/missing/v1/deliveries', '/targets/tools/v1/health?x=1']) {
    assert.equal((await f.call(path, 'bad')).status, 401); assert.equal((await f.call(path, 'callback-primary')).status, 404);
  }
  assert.deepEqual(f.routes, [0, 0]); assert.equal(f.posts(), 0);
});
test('body cannot select a different callback journal', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/targets/primary/v1/deliveries', 'callback-primary', { ...finalDelivery, targetId: 'tools' })).status, 400);
  assert.deepEqual(f.routes, [0, 0]); assert.equal(f.posts(), 0);
});
test('single-target outbound.stop still drains the real sender after caller cancellation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'single-sender-drain-')); const path = join(directory, 'journal');
  const journalScope = { appId: scope.appId, tenantId: scope.tenantId }; initializeDeliveryJournal(path, journalScope);
  const journal = openDeliveryJournal(path, journalScope); const auth = await authFixture(t); const gate = deferred<void>(); let entered = false;
  const receiver = await startReceiver(receiverConfig, { scope, admit() { return { kind: 'full' }; } }, { ...auth.dependencies,
    botToken: async () => { entered = true; await gate.promise; return 'synthetic-only'; } }, { journal, getRoute: () => ({ serviceUrl, channelId: 'msteams',
      bot: { id: receiverConfig.recipientIds[0]!, role: 'bot' }, conversation: { id: finalDelivery.contextId, conversationType: 'personal', tenantId: scope.tenantId } }) });
  t.after(async () => { gate.resolve(); await receiver.stop(); journal.close(); rmSync(directory, { recursive: true, force: true }); });
  const abort = new AbortController(); const delivery = receiver.outbound!.deliver(finalDelivery, { signal: abort.signal });
  await eventually(() => entered); abort.abort(); await delivery;
  let stopped = false; const stopping = receiver.outbound!.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); const early = stopped; gate.resolve(); await stopping;
  assert.equal(early, false, 'single-target dispatcher retains actual SDK token work after logical send cancellation');
});

test('stopping one borrowed dispatcher does not stop the shared sender; receiver stop drains held actual token work', async t => {
  const f = await fixture(t, true); await f.receiver.outbounds!.get('primary')!.stop();
  const response = f.call('/targets/tools/v1/deliveries', 'callback-tools', finalDelivery).then(r => r.arrayBuffer(), () => undefined);
  await eventually(() => f.tokens() === 1); let stopped = false;
  const stopping = f.receiver.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  f.gate.resolve(); await stopping; await response; assert.equal(f.posts(), 0); assert.equal(stopped, true);
  // Receiver owns no store; the caller can still consult the journal after drain.
  assert.ok(f.journals[1]!.begin({ ...finalDelivery, deliveryId: 'after-stop' }));
});
