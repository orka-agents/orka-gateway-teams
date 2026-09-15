import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeTableStore } from '../src/ingress/main.js';
import { parseRuntimeConfig } from '../src/ingress/runtime-config.js';
import { scope } from './support/ingress-auth.js';
import { runtimeIdentity, runtimeTableService, storageClientId } from './support/table-runtime.js';
import { deferred, eventually } from './support/table-service.js';

function config(mode: 'init' | 'init-delivery') {
  const result = parseRuntimeConfig({ GATEWAY_STORAGE_BACKEND: 'table-v2', TABLE_ACCOUNT: 'Example123', TABLE_NAME: 'Journal',
    TABLE_INGRESS_STORE_ID: 'stable', TABLE_DELIVERY_STORE_ID: 'stable', TABLE_MANAGED_IDENTITY_HOST: 'azure-container-apps',
    TABLE_MANAGED_IDENTITY_CLIENT_ID: storageClientId, TABLE_AUDIT_MAX_PAGES: '100', TABLE_AUDIT_MAX_BYTES: '10485760',
    TABLE_AUDIT_MAX_DURATION_MS: '30000', TABLE_AUDIT_MAX_TRACKING_BYTES: '1048576', TABLE_MAX_INDEX_BYTES: '16777216',
    TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, ORKA_BASE_URL: scope.orkaBaseUrl,
    ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName }, mode);
  assert.ok('storage' in result); return result;
}

for (const mode of ['init', 'init-delivery'] as const) test(`${mode} initializes only its used Table partition, drains, and refuses existing data without bot credentials`, async (t) => {
  const identity = await runtimeIdentity(t); const tables = await runtimeTableService(t, scope);
  const input = config(mode); const deps = { tableRequest: tables.request, storageIdentity: { request: identity.request } };
  await initializeTableStore(input, deps);
  const selected = mode === 'init' ? tables.inbox : tables.delivery; const unused = mode === 'init' ? tables.delivery : tables.inbox;
  assert.equal(selected.rows.get('M')?.V, 2); assert.equal(selected.rows.get('M')?.Owner, ''); assert.equal(unused.stats.requests, 0);
  assert.equal(identity.calls.bot, 0); assert.ok(identity.calls.storage > 0);
  const prior = selected.rows.get('M');
  await assert.rejects(initializeTableStore(input, deps), { message: 'Table initialization failed' });
  assert.equal(selected.rows.get('M') === prior, true); assert.equal(unused.rows.size, 0);
  await eventually(() => tables.stats.forwardCloses === tables.stats.forwarded && tables.stats.forwardSockets === tables.stats.forwardSocketCloses);
  tables.drained(); identity.drained();
});

for (const mode of ['init', 'init-delivery'] as const) test(`${mode} does not provision a missing physical table`, async (t) => {
  const identity = await runtimeIdentity(t); const tables = await runtimeTableService(t, scope);
  const selected = mode === 'init' ? tables.inbox : tables.delivery; let writes = 0;
  selected.controls.hook = event => {
    if (event.req.method !== 'GET') writes++;
    event.res.writeHead(404, { 'x-ms-error-code': 'TableNotFound' }); event.res.end('{"odata.error":{"code":"TableNotFound"}}');
  };
  await assert.rejects(initializeTableStore(config(mode), { tableRequest: tables.request, storageIdentity: { request: identity.request } }), { message: 'Table initialization failed' });
  assert.equal(writes, 0); assert.equal(selected.rows.size, 0); assert.equal(identity.calls.bot, 0);
  await eventually(() => tables.stats.forwardCloses === tables.stats.forwarded && tables.stats.forwardSockets === tables.stats.forwardSocketCloses);
  tables.drained(); identity.drained();
});

test('interrupted Table initializer waits actual native work and closes before refusing success', async (t) => {
  const identity = await runtimeIdentity(t); const tables = await runtimeTableService(t, scope); const entered = deferred(); const gate = deferred();
  tables.inbox.controls.hook = async event => { entered.resolve(); await gate.promise; event.reply(); };
  const abort = new AbortController(); let finished = false;
  const initializing = initializeTableStore(config('init'), { tableRequest: tables.request, storageIdentity: { request: identity.request } }, abort.signal)
    .finally(() => { finished = true; }); void initializing.catch(() => {});
  try {
    await Promise.race([entered.promise, initializing]); abort.abort(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, false); gate.resolve(); await assert.rejects(initializing, { message: 'Table initialization failed' });
    await eventually(() => tables.stats.forwardCloses === tables.stats.forwarded && tables.stats.forwardSockets === tables.stats.forwardSocketCloses);
    tables.drained(); identity.drained();
    // Cancellation is not proof of noncommit: no retry, reset, or deletion is attempted.
    assert.equal(tables.inbox.rows.get('M')?.Owner, '');
  } finally { gate.resolve(); await initializing.catch(() => {}); }
});
