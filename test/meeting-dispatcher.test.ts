import assert from 'node:assert/strict';
import { Client } from '@microsoft/teams.common/http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { createDeliveryDispatcher } from '../src/outbound/dispatcher.js';
import { createProviderSender } from '../src/outbound/sender.js';
import { safeSdkLogger } from '../src/ingress/logger.js';
import type { ReplyRoute } from '../src/ingress/types.js';
import type { DispatcherOptions, ProviderSender } from '../src/outbound/types.js';
import type { DeliveryRequest } from '../src/protocol/types.js';
import { finalDelivery } from './fixtures/outgoing.js';
import { httpsFixture } from './support/ingress-https.js';

const scope = { appId: 'app-fixture', tenantId: finalDelivery.accountId };
const route: ReplyRoute = { serviceUrl: 'https://smba.trafficmanager.net/teams/', channelId: 'msteams', bot: { id: 'bot', role: 'bot' },
  conversation: { id: finalDelivery.contextId, conversationType: 'groupChat', tenantId: scope.tenantId }, requester: { id: 'owner', displayName: '[Owner]' } };
const metadata = { 'meeting.version': '1', 'meeting.subject': 'Review', 'meeting.durationMinutes': '30', 'meeting.attendees': 'everyone', 'meeting.agenda.0': 'Design' };
const input: DeliveryRequest = { ...finalDelivery, kind: 'message', metadata };
const success = { status: 'delivered', providerMessageId: 'provider-fixture' };
const members = [{ id: 'bot', name: 'Bot' }, { id: 'one', name: 'Roster Person', userPrincipalName: 'private-roster@example.test', email: 'private-email@example.test' }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: test.TestContext, sender: ProviderSender, overrides: Partial<DispatcherOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'meeting-dispatch-')); const path = join(directory, 'delivery.sqlite');
  initializeDeliveryJournal(path, scope); const journal = openDeliveryJournal(path, scope);
  const dispatcher = createDeliveryDispatcher({ journal, sender, scope, interimDelivery: true, meetingDrafts: true,
    serviceUrls: [route.serviceUrl], recipientIds: ['bot'], getRoute: () => route, ...overrides });
  t.after(async () => { await dispatcher.stop(); journal.close(); rmSync(directory, { recursive: true, force: true }); });
  return { dispatcher, journal, directory };
}

test('native roster to measured action, same durable receipt replay zero GET/POST, no private bytes persisted or returned', async t => {
  let gets = 0; let posts = 0; let card: Record<string, unknown> | undefined; let requestGood = true;
  const tls = await httpsFixture(t, async (req, res) => {
    requestGood &&= req.headers.authorization === 'Bearer token';
    if (req.method === 'GET') { gets++; requestGood &&= req.url === `/v3/conversations/${encodeURIComponent(input.contextId)}/pagedMembers`; res.end(JSON.stringify({ members })); }
    else { posts++; const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c)); const body = Buffer.concat(chunks);
      requestGood &&= body.length <= 20480; card = JSON.parse(body.toString()); res.end('{"id":"provider-fixture"}'); }
  });
  const client = new Client({ logger: safeSdkLogger });
  const sender = createProviderSender(async () => 'token', { ca: tls.ca,
    get: (url, config) => client.get(url.replace(route.serviceUrl, tls.baseUrl), config),
    post: (url, body, config) => client.post(url.replace(route.serviceUrl, tls.baseUrl), body, config) });
  const f = fixture(t, sender); const response = await f.dispatcher.deliver(input); assert.deepEqual(response, success);
  assert.equal(requestGood, true); assert.equal(gets, 1); assert.equal(posts, 1);
  const serialized = JSON.stringify(card); assert.equal(serialized.includes('private-roster%40example.test'), true);
  assert.equal(serialized.includes('private-email'), false); assert.equal(serialized.includes('Action.OpenUrl'), true);
  assert.equal(serialized.includes(input.text), false); assert.equal(serialized.includes('Asked by'), true);
  assert.deepEqual(await f.dispatcher.deliver({ ...input, deliveryId: 'alias' }), success);
  assert.deepEqual(await f.dispatcher.deliver({ ...input, metadata: { ...metadata, 'meeting.subject': 'Changed' } }), { status: 'nonRetryableError', message: 'Delivery cannot be completed safely.' });
  assert.equal(gets, 1); assert.equal(posts, 1);
  await f.dispatcher.stop(); f.journal.close();
  for (const file of readdirSync(f.directory)) {
    const bytes = readFileSync(join(f.directory, file));
    for (const sentinel of ['private-roster', 'private-email', 'Roster Person', 'teams.microsoft.com/l/meeting/new']) assert.equal(bytes.includes(Buffer.from(sentinel)), false);
  }
  assert.equal(JSON.stringify(response).includes('private'), false);
});

test('native mid-body roster disconnect retries the original claim without settling a no-action card', async t => {
  let gets = 0; let posts = 0; let action = false;
  let broken: import('node:http').ServerResponse | undefined;
  const tls = await httpsFixture(t, async (req, res) => {
    if (req.method === 'GET') {
      gets++;
      if (gets === 1) { broken = res; res.writeHead(200, { 'Content-Length': '1000' }); res.write('{"members":['); }
      else res.end(JSON.stringify({ members }));
    } else {
      posts++; const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      action = Buffer.concat(chunks).includes(Buffer.from('Action.OpenUrl')); res.end('{"id":"provider-fixture"}');
    }
  });
  const client = new Client({ logger: safeSdkLogger });
  const sender = createProviderSender(async () => 'token', { ca: tls.ca,
    get: (url, config) => client.get(url.replace(route.serviceUrl, tls.baseUrl), { ...config, transport: {
      // Observe bytes without Axios's progress transform changing the error code.
      request: (options: import('node:https').RequestOptions, callback: (response: import('node:http').IncomingMessage) => void) =>
        (config.transport ?? { request: httpsRequest }).request(options, (response: import('node:http').IncomingMessage) => {
          response.once('data', () => broken?.destroy()); callback(response);
        }),
    } }),
    post: (url, body, config) => client.post(url.replace(route.serviceUrl, tls.baseUrl), body, config) });
  const f = fixture(t, sender);
  assert.equal((await f.dispatcher.deliver(input)).status, 'retryableError'); assert.equal(posts, 0);
  assert.deepEqual(await f.dispatcher.deliver(input), success); assert.equal(gets, 2); assert.equal(posts, 1); assert.equal(action, true);
  assert.deepEqual(await f.dispatcher.deliver({ ...input, deliveryId: 'recovered-alias' }), success);
  assert.equal(gets, 2); assert.equal(posts, 1);
});

for (const state of ['disabled', 'channel', 'roster', 'missing', 'ambiguous', 'outsider', 'overflow'] as const) test(`${state} produces a visible complete no-action card under the same claim`, async t => {
  let gets = 0; let posts = 0; let serialized = ''; let root: unknown;
  const sender: ProviderSender = { async getMembers() { gets++;
    if (state === 'roster') return { kind: 'unavailable' };
    if (state === 'missing') return { kind: 'members', members: [{ id: 'one', name: 'No UPN' }] };
    if (state === 'ambiguous') return { kind: 'members', members: [{ id: 'one', name: 'Grace', userPrincipalName: 'one@example.test' }, { id: 'two', name: 'Grace', userPrincipalName: 'two@example.test' }] };
    if (state === 'overflow') return { kind: 'members', members: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `Member ${i}`, userPrincipalName: `long-${i}-${'x'.repeat(100)}@example.test` })) };
    return { kind: 'members', members };
  }, async send(_route, message) { posts++; serialized = JSON.stringify(message); root = message.replyToId; return { kind: 'delivered', providerMessageId: 'provider-fixture' }; }, async stop() {} };
  const channel: ReplyRoute = { ...route, conversation: { ...route.conversation, conversationType: 'channel' }, threadId: 'root' };
  const f = fixture(t, sender, state === 'disabled' ? { meetingDrafts: false } : state === 'channel' ? { getRoute: () => channel } : {});
  const request = { ...input, ...(state === 'channel' ? { threadId: 'root' } : {}), metadata: ['ambiguous', 'outsider'].includes(state) ? { ...metadata, 'meeting.attendees': 'named', 'meeting.name.0': state === 'ambiguous' ? 'Grace' : 'Outsider' } : metadata };
  assert.deepEqual(await f.dispatcher.deliver(request), success); assert.deepEqual(await f.dispatcher.deliver({ ...request, deliveryId: 'noaction-alias' }), success);
  assert.equal(posts, 1); assert.equal(gets, state === 'disabled' || state === 'channel' ? 0 : 1);
  assert.equal(serialized.includes('Action.OpenUrl'), false); assert.equal(serialized.includes('Nothing scheduled'), true); assert.equal(serialized.includes('Suggested duration: 30 minutes'), true);
  assert.equal(serialized.includes('Design'), true); assert.equal(root, state === 'channel' ? 'root' : undefined);
});

test('historical receipt precedes current flags, decoder and removed route; interim/foreign route withdrawal sends nothing', async t => {
  let gets = 0; let posts = 0;
  const sender: ProviderSender = { async getMembers() { gets++; return { kind: 'members', members }; },
    async send() { posts++; return { kind: 'delivered', providerMessageId: 'provider-fixture' }; }, async stop() {} };
  const f = fixture(t, sender, { meetingDrafts: false, interimDelivery: false, getRoute: () => undefined });
  const malformed = { ...input, metadata: { 'meeting.version': '99' } };
  const begun = f.journal.begin(malformed); assert.equal(begun.kind, 'claimed');
  if (begun.kind !== 'claimed') throw new Error('Missing fixture claim'); f.journal.settle(begun.claim, { kind: 'delivered', providerMessageId: 'provider-fixture' });
  assert.deepEqual(await f.dispatcher.deliver(malformed), success);
  assert.equal((await f.dispatcher.deliver({ ...input, deliveryId: 'withdrawn', idempotencyId: 'withdrawn' })).status, 'nonRetryableError');
  assert.equal(gets, 0); assert.equal(posts, 0);
  const foreign = fixture(t, sender, { getRoute: () => ({ ...route, conversation: { ...route.conversation, tenantId: 'foreign' } }) });
  assert.equal((await foreign.dispatcher.deliver(input)).status, 'nonRetryableError'); assert.equal(gets, 0); assert.equal(posts, 0);
});

test('pre-POST transient GET failure releases original claim for retry, but actual POST uncertainty remains terminal', async t => {
  let gets = 0; let posts = 0;
  const f = fixture(t, { async getMembers() { return ++gets === 1 ? { kind: 'retryable' } : { kind: 'members', members }; },
    async send() { posts++; return { kind: 'unknown' }; }, async stop() {} });
  assert.equal((await f.dispatcher.deliver(input)).status, 'retryableError'); assert.equal(posts, 0);
  assert.equal((await f.dispatcher.deliver(input)).status, 'nonRetryableError'); assert.equal(posts, 1); assert.equal(gets, 2);
  assert.equal((await f.dispatcher.deliver(input)).status, 'nonRetryableError'); assert.equal(posts, 1); assert.equal(gets, 2);
});

test('one dispatch deadline spans GET and POST; synchronous late roster and cancellation suppress late sends', async t => {
  let posts = 0; const deadline = performance.now() + 40;
  const f = fixture(t, { async getMembers(_route, context) { assert.equal(context?.deadline, deadline); while (performance.now() <= deadline) { /* monotonic barrier */ } return { kind: 'members', members }; },
    async send() { posts++; return { kind: 'delivered', providerMessageId: 'provider-fixture' }; }, async stop() {} });
  assert.equal((await f.dispatcher.deliver(input, { deadline })).status, 'retryableError'); assert.equal(posts, 0);
  const gate = deferred<void>(); const accepted = deferred<void>(); let drained = false;
  const g = fixture(t, { async getMembers() { accepted.resolve(); await gate.promise; drained = true; return { kind: 'members', members }; },
    async send() { posts++; return { kind: 'unknown' }; }, async stop() {} });
  const pending = g.dispatcher.deliver(input); await accepted.promise; let stopped = false;
  const stopping = g.dispatcher.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false); assert.equal(drained, false);
  gate.resolve(); await stopping; assert.equal((await pending).status, 'retryableError'); assert.equal(drained, true); assert.equal(posts, 0);
});
