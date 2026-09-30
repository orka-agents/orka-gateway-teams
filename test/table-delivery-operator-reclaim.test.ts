import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reclaimTableDeliveryOperatorV2 } from '../src/delivery/table-recovery.js';
import { TableError } from '../src/storage/table/types.js';
import { createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import { budget } from './support/owned-audit.js';
import { code, dataEntity, payload, request, rowKey } from './support/table-delivery.js';
import { hash, tableBinding, tableService } from './support/table-service.js';
import { changedM2 } from './support/table-v2.js';

type Service = Awaited<ReturnType<typeof tableService>>;
const attestation = 'a'.repeat(64);
const storageCode = (want: string) => (error: unknown) => error instanceof TableError && error.code === want;
function fence(s: Service) {
  const m = s.rows.get('M')!;
  return { initId: String(m.InitId), initDigest: String(m.InitDigest), owner: String(m.Owner), epoch: Number(m.Epoch),
    mDigest: String(m.Digest), etag: String(m['odata.etag']) };
}
async function occupied(t: Parameters<typeof tableService>[0], populated = false) {
  const s = await tableService(t, 'delivery', 2);
  const initialized = createTableDeliveryJournalV2(tableBinding, s.dependencies); await initialized.initialize();
  const zombie = createTableDeliveryJournalV2(tableBinding, s.dependencies); await zombie.open();
  if (populated) assert.equal((await zombie.begin(request)).kind, 'claimed');
  return { s, zombie, expected: fence(s) };
}

// Catches omission of the domain's closed graph proof, post-audit fold, and next-epoch projection.
test('DELIVERY reclaim retains state/result, writes linked audit and projects prior sending to unknown', async t => {
  const { s, zombie, expected } = await occupied(t, true);
  const before = s.rows.get('M')!; const state = before.State, result = before.Result;
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, expected, budget(), attestation);
  const recovered = s.rows.get('M')!;
  assert.equal(recovered.Owner, ''); assert.equal(recovered.Epoch, String(expected.epoch));
  assert.equal(recovered.State, state); assert.equal(recovered.Result, result);
  const exit = JSON.parse(Buffer.from(String(recovered.Exit), 'base64').toString());
  const auditRow = `control_${Buffer.from(`control_recovery:${exit.auditId}`).toString('base64url')}`;
  const audit = s.rows.get(auditRow)!; assert.equal(exit.auditId, exit.invocation); assert.equal(exit.auditDigest, audit.Digest);
  const payload = JSON.parse(Buffer.from(String(audit.B0), 'base64').toString());
  assert.deepEqual({ oldOwner: payload.oldOwner, oldEpoch: payload.oldEpoch, originalMDigest: payload.originalMDigest,
    operatorAttestationDigest: payload.operatorAttestationDigest },
  { oldOwner: expected.owner, oldEpoch: expected.epoch, originalMDigest: expected.mDigest, operatorAttestationDigest: attestation });
  const rows = [...s.rows.entries()].filter(([key]) => key !== 'M').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  let folded = hash(['orka-recovery-data-v2', recovered.Binding]);
  for (const [key, row] of rows) folded = hash(['orka-recovery-row-v2', folded, key, row.Digest]);
  const data = hash(['orka-recovery-data-end-v2', folded, rows.length]);
  assert.equal(exit.domainDispositionDigest, hash(['orka-delivery-recovery-v2', recovered.Binding, state, result, data, rows.length, 'epoch-restart']));
  assert.equal(s.stats.violation, false);
  const next = createTableDeliveryJournalV2(tableBinding, s.dependencies); await next.open();
  assert.equal(s.rows.get('M')!.Epoch, String(expected.epoch + 1));
  assert.equal((await next.begin(request)).kind, 'unknown'); await next.close();
  await assert.rejects(zombie.close());
  const reopened = createTableDeliveryJournalV2(tableBinding, s.dependencies); await reopened.open(); await reopened.close();
});

// Catches an inspector that checks only envelopes or a final result but misses a broken alias graph.
test('DELIVERY reclaim refuses orphaned aliases before any recovery write', async t => {
  const { s, zombie, expected } = await occupied(t, true);
  s.rows.delete(rowKey('delivery', request.idempotencyId));
  const writes = s.stats.writes;
  await assert.rejects(reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, expected, budget(), attestation), storageCode('unresolved'));
  assert.equal(s.stats.writes, writes); assert.equal(s.rows.get('M')!.Owner, expected.owner);
  await zombie.close().catch(() => undefined);
});

// Catches successful reclaim after a first-pass row's ETag changed but its digest remained identical.
test('DELIVERY reclaim refuses cross-pass ETag drift even when data digest is unchanged', async t => {
  const { s, zombie, expected } = await occupied(t, true);
  let target = 0; const row = rowKey('alias', request.deliveryId);
  s.controls.hook = e => { if (e.req.method === 'GET' && e.path.includes('$filter') && ++target === 5) {
    s.rows.set(row, { ...s.rows.get(row)!, 'odata.etag': 'W/"99999"' });
  } e.reply(); };
  const writes = s.stats.writes;
  await assert.rejects(reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, expected, budget(), attestation), storageCode('unresolved'));
  assert.equal(s.stats.writes, writes); assert.equal(s.rows.get('M')!.Owner, expected.owner);
  delete s.controls.hook; await zombie.close().catch(() => undefined);
});

// Catches acceptance of a forged audit row or a missing receipt after operator recovery.
test('DELIVERY startup refuses a tampered recovery audit without discharging the acquired owner', async t => {
  const { s, zombie, expected } = await occupied(t);
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, expected, budget(), attestation);
  const exit = JSON.parse(Buffer.from(String(s.rows.get('M')!.Exit), 'base64').toString());
  const audit = `control_${Buffer.from(`control_recovery:${exit.auditId}`).toString('base64url')}`;
  s.rows.delete(audit);
  const j = createTableDeliveryJournalV2(tableBinding, s.dependencies);
  await assert.rejects(j.open(), code('corrupt')); await j.close().catch(() => undefined);
  assert.notEqual(s.rows.get('M')!.Owner, '');
  await zombie.close().catch(() => undefined);
});

// Catches silently treating a new audited recovery as historical after losing its receipt fields.
test('DELIVERY startup requires an audit receipt when the latest operator epoch has an audit row', async t => {
  const { s, zombie, expected } = await occupied(t);
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, expected, budget(), attestation);
  const m = s.rows.get('M')!;
  const exit = JSON.parse(Buffer.from(String(m.Exit), 'base64').toString());
  delete exit.auditId; delete exit.auditDigest;
  s.rows.set('M', changedM2(m, { Exit: Buffer.from(JSON.stringify(exit)).toString('base64') }, 80000));
  const j = createTableDeliveryJournalV2(tableBinding, s.dependencies);
  await assert.rejects(j.open(), code('corrupt')); await j.close().catch(() => undefined);
  await zombie.close().catch(() => undefined);
});

// The audit's pre-recovery disposition cannot be replaced while preserving the post-write fold.
test('DELIVERY startup verifies the pre-recovery disposition recorded inside a canonical audit', async t => {
  const { s, zombie, expected } = await occupied(t, true);
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, expected, budget(), attestation);
  const m = s.rows.get('M')!;
  const exit = JSON.parse(Buffer.from(String(m.Exit), 'base64').toString());
  const id = `control_recovery:${exit.auditId}`, key = rowKey('control', id);
  const payload = JSON.parse(Buffer.from(String(s.rows.get(key)!.B0), 'base64').toString());
  s.rows.set(key, dataEntity('control', id, { ...payload, dispositionDigest: 'f'.repeat(64) }));
  exit.auditDigest = s.rows.get(key)!.Digest;
  const rows = [...s.rows.entries()].filter(([name]) => name !== 'M').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  let fold = hash(['orka-recovery-data-v2', m.Binding]);
  for (const [name, row] of rows) fold = hash(['orka-recovery-row-v2', fold, name, row.Digest]);
  const data = hash(['orka-recovery-data-end-v2', fold, rows.length]);
  exit.domainDispositionDigest = hash(['orka-delivery-recovery-v2', m.Binding, m.State, m.Result, data, rows.length, 'epoch-restart']);
  s.rows.set('M', changedM2(m, { Exit: Buffer.from(JSON.stringify(exit)).toString('base64') }, 81000));
  const j = createTableDeliveryJournalV2(tableBinding, s.dependencies);
  await assert.rejects(j.open(), code('corrupt')); await j.close().catch(() => undefined);
  await zombie.close().catch(() => undefined);
});

// A clean release cannot also attest an operator recovery in that same epoch.
test('DELIVERY startup refuses an audit row falsely claiming the clean-release epoch', async t => {
  const s = await tableService(t, 'delivery', 2);
  const initialized = createTableDeliveryJournalV2(tableBinding, s.dependencies); await initialized.initialize();
  const owner = createTableDeliveryJournalV2(tableBinding, s.dependencies); await owner.open();
  const old = fence(s); await owner.close();
  const id = '11111111-1111-4111-8111-111111111111';
  s.rows.set(rowKey('control', `control_recovery:${id}`), dataEntity('control', `control_recovery:${id}`, {
    schema: 1, kind: 'operator-recovery-audit', invocation: id, oldOwner: old.owner, oldEpoch: old.epoch,
    originalMDigest: old.mDigest, dispositionDigest: 'b'.repeat(64), operatorAttestationDigest: attestation,
  }));
  const j = createTableDeliveryJournalV2(tableBinding, s.dependencies);
  await assert.rejects(j.open(), code('corrupt')); await j.close().catch(() => undefined);
});

// An unrelated valid row rollback cannot become the baseline of another recovery
// while the just-acquired M still preserves its predecessor's data commitment.
test('DELIVERY reclaim refuses unrelated valid row rollback under unchanged operator acquire before writing', async t => {
  const { s, zombie } = await occupied(t);
  const first = await zombie.begin(request);
  assert.equal(first.kind, 'claimed'); if (first.kind !== 'claimed') return;
  assert.equal(await zombie.settle(first.claim, { kind: 'delivered', providerMessageId: 'first-receipt' }), 'recorded');
  const other = { ...request, idempotencyId: 'other-stable', deliveryId: 'other-delivery' };
  const second = await zombie.begin(other);
  assert.equal(second.kind, 'claimed'); if (second.kind !== 'claimed') return;
  assert.equal(await zombie.settle(second.claim, { kind: 'delivered', providerMessageId: 'other-receipt' }), 'recorded');
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, fence(s), budget(), attestation);
  const acquired = createTableDeliveryJournalV2(tableBinding, s.dependencies); await acquired.open();
  const m = s.rows.get('M')!; assert.equal(m.Operation, 'acquire');
  const expected = fence(s);
  const firstRow = rowKey('delivery', request.idempotencyId);
  s.rows.set(firstRow, dataEntity('delivery', request.idempotencyId, { ...payload(s.rows.get(firstRow)!), state: 'rejected', providerMessageId: null }));
  const writes = s.stats.writes; const auditRows = [...s.rows.keys()].filter(key => key.startsWith('control_')).length;
  await assert.rejects(reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, expected, budget(), attestation), storageCode('unresolved'));
  assert.equal(s.stats.writes, writes); assert.equal(s.rows.get('M')!.Digest, m.Digest);
  assert.equal(s.rows.get('M')!['odata.etag'], m['odata.etag']);
  assert.equal([...s.rows.keys()].filter(key => key.startsWith('control_')).length, auditRows);
  await acquired.close().catch(() => undefined); await zombie.close().catch(() => undefined);
});

// An ordinary owner mutation changes M, so its old Exit no longer commits the data graph.
test('DELIVERY reclaim after legitimate owner mutation does not enforce stale operator data commitment', async t => {
  const { s, zombie } = await occupied(t);
  const first = await zombie.begin(request);
  assert.equal(first.kind, 'claimed'); if (first.kind !== 'claimed') return;
  assert.equal(await zombie.settle(first.claim, { kind: 'delivered', providerMessageId: 'first-receipt' }), 'recorded');
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, fence(s), budget(), attestation);
  const acquired = createTableDeliveryJournalV2(tableBinding, s.dependencies); await acquired.open();
  const other = { ...request, idempotencyId: 'other-stable', deliveryId: 'other-delivery' };
  assert.equal((await acquired.begin(other)).kind, 'claimed');
  assert.equal(s.rows.get('M')!.Operation, 'mutate');
  const firstRow = rowKey('delivery', request.idempotencyId);
  s.rows.set(firstRow, dataEntity('delivery', request.idempotencyId, { ...payload(s.rows.get(firstRow)!), state: 'rejected', providerMessageId: null }));
  const expected = fence(s);
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, expected, budget(), attestation);
  assert.equal(s.rows.get('M')!.Owner, ''); assert.equal(s.rows.get('M')!.Epoch, String(expected.epoch));
  const next = createTableDeliveryJournalV2(tableBinding, s.dependencies); await next.open();
  assert.equal((await next.begin(request)).kind, 'rejected'); await next.close();
  await acquired.close().catch(() => undefined); await zombie.close().catch(() => undefined);
});

// Catches a validator that rejects old canonical audit rows after a subsequent legitimate recovery.
test('DELIVERY reclaim keeps older audit rows and validates the latest epoch receipt', async t => {
  const { s, zombie, expected } = await occupied(t);
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, expected, budget(), attestation);
  const second = createTableDeliveryJournalV2(tableBinding, s.dependencies); await second.open();
  const next = fence(s);
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, next, budget(), attestation);
  assert.equal([...s.rows.keys()].filter(key => key.startsWith('control_')).length, 2);
  const third = createTableDeliveryJournalV2(tableBinding, s.dependencies); await third.open(); await third.close();
  await second.close().catch(() => undefined); await zombie.close().catch(() => undefined);
});
