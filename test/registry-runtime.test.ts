import assert from 'node:assert/strict';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { prepareStorageIdentity } from '../src/auth/storage-identity.js';
import { NativeAdapter } from '../src/ingress/http-adapter.js';
import { initializeTableStore } from '../src/ingress/main.js';
import { createTableIngressStoreV3 } from '../src/ingress/table-store.js';
import { startRegistryRuntime } from '../src/registry/runtime.js';
import { expectedEvent } from './fixtures/incoming.js';
import { finalDelivery } from './fixtures/outgoing.js';
import { authFixture, post, receiverConfig, serviceUrl } from './support/ingress-auth.js';
import { httpsFixture } from './support/ingress-https.js';
import { registryInput } from './support/registry.js';
import { runtimeIdentity } from './support/table-runtime.js';
import { deferred, eventually, tableService } from './support/table-service.js';
import { TestClock } from './support/table-v3.js';

async function fixture(t: test.TestContext, initialize = true) {
  const config = registryInput(); const identity = await runtimeIdentity(t);
  const domains: { target: string; kind: 'ingress' | 'delivery'; storeId: string; service: Awaited<ReturnType<typeof tableService>> }[] = [];
  for (const target of config.targets) for (const kind of ['ingress', 'delivery'] as const) {
    const storeId = kind === 'ingress' ? target.config.storage.ingressStoreId : target.config.storage.deliveryStoreId!;
    domains.push({ target: target.id, kind, storeId, service: await tableService(t, kind, 3, target.config.scope, httpsFixture, storeId) });
  }
  const native = https.request; let contract = true;
  const router = await httpsFixture(t, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
    const data = decodeURIComponent(req.url ?? '') + body.toString();
    const selected = domains.filter(d => data.includes(`v1_${d.kind}_${Buffer.from(d.storeId).toString('base64url')}`));
    if (selected.length !== 1) { contract = false; res.destroy(); return; }
    const service = selected[0]!.service;
    const forward = native(new URL(req.url!, service.fixture.baseUrl), { method: req.method, headers: req.headers,
      agent: false, rejectUnauthorized: true, ca: service.fixture.ca, servername: 'localhost' }, response => { res.writeHead(response.statusCode!, response.headers); response.pipe(res); });
    forward.on('error', () => res.destroy()); forward.end(body);
  });
  const request = ((url: URL, options: https.RequestOptions, callback: Parameters<typeof https.request>[2]) => {
    contract &&= url.origin === 'https://example123.table.core.windows.net' && options.rejectUnauthorized === true;
    return native(new URL(url.pathname + url.search, router.baseUrl), { ...options, ca: router.ca, servername: 'localhost' }, callback);
  }) as typeof https.request;
  const auth = await authFixture(t); const deps = { ...auth.dependencies, tableRequest: request, storageIdentity: { request: identity.request } };
  if (initialize) for (const target of config.targets) for (const kind of ['ingress', 'delivery'] as const) {
    const c = target.config;
    await initializeTableStore({ kind, scope: c.scope, storage: { backend: 'table-v3', account: c.storage.account, table: c.storage.table, identity: c.storage.identity, storeId: kind === 'ingress' ? c.storage.ingressStoreId : c.storage.deliveryStoreId! },
      ...(kind === 'ingress' ? { audit: c.storage.audit, maxIndexBytes: c.storage.maxIndexBytes } : {}) } as never, { tableRequest: request, storageIdentity: deps.storageIdentity });
  }
  t.after(() => { assert.equal(contract, true); assert.equal(domains.some(d => d.service.stats.violation), false); });
  return { config, deps, domains, auth };
}

test('all four V3 audits precede listeners; only legacy admits new Teams tasks; no Kubernetes startup request', async t => {
  const f = await fixture(t); let listens = 0;
  const listen = NativeAdapter.prototype.listen;
  t.mock.method(NativeAdapter.prototype, 'listen', function(this: NativeAdapter, ...args: Parameters<typeof listen>) {
    assert.ok(f.domains.every(d => !!d.service.rows.get('M')?.Owner)); listens++; return listen.apply(this, args);
  });
  const native = https.request; let kubernetes = 0;
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: any) => {
    if (url.hostname === 'kubernetes.example.invalid') kubernetes++;
    return native(url, options, callback);
  }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const runtime = await startRegistryRuntime(f.config, f.deps); t.after(() => runtime.stop());
  assert.equal(listens, 1); assert.equal((await post(runtime.port, f.auth.token())).status, 200);
  const tools = f.domains.find(d => d.target === 'tools' && d.kind === 'ingress')!;
  assert.equal([...tools.service.rows.values()].some(row => row.T === 'event'), false);
  assert.equal(kubernetes, 0);
  for (const [prefix, id] of [['', 'legacy'], ['/targets/tools', 'tools']]) assert.equal((await fetch(`http://127.0.0.1:${runtime.outboundPort}${prefix}/v1/health`, {
    headers: { authorization: `Bearer callback-${id}` } })).status, 200);
  await runtime.stop(); await runtime.done; assert.ok(f.domains.every(d => d.service.rows.get('M')?.Owner === ''));
});
for (const index of [0, 1, 2, 3]) test(`authority loss in domain ${index} stops all slots`, async t => {
  const f = await fixture(t); const clock = new TestClock(); const runtime = await startRegistryRuntime(f.config, { ...f.deps, tableLeaseClock: clock });
  t.after(() => runtime.stop().catch(() => {}));
  f.domains[index]!.service.controls.hook = e => { if (e.req.method === 'GET') { e.res.writeHead(503); e.res.end(); } else e.reply(); };
  clock.advance(40000); await assert.rejects(runtime.done, { message: 'Ingress storage failed' });
  await assert.rejects(fetch(`http://127.0.0.1:${runtime.port}/healthz`));
});
test('cancellation during a later live foreign-lease wait closes every retained handle without listening', async t => {
  const f = await fixture(t); const abort = new AbortController(); let listens = 0;
  t.mock.method(NativeAdapter.prototype, 'listen', async () => { listens++; throw new Error('must not listen'); });
  const c = f.config.targets[1]!.config;
  const { createTableDeliveryJournalV3 } = await import('../src/delivery/table-journal.js');
  const { prepareStorageIdentity } = await import('../src/auth/storage-identity.js');
  const provider = prepareStorageIdentity(c.storage.identity).createProvider(f.deps.storageIdentity);
  const foreign = createTableDeliveryJournalV3({ kind: 'delivery', account: c.storage.account, table: c.storage.table, storeId: c.storage.deliveryStoreId!, scope: { appId: c.scope.appId, tenantId: c.scope.tenantId } }, { token: provider.token, request: f.deps.tableRequest });
  await foreign.open(); t.after(async () => { await foreign.close().catch(() => {}); await provider.close(); });
  let waiting = false;
  f.domains[3]!.service.controls.hook = e => { if (e.req.method === 'GET') waiting = true; e.reply(); };
  const startup = startRegistryRuntime(f.config, f.deps, abort.signal); const failure = assert.rejects(startup);
  await eventually(() => waiting); abort.abort(); await failure; assert.equal(listens, 0);
  assert.ok(f.domains.slice(0, 3).every(d => d.service.rows.get('M')?.Owner === ''));
  await foreign.close(); await provider.close();
});
test('startup cancellation never closes stores before held actual listener startup drains', async t => {
  const f = await fixture(t); const abort = new AbortController(); const gate = deferred(); let entered = false; let drained = false; let earlyCloses = 0;
  const listen = NativeAdapter.prototype.listen;
  t.mock.method(NativeAdapter.prototype, 'listen', async function(this: NativeAdapter, ...args: Parameters<typeof listen>) {
    const port = await listen.apply(this, args); entered = true; await gate.promise; drained = true; return port;
  });
  const c = f.config.targets[0]!.config;
  const sample = createTableIngressStoreV3({ kind: 'ingress', account: c.storage.account, table: c.storage.table, storeId: c.storage.ingressStoreId, scope: c.scope },
    { token: async () => 'unused' }, { audit: c.storage.audit, maxIndexBytes: c.storage.maxIndexBytes });
  const proto = Object.getPrototypeOf(sample); const close = proto.close;
  t.mock.method(proto, 'close', function(this: typeof sample) { if (!drained) earlyCloses++; return close.call(this); });
  const startup = startRegistryRuntime(f.config, f.deps, abort.signal); const failure = assert.rejects(startup, { message: 'Ingress storage failed' });
  await eventually(() => entered); abort.abort(); await new Promise(resolve => setImmediate(resolve));
  const early = earlyCloses; gate.resolve(); await failure;
  assert.equal(early, 0, 'store close cannot start while actual listener startup is held');
  assert.ok(f.domains.every(d => d.service.rows.get('M')?.Owner === ''));
});

test('relay storage rejection during shutdown rejects done even when the store remains healthy', async t => {
  const f = await fixture(t); await seed(f); const gate = deferred(); let entered = false;
  const c = f.config.targets[0]!.config;
  const sample = createTableIngressStoreV3({ kind: 'ingress', account: c.storage.account, table: c.storage.table, storeId: c.storage.ingressStoreId, scope: c.scope },
    { token: async () => 'unused' }, { audit: c.storage.audit, maxIndexBytes: c.storage.maxIndexBytes });
  const proto = Object.getPrototypeOf(sample); const retry = proto.retry;
  // Model an async storage-port rejection with no poisoned lease, after actual durable settlement.
  t.mock.method(proto, 'retry', async function(this: typeof sample, ...args: Parameters<typeof sample.retry>) {
    await retry.apply(this, args); entered = true; await gate.promise; throw new Error('synthetic storage-port rejection');
  });
  const upstream = await httpsFixture(t, (_req, res) => { res.writeHead(503); res.end(); }); const native = https.request;
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: any) =>
    ['orka.example.invalid', 'tools.example.invalid'].includes(url.hostname) ? native(new URL(url.pathname, upstream.baseUrl), { ...options, ca: upstream.ca, servername: 'localhost' }, callback) : native(url, options, callback));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); gate.resolve(); });
  const runtime = await startRegistryRuntime(f.config, f.deps); await eventually(() => entered);
  const done = assert.rejects(runtime.done, { message: 'Ingress storage failed' });
  const stopping = assert.rejects(runtime.stop(), { message: 'Ingress storage failed' }); gate.resolve(); await Promise.all([stopping, done]);
});

test('missing later domain unwinds acquired earlier domains and never listens', async t => {
  const f = await fixture(t); f.domains[3]!.service.rows.clear();
  await assert.rejects(startRegistryRuntime(f.config, f.deps), { message: 'Ingress storage failed' });
  assert.ok(f.domains.every(d => !d.service.rows.get('M')?.Owner));
});

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const provider = prepareStorageIdentity(f.config.targets[0]!.config.storage.identity).createProvider(f.deps.storageIdentity);
  try { for (const target of f.config.targets) {
    const c = target.config; const inbox = createTableIngressStoreV3({ kind: 'ingress', account: c.storage.account, table: c.storage.table,
      storeId: c.storage.ingressStoreId, scope: c.scope }, { token: provider.token, request: f.deps.tableRequest },
    { audit: c.storage.audit, maxIndexBytes: c.storage.maxIndexBytes, policy: c.policy });
    await inbox.open(); await inbox.admit(expectedEvent, { serviceUrl, channelId: 'msteams', bot: { id: receiverConfig.recipientIds[0]!, role: 'bot' },
      conversation: { id: expectedEvent.contextId, conversationType: 'personal', tenantId: expectedEvent.accountId } });
    await inbox.close();
  } } finally { await provider.close(); }
}

test('retained second-slot work relays independently during legacy outage; colliding V3 callbacks retain separate receipts', async t => {
  const f = await fixture(t); await seed(f); const received: string[] = []; let posts = 0;
  const upstream = await httpsFixture(t, (req, res) => {
    const tools = req.headers.authorization === 'Bearer ingress-tools'; received.push(tools ? 'tools' : 'legacy');
    if (!tools) { res.writeHead(503, { 'retry-after': '60' }); res.end(); return; }
    res.writeHead(202); res.end(JSON.stringify({ status: 'accepted', eventId: expectedEvent.externalEventId, state: 'Queued' }));
  });
  const native = https.request;
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: any) =>
    ['orka.example.invalid', 'tools.example.invalid'].includes(url.hostname) ? native(new URL(url.pathname, upstream.baseUrl), { ...options, ca: upstream.ca, servername: 'localhost' }, callback) : native(url, options, callback));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const runtime = await startRegistryRuntime(f.config, { ...f.deps, botToken: async () => 'synthetic-only',
    providerPost: async () => ({ status: 201, data: Buffer.from(JSON.stringify({ id: `receipt-${++posts}` })) }) });
  t.after(() => runtime.stop().catch(() => {})); await eventually(() => received.includes('tools') && received.includes('legacy'));
  for (const [prefix, id, receipt] of [['', 'legacy', 'receipt-1'], ['/targets/tools', 'tools', 'receipt-2']]) {
    const call = () => fetch(`http://127.0.0.1:${runtime.outboundPort}${prefix}/v1/deliveries`, { method: 'POST', headers: {
      authorization: `Bearer callback-${id}`, 'content-type': 'application/json' }, body: JSON.stringify(finalDelivery) });
    assert.deepEqual(await (await call()).json(), { status: 'delivered', providerMessageId: receipt });
    assert.deepEqual(await (await call()).json(), { status: 'delivered', providerMessageId: receipt });
  }
  assert.equal(posts, 2); await runtime.stop(); await runtime.done;
});

test('all-target shutdown retains every lease until held shared bot-token work actually drains', async t => {
  const f = await fixture(t); await seed(f); const token = deferred(); let waiting = false; let posts = 0;
  const runtime = await startRegistryRuntime(f.config, { ...f.deps, botToken: async () => { waiting = true; await token.promise; return 'synthetic-only'; },
    providerPost: async () => { posts++; return { status: 201, data: Buffer.from('{"id":"forbidden"}') }; } });
  t.after(async () => { token.resolve(); await runtime.stop().catch(() => {}); });
  const sending = fetch(`http://127.0.0.1:${runtime.outboundPort}/targets/tools/v1/deliveries`, { method: 'POST', headers: {
    authorization: 'Bearer callback-tools', 'content-type': 'application/json' }, body: JSON.stringify(finalDelivery) }).then(r => r.arrayBuffer(), () => undefined);
  await eventually(() => waiting); const owners = f.domains.map(d => d.service.rows.get('M')!.Owner); let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false); assert.deepEqual(f.domains.map(d => d.service.rows.get('M')!.Owner), owners);
  token.resolve(); await sending; await stopping; await runtime.done; assert.equal(posts, 0);
  assert.ok(f.domains.every(d => d.service.rows.get('M')!.Owner === ''));
});
