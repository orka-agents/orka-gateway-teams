import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createKubernetesReader } from '../src/registry/kubernetes.js';
import { httpsFixture } from './support/ingress-https.js';
import { registryInput } from './support/registry.js';
import { deferred, eventually } from './support/table-service.js';

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'binding-client-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token'); writeFileSync(tokenFile, JSON.stringify({ token: 'synthetic-only', expiresAt: new Date(Date.now() + 3600000).toISOString() }), { mode: 0o600 });
  let status = 201; let body = '{"kind":"GatewayBinding","metadata":{"name":"teams-test"}}';
  const seen: { method: string; path: string; body: string }[] = []; let hold: Promise<void> | undefined; let closes = 0;
  const server = await httpsFixture(t, async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    seen.push({ method: req.method!, path: req.url!, body: input });
    if (hold) await hold; res.writeHead(status); res.end(body);
  });
  const target = { ...registryInput().targets[0]!, kubernetesTokenFile: tokenFile };
  const request = ((url: URL, options: https.RequestOptions, callback: any) => {
    assert.equal(url.origin, 'https://kubernetes.example.invalid'); assert.equal(options.rejectUnauthorized, true);
    assert.equal((options.headers as Record<string, unknown>)?.authorization === 'Bearer synthetic-only', true);
    const req = https.request(new URL(url.pathname + url.search, server.baseUrl), { ...options, ca: server.ca, servername: 'localhost' }, callback);
    req.once('close', () => closes++); return req;
  }) as typeof https.request;
  const reader = createKubernetesReader(target, { request }); t.after(() => reader.close());
  return { reader, seen, tokenFile, closes: () => closes, response(code: number, value = body) { status = code; body = value; }, hold(value: Promise<void>) { hold = value; } };
}
const context = (duration = 3000) => ({ signal: new AbortController().signal, deadline: performance.now() + duration, allowed: () => true });
// Removing fixed-path POST or treating an ACK as durable Binding truth breaks the provisioner's readback contract.
test('Binding POST is fixed, bounded and classified independently of later GET truth', async t => {
  const f = await fixture(t); const desired = { apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'GatewayBinding', metadata: { name: 'teams-test' }, spec: {} };
  assert.deepEqual(await f.reader.createBinding(desired, context()), { kind: 'ack' });
  assert.deepEqual(f.seen[0], { method: 'POST', path: '/apis/gateway.orka.ai/v1alpha1/namespaces/default/gatewaybindings', body: JSON.stringify(desired) });
  f.response(409); assert.deepEqual(await f.reader.createBinding(desired, context()), { kind: 'conflict' });
  f.response(302); assert.deepEqual(await f.reader.createBinding(desired, context()), { kind: 'uncertain' });
  f.response(404); assert.equal(await f.reader.getBinding('teams-test', context()), undefined);
  f.response(200); assert.equal((await f.reader.getBinding('teams-test', context()))?.kind, 'GatewayBinding');
  assert.equal(f.seen[4]?.path, '/apis/gateway.orka.ai/v1alpha1/namespaces/default/gatewaybindings/teams-test');
  await assert.rejects(f.reader.getBinding('../other', context())); assert.equal(f.seen.length, 5);
});
test('authority, credential expiry and expired context prevent Binding native handoff', async t => {
  const f = await fixture(t);
  await assert.rejects(f.reader.createBinding({}, { ...context(), allowed: () => false }));
  await assert.rejects(f.reader.getGateway(context(-1)));
  writeFileSync(f.tokenFile, JSON.stringify({ token: 'synthetic-only', expiresAt: new Date(Date.now() + 299000).toISOString() }));
  await assert.rejects(f.reader.createBinding({}, context()), { message: 'credential-expiring' }); assert.equal(f.seen.length, 0);
});
test('late authority loss never reports POST success or GET absence to a direct client caller', async t => {
  const f = await fixture(t); let allowed = true;
  const ctx = { ...context(), allowed: () => allowed };
  const postGate = deferred(); t.after(() => postGate.resolve()); f.hold(postGate.promise);
  const posted = f.reader.createBinding({}, ctx); await eventually(() => f.seen.length === 1);
  allowed = false; postGate.resolve(); assert.deepEqual(await posted, { kind: 'uncertain' });
  allowed = true; const getGate = deferred(); t.after(() => getGate.resolve()); f.hold(getGate.promise); f.response(404);
  const read = assert.rejects(f.reader.getBinding('teams-test', ctx), { message: 'Kubernetes read failed' });
  await eventually(() => f.seen.length === 2); allowed = false; getGate.resolve(); await read;
  assert.equal(f.closes(), 2);
});
test('paginated Binding reads retain the original deadline when caller context is reused', async t => {
  const f = await fixture(t); const first = deferred(); const second = deferred(); t.after(() => { first.resolve(); second.resolve(); });
  f.response(200, '{"kind":"GatewayBindingList","metadata":{"continue":"next"},"items":[]}'); f.hold(first.promise);
  const ctx = context(1000); const original = ctx.deadline;
  const outcome = f.reader.listBindings(ctx).then(() => 'success', () => 'failed');
  await eventually(() => f.seen.length === 1); ctx.deadline = performance.now() + 100000;
  f.hold(second.promise); first.resolve(); await eventually(() => f.seen.length === 2);
  f.response(200, '{"kind":"GatewayBindingList","metadata":{},"items":[]}');
  await new Promise(resolve => setTimeout(resolve, Math.max(1, original - performance.now() + 30))); second.resolve();
  assert.equal(await outcome, 'failed'); assert.equal(f.closes(), 2);
});
test('captured deadline and cancellation drain held requests; four actual calls bound native work', async t => {
  const f = await fixture(t); const gate = deferred(); t.after(() => gate.resolve()); f.hold(gate.promise);
  const ctx = context(150); const pending = assert.rejects(f.reader.getBinding('teams-test', ctx));
  await eventually(() => f.seen.length === 1); ctx.deadline = performance.now() + 100000;
  await pending; assert.equal(f.closes(), 1);
  const controller = new AbortController(); const active = { ...context(), signal: controller.signal };
  const held = Array.from({ length: 4 }, () => assert.rejects(f.reader.getGateway(active)));
  await eventually(() => f.seen.length === 5); await assert.rejects(f.reader.getAgent(context())); assert.equal(f.seen.length, 5);
  controller.abort(); await Promise.all(held); await f.reader.close(); assert.equal(f.closes(), 5);
  await assert.rejects(f.reader.createBinding({}, context())); gate.resolve();
});
