import assert from 'node:assert/strict';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { createTableDeliveryJournalV3 } from '../src/delivery/table-journal.js';
import { createDeliveryDispatcher } from '../src/outbound/dispatcher.js';
import { fixtureProviderSender, providerServiceUrl } from './support/table-delivery-provider.js';
import { request, scope as deliveryScope } from './support/table-delivery.js';
import { createProviderSender } from '../src/outbound/sender.js';
import { createOrkaClient } from '../src/ingress/client.js';
import { createTableKernelV3 } from '../src/storage/table/owner.js';
import type { DeliveryContext } from '../src/outbound/types.js';
import type { LeaseAuthority } from '../src/storage/table/types.js';
import { finalMessage } from './fixtures/outgoing.js';
import { scope } from './support/ingress-auth.js';
import { expectedEvent } from './fixtures/incoming.js';
import { deferred, eventually, tableBinding, tableService } from './support/table-service.js';
import { TestClock } from './support/table-v3.js';
import { httpsFixture } from './support/ingress-https.js';

const route = { serviceUrl: 'https://smba.trafficmanager.net/teams/', channelId: 'msteams' as const, bot: { id: 'bot', role: 'bot' as const },
  conversation: { id: 'room', conversationType: 'personal' as const, tenantId: tableBinding.scope.tenantId } };

test('dispatcher revalidates storage after routing before it asks the provider to send', async t => {
  const s = await tableService(t, 'delivery', 3);
  const init = createTableDeliveryJournalV3(tableBinding, s.dependencies); await init.initialize(); await init.close();
  const j = createTableDeliveryJournalV3(tableBinding, s.dependencies); await j.open();
  t.after(() => j.close().catch(() => {})); let posts = 0;
  const remote = await httpsFixture(t, async (req, res) => { posts++; for await (const _ of req) {} res.end('{"id":"unproved"}'); });
  const sender = fixtureProviderSender(remote.baseUrl, remote.ca, async () => 'synthetic');
  const saved = { ...route, serviceUrl: providerServiceUrl, conversation: { ...route.conversation, id: request.contextId } };
  const dispatcher = createDeliveryDispatcher({ journal: j, sender, authority: j.leaseAuthority(), scope: deliveryScope,
    serviceUrls: [providerServiceUrl], recipientIds: ['bot'], getRoute: () => {
      s.controls.hook = e => { if (e.req.method === 'GET') { e.res.writeHead(503); e.res.end(); } else e.reply(); }; return saved;
    } });
  t.after(() => dispatcher.stop());
  assert.notEqual((await dispatcher.deliver(request)).status, 'delivered'); assert.equal(posts, 0);
});

// Removing the final post-token check must cause a real remote POST in these tests.
for (const timers of [false, true]) test(`late bot token cannot revive expired authority, timers=${timers}`, async t => {
  const s = await tableService(t, 'delivery', 3); const clock = new TestClock();
  const k = createTableKernelV3(tableBinding, { ...s.dependencies, leaseClock: clock });
  t.after(() => k.close().catch(() => {})); await k.initialize(); await k.acquire();
  const token = deferred(); let waiting = false; let posts = 0;
  const remote = await httpsFixture(t, async (req, res) => { posts++; for await (const _ of req) {} res.end('{"id":"late"}'); });
  const sender = createProviderSender(async () => { waiting = true; await token.promise; return 'synthetic-token'; }, { ca: remote.ca });
  t.after(() => sender.stop());
  const result = sender.send({ ...route, serviceUrl: remote.baseUrl }, finalMessage, { authority: k.leaseAuthority() } as DeliveryContext);
  await eventually(() => waiting); clock.advance(114000, timers); token.resolve();
  assert.deepEqual(await result, { kind: 'retryable' }); await sender.stop();
  assert.equal(posts, 0); assert.equal(k.leaseAuthority().allowed(), false);
});

test('Orka cancellation settles only after its actual native request closes', async t => {
  const entered = deferred(); let closed = false;
  const remote = await httpsFixture(t, (req, _res) => { req.resume(); entered.resolve(); });
  const native = https.request;
  t.mock.method(https, 'request', (...args: Parameters<typeof https.request>) => {
    const req = native(...args); req.once('close', () => { closed = true; }); return req;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const client = createOrkaClient({ ...scope, orkaBaseUrl: remote.baseUrl }, { bearerToken: 'synthetic', ca: remote.ca });
  const abort = new AbortController(); const result = client.post(expectedEvent, abort.signal);
  await entered.promise; abort.abort(); await result; assert.equal(closed, true);
});

test('Orka 101 closes before cancellation: already-drained requests still settle', async t => {
  const closed = deferred();
  const remote = await httpsFixture(t, (req, res) => {
    req.resume(); res.writeHead(101, { Connection: 'Upgrade', Upgrade: 'fixture' }); res.end();
  });
  const native = https.request;
  t.mock.method(https, 'request', (...args: Parameters<typeof https.request>) => {
    const req = native(...args); req.once('close', () => closed.resolve()); return req;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const client = createOrkaClient({ ...scope, orkaBaseUrl: remote.baseUrl }, { bearerToken: 'synthetic', ca: remote.ca });
  const abort = new AbortController(); const result = client.post(expectedEvent, abort.signal);
  await closed.promise; abort.abort();
  assert.deepEqual(await Promise.race([result, turn().then(() => ({ kind: 'stuck-after-native-drain' }))]), { kind: 'retry' });
});

test('Orka native handoff checks authority after event serialization, not only relay readiness', async t => {
  let posts = 0; const remote = await httpsFixture(t, async (req, res) => { posts++; for await (const _ of req) {} res.writeHead(202); res.end('{"status":"accepted","eventId":"x","state":"Queued"}'); });
  const lost = new AbortController(); let allowed = true;
  const authority: LeaseAuthority = { allowed: () => allowed, revalidate: async () => true, lost: lost.signal };
  const client = createOrkaClient({ ...scope, orkaBaseUrl: remote.baseUrl }, { bearerToken: 'synthetic', ca: remote.ca, authority } as Parameters<typeof createOrkaClient>[1]);
  const input = structuredClone(expectedEvent);
  Object.defineProperty(input, 'text', { enumerable: true, get() { allowed = false; return 'hello'; } });
  assert.deepEqual(await client.post(input), { kind: 'retry' }); assert.equal(posts, 0);
});
