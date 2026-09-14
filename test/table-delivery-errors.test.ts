import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableDeliveryJournal } from '../src/delivery/table-journal.js';
import type { TableDeliveryJournalLimits } from '../src/delivery/table-journal.js';
import { DeliveryJournalError } from '../src/delivery/types.js';
import type { DeliveryJournalErrorCode } from '../src/delivery/types.js';
import { TableError } from '../src/storage/table/types.js';
import { code } from './support/table-delivery.js';
import { tableBinding, tableService } from './support/table-service.js';

interface ExceptionCase { name: string; create: () => unknown; expected: DeliveryJournalErrorCode }
const cases: ExceptionCase[] = [
  { name: 'revoked Proxy', create: () => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; }, expected: 'unavailable' },
  { name: 'throwing getPrototypeOf Proxy', create: () => new Proxy({}, { getPrototypeOf() { throw new Error('synthetic'); } }), expected: 'unavailable' },
  { name: 'stateful prototype and code cannot reclassify an unsupported delivery error', create: () => {
    let prototypes = 0; let reads = 0;
    return new Proxy({ get code() { return ++reads === 1 ? 'synthetic-unsupported' : 'busy'; } }, {
      getPrototypeOf() { return ++prototypes === 1 ? DeliveryJournalError.prototype : TableError.prototype; },
    });
  }, expected: 'unavailable' },
  { name: 'ordinary Error with context', create: () => new Error('synthetic', { cause: { synthetic: true } }), expected: 'unavailable' },
  { name: 'unbranded supported code', create: () => ({ code: 'busy' }), expected: 'unavailable' },
  { name: 'unbranded throwing code getter', create: () => ({ get code() { throw new Error('synthetic'); } }), expected: 'unavailable' },
  ...[null, undefined, false, 1, 'synthetic', Symbol('synthetic')].map((value, i) => ({
    name: `non-error value ${i}`, create: () => value, expected: 'unavailable' as const,
  })),
];
for (const [name, create] of [
  ['DeliveryJournalError', () => new DeliveryJournalError('busy')],
  ['TableError', () => new TableError('busy')],
] as const) {
  cases.push(
    { name: `${name} throwing code getter`, create: () => Object.defineProperty(create(), 'code', {
      get() { throw new Error('synthetic'); },
    }), expected: 'unavailable' },
    { name: `${name} unknown code`, create: () => Object.defineProperty(create(), 'code', { value: 'synthetic-unsupported' }), expected: 'unavailable' },
    { name: `${name} inherited message key`, create: () => Object.defineProperty(create(), 'code', { value: 'constructor' }), expected: 'unavailable' },
    { name: `${name} non-string code`, create: () => Object.defineProperty(create(), 'code', { value: 17 }), expected: 'unavailable' },
    { name: `${name} code changes after first read`, create: () => {
      let reads = 0;
      return Object.defineProperty(create(), 'code', { get() { return ++reads === 1 ? 'busy' : 'synthetic-unsupported'; } });
    }, expected: 'busy' },
  );
}
for (const value of ['invalid-input', 'missing', 'exists', 'busy', 'scope-mismatch', 'unsupported-schema', 'corrupt', 'unavailable', 'closed'] as const)
  cases.push({ name: `ordinary DeliveryJournalError ${value}`, create: () => new DeliveryJournalError(value, { cause: { synthetic: true } }), expected: value });
for (const [value, expected] of [
  ['invalid-input', 'invalid-input'], ['corrupt', 'corrupt'], ['missing', 'missing'], ['exists', 'exists'], ['busy', 'busy'], ['closed', 'closed'],
  ['unavailable', 'unavailable'], ['incomplete', 'unavailable'], ['unresolved', 'unavailable'], ['not-submitted', 'unavailable'], ['unready', 'unavailable'],
] as const) cases.push({ name: `ordinary TableError ${value}`, create: () => new TableError(value), expected });

for (const path of ['limits ownKeys', 'limits descriptor', 'dependency token getter', 'dependency request getter'] as const)
  test(`delivery factory contains exceptions from ${path} without I/O`, async t => {
    const s = await tableService(t);
    for (const scenario of cases) await t.test(scenario.name, () => {
      const source = scenario.create(); let injections = 0;
      const fail = (): never => { injections++; throw source; };
      const dependencies = { ...s.dependencies };
      let limits: TableDeliveryJournalLimits = {};
      if (path === 'limits ownKeys') limits = new Proxy({}, { ownKeys: fail });
      else if (path === 'limits descriptor') limits = new Proxy({ maxPending: 1 }, { getOwnPropertyDescriptor: fail });
      else Object.defineProperty(dependencies, path === 'dependency token getter' ? 'token' : 'request', { get: fail });
      let safe = false; let fresh = false; let clean = false;
      try {
        const journal = createTableDeliveryJournal(tableBinding, dependencies, limits);
        t.after(() => journal.close());
      } catch (error) {
        // Never hand hostile exceptions to assertion formatting, including on RED.
        try {
          safe = code(scenario.expected)(error); fresh = error !== source;
          clean = error instanceof DeliveryJournalError && error.message === new DeliveryJournalError(scenario.expected).message &&
            Object.keys(error).sort().join(',') === 'code,name';
        } catch { /* Classification escapes must fail only boolean assertions. */ }
      }
      assert.equal(injections, 1);
      assert.equal(s.stats.tokens, 0); assert.equal(s.stats.requests, 0); assert.equal(s.stats.writes, 0); assert.equal(s.rows.size, 0);
      assert.equal(safe, true); assert.equal(fresh, true); assert.equal(clean, true);
    });
  });

for (const [name, create] of [
  ['DeliveryJournalError', () => new DeliveryJournalError('busy')],
  ['TableError', () => new TableError('busy')],
] as const) test(`delivery factory does not coerce ${name} code or inspect source diagnostics`, async t => {
  const s = await tableService(t); let inspections = 0;
  const inspect = (): never => { inspections++; throw new Error('synthetic'); };
  const source = Object.defineProperties(create(), {
    code: { value: { [Symbol.toPrimitive]: inspect } },
    message: { get: inspect }, cause: { get: inspect }, stack: { get: inspect }, toString: { value: inspect },
  });
  const limits = new Proxy({}, { ownKeys() { throw source; } });
  let safe = false;
  try { const journal = createTableDeliveryJournal(tableBinding, s.dependencies, limits); t.after(() => journal.close()); }
  catch (error) { try { safe = code('unavailable')(error); } catch { /* No hostile assertion output. */ } }
  assert.equal(s.stats.tokens, 0); assert.equal(s.stats.requests, 0); assert.equal(s.stats.writes, 0);
  assert.equal(safe, true); assert.equal(inspections, 0);
});
