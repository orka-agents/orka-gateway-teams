import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHub } from '../src/accounts/github.js';
import type { BrowserAttempt } from '../src/accounts/store.js';
import { context, deferred } from './support/directory-table.js';
import { githubFixture, githubPair } from './support/github.js';
const config = { clientId: 'Iv1.synthetic', clientSecret: 'CLIENT_PRIVATE', publicOrigin: 'https://signin.example.invalid' };
const epoch = 1_800_000_000_000;
const attempt: BrowserAttempt = { state: 'bound-state', nonce: 'nonce', verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  challenge: { id: 'id', objectId: 'sender', conversationId: 'chat', activityId: 'activity', generation: 1, expiresAt: epoch + 600000, state: 'exchanging' } };
async function setup(t: test.TestContext) { const f = await githubFixture(t); const client = createGitHub(config, { request: f.request, now: () => epoch }); t.after(() => client.close()); return { ...f, client }; }

test('GitHub authorization has fixed callback, expiring user scope, state and S256 without secrets', async t => {
  const f = await setup(t); const url = new URL(f.client.authorizeUrl(attempt));
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: 'Iv1.synthetic', redirect_uri: 'https://signin.example.invalid/github/callback',
    scope: 'offline_access', state: 'bound-state', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' });
  assert.ok(!url.href.includes('CLIENT_PRIVATE')); assert.equal(f.requests.length, 0);
});
test('native GitHub web exchange obtains the immutable authenticated user ID and both token expiries', async t => {
  const f = await setup(t); const value = await f.client.redeemCode('CODE_PRIVATE', attempt, context());
  assert.deepEqual(value, { accessToken: 'ghu_ACCESS_PRIVATE', refreshToken: 'ghr_REFRESH_PRIVATE', providerUserId: '12345',
    expiresAt: epoch + 28800000, refreshExpiresAt: epoch + 15897600000 });
  assert.equal(f.requests.length, 2);
  const token = f.requests[0]!; assert.equal(token.method, 'POST'); assert.equal(token.url, '/login/oauth/access_token');
  assert.deepEqual(Object.fromEntries(token.form), { client_id: 'Iv1.synthetic', client_secret: 'CLIENT_PRIVATE', code: 'CODE_PRIVATE',
    code_verifier: attempt.verifier, redirect_uri: 'https://signin.example.invalid/github/callback' });
  assert.equal(token.headers.accept, 'application/json'); assert.equal(token.headers.authorization, undefined);
  const user = f.requests[1]!; assert.equal(user.method, 'GET'); assert.equal(user.url, '/user');
  assert.equal(user.headers.authorization, 'Bearer ghu_ACCESS_PRIVATE'); assert.equal(user.headers['x-github-api-version'], '2026-03-10');
  assert.ok(user.headers['user-agent']); assert.equal(user.form.toString(), ''); assert.equal(f.sockets(), 0);
});
test('refresh uses web client credentials and verifies /user again without reusing the old pair', async t => {
  const f = await setup(t); const value = await f.client.refresh('OLD_REFRESH', context());
  assert.equal(value.providerUserId, '12345'); assert.equal(value.refreshToken, 'ghr_REFRESH_PRIVATE');
  assert.deepEqual(Object.fromEntries(f.requests[0]!.form), { client_id: 'Iv1.synthetic', client_secret: 'CLIENT_PRIVATE', grant_type: 'refresh_token', refresh_token: 'OLD_REFRESH' });
  assert.equal(f.requests.length, 2);
});
for (const error of ['bad_verification_code', 'bad_refresh_token', 'incorrect_client_credentials']) test(`HTTP200 ${error} is sanitized and never retried`, async t => {
  const f = await setup(t); f.behavior((_req, res) => res.end(JSON.stringify({ error, error_description: 'CLIENT_PRIVATE CODE_PRIVATE' })));
  await assert.rejects(f.client.refresh('OLD_REFRESH', context()), { message: 'GitHub sign-in unavailable' }); assert.equal(f.requests.length, 1);
});
test('nonexpiring, malformed and partial GitHub token pairs cannot become linked identities', async t => {
  const f = await setup(t);
  for (const change of [{ refresh_token: undefined }, { refresh_token_expires_in: undefined }, { expires_in: undefined }, { expires_in: 0 },
    { expires_in: 28801 }, { expires_in: '28800' }, { refresh_token_expires_in: 0 }, { refresh_token_expires_in: 15897601 },
    { access_token: 'bad\nprivate' }, { token_type: 'Other' }]) {
    f.behavior((_req, res) => res.end(JSON.stringify({ ...githubPair(), ...change })));
    const before = f.requests.length; await assert.rejects(f.client.redeemCode('CODE_PRIVATE', attempt, context()), { message: 'GitHub sign-in unavailable' });
    assert.equal(f.requests.length - before, 1);
  }
  for (const id of [undefined, '12345', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    f.behavior((req, res) => res.end(JSON.stringify(req.url === '/user' ? { id, login: '12345' } : githubPair())));
    await assert.rejects(f.client.refresh('OLD_REFRESH', context()), { message: 'GitHub sign-in unavailable' });
  }
});
test('redirect, unauthorized, malformed, encoded and oversized native responses are fixed failures without follow-up requests', async t => {
  const f = await setup(t);
  for (const kind of ['redirect', 'unauthorized', 'malformed', 'encoded', 'oversized']) {
    f.behavior((_req, res) => {
      if (kind === 'redirect') res.writeHead(302, { location: 'https://evil.invalid/' });
      if (kind === 'unauthorized') res.writeHead(401);
      if (kind === 'encoded') res.setHeader('content-encoding', 'gzip');
      res.end(kind === 'oversized' ? 'x'.repeat(65537) : kind === 'malformed' ? '{' : JSON.stringify(githubPair()));
    });
    const before = f.requests.length; await assert.rejects(f.client.refresh('OLD_REFRESH', context()), { message: 'GitHub sign-in unavailable' });
    assert.equal(f.requests.length - before, 1); assert.equal(f.sockets(), 0);
  }
});
test('held native response honors deadline and close drains sockets; canceled/closed calls never acquire tokens', async t => {
  const f = await setup(t); const entered = deferred(); f.behavior(() => entered.resolve());
  const pending = f.client.refresh('OLD_REFRESH', { ...context(), deadline: performance.now() + 100 });
  const rejection = assert.rejects(pending, { message: 'GitHub sign-in unavailable' }); await entered.promise; await rejection;
  assert.equal(f.sockets(), 0);
  const next = f.client.refresh('OLD_REFRESH', context()); const rejected = assert.rejects(next, { message: 'GitHub sign-in unavailable' });
  await f.client.close(); await rejected; assert.equal(f.sockets(), 0);
  const before = f.requests.length; await assert.rejects(f.client.refresh('OLD_REFRESH', context())); assert.equal(f.requests.length, before);
});
