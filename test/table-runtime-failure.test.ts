import assert from 'node:assert/strict';
import test from 'node:test';
import { startIngressRuntime, initializeTableStore } from '../src/ingress/main.js';
import { scope } from './support/ingress-auth.js';
import { runtimeIdentity, runtimeTableService, tableRuntimeConfig } from './support/table-runtime.js';
import { createTableKernelV2 } from '../src/storage/table/owner.js';
import { syntheticToken } from './support/table-service.js';

function failure(category: string, reason: string, store?: string) {
  return (error: unknown) => {
    assert.equal(error instanceof Error, true);
    assert.equal((error as { category?: string }).category, category);
    assert.equal((error as { reason?: string }).reason, reason);
    assert.equal((error as { store?: string }).store, store);
    assert.equal(String(error), `Error: ${category}: ${reason}`);
    return true;
  };
}

test('missing Table inbox is diagnosed without opening a listener or exposing backend errors', async t => {
  const identity = await runtimeIdentity(t); const tables = await runtimeTableService(t, scope);
  await assert.rejects(startIngressRuntime(tableRuntimeConfig(scope), {
    tableRequest: tables.request, storageIdentity: { request: identity.request },
  }), failure('store-open-failed', 'missing', 'ingress'));
  assert.equal(tables.inbox.rows.size, 0); assert.equal(tables.delivery.stats.requests, 0);
  tables.drained(); identity.drained();
});

test('corrupt Table open retains its diagnosis even when shutdown is requested during that open', async t => {
  const identity = await runtimeIdentity(t); const tables = await runtimeTableService(t, scope);
  const abort = new AbortController();
  tables.inbox.controls.hook = event => {
    if (event.req.method === 'GET' && event.path.includes("RowKey='M'")) {
      abort.abort(); event.res.writeHead(200, { 'content-type': 'application/json' }); event.res.end('{}');
    } else event.reply();
  };
  await assert.rejects(startIngressRuntime(tableRuntimeConfig(scope), {
    tableRequest: tables.request, storageIdentity: { request: identity.request },
  }, abort.signal), failure('store-open-failed', 'corrupt', 'ingress'));
  tables.drained(); identity.drained();
});

test('occupied Table inbox reports operator reclaim required without modifying either store', async t => {
  const identity = await runtimeIdentity(t); const tables = await runtimeTableService(t, scope);
  const config = tableRuntimeConfig(scope);
  const init = { kind: 'ingress' as const, scope, audit: config.storage.audit, maxIndexBytes: config.storage.maxIndexBytes,
    storage: { backend: 'table-v2' as const, account: config.storage.account, table: config.storage.table,
      storeId: config.storage.ingressStoreId, identity: config.storage.identity } };
  await initializeTableStore(init, { tableRequest: tables.request, storageIdentity: { request: identity.request } });
  const owner = createTableKernelV2({ kind: 'ingress', account: config.storage.account, table: config.storage.table,
    storeId: config.storage.ingressStoreId, scope }, { token: async () => syntheticToken, request: tables.request });
  await owner.acquire(); const before = structuredClone(tables.inbox.rows.get('M')); const writes = tables.inbox.stats.writes;
  await assert.rejects(startIngressRuntime(config, {
    tableRequest: tables.request, storageIdentity: { request: identity.request },
  }), failure('store-owned-requires-operator-recovery', 'occupied', 'ingress'));
  assert.deepEqual(tables.inbox.rows.get('M'), before); assert.equal(tables.inbox.stats.writes, writes);
  assert.equal(tables.delivery.stats.requests, 0); await owner.close(); tables.drained(); identity.drained();
});
