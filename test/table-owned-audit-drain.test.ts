import assert from 'node:assert/strict';
import https from 'node:https';
import { addAbortListener, getEventListeners } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { createTableKernel, createTableKernelV2 } from '../src/storage/table/index.js';
import { budget, code, emptyInput, emptyPlan, owned, putData, visitor } from './support/owned-audit.js';
import { deferred, eventually, syntheticToken, tableBinding, tableService } from './support/table-service.js';

test('Node native abort listener resists propagation stopping and disposes through a guarded signal view', () => {
  const controller = new AbortController(); let ordinary = 0; let resistant = 0; let overrides = 0;
  controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
  controller.signal.addEventListener('abort', () => { ordinary++; });
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
  const view = { get aborted() { return aborted.call(controller.signal) as boolean; },
    addEventListener: EventTarget.prototype.addEventListener.bind(controller.signal),
    removeEventListener: EventTarget.prototype.removeEventListener.bind(controller.signal) } as AbortSignal;
  for (const key of ['aborted', 'addEventListener', 'removeEventListener']) Object.defineProperty(controller.signal, key, {
    get() { overrides++; throw new Error('private signal override detail'); },
  });
  const disposed = addAbortListener(view, () => { resistant += 10; }); disposed[Symbol.dispose]();
  const live = addAbortListener(view, () => { resistant++; }); controller.abort(); live[Symbol.dispose]();
  assert.equal(ordinary, 0); assert.equal(resistant, 1); assert.equal(overrides, 0);
});
for (const format of [1, 2] as const) {
  test(`V${format} caller propagation stopping cannot suppress record abort or publish audit permission`, async t => {
    const { s, k } = await owned(t, format); putData(s); const abort = new AbortController(); let records = 0; let later = 0;
    abort.signal.addEventListener('abort', event => event.stopImmediatePropagation()); const requests = s.stats.requests;
    const outcome = await k.auditOwned({ ...visitor(), record() { records++; abort.abort(); }, endPass() { later++; }, finalize() { later++; } }, budget(), { signal: abort.signal })
      .then(() => 'success', e => code('incomplete')(e) ? 'incomplete' : 'other');
    const after = k.status(); const auditRequests = s.stats.requests - requests; await k.close();
    assert.equal(outcome, 'incomplete'); assert.equal(after.lifecycle, 'owned-unready'); assert.equal(records, 1); assert.equal(later, 0); assert.equal(auditRequests, 2);
  });
  test(`V${format} caller propagation stopping cannot retain a cancelled never-started audit`, async t => {
    const { s, k } = await owned(t, format, { maxPending: 2 }); await k.scan(); const gate = deferred(); let held = false;
    s.controls.hook = async e => { if (!held) { held = true; await gate.promise; } e.reply(); };
    const first = k.read('M'); await eventually(() => held); const abort = new AbortController(); let callbacks = 0;
    abort.signal.addEventListener('abort', event => event.stopImmediatePropagation());
    const audit = k.auditOwned({ ...visitor(), record() { callbacks++; } }, budget(), { signal: abort.signal })
      .then(() => 'success', e => code('not-submitted')(e) ? 'not-submitted' : 'other');
    abort.abort(); const pendingAfterAbort = k.status().pending; gate.resolve(); await first; const outcome = await audit;
    delete s.controls.hook; await k.close();
    assert.equal(pendingAfterAbort, 1); assert.equal(outcome, 'not-submitted'); assert.equal(callbacks, 0);
  });
  test(`V${format} non-suppressible caller abort reaches held token promptly but audit and close still drain`, async t => {
    const s = await tableService(t, 'delivery', format); const gate = deferred<string>(); let hold = false; let heldSignal: AbortSignal | undefined;
    const k = (format === 1 ? createTableKernel : createTableKernelV2)(tableBinding, { ...s.dependencies, token: async (...args) => {
      if (hold) { hold = false; heldSignal = args[1].signal; return gate.promise; } return s.dependencies.token(...args);
    } });
    await k.initialize(); await k.acquire(); hold = true; const requests = s.stats.requests; const abort = new AbortController(); let settled = false; let closed = false; let callbacks = 0;
    abort.signal.addEventListener('abort', event => event.stopImmediatePropagation());
    const audit = k.auditOwned({ ...visitor(), record() { callbacks++; } }, budget(), { signal: abort.signal }).then(() => 'success', e => code('incomplete')(e) ? 'incomplete' : 'other').then(v => { settled = true; return v; });
    await eventually(() => !!heldSignal); abort.abort(); const prompt = heldSignal!.aborted;
    const close = k.close().then(() => { closed = true; }); await new Promise(r => setTimeout(r, 20));
    assert.equal(settled, false); assert.equal(closed, false); assert.equal(k.status().pending, 1); assert.equal(s.stats.requests, requests);
    gate.resolve(syntheticToken); const outcome = await audit; await close;
    assert.equal(prompt, true); assert.equal(outcome, 'incomplete'); assert.equal(callbacks, 0); assert.equal(k.status().pending, 0); assert.equal(s.rows.get('M')?.Owner, '');
  });
  test(`V${format} non-suppressible caller abort reaches held native destruction before close`, async t => {
    const { s, k } = await owned(t, format); const requests = s.stats.requests; let release: (() => void) | undefined;
    s.controls.hook = () => {};
    s.controls.request = ((...args: Parameters<typeof https.request>) => {
      const req = s.request(...args); const destroy = req.destroy.bind(req); req.destroy = () => { release = () => { destroy(); }; return req; }; return req;
    }) as typeof https.request;
    const abort = new AbortController(); let settled = false; let closed = false;
    abort.signal.addEventListener('abort', event => event.stopImmediatePropagation());
    const audit = k.auditOwned(visitor(), budget(), { signal: abort.signal }).then(() => 'success', e => code('incomplete')(e) ? 'incomplete' : 'other').then(v => { settled = true; return v; });
    await eventually(() => s.stats.requests === requests + 1); abort.abort(); const prompt = !!release;
    const close = k.close().then(() => { closed = true; }); await eventually(() => !!release); await new Promise(r => setTimeout(r, 20));
    assert.equal(settled, false); assert.equal(closed, false); assert.equal(k.status().pending, 1); assert.equal(s.stats.requestCloses, requests); assert.equal(s.stats.socketCloses, requests);
    delete s.controls.request; delete s.controls.hook; release!(); const outcome = await audit; await close;
    assert.equal(prompt, true); assert.equal(outcome, 'incomplete'); assert.equal(k.status().pending, 0); assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
  });
  test(`V${format} audit abort subscriptions dispose without invoking native signal overrides`, async t => {
    const { k } = await owned(t, format); const abort = new AbortController(); let overrides = 0;
    const stopping = (event: Event) => event.stopImmediatePropagation(); abort.signal.addEventListener('abort', stopping);
    for (const key of ['aborted', 'addEventListener', 'removeEventListener']) Object.defineProperty(abort.signal, key, {
      get() { overrides++; throw new Error('private signal override detail'); },
    });
    await k.auditOwned(visitor(), budget(), { signal: abort.signal });
    assert.equal(getEventListeners(abort.signal, 'abort').length, 1); assert.equal(overrides, 0); await k.close();
  });
  for (const reason of ['abort', 'deadline', 'request-timeout', 'close', 'invalidate'] as const) test(`V${format} active audit ${reason} owns held token until actual settlement`, async t => {
    const s = await tableService(t, 'delivery', format); const gate = deferred<string>(); let hold = false; let heldSignal: AbortSignal | undefined;
    const k = (format === 1 ? createTableKernel : createTableKernelV2)(tableBinding, { ...s.dependencies, token: async (...args) => {
      if (hold) { hold = false; heldSignal = args[1].signal; return gate.promise; } return s.dependencies.token(...args);
    } }, { maxPending: 2, maxPendingBytes: 21 });
    await k.initialize(); await k.acquire(); await k.scan(); hold = true; const requests = s.stats.requests; const writes = s.stats.writes;
    const abort = new AbortController(); let settled = false; let callbacks = 0; let close: Promise<void> | undefined;
    const outcome = k.auditOwned({ ...visitor(), record() { callbacks++; } }, budget({ maxDurationMs: reason === 'deadline' ? 100 : 30000 }),
      { signal: abort.signal, requestTimeoutMs: reason === 'request-timeout' ? 100 : 30000 })
      .then(() => { settled = true; return 'success'; }, e => { settled = true; return code(reason === 'invalidate' ? 'unresolved' : reason === 'request-timeout' ? 'unavailable' : 'incomplete')(e) ? 'expected' : 'other'; });
    await eventually(() => !!heldSignal);
    const queuedAbort = new AbortController(); const queued = assert.rejects(k.mutate({ input: Buffer.alloc(21), keys: [] }, emptyPlan, { signal: queuedAbort.signal }), code('not-submitted'));
    assert.equal(k.status().pending, 2); assert.equal(k.status().pendingBytes, 21);
    await assert.rejects(k.auditOwned(visitor(), budget()), code('not-submitted'));
    if (reason === 'abort') abort.abort();
    if (reason === 'close') close = k.close();
    if (reason === 'invalidate') { k.invalidate(); close = assert.rejects(k.close(), code('unresolved')); }
    await eventually(() => heldSignal!.aborted); await new Promise(r => setTimeout(r, 20));
    assert.equal(settled, false); assert.equal(callbacks, 0); assert.equal(s.stats.requests, requests); assert.equal(s.stats.writes, writes);
    if (!close) { assert.equal(k.status().pending, 2); assert.equal(k.status().pendingBytes, 21); queuedAbort.abort(); }
    await queued; assert.equal(k.status().pending, 1);
    gate.resolve(syntheticToken); assert.equal(await outcome, 'expected'); await close;
    assert.equal(k.status().pending, 0); assert.equal(k.status().pendingBytes, 0); assert.equal(callbacks, 0);
    if (!close) await k.close(); assert.equal(s.rows.get('M')?.Owner === '', reason !== 'invalidate');
    assert.equal(s.stats.requests, s.stats.socketCloses);
  });
  for (const reason of ['abort', 'deadline', 'close'] as const) test(`V${format} never-started ${reason} removes audit immediately without changing permission`, async t => {
    const { s, k } = await owned(t, format, { maxPending: 2 }); await k.scan(); const gate = deferred(); let held = false;
    s.controls.hook = async e => { if (!held) { held = true; await gate.promise; } e.reply(); };
    const first = k.read('M'); await eventually(() => held); const abort = new AbortController(); let callbacks = 0;
    const rejection = assert.rejects(k.auditOwned({ ...visitor(), record() { callbacks++; } }, budget({ maxDurationMs: reason === 'deadline' ? 50 : 30000 }), { signal: abort.signal }), code(reason === 'deadline' ? 'incomplete' : 'not-submitted'));
    let close: Promise<void> | undefined;
    if (reason === 'abort') abort.abort(); if (reason === 'close') close = k.close();
    await rejection; assert.equal(k.status().pending, 1); assert.equal(callbacks, 0);
    if (!close) assert.equal(k.status().lifecycle, 'envelope-audited');
    gate.resolve(); await first; delete s.controls.hook; await (close ?? k.close());
  });
  test(`V${format} abort inside record prevents next collection or after-M and retires previous audited permission`, async t => {
    const { s, k } = await owned(t, format); await k.scan(); putData(s); const abort = new AbortController(); let callbacks = 0;
    const requests = s.stats.requests;
    await assert.rejects(k.auditOwned({ ...visitor(), record() { callbacks++; abort.abort(); }, endPass() { callbacks++; }, finalize() { callbacks++; } }, budget(), { signal: abort.signal }), code('incomplete'));
    assert.equal(callbacks, 1); assert.equal(s.stats.requests - requests, 2); assert.equal(k.status().lifecycle, 'owned-unready');
    await assert.rejects(k.mutate(emptyInput, emptyPlan), code('unready')); await k.close();
  });
}
test('audit direct completion continuation sees audited permission before next FIFO mutation and cannot be bypassed', async t => {
  const { s, k } = await owned(t, 1, { maxPending: 3 }); const trace: string[] = []; let finalized = false;
  const audit = k.auditOwned({ ...visitor(), finalize() { finalized = true; trace.push('finalize'); } }, budget());
  const mutation = k.mutate(emptyInput, () => { trace.push('mutation'); return emptyPlan(); });
  const continuation = audit.then(() => {
    assert.equal(finalized, true); assert.equal(k.status().lifecycle, 'envelope-audited'); trace.push('completion');
    return k.read('M').then(() => { trace.push('read'); });
  });
  s.controls.hook = e => { if (finalized) trace.push(e.req.method === 'GET' ? 'request' : 'write'); e.reply(); };
  await continuation; await mutation;
  assert.deepEqual(trace.slice(0, 3), ['finalize', 'completion', 'request']);
  assert.ok(trace.indexOf('mutation') > trace.indexOf('completion')); assert.ok(trace.indexOf('read') > trace.indexOf('mutation'));
  delete s.controls.hook; await k.close();
});
for (const reason of ['abort', 'deadline', 'request-timeout', 'close', 'invalidate'] as const) test(`active audit ${reason} retains actual native request/socket destruction`, async t => {
  const { s, k } = await owned(t, 1); const requests = s.stats.requests; const writes = s.stats.writes; let release: (() => void) | undefined;
  s.controls.hook = () => {};
  s.controls.request = ((...args: Parameters<typeof https.request>) => {
    const req = s.request(...args); const destroy = req.destroy.bind(req);
    req.destroy = () => { release = () => { destroy(); }; return req; }; return req;
  }) as typeof https.request;
  const abort = new AbortController(); let settled = false; let closed = false; let close: Promise<void> | undefined;
  const outcome = k.auditOwned(visitor(), budget({ maxDurationMs: reason === 'deadline' ? 200 : 30000 }),
    { signal: abort.signal, requestTimeoutMs: reason === 'request-timeout' ? 200 : 30000 })
    .then(() => { settled = true; return 'success'; }, e => { settled = true;
      return code(reason === 'invalidate' ? 'unresolved' : reason === 'request-timeout' ? 'unavailable' : 'incomplete')(e) ? 'expected' : 'other'; });
  await eventually(() => s.stats.requests === requests + 1);
  if (reason === 'abort') abort.abort();
  if (reason === 'close') close = k.close().then(() => { closed = true; });
  if (reason === 'invalidate') { k.invalidate(); close = assert.rejects(k.close(), code('unresolved')).then(() => { closed = true; }); }
  await eventually(() => !!release); await new Promise(r => setTimeout(r, 20));
  assert.equal(settled, false); assert.equal(closed, false); assert.equal(k.status().pending, 1);
  assert.equal(s.stats.requestCloses, requests); assert.equal(s.stats.socketCloses, requests); assert.equal(s.stats.writes, writes);
  delete s.controls.request; delete s.controls.hook; release!(); assert.equal(await outcome, 'expected'); await (close ?? k.close());
  assert.equal(k.status().pending, 0); assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
  assert.equal(s.rows.get('M')?.Owner === '', reason !== 'invalidate');
});
test('audit native body exhaustion holds failure and slot through destruction; late invalidation dominates', async t => {
  const { s, k } = await owned(t, 2, { maxPending: 1 }); let release: (() => void) | undefined; let exhausted = false;
  s.controls.hook = e => {
    if (e.path.includes(",RowKey='M'")) e.reply();
    else { e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.write('{invalid audit body'); }
  };
  s.controls.request = ((url: URL, options: https.RequestOptions, callback: (res: IncomingMessage) => void) => {
    const req = s.request(url, options, res => {
      if (!url.pathname.includes('RowKey')) {
        const destroy = res.destroy.bind(res); res.destroy = () => { exhausted = true; release = () => { destroy(); }; return res; };
      }
      callback(res);
    });
    if (!url.pathname.includes('RowKey')) { const destroy = req.destroy.bind(req); req.destroy = () => { const prior = release; release = () => { prior?.(); destroy(); }; return req; }; }
    return req;
  }) as typeof https.request;
  let settled = false; const outcome = k.auditOwned(visitor(), budget({ maxPageBytes: 1 })).then(() => 'success', e => code('unresolved')(e) ? 'unresolved' : 'other').then(v => { settled = true; return v; });
  await eventually(() => exhausted); assert.equal(settled, false); assert.equal(k.status().pending, 1);
  await assert.rejects(k.read('M'), code('not-submitted')); k.invalidate();
  let closed = false; const close = assert.rejects(k.close(), code('unresolved')).then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(closed, false); assert.equal(settled, false);
  release!(); assert.equal(await outcome, 'unresolved'); await close; assert.equal(k.status().pending, 0);
  assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses); assert.notEqual(s.rows.get('M')?.Owner, '');
});
