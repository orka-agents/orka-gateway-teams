import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createTableKernel } from '../src/storage/table/owner.js';
import type { Plan, TableError } from '../src/storage/table/types.js';
import { deferred, eventually, hash, mDigest, stamp, tableBinding, tableService, wireM } from './support/table-service.js';

const input = () => ({ input: Buffer.from('input'), keys: [] });
const plan = (): Plan => ({ state: Buffer.from('state'), result: Buffer.from('result'), actions: [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload: Buffer.from('payload') }] });
const code = (want: string) => (e: unknown) => e instanceof Error && (e as TableError).code === want && !('cause' in e);
async function owned(t: Parameters<typeof tableService>[0], limits = {}) {
  const service = await tableService(t); const kernel = createTableKernel(tableBinding, service.dependencies, limits);
  await kernel.initialize(); await kernel.acquire(); return { s: service, k: kernel };
}
test('synchronous handle performs explicit initialize, acquire-unready, complete audit, mutation and drained release', async t => {
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies);
  assert.equal(s.stats.tokens, 0); await k.initialize(); assert.equal(s.rows.size, 1);
  await k.acquire(); assert.equal(k.status().ownership, 'owned'); assert.equal(k.status().lifecycle, 'owned-unready');
  await assert.rejects(k.mutate(input(), plan), code('unready')); await k.scan();
  const result = await k.mutate(input(), plan); assert.equal(result.kind, 'committed');
  assert.equal(result.kind === 'committed' && result.result.equals(Buffer.from('result')), true);
  assert.equal((await k.read({ type: 'delivery', id: 'item' }))?.value.kind, 'data');
  const close = k.close(); assert.equal(k.close(), close); await close;
  assert.equal(s.rows.get('M')?.Owner, ''); assert.equal(k.status().ownership, 'none');
  assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});
test('normal acquisition never initializes, adopts or takes over existing owners', async t => {
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies);
  await assert.rejects(k.acquire(), code('missing')); assert.equal(s.stats.writes, 0);
  s.rows.set('M', stamp(wireM(randomUUID(), 1), 1));
  await assert.rejects(k.acquire(), code('busy')); await assert.rejects(k.initialize(), code('exists'));
  await k.close(); assert.equal(s.stats.writes, 0);
});
test('digest-valid impossible initializer cannot be acquired or audited and causes zero writes', async t => {
  const s = await tableService(t);
  const invalid = { ...wireM(), Epoch: '1' };
  s.rows.set('M', stamp({ ...invalid, Digest: mDigest(invalid) }, 1));
  const k = createTableKernel(tableBinding, s.dependencies); let outcome = 'accepted';
  try { await k.acquire(); await k.scan(); } catch (e) { outcome = code('corrupt')(e) ? 'corrupt' : 'other'; }
  await k.close();
  assert.equal(s.stats.writes, 0); assert.equal(outcome, 'corrupt');
  assert.equal(s.stats.requests, s.stats.socketCloses);
});
test('cancelled first acquisition leaves an empty epoch-zero barrier that permits later acquisition', async t => {
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies); await k.initialize();
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'acquire') { e.res.writeHead(202); e.res.end(); } else e.reply(); };
  await assert.rejects(k.acquire(), code('not-submitted'));
  const barrier = s.rows.get('M')!;
  assert.equal(barrier.Operation, 'barrier'); assert.equal(barrier.Owner, ''); assert.equal(barrier.Epoch, '0');
  assert.equal(barrier.State, ''); assert.equal(barrier.Result, ''); assert.equal(barrier.Release, '');
  delete s.controls.hook; await k.acquire(); await k.scan(); await k.close();
});
for (const operation of ['initialize', 'acquire', 'release', 'mutate']) test(`lost ${operation} ACK requires raw M proof`, async t => {
  const s = await tableService(t); let losses = 0;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === operation) { losses++; e.commit(); e.res.destroy(); } else e.reply(); };
  const k = createTableKernel(tableBinding, s.dependencies); await k.initialize(); await k.acquire(); await k.scan();
  assert.equal((await k.mutate(input(), plan)).kind, 'committed'); await k.close(); assert.equal(losses, 1); assert.equal(s.rows.get('M')?.Owner, '');
});
test('uncertain initialization is never resubmitted or turned into a tombstone', async t => {
  const s = await tableService(t); s.controls.hook = e => { if (e.actions.length) e.res.destroy(); else e.reply(); };
  const k = createTableKernel(tableBinding, s.dependencies, { reconciliationReads: 3 });
  await assert.rejects(k.initialize(), code('unresolved')); assert.equal(k.status().lifecycle, 'poisoned');
  await assert.rejects(k.close(), code('unresolved')); assert.equal(s.stats.writes, 1); assert.equal(s.rows.size, 0);
});
test('initialization receipt survives a legitimate subsequent ownership transition', async t => {
  const s = await tableService(t);
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'initialize') {
    e.commit(); const current = s.rows.get('M')!; const next = { ...current, Owner: randomUUID(), Epoch: '1', Invocation: randomUUID(), Operation: 'acquire', Plan: '' };
    next.Plan = hash(['acquire', current.Digest, next.Owner, next.Invocation]);
    s.rows.set('M', stamp({ ...next, Digest: mDigest(next) }, 99)); e.res.destroy();
  } else e.reply(); };
  const k = createTableKernel(tableBinding, s.dependencies); await k.initialize(); assert.equal(k.status().ownership, 'none'); await k.close();
});
for (const operation of ['acquire', 'mutate', 'release']) test(`unchanged original M cancels ${operation} with one exact barrier`, async t => {
  const { s, k } = await owned(t); await k.scan(); let original = 0; let barriers = 0;
  if (operation === 'acquire') { await k.close(); }
  const handle = operation === 'acquire' ? createTableKernel(tableBinding, s.dependencies) : k;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === operation) { original++; e.res.writeHead(202); e.res.end(); }
    else { if (e.actions[0]?.entity.Operation === 'barrier') barriers++; e.reply(); }
  };
  if (operation === 'mutate') assert.equal((await handle.mutate(input(), plan)).kind, 'cancelled');
  else if (operation === 'acquire') await assert.rejects(handle.acquire(), code('not-submitted'));
  else await assert.rejects(handle.close(), code('unresolved'));
  assert.equal(original, 1); assert.equal(barriers, 1);
  if (operation !== 'release') { delete s.controls.hook; await handle.close(); }
  else assert.equal(handle.status().ownership, 'owned');
});
test('owned second-epoch mutation/release barriers retain state, result and the prior release receipt', async t => {
  const { s, k } = await owned(t); await k.scan(); await k.mutate(input(), plan); await k.close();
  const next = createTableKernel(tableBinding, s.dependencies); await next.acquire(); await next.scan();
  const original = s.rows.get('M')!; assert.equal(original.Epoch, '2'); assert.equal(typeof original.Release === 'string' && original.Release.length > 0, true);
  s.controls.hook = e => { if (['mutate', 'release'].includes(String(e.actions[0]?.entity.Operation))) { e.res.writeHead(202); e.res.end(); } else e.reply(); };
  assert.equal((await next.mutate(input(), plan)).kind, 'cancelled');
  await assert.rejects(next.close(), code('unresolved'));
  const barrier = s.rows.get('M')!; assert.equal(barrier.Operation, 'barrier');
  for (const field of ['Owner', 'Epoch', 'State', 'Result', 'Release']) assert.equal(barrier[field] === original[field], true);
  assert.equal(next.status().ownership, 'owned');
});
for (const order of ['original-first', 'barrier-first']) test(`exact original/barrier race ${order} with lost barrier ACK`, async t => {
  const { s, k } = await owned(t); await k.scan(); let pending: (() => boolean) | undefined; let original = 0; let barriers = 0;
  s.controls.hook = e => {
    const op = e.actions[0]?.entity.Operation;
    if (op === 'mutate') { original++; pending = e.commit; e.res.destroy(); }
    else if (op === 'barrier') { barriers++; if (order === 'original-first') pending!(); e.commit(); if (order === 'barrier-first') assert.equal(pending!(), false); e.res.destroy(); }
    else e.reply();
  };
  const result = await k.mutate(input(), plan); assert.equal(result.kind, order === 'original-first' ? 'committed' : 'cancelled');
  assert.equal(s.rows.has('delivery_aXRlbQ'), order === 'original-first'); assert.equal(original, 1); assert.equal(barriers, 1);
  delete s.controls.hook; await k.close();
});
for (const fault of ['missing', 'foreign', 'read-failure']) test(`${fault} M after submission poisons, bounds reconciliation and forbids release`, async t => {
  const { s, k } = await owned(t, { reconciliationReads: 3 }); await k.scan(); let submitted = false; const before = s.stats.requests;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'mutate') {
      submitted = true; if (fault === 'missing') s.rows.delete('M');
      if (fault === 'foreign') { const current = s.rows.get('M')!; const next = { ...current, Invocation: randomUUID() }; s.rows.set('M', stamp({ ...next, Digest: mDigest(next) }, 99)); }
      e.res.destroy();
    } else if (submitted && fault === 'read-failure') { e.res.writeHead(503); e.res.end(); } else e.reply();
  };
  await assert.rejects(k.mutate(input(), plan), code('unresolved')); assert.equal(k.status().lifecycle, 'poisoned');
  const writes = s.stats.writes; await assert.rejects(k.close(), code('unresolved')); assert.equal(s.stats.writes, writes);
  assert.equal(s.stats.requests - before <= 6, true); assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});
test('release receipt proves release even when the readback observes a new owner', async t => {
  const { s, k } = await owned(t); let nextOwner = '';
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'release') {
    e.commit(); const current = s.rows.get('M')!; nextOwner = randomUUID();
    const next = { ...current, Owner: nextOwner, Epoch: String(Number(current.Epoch) + 1), Invocation: randomUUID(), Operation: 'acquire', Plan: '' };
    next.Plan = hash(['acquire', current.Digest, nextOwner, next.Invocation]);
    s.rows.set('M', stamp({ ...next, Digest: mDigest(next) }, 99)); e.res.destroy();
  } else e.reply(); };
  await k.close(); assert.equal(k.status().ownership, 'none'); assert.equal(s.rows.get('M')?.Owner === nextOwner && !!nextOwner, true);
});
test('complete audit consumes empty pages; cyclic, exhausted and cancelled scans never ready', async t => {
  const { s, k } = await owned(t, { scanPages: 3 }); let count = 0;
  s.controls.hook = e => {
    if (e.req.method === 'GET' && !e.path.includes(",RowKey='")) {
      count++; if (count === 1) { e.res.writeHead(200, { 'content-type': 'application/json', 'x-ms-continuation-NextPartitionKey': 'v1_delivery_c3RhYmxl', 'x-ms-continuation-NextRowKey': 'M' }); e.res.end('{"value":[]}'); return; }
    }
    e.reply();
  };
  await k.scan(); assert.equal(count, 2); assert.equal(k.status().lifecycle, 'envelope-audited');
  s.controls.hook = e => {
    if (e.req.method === 'GET' && !e.path.includes(",RowKey='")) { e.res.writeHead(200, { 'content-type': 'application/json', 'x-ms-continuation-NextPartitionKey': 'v1_delivery_c3RhYmxl', 'x-ms-continuation-NextRowKey': 'M' }); e.res.end('{"value":[]}'); }
    else e.reply();
  };
  await assert.rejects(k.scan(), code('incomplete')); assert.equal(k.status().lifecycle, 'owned-unready');
  delete s.controls.hook; await k.close();
});
test('standard profile admits >=65 pending callers and removes queued abort exactly once', async t => {
  const { s, k } = await owned(t); await k.scan(); const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (!held && e.req.method === 'GET') { held = true; await gate.promise; } e.reply(); };
  const first = k.read('M'); await eventually(() => held);
  const abort = new AbortController(); const cancelled = k.read('M', { signal: abort.signal }); const cancellation = assert.rejects(cancelled, code('not-submitted'));
  const rest = Array.from({ length: 94 }, () => k.read('M')); assert.equal(k.status().pending, 96);
  await assert.rejects(k.read('M'), code('not-submitted')); abort.abort(); await cancellation; assert.equal(k.status().pending, 95);
  gate.resolve(); await Promise.all([first, ...rest]); assert.equal(k.status().pending, 0); delete s.controls.hook; await k.close();
});
test('input snapshots precede queue; issued abort retains its slot through cleanup readback', async t => {
  const { s, k } = await owned(t, { maxPending: 2 }); await k.scan(); const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (e.actions[0]?.entity.Operation === 'mutate') { e.commit(); e.res.destroy(); }
    else if (s.rows.get('M')?.Operation === 'mutate' && !held) { held = true; await gate.promise; e.reply(); } else e.reply(); };
  const raw = Buffer.from('before'); const abort = new AbortController();
  const mutation = k.mutate({ input: raw, keys: [] }, view => { assert.equal(view.input.toString(), 'before'); return plan(); }, { signal: abort.signal });
  const rejected = assert.rejects(mutation, code('unavailable')); raw.fill(0); await eventually(() => held); abort.abort(); await rejected;
  assert.equal(k.status().pending, 1); let closed = false; const close = k.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(closed, false); assert.equal(k.status().lifecycle, 'closing'); gate.resolve(); await close;
  assert.equal(k.status().pending, 0); assert.equal(s.rows.get('M')?.Owner, '');
});
for (const ack of ['empty', 'malformed', 'inner-failure', 'wrong-count', 'truncated'] as const) for (const commit of [true, false])
  test(`ACK ${ack}, committed=${commit}: only M determines outcome`, async t => {
    const { s, k } = await owned(t); await k.scan(); let originals = 0;
    s.controls.hook = e => {
      if (e.actions[0]?.entity.Operation !== 'mutate') { e.reply(); return; }
      originals++; if (commit) e.commit();
      const bodies = { empty: '', malformed: 'not multipart', 'inner-failure': '--changesetresponse_x\r\nHTTP/1.1 412 failure\r\n',
        'wrong-count': '--changesetresponse_x\r\nHTTP/1.1 204 success\r\n--changesetresponse_x--', truncated: 'partial' };
      e.res.writeHead(202, { 'content-type': 'multipart/mixed; boundary=response', ...(ack === 'truncated' ? { 'content-length': '1000' } : {}) });
      if (ack === 'truncated') { e.res.write(bodies[ack]); e.res.destroy(); } else e.res.end(bodies[ack]);
    };
    assert.equal((await k.mutate(input(), plan)).kind, commit ? 'committed' : 'cancelled'); assert.equal(originals, 1);
    delete s.controls.hook; await k.close();
  });
test('lost noncommitted cancellation barrier is bounded and never permits release', async t => {
  const { s, k } = await owned(t, { reconciliationReads: 4 }); await k.scan(); let originals = 0; let barriers = 0;
  s.controls.hook = e => { const op = e.actions[0]?.entity.Operation;
    if (op === 'mutate' || op === 'barrier') { if (op === 'mutate') originals++; else barriers++; e.res.destroy(); } else e.reply(); };
  await assert.rejects(k.mutate(input(), plan), code('unresolved')); assert.equal(originals, 1); assert.equal(barriers, 1);
  await assert.rejects(k.close(), code('unresolved')); assert.equal(barriers, 1);
});
test('old queued writer exact fence fails after clean release and new acquisition', async t => {
  const { s, k } = await owned(t); await k.scan(); let late: (() => boolean) | undefined;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'mutate') { late = e.commit; e.res.destroy(); } else e.reply(); };
  assert.equal((await k.mutate(input(), plan)).kind, 'cancelled'); delete s.controls.hook; await k.close();
  const next = createTableKernel(tableBinding, s.dependencies); await next.acquire(); await next.scan();
  assert.equal(late!(), false); assert.equal(s.rows.has('delivery_aXRlbQ'), false); await next.close();
});
