import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { NativeAdapter } from '../src/ingress/http-adapter.js';
const cookie = '__Host-github-link=' + 'a'.repeat(43);
const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };
async function call(port: number, path: string, method = 'GET', body = '', headers: Record<string, string | string[]> = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    }); req.on('error', reject); req.end(body);
  });
}
async function setup(t: test.TestContext) {
  let callback = async () => ({ redirect: 'https://github.com/login/oauth/authorize?state=synthetic', cookie: { value: 'a'.repeat(43), maxAge: 600 } });
  const calls: { fields: [string, string][]; cookie: string }[] = [];
  const adapter = new NativeAdapter(async () => false, { origin: 'https://signin.example.invalid', begin: async () => undefined,
    callback: () => callback(), githubCallback: async (form, value) => { calls.push({ fields: [...form], cookie: value }); return !form.has('error'); } });
  adapter.registerRoute('POST', '/api/messages', async () => ({ status: 200 })); const port = await adapter.listen('127.0.0.1', 0); t.after(() => adapter.stop());
  return { port, calls, continuation: (value: Awaited<ReturnType<typeof callback>>) => { callback = async () => value; } };
}
test('GitHub redirect is allowed only after the POST Microsoft continuation with a bounded host cookie', async t => {
  const f = await setup(t); const result = await call(f.port, '/oauth/callback', 'POST', 'state=s&code=c', formHeaders);
  assert.equal(result.status, 302); assert.equal(result.headers.location, 'https://github.com/login/oauth/authorize?state=synthetic');
  assert.equal(result.headers['set-cookie']?.[0], cookie + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600');
  for (const redirect of ['http://github.com/login/oauth/authorize', 'https://github.com.evil.invalid/login/oauth/authorize',
    'https://github.com/other', 'https://user@github.com/login/oauth/authorize', 'https://github.com/login/oauth/authorize#fragment']) {
    f.continuation({ redirect, cookie: { value: 'a'.repeat(43), maxAge: 600 } });
    assert.equal((await call(f.port, '/oauth/callback', 'POST', 'state=s&code=c', formHeaders)).status, 503);
  }
  for (const c of [{ value: 'bad; injected=1', maxAge: 600 }, { value: 'a'.repeat(43), maxAge: 601 }, { value: 'a'.repeat(43), maxAge: 0 }]) {
    f.continuation({ redirect: 'https://github.com/login/oauth/authorize', cookie: c });
    const refused = await call(f.port, '/oauth/callback', 'POST', 'state=s&code=c', formHeaders); assert.equal(refused.status, 503); assert.equal(refused.headers['set-cookie'], undefined);
  }
});
test('native GET callback passes unique success/denial fields and exactly one cookie; clears it without echoing provider content', async t => {
  const f = await setup(t);
  for (const [query, status] of [['code=CODE_PRIVATE&state=s', 200], ['error=access_denied&error_description=PRIVATE&state=s', 400]] as const) {
    const result = await call(f.port, '/github/callback?' + query, 'GET', '', { cookie }); assert.equal(result.status, status);
    assert.match(result.headers['set-cookie']![0]!, /Max-Age=0$/); assert.equal(result.headers['cache-control'], 'no-store'); assert.doesNotMatch(result.text, /PRIVATE/);
    assert.equal(f.calls.at(-1)!.cookie, 'a'.repeat(43)); assert.deepEqual(f.calls.at(-1)!.fields, [...new URLSearchParams(query)]);
  }
  const before = f.calls.length;
  for (const headers of [{}, { cookie: cookie + '; ' + cookie }, { cookie: cookie + '; __Host-github-link=' }, { cookie: '__Host-github-link=wrong' }, { cookie: [cookie, cookie] }]) {
    assert.equal((await call(f.port, '/github/callback?code=c&state=s', 'GET', '', headers)).status, 400);
  }
  for (const query of ['code=c&state=s&state=t', 'code=c&state=s&unexpected=1', 'code=c&state=s&error=e', 'code=c', 'state=s'])
    assert.equal((await call(f.port, '/github/callback?' + query, 'GET', '', { cookie })).status, 400);
  assert.equal(f.calls.length, before);
  assert.equal((await call(f.port, '/github/callback?code=c&state=s', 'POST', '', { cookie })).status, 404);
});
