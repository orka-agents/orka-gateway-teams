import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { App } from '@microsoft/teams.apps';
import { PUBLIC } from '@microsoft/teams.api';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { prepareReceiver, startReceiver } from '../src/ingress/server.js';
import { startIngressRuntime } from '../src/ingress/main.js';
import type { ServeConfig } from '../src/ingress/config.js';
import { startSetupCapture } from '../src/setup/server.js';
import { initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { activity, authFixture, post, scope } from './support/ingress-auth.js';
import { entraNetwork } from './support/managed-identity.js';
import { syntheticAccessToken } from './support/certificate.js';
import { workloadConfig, workloadFiles } from './support/workload-identity.js';
import { setupFiles } from './support/setup.js';
import { expectedEvent } from './fixtures/incoming.js';
import { finalDelivery } from './fixtures/outgoing.js';

function runtimeFiles(t: TestContext) {
  const projection = workloadFiles(t); const files = setupFiles(t);
  const config: ServeConfig = { receiver: projection.config, scope, dbPath: join(files.directory, 'inbox.sqlite'), bearerToken: randomUUID(),
    policy: { maxPending: 1000, maxRecords: 100000, replayWindowMs: 86400000 },
    outbound: { dbPath: join(files.directory, 'delivery.sqlite'), bearerToken: randomUUID(), host: '127.0.0.1', port: 0 } };
  return { projection, config };
}

for (const suffix of ['', '-journal', '-wal', '-shm', '.owner.sqlite', '.owner.sqlite-journal', '.owner.sqlite-wal', '.owner.sqlite-shm']) {
  test(`workload-token inode alias to delivery${suffix} is rejected before any store or file opens`, async (t) => {
    const f = runtimeFiles(t); fs.linkSync(f.projection.initial.resolved, f.config.outbound!.dbPath + suffix);
    let storeOpens = 0;
    const open = t.mock.method(fs, 'openSync', () => { throw new Error('No ordinary opens'); });
    await assert.rejects(startIngressRuntime(f.config, {
      openIngressStore: () => { storeOpens++; throw new Error('No store opens'); },
      openDeliveryJournal: () => { storeOpens++; throw new Error('No store opens'); },
    }), { message: 'Invalid ingress configuration' });
    assert.equal(storeOpens, 0); assert.equal(open.mock.callCount(), 0);
  });
}

test('workload token configured as the ingress path is rejected metadata-only', async (t) => {
  const f = runtimeFiles(t); fs.writeFileSync(f.config.dbPath, f.projection.initial.token, { mode: 0o600, flag: 'wx' });
  f.config.receiver = { ...f.projection.config, workloadIdentityTokenFile: f.config.dbPath };
  const open = t.mock.method(fs, 'openSync', () => { throw new Error('No ordinary opens'); });
  let storeOpens = 0;
  await assert.rejects(startIngressRuntime(f.config, { openIngressStore: () => { storeOpens++; throw new Error('No store opens'); } }),
    { message: 'Invalid ingress configuration' });
  assert.equal(storeOpens, 0); assert.equal(open.mock.callCount(), 0);
});

for (const outbound of [false, true]) test(`normal SQLite runtime accepts separated workload identity with outbound ${outbound}`, async (t) => {
  const f = runtimeFiles(t);
  initializeIngressStore(f.config.dbPath, scope);
  if (outbound) initializeDeliveryJournal(f.config.outbound!.dbPath, { appId: scope.appId, tenantId: scope.tenantId });
  else { delete f.config.outbound; f.config.receiver = workloadConfig; }
  const acquire = t.mock.method(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential', async () => { throw new Error('No acquisition'); });
  const runtime = await startIngressRuntime(f.config);
  try {
    assert.equal(typeof runtime.port, 'number'); assert.equal(runtime.outboundPort !== undefined, outbound);
    assert.equal(acquire.mock.callCount(), 0);
  } finally { await runtime.stop(); }
});

test('workload ingress-only mode selects the public deny callback without reading a token or constructing CCA', async (t) => {
  const open = t.mock.method(fs, 'openSync', () => { throw new Error('No token file'); });
  const tls = t.mock.method(https, 'request', () => { throw new Error('No OAuth'); });
  const acquire = t.mock.method(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential', async () => { throw new Error('No CCA'); });
  const initialize = App.prototype.initialize; let selected = false;
  t.mock.method(App.prototype, 'initialize', async function(this: App) {
    const credentials = this.credentials; selected = !!credentials && 'token' in credentials && !('clientSecret' in credentials);
    if (credentials && 'token' in credentials) await assert.rejects(async () => credentials.token(PUBLIC.botScope));
    await initialize.call(this);
  });
  const receiver = await prepareReceiver(workloadConfig).start({ scope, admit: () => ({ kind: 'full' }) });
  try {
    assert.equal(selected, true); assert.equal(open.mock.callCount(), 0); assert.equal(tls.mock.callCount(), 0); assert.equal(acquire.mock.callCount(), 0);
  } finally { await receiver.stop(); }
});

test('workload setup preserves dual JWT authentication and six-field capture without a mounted assertion', async (t) => {
  const files = setupFiles(t); const auth = await authFixture(t);
  const acquire = t.mock.method(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential', async () => { throw new Error('No CCA'); });
  const tls = t.mock.method(https, 'request', () => { throw new Error('No OAuth'); });
  const { clientSecret: _unused, ...settings } = files.config;
  const capture = await startSetupCapture({ ...settings, ...workloadConfig }, auth.dependencies); t.after(() => capture.stop());
  const body = activity(); body.text = files.challenge;
  assert.equal((await post(capture.port, auth.token({ aud: 'other' }), body)).status, 401);
  assert.equal((await post(capture.port, auth.token(), body)).status, 200); await capture.done;
  const candidate = JSON.parse(fs.readFileSync(files.config.captureFile, 'utf8'));
  assert.deepEqual(Object.keys(candidate).sort(), ['appId', 'conversationId', 'recipientId', 'senderId', 'serviceUrl', 'tenantId']);
  assert.equal(auth.requests(), 2); assert.equal(acquire.mock.callCount(), 0); assert.equal(tls.mock.callCount(), 0);
});

test('workload mode rejects legacy bot-token and alternate authority/scope overrides', () => {
  assert.throws(() => prepareReceiver(workloadConfig, { botToken: 'synthetic' }));
  assert.throws(() => prepareReceiver(workloadConfig, { sdkCloud: { ...PUBLIC, botScope: PUBLIC.graphScope } }));
  assert.throws(() => prepareReceiver(workloadConfig, { sdkCloud: { ...PUBLIC, loginEndpoint: 'https://other.invalid' } }));
});

test('the real SDK uses workload credentials for journal-backed delivery, replay, and refusal after invalid rotation', async (t) => {
  const projection = workloadFiles(t); const files = setupFiles(t);
  const db = join(files.directory, 'inbox.sqlite'); const deliveryDb = join(files.directory, 'delivery.sqlite');
  initializeIngressStore(db, scope); initializeDeliveryJournal(deliveryDb, { appId: scope.appId, tenantId: scope.tenantId });
  const store = openIngressStore(db, scope); const journal = openDeliveryJournal(deliveryDb, { appId: scope.appId, tenantId: scope.tenantId });
  t.after(() => { journal.close(); store.close(); });
  store.admit(expectedEvent, { serviceUrl: projection.config.serviceUrls[0]!, channelId: 'msteams',
    bot: { id: projection.config.recipientIds[0]!, role: 'bot' },
    conversation: { id: finalDelivery.contextId, conversationType: 'personal', tenantId: scope.tenantId } });
  let exchanges = 0; let sends = 0;
  const receiver = await startReceiver(projection.config, store, {
    workloadIdentityNetwork: entraNetwork(async () => {
      exchanges++; return { status: 200, headers: {}, body: { access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 } };
    }), providerPost: async (_url, _body, options) => {
      sends++; assert.equal(typeof options.token, 'string'); return { status: 201, data: Buffer.from('{"id":"workload-receipt"}') };
    },
  }, { journal, getRoute: (key) => store.getRoute(key) });
  try {
    assert.equal(exchanges, 0); assert.equal(sends, 0);
    assert.equal((await receiver.outbound!.deliver(finalDelivery)).status, 'delivered');
    assert.equal((await receiver.outbound!.deliver(finalDelivery)).status, 'delivered');
    assert.equal(exchanges, 1); assert.equal(sends, 1);
    projection.rotate({ sub: 'system:serviceaccount:other:identity' });
    assert.equal((await receiver.outbound!.deliver({ ...finalDelivery, deliveryId: 'rotated', idempotencyId: 'rotated' })).status, 'retryableError');
    assert.equal(exchanges, 1); assert.equal(sends, 1);
  } finally { await receiver.stop(); }
});
