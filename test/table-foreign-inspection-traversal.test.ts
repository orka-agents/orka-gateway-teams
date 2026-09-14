import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TableClient } from '@azure/data-tables';
import { createTableForeignInspectorV2, createTableKernel } from '../src/storage/table/index.js';
import { budget, code, emptyInput, putData, visitor, wireData } from './support/owned-audit.js';
import { foreign } from './support/foreign-inspection.js';
import { stamp, tableBinding, tableService } from './support/table-service.js';
import { mDigestV2 } from './support/table-v2.js';

for (const field of ['owner', 'epoch', 'mDigest', 'etag'] as const) test(`foreign frozen ${field} mismatch is unresolved before any page`, async t => {
  const f = await foreign(t);
  Object.assign(f.expected, { [field]: field === 'epoch' ? f.expected.epoch + 1 : field === 'owner' ? '99999999-9999-4999-8999-999999999999' : field === 'etag' ? '"different"' : '0'.repeat(64) });
  const i = f.create(); let records = 0;
  await assert.rejects(i.inspect({ ...visitor(), record() { records++; } }, budget()), code('unresolved'));
  assert.equal(f.stats.gets, 1); assert.equal(records, 0); assert.equal(i.status().lifecycle, 'failed'); await i.close(); f.unchanged();
});
for (const state of ['v1', 'owner-empty', 'epoch-zero', 'absent'] as const) test(`foreign inspector refuses ${state} M without adopting or writing`, async t => {
  const f = await foreign(t); const i = f.create();
  if (state === 'v1') {
    const old = await tableService(t); const owner = createTableKernel(tableBinding, old.dependencies);
    await owner.initialize(); await owner.acquire(); f.s.rows.set('M', old.rows.get('M')!);
  } else if (state === 'owner-empty') await f.owner.close();
  else if (state === 'epoch-zero') {
    const genesis = await tableService(t, 'delivery', 2);
    const { createTableKernelV2 } = await import('../src/storage/table/index.js');
    await createTableKernelV2(tableBinding, genesis.dependencies).initialize(); f.s.rows.set('M', genesis.rows.get('M')!);
  } else f.s.rows.delete('M');
  const before = f.s.stats.writes;
  await assert.rejects(i.inspect(visitor(), budget()), code('unresolved')); await i.close();
  assert.equal(f.stats.gets, 1); assert.equal(f.s.stats.writes, before);
});
for (const boundary of [1, 2, 3, 4]) test(`foreign authority drift at M point ${boundary} prevents later fences/finalizer`, async t => {
  const f = await foreign(t); const i = f.create(); let points = 0; let records = 0; let ended = 0; let final = 0;
  f.s.controls.hook = e => {
    if (e.path.includes(",RowKey='M'") && ++points === boundary) {
      const changed = { ...f.s.rows.get('M'), Invocation: '99999999-9999-4999-8999-999999999999' };
      f.s.rows.set('M', stamp({ ...changed, Digest: mDigestV2(changed) }, 999));
    }
    e.reply();
  };
  await assert.rejects(i.inspect({ passes: 2, record() { records++; }, endPass() { ended++; }, finalize() { final++; } }, budget()), code('unresolved'));
  assert.equal(points, boundary); assert.equal(records, Math.floor(boundary / 2)); assert.equal(ended, Math.floor(boundary / 2)); assert.equal(final, 0);
  await i.close(); f.unchanged();
});
for (const fault of ['cycle', 'order', 'missing', 'duplicate', 'drift', 'raw-digest', 'raw-binding', 'raw-type', 'duplicate-json', 'row-only', 'oversize-cursor'] as const)
  test(`foreign traversal ${fault} fails closed through actual raw decoder`, async t => {
    const f = await foreign(t); const i = f.create(); const row = putData(f.s); let pages = 0; let callbacks = 0;
    f.s.controls.hook = e => {
      if (e.path.includes(",RowKey='M'")) { e.reply(); return; } pages++;
      const more = ['cycle', 'order', 'duplicate', 'row-only', 'oversize-cursor'].includes(fault);
      const entity = { ...f.s.rows.get(fault === 'order' ? row : 'M') };
      if (fault === 'raw-digest') entity.Digest = '0'.repeat(64);
      if (fault === 'raw-binding') entity.Binding = Buffer.from('other binding').toString('base64');
      if (fault === 'raw-type') entity['Epoch@odata.type'] = 'Edm.Int32';
      if (fault === 'drift') { entity.Invocation = '99999999-9999-4999-8999-999999999999'; entity.Digest = mDigestV2(entity); }
      e.res.writeHead(200, { 'content-type': 'application/json', ...(more ? {
        ...(fault === 'row-only' ? {} : { 'x-ms-continuation-nextpartitionkey': fault === 'oversize-cursor' ? 'p'.repeat(2049) : 'opaque' }),
        'x-ms-continuation-nextrowkey': fault === 'cycle' ? 'same' : String(pages),
      } : {}) });
      e.res.end(fault === 'duplicate-json' ? '{"value":[],"value":[]}' : JSON.stringify({ value: fault === 'missing' || fault === 'cycle' ? [] : [entity] }));
    };
    const incomplete = ['cycle', 'order', 'row-only'].includes(fault);
    await assert.rejects(i.inspect({ ...visitor(), record() { callbacks++; } }, budget()), code(incomplete ? 'incomplete' : 'unresolved'));
    assert.equal(pages, ['cycle', 'order', 'duplicate'].includes(fault) ? 2 : 1); assert.equal(callbacks <= 1, true);
    assert.equal(i.status().lifecycle, 'failed'); await i.close(); f.unchanged();
  });
test('foreign empty continuation pages are counted and serial; separate exact fences surround both passes', async t => {
  const f = await foreign(t); const i = f.create(); const trace: string[] = []; let pages = 0;
  f.s.controls.hook = e => {
    if (e.path.includes(",RowKey='M'")) { trace.push('point'); e.reply(); return; } pages++; trace.push('page');
    e.res.writeHead(200, { 'content-type': 'application/json', ...(pages % 2 === 1 ? { 'x-ms-continuation-nextpartitionkey': 'opaque', 'x-ms-continuation-nextrowkey': 'M' } : {}) });
    e.res.end(JSON.stringify({ value: pages % 2 === 1 ? [] : [f.s.rows.get('M')] }));
  };
  await i.inspect({ passes: 2, record(pass) { assert.equal(pages, pass * 2); trace.push('record'); }, endPass() { trace.push('end'); }, finalize() { trace.push('final'); } }, budget({ maxPages: 4 }));
  assert.equal(JSON.stringify(trace) === JSON.stringify(['point', 'page', 'page', 'record', 'end', 'point', 'point', 'page', 'page', 'record', 'end', 'point', 'final']), true);
  await i.close(); assert.equal(f.stats.gets, 8); f.unchanged();
});
test('observed missing M dominates cancellation at public SDK completion', async t => {
  const f = await foreign(t); const i = f.create(); const abort = new AbortController(); let callbacks = 0;
  f.s.controls.hook = e => {
    if (e.path.includes(",RowKey='M'")) e.reply();
    else { e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.end('{"value":[]}'); }
  };
  const list = TableClient.prototype.listEntities;
  t.mock.method(TableClient.prototype, 'listEntities', function(this: TableClient, ...args: Parameters<typeof list>) {
    const entities = list.apply(this, args); const byPage = entities.byPage.bind(entities);
    entities.byPage = settings => { const pages = byPage(settings); const next = pages.next.bind(pages);
      pages.next = async () => { const result = await next(); abort.abort(); return result; }; return pages; };
    return entities;
  });
  await assert.rejects(i.inspect({ ...visitor(), record() { callbacks++; } }, budget(), { signal: abort.signal }), code('unresolved'));
  assert.equal(callbacks, 0); assert.equal(f.stats.gets, 2); await i.close(); f.unchanged();
});
test('copied foreign records and receipts cannot change later observations or the frozen fence', async t => {
  const f = await foreign(t); await f.owner.scan();
  await f.owner.mutate(emptyInput, () => ({ state: Buffer.from('state'), result: Buffer.from('result'), actions: [] }));
  await f.owner.close();
  const { createTableKernelV2 } = await import('../src/storage/table/index.js');
  const owner = createTableKernelV2(f.binding, f.s.dependencies); await owner.acquire(); const control = await owner.read('M');
  if (!control || control.value.kind !== 'metadata') throw new Error('Fixture metadata missing');
  const m = control.value; const i = createTableForeignInspectorV2(f.binding, f.dependencies, {
    initId: m.initId, initDigest: m.initDigest, owner: m.owner, epoch: m.epoch, mDigest: m.digest, etag: control.etag,
  });
  putData(f.s); const before = f.s.stats.writes; let records = 0;
  await i.inspect({ passes: 2, record(_pass, record) {
    records++;
    if (record.value.kind === 'metadata') {
      assert.equal(record.value.state.equals(Buffer.from('state')), true); assert.equal(record.value.result.equals(Buffer.from('result')), true);
      assert.equal(record.value.exit?.oldEpoch === 1, true); record.value.exit!.oldEpoch = 99;
      record.value.state.fill(0); record.value.result.fill(0); record.value.owner = ''; record.value.digest = '0'.repeat(64);
    } else { assert.equal(record.value.payload.equals(Buffer.from('audit payload')), true); record.value.payload.fill(0); }
  }, endPass() {}, finalize() {} }, budget());
  assert.equal(records, 4); await i.close(); assert.equal(f.s.stats.writes, before);
});
for (const failure of ['token', 'response'] as const) test(`foreign ${failure} failure is unavailable without exposing raw exceptions or writing`, async t => {
  const f = await foreign(t); let callbacks = 0;
  const dependencies = failure === 'token' ? { ...f.dependencies, token: async () => { throw new Error('private token dependency'); } } : f.dependencies;
  if (failure === 'response') f.s.controls.hook = e => { e.res.writeHead(503, { 'content-type': 'application/json' }); e.res.end('{"private":"service detail"}'); };
  const i = createTableForeignInspectorV2(f.binding, dependencies, f.expected);
  await assert.rejects(i.inspect({ ...visitor(), record() { callbacks++; } }, budget()), code('unavailable'));
  assert.equal(callbacks, 0); assert.equal(f.stats.gets, failure === 'token' ? 0 : 1); assert.equal(i.status().lifecycle, 'failed');
  await i.close(); f.unchanged();
});
test('a bounded test visitor, not generic two-pass inspection, rejects its domain membership drift', async t => {
  const f = await foreign(t); const row = putData(f.s); const i = f.create(); let first = 0; let second = 0; let finalized = false;
  await assert.rejects(i.inspect({ passes: 2, record(pass, r) {
    if (r.value.kind === 'data') { if (pass === 1) first++; else second++; }
  }, endPass(pass) {
    if (pass === 1) f.s.rows.delete(row);
    else if (first !== second) throw new Error('private domain mismatch');
  }, finalize() { finalized = true; } }, budget()), code('unresolved'));
  assert.equal(first, 1); assert.equal(second, 0); assert.equal(finalized, false); await i.close(); f.unchanged();
});
test('envelope inspection deliberately accepts raw-valid opaque domain data and changing cross-pass membership/versions', async t => {
  const f = await foreign(t); const i = f.create(); const removed = putData(f.s); const changed = wireData('other', Buffer.from([255, 0, 1]));
  f.s.rows.set(String(changed.RowKey), changed); const counts = [0, 0]; let final = false;
  await i.inspect({ passes: 2, record(pass, r) { if (r.value.kind === 'data') counts[pass - 1] = counts[pass - 1]! + 1; },
    endPass(pass) { if (pass === 1) { f.s.rows.delete(removed); f.s.rows.set(String(changed.RowKey), stamp(wireData('other', Buffer.from('not a domain object')), 999)); } },
    finalize() { final = true; } }, budget());
  assert.equal(counts[0], 2); assert.equal(counts[1], 1); assert.equal(final, true); assert.equal(i.status().lifecycle, 'completed'); await i.close(); f.unchanged();
});
