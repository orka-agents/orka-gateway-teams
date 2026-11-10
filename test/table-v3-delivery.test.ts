import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as journals from '../src/delivery/table-journal.js';
import * as recoveries from '../src/delivery/table-recovery.js';
import { budget } from './support/owned-audit.js';
import { code, dataEntity, payload, request, rowKey } from './support/table-delivery.js';
import { deferred, eventually, hash, tableBinding, tableService } from './support/table-service.js';
import { changedM3, TestClock } from './support/table-v3.js';
import { disposition } from './support/table-delivery-v2.js';

type Service = Awaited<ReturnType<typeof tableService>>;
const attestation = 'a'.repeat(64);
const auditBudget = () => budget({ maxPages: 100 });
function fence(s: Service) {
  const m = s.rows.get('M')!;
  return { initId: String(m.InitId), initDigest: String(m.InitDigest), owner: String(m.Owner), epoch: Number(m.Epoch),
    mDigest: String(m.Digest), etag: String(m['odata.etag']) };
}
function receipt(s: Service) { return JSON.parse(Buffer.from(String(s.rows.get('M')!.Exit), 'base64').toString()); }
function create(s: Service, clock: TestClock) {
  assert.equal(typeof journals.createTableDeliveryJournalV3, 'function', 'V3 journal must expose audited delivery startup');
  return journals.createTableDeliveryJournalV3(tableBinding, { ...s.dependencies, leaseClock: clock });
}
async function occupied(t: Parameters<typeof tableService>[0]) {
  const s = await tableService(t, 'delivery', 3); const clock = new TestClock();
  const init = create(s, clock); await init.initialize();
  const owner = create(s, clock); t.after(() => owner.close().catch(() => undefined)); await owner.open();
  return { s, clock, owner };
}
async function transition(s: Service, clock: TestClock, kind: 'expiry' | 'operator') {
  if (kind === 'expiry') {
    clock.advance(125001, false);
    await recoveries.expireTableDeliveryV3(tableBinding, { ...s.dependencies, leaseClock: clock }, fence(s), auditBudget());
  } else await recoveries.reclaimTableDeliveryOperatorV3(tableBinding, { ...s.dependencies, leaseClock: clock }, fence(s), auditBudget(), attestation);
}

// A factory that acquires without audited expiry would either remain busy or lose old sending evidence.
test('V3 delivery open expires a crashed owner without attestation and never resends its sending attempt', async t => {
  const { s, clock, owner } = await occupied(t);
  const old = await owner.begin(request); assert.equal(old.kind, 'claimed'); if (old.kind !== 'claimed') return;
  const oldEpoch = Number(s.rows.get('M')!.Epoch); const retained = structuredClone(s.rows.get(rowKey('delivery', request.idempotencyId))!);
  clock.advance(125001, false);
  const next = create(s, clock); t.after(() => next.close().catch(() => undefined)); await next.open();
  assert.equal(s.rows.get('M')!.Epoch, String(oldEpoch + 1));
  const exit = receipt(s); assert.equal(exit.kind, 'lease-expiry'); assert.equal('operatorAttestationDigest' in exit, false);
  const audit = payload(s.rows.get(rowKey('control', `control_lease_expiry:${exit.auditId}`))!);
  assert.equal(audit.kind, 'lease-expiry-audit'); assert.equal('operatorAttestationDigest' in audit, false);
  assert.equal(audit.observedAt, 1125001); assert.equal((audit.lease as { expiresAt: number }).expiresAt, 1120000);
  assert.deepEqual(s.rows.get(rowKey('delivery', request.idempotencyId)), retained);
  assert.deepEqual(await next.begin(request), { kind: 'unknown' });
  assert.equal(await next.settle(old.claim, { kind: 'delivered', providerMessageId: 'late-old-receipt' }), 'stale');
  const fresh = { ...request, idempotencyId: 'fresh', deliveryId: 'fresh-alias' };
  assert.equal((await next.begin(fresh)).kind, 'claimed'); assert.equal(s.stats.violation, false);
});

// Wrong control dispatch, lost historical audits or epoch projection would break one of these chains.
for (const chain of [['expiry', 'expiry'], ['operator', 'expiry'], ['expiry', 'operator']] as const)
  test(`V3 delivery ${chain.join('_then_')} preserves receipts aliases Sessions and audit history`, async t => {
    const { s, clock, owner } = await occupied(t);
    const delivered = await owner.begin(request); assert.equal(delivered.kind, 'claimed'); if (delivered.kind !== 'claimed') return;
    await owner.settle(delivered.claim, { kind: 'delivered', providerMessageId: 'retained-receipt' });
    const uncertain = { ...request, idempotencyId: 'uncertain', deliveryId: 'uncertain-alias' };
    assert.equal((await owner.begin(uncertain)).kind, 'claimed');
    const observation = { sessionDigest: 'b'.repeat(64), originDigest: 'c'.repeat(64) };
    await owner.observeSession(observation);
    const retained = [...s.rows.entries()].filter(([key]) => key !== 'M');
    await transition(s, clock, chain[0]);
    const firstExit = receipt(s); const firstAudit = rowKey('control', `${chain[0] === 'expiry' ? 'control_lease_expiry' : 'control_recovery'}:${firstExit.auditId}`);
    const middle = create(s, clock); t.after(() => middle.close().catch(() => undefined)); await middle.open();
    await transition(s, clock, chain[1]);
    const latestExit = receipt(s); assert.equal(latestExit.kind, chain[1] === 'expiry' ? 'lease-expiry' : 'operator-recovery');
    assert.equal(s.rows.has(firstAudit), true); assert.equal([...s.rows.keys()].filter(k => k.startsWith('control_')).length, 3);
    for (const [key, row] of retained) assert.deepEqual(s.rows.get(key), row);
    const next = create(s, clock); t.after(() => next.close().catch(() => undefined)); await next.open();
    assert.deepEqual(await next.begin({ ...request, deliveryId: 'new-receipt-alias' }), { kind: 'delivered', providerMessageId: 'retained-receipt' });
    assert.deepEqual(await next.begin(uncertain), { kind: 'unknown' });
    assert.deepEqual(await next.observeSession({ ...observation, originDigest: 'd'.repeat(64) }), { kind: 'observed', continuation: true });
    await next.close(); const reopen = create(s, clock); await reopen.open(); await reopen.close();
    assert.equal(s.stats.violation, false);
  });

// Without an acquire-boundary commitment check a valid unrelated row rollback becomes the next baseline.
for (const nextKind of ['expiry', 'operator'] as const) test(`V3 delivery later ${nextKind} rechecks predecessor expiry commitment before writes`, async t => {
  const { s, clock, owner } = await occupied(t);
  const claim = await owner.begin(request); assert.equal(claim.kind, 'claimed'); if (claim.kind !== 'claimed') return;
  await owner.settle(claim.claim, { kind: 'delivered', providerMessageId: 'receipt-before-expiry' });
  await owner.observeSession({ sessionDigest: 'b'.repeat(64), originDigest: 'c'.repeat(64) });
  await transition(s, clock, 'expiry');
  const acquired = create(s, clock); t.after(() => acquired.close().catch(() => undefined)); await acquired.open();
  const key = rowKey('delivery', request.idempotencyId);
  s.rows.set(key, dataEntity('delivery', request.idempotencyId, { ...payload(s.rows.get(key)!), state: 'rejected', providerMessageId: null }));
  const before = structuredClone(s.rows.get('M')); const writes = s.stats.writes;
  await assert.rejects(transition(s, clock, nextKind));
  assert.deepEqual(s.rows.get('M'), before); assert.equal(s.stats.writes, writes);
});

// Legitimate mutation ends the acquisition snapshot; Exit is history, not a forever-current fold.
test('V3 delivery expiry after owner mutation validates current graph rather than stale acquisition commitment', async t => {
  const { s, clock, owner } = await occupied(t); await owner.begin(request);
  await transition(s, clock, 'expiry');
  const middle = create(s, clock); t.after(() => middle.close().catch(() => undefined)); await middle.open();
  assert.equal((await middle.begin({ ...request, idempotencyId: 'new', deliveryId: 'new-alias' })).kind, 'claimed');
  await transition(s, clock, 'expiry');
  const next = create(s, clock); t.after(() => next.close().catch(() => undefined)); await next.open();
  assert.deepEqual(await next.begin(request), { kind: 'unknown' }); assert.equal(s.stats.violation, false);
});

// Strict E+S prevents an automatic clear at equality; manual recovery is allowed with real attestation.
test('V3 delivery expiry refuses the exact safe boundary while manual recovery accepts termination evidence', async t => {
  const { s, clock } = await occupied(t); clock.advance(125000, false);
  const before = structuredClone(s.rows.get('M')); const writes = s.stats.writes;
  await assert.rejects(recoveries.expireTableDeliveryV3(tableBinding, { ...s.dependencies, leaseClock: clock }, fence(s), auditBudget()));
  assert.deepEqual(s.rows.get('M'), before); assert.equal(s.stats.writes, writes);
  await transition(s, clock, 'operator');
  assert.equal(receipt(s).operatorAttestationDigest, attestation); assert.equal(s.stats.violation, false);
});

// No clean release may discharge an owner whose retained expiry evidence fails its startup proof.
test('V3 delivery missing expiry audit poisons acquired startup without a clean release', async t => {
  const { s, clock } = await occupied(t); await transition(s, clock, 'expiry');
  const exit = receipt(s); s.rows.delete(rowKey('control', `control_lease_expiry:${exit.auditId}`));
  const next = create(s, clock); await assert.rejects(next.open(), code('corrupt')); await next.close().catch(() => undefined);
  assert.notEqual(s.rows.get('M')!.Owner, ''); assert.equal(receipt(s).kind, 'lease-expiry');
});

// A persisted domain proof is independently checked rather than merely trusting its post-write fold.
test('V3 delivery expiry receipt commits the full retained data fold including its new audit', async t => {
  const { s, clock, owner } = await occupied(t); await owner.begin(request);
  const before = fence(s); const original = s.rows.get('M')!; await transition(s, clock, 'expiry');
  const m = s.rows.get('M')!; const exit = receipt(s);
  const row = s.rows.get(rowKey('control', `control_lease_expiry:${exit.auditId}`))!; const audit = payload(row);
  assert.equal(exit.oldOwner, before.owner); assert.equal(exit.originalMDigest, before.mDigest);
  assert.equal(exit.auditDigest, row.Digest); assert.equal(m.State, original.State); assert.equal(m.Result, original.Result);
  const rows = [...s.rows.entries()].filter(([key]) => key !== 'M').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  let fold = hash(['orka-recovery-data-v2', m.Binding]); let pre = fold;
  for (const [key, value] of rows) {
    fold = hash(['orka-recovery-row-v2', fold, key, value.Digest]);
    if (value !== row) pre = hash(['orka-recovery-row-v2', pre, key, value.Digest]);
  }
  const commit = (h: string, count: number) => hash(['orka-delivery-recovery-v2', m.Binding, m.State, m.Result,
    hash(['orka-recovery-data-end-v2', h, count]), count, 'epoch-restart']);
  assert.equal(exit.domainDispositionDigest, commit(fold, rows.length));
  assert.equal(audit.dispositionDigest, commit(pre, rows.length - 1)); assert.equal(s.stats.violation, false);
});

// A renewed scan header must remain domain-valid even after several page-boundary renewals.
test('V3 delivery startup scan renews without changing acquire evidence or Session capacity', async t => {
  const { s, clock, owner } = await occupied(t);
  await owner.observeSession({ sessionDigest: 'b'.repeat(64), originDigest: 'c'.repeat(64) }); await owner.close();
  let pages = 0;
  s.controls.hook = e => { e.reply(); if (e.req.method === 'GET' && !e.path.includes("RowKey='")) { pages++; clock.advance(30000, false); } };
  const next = create(s, clock); t.after(() => next.close().catch(() => undefined)); await next.open(); delete s.controls.hook;
  assert.equal(pages >= 2, true); assert.equal(s.rows.get('M')!.Operation, 'acquire'); assert.equal(next.leaseAuthority().allowed(), true);
  assert.deepEqual(await next.observeSession({ sessionDigest: 'b'.repeat(64), originDigest: 'd'.repeat(64) }), { kind: 'observed', continuation: true });
});

// Close must cancel the wait outside the kernel queue, rather than awaiting a foreign lease timeout.
test('V3 delivery close aborts a live foreign lease wait without acquiring or clearing', async t => {
  const { s, clock } = await occupied(t); const before = structuredClone(s.rows.get('M')); const writes = s.stats.writes;
  const timers = clock.pendingTimers;
  const next = create(s, clock); const opening = next.open(); const rejected = assert.rejects(opening, code('closed'));
  await eventually(() => clock.pendingTimers > timers);
  await next.close(); await rejected;
  assert.deepEqual(s.rows.get('M'), before); assert.equal(s.stats.writes, writes); assert.equal(next.status().lifecycle, 'closed');
  assert.equal(clock.pendingTimers, timers);
});

// Close after the wait but during acquire's first read cannot acquire and then fabricate a clean audited exit.
test('V3 delivery close during initial acquisition read never acquires or cleanly releases an unaudited graph', async t => {
  const { s, clock, owner } = await occupied(t); await owner.close();
  const before = structuredClone(s.rows.get('M')); const writes = s.stats.writes;
  const held = deferred(); const release = deferred(); let reads = 0;
  s.controls.hook = async e => {
    if (e.req.method === 'GET' && e.path.includes("RowKey='M'") && ++reads === 2) { held.resolve(); await release.promise; }
    e.reply();
  };
  const next = create(s, clock); const opening = assert.rejects(next.open(), code('closed'));
  await held.promise; const closing = next.close().catch(() => undefined); release.resolve();
  await Promise.all([opening, closing]); delete s.controls.hook;
  assert.deepEqual(s.rows.get('M'), before); assert.equal(s.stats.writes, writes);
});

// A missing manual statement must not select automatic expiry just because time has passed.
test('V3 delivery manual recovery never substitutes expiry for a missing operator attestation', async t => {
  const { s, clock } = await occupied(t); clock.advance(125001, false);
  const before = structuredClone(s.rows.get('M')); const writes = s.stats.writes;
  await assert.rejects(recoveries.reclaimTableDeliveryOperatorV3(tableBinding, { ...s.dependencies, leaseClock: clock },
    fence(s), auditBudget(), undefined as unknown as string));
  assert.deepEqual(s.rows.get('M'), before); assert.equal(s.stats.writes, writes);
});

// Manual proof is independent of the lease expiry; it retains the real private statement digest.
test('V3 delivery manual recovery can clear a live lease with termination attestation', async t => {
  const { s, clock } = await occupied(t); await transition(s, clock, 'operator');
  assert.equal(receipt(s).kind, 'operator-recovery'); assert.equal(receipt(s).operatorAttestationDigest, attestation);
  const next = create(s, clock); await next.open(); await next.close(); assert.equal(s.stats.violation, false);
});

// A later foreign renewal ends the single wait rather than extending it or adopting a stale fence.
test('V3 delivery live foreign lease wait returns busy on renewed M without clearing it', async t => {
  const { s, clock } = await occupied(t); const timers = clock.pendingTimers;
  const next = create(s, clock); const opening = next.open(); const rejected = assert.rejects(opening, code('busy'));
  await eventually(() => clock.pendingTimers > timers);
  const m = s.rows.get('M')!; const lease = JSON.parse(Buffer.from(String(m.Lease), 'base64').toString());
  const renewed = changedM3(m, { Lease: Buffer.from(JSON.stringify({ ...lease, sequence: lease.sequence + 1, expiresAt: lease.expiresAt + 40000 })).toString('base64') });
  s.rows.set('M', renewed); const writes = s.stats.writes; clock.advance(125001);
  await rejected; await next.close(); assert.deepEqual(s.rows.get('M'), renewed); assert.equal(s.stats.writes, writes);
});

// Re-signing the post-transition snapshot cannot hide a false pre-transition disposition inside its audit.
test('V3 delivery startup verifies the expiry audit pre-disposition as well as the post-data fold', async t => {
  const { s, clock, owner } = await occupied(t); await owner.begin(request); await transition(s, clock, 'expiry');
  const m = s.rows.get('M')!; const exit = receipt(s); const id = `control_lease_expiry:${exit.auditId}`; const key = rowKey('control', id);
  s.rows.set(key, dataEntity('control', id, { ...payload(s.rows.get(key)!), dispositionDigest: 'f'.repeat(64) }));
  exit.auditDigest = s.rows.get(key)!.Digest; exit.domainDispositionDigest = disposition(s);
  s.rows.set('M', changedM3(m, { Exit: Buffer.from(JSON.stringify(exit)).toString('base64') }));
  const next = create(s, clock); await assert.rejects(next.open(), code('corrupt')); await next.close().catch(() => undefined);
  assert.notEqual(s.rows.get('M')!.Owner, '');
});
