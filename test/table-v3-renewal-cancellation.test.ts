import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableKernelV3 } from '../src/storage/table/index.js';
import type { TableError } from '../src/storage/table/types.js';
import { deferred, eventually, syntheticToken, tableBinding, tableService } from './support/table-service.js';
import { TestClock } from './support/table-v3.js';

const code = (want: string) => (error: unknown) => error instanceof Error && (error as TableError).code === want;
const tick = () => new Promise(resolve => setImmediate(resolve));
const budget = { maxPages: 10, maxPageBytes: 1024 * 1024, maxDurationMs: 10000, maxTrackingBytes: 1024 * 1024 };
type Path = 'read' | 'audit-authority' | 'scan-checkpoint' | 'audit-checkpoint';
async function heldRenewal(t: Parameters<typeof tableService>[0], path: Path) {
  const s = await tableService(t, 'delivery', 3); const clock = new TestClock(); const gate = deferred();
  const checkpoint = path.endsWith('checkpoint'); let due = false; let calls = 0; let held = false;
  const k = createTableKernelV3(tableBinding, { ...s.dependencies, leaseClock: clock, token: async (scope, context) => {
    // Authority already has M; checkpoints first fetch it, then request the write token.
    if (due && ++calls === (checkpoint ? 2 : 1)) { held = true; await gate.promise; return syntheticToken; }
    return s.dependencies.token(scope, context);
  } }, { callTimeoutMs: 300000, cleanupTimeoutMs: 300000 });
  t.after(() => { gate.resolve(); return k.close().catch(() => {}); });
  await k.initialize(); await k.acquire(); await k.scan();
  await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state: Buffer.from('retained'), result: Buffer.from('receipt'),
    actions: [{ kind: 'create', key: { type: 'delivery', id: 'one' }, payload: Buffer.from('one') }] }));
  const before = structuredClone(s.rows.get('M')!); const writes = s.stats.writes; const abort = new AbortController(); let finalized = false;
  let renewed: Record<string, unknown> | undefined;
  s.controls.hook = e => {
    e.reply();
    const current = s.rows.get('M');
    if (e.actions.length && current?.Lease && JSON.parse(Buffer.from(String(current.Lease), 'base64').toString()).sequence === 2) renewed = structuredClone(current);
    if (!due && e.req.method === 'GET' && e.path.includes("RowKey='") !== checkpoint) { due = true; clock.advance(40000, false); }
  };
  const audit = () => k.auditOwned({ passes: 1, record() {}, endPass() {}, finalize() { finalized = true; } }, budget, { signal: abort.signal });
  const operation = path === 'read' ? k.read('M', { signal: abort.signal }) : path === 'scan-checkpoint' ? k.scan({ signal: abort.signal }) : audit();
  let settled = false;
  const outcome = operation.then(() => 'success', (error: TableError) => error.code).finally(() => { settled = true; });
  await eventually(() => held);
  return { s, k, clock, gate, before, writes, abort, outcome, settled: () => settled, finalized: () => finalized, renewed: () => renewed };
}
for (const path of ['read', 'audit-authority', 'scan-checkpoint', 'audit-checkpoint'] as const) {
  test(`V3 ${path} cancellation drains independent renewal and still releases cleanly`, async t => {
    const { s, k, gate, before, writes, abort, outcome, settled, finalized, renewed } = await heldRenewal(t, path);
    abort.abort(); await tick();
    // Legacy callers may reject early, but the actual FIFO slot must still be held.
    assert.equal(k.status().pending, 1);
    if (path.startsWith('audit')) assert.equal(settled(), false);
    let closed = false; const closing = k.close().finally(() => { closed = true; });
    // Attach rejection handling before exercising the old failing implementation.
    const closedResult = closing.then(() => 'released', () => 'unresolved');
    await tick(); assert.equal(closed, false); assert.equal(s.stats.writes, writes);
    gate.resolve();
    assert.equal(await outcome, path.startsWith('audit') ? 'incomplete' : 'unavailable');
    assert.equal(await closedResult, 'released'); assert.equal(k.leaseAuthority().lost.aborted, false);
    const lease = renewed(); assert.ok(lease);
    for (const key of ['Owner', 'Epoch', 'Operation', 'Invocation', 'Plan', 'State', 'Result', 'Exit']) assert.equal(lease[key], before[key]);
    const after = s.rows.get('M')!; assert.equal(after.Owner, ''); assert.equal(after.Operation, 'release'); assert.equal(after.Lease, '');
    for (const key of ['Epoch', 'State', 'Result']) assert.equal(after[key], before[key]);
    assert.equal(s.stats.writes, writes + 2); assert.equal(finalized(), false);
    assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
  });
}
for (const path of ['read', 'audit-checkpoint'] as const) {
  test(`V3 ${path} independent renewal remains fail-closed when original authority expires`, async t => {
    const { s, k, clock, gate, before, writes, abort, outcome } = await heldRenewal(t, path);
    abort.abort(); clock.advance(74000); assert.equal(k.leaseAuthority().lost.aborted, true);
    let closed = false; const closing = k.close().finally(() => { closed = true; });
    const failed = assert.rejects(closing, code('unresolved'));
    await tick(); assert.equal(closed, false); gate.resolve();
    assert.notEqual(await outcome, 'success'); await failed;
    assert.equal(k.leaseAuthority().allowed(), false); assert.equal(s.stats.writes, writes);
    for (const key of ['Owner', 'Epoch', 'Lease', 'State', 'Result', 'Exit']) assert.equal(s.rows.get('M')?.[key], before[key]);
    assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
  });
}
