import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeTableStore, reclaimTableStore } from '../src/ingress/main.js';
import { parseTableRecoveryConfig } from '../src/ingress/runtime-config.js';
import { createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import { scope } from './support/ingress-auth.js';
import { runtimeIdentity, runtimeTableService, storageClientId } from './support/table-runtime.js';
import { syntheticToken } from './support/table-service.js';
import { changedM2 } from './support/table-v2.js';

function recovery(owner: string, epoch: number) {
  return parseTableRecoveryConfig({ GATEWAY_STORAGE_BACKEND: 'table-v2', TABLE_ACCOUNT: 'Example123', TABLE_NAME: 'Journal',
    TABLE_DELIVERY_STORE_ID: 'stable', TABLE_MANAGED_IDENTITY_HOST: 'azure-container-apps', TABLE_MANAGED_IDENTITY_CLIENT_ID: storageClientId,
    TABLE_AUDIT_MAX_PAGES: '100', TABLE_AUDIT_MAX_BYTES: '10485760', TABLE_AUDIT_MAX_DURATION_MS: '30000',
    TABLE_AUDIT_MAX_TRACKING_BYTES: '1048576', TABLE_MAX_INDEX_BYTES: '16777216',
    TABLE_RECOVERY_EXPECTED_OWNER: owner, TABLE_RECOVERY_EXPECTED_EPOCH: String(epoch), TABLE_RECOVERY_ATTESTATION_DIGEST: 'b'.repeat(64),
    TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, ORKA_BASE_URL: scope.orkaBaseUrl,
    ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName }, 'delivery');
}

test('pre-aborted operator command reports cancellation without opening storage', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(reclaimTableStore(recovery('22222222-2222-4222-8222-222222222222', 1), {}, abort.signal),
    { message: 'operator-recovery-failed: cancelled' });
});

test('fence drift during foreign inspection reports an audit failure, not an uncertain submission', async t => {
  const identity = await runtimeIdentity(t); const tables = await runtimeTableService(t, scope);
  const binding = { kind: 'delivery' as const, account: 'example123', table: 'journal', storeId: 'stable',
    scope: { appId: scope.appId, tenantId: scope.tenantId } };
  const deps = { tableRequest: tables.request, storageIdentity: { request: identity.request } };
  await initializeTableStore(recovery('22222222-2222-4222-8222-222222222222', 1).target, deps);
  const previous = createTableDeliveryJournalV2(binding, { token: async () => syntheticToken, request: tables.request });
  await previous.open();
  const current = tables.delivery.rows.get('M')!; const writes = tables.delivery.stats.writes;
  let changed = false;
  tables.delivery.controls.hook = event => {
    if (!changed && event.req.method === 'GET' && event.path.includes("RowKey='M'")) {
      changed = true; event.reply(); tables.delivery.rows.set('M', changedM2(current, {}, 999));
    } else event.reply();
  };
  await assert.rejects(reclaimTableStore(recovery(String(current.Owner), Number(current.Epoch)), deps),
    { message: 'operator-recovery-failed: audit-or-storage-failed' });
  assert.equal(changed, true); assert.equal(tables.delivery.stats.writes, writes);
  assert.equal([...tables.delivery.rows.keys()].filter(key => key.startsWith('control_')).length, 0);
  delete tables.delivery.controls.hook; await assert.rejects(previous.close()); tables.drained(); identity.drained();
});

test('operator abort during foreign inspection reports cancellation without a write', async t => {
  const identity = await runtimeIdentity(t); const tables = await runtimeTableService(t, scope);
  const binding = { kind: 'delivery' as const, account: 'example123', table: 'journal', storeId: 'stable',
    scope: { appId: scope.appId, tenantId: scope.tenantId } };
  const deps = { tableRequest: tables.request, storageIdentity: { request: identity.request } };
  await initializeTableStore(recovery('22222222-2222-4222-8222-222222222222', 1).target, deps);
  const previous = createTableDeliveryJournalV2(binding, { token: async () => syntheticToken, request: tables.request });
  await previous.open();
  const m = tables.delivery.rows.get('M')!; const abort = new AbortController(); const writes = tables.delivery.stats.writes;
  let requested = false;
  tables.delivery.controls.hook = event => {
    if (!requested && event.req.method === 'GET' && event.path.includes("RowKey='M'")) {
      requested = true; event.reply(); abort.abort();
    } else event.reply();
  };
  await assert.rejects(reclaimTableStore(recovery(String(m.Owner), Number(m.Epoch)), deps, abort.signal),
    { message: 'operator-recovery-failed: cancelled' });
  assert.equal(requested, true); assert.equal(tables.delivery.stats.writes, writes);
  delete tables.delivery.controls.hook; await previous.close(); tables.drained(); identity.drained();
});

test('a caller cannot change the audit budget after the recovery command reads M', async t => {
  const identity = await runtimeIdentity(t); const tables = await runtimeTableService(t, scope);
  const binding = { kind: 'delivery' as const, account: 'example123', table: 'journal', storeId: 'stable',
    scope: { appId: scope.appId, tenantId: scope.tenantId } };
  const deps = { tableRequest: tables.request, storageIdentity: { request: identity.request } };
  await initializeTableStore(recovery('22222222-2222-4222-8222-222222222222', 1).target, deps);
  const previous = createTableDeliveryJournalV2(binding, { token: async () => syntheticToken, request: tables.request });
  await previous.open();
  const m = tables.delivery.rows.get('M')!;
  const parsed = recovery(String(m.Owner), Number(m.Epoch));
  const config = { ...parsed, audit: { ...parsed.audit } };
  let changed = false;
  tables.delivery.controls.hook = event => {
    if (!changed && event.req.method === 'GET' && event.path.includes("RowKey='M'")) {
      changed = true; event.reply(); config.audit.maxPages = 1;
    } else event.reply();
  };
  await reclaimTableStore(config, deps);
  assert.equal(changed, true); assert.equal(tables.delivery.rows.get('M')?.Owner, '');
  assert.equal(tables.delivery.rows.get('M')?.Operation, 'recover');
  delete tables.delivery.controls.hook; await assert.rejects(previous.close()); tables.drained(); identity.drained();
});

test('reclaim refuses a wrong owner or epoch, then atomically releases the exact owner with a durable audit row', async t => {
  const identity = await runtimeIdentity(t); const tables = await runtimeTableService(t, scope);
  const binding = { kind: 'delivery' as const, account: 'example123', table: 'journal', storeId: 'stable',
    scope: { appId: scope.appId, tenantId: scope.tenantId } };
  const deps = { tableRequest: tables.request, storageIdentity: { request: identity.request } };
  await initializeTableStore(recovery('22222222-2222-4222-8222-222222222222', 1).target, deps);
  const previous = createTableDeliveryJournalV2(binding, { token: async () => syntheticToken, request: tables.request });
  await previous.open();
  const m = tables.delivery.rows.get('M')!; const owner = String(m.Owner); const epoch = Number(m.Epoch);
  const writes = tables.delivery.stats.writes;
  await assert.rejects(reclaimTableStore(recovery('33333333-3333-4333-8333-333333333333', epoch), deps), { message: 'operator-recovery-failed: owner-or-epoch-mismatch' });
  await assert.rejects(reclaimTableStore(recovery(owner, epoch + 1), deps), { message: 'operator-recovery-failed: owner-or-epoch-mismatch' });
  assert.equal(tables.delivery.stats.writes, writes);
  await reclaimTableStore(recovery(owner, epoch), deps);
  const released = tables.delivery.rows.get('M')!;
  assert.equal(released.Owner, ''); assert.equal(released.Epoch, String(epoch)); assert.equal(released.Operation, 'recover');
  const receipt = JSON.parse(Buffer.from(String(released.Exit), 'base64').toString()) as { auditId: string; auditDigest: string };
  const auditRows = [...tables.delivery.rows.entries()].filter(([key]) => key.startsWith('control_'));
  assert.equal(auditRows.length, 1); assert.ok(receipt.auditId); assert.ok(receipt.auditDigest);
  const after = tables.delivery.stats.writes;
  await assert.rejects(reclaimTableStore(recovery(owner, epoch), deps), { message: 'operator-recovery-failed: already-unowned' });
  assert.equal(tables.delivery.stats.writes, after); assert.equal([...tables.delivery.rows.keys()].filter(key => key.startsWith('control_')).length, 1);
  await assert.rejects(previous.close());
  const next = createTableDeliveryJournalV2(binding, { token: async () => syntheticToken, request: tables.request });
  await next.open(); assert.equal(tables.delivery.rows.get('M')?.Epoch, String(epoch + 1)); await next.close();
  assert.equal([...tables.delivery.rows.keys()].filter(key => key.startsWith('control_')).length, 1);
  tables.drained(); identity.drained();
});
