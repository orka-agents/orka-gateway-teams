import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditInbox, createInboxAuditProjection } from '../src/ingress/table-audit.js';
import { InboxIndex } from '../src/ingress/table-index.js';
import { digest, encode } from '../src/ingress/codec.js';
import { createTableIngressStore } from '../src/ingress/table-store.js';
import { encodeState } from '../src/ingress/table-codec.js';
import { stateDigest } from '../src/ingress/table-result.js';
import { bindTable, decodeObjectV2 } from '../src/storage/table/codec.js';
import type { StoredRecordV2 } from '../src/storage/table/types.js';
import { reclaimTableIngress } from '../src/ingress/table-recovery.js';
import { createTableKernelV2, TableError } from '../src/storage/table/index.js';
import { options } from './support/table-ingress-store.js';
import { hash, ingressBinding } from './support/table-service.js';
import { auditBudget, inboxOwned, indexBudget, install, pair, wireData } from './support/table-ingress-audit.js';
import { armId, attemptId, sealFixture, stateFixture } from './support/table-ingress.js';
import { changedM2 } from './support/table-v2.js';

const code = (want: string) => (e: unknown) => e instanceof TableError && e.code === want;
const auditKey = (invocation: string) => `control_recovery:${invocation}`;
const auditRow = (invocation: string) => 'control_' + Buffer.from(auditKey(invocation)).toString('base64url');
const forgedInvocation = '88888888-8888-4888-8888-888888888888';
const forgedAudit = (oldEpoch: number) => encode({ schema: 1, kind: 'operator-recovery-audit', invocation: forgedInvocation,
  oldOwner: '99999999-9999-4999-8999-999999999999', oldEpoch, originalMDigest: 'a'.repeat(64),
  dispositionDigest: 'b'.repeat(64), operatorAttestationDigest: 'c'.repeat(64) });
function auditUnowned(s: Awaited<ReturnType<typeof inboxOwned>>['s']): void {
  const binding = ingressBinding;
  if (binding.kind !== 'ingress') throw new Error('ingress fixture required');
  const bound = bindTable(binding);
  const rows = [...s.rows.values()].map(raw => decodeObjectV2(bound, raw))
    .sort((a, b) => a.row === 'M' ? -1 : b.row === 'M' ? 1 : a.row < b.row ? -1 : a.row > b.row ? 1 : 0);
  const projection = createInboxAuditProjection(binding, new InboxIndex(indexBudget));
  try {
    for (const pass of [1, 2] as const) {
      for (const row of rows) projection.visitor.record(pass, row);
      projection.visitor.endPass(pass);
    }
    projection.visitor.finalize();
    assert.equal(projection.result().header.metadata.owner, '');
  } finally { projection.dispose(); }
}
const fence = (m: StoredRecordV2) => {
  if (m.value.kind !== 'metadata') throw new Error('M expected');
  return { initId: m.value.initId, initDigest: m.value.initDigest, owner: m.value.owner,
    epoch: m.value.epoch, mDigest: m.value.digest, etag: m.etag };
};

test('reclaim releases the first inbox index before building the second proof', async t => {
  const { s, k } = await inboxOwned(t); const m = await k.read('M'); assert.ok(m);
  const dispose = InboxIndex.prototype.dispose; let disposed = 0; let inspectedSecond = false;
  InboxIndex.prototype.dispose = function () { disposed++; dispose.call(this); };
  t.after(() => { InboxIndex.prototype.dispose = dispose; });
  let pages = 0;
  s.controls.hook = event => {
    if (event.req.method === 'GET' && !event.path.includes("RowKey='")) {
      pages++;
      if (pages === 3) { inspectedSecond = true; assert.ok(disposed > 0, 'first index released before the second inspection'); }
    }
    event.reply();
  };
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64));
  assert.equal(inspectedSecond, true); delete s.controls.hook;
  await assert.rejects(k.close(), code('unresolved'));
});

test('inbox recovery refuses a budget too small to retain the disposition across proofs', async t => {
  const { s, k } = await inboxOwned(t); const m = await k.read('M'); assert.ok(m);
  const writes = s.stats.writes;
  await assert.rejects(reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget,
    4 * 1024 * 1024, 'd'.repeat(64)), code('incomplete'));
  assert.equal(s.stats.writes, writes); assert.equal([...s.rows.keys()].filter(row => row.startsWith('control_')).length, 0);
  await k.close();
});

test('foreign unarmed inbox recovery retains rows, adds data-free audit, and next ordinary open can audit', async t => {
  const { s, k } = await inboxOwned(t); const entry = pair();
  await install(k, { state: stateFixture(), pairs: [entry] });
  const m = await k.read('M'); assert.ok(m);
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64));
  auditUnowned(s); // Recovery writes the audit at exactly this unowned M epoch.
  const recovered = s.rows.get('M')!; assert.equal(recovered.Operation, 'recover');
  assert.equal(recovered.Owner, ''); assert.equal(recovered.Epoch, String(fence(m).epoch));
  const x = JSON.parse(Buffer.from(String(recovered.Exit), 'base64').toString());
  const audit = s.rows.get('control_' + Buffer.from(`control_recovery:${x.auditId}`).toString('base64url'))!;
  assert.ok(audit); assert.equal(x.auditDigest, audit.Digest);
  assert.equal(x.operatorAttestationDigest, 'd'.repeat(64));
  const payload = Buffer.from(String(audit.B0), 'base64').toString();
  assert.equal(payload.includes('Synthetic inbox text'), false);
  assert.equal(payload.includes(entry.id), false);
  assert.equal([...s.rows.keys()].filter(key => key.startsWith('event_')).length, 1);
  const next = createTableKernelV2(ingressBinding, s.dependencies); await next.acquire();
  const audited = await auditInbox(next, ingressBinding, auditBudget, indexBudget);
  assert.equal(audited.index.diagnostics().events, 1);
  assert.equal(audited.header.state.handoffClockArm, null);
  audited.dispose(); await next.close(); await assert.rejects(k.close(), code('unresolved'));
});

test('armed handoff seals its active generation, clears arm without a clock sample, and cannot resend on next open', async t => {
  const { s, k } = await inboxOwned(t); const p = pair();
  p.event.state = 'forwarding'; p.event.attempt = 1; p.event.attemptId = attemptId; p.event.attemptEpoch = 1;
  const before = stateFixture();
  const state = stateFixture({ handoffClockArm: { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId } });
  const result = { schema: 1 as const, operation: 'claim' as const, epoch: 1,
    basis: { records: before.records, bodies: before.bodies, lastNow: before.lastNow, restartEpoch: before.restartEpoch,
      currentGeneration: before.currentGeneration, arm: null }, clock: { time: 100 },
    decision: { kind: 'claimed' as const, eventId: p.id, attemptId, attempt: 1 },
    postStateDigest: stateDigest(bindTable(ingressBinding), encodeState(state)) };
  await install(k, { state, pairs: [p], result });
  const m = await k.read('M'); assert.ok(m);
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64));
  auditUnowned(s);
  const recovered = JSON.parse(Buffer.from(String(s.rows.get('M')!.State), 'base64').toString());
  assert.equal(recovered.handoffClockArm, null); assert.equal(recovered.currentGeneration, null);
  assert.equal(recovered.lastNow, 100); assert.equal(recovered.bodies, 1);
  const sealed = s.rows.get('control_' + Buffer.from('generation:1').toString('base64url'))!;
  const seal = JSON.parse(Buffer.from(String(sealed.B0), 'base64').toString());
  assert.equal(seal.reason, 'clock-uncertain'); assert.equal(seal.observation, null);
  assert.equal(seal.epoch, 1); assert.equal(s.stats.lastActions, 3);
  const next = createTableIngressStore(ingressBinding, s.dependencies, options);
  await next.open(); assert.equal(await next.claimForForwarding(), undefined);
  await next.close(); await assert.rejects(k.close(), code('unresolved'));
});

for (const [oldEpoch, guard] of [[3, 'existing > guard'], [2, 'new equality guard']] as const) test(`acquired M rejects a forged recovery audit at epoch ${oldEpoch} (${guard})`, async t => {
  const { s, k } = await inboxOwned(t);
  await install(k, { state: stateFixture(), pairs: [pair()] }); await k.close();
  const next = createTableKernelV2(ingressBinding, s.dependencies); await next.acquire();
  assert.equal(s.rows.get('M')!.Epoch, '2');
  s.rows.set(auditRow(forgedInvocation), wireData(s, 'control', auditKey(forgedInvocation), forgedAudit(oldEpoch)));
  await assert.rejects(auditInbox(next, ingressBinding, auditBudget, indexBudget), code('unresolved'));
  await assert.rejects(next.close(), code('unresolved'));
});

test('ordinary startup rejects a forged audit at its clean-release Exit epoch', async t => {
  const { s, k } = await inboxOwned(t);
  await install(k, { state: stateFixture(), pairs: [pair()] }); await k.close();
  assert.equal(JSON.parse(Buffer.from(String(s.rows.get('M')!.Exit), 'base64').toString()).oldEpoch, 1);
  s.rows.set(auditRow(forgedInvocation), wireData(s, 'control', auditKey(forgedInvocation), forgedAudit(1)));
  const next = createTableIngressStore(ingressBinding, s.dependencies, options);
  await assert.rejects(next.open(), code('unresolved'));
  await assert.rejects(next.close(), code('unresolved'));
});

test('current operator Exit refuses a coherent rewrite of only the audit disposition digest', async t => {
  const { s, k } = await inboxOwned(t); const m = await k.read('M'); assert.ok(m);
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64));
  const owned = s.rows.get('M')!;
  const exit = JSON.parse(Buffer.from(String(owned.Exit), 'base64').toString());
  const key = auditKey(exit.auditId);
  const row = auditRow(exit.auditId);
  const audit = JSON.parse(Buffer.from(String(s.rows.get(row)!.B0), 'base64').toString());
  audit.dispositionDigest = 'f'.repeat(64);
  s.rows.set(row, wireData(s, 'control', key, encode(audit)));
  let fold = hash(['orka-recovery-data-v2', owned.Binding]); let count = 0;
  for (const [name, data] of [...s.rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) if (name !== 'M') {
    fold = hash(['orka-recovery-row-v2', fold, name, data.Digest]); count++;
  }
  const result = JSON.parse(Buffer.from(String(owned.Result), 'base64').toString());
  result.postDataDigest = hash(['orka-recovery-data-end-v2', fold, count]);
  assert.equal(result.dataRowCount, count);
  const resultBase64 = encode(result).toString('base64');
  exit.auditDigest = s.rows.get(row)!.Digest;
  exit.domainDispositionDigest = hash(['orka-inbox-recovery-v2', owned.Binding, resultBase64]);
  const plan = hash(['recover', exit.originalMDigest, exit.invocation, exit.auditDigest, exit.domainDispositionDigest,
    owned.State, resultBase64, null]);
  exit.planDigest = plan;
  s.rows.set('M', changedM2(owned, { Result: resultBase64, Exit: encode(exit).toString('base64'), Plan: plan }, 985));
  const next = createTableKernelV2(ingressBinding, s.dependencies); await next.acquire();
  await assert.rejects(auditInbox(next, ingressBinding, auditBudget, indexBudget), code('unresolved'));
  await assert.rejects(next.close(), code('unresolved')); await assert.rejects(k.close(), code('unresolved'));
});

test('recovered armed inbox rejects a forged regression seal despite coherent result and M digests', async t => {
  const { s, k } = await inboxOwned(t); const p = pair();
  Object.assign(p.event, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  const before = stateFixture();
  const state = stateFixture({ handoffClockArm: { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId } });
  const claim = { schema: 1 as const, operation: 'claim' as const, epoch: 1,
    basis: { records: before.records, bodies: before.bodies, lastNow: before.lastNow, restartEpoch: before.restartEpoch,
      currentGeneration: before.currentGeneration, arm: null }, clock: { time: 100 },
    decision: { kind: 'claimed' as const, eventId: p.id, attemptId, attempt: 1 },
    postStateDigest: stateDigest(bindTable(ingressBinding), encodeState(state)) };
  await install(k, { state, pairs: [p], result: claim });
  const m = await k.read('M'); assert.ok(m);
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64));
  auditUnowned(s); // Genuine created-seal commitment is accepted before tampering.

  const owned = s.rows.get('M')!;
  const exit = JSON.parse(Buffer.from(String(owned.Exit), 'base64').toString());
  const auditPayload = String(s.rows.get(auditRow(exit.auditId))!.B0);
  const sealKey = 'generation:1';
  const sealRow = 'control_' + Buffer.from(sealKey).toString('base64url');
  const original = JSON.parse(Buffer.from(String(s.rows.get(sealRow)!.B0), 'base64').toString());
  assert.equal(original.reason, 'clock-uncertain'); assert.equal(original.observation, null);
  assert.ok(original.watermark > 0);
  const forged = encode({ ...original, observation: original.watermark - 1, reason: 'clock-regression' });
  assert.notEqual(forged.toString('base64'), String(s.rows.get(sealRow)!.B0));
  s.rows.set(sealRow, wireData(s, 'control', sealKey, forged));

  let fold = hash(['orka-recovery-data-v2', owned.Binding]); let count = 0;
  for (const [name, data] of [...s.rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) if (name !== 'M') {
    fold = hash(['orka-recovery-row-v2', fold, name, data.Digest]); count++;
  }
  const result = JSON.parse(Buffer.from(String(owned.Result), 'base64').toString());
  result.postDataDigest = hash(['orka-recovery-data-end-v2', fold, count]);
  assert.equal(result.dataRowCount, count);
  const resultBase64 = encode(result).toString('base64');
  exit.domainDispositionDigest = hash(['orka-inbox-recovery-v2', owned.Binding, resultBase64]);
  const plan = hash(['recover', exit.originalMDigest, exit.invocation, exit.auditDigest, exit.domainDispositionDigest,
    owned.State, resultBase64, [sealKey, forged.toString('base64')]]);
  exit.planDigest = plan;
  s.rows.set('M', changedM2(owned, { Result: resultBase64, Exit: encode(exit).toString('base64'), Plan: plan }, 986));
  assert.equal(s.rows.get(auditRow(exit.auditId))!.B0, auditPayload);
  assert.throws(() => auditUnowned(s), code('corrupt'));
  await assert.rejects(k.close(), code('unresolved'));
});

test('current operator Exit refuses a digest-mismatched audit row on the next owned audit', async t => {
  const { s, k } = await inboxOwned(t); const m = await k.read('M'); assert.ok(m);
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64));
  const x = JSON.parse(Buffer.from(String(s.rows.get('M')!.Exit), 'base64').toString());
  const key = `control_recovery:${x.auditId}`;
  const row = 'control_' + Buffer.from(key).toString('base64url');
  const value = JSON.parse(Buffer.from(String(s.rows.get(row)!.B0), 'base64').toString());
  value.operatorAttestationDigest = 'a'.repeat(64);
  s.rows.set(row, wireData(s, 'control', key, Buffer.from(JSON.stringify(value))));
  const next = createTableKernelV2(ingressBinding, s.dependencies); await next.acquire();
  await assert.rejects(auditInbox(next, ingressBinding, auditBudget, indexBudget), code('unresolved'));
  await assert.rejects(next.close(), code('unresolved')); await assert.rejects(k.close(), code('unresolved'));
});

test('operator Exit cannot drop its audit reference while the matching audit row remains', async t => {
  const { s, k } = await inboxOwned(t); const m = await k.read('M'); assert.ok(m);
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64));
  const owned = s.rows.get('M')!;
  const exit = JSON.parse(Buffer.from(String(owned.Exit), 'base64').toString());
  delete exit.auditId; delete exit.auditDigest;
  s.rows.set('M', changedM2(owned, { Exit: Buffer.from(JSON.stringify(exit)).toString('base64') }, 984));
  const next = createTableKernelV2(ingressBinding, s.dependencies); await next.acquire();
  await assert.rejects(auditInbox(next, ingressBinding, auditBudget, indexBudget), code('unresolved'));
  await assert.rejects(next.close(), code('unresolved')); await assert.rejects(k.close(), code('unresolved'));
});

test('ordinary clean release replaces Exit but keeps append-only audit as data, not a generation seal', async t => {
  const { s, k } = await inboxOwned(t); const p = pair(); await install(k, { state: stateFixture(), pairs: [p] });
  const m = await k.read('M'); assert.ok(m);
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64));
  const auditRows = [...s.rows.keys()].filter(key => key.startsWith('control_'));
  assert.equal(auditRows.length, 1);
  const first = createTableIngressStore(ingressBinding, s.dependencies, options);
  await first.open(); await first.close();
  const exit = JSON.parse(Buffer.from(String(s.rows.get('M')!.Exit), 'base64').toString());
  assert.equal(exit.kind, 'clean-release'); assert.ok(s.rows.has(auditRows[0]!));
  const again = createTableIngressStore(ingressBinding, s.dependencies, options);
  await again.open(); assert.equal(again.status().lifecycle, 'ready'); await again.close();
  await assert.rejects(k.close(), code('unresolved'));
});

test('a zombie cannot mutate or recover the same old fence after a completed domain reclaim', async t => {
  const { s, k } = await inboxOwned(t); const m = await k.read('M'); assert.ok(m);
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64));
  const rows = [...s.rows.keys()].sort();
  await assert.rejects(k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state: Buffer.alloc(0), result: Buffer.alloc(0), actions: [] })), code('unresolved'));
  await assert.rejects(reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64)), code('unresolved'));
  assert.deepEqual([...s.rows.keys()].sort(), rows); await assert.rejects(k.close(), code('unresolved'));
});

test('armed handoff with an already proved regression preserves its original seal and still clears the arm', async t => {
  const { s, k } = await inboxOwned(t); const p = pair();
  Object.assign(p.event, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  const arm = { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId };
  const prior = stateFixture({ lastNow: 150, handoffClockArm: arm });
  const state = stateFixture({ lastNow: 150, currentGeneration: null, handoffClockArm: arm });
  const seal = sealFixture({ epoch: 1, watermark: 150, observation: 140 });
  const result = { schema: 1 as const, operation: 'revalidate' as const, epoch: 1,
    basis: { records: prior.records, bodies: prior.bodies, lastNow: prior.lastNow, restartEpoch: 1,
      currentGeneration: prior.currentGeneration, arm }, clock: { time: 140 },
    decision: { armId, eligible: false }, postStateDigest: stateDigest(bindTable(ingressBinding), encodeState(state)) };
  await install(k, { state, pairs: [p], seals: [seal], result });
  const m = await k.read('M'); assert.ok(m);
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64));
  auditUnowned(s);
  const recovered = JSON.parse(Buffer.from(String(s.rows.get('M')!.State), 'base64').toString());
  assert.equal(recovered.handoffClockArm, null); assert.equal(recovered.currentGeneration, null);
  const sealed = s.rows.get('control_' + Buffer.from('generation:1').toString('base64url'))!;
  const installedSeal = JSON.parse(Buffer.from(String(sealed.B0), 'base64').toString());
  assert.equal(installedSeal.reason, 'clock-regression'); assert.equal(installedSeal.observation, 140);
  assert.equal(s.stats.lastActions, 2);
  const next = createTableIngressStore(ingressBinding, s.dependencies, options);
  await next.open(); assert.equal(await next.claimForForwarding(), undefined); await next.close();
  await assert.rejects(k.close(), code('unresolved'));
});

test('operator at later acquired epoch quarantines an older retained arm without rewriting restart epoch', async t => {
  const { s, k } = await inboxOwned(t); const p = pair();
  Object.assign(p.event, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  const armed = stateFixture({ handoffClockArm: { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId } });
  const before = stateFixture();
  const result = { schema: 1 as const, operation: 'claim' as const, epoch: 1,
    basis: { records: before.records, bodies: before.bodies, lastNow: before.lastNow, restartEpoch: 1,
      currentGeneration: before.currentGeneration, arm: null }, clock: { time: 100 },
    decision: { kind: 'claimed' as const, eventId: p.id, attemptId, attempt: 1 },
    postStateDigest: stateDigest(bindTable(ingressBinding), encodeState(armed)) };
  await install(k, { state: armed, pairs: [p], result }); await k.close();
  const zombie = createTableKernelV2(ingressBinding, s.dependencies); await zombie.acquire();
  const m = await zombie.read('M'); assert.ok(m); assert.equal(fence(m).epoch, 2);
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64));
  const recovered = JSON.parse(Buffer.from(String(s.rows.get('M')!.State), 'base64').toString());
  assert.equal(recovered.restartEpoch, 1); assert.equal(recovered.handoffClockArm, null);
  const sealed = s.rows.get('control_' + Buffer.from('generation:1').toString('base64url'))!;
  assert.equal(JSON.parse(Buffer.from(String(sealed.B0), 'base64').toString()).epoch, 2);
  const next = createTableIngressStore(ingressBinding, s.dependencies, options);
  await next.open(); assert.equal(await next.claimForForwarding(), undefined); await next.close();
  await assert.rejects(zombie.close(), code('unresolved'));
});

test('rejects missing or malformed explicit operator attestation before foreign inspection or writes', async t => {
  const { s, k } = await inboxOwned(t); const m = await k.read('M'); assert.ok(m);
  const writes = s.stats.writes;
  await assert.rejects(reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, undefined as never), code('invalid-input'));
  await assert.rejects(reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'INVALID'), code('invalid-input'));
  assert.equal(s.stats.writes, writes); await k.close();
});

test('captures the exact foreign fence before asynchronous inspection, not caller mutations', async t => {
  const { s, k } = await inboxOwned(t); const m = await k.read('M'); assert.ok(m);
  const input = fence(m);
  const reclaim = reclaimTableIngress(ingressBinding, s.dependencies, input, auditBudget, indexBudget, 'd'.repeat(64));
  input.mDigest = 'a'.repeat(64);
  await reclaim;
  assert.equal(s.rows.get('M')!.Operation, 'recover'); await assert.rejects(k.close(), code('unresolved'));
});

test('complete domain proof changing between initial and reclaim audits forbids recovery write', async t => {
  const { s, k } = await inboxOwned(t); const p = pair();
  await install(k, { state: stateFixture(), pairs: [p] }); const m = await k.read('M'); assert.ok(m);
  const writes = s.stats.writes; let reads = 0;
  s.controls.hook = e => {
    if (e.req.method === 'GET' && e.path.includes(",RowKey='M'") && ++reads === 5) {
      const row = 'route_' + Buffer.from(p.target).toString('base64url');
      const altered = { ...p.route, route: { ...p.route.route, serviceUrl: 'https://changed.example.invalid/' } };
      altered.routeDigest = digest(encode(altered.route));
      s.rows.set(row, wireData(s, 'route', p.target, encode(altered)));
    }
    e.reply();
  };
  await assert.rejects(reclaimTableIngress(ingressBinding, s.dependencies, fence(m), auditBudget, indexBudget, 'd'.repeat(64)), code('unresolved'));
  assert.equal(reads >= 5, true); assert.equal(s.stats.writes, writes);
  assert.equal(s.rows.get('M')!.Operation, 'mutate');
  delete s.controls.hook; await k.close();
});
