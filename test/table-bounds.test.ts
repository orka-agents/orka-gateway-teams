import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createTableKernel } from '../src/storage/table/index.js';
import { bindTable, decodeRecord } from '../src/storage/table/codec.js';
import { OwnedTableClient } from '../src/storage/table/client.js';
import type { Planner, TableBinding, TableError } from '../src/storage/table/types.js';
import { context, deferred, eventually, ingressBinding, mDigest, stamp, tableBinding, tableService, wireM } from './support/table-service.js';
const code = (want: string) => (e: unknown) => e instanceof Error && (e as TableError).code === want;
const emptyPlan = () => ({ state: Buffer.alloc(0), result: Buffer.alloc(0), actions: [] });
async function owned(t: Parameters<typeof tableService>[0], limits = {}) {
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies, limits); await k.initialize(); await k.acquire(); await k.scan(); return { s, k };
}
test('ingress binds all five immutable scope fields and supports event/route envelopes over native SDK', async t => {
  const s = await tableService(t, 'ingress'); const k = createTableKernel(ingressBinding, s.dependencies);
  await k.initialize(); await k.acquire(); await k.scan();
  await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ ...emptyPlan(), actions: [
    { kind: 'create', key: { type: 'event', id: 'event' }, payload: Buffer.from('event') },
    { kind: 'create', key: { type: 'route', id: 'route' }, payload: Buffer.from('route') },
  ] }));
  assert.equal((await k.scan()).length, 3); await k.close(); const writes = s.stats.writes;
  if (ingressBinding.kind !== 'ingress') throw new Error('Fixture kind mismatch');
  for (const [field, value] of Object.entries(ingressBinding.scope)) {
    const scope = { ...ingressBinding.scope, [field]: field === 'orkaBaseUrl' ? 'https://different.example.invalid/' : value + '-different' };
    const other = createTableKernel({ ...ingressBinding, scope }, s.dependencies);
    await assert.rejects(other.acquire(), code('corrupt')); await other.close();
  }
  assert.equal(s.stats.writes, writes);
});
test('caller controls, scopes, getters and oversized input reject without auth or poisoning', async t => {
  const s = await tableService(t); let getter = 0;
  for (const b of [{ ...tableBinding, account: 'bad/path' }, { ...tableBinding, table: '12' }, { ...tableBinding, storeId: '' },
    { ...tableBinding, scope: { appId: 'App', tenantId: 'Tenant', extra: 'bad' } },
    { ...tableBinding, scope: { get appId() { getter++; return 'App'; }, tenantId: 'Tenant' } }]) {
    assert.throws(() => createTableKernel(b as TableBinding, s.dependencies), code('invalid-input'));
  }
  const k = createTableKernel(tableBinding, s.dependencies);
  for (const value of [{ input: Buffer.alloc(262145), keys: [] }, { input: Buffer.alloc(0), keys: Array.from({ length: 100 }, () => ({ type: 'delivery' as const, id: 'x' })) }])
    await assert.rejects(k.mutate(value, emptyPlan), code('invalid-input'));
  await assert.rejects(k.read({ type: 'delivery', id: 'x'.repeat(257) }), code('invalid-input'));
  assert.equal(getter, 0); assert.equal(s.stats.tokens, 0); await k.close();
});
test('retained bytes backpressure and cancellation free only never-issued queued snapshots', async t => {
  const { s, k } = await owned(t, { maxPendingBytes: 1024 }); const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (!held && e.req.method === 'GET') { held = true; await gate.promise; } e.reply(); };
  const first = k.mutate({ input: Buffer.alloc(512), keys: [] }, emptyPlan); await eventually(() => held);
  const abort = new AbortController(); const second = k.mutate({ input: Buffer.alloc(512), keys: [] }, emptyPlan, { signal: abort.signal });
  const cancelled = assert.rejects(second, code('not-submitted'));
  assert.equal(k.status().pendingBytes, 1024);
  await assert.rejects(k.mutate({ input: Buffer.alloc(1), keys: [] }, emptyPlan), code('not-submitted'));
  abort.abort(); await cancelled; assert.equal(k.status().pendingBytes, 512); gate.resolve(); await first;
  await eventually(() => k.status().pending === 0); assert.equal(k.status().pendingBytes, 0); delete s.controls.hook; await k.close();
});
test('planner sees independent Buffer snapshots and rejects async/oversized/wildcard output before write', async t => {
  const { s, k } = await owned(t);
  await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ ...emptyPlan(), actions: [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload: Buffer.from('saved') }] }));
  const writes = s.stats.writes;
  await k.mutate({ input: Buffer.alloc(0), keys: [{ type: 'delivery', id: 'item' }] }, view => {
    const record = view.records[0]; assert.equal(record?.value.kind === 'data' && Buffer.isBuffer(record.value.payload), true);
    if (record?.value.kind === 'data') record.value.payload.fill(0); return emptyPlan();
  });
  for (const planner of [(async () => emptyPlan()) as unknown as Planner,
    () => ({ ...emptyPlan(), state: Buffer.alloc(65537) }), () => ({ ...emptyPlan(), result: Buffer.alloc(65537) }),
    () => ({ ...emptyPlan(), actions: [{ kind: 'replace' as const, key: { type: 'delivery' as const, id: 'item' }, payload: Buffer.alloc(0), etag: '*' }] })]) {
    await assert.rejects(k.mutate({ input: Buffer.alloc(0), keys: [] }, planner), code('invalid-input'));
  }
  assert.equal(s.stats.writes, writes + 1); assert.equal((await k.read({ type: 'delivery', id: 'item' }))?.value.kind, 'data'); await k.close();
});
test('rejected Promise planners are refused without an unhandled rejection or a write', async t => {
  const { s, k } = await owned(t); const writes = s.stats.writes;
  await assert.rejects(k.mutate({ input: Buffer.alloc(0), keys: [] }, (() => Promise.reject(new Error('synthetic planner failure'))) as unknown as Planner), code('invalid-input'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(s.stats.writes, writes); await k.close();
});
test('epoch overflow and corrupt release receipts fail closed', async t => {
  const s = await tableService(t); const tooHigh = wireM('', Number.MAX_SAFE_INTEGER); s.rows.set('M', stamp(tooHigh, 1));
  const k = createTableKernel(tableBinding, s.dependencies); await assert.rejects(k.acquire(), code('invalid-input')); assert.equal(s.stats.writes, 0); await k.close();
  for (const receipt of [Buffer.from('not json'), Buffer.from('["owner",1,"invocation","digest"]'), Buffer.from(JSON.stringify([randomUUID(), 9, randomUUID(), 'a'.repeat(64)]))]) {
    const m = { ...wireM('', 1), Release: receipt.toString('base64') };
    assert.throws(() => decodeRecord(bindTable(tableBinding), Buffer.from(JSON.stringify(stamp({ ...m, Digest: mDigest(m) }, 1)))), code('corrupt'));
  }
});
for (const failure of ['pages', 'bytes', 'abort']) test(`scan ${failure} exhaustion returns no partial ready state`, async t => {
  const { s, k } = await owned(t); await k.close();
  const other = createTableKernel(tableBinding, s.dependencies, failure === 'pages' ? { scanPages: 2 } : failure === 'bytes' ? { scanBytes: 1 } : {});
  await other.acquire(); let pages = 0; const abort = new AbortController();
  if (failure === 'pages') s.controls.hook = e => {
    if (e.req.method === 'GET' && !e.path.includes(",RowKey='")) { pages++; e.res.writeHead(200, { 'content-type': 'application/json', 'x-ms-continuation-NextPartitionKey': 'opaque', 'x-ms-continuation-NextRowKey': String(pages) }); e.res.end('{"value":[]}'); } else e.reply();
  };
  if (failure === 'abort') s.controls.hook = e => { if (e.req.method === 'GET' && !e.path.includes(",RowKey='")) abort.abort(); else e.reply(); };
  await assert.rejects(other.scan({ signal: abort.signal }), (e: unknown) => e instanceof Error && ['incomplete', 'unavailable'].includes((e as TableError).code));
  await eventually(() => other.status().pending === 0); assert.equal(other.status().lifecycle, 'owned-unready');
  if (failure === 'pages') assert.equal(pages, 2); delete s.controls.hook; await other.close();
});
test('aborted preflight read does not invent corruption or abandon healthy ownership', async t => {
  const { s, k } = await owned(t); const abort = new AbortController();
  s.controls.hook = () => abort.abort();
  await assert.rejects(k.read('M', { signal: abort.signal }), code('unavailable'));
  await eventually(() => k.status().pending === 0); delete s.controls.hook;
  await k.close(); assert.equal(s.rows.get('M')?.Owner, '');
});
test('unconfirmed acquisition remains possibly-owned, and poisoned close drains locally without release', async t => {
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies, { reconciliationReads: 2 }); await k.initialize(); let acquired = false;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'acquire') { acquired = true; e.commit(); e.res.destroy(); }
    else if (acquired) { e.res.writeHead(503); e.res.end(); } else e.reply(); };
  await assert.rejects(k.acquire(), code('unresolved')); assert.equal(k.status().ownership, 'possible');
  const writes = s.stats.writes; const close = k.close(); assert.equal(k.close(), close); await assert.rejects(close, code('unresolved'));
  assert.equal(k.status().ownership, 'possible'); assert.equal(s.stats.writes, writes); assert.equal(s.stats.requests, s.stats.socketCloses);
});
test('superseded release receipt cannot claim release after another owner', async t => {
  const { s, k } = await owned(t); let advanced = false;
  const successor = createTableKernel(tableBinding, s.dependencies); const latest = createTableKernel(tableBinding, s.dependencies);
  s.controls.hook = async e => { if (e.actions[0]?.entity.Operation === 'release' && !advanced) {
    advanced = true; e.commit();
    // Advance through real clean ownership transitions: a missing receipt would be
    // corrupt M, not a test of the exact-but-superseded release proof.
    await successor.acquire(); await successor.close(); await latest.acquire(); await latest.scan(); e.res.destroy();
  } else e.reply(); };
  await assert.rejects(k.close(), code('unresolved')); assert.equal(k.status().ownership, 'owned');
  assert.equal(s.rows.get('M')?.Epoch, '3'); assert.equal(latest.status().lifecycle, 'envelope-audited');
  delete s.controls.hook; await latest.close();
});
test('native response bounds, UTF8, encoding and point/page ETag rules remain raw', async t => {
  const s = await tableService(t); const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  for (const body of [Buffer.alloc(524289), Buffer.from([0xff]), Buffer.from('{"value":[],"value":[]}'), Buffer.from('{"value":[]}')]) {
    s.controls.hook = e => { e.res.writeHead(200, { 'content-type': 'application/json', ...(body.length < 20 ? { 'content-encoding': 'gzip' } : {}) }); e.res.end(body); };
    await assert.rejects(c.page(context()));
  }
  const record = stamp(wireM(), 1);
  s.controls.hook = e => { e.res.writeHead(200, { 'content-type': 'application/json', etag: 'W/"page-global"' });
    e.res.end(JSON.stringify({ value: [record] })); };
  assert.equal((await c.page(context())).records[0]?.etag, 'W/"1"'); await c.close();
});
for (const operation of ['read', 'mutate']) test(`corrupt required data on ${operation} poisons the previously audited owner`, async t => {
  const { s, k } = await owned(t);
  await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ ...emptyPlan(), actions: [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload: Buffer.alloc(0) }] }));
  const key = { type: 'delivery' as const, id: 'item' }; s.rows.get('delivery_aXRlbQ')!.Digest = '0'.repeat(64);
  await assert.rejects(operation === 'read' ? k.read(key) : k.mutate({ input: Buffer.alloc(0), keys: [key] }, emptyPlan), code('unresolved'));
  assert.equal(k.status().lifecycle, 'poisoned'); const writes = s.stats.writes; await assert.rejects(k.close(), code('unresolved')); assert.equal(s.stats.writes, writes);
});
test('actual caller deadline expires independently of held cleanup and close still drains', async t => {
  const { s, k } = await owned(t, { maxPending: 1 }); const gate = deferred(); let held = false;
  s.controls.hook = async e => {
    if (e.actions[0]?.entity.Operation === 'mutate') { e.commit(); e.res.destroy(); }
    else if (s.rows.get('M')?.Operation === 'mutate' && !held) { held = true; await gate.promise; e.reply(); } else e.reply();
  };
  const operation = k.mutate({ input: Buffer.alloc(20), keys: [] }, emptyPlan, { timeoutMs: 2000 });
  const rejected = assert.rejects(operation, code('unavailable')); await eventually(() => held); await rejected;
  assert.equal(k.status().pending, 1); assert.equal(k.status().pendingBytes, 20);
  await assert.rejects(k.read('M'), code('not-submitted')); gate.resolve(); await eventually(() => k.status().pending === 0);
  delete s.controls.hook; await k.close(); assert.equal(s.rows.get('M')?.Owner, '');
});
test('orphan rows cannot be adopted by initialization', async t => {
  const { s, k } = await owned(t);
  await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ ...emptyPlan(), actions: [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload: Buffer.alloc(0) }] }));
  await k.close(); s.rows.delete('M'); const writes = s.stats.writes;
  const next = createTableKernel(tableBinding, s.dependencies); await assert.rejects(next.initialize(), code('exists')); await next.close(); assert.equal(s.stats.writes, writes);
});
test('invalid exact replacement ETag does not overwrite a record and original plan is never resubmitted', async t => {
  const { s, k } = await owned(t);
  await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ ...emptyPlan(), actions: [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload: Buffer.from('saved') }] }));
  const before = s.stats.writes;
  const result = await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ ...emptyPlan(), actions: [{ kind: 'replace', key: { type: 'delivery', id: 'item' }, payload: Buffer.from('changed'), etag: 'W/"stale"' }] }));
  assert.equal(result.kind, 'cancelled'); assert.equal(s.stats.writes - before, 2);
  const row = await k.read({ type: 'delivery', id: 'item' }); assert.equal(row?.value.kind === 'data' && row.value.payload.equals(Buffer.from('saved')), true); await k.close();
});
