import assert from 'node:assert/strict';
import https, { request as namedRequest } from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import type { IncomingMessage } from 'node:http';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { startIngressRuntime } from '../src/ingress/main.js';
import type { IngressRuntime, IngressRuntimeDependencies } from '../src/ingress/main.js';
import { ConfigurationError } from '../src/ingress/config.js';
import { createTableIngressStore } from '../src/ingress/table-store.js';
import { createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import { prepareStorageIdentity } from '../src/auth/storage-identity.js';
import { NativeAdapter } from '../src/ingress/http-adapter.js';
import { authFixture, post, receiverConfig, scope } from './support/ingress-auth.js';
import { runtimeIdentity, runtimeTableService, tableRuntimeConfig } from './support/table-runtime.js';
import { deferred, eventually } from './support/table-service.js';
import { httpsFixture } from './support/ingress-https.js';
import { syntheticAccessToken } from './support/certificate.js';
import { entraEndpoint, miConfig } from './support/managed-identity.js';
import { acaHeader, acaEnvironment, identityEnvironment } from './support/aca-identity.js';
import { finalDelivery } from './fixtures/outgoing.js';
import type { EventEnvelope } from '../src/protocol/types.js';

async function fixture(t: TestContext, initialized: 'both' | 'inbox' | 'neither' = 'both', shortTokens = false) {
  let runtime: IngressRuntime | undefined;
  const handles: { close(): Promise<void> }[] = [];
  const providers: { close(): Promise<void> }[] = [];
  t.after(async () => {
    await runtime?.stop().catch(() => {});
    await Promise.allSettled(handles.map(handle => handle.close()));
    await Promise.allSettled(providers.map(provider => provider.close()));
  });
  const identity = await runtimeIdentity(t, shortTokens ? 30 : 3600);
  const tables = await runtimeTableService(t, scope); const config = tableRuntimeConfig(scope);
  const provider = prepareStorageIdentity(config.storage.identity).createProvider({ request: identity.request }); providers.push(provider);
  const dependencies = { token: provider.token, request: tables.request };
  const ingressBinding = { kind: 'ingress' as const, account: 'example123', table: 'journal', storeId: 'stable', scope };
  const deliveryBinding = { kind: 'delivery' as const, account: 'example123', table: 'journal', storeId: 'stable', scope: { appId: scope.appId, tenantId: scope.tenantId } };
  const inbox = createTableIngressStore(ingressBinding, dependencies, { audit: config.storage.audit, maxIndexBytes: config.storage.maxIndexBytes, policy: config.policy });
  handles.push(inbox);
  const delivery = createTableDeliveryJournalV2(deliveryBinding, dependencies); handles.push(delivery);
  if (initialized !== 'neither') await inbox.initialize();
  if (initialized === 'both') await delivery.initialize();
  await inbox.close(); await delivery.close(); await provider.close();
  const observed = { inboxOpens: 0, deliveryOpens: 0, inboxCloses: [] as string[], deliveryCloses: [] as string[], listens: 0 };
  function observe(handle: typeof inbox | typeof delivery, kind: 'inbox' | 'delivery') {
    const proto = Object.getPrototypeOf(handle); const open = proto.open; const close = proto.close;
    t.mock.method(proto, 'open', function(this: typeof handle) { observed[kind === 'inbox' ? 'inboxOpens' : 'deliveryOpens']++; return open.call(this); });
    t.mock.method(proto, 'close', function(this: typeof handle) { observed[kind === 'inbox' ? 'inboxCloses' : 'deliveryCloses'].push(this.status().lifecycle); return close.call(this); });
  }
  observe(inbox, 'inbox'); observe(delivery, 'delivery');
  const listen = NativeAdapter.prototype.listen;
  t.mock.method(NativeAdapter.prototype, 'listen', function(this: NativeAdapter, ...args: Parameters<typeof listen>) { observed.listens++; return listen.apply(this, args); });
  const deps = { tableRequest: tables.request, storageIdentity: { request: identity.request }, managedIdentity: { acaRequest: identity.request } };
  return { config, tables, identity, observed, deps, deliveryBinding, dependencies, handles,
    async start(extra: IngressRuntimeDependencies = {}, signal?: AbortSignal) {
      runtime = await startIngressRuntime(config, { ...deps, ...extra }, signal); return runtime;
    },
    async drained() {
      await eventually(() => tables.stats.forwardCloses === tables.stats.forwarded && tables.stats.forwardSocketCloses === tables.stats.forwardSockets);
      tables.drained(); identity.drained();
    },
  };
}

for (const hook of ['openIngressStore', 'openDeliveryJournal'] as const) test(`selected Table runtime rejects legacy ${hook} before any native acquisition`, async (t) => {
  const f = await fixture(t); const before = f.identity.stats.calls; let calls = 0;
  await assert.rejects(f.start({ [hook]: () => { calls++; throw new Error('Legacy hook must not run'); } }), ConfigurationError);
  assert.equal(calls, 0); assert.equal(f.identity.stats.calls, before); assert.equal(f.observed.listens, 0);
});

for (const invalid of ['scope', 'delivery ID', 'audit', 'CA', 'bot credential', 'storage source', 'native storage dependency'] as const) {
  test(`invalid ${invalid} fails before Table ownership or native acquisition`, async (t) => {
    acaEnvironment(t); const config = tableRuntimeConfig(scope); let calls = 0;
    const deps: IngressRuntimeDependencies = { tableRequest: () => { calls++; throw new Error('Unexpected Table request'); },
      storageIdentity: { request: () => { calls++; throw new Error('Unexpected identity request'); } } };
    if (invalid === 'scope') config.scope = { ...scope, appId: '99999999-9999-4999-8999-999999999999' };
    if (invalid === 'delivery ID') delete config.storage.deliveryStoreId;
    if (invalid === 'audit') config.storage.audit.maxTrackingBytes = 0;
    if (invalid === 'CA') config.caFile = '/dev/null';
    if (invalid === 'bot credential') config.receiver = { ...miConfig, managedIdentityHost: 'azure-container-apps', managedIdentityClientId: scope.appId };
    if (invalid === 'storage source') {
      config.receiver = { ...receiverConfig };
      identityEnvironment(t, { IDENTITY_ENDPOINT: 'https://127.0.0.1/not-supported' });
    }
    if (invalid === 'native storage dependency') deps.storageIdentity = { token: () => 'forbidden' } as never;
    await assert.rejects(startIngressRuntime(config, deps), ConfigurationError); assert.equal(calls, 0);
  });
}

test('Table startup uses preownership config, scope and native dependency snapshots after an opening await', async (t) => {
  const f = await fixture(t); const entered = deferred(); const gate = deferred();
  f.tables.inbox.controls.hook = async event => { entered.resolve(); await gate.promise; event.reply(); };
  const starting = f.start(); void starting.catch(() => {});
  try {
    await Promise.race([entered.promise, starting]);
    f.config.scope = { ...scope, appId: '99999999-9999-4999-8999-999999999999' };
    f.config.storage.deliveryStoreId = 'different'; f.config.storage.audit.maxPages = 0;
    f.config.storage.identity.host = 'imds'; f.config.receiver.host = 'not-an-IP'; f.config.outbound!.port = -1;
    f.deps.storageIdentity.request = () => { throw new Error('Late replacement'); };
    f.deps.managedIdentity.acaRequest = () => { throw new Error('Late replacement'); };
    f.deps.tableRequest = () => { throw new Error('Late replacement'); };
    gate.resolve(); const runtime = await starting; assert.ok(runtime.port); assert.ok(runtime.outboundPort);
    await runtime.stop(); await runtime.done;
    assert.equal(f.tables.inbox.rows.get('M')?.Owner, ''); assert.equal(f.tables.delivery.rows.get('M')?.Owner, ''); await f.drained();
  } finally { gate.resolve(); await starting.then(r => r.stop(), () => {}); }
});

test('both real Table handles are retained before the first open await and closed after aborted late opening', async (t) => {
  const f = await fixture(t); const entered = deferred(); const gate = deferred(); const abort = new AbortController();
  f.tables.inbox.controls.hook = async event => { entered.resolve(); await gate.promise; event.reply(); };
  let finished = false; const starting = f.start({}, abort.signal).finally(() => { finished = true; }); void starting.catch(() => {});
  try {
    await Promise.race([entered.promise, starting]); abort.abort(); await turn();
    assert.equal(finished, false); assert.equal(f.observed.listens, 0); assert.equal(f.observed.inboxCloses.length, 0);
    gate.resolve(); await assert.rejects(starting, { message: 'Ingress startup failed' });
    assert.equal(f.observed.inboxCloses.length, 1); assert.deepEqual(f.observed.deliveryCloses, ['new']);
    assert.equal(f.observed.deliveryOpens, 0); assert.equal(f.observed.listens, 0); await f.drained();
    assert.equal(f.tables.inbox.rows.get('M')?.Owner, '');
  } finally { gate.resolve(); await starting.catch(() => {}); }
});

for (const target of ['inbox', 'delivery'] as const) test(`no listener binds before the complete ${target} domain audit`, async (t) => {
  const f = await fixture(t); const entered = deferred(); const gate = deferred();
  f.tables[target].controls.hook = async event => {
    if (event.req.method === 'GET' && !event.path.includes('RowKey=')) { entered.resolve(); await gate.promise; }
    event.reply();
  };
  const starting = f.start(); void starting.catch(() => {});
  try {
    await Promise.race([entered.promise, starting]); await turn(); assert.equal(f.observed.listens, 0);
    gate.resolve(); const runtime = await starting;
    assert.equal(f.observed.listens, 1); assert.ok(runtime.outboundPort);
    await runtime.stop(); await runtime.done; assert.equal(f.observed.inboxCloses.length, 1); assert.equal(f.observed.deliveryCloses.length, 1);
    await f.drained();
  } finally { gate.resolve(); await starting.then(r => r.stop(), () => {}); }
});

test('a rejected first opener still closes its retained handle and the constructed unopened second handle', async (t) => {
  const f = await fixture(t, 'neither');
  await assert.rejects(f.start(), { message: 'Ingress startup failed' });
  assert.equal(f.observed.inboxCloses.length, 1); assert.deepEqual(f.observed.deliveryCloses, ['new']);
  assert.equal(f.observed.deliveryOpens, 0); assert.equal(f.observed.listens, 0);
  assert.equal(f.tables.inbox.rows.size + f.tables.delivery.rows.size, 0); await f.drained();
});

for (const failure of ['missing', 'occupied', 'audit'] as const) test(`failed ${failure} second-store open closes both actual handles and never initializes or listens`, async (t) => {
  const f = await fixture(t, failure === 'missing' ? 'inbox' : 'both');
  let blocker: ReturnType<typeof createTableDeliveryJournalV2> | undefined;
  if (failure === 'occupied') {
    const provider = prepareStorageIdentity(f.config.storage.identity).createProvider({ request: f.identity.request });
    blocker = createTableDeliveryJournalV2(f.deliveryBinding, { token: provider.token, request: f.tables.request });
    await blocker.open(); f.handles.push(blocker); t.after(() => provider.close());
  }
  if (failure === 'audit') f.tables.delivery.controls.hook = event => {
    if (event.req.method === 'GET' && !event.path.includes('RowKey=')) { event.res.end('{"value":[]}'); return; }
    event.reply();
  };
  const before = f.tables.delivery.rows.get('M'); const closes = f.observed.deliveryCloses.length;
  await assert.rejects(f.start(), { message: 'Ingress startup failed' });
  assert.equal(f.observed.inboxCloses.length, 1); assert.equal(f.observed.deliveryCloses.length, closes + 1);
  assert.equal(f.observed.listens, 0); assert.equal(f.tables.inbox.rows.get('M')?.Owner, '');
  if (failure !== 'audit') assert.equal(f.tables.delivery.rows.get('M') === before, true);
  if (failure === 'missing') assert.equal(f.tables.delivery.rows.size, 0);
  await blocker?.close(); await f.drained();
});

test('storage identity remains available for fresh native acquisition during BOTH clean releases', async (t) => {
  const f = await fixture(t, 'both', true); const runtime = await f.start(); const before = f.identity.calls.storage;
  await runtime.stop(); await runtime.done;
  assert.ok(f.identity.calls.storage > before); assert.equal(f.identity.calls.bot, 0);
  for (const service of [f.tables.inbox, f.tables.delivery]) assert.equal(service.rows.get('M')?.Owner, '');
  await f.drained();
});

test('one failed release still drains and closes the other store; stop and done both reject', async (t) => {
  const f = await fixture(t); const runtime = await f.start();
  f.tables.delivery.controls.hook = event => {
    if (event.actions.some(action => action.entity.Operation === 'release')) { event.res.writeHead(403); event.res.end(); return; }
    event.reply();
  };
  await assert.rejects(runtime.stop(), { message: 'Ingress storage failed' });
  await assert.rejects(runtime.done, { message: 'Ingress storage failed' });
  assert.equal(f.observed.inboxCloses.length, 1); assert.equal(f.observed.deliveryCloses.length, 1);
  assert.equal(f.tables.inbox.rows.get('M')?.Owner, ''); assert.notEqual(f.tables.delivery.rows.get('M')?.Owner, ''); await f.drained();
});

test('production-selected stores use real ACA storage, bot federation and native Entra without token/opening overrides', async (t) => {
  const f = await fixture(t); const auth = await authFixture(t); const finalToken = syntheticAccessToken();
  let saved: EventEnvelope | undefined; let relays = 0; let exchanges = 0; let sends = 0; let contract = true;
  const upstream = await httpsFixture(t, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      relays++; contract &&= req.headers.authorization === `Bearer ${f.config.bearerToken}`;
      saved = JSON.parse(Buffer.concat(chunks).toString()); res.writeHead(202); res.end('{"status":"accepted","eventId":"selected-table-event","state":"Queued"}');
    });
  });
  const entra = await httpsFixture(t, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      exchanges++; const text = Buffer.concat(chunks).toString(); const form = new URLSearchParams(text);
      contract &&= form.get('scope') === 'https://api.botframework.com/.default' && form.get('client_id') === scope.appId &&
        form.has('client_assertion') && !form.has('client_secret') && !text.includes(acaHeader) && !JSON.stringify(req.headers).includes(acaHeader);
      res.end(JSON.stringify({ access_token: finalToken, token_type: 'Bearer', expires_in: 3600 }));
    });
  });
  const native = https.request; const stats = { calls: 0, closes: 0, sockets: 0, socketCloses: 0 };
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: (res: IncomingMessage) => void) => {
    if (url.hostname !== 'orka.example.invalid' && url.hostname !== 'login.microsoftonline.com') return native(url, options, callback);
    const fixture = url.hostname === 'orka.example.invalid' ? upstream : entra;
    if (fixture === entra) contract &&= url.href === entraEndpoint;
    stats.calls++; const req = native(new URL(url.pathname + url.search, fixture.baseUrl), { ...options, ca: fixture.ca, servername: 'localhost' }, callback);
    req.once('close', () => stats.closes++); req.once('socket', socket => { stats.sockets++; socket.once('close', () => stats.socketCloses++); }); return req;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(namedRequest === https.request, true, 'fixture must also map the named native Orka request');
  const runtime = await f.start({ ...auth.dependencies, providerPost: async (_url, _body, config) => {
    sends++; contract &&= config.token === finalToken && !JSON.stringify(config).includes(acaHeader);
    return { status: 201, data: Buffer.from('{"id":"selected-table-receipt"}') };
  } });
  assert.equal(f.identity.calls.bot, 0); assert.equal(exchanges, 0);
  assert.equal((await post(runtime.port, auth.token())).status, 200);
  await eventually(() => !!saved && [...f.tables.inbox.rows.values()].some(row => row.T === 'event' && Buffer.from(String(row.B0), 'base64').toString().includes('"state":"terminal"')));
  const body = { ...finalDelivery, originatingEventId: 'selected-table-event', replyTarget: saved!.replyTarget };
  const deliver = () => fetch(`http://127.0.0.1:${runtime.outboundPort}/v1/deliveries`, { method: 'POST', headers: {
    Authorization: `Bearer ${f.config.outbound!.bearerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (let i = 0; i < 2; i++) assert.deepEqual(await (await deliver()).json(), { status: 'delivered', providerMessageId: 'selected-table-receipt' });
  assert.equal(relays, 1); assert.equal(sends, 1); assert.equal(exchanges, 1); assert.equal(f.identity.calls.bot, 1);
  assert.ok(f.identity.calls.storage > 0); assert.equal(contract, true);
  await runtime.stop(); await runtime.done; await f.drained();
  await eventually(() => stats.calls === stats.closes && stats.sockets === stats.socketCloses);
  for (const service of [f.tables.inbox, f.tables.delivery]) assert.equal(service.rows.get('M')?.V, 2);
});
