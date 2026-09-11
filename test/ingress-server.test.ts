import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { startReceiver } from '../src/ingress/server.js';
import { initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import { activity, authFixture, deferred, post, receiverConfig, scope, serviceUrl } from './support/ingress-auth.js';
import { expectedEvent } from './fixtures/incoming.js';

test('SDK registered HTTP route verifies a real signature and durably admits the original personal event', async (t) => {
  const auth = await authFixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'teams-receiver-'));
  const path = join(directory, 'inbox.sqlite'); initializeIngressStore(path, scope);
  const store = openIngressStore(path, scope);
  const receiver = await startReceiver(receiverConfig, store, auth.dependencies);
  t.after(async () => { await receiver.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const response = await post(receiver.port, auth.token());
  assert.equal(response.status, 200);
  const claim = store.claim(); assert.ok(claim);
  assert.deepEqual({ ...claim.event, replyTarget: expectedEvent.replyTarget }, expectedEvent);
  assert.match(claim.event.replyTarget!, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(store.getRoute(claim.event.replyTarget!)?.bot.id, '28:fixture-app');
  // One strict JWKS load plus the SDK's independent signature-verification load.
  assert.equal(auth.requests(), 2);
});

async function fixture(t: TestContext) {
  const auth = await authFixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'teams-receiver-'));
  const path = join(directory, 'inbox.sqlite'); initializeIngressStore(path, scope);
  const store = openIngressStore(path, scope);
  const receiver = await startReceiver(receiverConfig, store, auth.dependencies);
  t.after(async () => { await receiver.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { auth, path, store, receiver };
}

const invalidClaims: [string, Record<string, unknown>][] = [
  ['missing exp', { exp: undefined }], ['missing nbf', { nbf: undefined }],
  ['string exp', { exp: '4000000000' }], ['null nbf', { nbf: null }],
  ['expired', { exp: Math.floor(Date.now() / 1000) - 301, nbf: 1 }],
  ['not yet valid', { nbf: Math.floor(Date.now() / 1000) + 400 }],
  ['wrong issuer', { iss: 'https://issuer.example.invalid' }],
  ['alias audience', { aud: `api://${receiverConfig.appId}` }],
  ['audience array', { aud: [receiverConfig.appId] }],
  ['wrong audience', { aud: 'other-app' }], ['missing serviceurl', { serviceurl: undefined }],
  ['different signed path', { serviceurl: `${serviceUrl}Other/` }],
];
for (const [name, claims] of invalidClaims) {
  test(`strict profile rejects ${name} without storage or echoed credentials`, async (t) => {
    const { auth, store, receiver } = await fixture(t);
    const token = auth.token(claims); const response = await post(receiver.port, token);
    assert.equal(response.status, 401); assert.equal(store.claim(), undefined);
    assert.ok(!(await response.text()).includes(token));
  });
}

test('real signature verification refuses another RSA key even with the selected endorsed kid', async (t) => {
  const { auth, receiver, store } = await fixture(t); const stranger = await authFixture(t);
  assert.equal((await post(receiver.port, stranger.token({}, { kid: auth.key.kid }))).status, 401);
  assert.equal(store.claim(), undefined);
});

test('symmetric algorithm, missing bearer and duplicate authorization headers never authenticate', async (t) => {
  const { auth, receiver, store } = await fixture(t);
  const noBearer = await fetch(`http://127.0.0.1:${receiver.port}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(activity()) });
  assert.equal(noBearer.status, 401);
  const symmetric = jwt.sign({ aud: scope.appId, serviceurl: serviceUrl }, randomBytes(32), { algorithm: 'HS256' });
  assert.equal((await post(receiver.port, symmetric)).status, 401);
  const body = JSON.stringify(activity()); const token = auth.token();
  const result = await new Promise<string>((resolve, reject) => {
    const socket = connect(receiver.port, '127.0.0.1'); let response = '';
    socket.on('connect', () => socket.write(`POST /api/messages HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAuthorization: Bearer ${token}\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
    socket.on('data', (chunk) => { response += chunk.toString(); }); socket.on('end', () => resolve(response)); socket.on('error', reject);
  });
  assert.match(result, /^HTTP\/1.1 401/); assert.equal(store.claim(), undefined);
  assert.equal(auth.requests(), 0);
});

test('SDK independently rejects a signature accepted by the strict guard', async (t) => {
  const { auth, receiver, store } = await fixture(t); const stranger = await authFixture(t);
  auth.setSdkKeys([{ ...stranger.key, kid: auth.key.kid }]);
  assert.equal((await post(receiver.port, auth.token())).status, 401);
  assert.equal(store.claim(), undefined); assert.equal(auth.requests(), 2);
});

for (const mode of ['missing endorsement', 'other endorsement', 'ambiguous kid', 'too many keys', 'oversized document'] as const) {
  test(`JWKS rejects ${mode}`, async (t) => {
    const { auth, receiver, store } = await fixture(t);
    if (mode === 'missing endorsement') auth.setKeys([{ ...auth.key, endorsements: undefined }]);
    if (mode === 'other endorsement') auth.setKeys([{ ...auth.key, endorsements: ['skype'] }]);
    if (mode === 'ambiguous kid') auth.setKeys([auth.key, { ...auth.key, endorsements: ['skype'] }]);
    if (mode === 'too many keys') auth.setKeys([auth.key, ...Array.from({ length: 1024 }, (_, i) => ({ ...auth.key, kid: `key-${i}` }))]);
    if (mode === 'oversized document') auth.setKeys([{ ...auth.key, padding: 'a'.repeat(2 * 1024 * 1024) }]);
    assert.equal((await post(receiver.port, auth.token())).status, 401);
    assert.equal(store.claim(), undefined); assert.equal(auth.requests(), 1);
  });
}

test('unknown kids share one bounded JWKS load and cannot refresh a cached miss', async (t) => {
  const { auth, receiver, store } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => post(receiver.port, auth.token({}, { kid: `unknown-${i}` }))));
  assert.ok(responses.every((response) => response.status === 401));
  assert.equal((await post(receiver.port, auth.token({}, { kid: 'yet-another' }))).status, 401);
  assert.equal(auth.requests(), 1); assert.equal(store.claim(), undefined);
  assert.equal((await post(receiver.port, auth.token())).status, 200);
  assert.equal(auth.strictRequests(), 1); assert.equal(auth.requests(), 2);
});

test('strict JWKS fetch has a whole-response deadline and does not forward a late success', async (t) => {
  const { auth, receiver, store } = await fixture(t); const gate = deferred<void>(); auth.delayStrict(gate.promise);
  const started = performance.now(); const response = await post(receiver.port, auth.token());
  assert.equal(response.status, 401); assert.ok(performance.now() - started < 7000);
  gate.resolve(); await receiver.stop(); assert.equal(store.claim(), undefined); assert.equal(auth.requests(), 1);
});

test('failed JWKS fetch is single-flight and cooldown prevents request-triggered reloads', async (t) => {
  const { auth, receiver, store } = await fixture(t); auth.setKeys([]);
  const responses = await Promise.all(Array.from({ length: 20 }, () => post(receiver.port, auth.token())));
  assert.ok(responses.every((response) => response.status === 401)); assert.equal(auth.requests(), 1);
  auth.setKeys([auth.key]); assert.equal((await post(receiver.port, auth.token())).status, 401);
  assert.equal(auth.requests(), 1); assert.equal(store.claim(), undefined);
});

test('signed non-finite lifetime claims cannot pass jsonwebtoken optional-claim behavior', async (t) => {
  const { auth, receiver, store } = await fixture(t);
  const base = { iss: 'https://api.botframework.com', aud: scope.appId, serviceurl: serviceUrl };
  for (const claims of ['"exp":1e400,"nbf":0', '"exp":4000000000,"nbf":-1e400']) {
    const payload = `${JSON.stringify(base).slice(0, -1)},${claims}}`;
    assert.equal((await post(receiver.port, auth.signPayload(payload))).status, 401);
  }
  assert.equal(store.claim(), undefined);
});

test('SDK tolerance is preserved but JWT appid/tid are not recipient or body tenant authority', async (t) => {
  const { auth, receiver, store } = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await post(receiver.port, auth.token({ exp: now - 100, nbf: now - 200, appid: 'not-the-bot', tid: 'not-the-body-tenant' }))).status, 200);
  assert.equal(store.claim()?.event.accountId, scope.tenantId);
});

for (const mutation of ['tenant', 'conflicting tenant', 'missing tenant', 'recipient', 'missing recipient', 'service path', 'channel', 'missing channel'] as const) {
  test(`original raw ${mutation} is rejected before storage`, async (t) => {
    const { auth, receiver, store } = await fixture(t); const body = activity();
    if (mutation === 'tenant') { body.channelData.tenant.id = 'other'; body.conversation.tenantId = 'other'; }
    if (mutation === 'conflicting tenant') body.channelData.tenant.id = 'other';
    if (mutation === 'missing tenant') { delete body.channelData; delete body.conversation.tenantId; }
    if (mutation === 'recipient') body.recipient.id = 'other-bot';
    if (mutation === 'missing recipient') delete body.recipient;
    if (mutation === 'service path') body.serviceUrl = `${serviceUrl}Other/`;
    if (mutation === 'channel') body.channelId = 'skype';
    if (mutation === 'missing channel') delete body.channelId;
    const response = await post(receiver.port, auth.token({ serviceurl: body.serviceUrl }), body);
    assert.ok(response.status >= 400 && response.status < 500); assert.equal(store.claim(), undefined);
  });
}

test('authenticated unsupported notifications and absent raw text explicitly ignore without admission', async (t) => {
  const { auth, receiver, store } = await fixture(t);
  for (const body of [{ ...activity(), type: 'typing' }, { ...activity(), type: 'invoke', name: 'signin/tokenExchange' }, { ...activity(), text: undefined }]) {
    const response = await post(receiver.port, auth.token(), body);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ignored' });
  }
  assert.equal(store.claim(), undefined);
});

test('strict service URL matching preserves path case even though the SDK lowercases paths', async (t) => {
  const { auth, store } = await fixture(t);
  const receiver = await startReceiver({ ...receiverConfig, serviceUrls: [`${serviceUrl}Path/`] }, store, auth.dependencies);
  t.after(() => receiver.stop()); const body = activity(); body.serviceUrl = `${serviceUrl}Path/`;
  assert.equal((await post(receiver.port, auth.token({ serviceurl: `${serviceUrl}path/` }), body)).status, 401);
  assert.equal(store.claim(), undefined);
  assert.equal((await post(receiver.port, auth.token({ serviceurl: body.serviceUrl }), body)).status, 200);
  assert.ok(store.claim());
});

test('concurrent replays retain one original profile/event/key; changed message is conflict', async (t) => {
  const { auth, receiver, store } = await fixture(t);
  assert.equal((await post(receiver.port, auth.token())).status, 200);
  const body = activity(); body.from.name = 'Changed Profile';
  const responses = await Promise.all(Array.from({ length: 10 }, () => post(receiver.port, auth.token(), body)));
  assert.ok(responses.every((response) => response.status === 200));
  const claim = store.claim(); assert.ok(claim);
  assert.equal(claim.event.sender.displayName, expectedEvent.sender.displayName);
  assert.equal(store.claim(), undefined);
  body.text = 'Changed message'; assert.equal((await post(receiver.port, auth.token(), body)).status, 409);
});

test('ACK awaits deferred durable admission; a failed save is 503 and poisons further admission', async (t) => {
  const auth = await authFixture(t);
  const admitted = deferred<void>(); const commit = deferred<never>(); let calls = 0;
  const receiver = await startReceiver(receiverConfig, { scope, admit: () => { calls++; admitted.resolve(); return commit.promise; } }, auth.dependencies);
  t.after(() => receiver.stop());
  let responded = false;
  const response = post(receiver.port, auth.token()).then((value) => { responded = true; return value; });
  await admitted.promise; await sleep(40); assert.equal(responded, false);
  commit.reject(new Error('private-storage-sentinel'));
  assert.equal((await response).status, 503);
  await assert.rejects(receiver.failed, { message: 'Ingress storage failed' });
  assert.equal((await post(receiver.port, auth.token())).status, 503); assert.equal(calls, 1);
});

test('storage failure emits 503 before the fatal lifecycle signal drains the receiver', async (t) => {
  const auth = await authFixture(t);
  const receiver = await startReceiver(receiverConfig, { scope, admit: () => { throw new Error('private-store-error'); } }, auth.dependencies);
  t.after(() => receiver.stop());
  void receiver.failed.catch(() => receiver.stop());
  const response = await post(receiver.port, auth.token());
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('private-store-error'));
  await receiver.stop();
});

test('deferred successful commit precedes ACK and full admission is backpressure', async (t) => {
  const auth = await authFixture(t); const reached = deferred<void>();
  const commit = deferred<{ kind: 'accepted'; replyTarget: string }>();
  const receiver = await startReceiver(receiverConfig, { scope, admit: () => { reached.resolve(); return commit.promise; } }, auth.dependencies);
  t.after(() => receiver.stop()); let responded = false;
  const response = post(receiver.port, auth.token()).then((value) => { responded = true; return value; });
  await reached.promise; await sleep(40); assert.equal(responded, false);
  commit.resolve({ kind: 'accepted', replyTarget: 'saved-original-key' }); assert.equal((await response).status, 200);
  const full = await startReceiver(receiverConfig, { scope, admit: () => ({ kind: 'full' }) }, auth.dependencies); t.after(() => full.stop());
  assert.equal((await post(full.port, auth.token())).status, 503);
});

test('shutdown drains SDK authentication and fences a late callback from admission', async (t) => {
  const { auth, receiver, store } = await fixture(t); const gate = deferred<void>(); auth.delaySdk(gate.promise);
  const response = post(receiver.port, auth.token()).catch(() => undefined);
  while (auth.requests() < 2) await sleep(5);
  let stopped = false; const stopping = receiver.stop().then(() => { stopped = true; });
  await sleep(30); assert.equal(stopped, false); gate.resolve(); await stopping; await response;
  assert.equal(store.claim(), undefined);
});

test('absolute SDK-processing deadline fences late admission, not only request-body receipt', async (t) => {
  const { auth, receiver, store } = await fixture(t); const gate = deferred<void>(); auth.delaySdk(gate.promise);
  const response = post(receiver.port, auth.token()).catch(() => undefined);
  while (auth.requests() < 2) await sleep(5);
  await sleep(10200);
  const result = await response; assert.ok(result === undefined || result.status === 408);
  gate.resolve(); await receiver.stop(); assert.equal(store.claim(), undefined);
});

test('safe SDK logger discards original activities, JWT claims and error details at debug including children', async (t) => {
  const { auth, receiver } = await fixture(t); const stranger = await authFixture(t);
  const output: string[] = [];
  const stdout = t.mock.method(process.stdout, 'write', (value: unknown) => { output.push(String(value)); return true; });
  const stderr = t.mock.method(process.stderr, 'write', (value: unknown) => { output.push(String(value)); return true; });
  const body = activity(); body.text = 'private-activity-sentinel';
  const token = auth.token({ appid: 'private-claim-sentinel' });
  const accepted = await post(receiver.port, token, body); const acceptedText = await accepted.text();
  // New receiver => independent SDK cache selects a different real key and logs its rejection through a child.
  auth.setSdkKeys([{ ...stranger.key, kid: auth.key.kid }]);
  const other = await startReceiver(receiverConfig, { scope, admit: () => { throw new Error('must not admit'); } }, auth.dependencies);
  const rejected = await post(other.port, token, body); const rejectedText = await rejected.text(); await other.stop();
  stdout.mock.restore(); stderr.mock.restore();
  assert.equal(accepted.status, 200); assert.equal(rejected.status, 401);
  const combined = output.join('') + acceptedText + rejectedText;
  assert.ok(!combined.includes('private-activity-sentinel')); assert.ok(!combined.includes('private-claim-sentinel'));
  assert.ok(!combined.includes(token)); assert.ok(!combined.includes(receiverConfig.clientSecret));
});

test('native HTTP parser rejects oversized/compressed/malformed UTF8 JSON and oversized headers safely', async (t) => {
  const { auth, receiver, store } = await fixture(t);
  const bounded = { ...activity(), unused: '' }; bounded.unused = 'x'.repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(bounded)));
  assert.equal(Buffer.byteLength(JSON.stringify(bounded)), 256 * 1024);
  assert.equal((await post(receiver.port, auth.token(), bounded)).status, 200);
  assert.ok(store.claim());
  const raw = async (headers: Record<string, string>, body: string | Buffer) => fetch(`http://127.0.0.1:${receiver.port}/api/messages`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : new Uint8Array(body) });
  assert.equal((await raw({}, 'x'.repeat(256 * 1024 + 1))).status, 413);
  assert.equal((await raw({ 'Content-Encoding': 'gzip' }, '{}')).status, 415);
  assert.equal((await raw({}, Buffer.from([0xff]))).status, 400);
  const malformed = await raw({}, '{"private-body-sentinel'); assert.equal(malformed.status, 400);
  assert.ok(!(await malformed.text()).includes('private-body-sentinel'));
  const oversized = await new Promise<string>((resolve, reject) => {
    const socket = connect(receiver.port, '127.0.0.1'); let response = '';
    socket.on('connect', () => socket.write(`POST /api/messages HTTP/1.1\r\nHost: localhost\r\nX-Pad: ${'x'.repeat(17 * 1024)}\r\n\r\n`));
    socket.on('data', (chunk) => { response += chunk.toString(); }); socket.on('end', () => resolve(response)); socket.on('error', reject);
  });
  assert.match(oversized, /^HTTP\/1.1 400/); assert.equal(store.claim(), undefined);
});
