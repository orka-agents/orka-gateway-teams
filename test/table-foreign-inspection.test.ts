import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableForeignInspectorV2 } from '../src/storage/table/index.js';
import { budget, owned, visitor } from './support/owned-audit.js';
import { tableBinding } from './support/table-service.js';

test('foreign V2 native public API completes two passes with no ownership or Table writes', async t => {
  const { s, k } = await owned(t, 2);
  const record = await k.read('M');
  if (!record || record.value.kind !== 'metadata') throw new Error('Fixture metadata missing');
  const m = record.value;
  const expected = { initId: m.initId, initDigest: m.initDigest, owner: m.owner, epoch: m.epoch, mDigest: m.digest, etag: record.etag };
  const before = s.stats.writes; let gets = 0; let nonGets = 0;
  s.controls.hook = e => { if (e.req.method === 'GET') gets++; else nonGets++; e.reply(); };
  const inspector = createTableForeignInspectorV2(tableBinding, s.dependencies, expected);
  await inspector.inspect({ ...visitor(), passes: 2 }, budget());
  assert.equal(inspector.status().ownership, 'none');
  assert.equal(inspector.status().lifecycle, 'completed');
  assert.equal(s.stats.writes, before);
  await inspector.close();
  assert.equal(s.stats.writes, before); assert.equal(nonGets, 0); assert.equal(gets, 6);
  delete s.controls.hook; await k.close();
});
