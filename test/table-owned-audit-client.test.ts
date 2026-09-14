import assert from 'node:assert/strict';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { OwnedTableClient } from '../src/storage/table/client.js';
import { bindTable } from '../src/storage/table/codec.js';
import { context, deferred, eventually, tableBinding, tableService } from './support/table-service.js';

const code = (want: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === want && !('cause' in e);
for (const format of [1, 2] as const) for (const allowance of [11, 12]) test(`V${format} audit native body allowance ${allowance} counts exact wire bytes`, async t => {
  const s = await tableService(t, 'delivery', format); let exhausted = 0;
  s.controls.hook = e => { e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.end('{"value":[]}'); };
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies, format);
  const page = c.page(context(), undefined, { maxBytes: allowance, exhaust: () => { exhausted++; } });
  if (allowance === 11) await assert.rejects(page, code('incomplete')); else assert.equal((await page).size, 12);
  assert.equal(exhausted, allowance === 11 ? 1 : 0); await c.close();
  assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});
test('fragmented audit overflow never decodes the truncated malformed body and waits for actual destruction', async t => {
  const s = await tableService(t); const sendExcess = deferred(); let release: (() => void) | undefined; let received = false;
  s.controls.hook = async e => {
    e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.write('{');
    await sendExcess.promise; e.res.write('invalid');
  };
  s.controls.request = ((url: URL, options: https.RequestOptions, callback: (res: IncomingMessage) => void) => {
    const req = s.request(url, options, res => {
      const destroy = res.destroy.bind(res);
      res.destroy = () => { release = () => { destroy(); }; return res; };
      res.on('data', () => { received = true; }); callback(res);
    });
    const destroy = req.destroy.bind(req);
    req.destroy = () => { const prior = release; release = () => { prior?.(); destroy(); }; return req; };
    return req;
  }) as typeof https.request;
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies); let exhausted = 0; let settled = false;
  const outcome = c.page(context(), undefined, { maxBytes: 1, exhaust: () => { exhausted++; } })
    .then(() => { settled = true; return 'success'; }, e => { settled = true; return code('incomplete')(e) ? 'incomplete' : 'other'; });
  await eventually(() => received); sendExcess.resolve(); await eventually(() => !!release);
  assert.equal(exhausted, 1); assert.equal(settled, false); assert.equal(s.stats.requestCloses, 0);
  let closed = false; const close = c.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(closed, false);
  release!(); assert.equal(await outcome, 'incomplete'); await close;
  assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});
