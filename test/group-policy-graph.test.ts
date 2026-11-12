import assert from 'node:assert/strict';
import https from 'node:https';
import test from 'node:test';
import { createGraphIdentity } from '../src/auth/graph-identity.js';
import { createGroupAuthorizer } from '../src/policy/admission.js';
import { snapshotGroupPolicy } from '../src/policy/config.js';
import { createGraphMembershipClient } from '../src/policy/graph.js';
import { acaEnvironment, identityFixture } from './support/aca-identity.js';
import { httpsFixture } from './support/ingress-https.js';
import { registryInput } from './support/registry.js';
import { deferred, eventually } from './support/table-service.js';

const objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const groups = Array.from({ length: 21 }, (_, n) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`);
const context = () => ({ signal: new AbortController().signal, deadline: performance.now() + 10000 });
async function fixture(t: test.TestContext) {
  let response: { status: number; body: string | Buffer } = { status: 200, body: JSON.stringify({ '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#Collection(Edm.String)', value: [groups[0]] }) };
  let custom: ((n: number) => typeof response) | undefined; let gate: Promise<void> | undefined;
  const bodies: string[][] = []; let paths = true; let closes = 0; let sockets = 0; let tokenCalls = 0; let identityClosed = false;
  const reached = deferred(); const smallBatch = deferred(); let reverseArrival = false;
  const server = await httpsFixture(t, async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const groupIds = JSON.parse(text).groupIds as string[];
    if (reverseArrival && groupIds.length === 20) await smallBatch.promise;
    bodies.push(groupIds); const n = bodies.length;
    if (groupIds.length === 1) smallBatch.resolve();
    reached.resolve();
    if (gate) await gate;
    const value = custom?.(n) ?? response; res.writeHead(value.status, { 'content-type': 'application/json' }); res.end(value.body);
  });
  const native = https.request;
  const request = ((url: URL, options: https.RequestOptions, callback: any) => {
    paths &&= url.href === `https://graph.microsoft.com/v1.0/users/${objectId}/checkMemberGroups` && options.method === 'POST' &&
      options.rejectUnauthorized === true && options.agent === false && options.headers !== undefined &&
      (options.headers as Record<string, string>).authorization === 'Bearer synthetic-graph';
    const req = native(new URL(url.pathname, server.baseUrl), { ...options, ca: server.ca, servername: 'localhost' }, callback);
    req.once('close', () => { closes++; }); req.once('socket', socket => socket.once('close', () => { sockets++; })); return req;
  }) as typeof https.request;
  const identity = { assertUsable() { if (identityClosed) throw new Error('private-source-sentinel'); },
    async token() { tokenCalls++; return 'synthetic-graph'; }, async close() { identityClosed = true; } };
  const client = createGraphMembershipClient(identity, { request }); t.after(() => client.close());
  return { client, request, identity, bodies, reached, server, paths: () => paths, closes: () => closes, sockets: () => sockets, tokenCalls: () => tokenCalls,
    reverseArrivals() { reverseArrival = true; }, response(value: typeof response) { response = value; }, responseFor(value: (n: number) => typeof response) { custom = value; },
    hold(value: Promise<void>) { gate = value; } };
}
test('Graph checks only configured groups in 20-ID batches, merges complete transitive result and drains native sockets', async t => {
  const f = await fixture(t); f.reverseArrivals(); f.responseFor(n => ({ status: 200, body: JSON.stringify({ '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#Collection(Edm.String)', value: [f.bodies[n - 1]![0]!.toUpperCase()] }) }));
  assert.deepEqual(await f.client.lookup(objectId, groups, context()), [groups[0], groups[20]]);
  assert.deepEqual(f.bodies.map(v => v.length).sort((a, b) => a - b), [1, 20]); assert.equal(f.paths(), true); assert.equal(f.tokenCalls(), 1);
  assert.equal(f.closes(), 2); assert.equal(f.sockets(), 2);
});
for (const [name, status, body] of [
  ['redirect', 302, '{}'], ['auth', 401, '{}'], ['forbidden', 403, '{}'], ['throttle', 429, '{}'], ['server', 503, '{}'],
  ['bad JSON', 200, '{'], ['missing', 200, '{}'], ['null', 200, 'null'], ['nonarray', 200, '{"value":"x"}'],
  ['wrong group', 200, JSON.stringify({ value: [objectId] })], ['duplicates', 200, JSON.stringify({ value: [groups[0], groups[0]] })],
  ['next link', 200, '{"value":[],"@odata.nextLink":"https://private.invalid"}'], ['partial', 200, '{"value":[],"error":"private-sentinel"}'],
  ['context type', 200, '{"value":[],"@odata.context":{}}'], ['oversize', 200, 'x'.repeat(65537)],
] as const) test(`Graph ${name} never grants, follows URLs or leaks errors`, async t => {
  const f = await fixture(t); f.response({ status, body });
  await assert.rejects(f.client.lookup(objectId, [groups[0]!], context()), { message: 'Graph membership unavailable' }); assert.equal(f.bodies.length, 1);
});
test('invalid Graph UTF-8 is rejected without replacement decoding', async t => {
  const f = await fixture(t); f.response({ status: 200, body: Buffer.from([0x7b, 0xff, 0x7d]) });
  await assert.rejects(f.client.lookup(objectId, [groups[0]!], context()), { message: 'Graph membership unavailable' });
});
test('native ACA to Graph to authorizer caches complete admission and refreshes denial after expiry', async t => {
  acaEnvironment(t); const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start });
  const f = await fixture(t); const local = await identityFixture(t, (req, res) => {
    assert.equal(new URL(req.url!, 'http://127.0.0.1').searchParams.get('resource'), 'https://graph.microsoft.com/');
    res.end(JSON.stringify({ access_token: 'synthetic-graph', token_type: 'Bearer', resource: 'https://graph.microsoft.com/',
      expires_on: Math.floor(Date.now() / 1000) + 3600, client_id: objectId }));
  });
  const registry = registryInput(); const policy = snapshotGroupPolicy({ schemaVersion: 1, graphIdentityClientId: objectId, policies: [
    { schemaVersion: 1, targetId: 'primary', frontAgent: 'front', rules: [{ groupId: groups[0], chatKinds: ['personal'] }] },
  ] }, registry);
  const authorizer = createGroupAuthorizer(policy, createGraphMembershipClient(createGraphIdentity(policy.graphIdentityClientId, { request: local.request }), { request: f.request }));
  t.after(() => authorizer.close());
  const subject = { tenantId: policy.tenantId, objectId, chatKind: 'personal' as const };
  assert.equal((await authorizer.authorize(subject, context(), 'primary')).kind, 'eligible');
  f.response({ status: 503, body: '{}' });
  assert.equal((await authorizer.authorize(subject, context(), 'primary')).kind, 'eligible'); assert.equal(f.bodies.length, 1);
  t.mock.timers.setTime(start + 60000); assert.equal((await authorizer.authorize(subject, context(), 'primary')).kind, 'unavailable');
  f.response({ status: 200, body: '{"value":[]}' });
  assert.equal((await authorizer.authorize(subject, context(), 'primary')).kind, 'no-access');
  assert.equal(f.paths(), true); await authorizer.close(); local.drained(); assert.equal(f.closes(), 3); assert.equal(f.sockets(), 3);
});
test('later batch failure never returns first batch membership', async t => {
  const f = await fixture(t); f.responseFor(n => ({ status: n === 1 ? 200 : 503, body: JSON.stringify({ value: n === 1 ? [groups[0]] : [] }) }));
  await assert.rejects(f.client.lookup(objectId, groups, context())); assert.equal(f.closes(), 2); assert.equal(f.sockets(), 2);
});
test('Graph validates all request fields before acquisition', async t => {
  const f = await fixture(t); const pre = new AbortController(); pre.abort();
  for (const [id, ids, ctx] of [ ['../users', groups, context()], [objectId, [groups[0], groups[0]], context()],
    [objectId, Array(257).fill(groups[0]), context()], [objectId, groups, { ...context(), signal: pre.signal }],
    [objectId, groups, { ...context(), deadline: NaN }], [objectId, groups, { ...context(), deadline: Infinity }], [objectId, groups, { ...context(), deadline: performance.now() - 1 }],
  ] as const) await assert.rejects(f.client.lookup(id, ids as string[], ctx));
  assert.equal(f.tokenCalls(), 0); assert.equal(f.bodies.length, 0);
});
test('verified Graph TLS rejects an untrusted fixture CA', async t => {
  const f = await fixture(t); const native = https.request;
  const request = ((url: URL, options: https.RequestOptions, callback: any) => native(new URL(url.pathname, f.server.baseUrl), options, callback)) as typeof https.request;
  const client = createGraphMembershipClient(f.identity, { request });
  await assert.rejects(client.lookup(objectId, [groups[0]!], context())); await client.close(); assert.equal(f.bodies.length, 0);
});
for (const action of ['cancel', 'deadline', 'close'] as const) test(`Graph ${action} destroys and drains held native work without late grant`, async t => {
  const f = await fixture(t); const gate = deferred(); f.hold(gate.promise); t.after(() => gate.resolve());
  const abort = new AbortController();
  const pending = assert.rejects(f.client.lookup(objectId, [groups[0]!], { signal: abort.signal, deadline: performance.now() + (action === 'deadline' ? 100 : 10000) }));
  try {
    await f.reached.promise;
    if (action === 'cancel') abort.abort();
    if (action === 'close') await f.client.close();
    await pending; assert.equal(f.closes(), 1); assert.equal(f.sockets(), 1);
    await f.client.close(); await assert.rejects(f.client.lookup(objectId, groups, context()));
  } finally { gate.resolve(); await f.client.close(); }
});
test('Graph caps actual concurrent lookups at 32 until close drains', async t => {
  const f = await fixture(t); const gate = deferred(); f.hold(gate.promise); t.after(() => gate.resolve());
  const pending = Promise.allSettled(Array.from({ length: 32 }, () => f.client.lookup(objectId, [groups[0]!], context())));
  try {
    await eventually(() => f.bodies.length === 32); await assert.rejects(f.client.lookup(objectId, [groups[0]!], context()));
    assert.equal(f.tokenCalls(), 32); await f.client.close(); assert.equal((await pending).every(r => r.status === 'rejected'), true);
    assert.equal(f.closes(), 32); assert.equal(f.sockets(), 32);
  } finally { gate.resolve(); await f.client.close(); }
});
