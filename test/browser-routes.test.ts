import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { NativeAdapter } from '../src/ingress/http-adapter.js';
import { deferred } from './support/ingress-auth.js';

const challenge = 'a'.repeat(64) + '.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function call(port: number, path: string, method = 'GET', body = '', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    }); req.on('error', reject); req.end(body);
  });
}
async function fixture(t: test.TestContext, enabled = true) {
  let verifications = 0; const begins: string[] = []; const forms: string[][] = []; let gate: Promise<void> | undefined;
  const adapter = new NativeAdapter(async () => { verifications++; return false; }, enabled ? {
    origin: 'https://signin.example.invalid',
    begin: async (id, ctx) => { assert.ok(!ctx.signal.aborted); begins.push(id); await gate;
      return 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?synthetic=only'; },
    callback: async form => { forms.push([...form.keys()]); return form.get('code') === 'synthetic-private-code'; },
  } : undefined);
  adapter.registerRoute('POST', '/api/messages', async () => ({ status: 200 }));
  const port = await adapter.listen('127.0.0.1', 0); t.after(() => adapter.stop());
  return { port, adapter, begins, forms, verifications: () => verifications, hold: (value: Promise<void>) => { gate = value; } };
}

test('only configured fixed browser routes bypass Bot authentication; redirect never trusts Host', async t => {
  const f = await fixture(t);
  const result = await call(f.port, '/signin?challenge=' + challenge, 'GET', '', { host: 'attacker.example.invalid' });
  assert.equal(result.status, 302); assert.equal(result.headers.location?.startsWith('https://login.microsoftonline.com/'), true);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.match(String(result.headers['content-security-policy']), /frame-ancestors 'none'/); assert.equal(f.verifications(), 0);
  assert.equal((await call(f.port, '/api/messages', 'POST', '{}', { 'content-type': 'application/json' })).status, 401);
  assert.equal(f.verifications(), 1);
  assert.equal((await call(f.port, '/github/callback?code=c&state=s')).status, 404);
  const disabled = await fixture(t, false);
  assert.equal((await call(disabled.port, '/signin?challenge=' + challenge)).status, 404);
  assert.equal((await call(disabled.port, '/oauth/callback', 'POST', 'state=x&code=y', { 'content-type': 'application/x-www-form-urlencoded' })).status, 404);
});

test('malformed challenges and alternate destinations have no browser effect', async t => {
  const f = await fixture(t);
  for (const path of ['/signin', '/signin?challenge=bad', '/signin?challenge=' + challenge + '&challenge=' + challenge,
    '/signin?challenge=' + challenge + '&redirect_uri=https://evil.invalid', '/oauth/callback?redirect=x', '//signin?challenge=' + challenge]) {
    assert.ok((await call(f.port, path)).status >= 400);
  }
  assert.equal(f.begins.length, 0); assert.equal(f.forms.length, 0); assert.equal(f.verifications(), 0);
});

test('callback accepts bounded unique form fields only and never echoes code or OAuth error', async t => {
  const f = await fixture(t); const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const good = await call(f.port, '/oauth/callback', 'POST', 'code=synthetic-private-code&state=s&session_state=x', headers);
  assert.equal(good.status, 200); assert.match(good.text, /[Ss]end your request again/);
  assert.doesNotMatch(good.text, /synthetic-private-code|state=s/);
  const error = await call(f.port, '/oauth/callback', 'POST', 'error=access_denied&error_description=synthetic-private-error&state=s', headers);
  assert.equal(error.status, 400); assert.doesNotMatch(error.text, /synthetic-private-error|access_denied/);
  const before = f.forms.length;
  for (const body of ['code=x&code=y&state=s', 'code=x&error=y&state=s', 'state=s', 'code=x&state=s&redirect_uri=https://evil.invalid',
    'code=' + 'x'.repeat(16384) + '&state=s']) {
    assert.ok((await call(f.port, '/oauth/callback', 'POST', body, headers)).status >= 400);
  }
  assert.equal(f.forms.length, before);
  assert.equal((await call(f.port, '/oauth/callback', 'POST', '{}', { 'content-type': 'application/json' })).status, 415);
});

test('durably committed callback answers200 before slow notification exceeds real10s timer and drains held work', { timeout: 20000 }, async t => {
  const { grantsFixture } = await import('./support/task-grants.js'); const f = await grantsFixture(t);
  const entered = deferred<void>(); const release = deferred<void>(); let oldWork = 0;
  const adapter = new NativeAdapter(async () => true, { origin: 'https://signin.example.invalid', begin: async () => undefined,
    callback: async (_form, ctx) => {
      const ch = await f.store.challenge(f.subject, 'browser-chat', 'browser-attempt', ctx);
      assert.equal(await f.store.claim(ch, ctx), 'claimed');
      assert.equal(await f.store.complete(ch, { accessToken: 'NEW-PRIVATE', expiresAt: f.now() + 100000 }, ctx), true);
      (ctx as typeof ctx & { committed?(): void }).committed?.(); entered.resolve(); await release.promise; return true;
    } });
  adapter.registerRoute('POST', '/api/messages', async () => { oldWork++; return { status: 200 }; });
  const port = await adapter.listen('127.0.0.1', 0); t.after(() => { release.resolve(); return adapter.stop(); });
  const response = call(port, '/oauth/callback', 'POST', 'state=s&code=private', { 'content-type': 'application/x-www-form-urlencoded' }).catch(() => ({ status: 0, text: '' }));
  await entered.promise;
  // Hold real post-publication work beyond the receiver's unchanged absolute timer.
  await new Promise(resolve => setTimeout(resolve, 10100));
  const result = await response; assert.equal(result.status, 200); assert.match(result.text, /signed in/); assert.doesNotMatch(result.text, /PRIVATE/);
  assert.equal((await f.store.inspect(f.subject, { signal: new AbortController().signal, deadline: performance.now() + 1000 })).linked, true);
  let drained = false; const stop = adapter.stop().then(() => { drained = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release.resolve(); await stop; assert.equal(oldWork, 0);
});

test('browser work cannot occupy all Bot HTTP slots and shutdown drains actual handlers', async t => {
  const f = await fixture(t); const held = deferred<void>(); f.hold(held.promise);
  const first = call(f.port, '/signin?challenge=' + challenge).catch(() => undefined);
  const second = call(f.port, '/signin?challenge=' + challenge).catch(() => undefined);
  for (let n = 0; n < 1000 && f.begins.length < 2; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.begins.length, 2);
  assert.equal((await call(f.port, '/signin?challenge=' + challenge)).status, 503);
  assert.equal((await call(f.port, '/api/messages', 'POST', '{}', { 'content-type': 'application/json' })).status, 401);
  let drained = false; const stopping = f.adapter.stop().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  held.resolve(); await Promise.all([first, second, stopping]); assert.equal(drained, true);
});
