import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { bindTable } from '../src/storage/table/codec.js';
import { OwnedTableClient } from '../src/storage/table/client.js';
import { createTableKernel, TableError } from '../src/storage/table/index.js';
import type { CallOptions } from '../src/storage/table/types.js';
import { context, tableBinding, tableService } from './support/table-service.js';

const forms = ['empty', 'html', 'malformed-json'] as const;
const code = (expected: string) => (error: unknown) => error instanceof TableError && error.code === expected && !('cause' in error);
const input = () => ({ input: Buffer.alloc(0), keys: [] });
const plan = () => ({ state: Buffer.alloc(0), result: Buffer.alloc(0), actions: [] });
function errorResponse(res: ServerResponse, status: number, form: typeof forms[number]): void {
  if (form === 'empty') { res.writeHead(status); res.end(); }
  else { res.writeHead(status, { 'content-type': form === 'html' ? 'text/html' : 'application/json' }); res.end(form === 'html' ? '<p>Unavailable</p>' : '{'); }
}
async function owned(t: Parameters<typeof tableService>[0]) {
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies);
  // Explicit success assertions below check release; cleanup also drains failed RED cases.
  t.after(async () => { delete s.controls.hook; await k.close().catch(() => {}); });
  await k.initialize(); await k.acquire(); await k.scan(); return { s, k };
}
for (const status of [404, 429, 503]) for (const form of forms)
  test(`non-success ${status}/${form} point and page responses are unavailable, not corrupt or absent`, async t => {
    const s = await tableService(t); const client = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
    t.after(() => client.close()); s.controls.hook = e => errorResponse(e.res, status, form);
    await assert.rejects(client.read('M', context()), code('unavailable'));
    await assert.rejects(client.page(context()), code('unavailable'));
    await client.close(); assert.equal(s.stats.requests, 2); assert.equal(s.stats.tokens, 2);
    assert.equal(s.stats.requestCloses, 2); assert.equal(s.stats.socketCloses, 2);
  });
for (const status of [429, 503]) for (const form of forms)
  test(`transient ${status}/${form} authority failure preserves healthy ownership and clean release`, async t => {
    const { s, k } = await owned(t); const before = s.stats.requests;
    s.controls.hook = e => errorResponse(e.res, status, form);
    await assert.rejects(k.read('M'), code('unavailable'));
    assert.equal(s.stats.requests - before, 1); assert.equal(k.status().lifecycle, 'envelope-audited');
    assert.equal(k.status().ownership, 'owned'); assert.equal(k.status().pending, 0);
    delete s.controls.hook; assert.equal((await k.mutate(input(), plan)).kind, 'committed');
    await k.close(); assert.equal(s.rows.get('M')?.Owner, '');
    assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
  });
for (const status of [404, 429, 503]) for (const form of forms)
  test(`lost ACK reconciliation continues after one ${status}/${form} read without resubmitting`, async t => {
    const { s, k } = await owned(t); let submitted = false; let writes = 0; let reads = 0; let barriers = 0;
    s.controls.hook = e => {
      const operation = e.actions[0]?.entity.Operation;
      if (operation === 'mutate') { writes++; e.commit(); submitted = true; e.res.destroy(); }
      else if (submitted && e.req.method === 'GET' && reads++ === 0) errorResponse(e.res, status, form);
      else { if (operation === 'barrier') barriers++; e.reply(); }
    };
    assert.equal((await k.mutate(input(), plan)).kind, 'committed');
    assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(barriers, 0);
    assert.equal(k.status().lifecycle, 'envelope-audited'); assert.equal(k.status().pending, 0);
    delete s.controls.hook; await k.close(); assert.equal(s.rows.get('M')?.Owner, '');
    assert.equal(s.stats.requests, s.stats.socketCloses);
  });
for (const form of forms)
  test(`malformed successful ${form} payloads still fail corrupt and poison owned authority`, async t => {
    const { s, k } = await owned(t); const client = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
    t.after(() => client.close()); const writes = s.stats.writes;
    s.controls.hook = e => errorResponse(e.res, 200, form);
    await assert.rejects(client.read('M', context()), code('corrupt'));
    await assert.rejects(client.page(context()), code('corrupt'));
    await assert.rejects(k.read('M'), code('unresolved')); assert.equal(k.status().lifecycle, 'poisoned');
    await assert.rejects(k.close(), code('unresolved')); await client.close();
    assert.equal(s.stats.writes, writes); assert.equal(s.stats.requests, s.stats.socketCloses);
  });
for (const operation of ['initialize', 'acquire', 'read', 'scan', 'mutate'] as const)
  test(`${operation} rejects every supplied non-object options value before admission or I/O`, async t => {
    const { s, k } = await owned(t); const before = s.stats.requests;
    for (const invalid of [null, false, 0, -0, NaN, '', 0n, true, 1, 'invalid', []]) {
      const options = invalid as unknown as CallOptions;
      const result = operation === 'read' ? k.read('M', options) : operation === 'mutate' ? k.mutate(input(), plan, options) : k[operation](options);
      await assert.rejects(result, code('invalid-input'));
      assert.equal(k.status().pending, 0); assert.equal(k.status().pendingBytes, 0);
    }
    assert.equal(s.stats.requests, before); assert.equal(k.status().lifecycle, 'envelope-audited');
    await k.close(); assert.equal(s.rows.get('M')?.Owner, '');
  });
test('omitted, undefined and empty-object options retain normal defaults', async t => {
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies);
  t.after(async () => { await k.close().catch(() => {}); });
  await k.initialize(undefined); await k.acquire({}); await k.scan();
  assert.equal((await k.read('M', undefined))?.value.kind, 'metadata');
  assert.equal((await k.mutate(input(), plan, {})).kind, 'committed');
  await k.close(); assert.equal(s.rows.get('M')?.Owner, '');
});
