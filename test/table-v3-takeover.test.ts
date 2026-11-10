import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableKernelV3, TableError } from '../src/storage/table/index.js';
import * as recovery from '../src/storage/table/recovery.js';
import { budget } from './support/owned-audit.js';
import { deferred, eventually, tableBinding, tableService } from './support/table-service.js';
import { TestClock } from './support/table-v3.js';

const code = (want: string) => (e: unknown) => e instanceof TableError && e.code === want;
const visitor = { passes: 2 as const, record(): undefined {}, endPass(): undefined {}, finalize(): undefined {} };
const disposition = { state: Buffer.alloc(0), dispositionDigest: 'b'.repeat(64),
  complete: () => ({ result: Buffer.alloc(0), domainDispositionDigest: 'c'.repeat(64) }) };
async function setup(t: Parameters<typeof tableService>[0]) {
  const s = await tableService(t, 'delivery', 3); const clock = new TestClock();
  const deps = { ...s.dependencies, leaseClock: clock }; const old = createTableKernelV3(tableBinding, deps);
  t.after(() => old.close().catch(() => {})); await old.initialize(); await old.acquire();
  const row = await old.read('M'); assert.ok(row?.value.kind === 'metadata'); const m = row.value;
  const fence = { initId: m.initId, initDigest: m.initDigest, owner: m.owner, epoch: m.epoch, mDigest: m.digest, etag: row.etag };
  const factory = (recovery as any).createTableLeaseExpirerV3;
  assert.equal(typeof factory, 'function', 'V3 audited expiry transport must exist');
  return { s, clock, deps, old, fence, factory };
}

test('expiry exact boundary refuses; safe expiry atomically clears and retains evidence before successor acquires', async t => {
  const { s, clock, deps, old, fence, factory } = await setup(t);
  clock.advance(125000, false); const before = s.stats.writes;
  const early = factory(tableBinding, deps, fence);
  await assert.rejects(early.reclaim(visitor, budget(), disposition), code('busy')); await early.close();
  assert.equal(s.stats.writes, before);
  clock.advance(1, false); const clear = factory(tableBinding, deps, fence);
  await clear.reclaim(visitor, budget(), disposition); await clear.close();
  const m = s.rows.get('M')!; assert.equal(m.Owner, ''); assert.equal(m.Epoch, '1'); assert.equal(m.Lease, '');
  assert.equal(m.Operation, 'lease-expiry'); const x = JSON.parse(Buffer.from(String(m.Exit), 'base64').toString());
  assert.equal(x.kind, 'lease-expiry'); assert.equal(x.originalMDigest, fence.mDigest); assert.equal(x.lease.expiresAt, 1120000);
  assert.equal(x.observedAt, 1125001); assert.equal('operatorAttestationDigest' in x, false);
  const audit = s.rows.get('control_' + Buffer.from('control_lease_expiry:' + x.auditId).toString('base64url'))!;
  assert.equal(audit.Digest, x.auditDigest); assert.equal(s.stats.lastActions, 2);
  const next = createTableKernelV3(tableBinding, deps); await next.acquire(); assert.equal(s.rows.get('M')!.Epoch, '2');
  assert.equal(s.rows.get('M')!.Exit, m.Exit); await next.close(); await assert.rejects(old.close(), code('unresolved'));
});

for (const committed of [true, false]) test(`expiry lost ACK commit=${committed} never blindly retries`, async t => {
  const { s, clock, deps, fence, factory } = await setup(t); clock.advance(125001, false); let writes = 0;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'lease-expiry') { writes++; if (committed) e.commit(); e.res.destroy(); } else e.reply(); };
  const r = factory(tableBinding, deps, fence);
  if (committed) await r.reclaim(visitor, budget(), disposition);
  else await assert.rejects(r.reclaim(visitor, budget(), disposition), code('unresolved'));
  assert.equal(writes, 1); assert.equal([...s.rows.keys()].filter(k => k.startsWith('control_')).length, committed ? 1 : 0);
  await r.close(); delete s.controls.hook;
});

test('losing_clear_race_with_lost_ack proves a foreign clear without claiming its own commit', async t => {
  const { s, clock, deps, fence, factory } = await setup(t); clock.advance(125001, false);
  const a = factory(tableBinding, deps, fence); const b = factory(tableBinding, deps, fence);
  const gate = deferred(); let submissions = 0;
  s.controls.hook = async e => { if (e.actions[0]?.entity.Operation === 'lease-expiry') {
    submissions++; if (submissions === 2) gate.resolve(); await gate.promise; e.commit(); e.res.destroy();
  } else e.reply(); };
  await Promise.all([a.reclaim(visitor, budget(), disposition), b.reclaim(visitor, budget(), disposition)]);
  assert.deepEqual([a.transitionOutcome(), b.transitionOutcome()].sort(), ['foreign-clear', 'own-commit']);
  assert.equal(submissions, 2); assert.equal(s.rows.size, 2); assert.equal(s.rows.get('M')!.Owner, '');
  await Promise.all([a.close(), b.close()]); delete s.controls.hook;
});

test('foreign-clear proof preserves each caller request budget at the final native handoff', async t => {
  const { s, clock, deps, fence, factory } = await setup(t); clock.advance(125001, false);
  const gate = deferred(); let submissions = 0; const pageBudgets: number[] = [];
  const native = () => {
    let remaining = 0;
    return { ...deps, token: async (scope: any, ctx: any) => { remaining = ctx.deadline - performance.now(); return deps.token(scope, ctx); },
      request: ((...args: any[]) => {
        const url = new URL(String(args[0]));
        if (submissions >= 2 && url.pathname.endsWith('()')) pageBudgets.push(remaining);
        return Reflect.apply(deps.request!, undefined, args);
      }) as typeof import('node:https').request };
  };
  const a = factory(tableBinding, native(), fence); const b = factory(tableBinding, native(), fence);
  s.controls.hook = async e => { if (e.actions[0]?.entity.Operation === 'lease-expiry') {
    if (++submissions === 2) gate.resolve(); await gate.promise; e.commit(); e.res.destroy();
  } else e.reply(); };
  await Promise.all([a.reclaim(visitor, budget(), disposition, { requestTimeoutMs: 3000 }), b.reclaim(visitor, budget(), disposition, { requestTimeoutMs: 3000 })]);
  assert.ok(pageBudgets.length > 0, 'exercise the foreign two-pass proof, not only point reconciliation');
  assert.ok(pageBudgets.every(ms => ms <= 3000), `foreign proof enlarged request budgets: ${pageBudgets.join(',')}`);
  await Promise.all([a.close(), b.close()]); delete s.controls.hook;
});

test('renewed read snapshots isolate nested expiry leases from the private fence used by later audits', async t => {
  const { s, clock, deps, fence, factory } = await setup(t); clock.advance(125001, false);
  const clear = factory(tableBinding, deps, fence); await clear.reclaim(visitor, budget(), disposition); await clear.close();
  const next = createTableKernelV3(tableBinding, deps); t.after(() => next.close().catch(() => {})); await next.acquire();
  let advanced = false;
  s.controls.hook = e => { if (!advanced && e.req.method === 'GET') { advanced = true; clock.advance(40000, false); } e.reply(); };
  const snapshot = await next.read('M'); delete s.controls.hook;
  assert.ok(snapshot?.value.kind === 'metadata' && snapshot.value.exit?.kind === 'lease-expiry');
  snapshot.value.exit.lease.sequence += 1;
  await next.auditOwned(visitor, budget());
  assert.equal(next.leaseAuthority().allowed(), true); await next.close();
});

test('changed M during expiry proof cannot create orphan audit', async t => {
  const { s, clock, deps, fence, factory } = await setup(t); clock.advance(125001, false);
  const before = s.stats.writes; const r = factory(tableBinding, deps, fence);
  await assert.rejects(r.reclaim({ ...visitor, finalize() { const m = s.rows.get('M')!; s.rows.set('M', { ...m, 'odata.etag': 'W/"other"' }); } }, budget(), disposition));
  assert.equal(s.stats.writes, before); assert.equal(s.rows.size, 1); await r.close();
});

test('expiry token held across cancellation cannot submit, and close drains the actual token', async t => {
  const { s, clock, deps, fence, factory } = await setup(t); clock.advance(125001, false);
  const gate = deferred(); let held = false; let final = false; const cancel = new AbortController();
  const r = factory(tableBinding, { ...deps, token: async (scope: any, ctx: any) => {
    if (final) { held = true; await gate.promise; } return deps.token(scope, ctx);
  } }, fence);
  const operation = r.reclaim(visitor, budget(), { ...disposition, complete() { final = true; return disposition.complete(); } }, { signal: cancel.signal });
  const rejected = assert.rejects(operation); await eventually(() => held); const before = s.stats.writes;
  cancel.abort(); let closed = false; const close = r.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  gate.resolve(); await rejected; await close; assert.equal(s.stats.writes, before);
});
