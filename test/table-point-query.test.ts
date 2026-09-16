import assert from 'node:assert/strict';
import https from 'node:https';
import { test } from 'node:test';
import { OwnedTableClient } from '../src/storage/table/client.js';
import { bindTable } from '../src/storage/table/codec.js';
import { createTableKernel, createTableKernelV2 } from '../src/storage/table/owner.js';
import { MAX_RESPONSE_BYTES } from '../src/storage/table/types.js';
import { context, deferred, eventually, partition, stamp, syntheticToken, tableBinding, tableService, wireM } from './support/table-service.js';
import { wireM2 } from './support/table-v2.js';
import { alterPointQuery, code, genericMissing, observePointIterator, wireData } from './support/table-point-query.js';

for (const format of [1, 2] as const) for (const shape of ['empty', 'metadata', 'data'] as const) {
  test(`V${format} generic point 404 requires one exact query: ${shape}`, async t => {
    const s = await tableService(t, 'delivery', format); s.controls.missingCode = 'ResourceNotFound';
    const row = shape === 'data' ? 'delivery_aXRlbQ' : 'M';
    // Unrelated rows must not turn absence into a partition scan or select the first row.
    s.rows.set('delivery_b3RoZXI', { ...wireData(), RowKey: 'delivery_b3RoZXI' });
    if (shape !== 'empty') s.rows.set(row, shape === 'data' ? wireData() : stamp(format === 1 ? wireM() : wireM2(), 37));
    let queries = 0;
    s.controls.hook = e => {
      if (e.path.includes(",RowKey='")) { genericMissing(e.res); return; }
      queries++; const url = new URL(e.req.url!, 'https://example123.table.core.windows.net');
      assert.equal(e.req.method === 'GET' && url.pathname === '/journal()', true);
      assert.equal(url.searchParams.get('$filter') === `PartitionKey eq '${partition}' and RowKey eq '${row}'`, true);
      assert.equal(url.searchParams.get('$top') === '1' && [...url.searchParams].length === 2, true);
      e.res.setHeader('etag', 'W/"aggregate-not-row"'); e.reply();
    };
    const iterator = observePointIterator(t);
    const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies, format);
    const result = await c.read(row, context()); await c.close();
    if (shape === 'empty') assert.equal(result, undefined);
    else {
      assert.equal(result?.row === row, true); assert.equal(result?.etag === (shape === 'data' ? 'W/"41"' : 'W/"37"'), true);
      assert.equal(result?.value.kind, shape === 'data' ? 'data' : 'metadata');
      if (shape === 'data') assert.equal(result?.value.kind === 'data' && result.value.payload.equals(Buffer.from('abc')), true);
      else assert.equal(result?.value.kind === 'metadata' && (format === 1 ? 'release' in result.value : 'exit' in result.value), true);
    }
    assert.equal(queries, 1); assert.deepEqual(iterator, { next: 1, returns: 1, closed: 1 });
    assert.equal(s.stats.requests, 2); assert.equal(s.stats.tokens, 2); assert.equal(s.stats.writes, 0);
    assert.equal(s.stats.requestCloses, 2); assert.equal(s.stats.socketCloses, 2);
  });
}

test('point 200 and default EntityNotFound remain single GETs without a collection iterator', async t => {
  const s = await tableService(t); const iterator = observePointIterator(t);
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  assert.equal(await c.read('M', context()), undefined);
  s.rows.set('M', stamp(wireM(), 1)); assert.equal((await c.read('M', context()))?.etag === 'W/"1"', true);
  await c.close(); assert.equal(s.stats.requests, 2); assert.equal(iterator.next, 0);
});

for (const fault of ['table', 'unknown', 'forbidden', 'missing-code', 'wrong-message', 'extra-property', 'duplicate-json',
  'contradictory-header', 'duplicate-header', 'non-json', 'non-identity', 'malformed'] as const) {
  test(`point ${fault} cannot authorize a fallback`, async t => {
    const s = await tableService(t); const iterator = observePointIterator(t);
    s.controls.hook = e => {
      const error = { code: fault === 'table' ? 'TableNotFound' : fault === 'unknown' ? 'Unknown' : 'ResourceNotFound',
        message: { lang: 'en-US', value: 'synthetic error' } };
      const envelope: Record<string, unknown> = { 'odata.error': error };
      if (fault === 'missing-code') Reflect.deleteProperty(error, 'code');
      if (fault === 'wrong-message') Reflect.set(error, 'message', 'invalid');
      if (fault === 'extra-property') envelope.extra = true;
      const headers = ['content-type', fault === 'non-json' ? 'text/plain' : 'application/json', 'x-ms-error-code',
        fault === 'contradictory-header' ? 'EntityNotFound' : error.code ?? 'ResourceNotFound'];
      if (fault === 'duplicate-header') headers.push('x-ms-error-code', 'ResourceNotFound');
      if (fault === 'non-identity') headers.push('content-encoding', 'gzip');
      e.res.writeHead(fault === 'forbidden' ? 403 : 404, headers);
      e.res.end(fault === 'malformed' ? '{' : fault === 'duplicate-json' ? '{"odata.error":{},"odata.error":{}}' : JSON.stringify(envelope));
    };
    const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
    await assert.rejects(c.read('M', context()), code('unavailable')); await c.close();
    assert.equal(s.stats.requests, 1); assert.equal(s.stats.tokens, 1); assert.equal(iterator.next, 0);
  });
}

for (const fault of ['wrong-row', 'wrong-partition', 'multiple', 'missing-row-etag', 'wrong-format', 'cursor', 'empty-cursor', 'row-only',
  'malformed-cursor', 'non200', 'query404', 'malformed', 'duplicate-json', 'oversize'] as const) {
  test(`exact query rejects ${fault} with no third GET`, async t => {
    const s = await tableService(t); const iterator = observePointIterator(t); let queries = 0;
    s.controls.hook = e => {
      if (e.path.includes(",RowKey='")) { genericMissing(e.res); return; } queries++;
      const m = stamp(fault === 'wrong-format' ? wireM2() : wireM(), 1);
      if (fault === 'wrong-partition') m.PartitionKey = 'v1_delivery_b3RoZXI';
      if (fault === 'missing-row-etag') delete m['odata.etag'];
      const rows = fault === 'wrong-row' ? [wireData()] : fault === 'multiple' ? [m, m] : [m];
      const headers: Record<string, string> = { 'content-type': 'application/json', etag: 'W/"aggregate"' };
      if (fault === 'cursor') { headers['x-ms-continuation-nextpartitionkey'] = partition; headers['x-ms-continuation-nextrowkey'] = 'M'; }
      if (fault === 'empty-cursor') headers['x-ms-continuation-nextpartitionkey'] = '';
      if (fault === 'row-only') headers['x-ms-continuation-nextrowkey'] = 'M';
      if (fault === 'malformed-cursor') headers['x-ms-continuation-nextpartitionkey'] = 'not printable';
      e.res.writeHead(fault === 'non200' ? 503 : fault === 'query404' ? 404 : 200, headers);
      e.res.end(fault === 'oversize' ? ' '.repeat(MAX_RESPONSE_BYTES + 1) : fault === 'malformed' ? '{' : fault === 'duplicate-json' ?
        '{"value":[],"value":[]}' : JSON.stringify({ value: fault.includes('cursor') || fault === 'row-only' ? [] : rows }));
    };
    const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
    await assert.rejects(c.read('M', context()), code(['non200', 'query404', 'oversize'].includes(fault) ? 'unavailable' : 'corrupt'));
    await c.close(); assert.equal(queries, 1); assert.equal(s.stats.requests, 2); assert.equal(s.stats.tokens, 2);
    assert.deepEqual(iterator, { next: 1, returns: 1, closed: 1 });
    assert.equal(s.stats.requestCloses, 2); assert.equal(s.stats.socketCloses, 2);
  });
}

for (const fault of ['duplicate-filter', 'duplicate-top', 'projection', 'continuation', 'wrong-row', 'wrong-path', 'wrong-method'] as const) {
  test(`exact query request fence refuses ${fault} before token or native work`, async t => {
    const s = await tableService(t); let queries = 0;
    s.controls.hook = e => {
      if (e.path.includes(",RowKey='")) { genericMissing(e.res); return; }
      queries++; e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.end('{"value":[]}');
    };
    alterPointQuery(t, request => {
      const url = new URL(request.url);
      if (fault === 'duplicate-filter') { url.searchParams.delete('$top'); url.searchParams.append('$filter', url.searchParams.get('$filter')!); }
      if (fault === 'duplicate-top') { url.searchParams.delete('$filter'); url.searchParams.append('$top', '1'); }
      if (fault === 'projection') url.searchParams.set('$select', 'RowKey');
      if (fault === 'continuation') url.searchParams.set('NextRowKey', 'M');
      if (fault === 'wrong-row') url.searchParams.set('$filter', `PartitionKey eq '${partition}' and RowKey eq 'delivery_aXRlbQ'`);
      if (fault === 'wrong-path') url.pathname = '/other()';
      if (fault === 'wrong-method') request.method = 'POST';
      request.url = url.href;
    });
    const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
    await assert.rejects(c.read('M', context()), code('unavailable')); await c.close();
    assert.equal(queries, 0); assert.equal(s.stats.requests, 1); assert.equal(s.stats.tokens, 1);
  });
}

for (const cancel of ['abort', 'deadline'] as const) test(`fallback token ${cancel} keeps original context and drains real late work`, async t => {
  const s = await tableService(t); s.controls.missingCode = 'ResourceNotFound'; const gate = deferred<string>();
  const abort = new AbortController(); const work = { signal: abort.signal, deadline: performance.now() + (cancel === 'deadline' ? 150 : 30000) };
  let tokens = 0; let tokenSignal: AbortSignal | undefined; let settled = false; let closed = false;
  const c = new OwnedTableClient(bindTable(tableBinding), { ...s.dependencies, token: async (_scope, ctx) => {
    tokens++; assert.equal(ctx.deadline, work.deadline);
    if (tokens === 2) { tokenSignal = ctx.signal; return gate.promise; } return syntheticToken;
  } });
  const outcome = c.read('M', work).then(() => { settled = true; return false; }, e => { settled = true; return code('unavailable')(e); });
  await eventually(() => tokens === 2 || settled); assert.equal(tokens, 2);
  const close = c.close().then(() => { closed = true; });
  if (cancel === 'abort') abort.abort();
  await eventually(() => tokenSignal?.aborted === true); assert.equal(settled, false); assert.equal(closed, false);
  gate.resolve(syntheticToken); assert.equal(await outcome, true); await close;
  assert.equal(s.stats.requests, 1); assert.equal(s.stats.requestCloses, 1); assert.equal(s.stats.socketCloses, 1);
});

test('abort after point socket close issues neither fallback token nor query', async t => {
  const s = await tableService(t); s.controls.missingCode = 'ResourceNotFound'; const abort = new AbortController();
  s.controls.request = ((...args: Parameters<typeof https.request>) => {
    const req = s.request(...args); req.once('socket', socket => socket.once('close', () => abort.abort())); return req;
  }) as typeof https.request;
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  await assert.rejects(c.read('M', { signal: abort.signal, deadline: performance.now() + 30000 }), code('unavailable'));
  await c.close(); assert.equal(s.stats.tokens, 1); assert.equal(s.stats.requests, 1);
});

test('fallback native abort waits for actual request and socket destruction, not cancellation alone', async t => {
  const s = await tableService(t); let query = false; let release: (() => void) | undefined;
  s.controls.hook = e => { if (e.path.includes(",RowKey='")) genericMissing(e.res); else query = true; };
  s.controls.request = ((...args: Parameters<typeof https.request>) => {
    const req = s.request(...args);
    if ((args[0] as URL).search) { const destroy = req.destroy.bind(req); req.destroy = () => { release = () => { destroy(); }; return req; }; }
    return req;
  }) as typeof https.request;
  const abort = new AbortController(); const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  let settled = false; let closed = false;
  const outcome = c.read('M', { signal: abort.signal, deadline: performance.now() + 30000 })
    .then(() => { settled = true; return false; }, e => { settled = true; return code('unavailable')(e); });
  await eventually(() => query || settled); assert.equal(query, true); abort.abort(); await eventually(() => !!release);
  const close = c.close().then(() => { closed = true; }); await new Promise(r => setTimeout(r, 20));
  assert.equal(settled, false); assert.equal(closed, false); assert.equal(s.stats.requestCloses, 1); assert.equal(s.stats.socketCloses, 1);
  release!(); assert.equal(await outcome, true); await close;
  assert.equal(s.stats.requests, 2); assert.equal(s.stats.requestCloses, 2); assert.equal(s.stats.socketCloses, 2);
});

for (const corrupt of [false, true]) test(`iterator return is awaited; cleanup failure cannot erase corruption=${corrupt}`, async t => {
  const s = await tableService(t); const gate = deferred(); let settled = false; let closed = false;
  const iterator = observePointIterator(t, async () => { await gate.promise; if (corrupt) throw new Error('synthetic cleanup failure'); });
  s.controls.hook = e => {
    if (e.path.includes(",RowKey='")) { genericMissing(e.res); return; }
    e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.end(JSON.stringify({ value: corrupt ? [wireData()] : [] }));
  };
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  const outcome = c.read('M', context()).then(value => { settled = true; return value === undefined ? 'absent' : 'present'; },
    e => { settled = true; return code('corrupt')(e) ? 'corrupt' : 'other'; });
  await eventually(() => iterator.returns === 1 || settled); assert.equal(iterator.returns, 1);
  const close = c.close().then(() => { closed = true; }); await new Promise(r => setTimeout(r, 20));
  assert.equal(settled, false); assert.equal(closed, false); gate.resolve();
  assert.equal(await outcome, corrupt ? 'corrupt' : 'absent'); await close;
  assert.deepEqual(iterator, { next: 1, returns: 1, closed: 1 }); assert.equal(s.stats.requests, 2);
});

for (const format of [1, 2] as const) test(`V${format} lost mutation ACK and generic missing M remain poisoned with no release or retry`, async t => {
  const s = await tableService(t, 'delivery', format);
  const k = (format === 1 ? createTableKernel : createTableKernelV2)(tableBinding, s.dependencies);
  await k.initialize(); await k.acquire(); await k.scan(); s.controls.missingCode = 'ResourceNotFound';
  let submitted = 0; let queries = 0;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'mutate') { submitted++; e.commit(); s.rows.delete('M'); e.res.destroy(); }
    else { if (e.path.includes('$filter')) queries++; e.reply(); }
  };
  const before = s.stats.requests;
  await assert.rejects(k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state: Buffer.alloc(0), result: Buffer.alloc(0), actions: [] })), code('unresolved'));
  assert.equal(k.status().lifecycle, 'poisoned'); const writes = s.stats.writes;
  await assert.rejects(k.close(), code('unresolved'));
  assert.equal(submitted, 1); assert.equal(queries, 1); assert.equal(s.stats.requests - before, 4); assert.equal(s.stats.writes, writes);
  assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});
