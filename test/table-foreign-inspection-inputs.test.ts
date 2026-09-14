import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableForeignInspectorV2 } from '../src/storage/table/index.js';
import type { ForeignOwnerFenceV2, TableBinding, TableDependencies } from '../src/storage/table/index.js';
import { budget, code, visitor } from './support/owned-audit.js';
import { foreign } from './support/foreign-inspection.js';
import { hash } from './support/table-service.js';

const uuid = '99999999-9999-4999-8999-999999999999';
test('constructor rejects closed fence descriptor and scalar faults before dependency reflection or I/O', async t => {
  const f = await foreign(t); let reflected = 0; let getters = 0;
  const dependencies = { get token() { reflected++; throw new Error('private dependency'); } } as unknown as TableDependencies;
  const cases: unknown[] = [null, [], Object.create(f.expected), { ...f.expected, extra: 1 }, { ...f.expected, [Symbol()]: 1 },
    Object.defineProperty({ ...f.expected }, 'owner', { get() { getters++; return uuid; } }),
    Object.defineProperty({ ...f.expected }, 'owner', { value: uuid, enumerable: false }),
    new Proxy(f.expected, { ownKeys() { throw new Error('private proxy'); } })];
  for (const key of Object.keys(f.expected)) { const missing = { ...f.expected }; Reflect.deleteProperty(missing, key); cases.push(missing); }
  for (const [key, values] of Object.entries({ initId: ['', 'not-uuid', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'], owner: ['', 'not-uuid'],
    epoch: [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'], initDigest: ['', 'A'.repeat(64), '0'.repeat(64)],
    mDigest: ['', 'A'.repeat(64), '0'.repeat(63)], etag: ['', '*', '""', 'unquoted', '"' + 'x'.repeat(255) + '"'] })) {
    for (const value of values) cases.push({ ...f.expected, [key]: value });
  }
  for (const expected of cases) assert.throws(() => createTableForeignInspectorV2(f.binding, dependencies, expected as ForeignOwnerFenceV2), code('invalid-input'));
  assert.equal(reflected, 0); assert.equal(getters, 0); assert.equal(f.stats.gets, 0); f.unchanged();
});
test('binding and nested scope descriptors are closed and required before dependencies', async t => {
  const f = await foreign(t, 'ingress'); let reflected = 0; let getters = 0;
  const dependencies = { get token() { reflected++; throw new Error('private dependency'); } } as unknown as TableDependencies;
  const cases: unknown[] = [null, [], { ...f.binding, extra: 1 }, { ...f.binding, [Symbol()]: 1 },
    Object.create(f.binding), Object.defineProperty({ ...f.binding }, 'account', { value: 'Example123', enumerable: false }),
    { ...f.binding, get scope() { getters++; return f.binding.scope; } },
    { ...f.binding, scope: { ...f.binding.scope, extra: 1 } },
    { ...f.binding, scope: Object.defineProperty({ ...f.binding.scope }, 'appId', { get() { getters++; return 'App'; } }) },
    new Proxy(f.binding, { getPrototypeOf() { throw new Error('private proxy'); } })];
  for (const key of Object.keys(f.binding)) { const missing = { ...f.binding }; Reflect.deleteProperty(missing, key); cases.push(missing); }
  for (const key of Object.keys(f.binding.scope)) { const scope = { ...f.binding.scope }; Reflect.deleteProperty(scope, key); cases.push({ ...f.binding, scope }); }
  for (const binding of cases) assert.throws(() => createTableForeignInspectorV2(binding as TableBinding, dependencies, f.expected), code('invalid-input'));
  assert.equal(reflected, 0); assert.equal(getters, 0); assert.equal(f.stats.gets, 0); f.unchanged();
});
for (const kind of ['delivery', 'ingress'] as const) test(`${kind} binding and exact fence snapshot precedes mutating dependency getters`, async t => {
  const f = await foreign(t, kind); let gets = 0; const scope = f.binding.scope;
  const dependencies = { get token() {
    f.binding.account = 'wrongaccount'; Reflect.set(scope, 'appId', 'changed'); f.expected.owner = uuid; f.expected.etag = '"changed"';
    return f.dependencies.token;
  }, request: f.dependencies.request };
  // Caller property get traps must never participate in the descriptor snapshots.
  const handler = { get() { gets++; throw new Error('private get'); } };
  f.binding.scope = new Proxy(f.binding.scope, handler);
  const inspector = createTableForeignInspectorV2(new Proxy(f.binding, handler), dependencies, new Proxy(f.expected, handler));
  await inspector.inspect(visitor(), budget()); await inspector.close();
  assert.equal(gets, 0); assert.equal(f.stats.gets, 3); f.unchanged();
});
for (const field of ['account', 'table', 'storeId', 'appId', 'tenantId', 'orkaBaseUrl', 'gatewayNamespace', 'gatewayName'] as const)
  test(`constructor initialization digest binds exact ${field}`, async t => {
    const f = await foreign(t, 'ingress');
    if (field === 'account' || field === 'table' || field === 'storeId') f.binding[field] = 'different';
    else Reflect.set(f.binding.scope, field, field === 'orkaBaseUrl' ? 'https://other.example.invalid/' : 'different');
    assert.throws(f.create, code('invalid-input')); assert.equal(f.stats.tokens, 0); f.unchanged();
  });
test('constructor accepts canonical resource casing and null-prototype snapshots, containing dependency exceptions', async t => {
  const f = await foreign(t); f.binding.account = f.binding.account.toUpperCase(); f.binding.table = f.binding.table.toUpperCase();
  const inspector = createTableForeignInspectorV2(Object.assign(Object.create(null), f.binding), f.dependencies, Object.assign(Object.create(null), f.expected));
  await inspector.inspect(visitor(), budget()); await inspector.close();
  for (const dependencies of [null, {}, { token: 1 }, { get token() { throw new Error('private dependency'); } },
    { token: f.dependencies.token, get request() { throw new Error('private request'); } }]) {
    assert.throws(() => createTableForeignInspectorV2(f.binding, dependencies as TableDependencies, f.expected), code('invalid-input'));
  }
  f.unchanged();
});
test('different but internally valid initialization is an observation mismatch, never adopted', async t => {
  const f = await foreign(t); f.expected.initId = uuid;
  f.expected.initDigest = hash(['orka-init-v2', f.s.rows.get('M')!.Binding, uuid]);
  const i = f.create(); await assert.rejects(i.inspect(visitor(), budget()), code('unresolved')); await i.close();
  assert.equal(f.stats.gets, 1); f.unchanged();
});
for (const field of ['maxPages', 'maxPageBytes', 'maxDurationMs', 'maxTrackingBytes'] as const)
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) test(`invalid ${field} scalar case ${String(value)} does not consume`, async t => {
    const f = await foreign(t); const i = f.create();
    await assert.rejects(i.inspect(visitor(), budget({ [field]: value })), code('invalid-input'));
    assert.equal(i.status().lifecycle, 'new'); assert.equal(f.stats.tokens, 0);
    await i.inspect(visitor(), budget()); await i.close(); f.unchanged();
  });
test('all preflight descriptors, callbacks, budgets and native signals validate without consuming', async t => {
  const f = await foreign(t); const i = f.create(); let getters = 0;
  const missing = budget(); Reflect.deleteProperty(missing, 'maxPages');
  const cases: [unknown, unknown, unknown][] = [
    [null, budget(), undefined], [Object.create(visitor()), budget(), undefined], [{ ...visitor(), passes: 3 }, budget(), undefined],
    [{ ...visitor(), get record() { getters++; return () => {}; } }, budget(), undefined], [{ ...visitor(), finalize: 1 }, budget(), undefined],
    [{ passes: 1, record() {}, endPass() {} }, budget(), undefined], [{ ...visitor(), [Symbol()]: 1 }, budget(), undefined],
    [visitor(), missing, undefined], [visitor(), { ...budget(), extra: 1 }, undefined],
    [visitor(), Object.defineProperty(budget(), 'maxPages', { value: 1, enumerable: false }), undefined],
    [visitor(), { ...budget(), get maxPageBytes() { getters++; return 1; } }, undefined],
    [visitor(), budget({ maxDurationMs: 2147483648 }), undefined], [visitor(), budget({ maxTrackingBytes: 268435457 }), undefined],
    [visitor(), budget(), { timeoutMs: 1 }], [visitor(), budget(), { signal: {} }], [visitor(), budget(), { signal: Object.create(AbortSignal.prototype) }],
    [visitor(), budget(), { get signal() { getters++; return undefined; } }], [visitor(), budget(), { requestTimeoutMs: null }],
    [visitor(), budget(), { requestTimeoutMs: 0 }], [visitor(), budget(), { requestTimeoutMs: 300001 }],
    [visitor(), budget(), new Proxy({}, { ownKeys() { throw new Error('private options'); } })],
  ];
  for (const [v, b, o] of cases) {
    await assert.rejects(i.inspect(v as never, b as never, o as never), code('invalid-input'));
    assert.equal(i.status().lifecycle, 'new'); assert.equal(i.status().pending, 0);
  }
  assert.equal(getters, 0); assert.equal(f.stats.tokens, 0); await i.inspect(visitor(), budget()); await i.close(); f.unchanged();
});
