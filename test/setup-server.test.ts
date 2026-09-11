import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, request } from 'node:http';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { App } from '@microsoft/teams.apps';
import { startSetupCapture } from '../src/setup/server.js';
import { activity, authFixture, deferred, post, serviceUrl } from './support/ingress-auth.js';
import { setupFiles } from './support/setup.js';

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate()) { assert.equal(performance.now() < deadline, true); await sleep(5); }
}
async function fixture(t: TestContext, timeoutMs = 30000) {
  const files = setupFiles(t); const auth = await authFixture(t);
  const capture = await startSetupCapture({ ...files.config, timeoutMs }, auth.dependencies);
  t.after(() => capture.stop());
  const body = activity(); body.text = files.challenge;
  return { ...files, auth, capture, body };
}
function absent(config: { captureFile: string }, directory: string) {
  assert.equal(fs.existsSync(config.captureFile), false); assert.deepEqual(fs.readdirSync(directory), ['challenge']);
}

test('actual SDK and strict signatures precede durable six-field capture and drained completion', async (t) => {
  const { config, directory, capture, auth, body } = await fixture(t);
  absent(config, directory);
  const response = await post(capture.port, auth.token(), body);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'accepted' });
  await capture.done;
  const candidate = JSON.parse(fs.readFileSync(config.captureFile, 'utf8'));
  assert.deepEqual(Object.keys(candidate).sort(), ['appId', 'conversationId', 'recipientId', 'senderId', 'serviceUrl', 'tenantId']);
  assert.equal(candidate.appId === config.appId && candidate.tenantId === config.tenantId, true);
  assert.equal(candidate.recipientId === body.recipient.id && candidate.serviceUrl === body.serviceUrl, true);
  assert.equal(candidate.senderId === body.from.id && candidate.conversationId === body.conversation.id, true);
  assert.equal(auth.requests(), 2); assert.equal(auth.strictRequests(), 1);
  await capture.stop(); await assert.rejects(() => post(capture.port, auth.token(), body));
});

test('SDK independently refuses wrong RSA key despite strict verification passing', async (t) => {
  const { config, directory, capture, auth, body } = await fixture(t); const stranger = await authFixture(t);
  auth.setSdkKeys([{ ...stranger.key, kid: auth.key.kid }]);
  const response = await post(capture.port, auth.token(), body);
  assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'Request rejected' });
  assert.equal(auth.requests(), 2); absent(config, directory);
});

for (const [name, claims] of [
  ['issuer', { iss: 'https://wrong.invalid/' }], ['audience', { aud: 'wrong' }], ['audience array', { aud: ['wrong'] }],
  ['missing exp', { exp: undefined }], ['missing nbf', { nbf: undefined }], ['string exp', { exp: '4000000000' }],
  ['null nbf', { nbf: null }], ['expired', { exp: 2, nbf: 1 }], ['future', { nbf: 4000000000 }],
  ['service binding', { serviceurl: serviceUrl + 'different/' }], ['missing service binding', { serviceurl: undefined }],
] as const) {
  test(`setup rejects JWT ${name} before any private write`, async (t) => {
    const { config, directory, capture, auth, body } = await fixture(t);
    assert.equal((await post(capture.port, auth.token(claims), body)).status, 401); absent(config, directory);
  });
}
for (const variant of ['unendorsed', 'other endorsement', 'wrong signature', 'nonfinite times'] as const) {
  test(`setup rejects ${variant} before any private write`, async (t) => {
    const { config, directory, capture, auth, body } = await fixture(t);
    let token = auth.token();
    if (variant === 'unendorsed') auth.setKeys([{ ...auth.key, endorsements: undefined }]);
    if (variant === 'other endorsement') auth.setKeys([{ ...auth.key, endorsements: ['skype'] }]);
    if (variant === 'wrong signature') token = (await authFixture(t)).token({}, { kid: auth.key.kid });
    if (variant === 'nonfinite times') token = auth.signPayload(JSON.stringify({ iss: 'https://api.botframework.com', aud: config.appId, serviceurl: serviceUrl }).slice(0, -1) + ',"exp":1e400,"nbf":0}');
    assert.equal((await post(capture.port, token, body)).status, 401); absent(config, directory);
  });
}

for (const variant of ['wrong code', 'old code', 'case', 'leading whitespace', 'newline', 'mention', 'bot', 'skill', 'self', 'bot type', 'group', 'channel chat', 'edit', 'invoke', 'event marker', 'empty'] as const) {
  test(`authenticated ${variant} is ignored without private write, then exact fresh personal code captures`, async (t) => {
    const { config, directory, capture, auth, body, challenge } = await fixture(t);
    const other = structuredClone(body);
    if (variant === 'wrong code') other.text = 'unrelated';
    if (variant === 'old code') other.text = setupFiles(t).challenge;
    if (variant === 'case') other.text = challenge.toUpperCase();
    if (variant === 'leading whitespace') other.text = ' ' + challenge;
    if (variant === 'newline') other.text = challenge + '\n';
    if (variant === 'mention') other.text = '<at>bot</at>' + challenge;
    if (variant === 'bot' || variant === 'skill') other.from.role = variant;
    if (variant === 'self') other.from.id = other.recipient.id;
    if (variant === 'bot type') other.from.type = 'bot';
    if (variant === 'group') other.conversation.isGroup = true;
    if (variant === 'channel chat') other.conversation.conversationType = 'channel';
    if (variant === 'edit') other.type = 'messageUpdate';
    if (variant === 'invoke') { other.type = 'invoke'; other.name = 'signin/tokenExchange'; }
    if (variant === 'event marker') other.channelData.eventType = 'messageEdit';
    if (variant === 'empty') delete other.text;
    const response = await post(capture.port, auth.token(), other);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ignored' }); absent(config, directory);
    // Missing role is legitimate wire data, not human attestation.
    delete body.from.role;
    assert.equal((await post(capture.port, auth.token(), body)).status, 200); await capture.done;
  });
}

for (const variant of ['tenant', 'conflicting tenant', 'missing tenant', 'malformed tenant', 'channel', 'recipient', 'sender', 'conversation', 'label', 'role', 'text', 'unicode', 'URL http', 'URL canonical', 'URL port', 'URL query', 'URL userinfo', 'URL long'] as const) {
  test(`setup rejects original body ${variant} before publication`, async (t) => {
    const { config, directory, capture, auth, body } = await fixture(t);
    if (variant === 'tenant') { body.conversation.tenantId = 'other'; body.channelData.tenant.id = 'other'; }
    if (variant === 'conflicting tenant') body.channelData.tenant.id = 'other';
    if (variant === 'missing tenant') { delete body.channelData; delete body.conversation.tenantId; }
    if (variant === 'malformed tenant') body.channelData.tenant = null;
    if (variant === 'channel') body.channelId = 'skype';
    if (variant === 'recipient') delete body.recipient.id;
    if (variant === 'sender') body.from.id = 'x'.repeat(257);
    if (variant === 'conversation') body.conversation.id = ' bad';
    if (variant === 'label') body.from.name = 'x'.repeat(257);
    if (variant === 'role') body.from.role = 'unknown';
    if (variant === 'text') body.text = 'x'.repeat(65537);
    if (variant === 'unicode') body.from.id = '\ud800';
    if (variant === 'URL http') body.serviceUrl = 'http://teams.example.invalid/';
    if (variant === 'URL canonical') body.serviceUrl = 'https://TEAMS.example.invalid';
    if (variant === 'URL port') body.serviceUrl = 'https://teams.example.invalid:444/';
    if (variant === 'URL query') body.serviceUrl += '?query';
    if (variant === 'URL userinfo') body.serviceUrl = 'https://user@teams.example.invalid/';
    if (variant === 'URL long') body.serviceUrl += 'x'.repeat(2048) + '/';
    const response = await post(capture.port, auth.token({ serviceurl: body.serviceUrl }), body);
    assert.equal(response.status >= 400 && response.status < 500, true); absent(config, directory);
  });
}

test('selection uses actual authenticated recipient/service, not SDK constructor or environment defaults', async (t) => {
  const before = process.env.SERVICE_URL;
  process.env.SERVICE_URL = 'http://unused-private.invalid/';
  t.after(() => { if (before === undefined) delete process.env.SERVICE_URL; else process.env.SERVICE_URL = before; });
  const { config, capture, auth, body } = await fixture(t);
  body.serviceUrl = 'https://another.example.invalid/Path/'; body.recipient.id = 'actual-bot';
  assert.equal((await post(capture.port, auth.token({ serviceurl: body.serviceUrl }), body)).status, 200); await capture.done;
  const saved = JSON.parse(fs.readFileSync(config.captureFile, 'utf8'));
  assert.equal(saved.serviceUrl === body.serviceUrl && saved.recipientId === body.recipient.id, true);
});

for (const variant of ['stop', 'expiry', 'disconnect', 'TLS changed', 'request deadline'] as const) {
  test(`setup ${variant} fences late actual SDK callback and drains before closing`, async (t) => {
    const { config, directory, capture, auth, body } = await fixture(t, variant === 'expiry' ? 500 : 30000);
    const gate = deferred<void>(); auth.delaySdk(gate.promise); t.after(() => gate.resolve());
    const req = request({ host: '127.0.0.1', port: capture.port, path: '/api/messages', method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${auth.token()}` } });
    req.on('error', () => {}); req.on('response', (response) => response.resume()); req.end(JSON.stringify(body));
    await until(() => auth.requests() === 2);
    let stopped = false; let stopping: Promise<void> | undefined;
    let directoryClosed = false; const close = fs.closeSync;
    t.mock.method(fs, 'closeSync', (fd: number) => { if (fs.fstatSync(fd).isDirectory()) directoryClosed = true; close(fd); });
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      if (variant === 'TLS changed') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      else if (variant === 'disconnect') { req.destroy(); await sleep(50); }
      else if (variant === 'expiry') await sleep(550);
      else if (variant === 'request deadline') await sleep(10200);
      else stopping = capture.stop().then(() => { stopped = true; });
      if (variant === 'stop') { await sleep(30); assert.equal(stopped, false); }
      absent(config, directory); assert.equal(directoryClosed, false); gate.resolve();
      if (variant === 'TLS changed' || variant === 'disconnect' || variant === 'request deadline') await sleep(100);
      await (stopping ?? capture.stop());
      await assert.rejects(capture.done, { message: 'Setup capture failed' }); absent(config, directory);
      assert.equal(directoryClosed, true);
    } finally { gate.resolve(); req.destroy(); if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before; }
  });
}

test('simultaneous matching candidates reserve once before any file write and never overwrite', async (t) => {
  const { config, capture, auth, body } = await fixture(t);
  const inputs = Array.from({ length: 8 }, (_, i) => ({ ...body, from: { id: `person-${i}` }, conversation: { ...body.conversation, id: `chat-${i}` } }));
  let links = 0; const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => { links++; link(...args); });
  await Promise.all(inputs.map((input) => post(capture.port, auth.token(), input).catch(() => undefined)));
  await capture.done; assert.equal(links, 1);
  const saved = JSON.parse(fs.readFileSync(config.captureFile, 'utf8'));
  assert.equal(inputs.some((input) => saved.senderId === input.from.id && saved.conversationId === input.conversation.id), true);
});

for (const afterPublication of [false, true]) {
  test(`filesystem failure ${afterPublication ? 'after' : 'before'} publication responds safely before draining`, async (t) => {
    const { config, capture, auth, body } = await fixture(t); const sync = fs.fsyncSync;
    t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (fs.fstatSync(fd).isDirectory() === afterPublication) throw new Error('private-write-fault'); sync(fd);
    });
    const response = await post(capture.port, auth.token(), body);
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'Request rejected' });
    await assert.rejects(capture.done, { message: 'Setup capture failed' });
    assert.equal(fs.existsSync(config.captureFile), afterPublication);
  });
}

test('setup keeps private fields out of wire/artifact and never invokes default SDK pipeline or external HTTPS', async (t) => {
  const { config, capture, auth, body } = await fixture(t);
  // Real public SDK default dispatch would call event; replacing it is only a tripwire,
  // not the auth/capture implementation. Authentication still uses the real SDK.
  let events = 0; t.mock.method(App.prototype, 'event', async () => { events++; throw new Error('must not dispatch'); });
  let externalRequests = 0;
  t.mock.method(https, 'request', () => { externalRequests++; throw new Error('must not request tokens or provider'); });
  const response = await post(capture.port, auth.token(), body); const wire = await response.text(); await capture.done;
  assert.equal(response.status, 200); assert.equal(events, 0); assert.equal(externalRequests, 0);
  const combined = fs.readFileSync(config.captureFile, 'utf8') + wire;
  assert.equal([body.text, config.clientSecret, body.id, body.from.name].some((value) => combined.includes(value)), false);
});

test('already cancelled startup never binds or publishes; late initialize is drained before stop completes', async (t) => {
  const { config, directory } = setupFiles(t); const aborted = new AbortController(); aborted.abort();
  await assert.rejects(startSetupCapture(config, {}, aborted.signal), { message: 'Setup capture failed' }); absent(config, directory);
  const gate = deferred<void>(); const reached = deferred<void>(); const initialize = App.prototype.initialize;
  t.mock.method(App.prototype, 'initialize', async function(this: App) { reached.resolve(); await gate.promise; await initialize.call(this); });
  const signal = new AbortController(); let finished = false;
  const starting = startSetupCapture(config, {}, signal.signal).finally(() => { finished = true; }); void starting.catch(() => {});
  await reached.promise; signal.abort(); await sleep(20); assert.equal(finished, false);
  gate.resolve(); await assert.rejects(starting, { message: 'Setup capture failed' }); absent(config, directory);
});

test('cancellation racing completed hard-link publication preserves the candidate but fails safely', async (t) => {
  const { config, challenge } = setupFiles(t); const auth = await authFixture(t); const abort = new AbortController();
  const capture = await startSetupCapture(config, auth.dependencies, abort.signal); t.after(() => capture.stop());
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => { link(...args); abort.abort(); });
  const body = activity(); body.text = challenge;
  const response = await post(capture.port, auth.token(), body); assert.equal(response.status, 503);
  await assert.rejects(capture.done, { message: 'Setup capture failed' });
  assert.equal(fs.statSync(config.captureFile).nlink, 1);
  const saved = JSON.parse(fs.readFileSync(config.captureFile, 'utf8'));
  assert.equal(saved.senderId === body.from.id, true);
});

test('occupied listener unwinds startup and closes capture resources without publication', async (t) => {
  const { config, directory } = setupFiles(t); const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.equal(address !== null && typeof address === 'object', true);
  if (!address || typeof address === 'string') throw new Error('Fixture listener failed');
  let directoryClosed = false; const close = fs.closeSync;
  t.mock.method(fs, 'closeSync', (fd: number) => { if (fs.fstatSync(fd).isDirectory()) directoryClosed = true; close(fd); });
  await assert.rejects(startSetupCapture({ ...config, port: address.port }), { message: 'Setup capture failed' });
  assert.equal(directoryClosed, true); absent(config, directory);
});

test('existing output refuses startup without touching bytes or loading either JWKS', async (t) => {
  const { config } = setupFiles(t); const auth = await authFixture(t);
  fs.writeFileSync(config.captureFile, 'preserve', { mode: 0o600 });
  await assert.rejects(startSetupCapture(config, auth.dependencies), { message: 'Setup capture failed' });
  assert.equal(auth.requests(), 0); assert.equal(fs.readFileSync(config.captureFile, 'utf8') === 'preserve', true);
});
