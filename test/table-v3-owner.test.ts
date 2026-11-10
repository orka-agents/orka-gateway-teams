import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnedTableClient } from '../src/storage/table/client.js';
import { createTableKernelV3 as create } from '../src/storage/table/index.js';
import type { TableError } from '../src/storage/table/types.js';
import { deferred, eventually, stamp, tableBinding, tableService } from './support/table-service.js';
import { wireM2 } from './support/table-v2.js';
import { TestClock, wireM3 } from './support/table-v3.js';

const code = (want: string) => (e: unknown) => e instanceof Error && (e as TableError).code === want;
async function setup(t: Parameters<typeof tableService>[0], limits = {}) {
  const s = await tableService(t, 'delivery', 3); const clock = new TestClock();
  const k = create(tableBinding, { ...s.dependencies, leaseClock: clock }, limits);
  t.after(() => k.close().catch(() => {}));
  await k.initialize(); await k.acquire(); return { s, k, clock };
}
const input = { input: Buffer.alloc(0), keys: [] };
const plan = () => ({ state: Buffer.from('state'), result: Buffer.from('result'), actions: [] });
const savedLease = (m: Record<string, unknown> | undefined) => JSON.parse(Buffer.from(String(m?.Lease), 'base64').toString());

test('V3 explicit lifecycle gives a lease only after acquisition and clears it on clean release', async t => {
  const { s, k, clock } = await setup(t);
  assert.equal(k.leaseAuthority().allowed(), true);
  assert.equal(savedLease(s.rows.get('M')).expiresAt, 1120000);
  await k.scan(); assert.equal((await k.mutate(input, plan)).kind, 'committed');
  await k.close(); assert.equal(s.rows.get('M')?.Owner, ''); assert.equal(s.rows.get('M')?.Lease, '');
  assert.equal(k.leaseAuthority().allowed(), false); assert.equal(clock.pendingTimers, 0);
  assert.equal(s.stats.violation, false);
});
test('V3 renewal CAS preserves every domain byte and is admitted even with a saturated user queue', async t => {
  const { s, k, clock } = await setup(t, { maxPending: 1 }); const before = structuredClone(s.rows.get('M')!);
  const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (!held && e.req.method === 'GET') { held = true; await gate.promise; } e.reply(); };
  const read = k.read('M'); await eventually(() => held); clock.advance(40000);
  gate.resolve(); await read; await eventually(() => savedLease(s.rows.get('M')).sequence === 2);
  const after = s.rows.get('M')!;
  for (const key of ['Owner', 'Epoch', 'Operation', 'Invocation', 'Plan', 'State', 'Result', 'Exit']) assert.equal(after[key], before[key]);
  assert.equal(savedLease(after).expiresAt, 1160000); assert.notEqual(after.Digest, before.Digest);
  assert.equal(k.leaseAuthority().allowed(), true); delete s.controls.hook;
});
test('V3 late wakeup self-fences without waiting for the expiry timer', async t => {
  const { s, k, clock } = await setup(t); await k.scan(); const writes = s.stats.writes;
  clock.advance(114000, false);
  assert.equal(k.leaseAuthority().allowed(), false); assert.equal(k.leaseAuthority().lost.aborted, true);
  await assert.rejects(k.mutate(input, plan), code('unresolved')); await assert.rejects(k.close(), code('unresolved'));
  assert.equal(s.stats.writes, writes); assert.notEqual(s.rows.get('M')?.Owner, '');
});
test('V3 authority cutoff is strict and a backwards wall step cannot extend it', async t => {
  const { k, clock } = await setup(t); clock.advance(113999, false); assert.equal(k.leaseAuthority().allowed(), true);
  clock.advance(1, false); assert.equal(k.leaseAuthority().allowed(), false);
});
test('V3 detects wall/monotonic divergence and never revives after clocks recover', async t => {
  const { k, clock } = await setup(t); clock.wall -= 5001;
  assert.equal(k.leaseAuthority().allowed(), false); clock.wall += 5001;
  assert.equal(k.leaseAuthority().allowed(), false);
});
test('V3 storage token released after expiry cannot submit a late mutation or clean release', async t => {
  const { s, k, clock } = await setup(t); await k.scan();
  const gate = deferred(); let held = false;
  // Hold a token only after the mutation's authority GET, at its write boundary.
  const original = s.dependencies.token; let calls = 0; let armed = false;
  const otherClock = new TestClock();
  const other = create(tableBinding, { ...s.dependencies, leaseClock: otherClock, token: async (scope, ctx) => {
    if (armed && ++calls === 2) { held = true; await gate.promise; } return original(scope, ctx);
  } });
  await k.close(); await other.acquire(); await other.scan();
  armed = true; const writes = s.stats.writes; const mutation = other.mutate(input, plan); const failed = assert.rejects(mutation, code('unresolved'));
  await eventually(() => held); otherClock.advance(114000, false); gate.resolve(); await failed;
  await assert.rejects(other.close(), code('unresolved')); assert.equal(s.stats.writes, writes);
  assert.equal(other.leaseAuthority().lost.aborted, true); assert.equal(clock.pendingTimers, 0);
});
for (const commit of [true, false]) test(`V3 lost renewal ACK commit=${commit} is reconciled without resubmitting`, async t => {
  const { s, k, clock } = await setup(t); let renewals = 0;
  s.controls.hook = e => {
    const m = e.actions[0]?.entity;
    if (m && savedLease(m)?.sequence === 2 && m.Operation === 'acquire') { renewals++; if (commit) e.commit(); e.res.destroy(); }
    else e.reply();
  };
  clock.advance(40000);
  await eventually(() => commit ? savedLease(s.rows.get('M')).sequence === 2 && k.status().pending === 0 : k.leaseAuthority().lost.aborted);
  // Revalidation queues behind the actual renewal readback, not merely its ACK.
  if (commit) assert.equal(await k.leaseAuthority().revalidate(), true);
  else assert.equal(k.leaseAuthority().allowed(), false);
  assert.equal(renewals, 1); delete s.controls.hook;
});
test('V3 two acquire CAS contenders grant only one live authority', async t => {
  const s = await tableService(t, 'delivery', 3);
  const a = create(tableBinding, { ...s.dependencies, leaseClock: new TestClock() });
  const b = create(tableBinding, { ...s.dependencies, leaseClock: new TestClock() });
  await a.initialize(); const result = await Promise.allSettled([a.acquire(), b.acquire()]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal([a, b].filter(k => k.leaseAuthority().allowed()).length, 1);
  await Promise.allSettled([a.close(), b.close()]);
});
test('V3 accepted long limits lose authority during held reconciliation, despite a late committed renewal', async t => {
  const { s, k, clock } = await setup(t, { callTimeoutMs: 300000, cleanupTimeoutMs: 300000 });
  const gate = deferred(); let submitted = false; let held = false;
  s.controls.hook = async e => {
    if (e.actions.length) { submitted = true; e.commit(); e.res.destroy(); }
    else if (submitted && !held) { held = true; await gate.promise; e.reply(); } else e.reply();
  };
  clock.advance(40000); await eventually(() => held); clock.advance(74000);
  assert.equal(k.leaseAuthority().lost.aborted, true); const writes = s.stats.writes;
  gate.resolve(); await assert.rejects(k.close(), code('unresolved')); assert.equal(s.stats.writes, writes);
  assert.equal(k.leaseAuthority().allowed(), false); delete s.controls.hook;
});
test('V3 overflow rejection never arms a lease or changes persistent ownership', async t => {
  const s = await tableService(t, 'delivery', 3); const clock = new TestClock();
  s.rows.set('M', stamp(wireM3('', Number.MAX_SAFE_INTEGER), 1));
  const k = create(tableBinding, { ...s.dependencies, leaseClock: clock });
  await assert.rejects(k.acquire(), code('invalid-input'));
  assert.equal(clock.pendingTimers, 0); assert.equal(s.stats.writes, 0); await k.close();
});
test('V3 does not upgrade V2 or take over an expired occupied row', async t => {
  const s = await tableService(t, 'delivery', 3);
  for (const [wire, want] of [[wireM2(), 'corrupt'], [wireM3('66666666-6666-4666-8666-666666666666', 1), 'busy']] as const) {
    const clock = new TestClock(); clock.advance(140000, false); s.rows.set('M', stamp(wire, 1));
    const k = create(tableBinding, { ...s.dependencies, leaseClock: clock });
    await assert.rejects(k.acquire(), code(want)); await k.close();
  }
  assert.equal(s.stats.writes, 0);
});
test('V3 idle renewal loses authority on unavailable storage and cannot claim release', async t => {
  const { s, k, clock } = await setup(t);
  s.controls.hook = e => { e.res.writeHead(503); e.res.end(); };
  clock.advance(40000); await eventually(() => k.leaseAuthority().lost.aborted);
  const writes = s.stats.writes; await assert.rejects(k.close(), code('unresolved'));
  assert.equal(s.stats.writes, writes); assert.notEqual(s.rows.get('M')?.Owner, '');
  assert.equal(s.stats.requests, s.stats.requestCloses); delete s.controls.hook;
});
test('V3 revalidation before acquisition or after close refuses without poisoning ownership', async t => {
  const s = await tableService(t, 'delivery', 3); const clock = new TestClock();
  const k = create(tableBinding, { ...s.dependencies, leaseClock: clock });
  assert.equal(await k.leaseAuthority().revalidate(), false);
  assert.equal(k.leaseAuthority().lost.aborted, false); await k.initialize(); await k.acquire();
  const close = k.close(); assert.equal(await k.leaseAuthority().revalidate(), false);
  await close; assert.equal(k.leaseAuthority().lost.aborted, false); assert.equal(s.rows.get('M')?.Owner, '');
});
test('V3 refused revalidation under queue pressure leaves the live grant and in-flight work intact', async t => {
  const { s, k } = await setup(t, { maxPending: 1 }); const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (!held && e.req.method === 'GET') { held = true; await gate.promise; } e.reply(); };
  const read = k.read('M'); const drained = read.then(() => 'read', () => 'failed'); await eventually(() => held);
  assert.equal(await k.leaseAuthority().revalidate(), false);
  assert.equal(k.leaseAuthority().lost.aborted, false); assert.equal(k.leaseAuthority().allowed(), true);
  gate.resolve(); assert.equal(await drained, 'read'); delete s.controls.hook; await k.close();
  assert.equal(s.rows.get('M')?.Owner, '');
});
test('V3 slightly early idle renewal timer re-arms rather than abandoning renewal', async t => {
  let renewal: (() => void) | undefined; let registrations = 0;
  const clock = new TestClock(); const base = clock.setTimer;
  clock.setTimer = (callback, delay) => {
    const cancel = base(callback, delay);
    if (delay === 40000) { renewal = () => { cancel(); callback(); }; registrations++; }
    return cancel;
  };
  const s = await tableService(t, 'delivery', 3); const k = create(tableBinding, { ...s.dependencies, leaseClock: clock });
  t.after(() => k.close().catch(() => {})); await k.initialize(); await k.acquire();
  assert.equal(registrations, 1); clock.advance(39999, false); renewal!();
  assert.equal(clock.pendingTimers >= 2, true);
  clock.advance(1); await eventually(() => savedLease(s.rows.get('M')).sequence === 2);
  assert.equal(await k.leaseAuthority().revalidate(), true);
});
test('V3 caller cancellation of a read is not a storage-authority failure', async t => {
  const { s, k } = await setup(t); const gate = deferred(); let held = false; const abort = new AbortController();
  s.controls.hook = async e => { if (!held && e.req.method === 'GET') { held = true; await gate.promise; } e.reply(); };
  const read = k.read('M', { signal: abort.signal }); const failed = assert.rejects(read, code('unavailable'));
  await eventually(() => held); abort.abort(); await failed; gate.resolve();
  await eventually(() => k.status().pending === 0); delete s.controls.hook;
  assert.equal(k.leaseAuthority().lost.aborted, false); assert.equal(await k.leaseAuthority().revalidate(), true);
  await k.close(); assert.equal(s.rows.get('M')?.Owner, '');
});
test('V3 confirmed release retires its lease before transport drain crosses expiry', async t => {
  const { s, k, clock } = await setup(t); const close = OwnedTableClient.prototype.close;
  t.mock.method(OwnedTableClient.prototype, 'close', function(this: OwnedTableClient) {
    clock.advance(114000); return close.call(this);
  });
  await k.close(); assert.equal(s.rows.get('M')?.Owner, '');
  assert.equal(k.leaseAuthority().lost.aborted, false); assert.equal(clock.pendingTimers, 0);
});
test('V3 premature owned audit remains unready and does not poison an unowned handle', async t => {
  const s = await tableService(t, 'delivery', 3); const clock = new TestClock();
  const k = create(tableBinding, { ...s.dependencies, leaseClock: clock });
  t.after(() => k.close().catch(() => {}));
  const visitor = { passes: 1 as const, record(): undefined {}, endPass(): undefined {}, finalize(): undefined {} };
  const budget = { maxPages: 10, maxPageBytes: 1024 * 1024, maxDurationMs: 10000, maxTrackingBytes: 1024 * 1024 };
  await assert.rejects(k.auditOwned(visitor, budget), code('unready'));
  assert.equal(k.leaseAuthority().lost.aborted, false); await k.initialize();
  await assert.rejects(k.auditOwned(visitor, budget), code('unready'));
  assert.equal(k.leaseAuthority().lost.aborted, false); await k.acquire(); await k.scan(); await k.close();
  assert.equal(s.rows.get('M')?.Owner, '');
});
for (const field of ['etag', 'digest'] as const) test(`V3 read crossing renewal returns caller-owned ${field}, not the private fence`, async t => {
  const { s, k, clock } = await setup(t); let advanced = false;
  s.controls.hook = e => {
    e.reply(); if (!advanced && e.path.includes("RowKey='M'")) { advanced = true; clock.advance(40000, false); }
  };
  const record = await k.read('M'); assert.equal(savedLease(s.rows.get('M')).sequence, 2);
  assert.ok(record); assert.equal(record.value.kind, 'metadata');
  if (field === 'etag') record.etag = 'W/"caller-owned"';
  else record.value.digest = 'f'.repeat(64);
  delete s.controls.hook; assert.equal(await k.leaseAuthority().revalidate(), true);
  assert.equal(k.leaseAuthority().lost.aborted, false); await k.close(); assert.equal(s.rows.get('M')?.Owner, '');
});
test('V3 normal mutation cannot append reserved recovery, expiry or upgrade evidence', async t => {
  const { s, k } = await setup(t); await k.scan();
  for (const prefix of ['control_recovery:', 'control_lease_expiry:', 'control_format_upgrade:']) {
    const result = await k.mutate(input, () => ({ ...plan(), actions: [{ kind: 'create', key: { type: 'control', id: prefix + 'attempt' }, payload: Buffer.from('fake') }] }));
    assert.equal(result.kind, 'cancelled'); assert.equal(s.rows.size, 1);
  }
  assert.equal(k.leaseAuthority().allowed(), true);
});
