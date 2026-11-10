import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindTable, decodeRecord, decodeRecordV2 } from '../src/storage/table/codec.js';
import { readRecord } from '../src/storage/table/format.js';
import { snapshotRecord } from '../src/storage/table/audit-traversal.js';
import { stamp, tableBinding } from './support/table-service.js';
import { changedM3, lease, wireM3 } from './support/table-v3.js';

const bound = bindTable(tableBinding);
const owner = '66666666-6666-4666-8666-666666666666';
const decode = (wire: Record<string, unknown>) => readRecord(3, bound, Buffer.from(JSON.stringify(wire)), 'M');
test('V3 closed layout decodes while both old formats refuse even unowned M', () => {
  const raw = stamp(wireM3(), 1);
  assert.doesNotThrow(() => decode(raw));
  for (const old of [decodeRecord, decodeRecordV2]) assert.throws(() => old(bound, Buffer.from(JSON.stringify(raw)), 'M'));
  const record = decode(stamp(wireM3(owner, 1), 2));
  assert.equal(record.value.kind === 'metadata' && record.value.owner, owner);
});
test('V3 lease policy, canonical bytes and owner/lease relation are validated independently of digest', () => {
  for (const patch of [{ durationMs: 120001 }, { skewMs: 0 }, { sequence: 0 }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { extra: true }]) {
    const raw = changedM3(wireM3(owner, 1), { Lease: Buffer.from(JSON.stringify({ ...lease(), ...patch })).toString('base64') });
    assert.throws(() => decode(raw));
  }
  for (const [ownerValue, leaseValue] of [[owner, ''], ['', Buffer.from(JSON.stringify(lease())).toString('base64')]]) {
    assert.throws(() => decode(changedM3(wireM3(ownerValue, ownerValue ? 1 : 0), { Lease: leaseValue })));
  }
  const raw = changedM3(wireM3(owner, 1), { Lease: Buffer.from(JSON.stringify(lease(), null, 2)).toString('base64') });
  assert.throws(() => decode(raw));
});
test('V3 metadata snapshots detach the nested lease from their source record', () => {
  const original = decode(stamp(wireM3(owner, 1), 1));
  const copy = snapshotRecord(original) as typeof original;
  assert.ok(original.value.kind === 'metadata' && original.value.lease);
  assert.ok(copy.value.kind === 'metadata' && copy.value.lease);
  const expiry = original.value.lease.expiresAt; copy.value.lease.expiresAt++;
  assert.equal(original.value.lease.expiresAt, expiry);
});
test('V3 digest binds lease and domain bytes and rejects unknown wire fields/types', () => {
  const raw = stamp(wireM3(owner, 1), 1);
  for (const patch of [{ Lease: Buffer.from(JSON.stringify(lease(2))).toString('base64') }, { State: 'YQ==' },
    { Extra: '' }, { 'Lease@odata.type': 'Edm.String' }, { V: 2 }]) assert.throws(() => decode({ ...raw, ...patch }));
});
