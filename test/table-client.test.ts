import assert from 'node:assert/strict';
import https from 'node:https';
import { test } from 'node:test';
import { bindTable } from '../src/storage/table/codec.js';
import { OwnedTableClient } from '../src/storage/table/client.js';
import type { DataAction, Metadata } from '../src/storage/table/types.js';
import { context, deferred, eventually, tableBinding, tableService, wireM, stamp } from './support/table-service.js';

function m(): Metadata {
  const wire = wireM(); return { kind: 'metadata', initId: String(wire.InitId), initDigest: String(wire.InitDigest), owner: '', epoch: 0,
    invocation: String(wire.Invocation), operation: 'initialize', plan: String(wire.Plan), state: Buffer.alloc(0), result: Buffer.alloc(0), release: Buffer.alloc(0), digest: String(wire.Digest) };
}
function safe(e: unknown): boolean { return e instanceof Error && /^Table storage: [a-z-]+$/u.test(e.message) && !('cause' in e) && !('request' in e) && !('response' in e); }
test('owned public SDK creates, raw reads and exact-replaces real native multipart bytes', async t => {
  const s = await tableService(t); const client = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  await client.write(m(), undefined, [], context());
  assert.equal(s.rows.has('M'), true);
  const before = await client.read('M', context()); assert.equal(before?.value.kind, 'metadata');
  const payload = Buffer.alloc(262144, 7);
  await client.write(m(), before!.etag, [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload }], context());
  assert.equal(s.stats.lastActions, 2); assert.equal(s.stats.conditionFailure, '');
  const row = await client.read('delivery_aXRlbQ', context());
  assert.equal(row?.value.kind === 'data' && row.value.payload.equals(payload), true);
  const page = await client.page(context()); assert.equal(page.records.length, 1); assert.equal(!!page.cursor, true);
  const next = await client.page(context(), page.cursor); assert.equal(next.records[0]?.row, 'delivery_aXRlbQ');
  await client.close(); assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});
test('100 actions fit; 101, duplicate rows, wildcard ETags and >4MiB plans reject before auth', async t => {
  const s = await tableService(t); s.rows.set('M', stamp(wireM(), 1));
  const client = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  const actions: DataAction[] = Array.from({ length: 99 }, (_, i) => ({ kind: 'create', key: { type: 'delivery', id: String(i) }, payload: Buffer.alloc(0) }));
  await client.write(m(), 'W/"1"', actions, context()); assert.equal(s.stats.lastActions, 100); assert.equal(s.stats.conditionFailure, ''); assert.equal(s.rows.size, 100);
  const count = s.stats.tokens;
  for (const plan of [[...actions, { ...actions[0]!, key: { type: 'delivery' as const, id: '100' } }], [actions[0]!, actions[0]!],
    actions.slice(0, 13).map(a => ({ ...a, payload: Buffer.alloc(262144) }))]) {
    await assert.rejects(client.write(m(), 'W/"1"', plan, context()), safe);
  }
  await assert.rejects(client.write(m(), '*', [], context()), safe);
  await assert.rejects(client.write(m(), undefined, actions, context()), safe);
  assert.equal(s.stats.tokens, count); await client.close();
});
test('near-limit multipart payload is actually delivered below 4MiB; the next full chunked entity is refused', async t => {
  const s = await tableService(t); s.rows.set('M', stamp(wireM(), 1));
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  const actions: DataAction[] = Array.from({ length: 11 }, (_, i) => ({ kind: 'create', key: { type: 'delivery', id: String(i) }, payload: Buffer.alloc(262144, 7) }));
  await c.write(m(), 'W/"1"', actions, context()); assert.equal(s.rows.size, 12);
  assert.equal(s.stats.bytes > 3800000 && s.stats.bytes <= 4194304, true); const tokens = s.stats.tokens;
  await assert.rejects(c.write(m(), 'W/"1"', [...actions, { ...actions[0]!, key: { type: 'delivery', id: 'extra' } }], context()), safe);
  assert.equal(s.stats.tokens, tokens); await c.close();
});
for (const status of [301, 307, 401, 429, 503]) test(`HTTP ${status} does not redirect, challenge or retry`, async t => {
  const s = await tableService(t); s.controls.hook = ({ res }) => { res.writeHead(status, { location: 'https://secondary.invalid/' }); res.end(); };
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  await assert.rejects(c.read('M', context()), safe); await c.close(); assert.equal(s.stats.requests, 1); assert.equal(s.stats.tokens, 1);
});
test('only classified EntityNotFound is absence; corrupt error bodies fail closed', async t => {
  const s = await tableService(t); const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  assert.equal(await c.read('M', context()), undefined);
  for (const code of ['TableNotFound', 'Unknown', '']) {
    s.controls.hook = ({ res }) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ 'odata.error': { code, message: { lang: 'en-US', value: 'private error' } } })); };
    await assert.rejects(c.read('M', context()), safe);
  }
  await c.close();
});
test('ambiguous consumed response headers and non-JSON entities fail before projection', async t => {
  const s = await tableService(t); const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  for (const headers of [ ['content-type', 'application/json', 'etag', 'W/"1"', 'etag', 'W/"hidden"'],
    ['content-type', 'text/html', 'etag', 'W/"1"'] ]) {
    s.controls.hook = e => { e.res.writeHead(200, headers); e.res.end(JSON.stringify(stamp(wireM(), 1))); };
    await assert.rejects(c.read('M', context()), safe);
  }
  await c.close();
});
test('native constructor throw is private and closes without phantom work', async t => {
  const s = await tableService(t); s.controls.request = (() => { throw new Error('private constructor detail'); }) as typeof https.request;
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  await assert.rejects(c.read('M', context()), safe); await c.close(); assert.equal(s.stats.requests, 0);
});
test('late token work remains owned after abort; close drains it and no late request occurs', async t => {
  const s = await tableService(t); const gate = deferred<string>(); const started = deferred();
  const c = new OwnedTableClient(bindTable(tableBinding), { ...s.dependencies, token: async () => { started.resolve(); return gate.promise; } });
  const abort = new AbortController(); let settled = false;
  const read = c.read('M', { signal: abort.signal, deadline: performance.now() + 30000 }); const failure = assert.rejects(read, safe);
  await started.promise; abort.abort(); const close = c.close().then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(settled, false);
  gate.resolve('late.synthetic'); await failure; await close; assert.equal(s.stats.requests, 0);
});
test('abort destroys actual HTTPS request and socket before close resolves', async t => {
  const s = await tableService(t); s.controls.hook = () => {};
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies); const abort = new AbortController();
  const read = c.read('M', { signal: abort.signal, deadline: performance.now() + 30000 }); const failure = assert.rejects(read, safe);
  await eventually(() => s.stats.requests === 1); abort.abort(); await failure; await c.close();
  assert.equal(s.stats.requestCloses, 1); assert.equal(s.stats.socketCloses, 1);
});
test('abort is not drain while actual native destruction is held at the request seam', async t => {
  const s = await tableService(t); s.controls.hook = () => {}; let release: (() => void) | undefined;
  s.controls.request = ((...args: Parameters<typeof https.request>) => {
    const req = s.request(...args); const destroy = req.destroy.bind(req);
    req.destroy = () => { release = () => { destroy(); }; return req; }; return req;
  }) as typeof https.request;
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies); const abort = new AbortController();
  const read = c.read('M', { signal: abort.signal, deadline: performance.now() + 30000 }); const failure = assert.rejects(read, safe);
  await eventually(() => s.stats.requests === 1); abort.abort(); await eventually(() => !!release);
  let closed = false; const close = c.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(closed, false); assert.equal(s.stats.requestCloses, 0); assert.equal(s.stats.socketCloses, 0);
  release!(); await failure; await close; assert.equal(s.stats.requestCloses, 1); assert.equal(s.stats.socketCloses, 1);
});
test('TLS hostname and CA verification cannot silently succeed', async t => {
  const s = await tableService(t);
  for (const wrong of ['hostname', 'ca']) {
    s.controls.request = ((url: URL, opts: https.RequestOptions, cb: never) => https.request(new URL(url.pathname + url.search, s.fixture.baseUrl),
      { ...opts, hostname: '127.0.0.1', servername: wrong === 'hostname' ? 'wrong.invalid' : 'localhost', ...(wrong === 'hostname' ? { ca: s.fixture.ca } : {}) }, cb)) as typeof https.request;
    const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies); await assert.rejects(c.read('M', context()), safe); await c.close();
  }
  assert.equal(s.stats.requests, 0);
});
