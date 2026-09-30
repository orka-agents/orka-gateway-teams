import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableKernelV2, TableError } from '../src/storage/table/index.js';
import { createTableOperatorReclaimerV2 } from '../src/storage/table/recovery.js';
import { budget } from './support/owned-audit.js';
import { deferred, eventually, hash, ingressBinding, tableBinding, tableService } from './support/table-service.js';

const code = (want: string) => (e: unknown) => e instanceof TableError && e.code === want && !('cause' in e);
const disposition = () => ({ state: Buffer.alloc(0), dispositionDigest: 'b'.repeat(64), operatorAttestationDigest: 'd'.repeat(64),
  complete: (_summary: { postDataDigest: string; dataRowCount: number; auditId: string; auditDigest: string }) =>
    ({ result: Buffer.alloc(0), domainDispositionDigest: 'c'.repeat(64) }) });
async function occupied(t: Parameters<typeof tableService>[0]) {
  const s = await tableService(t, 'delivery', 2);
  const zombie = createTableKernelV2(tableBinding, s.dependencies);
  await zombie.initialize(); await zombie.acquire();
  const record = await zombie.read('M');
  if (!record || record.value.kind !== 'metadata') throw new Error('fixture M');
  const m = record.value;
  const fence = { initId: m.initId, initDigest: m.initDigest, owner: m.owner, epoch: m.epoch, mDigest: m.digest, etag: record.etag };
  const visitor = { passes: 2 as const, record(): undefined {}, endPass(): undefined {}, finalize(): undefined {} };
  return { s, zombie, fence, visitor };
}

test('native reclaim atomically empties M at same epoch and creates a separate bound audit row; next ordinary owner advances epoch', async t => {
  const { s, zombie, fence, visitor } = await occupied(t);
  const reclaimer = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  await reclaimer.reclaim(visitor, budget(), disposition());
  const m = s.rows.get('M')!; assert.equal(m.Operation, 'recover'); assert.equal(m.Owner, ''); assert.equal(m.Epoch, String(fence.epoch));
  const exit = JSON.parse(Buffer.from(String(m.Exit), 'base64').toString());
  assert.equal(exit.kind, 'operator-recovery'); assert.equal(exit.oldOwner, fence.owner); assert.equal(exit.originalMDigest, fence.mDigest);
  assert.equal(exit.oldEpoch, fence.epoch); assert.equal(exit.operatorAttestationDigest, 'd'.repeat(64));
  const row = 'control_' + Buffer.from(`control_recovery:${exit.auditId}`).toString('base64url');
  const audit = s.rows.get(row)!; assert.ok(audit); assert.equal(exit.auditDigest, audit.Digest);
  const payload = JSON.parse(Buffer.from(String(audit.B0), 'base64').toString());
  assert.deepEqual(payload, { schema: 1, kind: 'operator-recovery-audit', invocation: exit.invocation, oldOwner: fence.owner, oldEpoch: fence.epoch,
    originalMDigest: fence.mDigest, dispositionDigest: 'b'.repeat(64), operatorAttestationDigest: 'd'.repeat(64) });
  assert.equal(s.stats.lastActions, 2); assert.equal(s.stats.violation, false);
  await reclaimer.close();
  const next = createTableKernelV2(tableBinding, s.dependencies); await next.acquire();
  assert.equal(s.rows.get('M')!.Epoch, String(fence.epoch + 1)); assert.ok(s.rows.has(row));
  assert.equal(s.rows.get('M')!.Exit, m.Exit);
  await assert.rejects(zombie.close(), code('unresolved'));
  await next.close(); assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});

test('storage computes post-write commitment including the separate audit row before domain finalization', async t => {
  const { s, zombie, fence, visitor } = await occupied(t);
  let called = 0;
  const dispositionWithCommitment = { ...disposition(), complete(summary: { postDataDigest: string; dataRowCount: number; auditId: string; auditDigest: string }) {
    called++;
    assert.equal(summary.dataRowCount, 1);
    const auditRow = `control_${Buffer.from(`control_recovery:${summary.auditId}`).toString('base64url')}`;
    const start = s.rows.get('M')!.Binding;
    const folded = s.rows.size === 1 ?
      // Independent fixture recipe, not the storage fold helper.
      hash(['orka-recovery-data-end-v2', hash(['orka-recovery-row-v2', hash(['orka-recovery-data-v2', start]), auditRow, summary.auditDigest]), 1]) : '';
    assert.equal(summary.postDataDigest, folded);
    return { result: Buffer.from('domain-result'), domainDispositionDigest: 'c'.repeat(64) };
  } };
  const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  await r.reclaim(visitor, budget(), dispositionWithCommitment); assert.equal(called, 1);
  assert.equal(s.rows.get('M')!.Result, Buffer.from('domain-result').toString('base64')); await r.close(); await assert.rejects(zombie.close(), code('unresolved'));
});

test('ingress seal and recovery audit create in the same fenced batch and both enter the post-data fold', async t => {
  const s = await tableService(t, 'ingress', 2); const zombie = createTableKernelV2(ingressBinding, s.dependencies);
  await zombie.initialize(); await zombie.acquire();
  const prior = await zombie.read('M'); if (!prior || prior.value.kind !== 'metadata') throw new Error('fixture M');
  const v = prior.value;
  const fence = { initId: v.initId, initDigest: v.initDigest, owner: v.owner, epoch: v.epoch, mDigest: v.digest, etag: prior.etag };
  const seal = { kind: 'create' as const, key: { type: 'control' as const, id: 'generation:1' }, payload: Buffer.from('synthetic-seal') };
  const r = createTableOperatorReclaimerV2(ingressBinding, s.dependencies, fence);
  await r.reclaim({ passes: 2, record(): undefined {}, endPass(): undefined {}, finalize(): undefined {} }, budget(), {
    state: Buffer.alloc(0), dispositionDigest: 'b'.repeat(64), operatorAttestationDigest: 'd'.repeat(64), seal,
    complete(summary) {
      assert.equal(summary.dataRowCount, 2);
      const audit = `control_${Buffer.from(`control_recovery:${summary.auditId}`).toString('base64url')}`;
      const sealRow = `control_${Buffer.from('generation:1').toString('base64url')}`;
      const binding = s.rows.get('M')!.Binding;
      const sealDigest = hash(['orka-data-v1', binding, 'control', 'generation:1', seal.payload.toString('base64')]);
      const rows = [[audit, summary.auditDigest], [sealRow, sealDigest]].sort((a, b) => a[0]! < b[0]! ? -1 : 1);
      let h = hash(['orka-recovery-data-v2', binding]);
      for (const [row, rowDigest] of rows) h = hash(['orka-recovery-row-v2', h, row, rowDigest]);
      assert.equal(summary.postDataDigest, hash(['orka-recovery-data-end-v2', h, 2]));
      return { result: Buffer.alloc(0), domainDispositionDigest: 'c'.repeat(64) };
    },
  });
  assert.equal(s.stats.lastActions, 3); assert.ok(s.rows.has(`control_${Buffer.from('generation:1').toString('base64url')}`));
  await r.close(); await assert.rejects(zombie.close(), code('unresolved'));
});

test('lost ACK requires exact M and audit readback; no resubmission or duplicate audit', async t => {
  const { s, zombie, fence, visitor } = await occupied(t); let writes = 0;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'recover') { writes++; e.commit(); e.res.destroy(); } else e.reply(); };
  const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  await r.reclaim(visitor, budget(), disposition()); assert.equal(writes, 1);
  assert.equal([...s.rows.keys()].filter(k => k.startsWith('control_')).length, 1);
  await r.close(); delete s.controls.hook;
  await assert.rejects(zombie.close(), code('unresolved'));
});

test('lost ACK plus corrupt audit readback remains unresolved despite matching committed M', async t => {
  const { s, zombie, fence, visitor } = await occupied(t); let writes = 0;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'recover') {
      writes++; assert.equal(e.commit(), true);
      const key = String(e.actions[1]!.entity.RowKey); s.rows.set(key, { ...s.rows.get(key)!, B0: 'AA==' }); e.res.destroy();
    } else e.reply();
  };
  const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  await assert.rejects(r.reclaim(visitor, budget(), disposition()), code('unresolved'));
  assert.equal(writes, 1); await r.close(); delete s.controls.hook; await assert.rejects(zombie.close(), code('unresolved'));
});

test('exact expected owner, epoch and M digest refuse without writes; repeat reclaim refuses owner-empty', async t => {
  const { s, zombie, fence, visitor } = await occupied(t);
  for (const changed of [{ owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, { epoch: fence.epoch + 1 }, { mDigest: 'e'.repeat(64) }]) {
    const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, { ...fence, ...changed });
    await assert.rejects(r.reclaim(visitor, budget(), disposition()), code('unresolved')); await r.close();
  }
  assert.equal(s.stats.writes, 2);
  const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  await r.reclaim(visitor, budget(), disposition()); await assert.rejects(r.reclaim(visitor, budget(), disposition()), code('not-submitted')); await r.close();
  const repeat = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  const before = s.stats.writes; await assert.rejects(repeat.reclaim(visitor, budget(), disposition()), code('busy'));
  assert.equal(s.stats.writes, before); await repeat.close(); await assert.rejects(zombie.close(), code('unresolved'));
});

test('racing ordinary owner mutation fences reclaim with no orphan audit; unresolved write is never retried', async t => {
  const { s, zombie, fence, visitor } = await occupied(t);
  let writes = 0;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'recover') { writes++; e.res.destroy(); } else e.reply(); };
  const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  await assert.rejects(r.reclaim(visitor, budget(), disposition()), code('unresolved'));
  assert.equal(writes, 1); assert.equal([...s.rows.keys()].filter(k => k.startsWith('control_')).length, 0);
  await r.close(); delete s.controls.hook; await zombie.close();
});

test('two racing reclaim transactions elect exactly one winner and leave one audit row', async t => {
  const { s, zombie, fence, visitor } = await occupied(t);
  const a = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  const b = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  const result = await Promise.allSettled([a.reclaim(visitor, budget(), disposition()), b.reclaim(visitor, budget(), disposition())]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(result.filter(r => r.status === 'rejected' && r.reason instanceof TableError && ['busy', 'unresolved'].includes(r.reason.code)).length, 1);
  assert.equal([...s.rows.keys()].filter(k => k.startsWith('control_')).length, 1);
  await Promise.all([a.close(), b.close()]); await assert.rejects(zombie.close(), code('unresolved'));
});

test('ordinary clean release and successor claim beat a simultaneous reclaim without orphan audit', async t => {
  const { s, zombie, fence, visitor } = await occupied(t);
  const successor = createTableKernelV2(tableBinding, s.dependencies); const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  let raced = false;
  s.controls.hook = async event => {
    if (!raced && event.actions[0]?.entity.Operation === 'recover') {
      raced = true; await zombie.close(); await successor.acquire(); event.reply();
    } else event.reply();
  };
  await assert.rejects(r.reclaim(visitor, budget(), disposition()), code('unresolved'));
  assert.equal(raced, true); assert.equal(s.rows.get('M')?.Owner !== fence.owner, true);
  assert.equal(s.rows.get('M')?.Epoch, String(fence.epoch + 1));
  assert.equal([...s.rows.keys()].filter(k => k.startsWith('control_')).length, 0);
  await r.close(); delete s.controls.hook; await successor.close();
});

test('intervening ordinary-owner write wins its M ETag and blocks the entire reclaim batch', async t => {
  const { s, zombie, fence, visitor } = await occupied(t); await zombie.scan();
  const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence); let raced = false;
  s.controls.hook = async e => {
    if (!raced && e.actions[0]?.entity.Operation === 'recover') {
      raced = true;
      await zombie.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state: Buffer.from('owner-state'), result: Buffer.alloc(0), actions: [] }));
      e.reply();
    } else e.reply();
  };
  await assert.rejects(r.reclaim(visitor, budget(), disposition()), code('unresolved'));
  assert.equal(raced, true); assert.equal(s.stats.conditionFailure, 'etag-mismatch');
  assert.equal([...s.rows.keys()].filter(k => k.startsWith('control_')).length, 0);
  await r.close(); delete s.controls.hook; await zombie.close();
});

test('late zombie M batch cannot commit after recovery replaces its original ETag', async t => {
  const { s, zombie, fence, visitor } = await occupied(t); await zombie.scan();
  const release = deferred(); let late: (() => boolean) | undefined;
  s.controls.hook = async e => {
    if (e.actions[0]?.entity.Operation === 'mutate') { late = e.commit; await release.promise; e.res.destroy(); }
    else e.reply();
  };
  const mutation = zombie.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state: Buffer.from('stale'), result: Buffer.alloc(0), actions: [] }));
  await eventually(() => !!late);
  const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  await r.reclaim(visitor, budget(), disposition()); assert.equal(late!(), false);
  release.resolve(); await assert.rejects(mutation, code('unresolved'));
  await r.close(); delete s.controls.hook; await assert.rejects(zombie.close(), code('unresolved'));
});

test('normal owned kernel cannot forge a reserved recovery audit row', async t => {
  const { s, zombie } = await occupied(t); await zombie.scan(); const before = s.stats.writes;
  const result = await zombie.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state: Buffer.alloc(0), result: Buffer.alloc(0), actions: [{
    kind: 'create', key: { type: 'control', id: 'control_recovery:11111111-1111-4111-8111-111111111111' }, payload: Buffer.from('{}'),
  }] }));
  assert.equal(result.kind, 'cancelled'); assert.equal(s.rows.has(`control_${Buffer.from('control_recovery:11111111-1111-4111-8111-111111111111').toString('base64url')}`), false);
  // The owned V2 kernel may reconcile a rejected plan with an ordinary M barrier, never a recover write or audit row.
  assert.equal(s.stats.writes, before + 1); assert.equal(s.rows.get('M')?.Operation, 'barrier');
  await zombie.close();
});

test('closing during a trusted domain finalizer revokes pre-submit write permission', async t => {
  const { s, zombie, fence, visitor } = await occupied(t);
  const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  const writes = s.stats.writes;
  await assert.rejects(r.reclaim({ ...visitor, finalize(): undefined { void r.close(); } }, budget(), disposition()), code('incomplete'));
  await r.close(); assert.equal(s.stats.writes, writes); await zombie.close();
});

test('operator cancellation during finalizer revokes reclaim before the first write', async t => {
  const { s, zombie, fence, visitor } = await occupied(t); const controller = new AbortController();
  const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence); const before = s.stats.writes;
  const d = disposition();
  await assert.rejects(r.reclaim(visitor, budget(), {
    ...d, complete(summary) { controller.abort(); return d.complete(summary); },
  }, { signal: controller.signal }), code('incomplete'));
  assert.equal(s.stats.writes, before); assert.equal(s.rows.get('M')?.Owner, fence.owner);
  assert.equal([...s.rows.keys()].filter(k => k.startsWith('control_')).length, 0);
  await r.close(); await zombie.close();
});

test('untrusted disposition shape and incomplete visitor cannot authorize a write', async t => {
  const { s, zombie, fence, visitor } = await occupied(t);
  const bad = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  await assert.rejects(bad.reclaim(visitor, budget(), { ...disposition(), extra: 'injection' } as never), code('invalid-input'));
  await bad.close(); assert.equal(s.stats.writes, 2);
  const r = createTableOperatorReclaimerV2(tableBinding, s.dependencies, fence);
  await assert.rejects(r.reclaim({ ...visitor, finalize(): undefined { throw new Error('domain audit failed'); } }, budget(), disposition()), code('unresolved'));
  assert.equal(s.stats.writes, 2); await r.close(); await zombie.close();
});
