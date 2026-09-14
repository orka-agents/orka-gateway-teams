import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TableClient } from '@azure/data-tables';
import { createTableForeignInspectorV2 } from '../src/storage/table/index.js';
import { budget, code, visitor } from './support/owned-audit.js';
import { foreign } from './support/foreign-inspection.js';

for (const passes of [1, 2] as const) for (const limit of ['maxPages', 'maxPageBytes'] as const) for (const delta of [-1, 0])
  test(`foreign ${passes} pass cumulative ${limit} boundary ${delta}`, async t => {
    const f = await foreign(t); const i = f.create(); const body = JSON.stringify({ value: [f.s.rows.get('M')] }); let pages = 0; let points = 0;
    f.s.controls.hook = e => {
      if (e.path.includes(",RowKey='M'")) { points++; e.reply(); }
      else { pages++; e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.end(body); }
    };
    // One pass needs two attempted requests: an empty continuation page, then M.
    if (passes === 1) f.s.controls.hook = e => {
      if (e.path.includes(",RowKey='M'")) { points++; e.reply(); return; } pages++;
      e.res.writeHead(200, { 'content-type': 'application/json', ...(pages === 1 ? { 'x-ms-continuation-nextpartitionkey': 'opaque', 'x-ms-continuation-nextrowkey': 'M' } : {}) });
      e.res.end(pages === 1 ? '{"value":[]}' : body);
    };
    const exact = limit === 'maxPages' ? 2 : passes === 1 ? 12 + Buffer.byteLength(body) : 2 * Buffer.byteLength(body);
    const inspection = i.inspect({ ...visitor(), passes }, budget({ [limit]: exact + delta }));
    if (delta === 0) { await inspection; assert.equal(points, 2 * passes); assert.equal(pages, 2); }
    else {
      await assert.rejects(inspection, code('incomplete')); assert.equal(points, passes === 1 ? 1 : 3);
      assert.equal(pages, limit === 'maxPages' ? 1 : 2); assert.equal(i.status().lifecycle, 'failed');
    }
    await i.close(); f.unchanged();
  });
for (const pointBytes of [524288, 524289]) test(`foreign M point bound ${pointBytes} is independent of exact cumulative page body allowance`, async t => {
  const f = await foreign(t); const i = f.create(); const entity = JSON.stringify(f.s.rows.get('M')); const page = JSON.stringify({ value: [f.s.rows.get('M')] }); let points = 0;
  f.s.controls.hook = e => {
    e.res.writeHead(200, { 'content-type': 'application/json' });
    if (e.path.includes(",RowKey='M'")) { points++; e.res.end(entity + ' '.repeat(pointBytes - Buffer.byteLength(entity))); }
    else e.res.end(page);
  };
  const inspection = i.inspect({ ...visitor(), passes: 2 }, budget({ maxPageBytes: 2 * Buffer.byteLength(page) }));
  if (pointBytes === 524288) { await inspection; assert.equal(points, 4); }
  else { await assert.rejects(inspection, code('unavailable')); assert.equal(points, 1); }
  await i.close(); f.unchanged();
});
for (const capacity of [80925, 80926, 81057, 81058]) test(`foreign tracking initial and overlapping growth capacity ${capacity}`, async t => {
  const f = await foreign(t); const i = f.create(); let pages = 0;
  f.s.controls.hook = e => {
    if (e.path.includes(",RowKey='M'")) { e.reply(); return; } pages++;
    e.res.writeHead(200, { 'content-type': 'application/json', ...(pages < 3 ? { 'x-ms-continuation-nextpartitionkey': 'opaque', 'x-ms-continuation-nextrowkey': String(pages) } : {}) });
    e.res.end(JSON.stringify({ value: pages === 3 ? [f.s.rows.get('M')] : [] }));
  };
  const inspection = i.inspect(visitor(), budget({ maxTrackingBytes: capacity }));
  if (capacity === 81058) { await inspection; assert.equal(pages, 3); }
  else { await assert.rejects(inspection, code('incomplete')); assert.equal(pages, capacity === 80925 ? 0 : 2); }
  await i.close(); f.unchanged();
});
test('foreign incoming escaped SDK cursor bound charges staging and rejects before another request', async t => {
  const f = await foreign(t); const i = f.create(); let pages = 0; let callbacks = 0; const received: number[] = []; const started: number[] = [];
  const list = TableClient.prototype.listEntities;
  t.mock.method(TableClient.prototype, 'listEntities', function(this: TableClient, ...args: Parameters<typeof list>) {
    const entities = list.apply(this, args); const byPage = entities.byPage.bind(entities);
    entities.byPage = settings => {
      started.push(settings?.continuationToken?.length ?? 0); const iterator = byPage(settings); const next = iterator.next.bind(iterator);
      iterator.next = async () => { const result = await next(); received.push(result.done ? 0 : result.value.continuationToken?.length ?? 0); return result; }; return iterator;
    }; return entities;
  });
  f.s.controls.hook = e => {
    if (e.path.includes(",RowKey='M'")) { e.reply(); return; } pages++;
    e.res.writeHead(200, { 'content-type': 'application/json',
      'x-ms-continuation-nextpartitionkey': pages === 1 ? '"'.repeat(2009) + 'p'.repeat(39) : '"'.repeat(2048),
      'x-ms-continuation-nextrowkey': pages === 1 ? 'r'.repeat(2048) : '\\'.repeat(2048) });
    e.res.end(JSON.stringify({ value: pages === 1 ? [f.s.rows.get('M')] : [] }));
  };
  await assert.rejects(i.inspect({ ...visitor(), record() { callbacks++; } }, budget({ maxTrackingBytes: 80926 })), code('unresolved'));
  assert.equal(pages, 2); assert.equal(callbacks, 1); assert.equal(f.stats.gets, 3);
  assert.equal(started.length, 2); assert.equal(started[1], 8192); assert.equal(received[0], 8192); assert.equal(received[1], 10976);
  await i.close(); f.unchanged();
});
test('foreign maximum engineering budgets remain usable on a small fixture without legacy profiles', async t => {
  const f = await foreign(t); const i = f.create();
  await i.inspect(Object.assign(Object.create(null), visitor()), Object.assign(Object.create(null), budget({
    maxPages: Number.MAX_SAFE_INTEGER, maxPageBytes: Number.MAX_SAFE_INTEGER, maxDurationMs: 2147483647, maxTrackingBytes: 268435456,
  })), Object.assign(Object.create(null), { requestTimeoutMs: 300000 }));
  await i.close(); f.unchanged();
});
for (const requestMs of [undefined, 300000]) test(`foreign request deadline ${requestMs === undefined ? 'default' : 'explicit'} is capped by original operation deadline`, async t => {
  const f = await foreign(t); const deadlines: number[] = []; const now = performance.now();
  const i = createTableForeignInspectorV2(f.binding, { ...f.dependencies, token: async (...args) => {
    deadlines.push(args[1].deadline); return f.dependencies.token(...args);
  } }, f.expected);
  const admission = performance.now();
  await i.inspect({ ...visitor(), passes: 2 }, budget({ maxDurationMs: 60000 }), requestMs === undefined ? undefined : { requestTimeoutMs: requestMs });
  assert.equal(deadlines.length, 6);
  assert.equal(deadlines.every(d => d >= now + (requestMs === undefined ? 29000 : 59000) && d <= performance.now() + (requestMs === undefined ? 30000 : 60000)), true);
  if (requestMs !== undefined) { assert.equal(deadlines.every(d => d === deadlines[0]), true); assert.equal(deadlines[0]! >= admission + 60000, true); }
  await i.close(); f.unchanged();
});
for (const callback of ['record', 'endPass', 'finalize'] as const) test(`foreign monotonic duration rechecked after synchronous ${callback} without waiting for timers`, async t => {
  const f = await foreign(t); const i = f.create(); let calls = 0; let later = 0;
  const v = { passes: 1 as const, record(): undefined { later++; }, endPass(): undefined { later++; }, finalize(): undefined { later++; },
    [callback](): undefined { calls++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } };
  await assert.rejects(i.inspect(v, budget({ maxDurationMs: 1000 })), code('incomplete'));
  assert.equal(calls, 1); assert.equal(later, callback === 'record' ? 0 : callback === 'endPass' ? 1 : 2);
  assert.equal(f.stats.gets, callback === 'finalize' ? 3 : 2); await i.close(); f.unchanged();
});
