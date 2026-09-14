import assert from 'node:assert/strict';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { TableClient } from '@azure/data-tables';
import { createTableForeignInspectorV2 } from '../src/storage/table/index.js';
import { budget, code, putData, visitor } from './support/owned-audit.js';
import { foreign } from './support/foreign-inspection.js';
import { deferred, eventually, syntheticToken } from './support/table-service.js';

for (const reason of ['abort', 'deadline', 'request-timeout', 'close'] as const) test(`foreign ${reason} keeps token and both promises pending until real token completion`, async t => {
  const f = await foreign(t); const gate = deferred<string>(); let signal: AbortSignal | undefined; let callbacks = 0;
  const i = createTableForeignInspectorV2(f.binding, { ...f.dependencies, token: async (_scope, context) => { signal = context.signal; return gate.promise; } }, f.expected);
  const abort = new AbortController(); let settled = false; let closed = false;
  const inspection = i.inspect({ ...visitor(), record() { callbacks++; } }, budget({ maxDurationMs: reason === 'deadline' ? 100 : 30000 }),
    { signal: abort.signal, requestTimeoutMs: reason === 'request-timeout' ? 100 : 30000 })
    .then(() => 'success', e => code(reason === 'request-timeout' ? 'unavailable' : 'incomplete')(e) ? 'expected' : 'other')
    .then(v => { settled = true; return v; });
  let close: Promise<void> | undefined;
  try {
    await eventually(() => !!signal);
    if (reason === 'abort') abort.abort(new Error('private reason'));
    if (reason === 'close') close = i.close().then(() => { closed = true; });
    await eventually(() => signal!.aborted); await new Promise(r => setTimeout(r, 20));
    assert.equal(settled, false); assert.equal(i.status().pending, 1); assert.equal(i.status().ownership, 'none');
    // Request-only failure is unavailable until an external close additionally cancels the operation.
    if (reason !== 'request-timeout') close ??= i.close().then(() => { closed = true; });
    await new Promise(r => setTimeout(r, 10)); assert.equal(closed, false); assert.equal(f.stats.gets, 0); f.unchanged();
  } finally { gate.resolve(syntheticToken); }
  assert.equal(await inspection, 'expected'); await (close ?? i.close());
  assert.equal(callbacks, 0); assert.equal(i.status().pending, 0); assert.equal(i.status().lifecycle, 'closed'); f.unchanged();
});
for (const stage of ['point', 'page'] as const) for (const reason of ['abort', 'deadline', 'request-timeout', 'close'] as const)
  test(`foreign ${stage} ${reason} waits for actual native request and socket destruction`, async t => {
    const f = await foreign(t); const i = f.create(); const requests = f.s.stats.requests; let release: (() => void) | undefined; let held = false;
    f.s.controls.hook = e => { if (stage === 'page' && e.path.includes(",RowKey='M'")) e.reply(); else { held = true; } };
    f.s.controls.request = ((url: URL, options: https.RequestOptions, callback: (res: IncomingMessage) => void) => {
      const req = f.s.request(url, options, callback);
      if (stage === 'point' || !url.pathname.includes('RowKey')) {
        const destroy = req.destroy.bind(req); req.destroy = () => { release = () => { destroy(); }; return req; };
      }
      return req;
    }) as typeof https.request;
    const abort = new AbortController(); let settled = false; let closed = false; let calls = 0; let close: Promise<void> | undefined;
    const inspection = i.inspect({ ...visitor(), record() { calls++; } }, budget({ maxDurationMs: reason === 'deadline' ? 300 : 30000 }),
      { signal: abort.signal, requestTimeoutMs: reason === 'request-timeout' ? 300 : 30000 })
      .then(() => 'success', e => code(reason === 'request-timeout' ? 'unavailable' : 'incomplete')(e) ? 'expected' : 'other').then(v => { settled = true; return v; });
    try {
      await eventually(() => held);
      if (reason === 'abort') abort.abort();
      if (reason === 'close') close = i.close().then(() => { closed = true; });
      await eventually(() => !!release);
      if (reason !== 'request-timeout') close ??= i.close().then(() => { closed = true; });
      await new Promise(r => setTimeout(r, 20)); assert.equal(settled, false); assert.equal(closed, false); assert.equal(i.status().pending, 1);
      assert.equal(i.status().ownership, 'none'); assert.equal(f.s.stats.requestCloses, requests + (stage === 'page' ? 1 : 0));
      assert.equal(f.s.stats.socketCloses, requests + (stage === 'page' ? 1 : 0)); f.unchanged();
    } finally { release?.(); }
    assert.equal(await inspection, 'expected'); await (close ?? i.close());
    assert.equal(calls, 0); assert.equal(i.status().pending, 0); assert.equal(f.s.stats.requests, f.s.stats.requestCloses); assert.equal(f.s.stats.requests, f.s.stats.socketCloses); f.unchanged();
  });
for (const failure of ['close', 'corrupt', 'body-budget'] as const) test(`foreign ${failure} awaits real public SDK iterator return and preserves failure precedence`, async t => {
  const f = await foreign(t); const i = f.create(); const gate = deferred(); let returning = false; let callbacks = 0;
  if (failure !== 'close') f.s.controls.hook = e => {
    if (e.path.includes(",RowKey='M'")) e.reply();
    else { e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.end('{invalid'); }
  };
  const list = TableClient.prototype.listEntities;
  t.mock.method(TableClient.prototype, 'listEntities', function(this: TableClient, ...args: Parameters<typeof list>) {
    const entities = list.apply(this, args); const byPage = entities.byPage.bind(entities);
    entities.byPage = settings => {
      const pages = byPage(settings); const end = pages.return?.bind(pages);
      pages.return = async () => { const result = await end?.(); returning = true; await gate.promise;
        if (failure !== 'close') throw new Error('private cleanup'); return result ?? { done: true, value: undefined }; };
      return pages;
    }; return entities;
  });
  let settled = false; let closed = false;
  const inspection = i.inspect({ ...visitor(), record() { callbacks++; } }, budget({ maxPageBytes: failure === 'body-budget' ? 1 : 1024 * 1024 }))
    .then(() => 'success', e => code(failure === 'corrupt' ? 'unresolved' : 'incomplete')(e) ? 'expected' : 'other').then(v => { settled = true; return v; });
  let close: Promise<void> | undefined;
  try {
    await eventually(() => returning); close = i.close().then(() => { closed = true; });
    await new Promise(r => setTimeout(r, 20)); assert.equal(settled, false); assert.equal(closed, false); assert.equal(i.status().pending, 1);
    assert.equal(i.status().ownership, 'none'); assert.equal(f.s.stats.requests, f.s.stats.socketCloses); f.unchanged();
  } finally { gate.resolve(); }
  assert.equal(await inspection, 'expected'); await close; assert.equal(callbacks, 0); assert.equal(i.status().pending, 0); f.unchanged();
});
test('foreign close drains a separately held real socket destroy, not just the request promise', async t => {
  const f = await foreign(t); const i = f.create(); let release: (() => void) | undefined; let socketLive = () => false;
  f.s.controls.request = ((...args: Parameters<typeof https.request>) => {
    const req = f.s.request(...args);
    req.once('socket', socket => {
      const destroy = socket.destroy.bind(socket); socketLive = () => !socket.destroyed;
      socket.destroy = error => { release = () => { destroy(error); }; return socket; };
    }); return req;
  }) as typeof https.request;
  let settled = false; let closed = false; let calls = 0; let close: Promise<void> | undefined;
  const inspection = i.inspect({ ...visitor(), record() { calls++; } }, budget()).then(() => 'success', e => code('incomplete')(e) ? 'incomplete' : 'other')
    .then(v => { settled = true; return v; });
  try {
    await eventually(() => !!release); assert.equal(socketLive(), true);
    close = i.close().then(() => { closed = true; });
    await new Promise(r => setTimeout(r, 20)); assert.equal(settled, false); assert.equal(closed, false); assert.equal(i.status().pending, 1);
    assert.equal(f.s.stats.requests - f.s.stats.socketCloses, 1); f.unchanged();
  } finally { release?.(); }
  assert.equal(await inspection, 'incomplete'); await close; assert.equal(calls, 0); assert.equal(i.status().pending, 0); f.unchanged();
});
test('foreign close after provisional M callback keeps later-page token reservation until settlement', async t => {
  const f = await foreign(t); putData(f.s); let tokens = 0; let held = false; const gate = deferred<string>(); let callbacks = 0;
  const i = createTableForeignInspectorV2(f.binding, { ...f.dependencies, token: async (...args) => {
    if (++tokens === 3) { held = true; return gate.promise; } return f.dependencies.token(...args);
  } }, f.expected);
  let settled = false; let closed = false; let close: Promise<void> | undefined;
  const inspection = i.inspect({ ...visitor(), record() { callbacks++; } }, budget()).then(() => 'success', e => code('incomplete')(e) ? 'incomplete' : 'other')
    .then(v => { settled = true; return v; });
  try {
    await eventually(() => held); assert.equal(callbacks, 1); close = i.close().then(() => { closed = true; });
    await new Promise(r => setTimeout(r, 20)); assert.equal(settled, false); assert.equal(closed, false); assert.equal(i.status().pending, 1);
    assert.equal(f.stats.gets, 2); f.unchanged();
  } finally { gate.resolve(syntheticToken); }
  assert.equal(await inspection, 'incomplete'); await close; assert.equal(callbacks, 1); assert.equal(f.stats.gets, 2); f.unchanged();
});
test('foreign page retention gate aborts before malformed excess is decoded and drains held native work', async t => {
  const f = await foreign(t); const i = f.create(); const excess = deferred(); let received = false; let release: (() => void) | undefined;
  f.s.controls.hook = async e => {
    if (e.path.includes(",RowKey='M'")) { e.reply(); return; }
    e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.write('{'); await excess.promise; e.res.write('invalid');
  };
  f.s.controls.request = ((url: URL, options: https.RequestOptions, callback: (res: IncomingMessage) => void) => {
    const page = !url.pathname.includes('RowKey');
    const req = f.s.request(url, options, res => {
      if (page) { const destroy = res.destroy.bind(res); res.destroy = () => { release = () => { destroy(); }; return res; }; res.on('data', () => { received = true; }); }
      callback(res);
    });
    if (page) { const destroy = req.destroy.bind(req); req.destroy = () => { const prior = release; release = () => { prior?.(); destroy(); }; return req; }; }
    return req;
  }) as typeof https.request;
  let settled = false; let closed = false; let callbacks = 0; let close: Promise<void> | undefined;
  const inspection = i.inspect({ ...visitor(), record() { callbacks++; } }, budget({ maxPageBytes: 1 }))
    .then(() => 'success', e => code('incomplete')(e) ? 'incomplete' : 'other').then(v => { settled = true; return v; });
  try {
    await eventually(() => received); excess.resolve(); await eventually(() => !!release);
    assert.equal(i.status().lifecycle, 'failed'); close = i.close().then(() => { closed = true; });
    await new Promise(r => setTimeout(r, 20)); assert.equal(settled, false); assert.equal(closed, false); assert.equal(i.status().pending, 1); f.unchanged();
  } finally { excess.resolve(); release?.(); }
  assert.equal(await inspection, 'incomplete'); await close; assert.equal(callbacks, 0); assert.equal(f.s.stats.requests, f.s.stats.socketCloses); f.unchanged();
});
