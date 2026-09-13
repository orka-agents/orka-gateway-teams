import assert from 'node:assert/strict';
import https from 'node:https';
import { test } from 'node:test';
import { createTableKernelV2 } from '../src/storage/table/index.js';
import { OwnedTableClient } from '../src/storage/table/client.js';
import { bindTable, decodeRecordV2 } from '../src/storage/table/codec.js';
import type { DataAction, PlannerV2 } from '../src/storage/table/types.js';
import { changedM2, wireM2 } from './support/table-v2.js';
import { context, deferred, eventually, ingressBinding, stamp, syntheticToken, tableBinding, tableService } from './support/table-service.js';
const code = (want: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === want && !('cause' in e);
const input = { input: Buffer.alloc(0), keys: [] };
const plan = () => ({ state: Buffer.alloc(0), result: Buffer.alloc(0), actions: [] });
async function owned(t: Parameters<typeof tableService>[0], limits = {}) {
  const s = await tableService(t, 'delivery', 2); const k = createTableKernelV2(tableBinding, s.dependencies, limits);
  await k.initialize(); await k.acquire(); await k.scan(); return { s, k };
}
test('V2 actual near-limit multipart bytes and 100-action ceiling are bounded before auth', async t => {
  const s = await tableService(t, 'delivery', 2); const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies, 2);
  const value = decodeRecordV2(bindTable(tableBinding), Buffer.from(JSON.stringify(stamp(wireM2(), 1)))).value;
  if (value.kind !== 'metadata') throw new Error('Expected metadata');
  await c.write(value, undefined, [], context()); const original = await c.read('M', context());
  const actions: DataAction[] = Array.from({ length: 11 }, (_, i) => ({ kind: 'create', key: { type: 'delivery', id: String(i) }, payload: Buffer.alloc(262144, 7) }));
  const before = s.stats.bytes; await c.write(value, original!.etag, actions, context());
  assert.equal(s.stats.bytes - before > 3800000 && s.stats.bytes - before <= 4194304, true);
  const tokens = s.stats.tokens;
  await assert.rejects(c.write(value, original!.etag, [...actions, { ...actions[0]!, key: { type: 'delivery', id: 'extra' } }], context()), code('invalid-input'));
  await assert.rejects(c.write(value, '*', [], context()), code('invalid-input'));
  const many: DataAction[] = Array.from({ length: 99 }, (_, i) => ({ kind: 'create', key: { type: 'alias', id: String(i) }, payload: Buffer.alloc(0) }));
  await assert.rejects(c.write(value, original!.etag, [...many, { ...many[0]!, key: { type: 'alias', id: 'extra' } }], context()), code('invalid-input'));
  assert.equal(s.stats.tokens, tokens);
  const current = await c.read('M', context()); await c.write(value, current!.etag, many, context());
  assert.equal(s.stats.lastActions, 100); await c.close(); assert.equal(s.stats.requests, s.stats.socketCloses);
});
test('V2 low-level transport cannot submit a fixture recovery operation or cross-format metadata', async () => {
  let tokens = 0;
  const c = new OwnedTableClient(bindTable(tableBinding), { token: async () => { tokens++; throw new Error('synthetic token failure'); } }, 2);
  const recovery = decodeRecordV2(bindTable(tableBinding), Buffer.from(JSON.stringify(stamp(wireM2('', 1, 'operator-recovery'), 1)))).value;
  if (recovery.kind !== 'metadata') throw new Error('Expected metadata');
  await assert.rejects(c.write(recovery, 'W/"1"', [], context()), code('invalid-input'));
  const { exit, ...fields } = recovery; void exit;
  // @ts-expect-error Deliberate format mismatch must also fail before auth at runtime.
  await assert.rejects(c.write({ ...fields, operation: 'release', release: Buffer.alloc(0) }, 'W/"1"', [], context()), code('invalid-input'));
  await c.close(); assert.equal(tokens, 0);
});
test('V2 deadline and close retain held token work without physical requests or late grants', async t => {
  const s = await tableService(t, 'delivery', 2); const gate = deferred<string>(); let held = false;
  const k = createTableKernelV2(tableBinding, { ...s.dependencies, token: async () => { held = true; return gate.promise; } }, { maxPending: 1 });
  const rejected = assert.rejects(k.initialize({ timeoutMs: 100 }), code('unavailable')); await eventually(() => held); await rejected;
  assert.equal(k.status().pending, 1); await assert.rejects(k.read('M'), code('not-submitted'));
  let closed = false; const close = k.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(closed, false); gate.resolve(syntheticToken); await close;
  assert.equal(k.status().pending, 0); assert.equal(k.status().ownership, 'none'); assert.equal(s.stats.requests, 0);
});
test('V2 native destruction held beyond deadline cannot release queue, bytes or close early', async t => {
  const { s, k } = await owned(t, { maxPending: 1 }); let release: (() => void) | undefined;
  s.controls.hook = () => {};
  s.controls.request = ((...args: Parameters<typeof https.request>) => {
    const req = s.request(...args); const destroy = req.destroy.bind(req);
    req.destroy = () => { release = () => { destroy(); }; return req; }; return req;
  }) as typeof https.request;
  const requests = s.stats.requests; const closes = s.stats.socketCloses;
  const rejected = assert.rejects(k.mutate({ input: Buffer.alloc(21), keys: [] }, plan, { timeoutMs: 150 }), code('unavailable'));
  await eventually(() => s.stats.requests > requests); await rejected; await eventually(() => !!release);
  assert.equal(k.status().pending, 1); assert.equal(k.status().pendingBytes, 21); assert.equal(s.stats.socketCloses, closes);
  let closed = false; k.invalidate(); const close = assert.rejects(k.close(), code('unresolved')).then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(closed, false); release!(); await close;
  assert.equal(k.status().pending, 0); assert.equal(k.status().pendingBytes, 0); assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});
test('V2 queued snapshots and admission hold through reconciliation after caller deadline', async t => {
  const { s, k } = await owned(t, { maxPending: 2, maxPendingBytes: 1024 }); const gate = deferred(); let held = false;
  s.controls.hook = async e => {
    if (e.actions[0]?.entity.Operation === 'mutate') { e.commit(); e.res.destroy(); }
    else if (s.rows.get('M')?.Operation === 'mutate' && !held) { held = true; await gate.promise; e.reply(); } else e.reply();
  };
  const bytes = Buffer.alloc(512, 7); let observed = false;
  const rejected = assert.rejects(k.mutate({ input: bytes, keys: [] }, view => { observed = view.input.equals(Buffer.alloc(512, 7)); return plan(); }, { timeoutMs: 1000 }), code('unavailable'));
  bytes.fill(0); await eventually(() => held); const abort = new AbortController();
  const cancelled = assert.rejects(k.mutate({ input: Buffer.alloc(512), keys: [] }, plan, { signal: abort.signal }), code('not-submitted'));
  assert.equal(k.status().pendingBytes, 1024); await assert.rejects(k.mutate({ input: Buffer.alloc(1), keys: [] }, plan), code('not-submitted'));
  abort.abort(); await cancelled; await rejected; assert.equal(observed, true); assert.equal(k.status().pending, 1); assert.equal(k.status().pendingBytes, 512);
  let closed = false; const close = k.close().then(() => { closed = true; }); await new Promise(r => setTimeout(r, 20)); assert.equal(closed, false);
  gate.resolve(); await close; assert.equal(k.status().pending, 0); assert.equal(s.rows.get('M')?.Owner, ''); assert.equal(s.stats.requests, s.stats.socketCloses);
});
for (const failure of ['pages', 'bytes', 'cycle', 'order', 'missing', 'abort']) test(`V2 scan ${failure} fails bounded without partial readiness`, async t => {
  const { s, k } = await owned(t); await k.close();
  const next = createTableKernelV2(tableBinding, s.dependencies, failure === 'bytes' ? { scanBytes: 1 } : { scanPages: 2 }); await next.acquire();
  const abort = new AbortController(); let pages = 0;
  s.controls.hook = e => {
    if (e.req.method === 'GET' && !e.path.includes(",RowKey='")) {
      pages++;
      if (failure === 'abort') { abort.abort(); return; }
      if (failure === 'pages' || failure === 'cycle' || failure === 'order') {
        e.res.writeHead(200, { 'content-type': 'application/json', 'x-ms-continuation-NextPartitionKey': 'opaque', 'x-ms-continuation-NextRowKey': failure === 'cycle' ? 'same' : String(pages) });
        e.res.end(JSON.stringify({ value: failure === 'order' ? [s.rows.get('M')] : [] })); return;
      }
      if (failure === 'missing') { e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.end('{"value":[]}'); return; }
    }
    e.reply();
  };
  await assert.rejects(next.scan({ signal: abort.signal }), e => code('incomplete')(e) || code('unavailable')(e) || code('unresolved')(e));
  await eventually(() => next.status().pending === 0); assert.notEqual(next.status().lifecycle, 'envelope-audited'); assert.equal(pages <= 2, true);
  delete s.controls.hook; if (failure === 'missing') await assert.rejects(next.close(), code('unresolved')); else await next.close();
});
test('V2 init rejects native-written orphan data, and scope mismatches never acquire or write', async t => {
  const { s, k } = await owned(t);
  await k.mutate(input, () => ({ ...plan(), actions: [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload: Buffer.from('saved') }] }));
  await k.close(); const writes = s.stats.writes;
  for (const change of [{ appId: 'other', tenantId: 'Tenant' }, { appId: 'App', tenantId: 'other' }]) {
    const other = createTableKernelV2({ ...tableBinding, kind: 'delivery', scope: change }, s.dependencies);
    await assert.rejects(other.acquire(), code('corrupt')); await other.close();
  }
  s.rows.delete('M'); const orphan = createTableKernelV2(tableBinding, s.dependencies);
  await assert.rejects(orphan.initialize(), code('exists')); await orphan.close(); assert.equal(s.stats.writes, writes);
  const ingress = await tableService(t, 'ingress', 2); const i = createTableKernelV2(ingressBinding, ingress.dependencies); await i.initialize();
  if (ingressBinding.kind !== 'ingress') throw new Error('Expected ingress fixture');
  for (const [key, value] of Object.entries(ingressBinding.scope)) {
    const scope = { ...ingressBinding.scope, [key]: key === 'orkaBaseUrl' ? 'https://other.invalid/' : value + '-other' };
    const other = createTableKernelV2({ ...ingressBinding, scope }, ingress.dependencies); await assert.rejects(other.acquire(), code('corrupt')); await other.close();
  }
  await i.close(); assert.equal(ingress.stats.writes, 1);
});
test('V2 corrupt required data invalidates while invalid planners reject without writes', async t => {
  const { s, k } = await owned(t); const key = { type: 'delivery' as const, id: 'item' };
  await k.mutate(input, () => ({ ...plan(), actions: [{ kind: 'create', key, payload: Buffer.from('saved') }] })); const writes = s.stats.writes;
  for (const planner of [() => ({ ...plan(), state: Buffer.alloc(65537) }), () => ({ ...plan(), result: Buffer.alloc(65537) }),
    () => ({ ...plan(), actions: [{ kind: 'replace' as const, key, payload: Buffer.alloc(0), etag: '*' }] }),
    (() => Promise.reject(new Error('synthetic planner failure'))) as unknown as PlannerV2]) await assert.rejects(k.mutate(input, planner), code('invalid-input'));
  assert.equal(s.stats.writes, writes);
  s.rows.get('delivery_aXRlbQ')!.Digest = '0'.repeat(64); await assert.rejects(k.mutate({ ...input, keys: [key] }, plan), code('unresolved'));
  await assert.rejects(k.close(), code('unresolved')); assert.equal(s.stats.writes, writes); assert.equal(k.status().ownership, 'owned');
});
for (const fault of ['missing', 'foreign', 'read-failure']) test(`V2 ${fault} after acquire retains possible ownership and never releases`, async t => {
  const s = await tableService(t, 'delivery', 2); const k = createTableKernelV2(tableBinding, s.dependencies, { reconciliationReads: 2 }); await k.initialize(); let acquired = false;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'acquire') {
      acquired = true; e.commit();
      if (fault === 'missing') s.rows.delete('M');
      if (fault === 'foreign') s.rows.set('M', changedM2(s.rows.get('M')!, { Invocation: '99999999-9999-4999-8999-999999999999' }, 500));
      e.res.destroy();
    } else if (acquired && fault === 'read-failure') { e.res.writeHead(503); e.res.end(); } else e.reply();
  };
  await assert.rejects(k.acquire(), code('unresolved')); assert.equal(k.status().ownership, 'possible'); const writes = s.stats.writes;
  await assert.rejects(k.close(), code('unresolved')); assert.equal(s.stats.writes, writes); assert.equal(s.stats.requests, s.stats.socketCloses);
});
