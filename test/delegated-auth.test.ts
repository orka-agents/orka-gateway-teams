import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import type https from 'node:https';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { createDelegatedAuth, WORK_IQ_SCOPE } from '../src/auth/delegated.js';
import { prepareFederatedAssertion } from '../src/auth/managed-identity.js';
import { miConfig, imdsFixture } from './support/managed-identity.js';
import { deferred } from './support/ingress-auth.js';

const oid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'delegated-key', use: 'sig', alg: 'RS256' };
const issuer = `https://login.microsoftonline.com/${miConfig.tenantId}/v2.0`;
function token(claims: Record<string, unknown> = {}) {
  const payload = { tid: miConfig.tenantId, oid, scp: 'access_as_user', aud: miConfig.appId, iss: issuer,
    exp: Math.floor(Date.now() / 1000) + 3600, ...claims };
  return jwt.sign(JSON.parse(JSON.stringify(payload)), pair.privateKey, { algorithm: 'RS256', keyid: 'delegated-key' });
}
const context = () => ({ signal: new AbortController().signal, deadline: performance.now() + 9000 });
const keys = async (url: string, options: RequestInit) => {
  assert.equal(url, `https://login.microsoftonline.com/${miConfig.tenantId}/discovery/v2.0/keys`);
  assert.equal(options.redirect, 'error');
  return new Response(JSON.stringify({ keys: [jwk] }));
};

test('delegated JWT signature, issuer, gateway audience, lifetime, scope and sender bind before OBO', async () => {
  let calls = 0;
  const auth = createDelegatedAuth(miConfig, { fetchKeys: async (...args) => { calls++; return keys(...args); } });
  assert.ok((await auth.verify(token(), oid, context())).assertionExpiresAt > Date.now());
  for (const claims of [{ tid: oid }, { oid: miConfig.appId }, { aud: oid }, { aud: [miConfig.appId] },
    { iss: `https://sts.windows.net/${miConfig.tenantId}/` }, { exp: 1 }, { exp: undefined }, { scp: 'other' },
    { scp: ['access_as_user'] }, { nbf: Math.floor(Date.now() / 1000) + 1000 }]) {
    await assert.rejects(auth.verify(token(claims), oid, context()), { message: 'Delegated sign-in unavailable' });
  }
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(auth.verify(jwt.sign({ exp: Math.floor(Date.now() / 1000) + 60 }, other.privateKey,
    { algorithm: 'RS256', keyid: 'delegated-key' }), oid, context()));
  await assert.rejects(auth.verify(token(), miConfig.appId, context()));
  assert.equal(calls, 1);
  for (let i = 0; i < 10; i++) {
    const raw = jwt.sign({ exp: Math.floor(Date.now() / 1000) + 60 }, pair.privateKey, { algorithm: 'RS256', keyid: `unknown-${i}` });
    await assert.rejects(auth.verify(raw, oid, context()));
  }
  assert.equal(calls, 1); await auth.close(); await assert.rejects(auth.verify(token(), oid, context()));
});

test('OBO uses fresh federated assertion, access-token assertion and fixed Work IQ scope, never client secret', async t => {
  const imds = await imdsFixture(t); let posts = 0; let good = false;
  const raw = token(); let status = 200; let reply: Record<string, unknown> = { access_token: 'synthetic-workiq-access',
    token_type: 'Bearer', expires_in: 3600, scope: WORK_IQ_SCOPE };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
      posts++; const form = new URLSearchParams(Buffer.concat(chunks).toString());
      good = form.get('assertion') === raw && form.get('client_id') === miConfig.appId &&
        form.get('scope') === WORK_IQ_SCOPE && form.get('requested_token_use') === 'on_behalf_of' &&
        form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' &&
        form.get('client_assertion_type') === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' &&
        Boolean(form.get('client_assertion')) && !form.has('client_secret');
      res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = ((url: URL, options: http.RequestOptions, cb: (response: http.IncomingMessage) => void) => {
    assert.equal(url.href, `https://login.microsoftonline.com/${miConfig.tenantId}/oauth2/v2.0/token`);
    assert.equal(options.method, 'POST'); assert.equal(options.agent, false); assert.equal((options as https.RequestOptions).rejectUnauthorized, true);
    return http.request(`http://127.0.0.1:${address.port}/token`, options, cb);
  }) as typeof https.request;
  const auth = createDelegatedAuth(miConfig, { fetchKeys: keys, managedIdentity: { imdsRequest: imds.imdsRequest }, request });
  const result = await auth.exchange(raw, context());
  assert.equal(result.accessToken === 'synthetic-workiq-access', true); assert.equal(result.assertion === raw, true);
  assert.ok(result.expiresAt > Date.now()); assert.ok(result.assertionExpiresAt! <= Date.now() + 600000);
  assert.equal(good, true); assert.equal(posts, 1); assert.equal(imds.calls(), 1);
  for (const invalid of [{ ...reply, scope: 'different.scope' }, { ...reply, expires_in: -1 }, { ...reply, access_token: 'private\\ninvalid' },
    { ...reply, error: 'PRIVATE-OAUTH-ERROR' }]) {
    reply = invalid; await assert.rejects(auth.exchange(raw, context()), { message: 'Delegated sign-in unavailable' });
  }
  reply = { error: 'invalid_grant', error_description: 'PRIVATE-OAUTH-ERROR' }; status = 400;
  await assert.rejects(auth.exchange(raw, context()), { code: 'invalid-grant', message: 'Delegated sign-in unavailable' });
  const before = posts;
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(auth.exchange(raw, { signal: aborted.signal, deadline: performance.now() + 9000 }));
  assert.equal(posts, before); await auth.close();
});

test('federated assertion preparation freezes caller-owned transports and tenant', async t => {
  const local = await imdsFixture(t); const input = { ...miConfig }; const dependencies = { imdsRequest: local.imdsRequest };
  const acquire = prepareFederatedAssertion(input, dependencies);
  dependencies.imdsRequest = () => { throw new Error('Replaced transport must not run'); };
  input.tenantId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  assert.equal(typeof await acquire(), 'string'); assert.equal(local.calls(), 1);
});

test('equivalent GUID tenant casing does not reject a valid delegated token', async () => {
  const lower = 'abcdef12-abcd-4abc-8abc-abcdefabcdef';
  const auth = createDelegatedAuth({ ...miConfig, tenantId: lower.toUpperCase() }, {
    fetchKeys: async () => new Response(JSON.stringify({ keys: [jwk] })) });
  try { await auth.verify(token({ tid: lower, iss: `https://login.microsoftonline.com/${lower}/v2.0` }), oid, context()); }
  finally { await auth.close(); }
});

test('shutdown waits held key retrieval and cancellation never publishes usable verification', async () => {
  const held = deferred<Response>(); let finished = false;
  const auth = createDelegatedAuth(miConfig, { fetchKeys: async () => held.promise });
  const verifying = auth.verify(token(), oid, context());
  const closing = auth.close().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  held.resolve(new Response(JSON.stringify({ keys: [jwk] })));
  await assert.rejects(verifying, { message: 'Delegated sign-in unavailable' }); await closing;
});
