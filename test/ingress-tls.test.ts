import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigurationError } from '../src/ingress/config.js';
import { startReceiver } from '../src/ingress/server.js';
import { startIngressRuntime } from '../src/ingress/main.js';
import { authFixture, deferred, post, receiverConfig, scope } from './support/ingress-auth.js';
import { httpsFixture } from './support/ingress-https.js';

// Node's test runner isolates this file in its own process. Every key request in
// these environment-mutation regressions is restricted to an ephemeral loopback fixture.
function isolateTlsEnvironment(t: TestContext): void {
  const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  t.after(() => {
    if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
  });
}
async function selfSignedAuth(t: TestContext) {
  const auth = await authFixture(t); let requests = 0;
  const tls = await httpsFixture(t, (_req, res) => {
    requests++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: [auth.key] }));
  });
  return { token: auth.token, requests: () => requests, dependencies: {
    sdkCloud: { ...auth.dependencies.sdkCloud, openIdMetadataUrl: `${tls.baseUrl}openidconfiguration` },
    fetchKeys: (_url: string, options: RequestInit) => fetch(`${tls.baseUrl}keys`, options),
  } };
}

test('untrusted self-signed HTTPS JWKS cannot authenticate a real signed activity with normal TLS', async (t) => {
  isolateTlsEnvironment(t); const auth = await selfSignedAuth(t); let admissions = 0;
  const receiver = await startReceiver(receiverConfig, { scope, admit: () => { admissions++; return { kind: 'accepted', replyTarget: 'saved' }; } }, auth.dependencies);
  t.after(() => receiver.stop());
  assert.equal((await post(receiver.port, auth.token())).status, 401); assert.equal(admissions, 0);
});

test('receiver library startup rejects Node TLS bypass without relying on config parsing', async (t) => {
  isolateTlsEnvironment(t); const auth = await selfSignedAuth(t);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  await assert.rejects(startReceiver(receiverConfig, { scope, admit: () => ({ kind: 'accepted', replyTarget: 'saved' }) }, auth.dependencies)
    .then((receiver) => { t.after(() => receiver.stop()); return receiver; }), ConfigurationError);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
});

test('runtime library rejects Node TLS bypass before attempting to open an inbox', async (t) => {
  isolateTlsEnvironment(t); const auth = await selfSignedAuth(t);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  await assert.rejects(startIngressRuntime({ receiver: receiverConfig, scope, dbPath: '/missing-ingress-fixture/inbox.sqlite',
    bearerToken: receiverConfig.clientSecret, policy: { maxPending: 1, maxRecords: 1, replayWindowMs: 1000 } }, auth.dependencies), ConfigurationError);
});

test('registered SDK route rejects Node TLS bypass enabled after startup instead of trusting self-signed JWKS', async (t) => {
  isolateTlsEnvironment(t); const auth = await selfSignedAuth(t); let admissions = 0;
  const receiver = await startReceiver(receiverConfig, { scope, admit: () => { admissions++; return { kind: 'accepted', replyTarget: 'saved' }; } }, auth.dependencies);
  t.after(() => receiver.stop());
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  assert.equal((await post(receiver.port, auth.token())).status, 401); assert.equal(admissions, 0);
  assert.equal(auth.requests(), 0); assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
});

test('late SDK callback cannot admit when Node TLS bypass changes during SDK verification', async (t) => {
  isolateTlsEnvironment(t); const auth = await authFixture(t); const gate = deferred<void>(); let admissions = 0;
  auth.delaySdk(gate.promise); t.after(() => gate.resolve());
  const receiver = await startReceiver(receiverConfig, { scope, admit: () => { admissions++; return { kind: 'accepted', replyTarget: 'saved' }; } }, auth.dependencies);
  t.after(() => receiver.stop());
  const response = post(receiver.port, auth.token());
  for (let i = 0; i < 200 && auth.requests() < 2; i++) await sleep(5);
  assert.equal(auth.requests(), 2);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; gate.resolve();
  assert.equal((await response).status, 401); assert.equal(admissions, 0);
});
