import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import * as api from '../src/storage/table/index.js';
import type { OwnedAuditVisitor, StoredRecord, StoredRecordV2 } from '../src/storage/table/index.js';
import { budget, code, emptyInput, emptyPlan, owned, putData, visitor } from './support/owned-audit.js';
import { deferred, eventually, mDigest } from './support/table-service.js';
import { mDigestV2 } from './support/table-v2.js';

for (const format of [1, 2] as const) {
  for (const passes of [1, 2] as const) test(`V${format} audit ${passes} passes has exact separate M fences, synchronous records and finalization`, async t => {
    const { s, k } = await owned(t, format); const row = putData(s); const trace: string[] = [];
    s.controls.hook = e => { trace.push(e.path.includes(",RowKey='M'") ? 'M' : 'page'); e.reply(); };
    await k.auditOwned({ passes, record(pass, record) {
      assert.equal(this, undefined); assert.equal(k.status().lifecycle, 'owned-unready'); trace.push(String(pass) + ':' + record.row);
    }, endPass(pass) { assert.equal(this, undefined); trace.push('end' + pass); }, finalize() {
      assert.equal(this, undefined); trace.push('finalize'); assert.equal(k.status().lifecycle, 'owned-unready');
    } }, budget());
    const passTrace = (p: number) => ['M', 'page', p + ':M', 'page', p + ':' + row, 'end' + p, 'M'];
    assert.deepEqual(trace, [...passTrace(1), ...(passes === 2 ? passTrace(2) : []), 'finalize']);
    assert.equal(k.status().lifecycle, 'envelope-audited'); delete s.controls.hook; await k.close();
  });
  test(`V${format} independent audit snapshots cannot mutate authoritative M, payload or receipts`, async t => {
    const { s, k } = await owned(t, format); await k.scan();
    await k.mutate(emptyInput, () => ({ state: Buffer.from('state'), result: Buffer.from('result'), actions: [] }));
    await k.close(); const next = (format === 1 ? api.createTableKernel : api.createTableKernelV2)(
      { account: 'Example123', table: 'Journal', kind: 'delivery', storeId: 'stable', scope: { appId: 'App', tenantId: 'Tenant' } }, s.dependencies);
    await next.acquire(); putData(s); let records = 0;
    await next.auditOwned({ passes: 2, record(_pass, record) {
      records++;
      if (record.value.kind === 'metadata') {
        assert.equal(record.value.state.toString(), 'state'); assert.equal(record.value.result.toString(), 'result');
        record.value.state.fill(0); record.value.result.fill(0); record.value.digest = '0'.repeat(64);
        if ('release' in record.value) { assert.ok(record.value.release.length); record.value.release.fill(0); }
        else { assert.equal(record.value.exit?.oldEpoch, 1); record.value.exit!.oldEpoch = 99; }
      } else { assert.equal(record.value.payload.toString(), 'audit payload'); record.value.payload.fill(0); }
    }, endPass() {}, finalize() {} }, budget());
    assert.equal(records, 4); await next.mutate(emptyInput, emptyPlan); await next.close();
  });
  for (const limit of ['maxPages', 'maxPageBytes'] as const) test(`V${format} ${limit} is cumulative across passes, with exact boundary success`, async t => {
    const { s, k } = await owned(t, format); const body = JSON.stringify({ value: [s.rows.get('M')] }); let pages = 0; let reads = 0;
    s.controls.hook = e => {
      if (e.path.includes(",RowKey='M'")) { reads++; e.reply(); }
      else { pages++; e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.end(body); }
    };
    const exact = limit === 'maxPages' ? 2 : 2 * Buffer.byteLength(body);
    await assert.rejects(k.auditOwned({ ...visitor(), passes: 2 }, budget({ [limit]: exact - 1 })), code('incomplete'));
    assert.equal(k.status().lifecycle, 'owned-unready'); assert.equal(pages, limit === 'maxPages' ? 1 : 2); assert.equal(reads, 3);
    pages = 0; reads = 0; await k.auditOwned({ ...visitor(), passes: 2 }, budget({ [limit]: exact }));
    assert.equal(pages, 2); assert.equal(reads, 4); delete s.controls.hook; await k.close();
  });
  for (const fault of ['cycle', 'order', 'missing', 'duplicate', 'drift', 'corrupt'] as const) test(`V${format} traversal ${fault} disposition never permits partial readiness`, async t => {
    const { s, k } = await owned(t, format); const row = putData(s); let pages = 0; let reads = 0; let callbacks = 0;
    s.controls.hook = e => {
      if (e.path.includes(",RowKey='M'")) { reads++; e.reply(); return; }
      pages++; const more = (fault === 'cycle' || fault === 'order' || fault === 'duplicate') && pages < 3;
      const entity = fault === 'order' ? s.rows.get(row) : s.rows.get('M');
      if (fault === 'corrupt') entity!.Digest = '0'.repeat(64);
      if (fault === 'drift') {
        const changed = { ...entity, Invocation: '99999999-9999-4999-8999-999999999999' };
        entity!.Digest = (format === 1 ? mDigest : mDigestV2)(changed); entity!.Invocation = changed.Invocation;
      }
      e.res.writeHead(200, { 'content-type': 'application/json', ...(more ? {
        'x-ms-continuation-nextpartitionkey': 'opaque', 'x-ms-continuation-nextrowkey': fault === 'cycle' ? 'same' : String(pages),
      } : {}) });
      e.res.end(JSON.stringify({ value: fault === 'missing' || fault === 'cycle' ? [] : [entity] }));
    };
    const poison = ['missing', 'duplicate', 'drift', 'corrupt'].includes(fault);
    await assert.rejects(k.auditOwned({ ...visitor(), record() { callbacks++; } }, budget()), code(poison ? 'unresolved' : 'incomplete'));
    assert.equal(k.status().lifecycle, poison ? 'poisoned' : 'owned-unready'); assert.equal(reads, 1); assert.equal(pages, ['cycle', 'order', 'duplicate'].includes(fault) ? 2 : 1); assert.ok(callbacks <= 1);
    delete s.controls.hook; if (poison) await assert.rejects(k.close(), code('unresolved')); else await k.close();
  });
  test(`V${format} empty continuation pages count and continue; no prefetch precedes callbacks`, async t => {
    const { s, k } = await owned(t, format); let pages = 0;
    s.controls.hook = e => {
      if (e.path.includes(",RowKey='M'")) { e.reply(); return; } pages++;
      e.res.writeHead(200, { 'content-type': 'application/json', ...(pages % 2 === 1 ? { 'x-ms-continuation-nextpartitionkey': 'opaque', 'x-ms-continuation-nextrowkey': 'M' } : {}) });
      e.res.end(JSON.stringify({ value: pages % 2 === 1 ? [] : [s.rows.get('M')] }));
    };
    await k.auditOwned({ ...visitor(), passes: 2, record(pass) { assert.equal(pages, pass * 2); } }, budget({ maxPages: 4 }));
    assert.equal(pages, 4); delete s.controls.hook; await k.close();
  });
}

for (const field of ['maxPages', 'maxPageBytes', 'maxDurationMs', 'maxTrackingBytes'] as const) {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) test(`audit rejects invalid ${field} scalar ${String(value)} without admission`, async t => {
    const { s, k } = await owned(t, 1); const before = k.status(); const tokens = s.stats.tokens;
    await assert.rejects(k.auditOwned(visitor(), budget({ [field]: value })), code('invalid-input'));
    assert.deepEqual(k.status(), before); assert.equal(s.stats.tokens, tokens); await k.close();
  });
}
test('audit validates closed own-data required descriptors without invoking getters', async t => {
  const { s, k } = await owned(t, 1); const before = k.status(); const tokens = s.stats.tokens; let getters = 0;
  const getter = { get maxPages() { getters++; return 1; } };
  const missingBudget = budget(); Reflect.deleteProperty(missingBudget, 'maxPages');
  const hidden = Object.defineProperty(budget(), 'maxPages', { value: 1, enumerable: false });
  const cases: [unknown, unknown, unknown][] = [
    [visitor(), getter, undefined], [visitor(), missingBudget, undefined], [visitor(), hidden, undefined],
    [visitor(), { ...budget(), extra: 1 }, undefined], [Object.create(visitor()), budget(), undefined],
    [{ ...visitor(), get record() { getters++; return () => {}; } }, budget(), undefined],
    [{ passes: 1, record() {}, endPass() {} }, budget(), undefined], [{ ...visitor(), finalize: 1 }, budget(), undefined],
    [{ ...visitor(), passes: 3 }, budget(), undefined], [{ ...visitor(), [Symbol('extra')]: 1 }, budget(), undefined],
    [visitor(), budget(), { timeoutMs: 1 }], [visitor(), budget(), { signal: {} }],
    [visitor(), budget(), { signal: Object.create(AbortSignal.prototype) }],
    [visitor(), budget(), { get requestTimeoutMs() { getters++; return 1; } }],
    [visitor(), budget(), { requestTimeoutMs: 0 }], [visitor(), budget(), { requestTimeoutMs: 300001 }], [visitor(), budget(), { requestTimeoutMs: null }],
    [visitor(), budget({ maxDurationMs: 2147483648 }), undefined], [visitor(), budget({ maxTrackingBytes: 268435457 }), undefined],
  ];
  for (const [v, b, o] of cases) await assert.rejects(k.auditOwned(v as api.OwnedAuditVisitor & api.OwnedAuditVisitorV2, b as api.OwnedAuditBudget, o as api.OwnedAuditOptions), code('invalid-input'));
  assert.equal(getters, 0); assert.equal(s.stats.tokens, tokens); assert.deepEqual(k.status(), before); await k.close();
});
test('null-prototype inputs and engineering ceilings work on small fixtures independently of legacy scan/call limits', async t => {
  const { s, k: initial } = await owned(t, 1); await initial.close();
  const k = api.createTableKernel({ account: 'Example123', table: 'Journal', kind: 'delivery', storeId: 'stable', scope: { appId: 'App', tenantId: 'Tenant' } },
    s.dependencies, { scanBytes: 1, scanPages: 1, callTimeoutMs: 1 });
  await k.acquire({ timeoutMs: 30000 });
  const v = Object.assign(Object.create(null), visitor()); const b = Object.assign(Object.create(null), budget({
    maxPages: Number.MAX_SAFE_INTEGER, maxPageBytes: Number.MAX_SAFE_INTEGER, maxDurationMs: 2147483647, maxTrackingBytes: 268435456,
  }));
  putData(s); await k.auditOwned(v, b, Object.assign(Object.create(null), { requestTimeoutMs: 300000 }));
  await assert.rejects(k.scan({ timeoutMs: 30000 }), code('incomplete')); await k.close();
});
test('queued audit snapshots scalars and callback references, not the caller visitor object', async t => {
  const { s, k } = await owned(t, 1); const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (!held) { held = true; await gate.promise; } e.reply(); };
  const first = k.read('M'); await eventually(() => held); let callbacks = 0;
  const v = { ...visitor(), record(): undefined { callbacks++; } }; const b = budget(); const o = { requestTimeoutMs: 30000 };
  const audit = k.auditOwned(v, b, o); v.record = () => { throw new Error('private callback detail'); }; b.maxPages = 1; b.maxPageBytes = 1; o.requestTimeoutMs = 0;
  gate.resolve(); await first; await audit; assert.equal(callbacks, 1); delete s.controls.hook; await k.close();
});
for (const callback of ['record', 'endPass', 'finalize'] as const) for (const failure of ['sentinel', 'error', 'incomplete', 'value', 'thenable', 'return-promise', 'throw-promise', 'cross-realm', 'throw-cross-realm'] as const)
  test(`audit ${callback} ${failure} is contained and classified without assimilating callbacks`, async t => {
    const { k } = await owned(t, 1); let getter = 0;
    const callbackValue = () => {
      if (failure === 'sentinel') throw api.OWNED_AUDIT_BUDGET_EXHAUSTED;
      if (failure === 'error') throw new Error('private callback detail');
      if (failure === 'incomplete') throw new api.TableError('incomplete');
      if (failure === 'value') return 1;
      if (failure === 'thenable') return { get then() { getter++; throw new Error('private then detail'); } };
      const p: Promise<never> = failure === 'cross-realm' || failure === 'throw-cross-realm' ? runInNewContext('Promise.reject(new Error("private realm detail"))') : Promise.reject(new Error('private promise detail'));
      Object.defineProperty(p, 'then', { get() { getter++; throw new Error('private then detail'); } });
      if (failure === 'throw-promise' || failure === 'throw-cross-realm') throw p; return p;
    };
    const v = { ...visitor(), [callback]: callbackValue } as unknown as OwnedAuditVisitor & api.OwnedAuditVisitorV2;
    await assert.rejects(k.auditOwned(v, budget()), code(failure === 'sentinel' ? 'incomplete' : 'unresolved'));
    await new Promise(r => setImmediate(r)); assert.equal(getter, 0);
    if (failure === 'sentinel') await k.close(); else await assert.rejects(k.close(), code('unresolved'));
  });
for (const operation of ['initialize', 'acquire', 'read', 'scan', 'mutate', 'auditOwned', 'close'] as const) test(`caught callback reentrancy into ${operation} throws synchronously and poisons`, async t => {
  const { k } = await owned(t, 1); let caught = false;
  await assert.rejects(k.auditOwned({ ...visitor(), record() {
    try {
      if (operation === 'read') k.read(null as never);
      else if (operation === 'mutate') k.mutate(null as never, null as never);
      else if (operation === 'auditOwned') k.auditOwned(null as never, null as never);
      else k[operation]();
    } catch (e) { caught = code('unresolved')(e); }
  } }, budget()), code('unresolved'));
  assert.equal(caught, true); assert.equal(k.status().pending, 0); await assert.rejects(k.close(), code('unresolved'));
});
test('status and invalidate are permitted callbacks; invalidation prevents every later boundary', async t => {
  const { s, k } = await owned(t, 1); putData(s); let callbacks = 0; const requests = s.stats.requests;
  await assert.rejects(k.auditOwned({ ...visitor(), record() { callbacks++; assert.equal(k.status().ownership, 'owned'); k.invalidate(); },
    endPass() { callbacks++; }, finalize() { callbacks++; } }, budget()), code('unresolved'));
  assert.equal(callbacks, 1); assert.equal(s.stats.requests - requests, 2); await assert.rejects(k.close(), code('unresolved'));
});
// Type-level format separation preserves V1 exports and refuses mixed metadata visitors.
function typeChecks(v1: api.TableKernel, v2: api.TableKernelV2, a: api.OwnedAuditVisitor, b: api.OwnedAuditVisitorV2) {
  v1.auditOwned(a, budget()); v2.auditOwned(b, budget());
  // @ts-expect-error V2 metadata cannot enter a V1 visitor.
  v2.auditOwned(a, budget());
  // @ts-expect-error V1 metadata cannot enter a V2 visitor.
  v1.auditOwned(b, budget());
  const record1 = (_pass: 1 | 2, _record: Readonly<StoredRecord>) => {};
  const record2 = (_pass: 1 | 2, _record: Readonly<StoredRecordV2>) => {};
  void record1; void record2;
}
void typeChecks;
