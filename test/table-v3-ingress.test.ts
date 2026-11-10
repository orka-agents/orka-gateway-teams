import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createTableIngressStoreV3 as create } from '../src/ingress/table-store.js';
import { expireTableIngressV3, reclaimTableIngressV3 } from '../src/ingress/table-recovery.js';
import { auditInbox } from '../src/ingress/table-audit.js';
import { encodeState } from '../src/ingress/table-codec.js';
import { encodeResult, stateDigest } from '../src/ingress/table-result.js';
import { initialState } from '../src/ingress/table-state.js';
import { bindTable } from '../src/storage/table/codec.js';
import { createTableKernelV3 } from '../src/storage/table/index.js';
import type { ForeignOwnerFenceV2, TableLeaseDependencies } from '../src/storage/table/types.js';
import { auditBudget, indexBudget, pair, wireData } from './support/table-ingress-audit.js';
import { options, code, payload, rowKey, state } from './support/table-ingress-store.js';
import { deferred, eventually, ingressBinding, tableService } from './support/table-service.js';
import { TestClock } from './support/table-v3.js';

const expire = (...args: [typeof ingressBinding, TableLeaseDependencies, ForeignOwnerFenceV2]) =>
  expireTableIngressV3(...args, auditBudget, indexBudget);
const reclaim = (...args: [typeof ingressBinding, TableLeaseDependencies, ForeignOwnerFenceV2, string]) =>
  reclaimTableIngressV3(args[0], args[1], args[2], auditBudget, indexBudget, args[3]);
function fence(s: Awaited<ReturnType<typeof tableService>>): ForeignOwnerFenceV2 {
  const m = s.rows.get('M')!;
  return { initId: String(m.InitId), initDigest: String(m.InitDigest), owner: String(m.Owner), epoch: Number(m.Epoch),
    mDigest: String(m.Digest), etag: String(m['odata.etag']) };
}
const exit = (s: Awaited<ReturnType<typeof tableService>>) => JSON.parse(Buffer.from(String(s.rows.get('M')!.Exit), 'base64').toString());
const lease = (s: Awaited<ReturnType<typeof tableService>>) => JSON.parse(Buffer.from(String(s.rows.get('M')!.Lease), 'base64').toString());
async function seeded(t: TestContext) {
  const s = await tableService(t, 'ingress', 3); const clock = new TestClock();
  const dependencies = { ...s.dependencies, leaseClock: clock };
  const k = createTableKernelV3(ingressBinding, dependencies); t.after(() => k.close().catch(() => undefined));
  await k.initialize(); await k.acquire(); await k.scan();
  const bytes = encodeState(initialState());
  await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state: bytes,
    result: encodeResult({ schema: 1, operation: 'initialize', epoch: 1, basis: null, clock: null,
      decision: { kind: 'initialized' }, postStateDigest: stateDigest(bindTable(ingressBinding), bytes) }), actions: [] }));
  return { s, k, clock, dependencies };
}
async function opened(t: TestContext) {
  const s = await tableService(t, 'ingress', 3); const clock = new TestClock();
  const dependencies = { ...s.dependencies, leaseClock: clock };
  await create(ingressBinding, dependencies, options).initialize();
  const j = create(ingressBinding, dependencies, options); await j.open(); t.after(() => j.close().catch(() => undefined));
  return { s, j, clock, dependencies };
}

test('V3 ingress initialized/opened lifecycle retains completed receipts across ordinary restart', async t => {
  const { s, j, dependencies } = await opened(t); const p = pair();
  await j.admit(p.event.body!, p.route.route); const g = await j.claimForForwarding(); assert.ok(g);
  assert.equal(await g.revalidate(), true); assert.equal(g.take(), true);
  await j.complete(g.claim, { status: 'accepted', eventId: 'receipt', state: 'Queued' });
  await j.close(); const next = create(ingressBinding, dependencies, options); await next.open();
  assert.equal((await next.admit(p.event.body!, p.route.route)).kind, 'duplicate');
  assert.equal(await next.claimForForwarding(), undefined); assert.equal(s.rows.get('M')!.V, 3); await next.close();
});

test('automatic ingress expiry seals an armed generation without inventing operator attestation or resending', async t => {
  const { s, j, clock, dependencies } = await opened(t); const p = pair();
  await j.admit(p.event.body!, p.route.route); const grant = await j.claimForForwarding(); assert.ok(grant);
  clock.advance(125001, false);
  const next = create(ingressBinding, dependencies, options); await next.open();
  const x = exit(s); assert.equal(x.kind, 'lease-expiry'); assert.equal('operatorAttestationDigest' in x, false);
  assert.equal(x.lease.expiresAt, 1120000); assert.equal(x.observedAt, 1125001);
  const audits = [...s.rows.values()].filter(r => r.RowKey !== 'M' && r.T === 'control' && payload(r).kind === 'lease-expiry-audit');
  assert.equal(audits.length, 1); const audit = payload(audits[0]!);
  assert.equal(audit.invocation, x.auditId); assert.equal(audits[0]!.Digest, x.auditDigest);
  assert.equal('operatorAttestationDigest' in audit, false);
  const seal = payload(s.rows.get(rowKey('control', 'generation:1'))!);
  assert.equal(seal.reason, 'clock-uncertain'); assert.equal(seal.observation, null);
  assert.equal(state(s).handoffClockArm, null); assert.equal(await next.claimForForwarding(), undefined);
  const fresh = pair('fresh', 'fresh-target', 2); await next.admit(fresh.event.body!, fresh.route.route);
  const freshGrant = await next.claimForForwarding(); assert.ok(freshGrant); assert.equal(freshGrant.claim.externalEventId, 'fresh');
  freshGrant.retire(); await next.close(); await assert.rejects(j.close(), code('unresolved'));
});

test('manual V3 ingress reclaim permits a live lease only with a real attestation digest', async t => {
  const { s, k, dependencies } = await seeded(t); const before = fence(s); const writes = s.stats.writes;
  const tokens = s.stats.tokens;
  for (const invalid of ['', undefined]) {
    await assert.rejects(reclaim(ingressBinding, dependencies, before, invalid as string), code('invalid-input'));
  }
  assert.equal(s.stats.tokens, tokens); assert.equal(s.stats.writes, writes);
  await reclaim(ingressBinding, dependencies, before, 'd'.repeat(64));
  assert.equal(s.rows.get('M')!.Owner, ''); assert.equal(s.rows.get('M')!.Lease, '');
  assert.equal(exit(s).kind, 'operator-recovery'); assert.equal(exit(s).operatorAttestationDigest, 'd'.repeat(64));
  const next = create(ingressBinding, dependencies, options); await next.open(); await next.close();
  await assert.rejects(k.close(), code('unresolved'));
});

for (const transitions of [['expiry', 'expiry'], ['manual', 'expiry'], ['expiry', 'manual']] as const) {
  test(`ingress ${transitions.join('_then_')} retains all transition audits and generation seals`, async t => {
    const { s, j, clock, dependencies } = await opened(t); const p = pair();
    await j.admit(p.event.body!, p.route.route); const grant = await j.claimForForwarding(); assert.ok(grant);
    for (const transition of transitions) {
      if (transition === 'expiry') { clock.advance(125001, false); await expire(ingressBinding, dependencies, fence(s)); }
      else await reclaim(ingressBinding, dependencies, fence(s), 'e'.repeat(64));
      const current = createTableKernelV3(ingressBinding, dependencies); await current.acquire();
      const audited = await auditInbox(current, ingressBinding, auditBudget, indexBudget);
      assert.equal(audited.header.state.handoffClockArm, null); assert.equal(audited.index.sealByGeneration(1)?.reason, 'clock-uncertain');
      audited.dispose(); current.invalidate(); await assert.rejects(current.close(), code('unresolved'));
    }
    assert.equal([...s.rows.values()].filter(r => r.RowKey !== 'M' && r.T === 'control' && payload(r).kind.endsWith('-audit')).length, 2);
    const next = create(ingressBinding, dependencies, options);
    clock.advance(125001, false); await next.open(); assert.equal(await next.claimForForwarding(), undefined); await next.close();
    await assert.rejects(j.close(), code('unresolved'));
  });
}

test('later ingress acquire rechecks an expiry audit commitment rather than decoding transition audit as a seal', async t => {
  const { s, k, clock, dependencies } = await seeded(t); clock.advance(125001, false);
  await expire(ingressBinding, dependencies, fence(s)); const x = exit(s);
  const entry = [...s.rows.entries()].find(([, r]) => r.T === 'control' && payload(r).invocation === x.auditId); assert.ok(entry);
  const audit = payload(entry[1]); audit.dispositionDigest = 'f'.repeat(64);
  s.rows.set(entry[0], wireData(s, 'control', String(entry[1].Id), Buffer.from(JSON.stringify(audit))));
  const next = create(ingressBinding, dependencies, options); await assert.rejects(next.open(), code('unresolved'));
  await assert.rejects(next.close(), code('unresolved')); await assert.rejects(k.close(), code('unresolved'));
});

test('renewed ingress audit publishes current M fence while retaining exact domain state and row proof', async t => {
  const { s, k, clock } = await seeded(t);
  let advances = 0;
  s.controls.hook = e => {
    if (advances < 2 && e.req.method === 'GET' && !e.path.includes("RowKey='")) { advances++; clock.advance(40000, false); }
    e.reply();
  };
  const audited = await auditInbox(k, ingressBinding, auditBudget, indexBudget);
  assert.equal(advances, 2); assert.equal(lease(s).sequence, 3);
  assert.equal(audited.header.version.digest, s.rows.get('M')!.Digest);
  assert.equal(audited.header.version.etag, s.rows.get('M')!['odata.etag']);
  assert.equal(audited.header.metadata.digest, s.rows.get('M')!.Digest);
  audited.dispose(); delete s.controls.hook; await k.close();
});

test('close cancels V3 ingress startup waiting on a live foreign lease without clearing it', async t => {
  const { s, k, clock, dependencies } = await seeded(t); const before = structuredClone(s.rows.get('M')); const writes = s.stats.writes;
  const next = create(ingressBinding, dependencies, options); const opening = next.open(); const rejected = assert.rejects(opening, code('incomplete'));
  await eventually(() => clock.pendingTimers > 2); await next.close(); await rejected;
  assert.deepEqual(s.rows.get('M'), before); assert.equal(s.stats.writes, writes); await k.close();
});

test('live renewed foreign ingress M returns busy after one bounded wait instead of extending it', async t => {
  const { s, k, clock, dependencies } = await seeded(t);
  const next = create(ingressBinding, dependencies, options); const opening = next.open(); const rejected = assert.rejects(opening, code('busy'));
  await eventually(() => clock.pendingTimers > 2);
  clock.advance(40000, false); await k.read('M'); const renewed = structuredClone(s.rows.get('M'));
  clock.advance(85001); await rejected; await next.close(); assert.deepEqual(s.rows.get('M'), renewed);
});

test('losing_clear_race_with_lost_ack verifies the winning ingress disposition and preserves one uncertain interval', async t => {
  const { s, j, clock, dependencies } = await opened(t); const p = pair();
  await j.admit(p.event.body!, p.route.route); const grant = await j.claimForForwarding(); assert.ok(grant);
  clock.advance(125001, false); const before = fence(s); const gate = deferred(); let submissions = 0;
  s.controls.hook = async e => {
    if (e.actions[0]?.entity.Operation === 'lease-expiry') {
      const first = ++submissions === 1; if (submissions === 2) gate.resolve(); await gate.promise;
      if (first) { e.commit(); e.res.destroy(); } else e.reply();
    } else e.reply();
  };
  await Promise.all([expire(ingressBinding, dependencies, before), expire(ingressBinding, dependencies, before)]);
  delete s.controls.hook;
  assert.equal(submissions, 2); assert.equal(s.rows.get('M')!.Owner, '');
  assert.equal([...s.rows.values()].filter(r => r.T === 'control' && payload(r).kind === 'lease-expiry-audit').length, 1);
  assert.equal(payload(s.rows.get(rowKey('control', 'generation:1'))!).reason, 'clock-uncertain');
  const next = create(ingressBinding, dependencies, options); await next.open();
  assert.equal(await next.claimForForwarding(), undefined); await next.close(); await assert.rejects(j.close(), code('unresolved'));
});

test('exact ingress expiry boundary cannot clear authority until the strict skew margin has elapsed', async t => {
  const { s, k, clock, dependencies } = await seeded(t); const writes = s.stats.writes;
  clock.advance(125000, false); const before = fence(s);
  await assert.rejects(expire(ingressBinding, dependencies, before), code('busy')); assert.equal(s.stats.writes, writes);
  clock.advance(1, false); await expire(ingressBinding, dependencies, before);
  assert.equal(s.rows.get('M')!.Owner, ''); assert.equal(exit(s).observedAt, 1125001); await assert.rejects(k.close(), code('unresolved'));
});

test('changed M during ingress foreign proof submits no expiry disposition', async t => {
  const { s, k, clock, dependencies } = await seeded(t); clock.advance(125001, false); const before = fence(s); const writes = s.stats.writes;
  const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (!held && e.req.method === 'GET' && !e.path.includes("RowKey='")) { held = true; await gate.promise; } e.reply(); };
  const expiring = expire(ingressBinding, dependencies, before); const rejected = assert.rejects(expiring, code('unresolved'));
  await eventually(() => held); const m = s.rows.get('M')!; s.rows.set('M', { ...m, 'odata.etag': 'W/"999"' }); gate.resolve(); await rejected;
  assert.equal(s.stats.writes, writes); delete s.controls.hook; await assert.rejects(k.close(), code('unresolved'));
});
