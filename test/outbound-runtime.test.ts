import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { Agent } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@microsoft/teams.common/http';
import type { Token } from '@microsoft/teams.common/http';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import { startIngressRuntime } from '../src/ingress/main.js';
import type { IngressRuntime } from '../src/ingress/main.js';
import { ConfigurationError } from '../src/ingress/config.js';
import type { ServeConfig } from '../src/ingress/config.js';
import { startReceiver } from '../src/ingress/server.js';
import type { ReceiverDependencies } from '../src/ingress/server.js';
import { initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import { createTableIngressStore } from '../src/ingress/table-store.js';
import { safeSdkLogger } from '../src/ingress/logger.js';
import type { ProviderPost } from '../src/outbound/sender.js';
import type { EventEnvelope } from '../src/protocol/types.js';
import { finalDelivery, finalMessage } from './fixtures/outgoing.js';
import { expectedEvent } from './fixtures/incoming.js';
import { authFixture, deferred, post, receiverConfig, scope, serviceUrl } from './support/ingress-auth.js';
import { httpsFixture } from './support/ingress-https.js';
import { auditBudget, indexBudget } from './support/table-ingress-audit.js';
import { payload, rowKey } from './support/table-ingress-store.js';
import { ingressBinding, tableBinding, tableService } from './support/table-service.js';

const journalScope = { appId: scope.appId, tenantId: scope.tenantId };
const route = { serviceUrl, channelId: 'msteams' as const, bot: { id: receiverConfig.recipientIds[0]!, role: 'bot' as const },
  conversation: { id: finalDelivery.contextId, conversationType: 'personal' as const, tenantId: scope.tenantId } };
function storage(t: TestContext, baseUrl = scope.orkaBaseUrl, ca?: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-full-runtime-')); let runtime: IngressRuntime | undefined;
  t.after(async () => { try { await runtime?.stop().catch(() => {}); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const config: ServeConfig = { scope: { ...scope, orkaBaseUrl: baseUrl }, dbPath: join(directory, 'inbox.sqlite'), receiver: { ...receiverConfig },
    bearerToken: randomUUID(), policy: { maxPending: 1000, maxRecords: 100000, replayWindowMs: 86400000 },
    outbound: { dbPath: join(directory, 'delivery.sqlite'), bearerToken: randomUUID(), host: '127.0.0.1', port: 0 } };
  if (ca) { config.caFile = join(directory, 'ca.pem'); writeFileSync(config.caFile, ca, { mode: 0o600 }); }
  initializeIngressStore(config.dbPath, config.scope); initializeDeliveryJournal(config.outbound!.dbPath, journalScope);
  return { config, own(value: IngressRuntime) { runtime = value; return value; }, seed() {
    const store = openIngressStore(config.dbPath, config.scope); try { store.admit(expectedEvent, route); } finally { store.close(); }
  }, reopen() {
    const inbox = openIngressStore(config.dbPath, config.scope); const journal = openDeliveryJournal(config.outbound!.dbPath, journalScope);
    return { inbox, journal, close() { inbox.close(); journal.close(); } };
  } };
}
async function deliver(runtime: IngressRuntime, config: ServeConfig, body: unknown = finalDelivery, token = config.outbound!.bearerToken) {
  assert.equal(typeof runtime.outboundPort, 'number');
  return fetch(`http://127.0.0.1:${runtime.outboundPort}/v1/deliveries`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function until(condition: () => boolean | Promise<boolean>, timeout = 4000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!await condition()) { if (performance.now() >= deadline) throw new Error('fixture condition deadline'); await sleep(5); }
}
async function refused(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/v1/health`); return false; } catch { return true; }
}
function providerWrapper(t: TestContext, baseUrl: string, ca: Buffer, expectedToken: string): ProviderPost {
  const client = new Client({ logger: safeSdkLogger }); const agent = new Agent({ ca, rejectUnauthorized: true }); t.after(() => agent.destroy());
  return (url, body, config) => {
    assert.equal(url, `${serviceUrl}v3/conversations/${encodeURIComponent(finalDelivery.contextId)}/activities`);
    assert.ok(config.token === expectedToken); assert.equal(config.maxRedirects, 0); assert.equal(config.proxy, false);
    assert.equal(config.httpsAgent.options.rejectUnauthorized, true); assert.equal(config.maxBodyLength, 20480);
    assert.equal(config.maxContentLength, 65536); assert.equal(config.decompress, false); assert.equal(config.responseType, 'arraybuffer');
    // Only this trusted test transport maps the intended saved public HTTPS URL.
    return client.post(`${baseUrl}v3/conversations/${encodeURIComponent(finalDelivery.contextId)}/activities`, body, { ...config, httpsAgent: agent });
  };
}

test('real registered SDK input -> inbox -> HTTPS Orka -> V1 reply -> SDK HTTPS receipt; concurrent aliases and restart replay one effect', { timeout: 12000 }, async (t) => {
  const auth = await authFixture(t); const event = deferred<EventEnvelope>(); const accepted = deferred<void>(); const release = deferred<void>();
  const providerToken = randomUUID(); let sends = 0; let bytes = 0; let inboundAuthenticated = false;
  const provider = await httpsFixture(t, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      sends++; assert.ok(req.headers.authorization === `Bearer ${providerToken}`); assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v3/conversations/19%3Afixture-personal/activities');
      const body = Buffer.concat(chunks); bytes = body.length; const message = JSON.parse(body.toString());
      assert.deepEqual(Object.keys(message).sort(), ['attachments', 'type']); assert.equal(message.attachments.length, 1);
      assert.equal(message.attachments[0].content.body[0].text, 'Orka reply'); accepted.resolve();
      void release.promise.then(() => { res.writeHead(201); res.end(JSON.stringify({ id: 'provider-full-receipt' })); });
    });
  });
  const upstream = await httpsFixture(t, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      inboundAuthenticated = req.headers.authorization === `Bearer ${f.config.bearerToken}`;
      assert.equal(req.url, '/api/v1/gateways/default/teams/events'); event.resolve(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(202); res.end(JSON.stringify({ status: 'accepted', eventId: 'orka-internal-event', state: 'Queued' }));
    });
  });
  const f = storage(t, upstream.baseUrl, upstream.ca); let tokenCalls = 0;
  const dependencies = { ...auth.dependencies, botToken: async (options: unknown) => { assert.deepEqual(options, {}); tokenCalls++; return { toString: () => providerToken }; },
    providerPost: providerWrapper(t, provider.baseUrl, provider.ca, providerToken) };
  let runtime = f.own(await startIngressRuntime(f.config, dependencies));
  assert.equal((await post(runtime.port, f.config.outbound!.bearerToken)).status, 401);
  assert.equal((await deliver(runtime, f.config, finalDelivery, auth.token())).status, 401);
  assert.equal((await deliver(runtime, f.config, finalDelivery, f.config.bearerToken)).status, 401);
  assert.equal((await post(runtime.port, auth.token())).status, 200); const saved = await event.promise; assert.ok(inboundAuthenticated);
  assert.ok(saved.replyTarget && saved.replyTarget !== 'conformance');
  const body = { ...finalDelivery, originatingEventId: 'orka-internal-event', replyTarget: saved.replyTarget, text: 'x'.repeat(65000) };
  const unsupported = await deliver(runtime, f.config, { ...body, deliveryId: 'no-alias', idempotencyId: 'no-alias', replyTarget: 'conformance' });
  assert.equal((await unsupported.json() as { status: string }).status, 'nonRetryableError'); assert.equal(sends, 0); assert.equal(tokenCalls, 0);
  const pending = deliver(runtime, f.config, body); await accepted.promise;
  for (const response of await Promise.all(Array.from({ length: 8 }, (_, i) => deliver(runtime, f.config, { ...body, deliveryId: `alias-${i}` })))) {
    assert.equal((await response.json() as { status: string }).status, 'retryableError');
  }
  release.resolve(); assert.deepEqual(await (await pending).json(), { status: 'delivered', providerMessageId: 'provider-full-receipt' });
  assert.ok(bytes > 20000 && bytes <= 20480); assert.equal(sends, 1); assert.equal(tokenCalls, 1);
  await runtime.stop(); const reopened = f.reopen();
  try { assert.deepEqual(reopened.journal.begin(body), { kind: 'delivered', providerMessageId: 'provider-full-receipt' }); assert.deepEqual(reopened.inbox.getRoute(saved.replyTarget!), route); }
  finally { reopened.close(); }
  // Historical receipt precedes CURRENT allowlists; fresh sends do not inherit history's permission.
  runtime = f.own(await startIngressRuntime({ ...f.config, receiver: { ...f.config.receiver, recipientIds: ['other-bot'], serviceUrls: ['https://other.example.invalid/'] } }, dependencies));
  assert.deepEqual(await (await deliver(runtime, f.config, { ...body, deliveryId: 'restart-alias' })).json(), { status: 'delivered', providerMessageId: 'provider-full-receipt' });
  assert.equal((await (await deliver(runtime, f.config, { ...body, idempotencyId: 'fresh', deliveryId: 'fresh' })).json() as { status: string }).status, 'nonRetryableError');
  assert.equal((await (await deliver(runtime, f.config, { ...body, text: 'changed' })).json() as { status: string }).status, 'nonRetryableError');
  assert.equal(sends, 1); assert.equal(tokenCalls, 1);
});

test('real Table-backed registered SDK runtime persists input/reply and replays duplicates after clean fresh-handle restart', { timeout: 20000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-table-runtime-'));
  const handles: { close(): Promise<void> }[] = []; const errors: unknown[] = []; let runtime: IngressRuntime | undefined;
  async function stopAndClose() {
    const stopped = await Promise.allSettled([Promise.resolve().then(() => runtime?.stop()), runtime?.done]);
    const closed = await Promise.allSettled(handles.map(handle => Promise.resolve().then(() => handle.close())));
    for (const outcome of [...stopped, ...closed]) if (outcome.status === 'rejected') errors.push(outcome.reason);
    assert.equal(errors.length, 0, 'Table runtime must open and close cleanly; no reset or takeover');
  }
  // Register before the fixtures so their HTTPS listeners remain alive through owner release.
  t.after(async () => { try { await stopAndClose(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const auth = await authFixture(t); const providerToken = randomUUID();
  const orkaReceipt = { status: 'accepted', eventId: 'orka-table-event', state: 'Queued' };
  const deliveryReceipt = { status: 'delivered', providerMessageId: 'provider-table-receipt' };
  let saved: EventEnvelope | undefined; let relays = 0; let sends = 0; let tokenCalls = 0; let inboundAuthenticated = false;
  const provider = await httpsFixture(t, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      sends++; assert.ok(req.headers.authorization === `Bearer ${providerToken}`); assert.equal(req.method, 'POST');
      assert.ok(req.url === '/v3/conversations/19%3Afixture-personal/activities');
      assert.ok(JSON.stringify(JSON.parse(Buffer.concat(chunks).toString())) === JSON.stringify(finalMessage));
      res.writeHead(201); res.end(JSON.stringify({ id: deliveryReceipt.providerMessageId }));
    });
  });
  const upstream = await httpsFixture(t, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      relays++; inboundAuthenticated = req.headers.authorization === `Bearer ${config.bearerToken}`;
      assert.equal(req.method, 'POST'); assert.ok(req.url === '/api/v1/gateways/default/teams/events');
      saved = JSON.parse(Buffer.concat(chunks).toString()); res.writeHead(202); res.end(JSON.stringify(orkaReceipt));
    });
  });
  // Required SQLite paths remain valid but are never initialized or opened by this case.
  const config: ServeConfig = { scope: { ...scope, orkaBaseUrl: upstream.baseUrl }, dbPath: join(directory, 'inbox.sqlite'),
    receiver: { ...receiverConfig }, bearerToken: randomUUID(), caFile: join(directory, 'ca.pem'),
    policy: { maxPending: 1000, maxRecords: 100000, replayWindowMs: 86400000 },
    outbound: { dbPath: join(directory, 'delivery.sqlite'), bearerToken: randomUUID(), host: '127.0.0.1', port: 0 } };
  writeFileSync(config.caFile!, upstream.ca, { mode: 0o600 });
  const inboxService = await tableService(t, 'ingress', 2, config.scope);
  const deliveryService = await tableService(t, 'delivery', 2, journalScope);
  const inboxBinding = { ...ingressBinding, kind: 'ingress' as const, scope: config.scope };
  const deliveryBinding = { ...tableBinding, kind: 'delivery' as const, scope: journalScope };
  const options = { audit: auditBudget, maxIndexBytes: indexBudget, policy: config.policy };
  function freshHandles() {
    const inbox = createTableIngressStore(inboxBinding, inboxService.dependencies, options); handles.push(inbox);
    const journal = createTableDeliveryJournalV2(deliveryBinding, deliveryService.dependencies); handles.push(journal);
    return { inbox, journal };
  }
  const initializers = freshHandles();
  await initializers.inbox.initialize(); await initializers.journal.initialize(); await stopAndClose();
  const dependencies = { ...auth.dependencies, botToken: () => { tokenCalls++; return providerToken; },
    providerPost: providerWrapper(t, provider.baseUrl, provider.ca, providerToken) };
  function start() {
    // Both real handles are reachable even if an opening hook fails before returning one.
    const { inbox, journal } = freshHandles();
    return startIngressRuntime(config, { ...dependencies,
      openIngressStore: async () => { await inbox.open().catch(error => { errors.push(error); throw error; }); return inbox; },
      openDeliveryJournal: async () => { await journal.open().catch(error => { errors.push(error); throw error; }); return journal; } });
  }
  function ingressCompleted() {
    const row = saved && inboxService.rows.get(rowKey('event', saved.externalEventId)); if (!row) return false;
    const event = payload(row);
    return event.state === 'terminal' && event.body === null && event.replyTarget === saved!.replyTarget &&
      event.receipt?.status === orkaReceipt.status && event.receipt.eventId === orkaReceipt.eventId && event.receipt.state === orkaReceipt.state;
  }
  function assertHistory() {
    assert.ok(ingressCompleted());
    const operation = deliveryService.rows.get(rowKey('delivery', finalDelivery.idempotencyId)); assert.ok(operation);
    const receipt = payload(operation); assert.equal(receipt.state, 'delivered'); assert.ok(receipt.providerMessageId === deliveryReceipt.providerMessageId);
    assert.equal([...inboxService.rows.values()].filter(row => row.T === 'event').length, 1);
    assert.equal([...deliveryService.rows.values()].filter(row => row.T === 'delivery').length, 1);
    assert.equal(relays, 1); assert.equal(sends, 1); assert.equal(tokenCalls, 1);
    for (const service of [inboxService, deliveryService]) {
      assert.ok(service.stats.requests > 0 && service.stats.writes > 0 && service.stats.reads > 0 && service.stats.pages > 0);
      assert.ok(service.rows.size > 1); assert.equal(service.stats.violation, false);
    }
    for (const path of [config.dbPath, config.outbound!.dbPath, `${config.outbound!.dbPath}.owner.sqlite`]) assert.equal(existsSync(path), false);
  }
  runtime = await start();
  assert.equal((await post(runtime.port, auth.token())).status, 200);
  await until(ingressCompleted); assert.ok(inboundAuthenticated); assert.ok(saved?.replyTarget && saved.replyTarget !== 'conformance');
  assert.ok(auth.strictRequests() > 0 && auth.requests() > auth.strictRequests());
  const body = { ...finalDelivery, originatingEventId: orkaReceipt.eventId, replyTarget: saved.replyTarget };
  const response = await deliver(runtime, config, body); assert.equal(response.status, 200);
  assert.ok(JSON.stringify(await response.json()) === JSON.stringify(deliveryReceipt)); assertHistory();
  async function duplicates() {
    assert.equal((await post(runtime!.port, auth.token())).status, 200);
    const response = await deliver(runtime!, config, body); assert.equal(response.status, 200);
    assert.ok(JSON.stringify(await response.json()) === JSON.stringify(deliveryReceipt)); assertHistory();
  }
  await duplicates(); await stopAndClose(); assertHistory();
  // Same services, maps, bindings and initialized data; only runtime/handle instances change.
  runtime = await start(); await duplicates(); await stopAndClose(); assertHistory();
});

test('same App public token closure supports string, StringLike and factory; invalid acquisitions never send', async (t) => {
  const value = randomUUID();
  for (const [name, token, successful] of [
    ['string', value, true], ['StringLike', { toString: () => value }, true], ['factory string', () => value, true],
    ['factory StringLike', async () => ({ toString: () => value }), true], ['undefined factory', () => undefined, false],
    ['throwing factory', () => { throw new Error('private-token-error'); }, false],
    ['throwing toString', { toString: () => { throw new Error('private-token-string'); } }, false], ['empty string', '', false],
  ] as [string, Token, boolean][]) await t.test(name, async (t) => {
    const f = storage(t); f.seed(); const owned = f.reopen(); let sends = 0;
    const receiver = await startReceiver(f.config.receiver, owned.inbox, { botToken: token, providerPost: async (_url, body, config) => {
      sends++; assert.ok(config.token === value); assert.deepEqual(JSON.parse(body.toString()), finalMessage);
      return { status: 201, data: Buffer.from('{"id":"same-app-receipt"}') };
    } }, { journal: owned.journal, getRoute: (key) => owned.inbox.getRoute(key) });
    try {
      assert.ok(receiver.outbound); assert.deepEqual(Object.keys(receiver).sort(), ['failed', 'outbound', 'port', 'stop']);
      assert.equal((await receiver.outbound.deliver(finalDelivery)).status, successful ? 'delivered' : 'retryableError'); assert.equal(sends, successful ? 1 : 0);
    } finally { await receiver.stop(); await receiver.stop(); owned.close(); }
  });
});

test('ingress-only receiver never constructs a sender or acquires bot tokens', async (t) => {
  const f = storage(t); const owned = f.reopen(); let calls = 0;
  const receiver = await startReceiver(f.config.receiver, owned.inbox, { botToken: () => { calls++; throw new Error('must not acquire'); },
    providerPost: async () => { calls++; throw new Error('must not post'); } });
  try { assert.equal(Object.hasOwn(receiver, 'outbound'), false); await receiver.stop(); assert.equal(calls, 0); }
  finally { owned.close(); }
});

test('shutdown aborts API and drains same-App token work before either store closes; no late POST', { timeout: 7000 }, async (t) => {
  const f = storage(t); f.seed(); const token = deferred<string>(); const acquired = deferred<void>(); let sends = 0;
  const runtime = f.own(await startIngressRuntime(f.config, { botToken: () => { acquired.resolve(); return token.promise; }, providerPost: async () => { sends++; throw new Error(); } }));
  const pending = deliver(runtime, f.config).catch(() => undefined); await acquired.promise;
  let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; });
  await until(() => refused(runtime.outboundPort!)); assert.equal(stopped, false); assert.ok(await refused(runtime.port));
  token.resolve(randomUUID()); await stopping; await pending; assert.equal(sends, 0);
  const owned = f.reopen(); try { assert.equal(owned.journal.begin(finalDelivery).kind, 'claimed'); } finally { owned.close(); }
});

test('provider acceptance followed by caller disconnect becomes unknown, survives restart and never sends again', { timeout: 10000 }, async (t) => {
  const f = storage(t); f.seed(); const accepted = deferred<void>(); const providerToken = randomUUID(); let sends = 0;
  const provider = await httpsFixture(t, (req, _res) => { req.resume(); req.on('end', () => { sends++; accepted.resolve(); }); });
  const dependencies: ReceiverDependencies = { botToken: () => providerToken, providerPost: providerWrapper(t, provider.baseUrl, provider.ca, providerToken) };
  let runtime = f.own(await startIngressRuntime(f.config, dependencies));
  const req = request({ host: '127.0.0.1', port: runtime.outboundPort, method: 'POST', path: '/v1/deliveries',
    headers: { Authorization: `Bearer ${f.config.outbound!.bearerToken}`, 'Content-Type': 'application/json' } });
  req.on('error', () => {}); req.end(JSON.stringify(finalDelivery)); await accepted.promise; req.destroy(); await runtime.stop();
  runtime = f.own(await startIngressRuntime(f.config, dependencies));
  assert.equal((await (await deliver(runtime, f.config)).json() as { status: string }).status, 'nonRetryableError'); assert.equal(sends, 1);
});

test('a client-observed SDK receipt survives API client disconnect and replays durably after shutdown', { timeout: 7000 }, async (t) => {
  const f = storage(t); f.seed(); const observed = deferred<void>(); const providerToken = randomUUID(); let sends = 0;
  const provider = await httpsFixture(t, (req, res) => { req.resume(); req.on('end', () => {
    sends++; res.writeHead(201); res.end('{"id":"receipt-before-disconnect"}');
  }); });
  const realPost = providerWrapper(t, provider.baseUrl, provider.ca, providerToken);
  let disconnect!: () => void;
  const runtime = f.own(await startIngressRuntime(f.config, { botToken: () => providerToken, providerPost: async (url, body, config) => {
    const response = await realPost(url, body, config);
    assert.ok(response.data instanceof Uint8Array);
    assert.equal(JSON.parse(Buffer.from(response.data).toString()).id, 'receipt-before-disconnect');
    // The REAL SDK client has consumed the complete HTTPS receipt, not merely
    // the fixture's res.end. Let receipt/settlement microtasks run before disconnecting.
    setImmediate(() => { disconnect(); observed.resolve(); }); return response;
  } }));
  const req = request({ host: '127.0.0.1', port: runtime.outboundPort, method: 'POST', path: '/v1/deliveries',
    headers: { Authorization: `Bearer ${f.config.outbound!.bearerToken}`, 'Content-Type': 'application/json' } }, (res) => res.resume());
  req.on('error', () => {}); disconnect = () => req.destroy(); req.end(JSON.stringify(finalDelivery));
  await observed.promise; await runtime.stop(); const owned = f.reopen();
  try { assert.deepEqual(owned.journal.begin({ ...finalDelivery, deliveryId: 'after-disconnect' }), { kind: 'delivered', providerMessageId: 'receipt-before-disconnect' }); }
  finally { owned.close(); }
  assert.equal(sends, 1);
});

test('delivery owner poison flushes V1 before stopping both directions and releases both stores', { timeout: 7000 }, async (t) => {
  const f = storage(t); f.seed(); const runtime = f.own(await startIngressRuntime(f.config));
  const path = `${f.config.outbound!.dbPath}.owner.sqlite`; renameSync(path, `${path}.held`);
  try {
    const response = await deliver(runtime, f.config); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'retryableError', message: 'Delivery is temporarily unavailable.' });
    await assert.rejects(runtime.done, { message: 'Ingress storage failed' }); assert.ok(await refused(runtime.port)); assert.ok(await refused(runtime.outboundPort!));
  } finally { await runtime.stop().catch(() => {}); renameSync(`${path}.held`, path); }
  const owned = f.reopen(); owned.close();
});

test('ingress poison also aborts outbound work and drains token acquisition before releasing both stores', { timeout: 7000 }, async (t) => {
  const f = storage(t); f.seed(); const acquired = deferred<void>(); const token = deferred<string>(); let sends = 0;
  const runtime = f.own(await startIngressRuntime(f.config, { botToken: () => { acquired.resolve(); return token.promise; }, providerPost: async () => { sends++; throw new Error(); } }));
  let done = false; void runtime.done.catch(() => { done = true; });
  const pending = deliver(runtime, f.config).catch(() => undefined); await acquired.promise; chmodSync(f.config.dbPath, 0o644);
  await until(() => refused(runtime.outboundPort!));
  assert.equal(done, false); token.resolve(randomUUID()); await assert.rejects(runtime.done, { message: 'Ingress storage failed' });
  await pending; assert.equal(sends, 0); chmodSync(f.config.dbPath, 0o600); const owned = f.reopen(); owned.close();
});

test('missing second store and occupied second listener unwind without relay, initialization or history loss', { timeout: 7000 }, async (t) => {
  let relays = 0; const upstream = await httpsFixture(t, (_req, res) => { relays++; res.end(); });
  const f = storage(t, upstream.baseUrl, upstream.ca); f.seed();
  const owned = f.reopen(); const claim = owned.journal.begin(finalDelivery); assert.equal(claim.kind, 'claimed');
  if (claim.kind === 'claimed') owned.journal.settle(claim.claim, { kind: 'delivered', providerMessageId: 'before-startup' }); owned.close();
  const missing = `${f.config.outbound!.dbPath}.missing`;
  await assert.rejects(startIngressRuntime({ ...f.config, outbound: { ...f.config.outbound!, dbPath: missing } }).then(f.own));
  assert.equal(existsSync(missing), false); assert.equal(relays, 0); f.reopen().close();
  const occupied = createServer(); await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve()))); const address = occupied.address(); assert.ok(address && typeof address !== 'string');
  await assert.rejects(startIngressRuntime({ ...f.config, outbound: { ...f.config.outbound!, port: address.port } }).then(f.own));
  assert.equal(relays, 0); const again = f.reopen();
  try { assert.deepEqual(again.journal.begin(finalDelivery), { kind: 'delivered', providerMessageId: 'before-startup' }); assert.ok(again.inbox.getRoute(finalDelivery.replyTarget)); }
  finally { again.close(); }
});

test('direct library full config validates bearer/path collisions before opening or binding', async (t) => {
  const f = storage(t);
  for (const outbound of [{ ...f.config.outbound!, bearerToken: f.config.bearerToken }, { ...f.config.outbound!, dbPath: f.config.dbPath },
    { ...f.config.outbound!, host: 'not-an-IP' }, { ...f.config.outbound!, bearerToken: '' }]) {
    await assert.rejects(startIngressRuntime({ ...f.config, outbound }).then(f.own), ConfigurationError); f.reopen().close();
  }
});
