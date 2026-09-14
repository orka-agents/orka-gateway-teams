import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { OWNED_AUDIT_BUDGET_EXHAUSTED, TableError } from '../src/storage/table/index.js';
import { budget, code, putData, visitor } from './support/owned-audit.js';
import { foreign } from './support/foreign-inspection.js';

for (const started of [false, true]) test(`foreign close is harmless and memoized when started=${started}`, async t => {
  const f = await foreign(t); const i = f.create();
  const initial = i.status(); assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.keys(initial).sort().join(',') === 'lifecycle,ownership,pending', true);
  assert.equal(initial.lifecycle, 'new'); assert.equal(initial.ownership, 'none'); assert.equal(initial.pending, 0);
  for (let n = 0; n < 3; n++) i.status(); assert.equal(f.stats.tokens, 0);
  if (started) { await i.inspect(visitor(), budget()); await assert.rejects(i.inspect(visitor(), budget()), code('not-submitted')); }
  const close = i.close(); assert.equal(i.close() === close, true); assert.equal(i.status().lifecycle, 'closing');
  await assert.rejects(i.inspect(visitor(), budget()), code('closed')); await close;
  assert.equal(i.close() === close, true); assert.equal(i.status().lifecycle, 'closed'); assert.equal(i.status().pending, 0);
  assert.equal(initial.lifecycle, 'new'); f.unchanged();
});
test('valid admission consumes synchronously, snapshots config and refuses overlap', async t => {
  const f = await foreign(t); const i = f.create(); let callbacks = 0; let propertyGets = 0;
  const v = { ...visitor(), record(): undefined { callbacks++; } }; const b = budget(); const o = { requestTimeoutMs: 30000 };
  const handler = { get() { propertyGets++; throw new Error('private input'); } };
  const inspection = i.inspect(new Proxy(v, handler), new Proxy(b, handler), new Proxy(o, handler));
  void inspection.catch(() => {}); // Observe even when an early lifecycle assertion fails during RED.
  assert.equal(i.status().lifecycle, 'inspecting'); assert.equal(i.status().pending, 1); assert.equal(i.status().ownership, 'none');
  v.record = () => { throw new Error('private replacement'); }; b.maxPages = 0; b.maxPageBytes = 0; o.requestTimeoutMs = 0;
  await assert.rejects(i.inspect(visitor(), budget()), code('not-submitted')); await inspection;
  assert.equal(callbacks, 1); assert.equal(propertyGets, 0); assert.equal(i.status().pending, 0); await i.close(); f.unchanged();
});
test('valid already-aborted admission is consumed incomplete without I/O', async t => {
  const f = await foreign(t); const i = f.create(); const abort = new AbortController(); abort.abort(new Error('private reason'));
  await assert.rejects(i.inspect(visitor(), budget(), { signal: abort.signal }), code('incomplete'));
  assert.equal(i.status().lifecycle, 'failed'); assert.equal(i.status().pending, 0); assert.equal(f.stats.tokens, 0);
  await assert.rejects(i.inspect(visitor(), budget()), code('not-submitted')); await i.close(); f.unchanged();
});
for (const callback of ['record', 'endPass', 'finalize'] as const) for (const operation of ['inspect', 'close'] as const)
  test(`caught foreign ${operation} reentrancy in ${callback} latches unresolved synchronously`, async t => {
    const f = await foreign(t); const i = f.create(); let caught = false; let calls = 0;
    await assert.rejects(i.inspect({ ...visitor(), [callback](): undefined {
      calls++; assert.equal(i.status().ownership, 'none');
      try { if (operation === 'inspect') i.inspect(null as never, null as never); else i.close(); }
      catch (error) { caught = code('unresolved')(error); }
    } }, budget()), code('unresolved'));
    assert.equal(caught, true); assert.equal(calls, 1); assert.equal(i.status().lifecycle, 'failed');
    assert.equal(i.status().pending, 0); await i.close(); f.unchanged();
  });
for (const callback of ['record', 'endPass', 'finalize'] as const)
  for (const failure of ['sentinel', 'incomplete', 'error', 'value', 'thenable', 'return-promise', 'throw-promise', 'cross-realm', 'constructor'] as const)
    test(`foreign ${callback} ${failure} obeys exact sentinel and synchronous callback contract`, async t => {
      const f = await foreign(t); const i = f.create(); let getters = 0; let calls = 0;
      const invalid = function(this: void) {
        calls++; assert.equal(this === undefined, true);
        if (failure === 'sentinel') throw OWNED_AUDIT_BUDGET_EXHAUSTED;
        if (failure === 'incomplete') throw new TableError('incomplete');
        if (failure === 'error') throw new Error('private callback');
        if (failure === 'value') return 1;
        if (failure === 'thenable') return { get then() { getters++; throw new Error('private then'); } };
        if (failure === 'constructor') {
          const p = Promise.resolve(); Object.defineProperty(p, 'constructor', { get() { throw new Error('private constructor'); } }); return p;
        }
        const p: Promise<never> = failure === 'cross-realm' ? runInNewContext('Promise.reject(new Error("private realm"))') : Promise.reject(new Error('private promise'));
        Object.defineProperty(p, 'then', { get() { getters++; throw new Error('private then'); } });
        if (failure === 'throw-promise') throw p; return p;
      };
      await assert.rejects(i.inspect({ ...visitor(), [callback]: invalid } as never, budget()), code(failure === 'sentinel' ? 'incomplete' : 'unresolved'));
      await new Promise(r => setImmediate(r)); assert.equal(getters, 0); assert.equal(calls, 1); assert.equal(i.status().lifecycle, 'failed');
      await assert.rejects(i.inspect(visitor(), budget()), code('not-submitted')); await i.close(); f.unchanged();
    });
test('native signal overrides and propagation stopping cannot suppress foreign abort or leak listener retention', async t => {
  const f = await foreign(t); const i = f.create(); putData(f.s); const abort = new AbortController(); let overrides = 0; let calls = 0; let later = 0;
  abort.signal.addEventListener('abort', e => e.stopImmediatePropagation());
  for (const key of ['aborted', 'addEventListener', 'removeEventListener']) Object.defineProperty(abort.signal, key, {
    get() { overrides++; throw new Error('private signal'); },
  });
  await assert.rejects(i.inspect({ ...visitor(), record() { calls++; abort.abort(); }, endPass() { later++; }, finalize() { later++; } }, budget(), { signal: abort.signal }), code('incomplete'));
  assert.equal(overrides, 0); assert.equal(calls, 1); assert.equal(later, 0); assert.equal(f.stats.gets, 2);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1); await i.close(); f.unchanged();
});
for (const reason of ['abort', 'close'] as const) test(`finalizer-scheduled ${reason} prevents foreign publication`, async t => {
  const f = await foreign(t); const i = f.create(); const abort = new AbortController(); let close: Promise<void> | undefined; let finalized = false;
  await assert.rejects(i.inspect({ ...visitor(), finalize() { finalized = true; queueMicrotask(() => {
    if (reason === 'close') close = i.close(); else abort.abort();
  }); } }, budget(), { signal: abort.signal }), code('incomplete'));
  assert.equal(finalized, true); assert.equal(i.status().lifecycle === 'completed', false);
  await (close ?? i.close()); f.unchanged();
});
test('foreign close fences even malformed later calls without reflecting their inputs', async t => {
  const f = await foreign(t); const i = f.create(); const close = i.close(); let reflected = 0;
  const malformed = new Proxy({}, { getPrototypeOf() { reflected++; throw new Error('private later input'); } });
  await assert.rejects(i.inspect(malformed as never, null as never), code('closed'));
  await close; await assert.rejects(i.inspect(null as never, null as never), code('closed'));
  assert.equal(reflected, 0); assert.equal(f.stats.tokens, 0); f.unchanged();
});
for (const input of ['visitor', 'budget', 'options'] as const)
  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const)
    test(`foreign close during valid ${input} ${trap} reflection prevents admission`, async t => {
      const f = await foreign(t); const i = f.create(); const abort = new AbortController();
      let closing: Promise<void> | undefined; let reflected = 0; let callbacks = 0;
      const reflect = <T extends object>(value: T): T => new Proxy(value, {
        getPrototypeOf(target) {
          if (trap === 'getPrototypeOf') { reflected++; closing = i.close(); }
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          if (trap === 'ownKeys') { reflected++; closing = i.close(); }
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          if (trap === 'getOwnPropertyDescriptor') { reflected++; closing = i.close(); }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const v = { ...visitor(), record(): undefined { callbacks++; } };
      const b = budget(); const o = { signal: abort.signal, requestTimeoutMs: 30000 };
      const inspection = i.inspect(input === 'visitor' ? reflect(v) : v, input === 'budget' ? reflect(b) : b, input === 'options' ? reflect(o) : o);
      const observed = inspection.then(() => 'success', error => code('closed')(error) ? 'closed' : 'other');
      try {
        assert.equal(reflected > 0, true); assert.equal(i.status().lifecycle, 'closing');
        assert.equal(i.status().pending, 0); assert.equal(i.status().ownership, 'none');
        assert.equal(i.close() === closing, true); assert.equal(await observed, 'closed');
        assert.equal(callbacks, 0); assert.equal(f.stats.tokens, 0); assert.equal(f.stats.gets, 0);
        assert.equal(getEventListeners(abort.signal, 'abort').length, 0); f.unchanged();
        await closing; assert.equal(i.status().lifecycle, 'closed'); assert.equal(i.status().pending, 0);
      } finally { await observed; await i.close(); }
    });
test('caught reentrancy followed by allocator sentinel cannot erase unresolved', async t => {
  const f = await foreign(t); const i = f.create(); let caught = false;
  await assert.rejects(i.inspect({ ...visitor(), record() {
    try { i.close(); } catch (error) { caught = code('unresolved')(error); }
    throw OWNED_AUDIT_BUDGET_EXHAUSTED;
  } }, budget()), code('unresolved'));
  assert.equal(caught, true); await i.close(); f.unchanged();
});
test('foreign publication checks deadline after finalizer microtasks too', async t => {
  const f = await foreign(t); const i = f.create(); let finalized = false;
  await assert.rejects(i.inspect({ ...visitor(), finalize() {
    finalized = true; queueMicrotask(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); });
  } }, budget({ maxDurationMs: 1000 })), code('incomplete'));
  assert.equal(finalized, true); assert.equal(i.status().lifecycle, 'failed'); await i.close(); f.unchanged();
});
test('callback function properties are not inspected and callbacks use undefined receivers', async t => {
  const f = await foreign(t); const i = f.create(); let calls = 0; let getters = 0;
  const fn = function(this: void): undefined { assert.equal(this === undefined, true); calls++; };
  for (const key of ['name', 'constructor', 'then']) Object.defineProperty(fn, key, { get() { getters++; throw new Error('private function'); } });
  await i.inspect({ passes: 1, record: fn, endPass: fn, finalize: fn }, budget());
  assert.equal(calls, 3); assert.equal(getters, 0); await i.close(); f.unchanged();
});
