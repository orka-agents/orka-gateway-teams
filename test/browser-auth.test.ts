import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import type https from 'node:https';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { createDelegatedAuth, WORK_IQ_SCOPE } from '../src/auth/delegated.js';
import type { BrowserAttempt } from '../src/accounts/store.js';
import { miConfig, imdsFixture } from './support/managed-identity.js';

const oid = 'abcdef12-abcd-4abc-8abc-abcdefabcdef';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'browser-key', use: 'sig', alg: 'RS256' };
const issuer = `https://login.microsoftonline.com/${miConfig.tenantId}/v2.0`;
const redirectUri = 'https://gateway.example/oauth/callback';
const attempt: BrowserAttempt = { state: 'synthetic-state', nonce: 'synthetic-nonce',
  // RFC 7636 section 4.2's independent S256 example.
  verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  challenge: { id: 'synthetic-challenge', objectId: oid, conversationId: 'chat', activityId: 'message', generation: 1,
    expiresAt: Date.now() + 600000, state: 'exchanging', method: 'browser' } };
const context = () => ({ signal: new AbortController().signal, deadline: performance.now() + 9000 });
function idToken(claims: Record<string, unknown> = {}, privateKey = pair.privateKey, algorithm: jwt.Algorithm = 'RS256') {
  return jwt.sign(JSON.parse(JSON.stringify({ tid: miConfig.tenantId, oid, aud: miConfig.appId, iss: issuer,
    nonce: attempt.nonce, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })), privateKey, { algorithm, keyid: 'browser-key' });
}
async function fixture(t: Parameters<typeof imdsFixture>[0]) {
  const imds = await imdsFixture(t); let status = 200; let posts = 0;
  let response: Record<string, unknown> = { access_token: 'synthetic-browser-access', refresh_token: 'synthetic-refresh',
    token_type: 'Bearer', expires_in: 3600, scope: WORK_IQ_SCOPE, id_token: idToken() };
  let form = new URLSearchParams();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
      posts++; form = new URLSearchParams(Buffer.concat(chunks).toString());
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = ((url: URL, options: https.RequestOptions, cb: (response: http.IncomingMessage) => void) => {
    assert.equal(url.href, `https://login.microsoftonline.com/${miConfig.tenantId}/oauth2/v2.0/token`);
    assert.equal(options.method, 'POST'); assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
    return http.request(`http://127.0.0.1:${address.port}/token`, options, cb);
  }) as typeof https.request;
  const auth = createDelegatedAuth(miConfig, { request, managedIdentity: { imdsRequest: imds.imdsRequest },
    fetchKeys: async (url, options) => {
      assert.equal(url, `https://login.microsoftonline.com/${miConfig.tenantId}/discovery/v2.0/keys`);
      assert.equal(options.redirect, 'error'); return new Response(JSON.stringify({ keys: [jwk] }));
    } });
  t.after(() => auth.close());
  return { auth, imds, form: () => form, posts: () => posts,
    reply: (value: Record<string, unknown>, code = 200) => { response = value; status = code; },
    defaults: () => ({ access_token: 'synthetic-browser-access', refresh_token: 'synthetic-refresh',
      token_type: 'Bearer', expires_in: 3600, scope: WORK_IQ_SCOPE, id_token: idToken() }) };
}

test('authorize URL uses tenant-specific form_post, fixed redirect, offline scope, state, nonce and S256', () => {
  const auth = createDelegatedAuth(miConfig);
  const url = new URL(auth.authorizeUrl(attempt, redirectUri));
  assert.equal(url.origin + url.pathname, `https://login.microsoftonline.com/${miConfig.tenantId}/oauth2/v2.0/authorize`);
  assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: miConfig.appId, response_type: 'code', response_mode: 'form_post',
    redirect_uri: redirectUri, scope: `openid profile offline_access ${WORK_IQ_SCOPE}`, state: 'synthetic-state', nonce: 'synthetic-nonce',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' });
  assert.equal(url.searchParams.has('code_verifier'), false); void auth.close();
});

test('code redemption uses federation and PKCE then returns signed same-sender cache without the ID token', async t => {
  const f = await fixture(t);
  f.reply({ ...f.defaults(), id_token: idToken({ oid: oid.toUpperCase() }) });
  const result = await f.auth.redeemCode('synthetic-code', attempt, redirectUri, context());
  assert.equal(result.accessToken === 'synthetic-browser-access', true);
  assert.equal(result.refreshToken === 'synthetic-refresh', true); assert.ok(result.expiresAt > Date.now());
  assert.deepEqual(Object.keys(result).sort(), ['accessToken', 'expiresAt', 'refreshToken']);
  const form = f.form();
  assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('redirect_uri'), redirectUri);
  assert.equal(form.get('code') === 'synthetic-code', true); assert.equal(form.get('code_verifier') === attempt.verifier, true);
  assert.equal(form.get('scope'), `openid profile offline_access ${WORK_IQ_SCOPE}`);
  assert.equal(form.get('client_id'), miConfig.appId); assert.equal(form.get('client_secret'), null);
  assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  assert.ok(form.get('client_assertion')); assert.equal(f.imds.calls(), 1); assert.equal(f.posts(), 1);
  // The same signed ID token cannot satisfy a distinct browser transaction's nonce.
  await assert.rejects(f.auth.redeemCode('other-code', { ...attempt, nonce: 'other-nonce' }, redirectUri, context()),
    { message: 'Delegated sign-in unavailable' });
});

test('browser signed identity rejects wrong nonce, tenant, sender, audience, issuer, expiry and signature', async t => {
  const f = await fixture(t);
  const invalid = [idToken({ nonce: 'wrong' }), idToken({ nonce: undefined }), idToken({ tid: oid }),
    idToken({ oid: miConfig.appId }), idToken({ oid: 'not-a-guid' }), idToken({ aud: oid }), idToken({ aud: [miConfig.appId] }),
    idToken({ iss: `https://sts.windows.net/${miConfig.tenantId}/` }), idToken({ exp: 1 }), idToken({ exp: undefined }),
    idToken({}, wrongPair.privateKey), idToken({}, pair.privateKey, 'RS384')];
  for (const raw of invalid) {
    f.reply({ ...f.defaults(), id_token: raw });
    await assert.rejects(f.auth.redeemCode('synthetic-code', attempt, redirectUri, context()), { message: 'Delegated sign-in unavailable' });
  }
});

test('code response requires refresh token, signed ID token and a valid scoped bearer token', async t => {
  const f = await fixture(t);
  for (const change of [{ refresh_token: undefined }, { refresh_token: '' }, { refresh_token: 'bad\nprivate' },
    { id_token: undefined }, { scope: 'different.scope' }, { access_token: '' }, { access_token: 'bad\nprivate' },
    { token_type: 'Other' }, { expires_in: 0 }, { expires_in: 86401 }, { expires_in: '3600' }]) {
    f.reply({ ...f.defaults(), ...change });
    await assert.rejects(f.auth.redeemCode('synthetic-code', attempt, redirectUri, context()), { message: 'Delegated sign-in unavailable' });
  }
});

test('refresh rotates its native cache or retains the previous refresh token without requiring an ID token', async t => {
  const f = await fixture(t); f.reply({ ...f.defaults(), id_token: undefined, refresh_token: 'rotated-refresh' });
  const rotated = await f.auth.refresh('original-refresh', context());
  assert.equal(rotated.refreshToken === 'rotated-refresh', true);
  assert.equal(f.form().get('grant_type'), 'refresh_token'); assert.equal(f.form().get('refresh_token') === 'original-refresh', true);
  assert.equal(f.form().get('scope'), WORK_IQ_SCOPE); assert.equal(f.form().has('client_secret'), false);
  assert.ok(f.form().get('client_assertion'));
  f.reply({ ...f.defaults(), id_token: undefined, refresh_token: undefined });
  assert.equal((await f.auth.refresh('rotated-refresh', context())).refreshToken === 'rotated-refresh', true);
  f.reply({ ...f.defaults(), scope: 'wrong' });
  await assert.rejects(f.auth.refresh('rotated-refresh', context()), { message: 'Delegated sign-in unavailable' });
  f.reply({ error: 'invalid_grant', error_description: 'private' }, 400);
  const before = f.posts();
  await assert.rejects(f.auth.refresh('rotated-refresh', context()), { code: 'invalid-grant', message: 'Delegated sign-in unavailable' });
  assert.equal(f.posts() - before, 1);
});

test('browser token operations honor cancellation before network and closed auth cannot return tokens', async t => {
  const f = await fixture(t); const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.auth.redeemCode('synthetic-code', attempt, redirectUri, { ...context(), signal: aborted.signal }));
  await assert.rejects(f.auth.refresh('synthetic-refresh', { ...context(), signal: aborted.signal }));
  assert.equal(f.posts(), 0); await f.auth.close();
  await assert.rejects(f.auth.refresh('synthetic-refresh', context())); assert.equal(f.posts(), 0);
});
