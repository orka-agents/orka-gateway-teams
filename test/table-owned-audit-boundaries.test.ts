import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { TableClient } from '@azure/data-tables';
import { createTableKernel } from '../src/storage/table/index.js';
import { OwnedTableClient } from '../src/storage/table/client.js';
import { bindTable } from '../src/storage/table/codec.js';
import { budget, code, emptyInput, emptyPlan, owned, putData, visitor } from './support/owned-audit.js';
import { context, deferred, eventually, mDigest, stamp, tableBinding, tableService } from './support/table-service.js';
import { mDigestV2 } from './support/table-v2.js';

function iteratorHook(t: TestContext, hooks: { returned?: () => void; received?: (tokenLength: number) => void; started?: (tokenLength: number) => void }) {
  const list = TableClient.prototype.listEntities;
  t.mock.method(TableClient.prototype, 'listEntities', function(this: TableClient, ...args: Parameters<typeof list>) {
    const entities = list.apply(this, args); const byPage = entities.byPage.bind(entities);
    entities.byPage = settings => {
      hooks.started?.(settings?.continuationToken?.length ?? 0);
      const pages = byPage(settings); const next = pages.next.bind(pages); const end = pages.return?.bind(pages);
      pages.next = async () => { const result = await next(); hooks.received?.(result.done ? 0 : result.value.continuationToken?.length ?? 0); return result; };
      pages.return = async () => { const result = await end?.(); hooks.returned?.(); return result ?? { done: true, value: undefined }; };
      return pages;
    };
    return entities;
  });
}
for (const format of [1, 2] as const) for (const maxTrackingBytes of [80925, 80926]) test(`V${format} escaped SDK token staging reserves capacity ${maxTrackingBytes} before native receive`, async t => {
  const { s, k } = await owned(t, format); const requests = s.stats.requests; const writes = s.stats.writes;
  const receivedLengths: number[] = []; const startedLengths: number[] = []; let pages = 0; let records = 0; let later = 0;
  // Observe only lengths at the public SDK page boundary; never import private token helpers.
  iteratorHook(t, { started(length) { startedLengths.push(length); }, received(length) { receivedLengths.push(length); } });
  s.controls.hook = e => {
    if (e.path.includes(",RowKey='M'")) { e.reply(); return; } pages++;
    // First SDK JSON is 6144 bytes (base64 8192); the second is 8231 (base64 10976).
    // Both use two allowed 2048-character printable ASCII continuation headers.
    const partition = pages === 1 ? '"'.repeat(2009) + 'p'.repeat(39) : '"'.repeat(2048);
    const row = pages === 1 ? 'r'.repeat(2048) : '\\'.repeat(2048);
    e.res.writeHead(200, { 'content-type': 'application/json', 'x-ms-continuation-nextpartitionkey': partition, 'x-ms-continuation-nextrowkey': row });
    e.res.end(JSON.stringify({ value: pages === 1 ? [s.rows.get('M')] : [] }));
  };
  const outcome = await k.auditOwned({ ...visitor(), record() { records++; }, endPass() { later++; }, finalize() { later++; } }, budget({ maxTrackingBytes }))
    .then(() => 'success', e => code('incomplete')(e) ? 'incomplete' : code('unresolved')(e) ? 'unresolved' : 'other');
  const after = k.status(); const auditRequests = s.stats.requests - requests; const auditWrites = s.stats.writes - writes;
  delete s.controls.hook; const close = await k.close().then(() => 'released', e => code('unresolved')(e) ? 'unresolved' : 'other');
  assert.equal(close, maxTrackingBytes === 80925 ? 'released' : 'unresolved');
  assert.equal(outcome, maxTrackingBytes === 80925 ? 'incomplete' : 'unresolved');
  assert.equal(after.lifecycle, maxTrackingBytes === 80925 ? 'owned-unready' : 'poisoned'); assert.equal(after.pending, 0); assert.equal(later, 0); assert.equal(auditWrites, 0);
  if (maxTrackingBytes === 80925) { assert.equal(auditRequests, 0); assert.equal(pages, 0); assert.equal(records, 0); assert.deepEqual(receivedLengths, []); }
  else {
    assert.equal(auditRequests, 3); assert.equal(pages, 2); assert.equal(records, 1);
    assert.deepEqual(startedLengths, [0, 8192]); assert.deepEqual(receivedLengths, [8192, 10976]);
    assert.notEqual(s.rows.get('M')?.Owner, '');
  }
  assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});
for (const failure of ['body-budget', 'corrupt'] as const) test(`audit ${failure} survives actual SDK iterator cleanup failure`, async t => {
  const s = await tableService(t); let cleanup = 0;
  iteratorHook(t, { returned() { cleanup++; throw new Error('private SDK cleanup detail'); } });
  s.controls.hook = e => { e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.end('{not valid'); };
  const client = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  await assert.rejects(client.page(context(), undefined, { maxBytes: failure === 'body-budget' ? 1 : 1024, exhaust() {} }), code(failure === 'body-budget' ? 'incomplete' : 'corrupt'));
  assert.equal(cleanup, 1); await client.close(); assert.equal(s.stats.requests, s.stats.socketCloses);
});
test('completed traversal missing M poisons even when SDK completion also observes caller abort', async t => {
  const { s, k } = await owned(t, 1); const abort = new AbortController(); let callbacks = 0;
  s.controls.hook = e => { if (e.path.includes(",RowKey='M'")) e.reply(); else { e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.end('{"value":[]}'); } };
  iteratorHook(t, { received() { abort.abort(); } });
  await assert.rejects(k.auditOwned({ ...visitor(), record() { callbacks++; } }, budget(), { signal: abort.signal }), code('unresolved'));
  assert.equal(callbacks, 0); assert.equal(k.status().lifecycle, 'poisoned'); await assert.rejects(k.close(), code('unresolved'));
});
test('active cancellation before the first run microtask retires prior audit permission without I/O', async t => {
  const { s, k } = await owned(t, 1); await k.scan(); await new Promise(r => setImmediate(r));
  const abort = new AbortController(); const requests = s.stats.requests;
  const audit = k.auditOwned(visitor(), budget(), { signal: abort.signal }); abort.abort();
  await assert.rejects(audit, code('incomplete')); assert.equal(s.stats.requests, requests); assert.equal(k.status().lifecycle, 'owned-unready');
  await assert.rejects(k.mutate(emptyInput, emptyPlan), code('unready')); await k.close();
});
test('already-aborted caller is not submitted; invalid inputs, missing ownership and closing do not create an audit', async t => {
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies); const abort = new AbortController(); abort.abort();
  await assert.rejects(k.auditOwned(visitor(), budget(), { signal: abort.signal }), code('not-submitted'));
  await assert.rejects(k.auditOwned(visitor(), budget()), code('unready')); assert.equal(s.stats.tokens, 0); assert.equal(k.status().pending, 0);
  const close = k.close(); await assert.rejects(k.auditOwned(visitor(), budget()), code('closed')); await close;
});
for (const format of [1, 2] as const) for (const pointBytes of [524288, 524289]) test(`V${format} M point allowance ${pointBytes} is separate from exact collection budget`, async t => {
  const { s, k } = await owned(t, format); const entity = JSON.stringify(s.rows.get('M')); const page = JSON.stringify({ value: [s.rows.get('M')] }); let points = 0;
  s.controls.hook = e => {
    e.res.writeHead(200, { 'content-type': 'application/json' });
    if (e.path.includes(",RowKey='M'")) { points++; e.res.end(entity + ' '.repeat(pointBytes - Buffer.byteLength(entity))); }
    else e.res.end(page);
  };
  const audit = k.auditOwned({ ...visitor(), passes: 2 }, budget({ maxPageBytes: 2 * Buffer.byteLength(page) }));
  if (pointBytes === 524288) { await audit; assert.equal(points, 4); }
  else { await assert.rejects(audit, code('unavailable')); assert.equal(points, 1); assert.equal(k.status().lifecycle, 'owned-unready'); }
  delete s.controls.hook; await k.close();
});
for (const format of [1, 2] as const) for (const boundary of [1, 2, 3, 4]) test(`V${format} authority drift at point ${boundary} fails closed without extra fence reads`, async t => {
  const { s, k } = await owned(t, format); let reads = 0; let records = 0; let ended = 0; let final = 0;
  s.controls.hook = e => {
    if (e.path.includes(",RowKey='M'") && ++reads === boundary) {
      const current = s.rows.get('M')!; const changed = { ...current, Invocation: '99999999-9999-4999-8999-999999999999' };
      s.rows.set('M', stamp({ ...changed, Digest: (format === 1 ? mDigest : mDigestV2)(changed) }, 999));
    }
    e.reply();
  };
  await assert.rejects(k.auditOwned({ passes: 2, record() { records++; }, endPass() { ended++; }, finalize() { final++; } }, budget()), code('unresolved'));
  assert.equal(reads, boundary); assert.equal(records, Math.floor(boundary / 2)); assert.equal(ended, Math.floor(boundary / 2)); assert.equal(final, 0);
  await assert.rejects(k.close(), code('unresolved'));
});
for (const callback of ['record', 'endPass', 'finalize'] as const) test(`duration is checked after synchronous ${callback} even before timers can fire`, async t => {
  const { s, k } = await owned(t, 1); let callbacks = 0; let later = 0; let points = 0;
  s.controls.hook = e => { if (e.path.includes(",RowKey='M'")) points++; e.reply(); };
  const v = { ...visitor(), record(): undefined { later++; }, endPass(): undefined { later++; }, finalize(): undefined { later++; }, [callback](): undefined {
    callbacks++; const entered = performance.now();
    while (performance.now() - entered < 1000) { /* Overrun from callback entry, strictly after admission. */ }
  } };
  await assert.rejects(k.auditOwned(v, budget({ maxDurationMs: 1000 })), code('incomplete'));
  assert.equal(callbacks, 1); assert.equal(later, callback === 'record' ? 0 : callback === 'endPass' ? 1 : 2);
  assert.equal(points, callback === 'finalize' ? 2 : 1); assert.equal(k.status().lifecycle, 'owned-unready'); delete s.controls.hook; await k.close();
});
test('audit snapshots own descriptor values without invoking property get traps', async t => {
  const { k } = await owned(t, 1); let gets = 0; let records = 0;
  const handler = { get() { gets++; throw new Error('private property get detail'); } };
  const v = new Proxy({ ...visitor(), record(): undefined { records++; } }, handler);
  const b = new Proxy(budget(), handler); const o = new Proxy({ requestTimeoutMs: 30000 }, handler);
  await k.auditOwned(v, b, o); assert.equal(gets, 0); assert.equal(records, 1); await k.close();
});
test('audit does not inspect callback function name, constructor or then properties', async t => {
  const { k } = await owned(t, 1); let calls = 0; let getters = 0; const callback = (): undefined => { calls++; };
  for (const key of ['name', 'constructor', 'then']) Object.defineProperty(callback, key, { get() { getters++; throw new Error('private function property'); } });
  await k.auditOwned({ passes: 1, record: callback, endPass: callback, finalize: callback }, budget());
  assert.equal(calls, 3); assert.equal(getters, 0); await k.close();
});
test('queued audit allocates tracking only when its FIFO job starts', async t => {
  const { s, k } = await owned(t, 1); const gate = deferred(); let held = false; let first = true;
  s.controls.hook = async e => { if (first) { first = false; held = true; await gate.promise; } e.reply(); };
  const read = k.read('M'); await eventually(() => held); const requests = s.stats.requests;
  const audit = k.auditOwned(visitor(), budget({ maxTrackingBytes: 1 }));
  assert.equal(k.status().pending, 2); assert.equal(s.stats.requests, requests); gate.resolve(); await read;
  await assert.rejects(audit, code('incomplete')); assert.equal(s.stats.requests, requests); delete s.controls.hook; await k.close();
});
test('fulfilled native Promise with throwing constructor still poisons; this does not test rejection handling', async t => {
  const { k } = await owned(t, 1);
  const invalidRecord = () => {
    const promise = Promise.resolve();
    Object.defineProperty(promise, 'constructor', { get() { throw new Error('private native reaction detail'); } });
    return promise;
  };
  // Deliberately violate the public return type to retain the runtime poison check.
  await assert.rejects(k.auditOwned({ ...visitor(), record: invalidRecord as unknown as () => undefined }, budget()), code('unresolved'));
  await assert.rejects(k.close(), code('unresolved'));
});
for (const reason of ['close', 'invalidate'] as const) test(`finalizer-scheduled ${reason} wins before FIFO publication`, async t => {
  const { k } = await owned(t, 1); let close: Promise<void> | undefined;
  await assert.rejects(k.auditOwned({ ...visitor(), finalize() {
    queueMicrotask(() => { if (reason === 'close') close = k.close(); else k.invalidate(); });
  } }, budget()), code(reason === 'close' ? 'incomplete' : 'unresolved'));
  if (close) await close; else await assert.rejects(k.close(), code('unresolved'));
});
test('request deadlines use the separate default and the original admission deadline after queue wait', async t => {
  const s = await tableService(t); const deadlines: number[] = []; let measuring = false;
  const k = createTableKernel(tableBinding, { ...s.dependencies, token: async (...args) => {
    if (measuring) deadlines.push(args[1].deadline - performance.now()); return s.dependencies.token(...args);
  } }, { callTimeoutMs: 1 });
  await k.initialize({ timeoutMs: 30000 }); await k.acquire({ timeoutMs: 30000 });
  measuring = true; await k.auditOwned(visitor(), budget({ maxDurationMs: 60000 })); measuring = false;
  assert.equal(deadlines.length, 3); assert.ok(deadlines.every(ms => ms > 29000 && ms <= 30000));
  deadlines.length = 0; const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (!held) { held = true; await gate.promise; } e.reply(); };
  const read = k.read('M', { timeoutMs: 30000 }); await eventually(() => held);
  const admitted = performance.now(); const audit = k.auditOwned(visitor(), budget({ maxDurationMs: 30000 }), { requestTimeoutMs: 300000 });
  await new Promise(r => setTimeout(r, 40)); measuring = true;
  const elapsed = performance.now() - admitted; gate.resolve(); await read; await audit;
  assert.equal(deadlines.length, 3); assert.ok(deadlines.every(ms => ms <= 30000 - elapsed + 1 && ms > 28000));
  delete s.controls.hook; measuring = false; await k.close();
});
test('second pass remains a fresh raw audit, not an unbudgeted cross-pass domain index', async t => {
  const { s, k } = await owned(t, 1); const row = putData(s); let records = 0;
  await k.auditOwned({ passes: 2, record() { records++; }, endPass(pass) { if (pass === 1) s.rows.delete(row); }, finalize() {} }, budget());
  assert.equal(records, 3); assert.equal(k.status().lifecycle, 'envelope-audited'); await k.close();
});
