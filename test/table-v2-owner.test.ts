import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as kernel from '../src/storage/table/index.js';
import { changedM2, wireM2 } from './support/table-v2.js';
import { hash, ingressBinding, stamp, tableBinding, tableService, wireM } from './support/table-service.js';

const create = kernel.createTableKernelV2;
const code = (want: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === want && !('cause' in e);
const input = { input: Buffer.alloc(0), keys: [] };
const plan = () => ({ state: Buffer.from('state'), result: Buffer.from('result'), actions: [] });
async function owned(t: Parameters<typeof tableService>[0], limits = {}) {
  const s = await tableService(t, 'delivery', 2); const k = create(tableBinding, s.dependencies, limits);
  await k.initialize(); await k.acquire(); await k.scan(); return { s, k };
}
for (const kind of ['ingress', 'delivery'] as const) test(`V2 ${kind} native SDK init/acquire/create/replace/scan/close/handover keeps V1 data bytes`, async t => {
  const binding = kind === 'delivery' ? tableBinding : ingressBinding;
  const s = await tableService(t, kind, 2); const k = create(binding, s.dependencies);
  assert.equal(s.stats.requests, 0); await k.initialize(); assert.equal(s.rows.get('M')?.V, 2);
  await k.acquire(); await assert.rejects(k.mutate(input, plan), code('unready')); await k.scan();
  const key = { type: kind === 'delivery' ? 'delivery' as const : 'event' as const, id: 'item' };
  await k.mutate(input, () => ({ ...plan(), actions: [{ kind: 'create', key, payload: Buffer.alloc(262144, 7) }] }));
  const first = await k.read(key); assert.equal(first?.value.kind === 'data' && first.value.payload.length, 262144);
  await k.mutate({ ...input, keys: [key] }, view => ({ ...plan(), actions: [{ kind: 'replace', key, etag: view.records[0]!.etag, payload: Buffer.from('replaced') }] }));
  assert.equal((await k.scan()).length, 2); const record = await k.read(key);
  assert.equal(record?.value.kind === 'data' && record.value.payload.toString() === 'replaced', true);
  const row = s.rows.get(key.type + '_aXRlbQ'); assert.equal(row?.V, 1);
  await k.close(); const released = s.rows.get('M')!; assert.equal(released.Owner, ''); assert.equal('Release' in released, false);
  const receipt = JSON.parse(Buffer.from(String(released.Exit), 'base64').toString());
  assert.equal(receipt.kind, 'clean-release'); assert.equal(receipt.oldEpoch, 1); assert.equal(receipt.invocation, released.Invocation); assert.equal(receipt.planDigest, released.Plan);
  const next = create(binding, s.dependencies); await next.acquire(); await next.scan();
  assert.equal(s.rows.get('M')?.Epoch, '2'); assert.equal(s.rows.get('M')?.Exit, released.Exit);
  const read = await next.read('M'); assert.equal(read?.value.kind === 'metadata' && 'exit' in read.value, true);
  await next.close(); assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});
for (const format of [1, 2] as const) test(`format ${format} history rejects opposite factory without writes`, async t => {
  const s = await tableService(t, 'delivery', format); const original = (format === 1 ? kernel.createTableKernel : create)(tableBinding, s.dependencies);
  await original.initialize(); await original.acquire(); await original.close(); const writes = s.stats.writes;
  const other = (format === 1 ? create : kernel.createTableKernel)(tableBinding, s.dependencies);
  await assert.rejects(other.acquire(), code('corrupt')); await assert.rejects(other.initialize(), code('corrupt'));
  await other.close(); assert.equal(s.stats.writes, writes);
});
for (const format of [1, 2] as const) test(`format ${format} owned mutation rejects a switched M before writing`, async t => {
  const s = await tableService(t, 'delivery', format); const k = (format === 1 ? kernel.createTableKernel : create)(tableBinding, s.dependencies);
  await k.initialize(); await k.acquire(); await k.scan(); const writes = s.stats.writes;
  const owner = String(s.rows.get('M')!.Owner); s.rows.set('M', stamp(format === 1 ? wireM2(owner, 1) : wireM(owner, 1), 900));
  await assert.rejects(k.mutate(input, plan), code('unresolved')); await assert.rejects(k.close(), code('unresolved'));
  assert.equal(k.status().ownership, 'owned'); assert.equal(s.stats.writes, writes);
});
test('V2 emitted normal plans retain the independent initialize/acquire/mutate/release recipes', async t => {
  const s = await tableService(t, 'delivery', 2); let checked = 0;
  s.controls.hook = e => {
    const m = e.actions[0]?.entity;
    if (m) {
      const previous = s.rows.get('M'); const recipe = m.Operation === 'initialize' ? ['initialize', m.InitId] :
        m.Operation === 'acquire' ? ['acquire', previous!.Digest, m.Owner, m.Invocation] :
        m.Operation === 'release' ? ['release', previous!.Digest, m.Invocation] : ['mutate', m.Invocation, previous!.Digest, e.actions.slice(1).map(a => {
          const row = a.entity; const payload = Buffer.concat(Array.from({ length: Number(row.Count) }, (_, i) => Buffer.from(String(row[`B${i}`]), 'base64')));
          return [a.method === 'POST' ? 'create' : 'replace', row.T, row.Id, a.etag ?? '', payload.toString('base64')];
        }), m.State, m.Result];
      assert.equal(m.Plan === hash(recipe), true); checked++;
    }
    e.reply();
  };
  const k = create(tableBinding, s.dependencies); await k.initialize(); await k.acquire(); await k.scan();
  const key = { type: 'delivery' as const, id: 'item' };
  await k.mutate(input, () => ({ ...plan(), actions: [{ kind: 'create', key, payload: Buffer.from('saved') }] }));
  await k.mutate({ ...input, keys: [key] }, v => ({ ...plan(), actions: [{ kind: 'replace', key, payload: Buffer.from('changed'), etag: v.records[0]!.etag }] }));
  await k.close(); assert.equal(checked, 5);
});
test('V2 cancelled first acquisition installs an exact genesis barrier and allows later acquisition', async t => {
  const s = await tableService(t, 'delivery', 2); const k = create(tableBinding, s.dependencies); await k.initialize();
  const before = structuredClone(s.rows.get('M')!); let expected: Record<string, unknown> | undefined;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'acquire') { expected = e.actions[0].entity; e.res.destroy(); }
    else if (e.actions[0]?.entity.Operation === 'barrier') {
      const m = e.actions[0].entity;
      assert.equal(m.Plan, hash(['barrier', before.Digest, expected!.Digest, m.Invocation])); assert.equal(e.actions[0].etag, before['odata.etag']);
      e.commit(); e.res.destroy();
    } else e.reply();
  };
  await assert.rejects(k.acquire(), code('not-submitted')); assert.equal(k.status().ownership, 'none');
  for (const field of ['Owner', 'Epoch', 'State', 'Result', 'Exit']) assert.equal(s.rows.get('M')?.[field], before[field]);
  delete s.controls.hook; await k.acquire(); await k.scan(); await k.close();
});
for (const operation of ['initialize', 'acquire', 'mutate', 'release']) test(`V2 lost ${operation} ACK reconciles exact raw M`, async t => {
  const s = await tableService(t, 'delivery', 2); let losses = 0;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === operation) { losses++; e.commit(); e.res.destroy(); } else e.reply(); };
  const k = create(tableBinding, s.dependencies); await k.initialize(); await k.acquire(); await k.scan();
  assert.equal((await k.mutate(input, plan)).kind, 'committed'); await k.close(); assert.equal(losses, 1); assert.equal(k.status().ownership, 'none');
});
for (const order of ['original-first', 'barrier-first']) test(`V2 exact original/barrier race ${order} loses barrier ACK without retry`, async t => {
  const { s, k } = await owned(t); let pending: (() => boolean) | undefined; let originals = 0; let barriers = 0;
  s.controls.hook = e => {
    const op = e.actions[0]?.entity.Operation;
    if (op === 'mutate') { originals++; pending = e.commit; e.res.destroy(); }
    else if (op === 'barrier') { barriers++; if (order === 'original-first') pending!(); e.commit(); if (order === 'barrier-first') assert.equal(pending!(), false); e.res.destroy(); }
    else e.reply();
  };
  const result = await k.mutate(input, () => ({ ...plan(), actions: [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload: Buffer.from('payload') }] }));
  assert.equal(result.kind, order === 'original-first' ? 'committed' : 'cancelled'); assert.equal(originals, 1); assert.equal(barriers, 1);
  assert.equal(s.rows.has('delivery_aXRlbQ'), order === 'original-first'); delete s.controls.hook; await k.close();
  const next = create(tableBinding, s.dependencies); await next.acquire(); await next.scan();
  assert.equal(pending!(), order === 'original-first'); // A committed fixture closure is idempotent; a cancelled one remains fenced.
  await next.close();
});
test('V2 old queued mutation is first attempted after clean handover and loses its exact fence', async t => {
  const { s, k } = await owned(t); let late: (() => boolean) | undefined;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'mutate') { late = e.commit; e.res.destroy(); } else e.reply(); };
  assert.equal((await k.mutate(input, () => ({ ...plan(), actions: [{ kind: 'create', key: { type: 'delivery', id: 'late' }, payload: Buffer.from('payload') }] }))).kind, 'cancelled');
  delete s.controls.hook; await k.close(); const next = create(tableBinding, s.dependencies); await next.acquire(); await next.scan();
  const current = structuredClone(s.rows.get('M')); assert.equal(late!(), false);
  assert.equal(s.stats.conditionFailure, 'etag-mismatch'); assert.deepEqual(s.rows.get('M'), current); assert.equal(s.rows.has('delivery_bGF0ZQ'), false); await next.close();
});
for (const kind of ['clean-release', 'operator-recovery'] as const) test(`V2 late normal close accepts only ${kind === 'clean-release' ? 'matching clean' : 'no recovery'} exit proof`, async t => {
  const { s, k } = await owned(t); const next = create(tableBinding, s.dependencies); let advanced = false;
  s.controls.hook = async e => {
    if (e.actions[0]?.entity.Operation === 'release' && !advanced) {
      advanced = true;
      if (kind === 'clean-release') e.commit();
      else {
        const expected = e.actions[0]!.entity; const original = s.rows.get('M')!;
        // Independent persisted-recovery fixture, not an operator writer. The matching
        // release fields deliberately cannot authorize clean-close reconciliation.
        const receipt = { kind, oldOwner: original.Owner, oldEpoch: Number(original.Epoch), invocation: expected.Invocation,
          originalMDigest: original.Digest, planDigest: expected.Plan, domainDispositionDigest: 'c'.repeat(64), operatorAttestationDigest: 'd'.repeat(64) };
        s.rows.set('M', changedM2(original, { Owner: '', Operation: 'recover', Invocation: expected.Invocation, Plan: expected.Plan,
          Exit: Buffer.from(JSON.stringify(receipt)).toString('base64') }, 800));
      }
      await next.acquire(); await next.scan(); e.res.destroy();
    } else e.reply();
  };
  if (kind === 'clean-release') { await k.close(); assert.equal(k.status().ownership, 'none'); }
  else { await assert.rejects(k.close(), code('unresolved')); assert.equal(k.status().ownership, 'owned'); }
  assert.equal(next.status().ownership, 'owned'); delete s.controls.hook; await next.close();
});
for (const operation of ['acquire', 'mutate', 'release']) test(`V2 cancellation ${operation} preserves recovery Exit bytes and exact original fields`, async t => {
  const s = await tableService(t, 'delivery', 2); s.rows.set('M', stamp(wireM2('', 1, 'operator-recovery'), 50));
  const k = create(tableBinding, s.dependencies); if (operation !== 'acquire') { await k.acquire(); await k.scan(); }
  const original = structuredClone(s.rows.get('M')!); let barriers = 0;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === operation) { e.res.destroy(); }
    else if (e.actions[0]?.entity.Operation === 'barrier') { barriers++; assert.equal(e.actions[0]!.etag, original['odata.etag']); e.commit(); e.res.destroy(); } else e.reply(); };
  if (operation === 'acquire') await assert.rejects(k.acquire(), code('not-submitted'));
  else if (operation === 'mutate') assert.equal((await k.mutate(input, plan)).kind, 'cancelled');
  else await assert.rejects(k.close(), code('unresolved'));
  assert.equal(barriers, 1); for (const field of ['Owner', 'Epoch', 'State', 'Result', 'Exit']) assert.equal(s.rows.get('M')?.[field], original[field]);
  delete s.controls.hook; if (operation !== 'release') await k.close(); else assert.equal(k.status().ownership, 'owned');
});
test('V2 lost noncommitted mutation and cancellation barrier stay unresolved without resubmission', async t => {
  const { s, k } = await owned(t, { reconciliationReads: 4 }); let originals = 0; let barriers = 0;
  const original = structuredClone(s.rows.get('M')!);
  s.controls.hook = e => {
    const op = e.actions[0]?.entity.Operation;
    if (op === 'mutate' || op === 'barrier') { if (op === 'mutate') originals++; else barriers++; e.res.destroy(); } else e.reply();
  };
  await assert.rejects(k.mutate(input, plan), code('unresolved')); await assert.rejects(k.close(), code('unresolved'));
  assert.equal(originals, 1); assert.equal(barriers, 1); assert.deepEqual(s.rows.get('M'), original); assert.equal(k.status().ownership, 'owned');
});
test('V2 overwritten clean proof remains unresolved with honest ownership', async t => {
  const { s, k } = await owned(t); const next = create(tableBinding, s.dependencies); const latest = create(tableBinding, s.dependencies); let advanced = false;
  s.controls.hook = async e => { if (e.actions[0]?.entity.Operation === 'release' && !advanced) {
    advanced = true; e.commit(); await next.acquire(); await next.close(); await latest.acquire(); await latest.scan(); e.res.destroy();
  } else e.reply(); };
  await assert.rejects(k.close(), code('unresolved')); assert.equal(k.status().ownership, 'owned'); assert.equal(s.rows.get('M')?.Epoch, '3');
  delete s.controls.hook; await latest.close();
});
test('V2 occupied owner, overflow and orphan/partial histories never grant or write', async t => {
  const s = await tableService(t, 'delivery', 2); const k = create(tableBinding, s.dependencies);
  await assert.rejects(k.acquire(), code('missing'));
  for (const [wire, want] of [[wireM2(randomUUID(), 1), 'busy'], [wireM2('', Number.MAX_SAFE_INTEGER, 'operator-recovery'), 'invalid-input'],
    [{ ...wireM2(), InitDigest: undefined }, 'corrupt']] as const) {
    s.rows.set('M', stamp(wire, 50)); await assert.rejects(k.acquire(), code(want));
    await assert.rejects(k.initialize(), code(want === 'corrupt' ? 'corrupt' : 'exists'));
  }
  assert.equal(s.stats.writes, 0); await k.close();
});
test('V2 acquire never treats a recovery-shaped occupied owner as recoverable', async t => {
  const s = await tableService(t, 'delivery', 2); s.rows.set('M', stamp(wireM2(randomUUID(), 2, 'operator-recovery'), 50));
  const k = create(tableBinding, s.dependencies); await assert.rejects(k.acquire(), code('busy')); await k.close(); assert.equal(s.stats.writes, 0);
});
