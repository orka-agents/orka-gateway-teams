import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createKubernetesReader } from '../src/registry/kubernetes.js';
import { httpsFixture } from './support/ingress-https.js';
import { registryInput } from './support/registry.js';
import { deferred, eventually } from './support/table-service.js';

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'registry-kubernetes-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token.json'); let now = Date.now(); let calls = 0; const paths: string[] = []; let auth = true;
  let response = { status: 200, body: JSON.stringify({ apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'Gateway', metadata: { name: 'teams' } }) };
  let responseFor: ((call: number) => typeof response) | undefined;
  const server = await httpsFixture(t, (req, res) => { calls++; paths.push(req.url!); auth &&= req.headers.authorization === 'Bearer synthetic-only';
    const value = responseFor?.(calls) ?? response; res.writeHead(value.status); res.end(value.body); });
  const target = { ...registryInput().targets[0]!, kubernetesTokenFile: tokenFile };
  const save = (expiresAt = new Date(now + 3600000).toISOString()) => writeFileSync(tokenFile, JSON.stringify({ token: 'synthetic-only', expiresAt }), { mode: 0o600 }); save();
  const native = https.request;
  const request = ((url: URL, options: https.RequestOptions, callback: any) => {
    assert.equal(url.origin, 'https://kubernetes.example.invalid'); assert.equal(options.method, 'GET'); assert.equal(options.rejectUnauthorized, true);
    return native(new URL(url.pathname + url.search, server.baseUrl), { ...options, ca: server.ca, servername: 'localhost' }, callback);
  }) as typeof https.request;
  const reader = createKubernetesReader(target, { request, now: () => now }); t.after(() => reader.close());
  return { reader, target, request, tokenFile, directory, save, paths, calls: () => calls, auth: () => auth,
    response(value: typeof response) { response = value; }, responseFor(value: (call: number) => typeof response) { responseFor = value; },
    advance(ms: number) { now += ms; } };
}
test('Kubernetes reader performs only fixed resource GETs, preserves returned fields and encodes list continuations', async t => {
  const f = await fixture(t); assert.equal((await f.reader.getGateway()).kind, 'Gateway');
  f.response({ status: 200, body: '{"kind":"Agent","metadata":{"name":"front"},"spec":{"arbitrary":"kept"}}' });
  assert.deepEqual((await f.reader.getAgent()).spec, { arbitrary: 'kept' });
  assert.deepEqual(f.paths, ['/apis/gateway.orka.ai/v1alpha1/namespaces/default/gateways/teams', '/apis/core.orka.ai/v1alpha1/namespaces/default/agents/front']);
  f.response({ status: 200, body: '{"kind":"GatewayBindingList","metadata":{"continue":"a+/=&?"},"items":[{"metadata":{"name":"one"}}]}' });
  // Repeated continuation is bounded; it never becomes a response-controlled URL.
  await assert.rejects(f.reader.listBindings()); assert.ok(f.paths[3]!.endsWith('continue=a%2B%2F%3D%26%3F')); assert.equal(f.auth(), true);
});
test('list result preserves items from bounded pages and ignores response links', async t => {
  const f = await fixture(t); f.response({ status: 200, body: '{"kind":"GatewayBindingList","metadata":{},"items":[{"metadata":{"name":"one"},"spec":{"x":1}}],"nextLink":"https://elsewhere.invalid/"}' });
  assert.deepEqual(await f.reader.listBindings(), [{ metadata: { name: 'one' }, spec: { x: 1 } }]); assert.equal(f.calls(), 1);
});
test('positive paged list retains both pages without following response URLs', async t => {
  const f = await fixture(t); f.responseFor(call => ({ status: 200, body: JSON.stringify({ kind: 'GatewayBindingList',
    metadata: call === 1 ? { continue: 'page-two' } : {}, items: [{ metadata: { name: `item-${call}` } }] }) }));
  assert.deepEqual(await f.reader.listBindings(), [{ metadata: { name: 'item-1' } }, { metadata: { name: 'item-2' } }]);
  assert.equal(f.calls(), 2);
});
test('list refuses a 101st page and an oversized item total', async t => {
  const f = await fixture(t); f.responseFor(call => ({ status: 200, body: JSON.stringify({ kind: 'GatewayBindingList', metadata: { continue: `page-${call}` }, items: [] }) }));
  await assert.rejects(f.reader.listBindings(), { message: 'Kubernetes read failed' }); assert.equal(f.calls(), 100);
  f.responseFor(() => ({ status: 200, body: JSON.stringify({ kind: 'GatewayBindingList', metadata: {}, items: Array(10001).fill({}) }) }));
  await assert.rejects(f.reader.listBindings(), { message: 'Kubernetes read failed' }); assert.equal(f.calls(), 101);
});
test('expiry cutoff rereads atomic replacement without fallback or identity change', async t => {
  const f = await fixture(t); f.advance(3300000); await assert.rejects(f.reader.getGateway(), { message: 'credential-expiring' }); assert.equal(f.calls(), 0);
  const replacement = join(f.directory, 'replacement'); writeFileSync(replacement, JSON.stringify({ token: 'synthetic-only', expiresAt: new Date(Date.now() + 7200000).toISOString() }), { mode: 0o600 });
  renameSync(replacement, f.tokenFile); assert.equal((await f.reader.getGateway()).kind, 'Gateway'); assert.equal(f.calls(), 1);
  writeFileSync(f.tokenFile, '{broken'); await assert.rejects(f.reader.getGateway()); assert.equal(f.calls(), 1);
});
for (const kind of ['missing', 'public', 'oversized', 'symlink', 'hardlink', 'no-expiry', 'unknown', 'bad-date', 'rollover-date'] as const) test(`Kubernetes token ${kind} fails before native handoff`, async t => {
  const f = await fixture(t);
  if (kind === 'missing') rmSync(f.tokenFile);
  if (kind === 'public') chmodSync(f.tokenFile, 0o644);
  if (kind === 'oversized') writeFileSync(f.tokenFile, 'a'.repeat(16385));
  if (kind === 'no-expiry') writeFileSync(f.tokenFile, '{"token":"synthetic-only"}');
  if (kind === 'unknown') writeFileSync(f.tokenFile, '{"token":"synthetic-only","expiresAt":"2099-01-01T00:00:00.000Z","extra":1}');
  if (kind === 'bad-date') writeFileSync(f.tokenFile, '{"token":"synthetic-only","expiresAt":"tomorrow"}');
  if (kind === 'rollover-date') writeFileSync(f.tokenFile, '{"token":"synthetic-only","expiresAt":"2099-02-31T00:00:00.000Z"}');
  if (kind === 'symlink' || kind === 'hardlink') { const other = join(f.directory, 'alias'); renameSync(f.tokenFile, other); if (kind === 'symlink') symlinkSync(other, f.tokenFile); else linkSync(other, f.tokenFile); }
  await assert.rejects(f.reader.getGateway()); assert.equal(f.calls(), 0);
});
for (const [status, body] of [[302, '{}'], [403, '{}'], [200, 'null'], [200, '{"metadata":[]}'], [200, 'x'.repeat(1048577)]] as const)
  test(`Kubernetes rejects status/shape/size ${status}/${body.length} with a fixed error`, async t => {
    const f = await fixture(t); f.response({ status, body }); await assert.rejects(f.reader.getGateway(), { message: 'Kubernetes read failed' }); assert.equal(f.calls(), 1);
  });
test('verified TLS refuses wrong CA', async t => {
  const f = await fixture(t); const server = await httpsFixture(t, (_req, res) => { res.end('{}'); });
  const native = https.request;
  const request = ((url: URL, options: https.RequestOptions, callback: any) => native(new URL(url.pathname, server.baseUrl), options, callback)) as typeof https.request;
  const reader = createKubernetesReader(f.target, { request }); await assert.rejects(reader.getGateway()); await reader.close();
});
test('configured CA is captured and determines verified Kubernetes TLS without a transport CA override', async t => {
  const f = await fixture(t); const server = await httpsFixture(t, (_req, res) => res.end('{"kind":"Gateway","metadata":{}}'));
  const other = await httpsFixture(t, (_req, res) => res.end('{}')); const caFile = join(f.directory, 'kubernetes-ca.pem');
  writeFileSync(caFile, server.ca); const target = { ...f.target, kubernetesCaFile: caFile }; const native = https.request;
  const request = ((url: URL, options: https.RequestOptions, callback: any) => native(new URL(url.pathname, server.baseUrl), { ...options, servername: 'localhost' }, callback)) as typeof https.request;
  const right = createKubernetesReader(target, { request }); writeFileSync(caFile, other.ca);
  const wrong = createKubernetesReader(target, { request });
  assert.equal((await right.getGateway()).kind, 'Gateway'); await assert.rejects(wrong.getGateway(), { message: 'Kubernetes read failed' });
  await right.close(); await wrong.close();
});
test('close cancels and drains held native work; pre-abort and closed readers never hand off', async t => {
  const f = await fixture(t); const gate = deferred(); let entered = false;
  const server = await httpsFixture(t, async (_req, res) => { entered = true; await gate.promise; res.end('{}'); });
  const native = https.request; let handoffs = 0; let closes = 0;
  const request = ((url: URL, options: https.RequestOptions, callback: any) => {
    handoffs++; const req = native(new URL(url.pathname, server.baseUrl), { ...options, ca: server.ca, servername: 'localhost' }, callback);
    req.once('close', () => { closes++; }); return req;
  }) as typeof https.request;
  const reader = createKubernetesReader(f.target, { request }); t.after(() => { gate.resolve(); });
  const pre = new AbortController(); pre.abort(); await assert.rejects(reader.getGateway(pre.signal)); assert.equal(handoffs, 0);
  const pending = assert.rejects(reader.getGateway()); await eventually(() => entered); await reader.close(); assert.equal(closes, 1); await pending;
  await assert.rejects(reader.getAgent()); assert.equal(handoffs, 1); gate.resolve();
});
