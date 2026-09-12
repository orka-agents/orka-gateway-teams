import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { App } from '@microsoft/teams.apps';
import { PUBLIC } from '@microsoft/teams.api';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { startIngressRuntime } from '../src/ingress/main.js';
import type { ServeConfig } from '../src/ingress/config.js';
import { prepareReceiver, startReceiver } from '../src/ingress/server.js';
import { startSetupCapture } from '../src/setup/server.js';
import { initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { activity, authFixture, deferred, post, scope } from './support/ingress-auth.js';
import { assertion, entraNetwork, imdsFixture, miConfig } from './support/managed-identity.js';
import { setupFiles } from './support/setup.js';
import { httpsFixture } from './support/ingress-https.js';
import type { RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { expectedEvent } from './fixtures/incoming.js';
import { finalDelivery } from './fixtures/outgoing.js';

const journalScope = { appId: scope.appId, tenantId: scope.tenantId };
function aciHeader(t: TestContext): string {
  const before = process.env.IDENTITY_HEADER; const header = 'synthetic-unused-aci-header';
  t.after(() => { if (before === undefined) delete process.env.IDENTITY_HEADER; else process.env.IDENTITY_HEADER = before; });
  process.env.IDENTITY_HEADER = header; return header;
}
function storage(t: TestContext) {
  const files = setupFiles(t);
  const config: ServeConfig = { receiver: { ...miConfig }, scope, dbPath: join(files.directory, 'inbox.sqlite'), bearerToken: randomUUID(),
    policy: { maxPending: 1000, maxRecords: 100000, replayWindowMs: 86400000 },
    outbound: { dbPath: join(files.directory, 'delivery.sqlite'), bearerToken: randomUUID(), host: '127.0.0.1', port: 0 } };
  return { config, init() {
    initializeIngressStore(config.dbPath, scope); initializeDeliveryJournal(config.outbound!.dbPath, journalScope);
    const store = openIngressStore(config.dbPath, scope);
    try { store.admit(expectedEvent, { serviceUrl: miConfig.serviceUrls[0]!, channelId: 'msteams',
      bot: { id: miConfig.recipientIds[0]!, role: 'bot' },
      conversation: { id: finalDelivery.contextId, conversationType: 'personal', tenantId: scope.tenantId } }); }
    finally { store.close(); }
  }, reopen() {
    const store = openIngressStore(config.dbPath, scope); const journal = openDeliveryJournal(config.outbound!.dbPath, journalScope);
    return { store, journal, close() { journal.close(); store.close(); } };
  } };
}

test('MI preparation and ingress-only SDK select a deny callback without files, network or CCA', async (t) => {
  const header = aciHeader(t);
  let selected = false; const initialize = App.prototype.initialize;
  const open = t.mock.method(fs, 'openSync', () => { throw new Error('No credential files'); });
  const req = t.mock.method(http, 'request', () => { throw new Error('No metadata'); });
  const tls = t.mock.method(https, 'request', () => { throw new Error('No OAuth'); });
  const acquire = t.mock.method(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential', async () => { throw new Error('No CCA'); });
  t.mock.method(App.prototype, 'initialize', async function(this: App) {
    const credentials = this.credentials; selected = !!credentials && 'token' in credentials && !('clientSecret' in credentials);
    if (credentials && 'token' in credentials) await assert.rejects(async () => credentials.token(PUBLIC.botScope));
    await initialize.call(this);
  });
  const input = { ...miConfig }; const prepared = prepareReceiver(input);
  input.appId = randomUUID(); assert.equal(JSON.stringify(prepared), '{}');
  const receiver = await prepared.start({ scope, admit: () => ({ kind: 'full' }) });
  try {
    assert.equal(selected, true); await assert.rejects(prepared.start({ scope, admit: () => ({ kind: 'full' }) }));
    assert.equal(open.mock.callCount(), 0); assert.equal(req.mock.callCount(), 0); assert.equal(tls.mock.callCount(), 0); assert.equal(acquire.mock.callCount(), 0);
    assert.equal(process.env.IDENTITY_HEADER === header, true);
  } finally { await receiver.stop(); }
});

test('MI setup uses deny-only public credentials and real dual JWT authentication with six-field capture', async (t) => {
  const header = aciHeader(t);
  const files = setupFiles(t); const auth = await authFixture(t); let selected = false;
  const acquire = t.mock.method(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential', async () => { throw new Error('No CCA'); });
  const request = http.request; let metadataCalls = 0;
  t.mock.method(http, 'request', (...args: Parameters<typeof http.request>) => {
    const target = args[0];
    const hostname = typeof target === 'string' ? new URL(target).hostname : target instanceof URL ? target.hostname : target.hostname;
    if (hostname !== '127.0.0.1') { metadataCalls++; throw new Error('No metadata'); }
    return request(...args);
  });
  const tls = t.mock.method(https, 'request', () => { throw new Error('No OAuth'); });
  const initialize = App.prototype.initialize;
  t.mock.method(App.prototype, 'initialize', async function(this: App) {
    const credentials = this.credentials; selected = !!credentials && 'token' in credentials && !('clientSecret' in credentials);
    if (credentials && 'token' in credentials) await assert.rejects(async () => credentials.token(PUBLIC.botScope));
    await initialize.call(this);
  });
  const { clientSecret: _unused, ...settings } = files.config;
  const capture = await startSetupCapture({ ...settings, ...miConfig }, auth.dependencies); t.after(() => capture.stop());
  const body = activity(); body.text = files.challenge;
  assert.equal((await post(capture.port, auth.token(), body)).status, 200); await capture.done;
  const candidate = JSON.parse(fs.readFileSync(files.config.captureFile, 'utf8'));
  assert.deepEqual(Object.keys(candidate).sort(), ['appId', 'conversationId', 'recipientId', 'senderId', 'serviceUrl', 'tenantId']);
  assert.equal(auth.requests(), 2); assert.equal(selected, true);
  assert.equal(acquire.mock.callCount(), 0); assert.equal(metadataCalls, 0); assert.equal(tls.mock.callCount(), 0);
  assert.equal(JSON.stringify(candidate).includes(header), false); assert.equal(process.env.IDENTITY_HEADER === header, true);
});

for (const variant of ['before preparation', 'before SDK', 'during initialization', 'wrong selection']) {
  test(`MI receiver refuses ${variant} credential ambiguity`, async (t) => {
    const before = process.env.IDENTITY_ENDPOINT;
    t.after(() => { if (before === undefined) delete process.env.IDENTITY_ENDPOINT; else process.env.IDENTITY_ENDPOINT = before; });
    if (variant === 'before preparation') { process.env.IDENTITY_ENDPOINT = ''; assert.throws(() => prepareReceiver(miConfig)); return; }
    const prepared = prepareReceiver(miConfig);
    if (variant === 'before SDK') process.env.IDENTITY_ENDPOINT = '';
    if (variant === 'during initialization') {
      const initialize = App.prototype.initialize;
      t.mock.method(App.prototype, 'initialize', async function(this: App) { await initialize.call(this); process.env.IDENTITY_ENDPOINT = ''; });
    }
    if (variant === 'wrong selection') t.mock.getter(App.prototype, 'credentials', () => ({ clientId: scope.appId, tenantId: scope.tenantId }));
    await assert.rejects(prepared.start({ scope, admit: () => ({ kind: 'full' }) }).then(async (receiver) => { await receiver.stop(); }));
  });
}

test('MI refuses legacy botToken override and alternate SDK scope/authority', () => {
  assert.throws(() => prepareReceiver(miConfig, { botToken: 'synthetic' }));
  assert.throws(() => prepareReceiver(miConfig, { sdkCloud: { ...PUBLIC, botScope: PUBLIC.graphScope } }));
  assert.throws(() => prepareReceiver(miConfig, { sdkCloud: { ...PUBLIC, loginEndpoint: 'https://other.invalid' } }));
});

test('full normal runtime uses real MI, CCA and public App token for journal-backed sends and receipt replay', async (t) => {
  const header = aciHeader(t);
  const f = storage(t); f.init(); const auth = await authFixture(t); const imds = await imdsFixture(t);
  let posts = 0; let sends = 0; let selected = false; const initialize = App.prototype.initialize;
  // Only the explicit native test boundary may reach metadata. This also makes a missing wiring fail privately.
  const native = http.request;
  t.mock.method(http, 'request', (...args: Parameters<typeof http.request>) => {
    if (args[0] instanceof URL && args[0].hostname === '169.254.169.254') throw new Error('Use the selected native seam');
    return native(...args);
  });
  t.mock.method(App.prototype, 'initialize', async function(this: App) {
    const credentials = this.credentials;
    selected = !!credentials && 'token' in credentials && credentials.clientId === scope.appId && credentials.tenantId === scope.tenantId;
    await initialize.call(this);
  });
  const runtime = await startIngressRuntime(f.config, { ...auth.dependencies,
    managedIdentity: { imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork(async () => {
      posts++; return { status: 200, headers: {}, body: { access_token: assertion(), token_type: 'Bearer', expires_in: 3600 } };
    }) }, providerPost: async (_url, _body, config) => {
      sends++; assert.equal(typeof config.token, 'string'); assert.equal(JSON.stringify(config).includes(header), false);
      return { status: 201, data: Buffer.from('{"id":"mi-receipt"}') };
    } });
  t.after(() => runtime.stop()); assert.equal(selected, true); assert.equal(imds.calls(), 0); assert.equal(posts, 0);
  assert.equal((await post(runtime.port, auth.token())).status, 200);
  const deliver = (id: string) => fetch(`http://127.0.0.1:${runtime.outboundPort}/v1/deliveries`, { method: 'POST',
    headers: { Authorization: `Bearer ${f.config.outbound!.bearerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...finalDelivery, deliveryId: id, idempotencyId: id }) });
  for (const id of ['first', 'second', 'first']) assert.equal((await (await deliver(id)).json() as { status: string }).status, 'delivered');
  assert.equal(imds.calls(), 2); assert.equal(posts, 1); assert.equal(sends, 2);
  assert.equal(process.env.IDENTITY_HEADER === header, true); await runtime.stop();
  const owned = f.reopen(); try { assert.equal(owned.journal.begin({ ...finalDelivery, deliveryId: 'first', idempotencyId: 'first' }).kind, 'delivered'); }
  finally { owned.close(); }
});

for (const variant of ['claims', 'JSON', 'OAuth']) test(`MI full receiver rejects malformed ${variant} pre-effect without provider POST`, async (t) => {
  const f = storage(t); f.init(); const owned = f.reopen(); let sends = 0; let exchanges = 0;
  const imds = await imdsFixture(t, (_req, res) => res.end(variant === 'JSON' ? '{' : JSON.stringify({
    access_token: assertion(variant === 'claims' ? { sub: miConfig.managedIdentityClientId } : {}),
  })));
  const receiver = await startReceiver(miConfig, owned.store, { managedIdentity: { imdsRequest: imds.imdsRequest,
    entraNetwork: entraNetwork(async () => { exchanges++; return { status: 200, headers: {}, body: { access_token: 'a.b.c', token_type: 'Bearer', expires_in: 3600 } }; }) },
    providerPost: async () => { sends++; throw new Error('No send'); } }, { journal: owned.journal, getRoute: (key) => owned.store.getRoute(key) });
  try {
    assert.equal((await receiver.outbound!.deliver(finalDelivery)).status, 'retryableError');
    assert.equal(sends, 0); assert.equal(imds.calls(), 1); assert.equal(exchanges, variant === 'OAuth' ? 1 : 0);
    assert.equal(owned.journal.begin(finalDelivery).kind, 'claimed');
  } finally { await receiver.stop(); owned.close(); }
});

for (const variant of ['failure', 'cancel', 'deadline', 'shutdown']) test(`MI ${variant} drains outstanding IMDS and subsequent exchange without late send`, async (t) => {
  const f = storage(t); f.init(); const owned = f.reopen(); let sends = 0; let exchanges = 0;
  const reached = deferred<void>(); const gate = deferred<void>();
  const imds = await imdsFixture(t, async (_req, res) => {
    reached.resolve(); await gate.promise;
    res.end(JSON.stringify({ access_token: variant === 'failure' ? 'a.b.c' : assertion() }));
  });
  const receiver = await startReceiver(miConfig, owned.store, { managedIdentity: { imdsRequest: imds.imdsRequest,
    entraNetwork: entraNetwork(async () => { exchanges++; return { status: 200, headers: {}, body: { access_token: assertion(), token_type: 'Bearer', expires_in: 3600 } }; }) },
    providerPost: async () => { sends++; throw new Error('No late send'); } }, { journal: owned.journal, getRoute: (key) => owned.store.getRoute(key) });
  const abort = new AbortController();
  const pending = receiver.outbound!.deliver(finalDelivery, { signal: abort.signal,
    ...(variant === 'deadline' ? { deadline: performance.now() + 100 } : {}) });
  await reached.promise;
  if (variant === 'cancel') abort.abort();
  if (variant === 'failure') gate.resolve();
  let stopped = false; let stopping: Promise<void> | undefined;
  if (variant === 'shutdown') stopping = receiver.stop().then(() => { stopped = true; });
  try {
    assert.equal((await pending).status, 'retryableError'); assert.equal(sends, 0);
    stopping ??= receiver.stop().then(() => { stopped = true; });
    await sleep(20); if (variant !== 'failure') { assert.equal(stopped, false); assert.equal(imds.closed(), 0); }
    gate.resolve(); await stopping;
    assert.equal(imds.closed(), 1); assert.equal(sends, 0); assert.equal(exchanges, variant === 'failure' ? 0 : 1);
  } finally { gate.resolve(); await receiver.stop(); owned.close(); }
});

test('concurrent removable waiters share the original MI acquisition; cancelling one cannot cancel or send for it', async (t) => {
  const f = storage(t); f.init(); const owned = f.reopen(); let sends = 0; let exchanges = 0;
  const reached = deferred<void>(); const gate = deferred<void>();
  const imds = await imdsFixture(t, async (_req, res) => { reached.resolve(); await gate.promise; res.end(JSON.stringify({ access_token: assertion() })); });
  const receiver = await startReceiver(miConfig, owned.store, { managedIdentity: { imdsRequest: imds.imdsRequest,
    entraNetwork: entraNetwork(async () => { exchanges++; return { status: 200, headers: {}, body: { access_token: assertion(), token_type: 'Bearer', expires_in: 3600 } }; }) },
    providerPost: async () => { sends++; return { status: 201, data: Buffer.from('{"id":"shared-receipt"}') }; } },
  { journal: owned.journal, getRoute: (key) => owned.store.getRoute(key) });
  const abort = new AbortController(); const cancelled = receiver.outbound!.deliver(finalDelivery, { signal: abort.signal });
  await reached.promise;
  const survivor = receiver.outbound!.deliver({ ...finalDelivery, deliveryId: 'survivor', idempotencyId: 'survivor' });
  try {
    abort.abort(); assert.equal((await cancelled).status, 'retryableError'); assert.equal(sends, 0);
    gate.resolve(); assert.equal((await survivor).status, 'delivered');
    assert.equal(imds.calls(), 1); assert.equal(exchanges, 1); assert.equal(sends, 1);
  } finally { gate.resolve(); await receiver.stop(); owned.close(); }
});

test('normal shutdown retains both stores until actual native IMDS AND HTTPS Entra requests close', async (t) => {
  const f = storage(t); f.init(); const miReached = deferred<void>(); const miGate = deferred<void>();
  const entraReached = deferred<void>(); const entraGate = deferred<void>(); let sends = 0; let entraClosed = 0;
  const imds = await imdsFixture(t, async (_req, res) => { miReached.resolve(); await miGate.promise; res.end(JSON.stringify({ access_token: assertion() })); });
  const entra = await httpsFixture(t, (req, res) => { req.resume(); req.on('end', async () => {
    entraReached.resolve(); await entraGate.promise; res.end(JSON.stringify({ access_token: assertion(), token_type: 'Bearer', expires_in: 3600 }));
  }); });
  const native = https.request;
  t.mock.method(https, 'request', (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    if (url.hostname !== 'login.microsoftonline.com') throw new Error('No external requests');
    assert.equal(url.href, `https://login.microsoftonline.com/${miConfig.tenantId}/oauth2/v2.0/token`);
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
    const req = native(new URL(entra.baseUrl), { ...options, ca: entra.ca, servername: 'localhost' }, callback);
    req.once('close', () => { entraClosed++; }); return req;
  });
  const runtime = await startIngressRuntime(f.config, { managedIdentity: { imdsRequest: imds.imdsRequest },
    providerPost: async () => { sends++; throw new Error('No late send'); } });
  const pending = fetch(`http://127.0.0.1:${runtime.outboundPort}/v1/deliveries`, { method: 'POST',
    headers: { Authorization: `Bearer ${f.config.outbound!.bearerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(finalDelivery) }).catch(() => undefined);
  await miReached.promise; let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; });
  try {
    await sleep(20); assert.equal(stopped, false); assert.equal(imds.closed(), 0);
    miGate.resolve(); await entraReached.promise;
    assert.equal(imds.closed(), 1); assert.equal(entraClosed, 0); assert.equal(stopped, false);
    assert.throws(() => openIngressStore(f.config.dbPath, scope));
    assert.throws(() => openDeliveryJournal(f.config.outbound!.dbPath, journalScope));
    entraGate.resolve(); await stopping; await pending;
    assert.equal(entraClosed, 1); assert.equal(sends, 0);
    const owned = f.reopen(); try { assert.equal(owned.journal.begin(finalDelivery).kind, 'claimed'); } finally { owned.close(); }
  } finally { miGate.resolve(); entraGate.resolve(); await runtime.stop(); }
});
