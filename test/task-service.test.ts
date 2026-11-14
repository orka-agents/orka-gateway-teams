import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskService } from '../src/accounts/task-service.js';
import { startTargetOutboundServer } from '../src/outbound/server.js';
import { context, deferred } from './support/directory-table.js';
import { grantsFixture } from './support/task-grants.js';
import { completed, workIQFixture } from './support/workiq.js';

const credential = 'CONTROLLER-PRIVATE';
const delivery = 'DELIVERY-PRIVATE';
async function fixture(t: Parameters<typeof grantsFixture>[0]) {
  const f = await grantsFixture(t); await f.store.reserveGrant(f.input, context()); const w = await workIQFixture(t);
  let refresh = async (_token: string) => ({ accessToken: 'ACCESS-PRIVATE', expiresAt: f.now() + 100_000, refreshToken: 'REFRESH-PRIVATE' });
  const logs: string[] = [];
  const open = (accounts = f.store) => createTaskService({ accounts, authority: f.authority, now: f.now,
    targets: [{ id: 'tools', gatewayUid: 'gateway', identityDigest: f.input.targetDigest, taskPassToken: credential },
      { id: 'other', gatewayUid: 'other-gateway', identityDigest: 'b'.repeat(64), taskPassToken: 'OTHER-CONTROLLER' }],
    auth: { exchange: async () => { throw new Error('not SSO'); }, refresh: token => refresh(token) },
    workiq: { request: w.request }, privateCredentials: [delivery], log: c => logs.push(c) });
  const service = open(); t.after(() => service.close());
  const server = await startTargetOutboundServer({ host: '127.0.0.1', port: 0 }, [{ prefix: '/targets/tools', bearerToken: delivery,
    scope: { appId: 'app', tenantId: 'tenant' }, dispatcher: { healthy: true, deliver: async () => { throw new Error('not delivery'); }, stop: async () => {} } }], () => true, service);
  t.after(() => server.stop());
  const body = { protocolVersion: 'orka.gateway.v1', grantRef: f.input.ref, namespaceUID: 'ns', gatewayUID: 'gateway', taskUID: 'task',
    tools: ['workiq'], deadline: new Date(f.now() + 600_000).toISOString() };
  const post = async (path: string, token: string | undefined, input: unknown = body) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST', headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as any };
  };
  const issue = async (input: unknown = body) => { const r = await post('/v1/task-passes', credential, input); assert.equal(r.status, 200); return r.body as { pass: string; expiresAt: string }; };
  return { ...f, w, service, server, openService: open, logs, body, post, issue, refresh: (fn: typeof refresh) => { refresh = fn; } };
}

test('real listener accepts only dedicated issuance bearer and exact #1110 body/reply, bounds pass to five minutes/deadline', async t => {
  const f = await fixture(t);
  for (const token of [undefined, delivery]) assert.equal((await f.post('/v1/task-passes', token)).status, 401);
  assert.equal((await f.post('/targets/tools/v1/deliveries', credential)).status, 401);
  for (const input of [{ ...f.body, extra: true }, { ...f.body, tools: ['unknown'] }, { ...f.body, deadline: 'tomorrow' }, { ...f.body, gatewayUID: 'other-gateway' }]) {
    assert.notEqual((await f.post('/v1/task-passes', credential, input)).status, 200);
  }
  const result = await f.issue(); assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'pass']); assert.match(result.pass, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Date.parse(result.expiresAt), f.now() + 290_000);
  const again = await f.issue({ ...f.body, tools: ['workiq', 'workiq'], deadline: f.body.deadline.replace('Z', '+00:00') }); assert.notEqual(result.pass, again.pass);
  const offset = new Date(Date.parse(f.body.deadline) + 3600000).toISOString().replace('Z', '+01:00').replace('.000', '.0000');
  assert.equal((await f.issue({ ...f.body, deadline: offset })).expiresAt, result.expiresAt);
  const call = await f.post('/v1/task-tools/workiq', result.pass, { question: 'Question' });
  assert.deepEqual(call, { status: 200, body: { text: 'Answer' } }); assert.equal(f.w.bodies.length, 1);
  assert.notEqual((await f.post('/v1/task-tools/workiq', result.pass, { question: 'Again' })).status, 200);
  assert.notEqual((await f.post('/v1/task-passes', 'OTHER-CONTROLLER')).status, 200);
  for (const change of [{ taskUID: 'child' }, { namespaceUID: 'other' }, { deadline: new Date(f.now() + 600_001).toISOString() }]) {
    assert.notEqual((await f.post('/v1/task-passes', credential, { ...f.body, ...change })).status, 200);
  }
  assert.ok(f.logs.includes('grant-binding-conflict'));
});

test('pass expiry tolerates the gateway clock leading the controller by five seconds', async t => {
  const f = await fixture(t); const controllerNow = f.now() - 5000;
  const pass = await f.issue();
  assert.ok(Date.parse(pass.expiresAt) <= controllerNow + 300000, 'Orka must accept the reply within its receipt-relative five-minute cap');
  assert.ok(Date.parse(pass.expiresAt) > f.now());
});

test('single-use pass is consumed synchronously, malformed arguments and ambiguous provider outcomes never resend', async t => {
  const f = await fixture(t); const pass = (await f.issue()).pass;
  const entered = deferred(); const release = deferred();
  f.w.behavior((_req, res, b) => { entered.resolve(); void release.promise.then(() => res.end(JSON.stringify(completed(b.id)))); });
  const first = f.post('/v1/task-tools/workiq', pass, { question: 'q' }); await entered.promise;
  assert.notEqual((await f.post('/v1/task-tools/workiq', pass, { question: 'q' })).status, 200); release.resolve(); assert.equal((await first).status, 200);
  const invalid = (await f.issue()).pass;
  assert.notEqual((await f.post('/v1/task-tools/workiq', invalid, { question: 'q', url: 'https://evil' })).status, 200);
  assert.notEqual((await f.post('/v1/task-tools/workiq', invalid, { question: 'q' })).status, 200);
  f.w.behavior((_req, res) => res.destroy());
  const uncertain = (await f.issue()).pass;
  const failed = await f.post('/v1/task-tools/workiq', uncertain, { question: 'q' }); assert.deepEqual(failed.body, { error: 'tool-unavailable' });
  assert.notEqual((await f.post('/v1/task-tools/workiq', uncertain, { question: 'q' })).status, 200); assert.equal(f.w.bodies.length, 2);
});

for (const reason of ['expiry', 'deadline', 'disconnect', 'restart', 'authority'] as const) test(`${reason} fences passes before provider effect`, async t => {
  const f = await fixture(t); const pass = (await f.issue(reason === 'deadline' ? { ...f.body, deadline: new Date(f.now() + 1000).toISOString() } : undefined)).pass;
  if (reason === 'expiry') f.advance(300_001);
  if (reason === 'deadline') f.advance(1001);
  if (reason === 'disconnect') await f.store.disconnect(f.subject, context());
  if (reason === 'authority') f.revoke();
  if (reason === 'restart') {
    await f.service.close();
  }
  assert.notEqual((await f.post('/v1/task-tools/workiq', pass, { question: 'q' })).status, 200); assert.equal(f.w.bodies.length, 0);
});

test('fresh service reacquires exactly the durable binding, never old process passes or a new generation', async t => {
  const f = await fixture(t); const old = await f.issue(); await f.service.close();
  const next = f.openService(f.open()); t.after(() => next.close()); assert.equal(next.authenticate('/v1/task-tools/workiq', old.pass), false);
  assert.equal((await next.handle('/v1/task-passes', credential, f.body, context())).status, 200);
  assert.notEqual((await next.handle('/v1/task-passes', credential, { ...f.body, taskUID: 'child' }, context())).status, 200);
  await f.store.disconnect(f.subject, context()); await f.link('relink');
  assert.notEqual((await next.handle('/v1/task-passes', credential, f.body, context())).status, 200);
});

test('disconnect during renewal cannot send provider credentials', async t => {
  const f = await fixture(t); const pass = (await f.issue()).pass; f.advance(100_001);
  const entered = deferred(); const release = deferred(); f.refresh(async () => { entered.resolve(); await release.promise; return { accessToken: 'ACCESS-PRIVATE', expiresAt: f.now() + 100_000, refreshToken: 'REFRESH-PRIVATE' }; });
  const pending = f.post('/v1/task-tools/workiq', pass, { question: 'q' }); await entered.promise; await f.store.disconnect(f.subject, context()); release.resolve();
  assert.deepEqual((await pending).body, { error: 'signin-required' }); assert.equal(f.w.bodies.length, 0);
});

for (const race of ['owner', 'generation'] as const) test(`${race} changing during final owner revalidation prevents native provider send`, async t => {
  const f = await fixture(t); const pass = (await f.issue()).pass;
  f.authority.revalidate = async () => {
    if (race === 'owner') { f.revoke(); return false; }
    await f.store.disconnect(f.subject, context()); await f.link('new-generation'); return true;
  };
  assert.notEqual((await f.post('/v1/task-tools/workiq', pass, { question: 'q' })).status, 200); assert.equal(f.w.bodies.length, 0);
});

test('pass expiring during renewal cannot reach native provider send', async t => {
  const f = await fixture(t); const pass = (await f.issue()).pass; f.advance(100001);
  f.refresh(async () => { f.advance(200000); return { accessToken: 'ACCESS-PRIVATE', expiresAt: f.now() + 100000, refreshToken: 'REFRESH-PRIVATE' }; });
  assert.notEqual((await f.post('/v1/task-tools/workiq', pass, { question: 'q' })).status, 200); assert.equal(f.w.bodies.length, 0);
});

test('listener stop drains held actual token renewal after HTTP disconnect before returning', async t => {
  const f = await fixture(t); const pass = (await f.issue()).pass; f.advance(100_001);
  const entered = deferred(); const release = deferred(); t.after(() => release.resolve());
  f.refresh(async () => { entered.resolve(); await release.promise; return { accessToken: 'ACCESS-PRIVATE', expiresAt: f.now() + 100000, refreshToken: 'REFRESH-PRIVATE' }; });
  const pending = f.post('/v1/task-tools/workiq', pass, { question: 'q' }).catch(() => undefined); await entered.promise;
  let done = false; const stopped = f.server.stop().then(() => { done = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  release.resolve(); await stopped; await pending; assert.equal(f.w.bodies.length, 0);
});

test('malformed calendar dates are refused before durable first binding', async t => {
  const f = await fixture(t);
  for (const date of ['2027-02-30T12:00:00Z', '2027-01-15T24:00:00Z', '2027-13-01T00:00:00Z']) {
    assert.notEqual((await f.post('/v1/task-passes', credential, { ...f.body, deadline: date })).status, 200);
  }
  assert.equal((await f.store.getGrant(f.input.ref, context()))!.binding, undefined);
});

test('provider cannot echo controller, delivery or stored account credentials into tool output', async t => {
  const f = await fixture(t);
  for (const credentialText of [credential, delivery, 'ACCESS-PRIVATE', 'REFRESH-PRIVATE']) {
    const pass = (await f.issue()).pass;
    f.w.behavior((_req, res, b) => res.end(JSON.stringify(completed(b.id, credentialText))));
    const result = await f.post('/v1/task-tools/workiq', pass, { question: 'q' }); assert.deepEqual(result.body, { error: 'tool-unavailable' });
    assert.ok(!JSON.stringify({ result, logs: f.logs }).includes(credentialText));
  }
});
