import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableKernelV3 } from '../src/storage/table/owner.js';
import { tableBinding, tableService } from './support/table-service.js';
import { changedM3, TestClock } from './support/table-v3.js';

const budget = { maxPages: 40, maxPageBytes: 1024 * 1024, maxDurationMs: 10000, maxTrackingBytes: 1024 * 1024 };
async function setup(t: Parameters<typeof tableService>[0]) {
  const s = await tableService(t, 'delivery', 3); const clock = new TestClock();
  const k = createTableKernelV3(tableBinding, { ...s.dependencies, leaseClock: clock });
  t.after(() => k.close().catch(() => {})); await k.initialize(); await k.acquire(); await k.scan();
  await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state: Buffer.from('state'), result: Buffer.from('result'),
    actions: ['one', 'two', 'three'].map(id => ({ kind: 'create' as const, key: { type: 'delivery' as const, id }, payload: Buffer.from(id) })) }));
  return { s, k, clock };
}
test('V3 two-pass owned audit renews internally while preserving exact data versions', async t => {
  const { s, k, clock } = await setup(t); const domain = structuredClone(s.rows.get('M')!);
  const versions: string[][] = [[], []]; let pages = 0;
  s.controls.hook = e => {
    if (e.req.method === 'GET' && !e.path.includes("RowKey='")) { pages++; e.reply(); clock.advance(30000, false); }
    else e.reply();
  };
  await k.auditOwned({ passes: 2, record(pass, r) {
    if (r.value.kind === 'data') versions[pass - 1]!.push(JSON.stringify([r.row, r.etag, r.value.digest]));
    else for (const key of ['owner', 'epoch', 'operation', 'invocation', 'plan']) {
      const wire = { owner: 'Owner', epoch: 'Epoch', operation: 'Operation', invocation: 'Invocation', plan: 'Plan' }[key]!;
      assert.equal(String(r.value[key as 'owner']), String(domain[wire]));
    }
  }, endPass() {}, finalize() {} }, budget);
  assert.equal(pages, 8); assert.deepEqual(versions[0], versions[1]);
  assert.equal(versions[0]!.length, 3); assert.equal(k.status().lifecycle, 'envelope-audited');
  assert.equal(k.leaseAuthority().allowed(), true);
  assert.equal(JSON.parse(Buffer.from(String(s.rows.get('M')?.Lease), 'base64').toString()).sequence >= 4, true);
  delete s.controls.hook;
});
test('V3 scan renews at page boundaries and preserves its domain acquire operation', async t => {
  const { s, k, clock } = await setup(t);
  // New epoch starts with acquire; the retained data is only an envelope fixture.
  await k.close(); const next = createTableKernelV3(tableBinding, { ...s.dependencies, leaseClock: clock });
  t.after(() => next.close().catch(() => {})); await next.acquire();
  s.controls.hook = e => { e.reply(); if (e.req.method === 'GET' && !e.path.includes("RowKey='")) clock.advance(30000, false); };
  const rows = await next.scan();
  assert.equal(rows.length, 4); assert.equal(s.rows.get('M')?.Operation, 'acquire');
  assert.equal(next.leaseAuthority().allowed(), true); assert.equal(next.status().lifecycle, 'envelope-audited');
  delete s.controls.hook;
});
test('V3 page stalled beyond authority cannot publish a successful audit without timer callbacks', async t => {
  const { s, k, clock } = await setup(t); let advanced = false; let published = false;
  s.controls.hook = e => {
    if (!advanced && e.req.method === 'GET' && !e.path.includes("RowKey='")) { advanced = true; clock.advance(114000, false); }
    e.reply();
  };
  await assert.rejects(k.auditOwned({ passes: 2, record() {}, endPass() {}, finalize() { published = true; } }, budget));
  assert.equal(published, false); assert.equal(k.leaseAuthority().allowed(), false);
  assert.equal(k.status().lifecycle, 'poisoned'); delete s.controls.hook;
});
for (const domainChange of [false, true]) test(`V3 audit rejects a foreign metadata change even with matching owner/epoch; domain=${domainChange}`, async t => {
  const { s, k } = await setup(t); let changed = false;
  s.controls.hook = e => {
    if (!changed && e.req.method === 'GET' && !e.path.includes("RowKey='")) {
      changed = true; const previous = s.rows.get('M')!;
      const lease = JSON.parse(Buffer.from(String(previous.Lease), 'base64').toString());
      s.rows.set('M', changedM3(previous, domainChange ? { Plan: 'f'.repeat(64) } : {
        Lease: Buffer.from(JSON.stringify({ ...lease, sequence: lease.sequence + 1 })).toString('base64') }));
    }
    e.reply();
  };
  await assert.rejects(k.auditOwned({ passes: 2, record() {}, endPass() {}, finalize() {} }, budget));
  assert.equal(k.leaseAuthority().allowed(), false); delete s.controls.hook;
});
