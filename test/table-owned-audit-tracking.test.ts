import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as audit from '../src/storage/table/audit.js';
import { CursorHashes, AuditTracking } from '../src/storage/table/audit-tracking.js';
import { budget, code, owned, visitor } from './support/owned-audit.js';

test('cumulative work charging checks safe-integer remainder before addition without large workloads', () => {
  assert.equal(audit.chargeAuditWork(9007199254740990, 1, 9007199254740991), 9007199254740991);
  assert.equal(audit.chargeAuditWork(0, 9007199254740991, 9007199254740991), 9007199254740991);
  assert.throws(() => audit.chargeAuditWork(9007199254740991, 1, 9007199254740991), code('incomplete'));
  assert.throws(() => audit.chargeAuditWork(9007199254740990, 2, 9007199254740991), code('incomplete'));
});
test('cursor hash occupancy distinguishes zero digest, collisions and duplicates at half load', () => {
  const hashes = new CursorHashes(1000, () => {}); const zero = Buffer.alloc(32); const collision = Buffer.alloc(32); collision[31] = 1;
  assert.equal(hashes.add(zero), true); assert.equal(hashes.add(zero), false);
  assert.equal(hashes.add(collision), true); assert.equal(hashes.add(collision), false); assert.equal(hashes.add(zero), false);
  hashes.clear(); assert.equal(hashes.add(zero), true); assert.equal(hashes.add(collision), true);
});
test('cursor table charges initial capacity and entire old plus new growth overlap before doubling', () => {
  assert.throws(() => new CursorHashes(65, () => {}), code('incomplete'));
  const exact = new CursorHashes(66, () => {}); assert.equal(exact.add(Buffer.alloc(32)), true);
  // Two occupied buckets require C=4. Steady 132 fits, but old C=2 plus new C=4 requires 198.
  for (const cap of [132, 197]) {
    const hashes = new CursorHashes(cap, () => {}); hashes.add(Buffer.alloc(32));
    assert.throws(() => hashes.add(Buffer.alloc(32, 1)), code('incomplete'));
    assert.equal(hashes.add(Buffer.alloc(32)), false);
  }
  const growth = new CursorHashes(198, () => {}); growth.add(Buffer.alloc(32)); assert.equal(growth.add(Buffer.alloc(32, 1)), true);
  // The old allocation was released: current C=4 is 132, next overlap is 132+264=396.
  assert.throws(() => growth.add(Buffer.alloc(32, 2)), code('incomplete'));
  const next = new CursorHashes(396, () => {}); for (let i = 0; i < 4; i++) assert.equal(next.add(Buffer.alloc(32, i)), true);
});
test('hash lookup and rehash check eligibility within probe loops', () => {
  let checks = 0; let stop = Infinity; const hashes = new CursorHashes(1000, () => { if (++checks >= stop) throw new Error('stopped'); });
  hashes.add(Buffer.alloc(32)); checks = 0; stop = 4;
  const collision = Buffer.alloc(32); collision[31] = 1;
  assert.throws(() => hashes.add(collision), { message: 'stopped' }); assert.equal(checks, 4);
});
test('tracking reserves both cursor representations, bounded hash scratch and two maximal row buffers', () => {
  // Old accepted token 8192 plus incoming SDK token 10976, each with two 2048-char headers:
  // 2*(8192+4096) + 2*(10976+4096) + (3*8192+32+2*64) + 2*(2*351) = 80860; C=2 adds 66.
  assert.throws(() => new AuditTracking(80925, () => {}), code('incomplete'));
  const tracker = new AuditTracking(80926, () => {});
  tracker.row('M'); tracker.row('delivery_' + 'a'.repeat(342));
  assert.throws(() => tracker.row('delivery_' + 'a'.repeat(342)), code('incomplete'));
  tracker.clear(); tracker.row('M');
  assert.equal(tracker.cursor({ token: 'a'.repeat(8192), partition: 'b'.repeat(2048), row: 'c'.repeat(2048) }), true);
  assert.equal(tracker.cursor({ token: 'a'.repeat(8192), partition: 'b'.repeat(2048), row: 'c'.repeat(2048) }), false);
});
for (const cap of [80925, 80926, 81057, 81058]) test(`audit tracking capacity ${cap} gates small continuation fixture before extra requests`, async t => {
  const { s, k } = await owned(t, 1); let pages = 0;
  s.controls.hook = e => {
    if (e.path.includes(",RowKey='M'")) { e.reply(); return; }
    pages++; const withinPass = (pages - 1) % 3 + 1;
    e.res.writeHead(200, { 'content-type': 'application/json', ...(withinPass < 3 ? { 'x-ms-continuation-nextpartitionkey': 'opaque', 'x-ms-continuation-nextrowkey': String(withinPass) } : {}) });
    e.res.end(JSON.stringify({ value: withinPass === 3 ? [s.rows.get('M')] : [] }));
  };
  const audit = k.auditOwned({ ...visitor(), passes: 2 }, budget({ maxTrackingBytes: cap }));
  if (cap === 81058) await audit; else await assert.rejects(audit, code('incomplete'));
  assert.equal(pages, cap === 80925 ? 0 : cap === 81058 ? 6 : 2);
  delete s.controls.hook; await k.close();
});
