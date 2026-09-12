import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { App } from '@microsoft/teams.apps';
import { PUBLIC } from '@microsoft/teams.api';
import { ConfidentialClientApplication } from '@azure/msal-node';
import type { INetworkModule, NetworkResponse } from '@azure/msal-node';
import { startIngressRuntime } from '../src/ingress/main.js';
import type { ServeConfig } from '../src/ingress/config.js';
import { prepareReceiver, startReceiver } from '../src/ingress/server.js';
import { startSetupCapture } from '../src/setup/server.js';
import { initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { certificateFiles, syntheticAccessToken } from './support/certificate.js';
import { activity, authFixture, deferred, post, scope } from './support/ingress-auth.js';
import { setupFiles } from './support/setup.js';
import { expectedEvent } from './fixtures/incoming.js';
import { finalDelivery } from './fixtures/outgoing.js';

const journalScope = { appId: scope.appId, tenantId: scope.tenantId };
function storage(t: TestContext) {
  const f = certificateFiles(t); const files = setupFiles(t);
  const config: ServeConfig = { receiver: f.config, scope, dbPath: join(files.directory, 'inbox.sqlite'), bearerToken: randomUUID(),
    policy: { maxPending: 1000, maxRecords: 100000, replayWindowMs: 86400000 },
    outbound: { dbPath: join(files.directory, 'delivery.sqlite'), bearerToken: randomUUID(), host: '127.0.0.1', port: 0 } };
  return { ...f, config, init() {
    initializeIngressStore(config.dbPath, scope); initializeDeliveryJournal(config.outbound!.dbPath, journalScope);
    const store = openIngressStore(config.dbPath, scope);
    try { store.admit(expectedEvent, { serviceUrl: config.receiver.serviceUrls[0]!, channelId: 'msteams',
      bot: { id: config.receiver.recipientIds[0]!, role: 'bot' },
      conversation: { id: finalDelivery.contextId, conversationType: 'personal', tenantId: scope.tenantId } }); }
    finally { store.close(); }
  }, reopen() {
    const store = openIngressStore(config.dbPath, scope); const journal = openDeliveryJournal(config.outbound!.dbPath, journalScope);
    return { store, journal, close() { journal.close(); store.close(); } };
  } };
}
function tokenNetwork(run: () => Promise<void> = async () => {}): INetworkModule {
  return { sendGetRequestAsync: async () => { throw new Error('No discovery'); },
    async sendPostRequestAsync<T>(): Promise<NetworkResponse<T>> {
      await run(); return { status: 200, headers: {}, body: { access_token: syntheticAccessToken(), expires_in: 3600, token_type: 'Bearer' } as T };
    } };
}

test('invalid private material is rejected before Orka client/SQLite reads or setup artifact opens', async (t) => {
  const f = storage(t); f.init(); fs.writeFileSync(f.config.receiver.privateKeyFile!, 'invalid synthetic material');
  let opens = 0; const open = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] !== f.config.receiver.privateKeyFile && args[0] !== f.config.receiver.certificateFile) opens++;
    return open(...args);
  });
  await assert.rejects(startIngressRuntime(f.config)); assert.equal(opens, 0);
  const setup = setupFiles(t); opens = 0;
  const { clientSecret: _unused, ...settings } = setup.config;
  await assert.rejects(startSetupCapture({ ...settings, ...f.config.receiver })); assert.equal(opens, 0);
});

for (const suffix of ['', '-journal', '-wal', '-shm', '.owner.sqlite', '.owner.sqlite-journal', '.owner.sqlite-wal', '.owner.sqlite-shm']) {
  test(`credential inode alias to delivery${suffix} is rejected metadata-only`, async (t) => {
    const f = storage(t); const path = f.config.outbound!.dbPath + suffix;
    fs.linkSync(f.config.receiver.privateKeyFile!, path);
    const open = t.mock.method(fs, 'openSync', () => { throw new Error('ordinary open forbidden'); });
    await assert.rejects(startIngressRuntime(f.config)); assert.equal(open.mock.callCount(), 0);
  });
}

test('certificate setup validates real pair, uses deny-only SDK callback and keeps dual JWT/six-field capture', async (t) => {
  const f = certificateFiles(t); const files = setupFiles(t); const auth = await authFixture(t);
  let acquisitions = 0; let selected = false; const initialize = App.prototype.initialize;
  t.mock.method(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential', async () => { acquisitions++; throw new Error('Must not acquire'); });
  t.mock.method(https, 'request', () => { acquisitions++; throw new Error('Must not request HTTPS'); });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url: string | URL | Request, options?: RequestInit) => {
    if (!String(url).startsWith('http://127.0.0.1:')) { acquisitions++; throw new Error('Must not use external fetch'); }
    return fetch(url, options);
  });
  t.mock.method(App.prototype, 'initialize', async function(this: App) {
    const credentials = this.credentials; selected = !!credentials && 'token' in credentials && !('clientSecret' in credentials);
    if (credentials && 'token' in credentials) await assert.rejects(async () => credentials.token(PUBLIC.botScope));
    await initialize.call(this);
  });
  const { clientSecret: _unused, ...settings } = files.config;
  const capture = await startSetupCapture({ ...settings, ...f.config }, auth.dependencies); t.after(() => capture.stop());
  t.mock.method(App.prototype, 'event', () => { throw new Error('Must not dispatch default pipeline'); });
  const body = activity(); body.text = files.challenge;
  assert.equal((await post(capture.port, auth.token(), body)).status, 200); await capture.done;
  const candidate = JSON.parse(fs.readFileSync(files.config.captureFile, 'utf8'));
  assert.deepEqual(Object.keys(candidate).sort(), ['appId', 'conversationId', 'recipientId', 'senderId', 'serviceUrl', 'tenantId']);
  assert.equal(auth.requests(), 2); assert.equal(selected, true); assert.equal(acquisitions, 0);
});

test('actual full receiver App token + MSAL -> dispatcher/journal uses one client/cache without file rereads', async (t) => {
  const f = storage(t); f.init(); const auth = await authFixture(t); let acquired = 0; let sent = 0; let selected = false;
  const initialize = App.prototype.initialize; let startup = true;
  t.mock.method(App.prototype, 'initialize', async function(this: App) {
    const credentials = this.credentials; selected = !!credentials && 'token' in credentials && credentials.clientId === scope.appId && credentials.tenantId === scope.tenantId;
    // Store ownership already exists. Neither startup nor token work can reread paths.
    fs.unlinkSync(f.config.receiver.privateKeyFile!); fs.unlinkSync(f.config.receiver.certificateFile!);
    await initialize.call(this); startup = false;
  });
  const acquire = ConfidentialClientApplication.prototype.acquireTokenByClientCredential;
  const clients = new Set<ConfidentialClientApplication>();
  t.mock.method(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential', async function(this: ConfidentialClientApplication, ...args: Parameters<typeof acquire>) {
    clients.add(this); return acquire.apply(this, args);
  });
  const runtime = await startIngressRuntime(f.config, { ...auth.dependencies, certificateNetwork: tokenNetwork(async () => { acquired++; assert.equal(startup, false); }),
    providerPost: async (_url, _body, config) => { sent++; assert.equal(typeof config.token, 'string'); return { status: 201, data: Buffer.from('{"id":"certificate-receipt"}') }; } });
  t.after(() => runtime.stop()); assert.equal(selected, true); assert.equal(acquired, 0);
  assert.equal((await post(runtime.port, auth.token())).status, 200);
  const deliver = (id: string) => fetch(`http://127.0.0.1:${runtime.outboundPort}/v1/deliveries`, { method: 'POST',
    headers: { Authorization: `Bearer ${f.config.outbound!.bearerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...finalDelivery, deliveryId: id, idempotencyId: id }) });
  for (const id of ['first', 'second']) assert.equal((await (await deliver(id)).json() as { status: string }).status, 'delivered');
  assert.equal(acquired, 1); assert.equal(sent, 2); assert.equal(clients.size, 1); await runtime.stop();
  const owned = f.reopen(); try { assert.equal(owned.journal.begin({ ...finalDelivery, deliveryId: 'first', idempotencyId: 'first' }).kind, 'delivered'); } finally { owned.close(); }
});

for (const variant of ['failure', 'cancel', 'deadline', 'shutdown']) test(`certificate acquisition ${variant} is pre-effect retryable and owned work drains`, async (t) => {
  const f = storage(t); f.init(); const owned = f.reopen(); const reached = deferred<void>(); const gate = deferred<void>(); let sends = 0;
  const receiver = await startReceiver(f.config.receiver, owned.store, { certificateNetwork: tokenNetwork(async () => {
    reached.resolve(); await gate.promise; if (variant === 'failure') throw new Error('synthetic-private-response');
  }), providerPost: async () => { sends++; throw new Error('must not send'); } }, { journal: owned.journal, getRoute: (key) => owned.store.getRoute(key) });
  const abort = new AbortController(); const pending = receiver.outbound!.deliver(finalDelivery,
    { signal: abort.signal, ...(variant === 'deadline' ? { deadline: performance.now() + 100 } : {}) });
  await reached.promise;
  if (variant === 'cancel') abort.abort();
  if (variant === 'failure') gate.resolve();
  let stopped = false; let stopping: Promise<void> | undefined;
  if (variant === 'shutdown') stopping = receiver.stop().then(() => { stopped = true; });
  try {
    const outcome = await pending; assert.equal(outcome.status, 'retryableError'); assert.equal(sends, 0);
    stopping ??= receiver.stop().then(() => { stopped = true; });
    await sleep(20); if (variant !== 'failure') assert.equal(stopped, false);
    gate.resolve(); await stopping; assert.equal(sends, 0);
  } finally { gate.resolve(); await receiver.stop(); owned.close(); }
});

test('prepared receiver is private, snapshots before ownership, and starts only once without rereads', async (t) => {
  const f = certificateFiles(t); let acquired = 0;
  const prepared = prepareReceiver(f.config, { certificateNetwork: tokenNetwork(async () => { acquired++; }) });
  assert.equal(JSON.stringify(prepared), '{}');
  fs.unlinkSync(f.config.certificateFile); fs.unlinkSync(f.config.privateKeyFile);
  f.config.appId = randomUUID(); // A caller mutation cannot change the prepared scope.
  const receiver = await prepared.start({ scope, admit: () => ({ kind: 'full' }) });
  try { await assert.rejects(prepared.start({ scope, admit: () => ({ kind: 'full' }) })); assert.equal(acquired, 0); }
  finally { await receiver.stop(); }
});

for (const variant of ['before preparation', 'before SDK', 'during initialization', 'wrong selected credentials']) {
  test(`certificate receiver refuses ${variant} ambiguity with no legacy token fallback`, async (t) => {
    const f = certificateFiles(t); const before = process.env.CLIENT_SECRET;
    const restore = () => { if (before === undefined) delete process.env.CLIENT_SECRET; else process.env.CLIENT_SECRET = before; };
    t.after(restore);
    const sink = { scope, admit: () => ({ kind: 'full' as const }) };
    if (variant === 'before preparation') {
      process.env.CLIENT_SECRET = 'synthetic-ambient';
      assert.throws(() => prepareReceiver(f.config)); return;
    }
    const prepared = prepareReceiver(f.config);
    if (variant === 'before SDK') process.env.CLIENT_SECRET = '';
    if (variant === 'during initialization') {
      const initialize = App.prototype.initialize;
      t.mock.method(App.prototype, 'initialize', async function(this: App) { await initialize.call(this); process.env.CLIENT_SECRET = 'synthetic-ambient'; });
    }
    if (variant === 'wrong selected credentials') t.mock.getter(App.prototype, 'credentials', () => ({ clientId: scope.appId, tenantId: scope.tenantId }));
    await assert.rejects(prepared.start(sink));
  });
}

test('certificate branch refuses legacy token override, validates direct callers, and pins SDK bot scope/authority', async (t) => {
  const f = certificateFiles(t); const sink = { scope, admit: () => ({ kind: 'full' as const }) };
  await assert.rejects(startReceiver(f.config, sink, { botToken: 'synthetic' }));
  await assert.rejects(startReceiver({ ...f.config, tenantId: 'common' }, sink));
  await assert.rejects(startReceiver(f.config, sink, { sdkCloud: { ...PUBLIC, botScope: PUBLIC.graphScope } }));
  await assert.rejects(startReceiver(f.config, sink, { sdkCloud: { ...PUBLIC, loginEndpoint: 'https://other.invalid' } }));
});

test('full runtime shutdown drains actual certificate acquisition before releasing both stores', async (t) => {
  const f = storage(t); f.init(); const reached = deferred<void>(); const gate = deferred<void>(); let sends = 0;
  const runtime = await startIngressRuntime(f.config, { certificateNetwork: tokenNetwork(async () => { reached.resolve(); await gate.promise; }),
    providerPost: async () => { sends++; throw new Error('No late send'); } });
  const pending = fetch(`http://127.0.0.1:${runtime.outboundPort}/v1/deliveries`, { method: 'POST',
    headers: { Authorization: `Bearer ${f.config.outbound!.bearerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(finalDelivery) }).catch(() => undefined);
  await reached.promise; let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; });
  try {
    await sleep(30); assert.equal(stopped, false); assert.equal(sends, 0);
    gate.resolve(); await stopping; await pending; assert.equal(sends, 0);
    const owned = f.reopen(); try { assert.equal(owned.journal.begin(finalDelivery).kind, 'claimed'); } finally { owned.close(); }
  } finally { gate.resolve(); await runtime.stop(); }
});
