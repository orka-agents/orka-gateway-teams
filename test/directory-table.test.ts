import assert from 'node:assert/strict';
import https from 'node:https';
import { test } from 'node:test';
import { bindingName, directoryKey, encodeEntity } from '../src/directory/codec.js';
import { createDirectoryTable } from '../src/directory/table.js';
import { DirectoryError } from '../src/directory/types.js';
import { binding, context, deferred, directoryFixture, eventually, key, sample } from './support/directory-table.js';

const scope = { appId: binding.appId, tenantId: binding.tenantId };
const code = (want: string) => (e: unknown) => e instanceof DirectoryError && e.code === want && e.message === `Directory storage: ${want}` && !('cause' in e);

test('invalid bindings and missing replace ETags fail closed before any token or native work', async t => {
  const f = await directoryFixture(t);
  for (const invalid of [{ ...binding, account: undefined }, { ...binding, table: undefined }]) {
    assert.throws(() => createDirectoryTable(invalid as never, f.dependencies), code('invalid-input'));
  }
  const table = createDirectoryTable(binding, f.dependencies); t.after(() => table.close());
  await assert.rejects(table.replace(key, undefined as never, sample(), context()), code('invalid-input'));
  assert.equal(f.stats.tokens, 0); assert.equal(f.stats.requests, 0);
});
test('native conditional CRUD classifies ACKs separately from read-back truth and drains sockets', async t => {
  const f = await directoryFixture(t); const table = createDirectoryTable(binding, f.dependencies); t.after(() => table.close());
  assert.equal(await table.get(key, context()), undefined);
  assert.deepEqual(await table.insert(key, sample(), context()), { kind: 'ack' });
  const row = await table.get(key, context()); assert.deepEqual(row?.value, sample()); assert.equal(row?.etag, 'W/"1"');
  assert.deepEqual(await table.insert(key, sample(), context()), { kind: 'conflict' });
  assert.deepEqual(await table.replace(key, 'W/"wrong"', sample(), context()), { kind: 'conflict' });
  assert.deepEqual(await table.replace(key, row!.etag, sample(), context()), { kind: 'ack' });
  assert.equal(f.requests.at(-1)?.headers['if-match'], 'W/"1"');
  assert.deepEqual(await table.list(context()), [{ ...row, etag: 'W/"2"' }]);
  await table.close(); assert.equal(f.stats.requestCloses, f.stats.requests); assert.equal(f.stats.socketCloses, f.stats.sockets);
  await assert.rejects(table.get(key, context()), code('closed'));
});
test('only EntityNotFound or one exact empty ResourceNotFound query proves absence', async t => {
  const f = await directoryFixture(t); const table = createDirectoryTable(binding, f.dependencies); t.after(() => table.close());
  f.controls.hook = ({ url, res, reply }) => {
    if (url.pathname !== '/Directory()') { res.writeHead(404, { 'x-ms-error-code': 'ResourceNotFound' }); res.end(); }
    else { assert.deepEqual([...url.searchParams.keys()].sort(), ['$filter', '$top']); assert.equal(url.searchParams.get('$filter'), `PartitionKey eq '${directoryKey(scope, key).partition}' and RowKey eq '${directoryKey(scope, key).row}'`); reply(); }
  };
  assert.equal(await table.get(key, context()), undefined); assert.equal(f.stats.requests, 2);
  const present = { ...encodeEntity(scope, key, sample()), Timestamp: '2026-11-11T00:00:00Z', 'odata.etag': '"present"' };
  f.rows.set(directoryKey(scope, key).row, present);
  assert.deepEqual((await table.get(key, context()))?.value, sample()); assert.equal(f.stats.requests, 4);
  f.controls.hook = ({ res }) => { res.writeHead(404, { 'x-ms-error-code': 'TableNotFound' }); res.end(); };
  await assert.rejects(table.get(key, context()), code('unavailable'));
  assert.deepEqual(await table.replace(key, '"old"', sample(), context()), { kind: 'uncertain' });
  f.controls.hook = ({ url, res }) => {
    if (url.pathname !== '/Directory()') { res.writeHead(404, { 'x-ms-error-code': 'ResourceNotFound' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'application/json;odata=fullmetadata', 'x-ms-continuation-nextrowkey': 'later' }); res.end('{"value":[]}'); }
  };
  await assert.rejects(table.get(key, context()), code('corrupt'));
});
test('ACK/status is not commit proof; malformed writes never become successful commits', async t => {
  const f = await directoryFixture(t); const table = createDirectoryTable(binding, f.dependencies); t.after(() => table.close());
  f.controls.hook = ({ res }) => { res.writeHead(204); res.end(); };
  assert.deepEqual(await table.insert(key, sample(), context()), { kind: 'ack' });
  delete f.controls.hook; assert.equal(await table.get(key, context()), undefined);
  for (const status of [200, 202, 301, 429, 500]) {
    f.controls.hook = ({ res }) => { res.writeHead(status, { location: 'https://other.invalid/' }); res.end(); };
    assert.deepEqual(await table.insert(key, sample(), context()), { kind: 'uncertain' });
  }
  const before = f.stats.tokens;
  await assert.rejects(table.replace(key, '*', sample(), context()), code('invalid-input'));
  assert.equal(f.stats.tokens, before);
});
test('raw fullmetadata decode rejects digest/schema/identity faults, duplicates, UTF8 and body overflow', async t => {
  const f = await directoryFixture(t); const table = createDirectoryTable(binding, f.dependencies); t.after(() => table.close());
  await table.insert(key, sample(), context()); const good = [...f.rows.values()][0]!;
  for (const change of [{ Digest: 'b'.repeat(64) }, { Armed: true }, { Timestamp: undefined }, { 'odata.etag': undefined }, { Payload: '====' }, { privateText: 'no' }, { PartitionKey: 'foreign' }]) {
    f.rows.set(String(good.RowKey), { ...good, ...change }); await assert.rejects(table.get(key, context()), code('corrupt'));
  }
  const faults = [Buffer.from('{"V":1,"\\u0056":1}'), Buffer.from([0xff]), Buffer.alloc(512*1024+1, 32)];
  for (const body of faults) { f.controls.hook = ({ res }) => { res.writeHead(200, { 'content-type': 'application/json;odata=fullmetadata' }); res.end(body); }; await assert.rejects(table.get(key, context()), code('corrupt')); }
  const { Timestamp: _stamp, 'odata.etag': _tag, ...withoutMetadata } = good;
  f.controls.hook = ({ res }) => { res.writeHead(200, { 'content-type': 'application/json;odata=nometadata' }); res.end(JSON.stringify(withoutMetadata)); };
  await assert.rejects(table.get(key, context()), code('corrupt'));
  f.controls.hook = ({ res }) => { res.writeHead(302, { location: 'https://foreign.invalid/' }); res.end(); };
  const before = f.stats.requests; await assert.rejects(table.get(key, context()), code('unavailable')); assert.equal(f.stats.requests, before+1);
});
test('native JSON accepts service parameters but rejects compression and duplicate selected raw headers', async t => {
  const f = await directoryFixture(t); const table = createDirectoryTable(binding, f.dependencies); t.after(() => table.close());
  await table.insert(key, sample(), context()); const good = [...f.rows.values()][0]!;
  f.controls.hook = ({ res }) => { res.writeHead(200, { 'content-type': 'application/json;odata=fullmetadata;streaming=true;charset=utf-8' }); res.end(JSON.stringify(good)); };
  assert.deepEqual((await table.get(key, context()))?.value, sample());
  f.controls.hook = ({ res }) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(JSON.stringify(good)); };
  await assert.rejects(table.get(key, context()), code('corrupt'));
  for (const [name, value] of [['etag', 'W/"1"'], ['content-type', 'application/json'], ['content-encoding', 'identity'], ['x-ms-error-code', 'EntityNotFound'], ['x-ms-continuation-nextrowkey', 'next'], ['x-ms-continuation-nextpartitionkey', 'partition']]) {
    f.controls.hook = ({ res }) => {
      const headers = [name!, value!, name!.toUpperCase(), value!];
      if (name !== 'content-type') headers.push('content-type', 'application/json');
      res.writeHead(200, headers); res.end(JSON.stringify(good));
    };
    await assert.rejects(table.get(key, context()), code('corrupt'));
  }
});
test('native Table rejects an untrusted fixture certificate', async t => {
  const f = await directoryFixture(t);
  const request: typeof https.request = ((url: URL, options: https.RequestOptions, cb: Parameters<typeof https.request>[2]) => https.request(new URL(url.pathname+url.search, f.fixture.baseUrl), { ...options, hostname: '127.0.0.1', servername: 'localhost' }, cb!)) as typeof https.request;
  const table = createDirectoryTable(binding, { ...f.dependencies, request }); t.after(() => table.close());
  await assert.rejects(table.get(key, context()), code('unavailable')); assert.equal(f.stats.requests, 0);
});
test('four held token acquisitions saturate before a fifth token and close waits actual borrowed provider work', async t => {
  const f = await directoryFixture(t); const gate = deferred<string>(); let calls = 0; const signals: AbortSignal[] = [];
  const table = createDirectoryTable(binding, { ...f.dependencies, token: async (_scope, ctx) => { calls++; signals.push(ctx.signal); return gate.promise; } });
  const pending = Array.from({ length: 4 }, () => table.get(key, context()).catch(e => e));
  await eventually(() => calls === 4); await assert.rejects(table.get(key, context()), code('busy')); assert.equal(calls, 4);
  let done = false; const closing = table.close().then(() => { done = true; }); await new Promise(r => setTimeout(r, 10));
  assert.equal(done, false); assert.ok(signals.every(s => s.aborted)); gate.resolve('synthetic-directory-token');
  await closing; for (const result of await Promise.all(pending)) assert.ok(code('unavailable')(result)); assert.equal(f.stats.requests, 0);
});
test('four live native sockets saturate and close waits their actual delayed destruction', async t => {
  const f = await directoryFixture(t); f.controls.hook = () => {}; const releases: (() => void)[] = [];
  const request: typeof https.request = ((...args: Parameters<typeof https.request>) => {
    const req = f.request(...args);
    req.once('socket', socket => {
      const destroy = socket.destroy.bind(socket);
      socket.destroy = (() => socket) as typeof socket.destroy;
      releases.push(() => { socket.destroy = destroy; destroy(); });
    });
    return req;
  }) as typeof https.request;
  const table = createDirectoryTable(binding, { ...f.dependencies, request });
  const pending = Array.from({ length: 4 }, () => table.get(key, context()).catch(e => e));
  await eventually(() => f.stats.requests === 4);
  await assert.rejects(table.get(key, context()), code('busy')); assert.equal(f.stats.tokens, 4); assert.equal(f.stats.sockets, 4);
  let done = false; const closing = table.close().then(() => { done = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(done, false); assert.equal(f.stats.socketCloses, 0);
  for (const release of releases) release(); await closing;
  for (const value of await Promise.all(pending)) assert.ok(code('unavailable')(value));
  assert.equal(f.stats.socketCloses, 4); assert.equal(f.stats.requestCloses, 4);
});
test('post-token authority/deadline/cancel rechecks prevent native writes', async t => {
  const f = await directoryFixture(t); const gate = deferred<string>(); let calls = 0;
  const table = createDirectoryTable(binding, { ...f.dependencies, token: async () => { calls++; return gate.promise; } }); t.after(() => table.close());
  let allowed = true; const controller = new AbortController();
  const pending = table.insert(key, sample(), { ...context(), authorizeWrite: () => allowed });
  await eventually(() => calls === 1); allowed = false; gate.resolve('synthetic-directory-token');
  await assert.rejects(pending, code('unavailable')); assert.equal(f.stats.requests, 0);
  for (const ctx of [{ signal: controller.signal, deadline: NaN }, { signal: controller.signal, deadline: Infinity }]) await assert.rejects(table.get(key, ctx), code('invalid-input'));
  controller.abort(); await assert.rejects(table.get(key, { ...context(), signal: controller.signal }), code('unavailable'));
  await assert.rejects(table.get(key, context(-1)), code('unavailable'));
});
test('abort and deadline destroy actual held native request and socket before completing drain', async t => {
  const f = await directoryFixture(t); f.controls.hook = () => {};
  const table = createDirectoryTable(binding, f.dependencies); t.after(() => table.close());
  const controller = new AbortController(); const pending = table.get(key, { ...context(), signal: controller.signal });
  await eventually(() => f.stats.requests === 1); controller.abort(); await assert.rejects(pending, code('unavailable'));
  assert.equal(f.stats.socketCloses, 1); assert.equal(f.stats.requestCloses, 1);
  await assert.rejects(table.get(key, context(40)), code('unavailable')); assert.equal(f.stats.socketCloses, 2);
  const hanging = table.get(key, context()).catch(e => e); await eventually(() => f.stats.requests === 3); await table.close();
  assert.ok(code('unavailable')(await hanging)); assert.equal(f.stats.socketCloses, 3);
});
test('list follows empty pages, filters Armed and rejects repeated cursors, duplicate rows and late faults atomically', async t => {
  const f = await directoryFixture(t); const table = createDirectoryTable(binding, f.dependencies); t.after(() => table.close());
  const row = { ...encodeEntity(scope, key, sample()), Timestamp: '2026-11-11T00:00:00Z', 'odata.etag': '"one"' };
  let page = 0;
  f.controls.hook = ({ url, res }) => {
    assert.equal(url.searchParams.get('$top'), '4'); assert.ok(url.searchParams.get('$filter')?.endsWith(' and Armed eq true'));
    res.setHeader('content-type', 'application/json;odata=fullmetadata');
    if (++page === 1) { res.setHeader('x-ms-continuation-nextrowkey', 'next'); res.end('{"value":[]}'); }
    else { assert.equal(url.searchParams.get('NextRowKey'), 'next'); res.end('{"value":[]}'); }
  };
  assert.deepEqual(await table.list(context(), true), []); assert.equal(page, 2);
  for (const fault of ['repeat', 'duplicate', 'late', 'foreign', 'page-size']) {
    page = 0;
    f.controls.hook = ({ res }) => {
      res.setHeader('content-type', 'application/json;odata=fullmetadata'); page++;
      if (fault === 'repeat' || page === 1) res.setHeader('x-ms-continuation-nextrowkey', 'next');
      if (fault === 'late' && page === 2) { res.writeHead(500); res.end(); return; }
      const value = fault === 'repeat' ? [] : fault === 'page-size' ? Array.from({ length: 5 }, () => row) : fault === 'foreign' ? [{ ...row, RowKey: 'foreign' }] : [row];
      res.end(JSON.stringify({ value }));
    };
    await assert.rejects(table.list(context()), code(fault === 'repeat' ? 'unready' : fault === 'late' ? 'unavailable' : 'corrupt'));
  }
});
test('stream traversal visits 4000 rows before its page cap; list still refuses 32MiB rather than publishing a prefix', async t => {
  const f = await directoryFixture(t); const table = createDirectoryTable(binding, f.dependencies); t.after(() => table.close());
  let page = 0; let visited = 0;
  f.controls.hook = ({ res }) => {
    res.setHeader('content-type', 'application/json;odata=fullmetadata'); res.setHeader('x-ms-continuation-nextrowkey', String(++page));
    const value = Array.from({ length: 4 }, (_, i) => {
      const conversationId = `page-${page}-row-${i}`;
      const record = { ...sample(), conversationId, bindingName: bindingName(scope, conversationId, 'a'.repeat(64)) };
      return { ...encodeEntity(scope, { kind: 'conn', conversationId }, record), Timestamp: '2026-11-11T00:00:00Z', 'odata.etag': '"one"' };
    });
    res.end(JSON.stringify({ value }));
  };
  await assert.rejects(table.list(context(), false, async () => { visited++; }), code('unready'));
  assert.equal(page, 1000); assert.equal(visited, 4000);
  page = 0; const padding = ' '.repeat(500*1024);
  f.controls.hook = ({ res }) => { res.setHeader('content-type', 'application/json;odata=fullmetadata'); res.setHeader('x-ms-continuation-nextrowkey', String(++page)); res.end('{"value":[]}'+padding); };
  await assert.rejects(table.list(context()), code('unready')); assert.ok(page > 64 && page < 70);
});
