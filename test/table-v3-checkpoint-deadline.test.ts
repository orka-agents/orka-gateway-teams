import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableKernelV3 } from '../src/storage/table/index.js';
import { tableBinding, tableService } from './support/table-service.js';
import { TestClock } from './support/table-v3.js';

test('V3 audit page gets its request budget after independent checkpoint renewal drains', async t => {
  const s = await tableService(t, 'delivery', 3); const clock = new TestClock(); let due = false; let calls = 0;
  const now = performance.now.bind(performance); let elapsed = 0;
  const k = createTableKernelV3(tableBinding, { ...s.dependencies, leaseClock: clock, token: async (scope, context) => {
    if (due && ++calls === 2) {
      // Six seconds elapse inside renewal, exceeding the not-yet-started page's
      // five-second request budget, but not the lease or total audit deadline.
      elapsed = 6000; clock.advance(6000, false);
    }
    return s.dependencies.token(scope, context);
  } });
  t.after(() => k.close().catch(() => {})); await k.initialize(); await k.acquire(); await k.scan();
  await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state: Buffer.alloc(0), result: Buffer.alloc(0),
    actions: [{ kind: 'create', key: { type: 'delivery', id: 'one' }, payload: Buffer.from('one') }] }));
  t.mock.method(performance, 'now', () => now() + elapsed);
  s.controls.hook = e => {
    e.reply(); if (!due && e.req.method === 'GET' && !e.path.includes("RowKey='")) { due = true; clock.advance(40000, false); }
  };
  let records = 0; let finalized = false;
  try {
    await k.auditOwned({ passes: 1, record() { records++; }, endPass() {}, finalize() { finalized = true; } },
      { maxPages: 10, maxPageBytes: 1024 * 1024, maxDurationMs: 300000, maxTrackingBytes: 1024 * 1024 }, { requestTimeoutMs: 5000 });
    assert.equal(elapsed, 6000); assert.equal(records, 2); assert.equal(finalized, true);
    assert.equal(k.status().lifecycle, 'envelope-audited'); assert.equal(k.leaseAuthority().lost.aborted, false);
  } finally { t.mock.restoreAll(); delete s.controls.hook; }
  await k.close(); assert.equal(s.rows.get('M')?.Owner, '');
  assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});
