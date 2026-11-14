import assert from 'node:assert/strict';
import type { Activity } from '@microsoft/teams.api';
import type { EventEnvelope } from '../src/protocol/types.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityFixture } from './support/aca-identity.js';
import type { RegistryRuntimeDependencies } from '../src/registry/runtime.js';
import { decodeEntity, bindingName } from '../src/directory/codec.js';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { prepareStorageIdentity } from '../src/auth/storage-identity.js';
import { NativeAdapter } from '../src/ingress/http-adapter.js';
import { initializeTableStore } from '../src/ingress/main.js';
import { createTableIngressStoreV3 } from '../src/ingress/table-store.js';
import { snapshotRegistry } from '../src/registry/config.js';
import { startRegistryRuntime } from '../src/registry/runtime.js';
import { expectedEvent } from './fixtures/incoming.js';
import { finalDelivery } from './fixtures/outgoing.js';
import { activity, authFixture, post, receiverConfig, serviceUrl } from './support/ingress-auth.js';
import { httpsFixture } from './support/ingress-https.js';
import { registryInput } from './support/registry.js';
import { runtimeIdentity } from './support/table-runtime.js';
import { deferred, eventually, syntheticToken, tableService } from './support/table-service.js';
import { directoryFixture } from './support/directory-table.js';
import { encodeEntity } from '../src/directory/codec.js';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { miConfig, entraNetwork } from './support/managed-identity.js';
import { WORK_IQ_SCOPE } from '../src/auth/delegated.js';
import type { ControlRecord } from '../src/directory/types.js';
import { TestClock } from './support/table-v3.js';
import { payload } from './support/table-ingress-store.js';
import { convertActivity } from '../src/teams/convert.js';
import { createAccountStore } from '../src/accounts/store.js';
import { grantReference } from '../src/accounts/grants.js';
import { context as accountContext } from './support/directory-table.js';

async function fixture(t: test.TestContext, initialize = true, count = 2, expirySeconds = 3600) {
  const config = { ...registryInput(count), groupPolicyFile: '' }; const identity = await runtimeIdentity(t, expirySeconds);
  const files = mkdtempSync(join(tmpdir(), 'registry-live-')); t.after(() => rmSync(files, { recursive: true, force: true }));
  config.groupPolicyFile = join(files, 'policy.json');
  writeFileSync(config.groupPolicyFile, JSON.stringify({ schemaVersion: 1, graphIdentityClientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', policies: [] }));
  const domains: { target: string; kind: 'ingress' | 'delivery'; storeId: string; service: Awaited<ReturnType<typeof tableService>> }[] = [];
  for (const target of config.targets) for (const kind of ['ingress', 'delivery'] as const) {
    const storeId = kind === 'ingress' ? target.config.storage.ingressStoreId : target.config.storage.deliveryStoreId!;
    domains.push({ target: target.id, kind, storeId, service: await tableService(t, kind, 3, target.config.scope, httpsFixture, storeId) });
  }
  const directory = await directoryFixture(t, syntheticToken); const accounts = await directoryFixture(t, syntheticToken);
  const native = https.request; let contract = true;
  const bindings = new Map<string, Map<string, Record<string, any>>>(); let kubernetesGate: Promise<void> | undefined; let kubernetesCalls = 0;
  for (const target of config.targets) {
    target.kubernetesBaseUrl = `https://${target.id}-kubernetes.example.invalid/`;
    target.kubernetesTokenFile = join(files, `${target.id}-kubernetes.json`);
    writeFileSync(target.kubernetesTokenFile, JSON.stringify({ token: 'synthetic-kubernetes', expiresAt: new Date(Date.now() + 3600000).toISOString() }), { mode: 0o600 });
    bindings.set(target.id, new Map());
  }
  const kube = await httpsFixture(t, async (req, res) => {
    kubernetesCalls++; await kubernetesGate;
    const target = String(req.headers['fixture-target']); const saved = bindings.get(target)!; const path = new URL(req.url!, 'https://localhost').pathname;
    let value: unknown;
    if (path.endsWith('/gateways/teams')) value = { apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'Gateway', metadata: { namespace: 'default', name: 'teams', uid: 'gateway-uid', generation: 1 }, status: { ready: true, observedGeneration: 1 } };
    else if (path.endsWith('/agents/front')) value = { apiVersion: 'core.orka.ai/v1alpha1', kind: 'Agent', metadata: { namespace: 'default', name: 'front' } };
    else if (path.endsWith('/gatewaybindings') && req.method === 'POST') {
      let text = ''; for await (const chunk of req) text += chunk;
      const created = JSON.parse(text); value = { ...created, metadata: { ...created.metadata, uid: randomUUID(), generation: 1 }, status: { ready: true, observedGeneration: 1 } };
      saved.set(created.metadata.name, value as Record<string, any>);
    } else if (path.endsWith('/gatewaybindings')) value = { kind: 'GatewayBindingList', metadata: {}, items: [...saved.values()] };
    else value = saved.get(path.split('/').at(-1)!);
    res.writeHead(value ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(value ?? {}));
  });
  const kubernetesRequest = ((url: URL, options: https.RequestOptions, callback: any) => native(new URL(url.pathname + url.search, kube.baseUrl),
    { ...options, ca: kube.ca, servername: 'localhost', headers: { ...options.headers, 'fixture-target': url.hostname.split('-kubernetes.')[0]! } }, callback)) as typeof https.request;
  const router = await httpsFixture(t, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
    const data = decodeURIComponent(req.url ?? '') + body.toString();
    const selected = domains.filter(d => data.includes(`v1_${d.kind}_${Buffer.from(d.storeId).toString('base64url')}`));
    if (selected.length !== 1) { contract = false; res.destroy(); return; }
    const service = selected[0]!.service;
    const forward = native({ hostname: '127.0.0.1', port: new URL(service.fixture.baseUrl).port, path: req.url!, method: req.method, headers: req.headers,
      agent: false, rejectUnauthorized: true, ca: service.fixture.ca, servername: 'localhost' }, response => { res.writeHead(response.statusCode!, response.headers); response.pipe(res); });
    forward.on('error', () => res.destroy()); forward.end(body);
  });
  const request = ((url: URL, options: https.RequestOptions, callback: Parameters<typeof https.request>[2]) => {
    contract &&= url.origin === 'https://example123.table.core.windows.net' && options.rejectUnauthorized === true;
    if (url.pathname.startsWith('/Directory')) return directory.request(url, options, callback!);
    if (url.pathname.startsWith('/Accounts')) return accounts.request(url, options, callback!);
    return native(new URL(url.pathname + url.search, router.baseUrl), { ...options, ca: router.ca, servername: 'localhost' }, callback);
  }) as typeof https.request;
  const auth = await authFixture(t); const deps = { ...auth.dependencies, tableRequest: request, kubernetesRequest, storageIdentity: { request: identity.request },
    botToken: async () => 'synthetic-only', providerPost: async () => ({ status: 201, data: Buffer.from('{"id":"control-receipt"}') }) } satisfies RegistryRuntimeDependencies;
  if (initialize) for (const target of config.targets) for (const kind of ['ingress', 'delivery'] as const) {
    const c = target.config;
    await initializeTableStore({ kind, scope: c.scope, storage: { backend: 'table-v3', account: c.storage.account, table: c.storage.table, identity: c.storage.identity, storeId: kind === 'ingress' ? c.storage.ingressStoreId : c.storage.deliveryStoreId! },
      ...(kind === 'ingress' ? { audit: c.storage.audit, maxIndexBytes: c.storage.maxIndexBytes } : {}) } as never, { tableRequest: request, storageIdentity: deps.storageIdentity });
  }
  t.after(() => { assert.equal(contract, true); assert.equal(domains.some(d => d.service.stats.violation), false); });
  return { config, deps, domains, auth, identity, directory, accounts, files, bindings, kubernetesCalls: () => kubernetesCalls,
    holdKubernetes: (gate: Promise<void> | undefined) => { kubernetesGate = gate; } };
}

async function policyFixture(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const group = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  writeFileSync(f.config.groupPolicyFile, JSON.stringify({ schemaVersion: 1, graphIdentityClientId: clientId,
    policies: f.config.targets.map(target => ({ schemaVersion: 1, targetId: target.id, frontAgent: 'front', rules: [{ groupId: group, chatKinds: ['personal', 'groupChat'] }] })) }));
  const identity = await identityFixture(t, (req, res) => {
    const resource = new URL(req.url!, 'http://localhost').searchParams.get('resource'); assert.equal(resource, 'https://graph.microsoft.com/');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ access_token: 'synthetic-graph', resource, token_type: 'Bearer', client_id: clientId, expires_on: Math.floor(Date.now() / 1000) + 3600 }));
  });
  let status = 200; let calls = 0; let gate: Promise<void> | undefined;
  const server = await httpsFixture(t, async (req, res) => {
    calls++; let text = ''; for await (const chunk of req) text += chunk;
    assert.deepEqual(JSON.parse(text), { groupIds: [group] }); await gate;
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ value: req.url!.includes('/dddddddd-') ? [] : [group] }));
  });
  const native = https.request;
  const graphRequest = ((url: URL, options: https.RequestOptions, callback: any) => {
    assert.equal(url.origin, 'https://graph.microsoft.com');
    return native(new URL(url.pathname, server.baseUrl), { ...options, ca: server.ca, servername: 'localhost' }, callback);
  }) as typeof https.request;
  return { deps: { ...f.deps, graphIdentityRequest: identity.request, graphRequest }, identityBaseUrl: identity.baseUrl, calls: () => calls,
    status: (value: number) => { status = value; }, hold: (value: Promise<void> | undefined) => { gate = value; } };
}

test('synthetic identity response explicitly declares JSON content', async t => {
  const f = await fixture(t); const graph = await policyFixture(t, f);
  const response = await fetch(new URL('?resource=https%3A%2F%2Fgraph.microsoft.com%2F', graph.identityBaseUrl));
  await response.arrayBuffer(); assert.equal(response.headers.get('content-type'), 'application/json');
});

test('native live discovery, connection, current sender admission and recurring relay checks', async t => {
  const f = await fixture(t); const graph = await policyFixture(t, f); let orka = 0;
  const upstream = await httpsFixture(t, async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const event = JSON.parse(text); orka++; res.writeHead(202); res.end(JSON.stringify({ status: 'accepted', eventId: event.externalEventId, state: 'Queued' }));
  });
  const native = https.request;
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: any) =>
    url.hostname === 'tools.example.invalid' ? native(new URL(url.pathname, upstream.baseUrl), { ...options, ca: upstream.ca, servername: 'localhost' }, callback) : native(url, options, callback));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const messages: string[] = []; const runtime = await startRegistryRuntime(f.config, { ...graph.deps, providerPost: async (_url, body) => {
    messages.push(body.toString()); return { status: 201, data: Buffer.from('{"id":"receipt"}') };
  } }); t.after(() => runtime.stop().catch(() => {}));
  const input = activity(); input.from.aadObjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal((await post(runtime.port, f.auth.token(), input)).status, 200); assert.equal(orka, 0); assert.match(messages[0]!, /use tools/);
  input.id = 'connect'; input.text = 'use tools'; assert.equal((await post(runtime.port, f.auth.token(), input)).status, 200); assert.equal(orka, 0);
  const before = f.kubernetesCalls(); input.id = 'request'; input.text = 'do work'; assert.equal((await post(runtime.port, f.auth.token(), input)).status, 200);
  await eventually(() => orka === 1); assert.ok(f.kubernetesCalls() >= before + 12, 'admission and relay each perform fresh checks');
  input.id = 'denied-sender'; input.from.aadObjectId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  assert.equal((await post(runtime.port, f.auth.token(), input)).status, 200); assert.match(messages.at(-1)!, /You don't have access/); assert.equal(orka, 1);
  assert.equal(graph.calls(), 2);
  const scope = { appId: f.config.targets[0]!.config.scope.appId, tenantId: f.config.targets[0]!.config.scope.tenantId };
  const rows = [...f.directory.rows.values()].map(row => decodeEntity(scope, row).value);
  assert.equal(rows.filter(row => row.kind === 'conn' && row.state === 'provisioned').length, 1);
  assert.ok(rows.filter(row => row.kind === 'control').every(row => row.state === 'delivered'));
});

test('post-open directory corruption flushes fixed 503 and stops all targets', async t => {
  const f = await fixture(t); const runtime = await startRegistryRuntime(f.config, f.deps); t.after(() => runtime.stop().catch(() => {}));
  f.directory.controls.hook = ({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"invalid":"private-sentinel"}'); };
  const done = assert.rejects(runtime.done, { message: 'Ingress storage failed' });
  const response = await post(runtime.port, f.auth.token()); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private-sentinel/); await done;
});

test('normal shutdown during a handed-off directory mutation remains clean', async t => {
  const f = await fixture(t); const runtime = await startRegistryRuntime(f.config, f.deps); let entered = false;
  const gate = deferred(); t.after(async () => { gate.resolve(); await runtime.stop().catch(() => {}); });
  f.directory.controls.hook = async ({ req, reply }) => {
    if (req.method === 'POST' || req.method === 'MERGE' || req.method === 'PUT') { entered = true; await gate.promise; }
    reply();
  };
  const response = post(runtime.port, f.auth.token()).catch(() => undefined); await eventually(() => entered);
  const stopping = runtime.stop(); gate.resolve(); await response; await stopping; await runtime.done;
  assert.ok(f.domains.every(d => d.service.rows.get('M')!.Owner === ''));
});

test('Graph transient failure does not poison stores; shutdown drains held native lookup before lease release', async t => {
  const f = await fixture(t); const graph = await policyFixture(t, f); graph.status(503);
  const runtime = await startRegistryRuntime(f.config, graph.deps); const gate = deferred(); t.after(async () => { gate.resolve(); await runtime.stop().catch(() => {}); });
  const input = activity(); input.from.aadObjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal((await post(runtime.port, f.auth.token(), input)).status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${runtime.outboundPort}/targets/tools/v1/health`, { headers: { authorization: 'Bearer callback-tools' } })).status, 200);
  graph.status(200); graph.hold(gate.promise); input.id = 'held-graph';
  const response = post(runtime.port, f.auth.token(), input).catch(() => undefined); await eventually(() => graph.calls() === 2);
  const owners = f.domains.map(d => d.service.rows.get('M')!.Owner); let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false); assert.deepEqual(f.domains.map(d => d.service.rows.get('M')!.Owner), owners);
  gate.resolve(); await response; await stopping; await runtime.done;
  assert.equal(f.domains.some(d => [...d.service.rows.values()].some(row => row.T === 'event')), false);
});

test('registry runtime requires directory configuration before opening stores', async () => {
  const input = registryInput();
  await assert.rejects(startRegistryRuntime({ schemaVersion: 1, targets: input.targets }), { message: 'Invalid ingress configuration' });
});

for (const fault of ['missing', 'corrupt'] as const) test(`${fault} directory fails startup without listening and releases V3 ownership`, async t => {
  const f = await fixture(t); let listens = 0;
  t.mock.method(NativeAdapter.prototype, 'listen', async () => { listens++; throw new Error('must not listen'); });
  f.directory.controls.hook = ({ res }) => {
    res.writeHead(fault === 'missing' ? 404 : 200, { 'content-type': 'application/json' });
    res.end(fault === 'missing' ? '' : '{"value":[{"invalid":"row"}]}');
  };
  await assert.rejects(startRegistryRuntime(f.config, f.deps), { message: 'Ingress storage failed' });
  assert.equal(listens, 0); assert.ok(f.domains.every(d => d.service.rows.get('M')!.Owner === ''));
});

test('cancellation during directory opening retains all leases until its native socket really closes', async t => {
  const f = await fixture(t); const abort = new AbortController(); const releases: (() => void)[] = []; let waiting = false;
  f.directory.controls.hook = () => { waiting = true; };
  const request = f.deps.tableRequest;
  f.deps.tableRequest = ((...args: Parameters<typeof request>) => {
    const req = request(...args);
    if (args[0] instanceof URL && args[0].pathname.startsWith('/Directory')) req.once('socket', socket => {
      const destroy = socket.destroy.bind(socket); socket.destroy = (() => socket) as typeof socket.destroy;
      releases.push(() => { socket.destroy = destroy; destroy(); });
    });
    return req;
  }) as typeof request;
  let settled = false;
  const starting = startRegistryRuntime(f.config, f.deps, abort.signal);
  const rejected = assert.rejects(starting, { message: 'Ingress storage failed' }).then(() => { settled = true; });
  try {
    await eventually(() => waiting); const owners = f.domains.map(d => d.service.rows.get('M')!.Owner); abort.abort();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    assert.deepEqual(f.domains.map(d => d.service.rows.get('M')!.Owner), owners);
  } finally { for (const release of releases) release(); await rejected; }
  assert.ok(f.domains.every(d => d.service.rows.get('M')!.Owner === ''));
  assert.equal(f.directory.stats.socketCloses, f.directory.stats.sockets);
});

test('32 targets drain a shared held refresh and release all 64 domains cleanly', async t => {
  const f = await fixture(t, true, 32, 30); const gate = deferred();
  const runtime = await startRegistryRuntime(f.config, f.deps); let stopped = false;
  try {
    const before = f.identity.calls.storage; f.identity.delayStorage(gate.promise);
    const result = runtime.stop().then(() => { stopped = true; return true; }, () => { stopped = true; return false; });
    await eventually(() => f.identity.calls.storage > before); assert.equal(stopped, false);
    gate.resolve(); assert.equal(await result, true, 'supported 64-domain release cannot overflow token admission'); await runtime.done;
    assert.ok(f.domains.every(d => d.service.rows.get('M')!.Owner === ''));
  } finally { gate.resolve(); await runtime.stop().catch(() => {}); }
});

test('callback all-target revalidation overlaps independent domains instead of serializing their network latency', async t => {
  const f = await fixture(t); await seed(f); const gate = deferred(); let entered = 0;
  const c = f.config.targets[0]!.config;
  const { createTableDeliveryJournalV3 } = await import('../src/delivery/table-journal.js');
  const samples = [createTableIngressStoreV3({ kind: 'ingress', account: c.storage.account, table: c.storage.table, storeId: c.storage.ingressStoreId, scope: c.scope },
    { token: async () => 'unused' }, { audit: c.storage.audit, maxIndexBytes: c.storage.maxIndexBytes }),
    createTableDeliveryJournalV3({ kind: 'delivery', account: c.storage.account, table: c.storage.table, storeId: c.storage.deliveryStoreId!, scope: { appId: c.scope.appId, tenantId: c.scope.tenantId } }, { token: async () => 'unused' })];
  for (const sample of samples) {
    const proto = Object.getPrototypeOf(sample); const original = proto.leaseAuthority;
    t.mock.method(proto, 'leaseAuthority', function(this: typeof sample) {
      const a = original.call(this); return { ...a, async revalidate() { entered++; if (entered === 1) await gate.promise; return a.revalidate(); } };
    });
  }
  const runtime = await startRegistryRuntime(f.config, { ...f.deps, botToken: async () => 'synthetic-only',
    providerPost: async () => ({ status: 201, data: Buffer.from('{"id":"receipt"}') }) });
  t.after(async () => { gate.resolve(); await runtime.stop().catch(() => {}); });
  const response = fetch(`http://127.0.0.1:${runtime.outboundPort}/targets/tools/v1/deliveries`, { method: 'POST', headers: {
    authorization: 'Bearer callback-tools', 'content-type': 'application/json' }, body: JSON.stringify({ ...finalDelivery, contextId: `${finalDelivery.contextId}-tools` }) });
  await eventually(() => entered > 0); const concurrent = entered; gate.resolve(); await response; await runtime.stop();
  assert.equal(concurrent, 4, 'one held remote lease read must not defer reads of the other independent domains');
});

test('all V3 audits and inherited directory recovery precede listeners; registry denies personal/group access and refuses channels', async t => {
  const f = await fixture(t); let listens = 0;
  const scope = { appId: f.config.targets[0]!.config.scope.appId, tenantId: f.config.targets[0]!.config.scope.tenantId };
  const value: ControlRecord = { schema: 1, kind: 'control', scope, conversationId: 'old-chat', chatKind: 'personal', activityId: 'old-activity',
    fingerprint: 'a'.repeat(64), currentTargetDigest: null, desiredTargetDigest: null, state: 'armed', ownerUUID: randomUUID(), attemptUUID: randomUUID(),
    route: { serviceUrl, channelId: 'msteams', bot: { id: receiverConfig.recipientIds[0]!, role: 'bot' },
      conversation: { id: 'old-chat', tenantId: scope.tenantId, conversationType: 'personal' } }, reply: { kind: 'no-access' } };
  const row = encodeEntity(scope, { kind: 'control', conversationId: value.conversationId, activityId: value.activityId }, value);
  f.directory.rows.set(String(row.RowKey), { ...row, Timestamp: '2026-01-01T00:00:00Z', 'odata.etag': '"old"' });
  f.directory.controls.hook = ({ reply }) => { assert.ok(f.domains.every(d => !!d.service.rows.get('M')?.Owner)); reply(); };
  const listen = NativeAdapter.prototype.listen;
  t.mock.method(NativeAdapter.prototype, 'listen', function(this: NativeAdapter, ...args: Parameters<typeof listen>) {
    assert.ok(f.domains.every(d => !!d.service.rows.get('M')?.Owner));
    assert.equal(f.directory.rows.get(String(row.RowKey))!.Armed, false); listens++; return listen.apply(this, args);
  });
  const native = https.request; let kubernetes = 0;
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: any) => {
    if (url.hostname === 'kubernetes.example.invalid') kubernetes++;
    return native(url, options, callback);
  }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const runtime = await startRegistryRuntime(f.config, f.deps); t.after(() => runtime.stop());
  assert.equal(listens, 1);
  for (const kind of ['personal', 'groupChat', 'channel']) {
    const input = activity(); input.id += `-${kind}`; input.conversation.id += `-${kind}`; input.conversation.conversationType = kind;
    if (kind !== 'personal') {
      input.conversation.isGroup = true; input.from.aadObjectId = 'aad-requester';
      input.text = '<at>Orka</at> help';
      input.entities = [{ type: 'mention', text: '<at>Orka</at>', mentioned: { id: input.recipient.id } }];
    }
    assert.equal((await post(runtime.port, f.auth.token(), input)).status, kind === 'channel' ? 409 : 200);
  }
  assert.equal(f.domains.some(d => [...d.service.rows.values()].some(row => row.T === 'event')), false);
  assert.equal(kubernetes, 0);
  for (const id of ['primary', 'tools']) assert.equal((await fetch(`http://127.0.0.1:${runtime.outboundPort}/targets/${id}/v1/health`, {
    headers: { authorization: `Bearer callback-${id}` } })).status, 200);
  for (const path of ['/v1/health', '/v1/capabilities', '/v1/deliveries']) {
    assert.equal((await fetch(`http://127.0.0.1:${runtime.outboundPort}${path}`, { headers: { authorization: 'Bearer callback-primary' } })).status, 404);
  }
  await runtime.stop(); await runtime.done; assert.ok(f.domains.every(d => d.service.rows.get('M')?.Owner === ''));
});
for (const index of [0, 1, 2, 3]) test(`authority loss in domain ${index} stops all slots`, async t => {
  const f = await fixture(t); const clock = new TestClock(); const runtime = await startRegistryRuntime(f.config, { ...f.deps, tableLeaseClock: clock });
  t.after(() => runtime.stop().catch(() => {}));
  f.domains[index]!.service.controls.hook = e => { if (e.req.method === 'GET') { e.res.writeHead(503); e.res.end(); } else e.reply(); };
  clock.advance(40000); await assert.rejects(runtime.done, { message: 'Ingress storage failed' });
  await assert.rejects(fetch(`http://127.0.0.1:${runtime.port}/healthz`));
});
test('cancellation during a later live foreign-lease wait closes every retained handle without listening', async t => {
  const f = await fixture(t); const abort = new AbortController(); let listens = 0;
  t.mock.method(NativeAdapter.prototype, 'listen', async () => { listens++; throw new Error('must not listen'); });
  const c = f.config.targets[1]!.config;
  const { createTableDeliveryJournalV3 } = await import('../src/delivery/table-journal.js');
  const { prepareStorageIdentity } = await import('../src/auth/storage-identity.js');
  const provider = prepareStorageIdentity(c.storage.identity).createProvider(f.deps.storageIdentity);
  const foreign = createTableDeliveryJournalV3({ kind: 'delivery', account: c.storage.account, table: c.storage.table, storeId: c.storage.deliveryStoreId!, scope: { appId: c.scope.appId, tenantId: c.scope.tenantId } }, { token: provider.token, request: f.deps.tableRequest });
  await foreign.open(); t.after(async () => { await foreign.close().catch(() => {}); await provider.close(); });
  let waiting = false;
  f.domains[3]!.service.controls.hook = e => { if (e.req.method === 'GET') waiting = true; e.reply(); };
  const startup = startRegistryRuntime(f.config, f.deps, abort.signal); const failure = assert.rejects(startup);
  await eventually(() => waiting); abort.abort(); await failure; assert.equal(listens, 0);
  assert.ok(f.domains.slice(0, 3).every(d => d.service.rows.get('M')?.Owner === ''));
  await foreign.close(); await provider.close();
});
test('startup cancellation never closes stores before held actual listener startup drains', async t => {
  const f = await fixture(t); const abort = new AbortController(); const gate = deferred(); let entered = false; let drained = false; let earlyCloses = 0;
  const listen = NativeAdapter.prototype.listen;
  t.mock.method(NativeAdapter.prototype, 'listen', async function(this: NativeAdapter, ...args: Parameters<typeof listen>) {
    const port = await listen.apply(this, args); entered = true; await gate.promise; drained = true; return port;
  });
  const c = f.config.targets[0]!.config;
  const sample = createTableIngressStoreV3({ kind: 'ingress', account: c.storage.account, table: c.storage.table, storeId: c.storage.ingressStoreId, scope: c.scope },
    { token: async () => 'unused' }, { audit: c.storage.audit, maxIndexBytes: c.storage.maxIndexBytes });
  const proto = Object.getPrototypeOf(sample); const close = proto.close;
  t.mock.method(proto, 'close', function(this: typeof sample) { if (!drained) earlyCloses++; return close.call(this); });
  const startup = startRegistryRuntime(f.config, f.deps, abort.signal); const failure = assert.rejects(startup, { message: 'Ingress storage failed' });
  await eventually(() => entered); abort.abort(); await new Promise(resolve => setImmediate(resolve));
  const early = earlyCloses; gate.resolve(); await failure;
  assert.equal(early, 0, 'store close cannot start while actual listener startup is held');
  assert.ok(f.domains.every(d => d.service.rows.get('M')?.Owner === ''));
});

test('relay storage rejection during shutdown rejects done even when the store remains healthy', async t => {
  const f = await fixture(t); await seed(f); const gate = deferred(); let entered = false;
  const c = f.config.targets[0]!.config;
  const sample = createTableIngressStoreV3({ kind: 'ingress', account: c.storage.account, table: c.storage.table, storeId: c.storage.ingressStoreId, scope: c.scope },
    { token: async () => 'unused' }, { audit: c.storage.audit, maxIndexBytes: c.storage.maxIndexBytes });
  const proto = Object.getPrototypeOf(sample); const retry = proto.retry;
  // Model an async storage-port rejection with no poisoned lease, after actual durable settlement.
  t.mock.method(proto, 'retry', async function(this: typeof sample, ...args: Parameters<typeof sample.retry>) {
    await retry.apply(this, args); entered = true; await gate.promise; throw new Error('synthetic storage-port rejection');
  });
  const upstream = await httpsFixture(t, (_req, res) => { res.writeHead(503); res.end(); }); const native = https.request;
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: any) =>
    ['orka.example.invalid', 'tools.example.invalid'].includes(url.hostname) ? native(new URL(url.pathname, upstream.baseUrl), { ...options, ca: upstream.ca, servername: 'localhost' }, callback) : native(url, options, callback));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); gate.resolve(); });
  const runtime = await startRegistryRuntime(f.config, f.deps); await eventually(() => entered);
  const done = assert.rejects(runtime.done, { message: 'Ingress storage failed' });
  const stopping = assert.rejects(runtime.stop(), { message: 'Ingress storage failed' }); gate.resolve(); await Promise.all([stopping, done]);
});

test('missing later domain unwinds acquired earlier domains and never listens', async t => {
  const f = await fixture(t); f.domains[3]!.service.rows.clear();
  await assert.rejects(startRegistryRuntime(f.config, f.deps), { message: 'Ingress storage failed' });
  assert.ok(f.domains.every(d => !d.service.rows.get('M')?.Owner));
});

async function seed(f: Awaited<ReturnType<typeof fixture>>, inputEvent: EventEnvelope = expectedEvent) {
  const provider = prepareStorageIdentity(f.config.targets[0]!.config.storage.identity).createProvider(f.deps.storageIdentity);
  try { for (const target of f.config.targets) {
    const c = target.config; const inbox = createTableIngressStoreV3({ kind: 'ingress', account: c.storage.account, table: c.storage.table,
      storeId: c.storage.ingressStoreId, scope: c.scope }, { token: provider.token, request: f.deps.tableRequest },
    { audit: c.storage.audit, maxIndexBytes: c.storage.maxIndexBytes, policy: c.policy });
    await inbox.open();
    const event = { ...inputEvent, contextId: target.id === 'primary' ? inputEvent.contextId : `${inputEvent.contextId}-${target.id}` };
    const registered = snapshotRegistry(f.config).targets.find(t => t.id === target.id)!; const digest = registered.identityDigest!;
    const scope = { appId: c.scope.appId, tenantId: c.scope.tenantId }; const name = bindingName(scope, event.contextId, digest);
    const spec = { gatewayRef: { name: c.scope.gatewayName }, agentRef: { name: 'front' }, match: { accountId: c.scope.tenantId, contextId: event.contextId },
      priority: 0, senderPolicy: { mode: 'all' }, session: { mode: 'context-sender' } };
    const value = { schema: 1 as const, kind: 'conn' as const, scope, conversationId: event.contextId, chatKind: 'personal' as const,
      targetId: target.id, identityDigest: digest, bindingName: name, state: 'provisioned' as const, binding: { namespace: 'default', name, uid: 'uid', generation: 1, spec } };
    const row = encodeEntity(scope, { kind: 'conn', conversationId: event.contextId }, value);
    f.directory.rows.set(String(row.RowKey), { ...row, Timestamp: '2026-01-01T00:00:00Z', 'odata.etag': '"seed"' });
    f.bindings.get(target.id)!.set(name, { apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'GatewayBinding', metadata: { namespace: 'default', name, uid: 'uid', generation: 1,
      annotations: { 'gateway.orka.ai/teams-target-digest': digest, 'gateway.orka.ai/teams-gateway-uid': 'gateway-uid' } }, spec, status: { ready: true, observedGeneration: 1 } });
    await inbox.admit(event, { serviceUrl, channelId: 'msteams', bot: { id: receiverConfig.recipientIds[0]!, role: 'bot' },
      conversation: { id: event.contextId, conversationType: 'personal', tenantId: event.accountId } });
    await inbox.close();
  } } finally { await provider.close(); }
}

test('retained second-slot work relays independently during primary outage; colliding V3 callbacks retain separate receipts', async t => {
  const f = await fixture(t); await seed(f); const received: string[] = []; let posts = 0;
  const upstream = await httpsFixture(t, (req, res) => {
    const tools = req.headers.authorization === 'Bearer ingress-tools'; received.push(tools ? 'tools' : 'primary');
    if (!tools) { res.writeHead(503, { 'retry-after': '60' }); res.end(); return; }
    res.writeHead(202); res.end(JSON.stringify({ status: 'accepted', eventId: expectedEvent.externalEventId, state: 'Queued' }));
  });
  const native = https.request;
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: any) =>
    ['orka.example.invalid', 'tools.example.invalid'].includes(url.hostname) ? native(new URL(url.pathname, upstream.baseUrl), { ...options, ca: upstream.ca, servername: 'localhost' }, callback) : native(url, options, callback));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const runtime = await startRegistryRuntime(f.config, { ...f.deps, botToken: async () => 'synthetic-only',
    providerPost: async () => ({ status: 201, data: Buffer.from(JSON.stringify({ id: `receipt-${++posts}` })) }) });
  t.after(() => runtime.stop().catch(() => {})); await eventually(() => received.includes('tools') && received.includes('primary'));
  for (const [prefix, id, receipt] of [['/targets/primary', 'primary', 'receipt-1'], ['/targets/tools', 'tools', 'receipt-2']]) {
    const call = () => fetch(`http://127.0.0.1:${runtime.outboundPort}${prefix}/v1/deliveries`, { method: 'POST', headers: {
      authorization: `Bearer callback-${id}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...finalDelivery, contextId: id === 'primary' ? finalDelivery.contextId : `${finalDelivery.contextId}-${id}` }) });
    assert.deepEqual(await (await call()).json(), { status: 'delivered', providerMessageId: receipt });
    assert.deepEqual(await (await call()).json(), { status: 'delivered', providerMessageId: receipt });
  }
  assert.equal(posts, 2); await runtime.stop(); await runtime.done;
});

test('changed retained Binding prevents relay and uses native no-effect backoff without blocking another target', async t => {
  const f = await fixture(t); await seed(f); const received: string[] = [];
  for (const binding of f.bindings.get('tools')!.values()) binding.metadata.uid = 'changed-uid';
  const upstream = await httpsFixture(t, (req, res) => {
    received.push(req.headers.authorization === 'Bearer ingress-tools' ? 'tools' : 'primary');
    res.writeHead(503, { 'retry-after': '60' }); res.end();
  });
  const native = https.request;
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: any) =>
    ['orka.example.invalid', 'tools.example.invalid'].includes(url.hostname) ? native(new URL(url.pathname, upstream.baseUrl), { ...options, ca: upstream.ca, servername: 'localhost' }, callback) : native(url, options, callback));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const runtime = await startRegistryRuntime(f.config, f.deps); t.after(() => runtime.stop().catch(() => {}));
  const inbox = f.domains.find(d => d.target === 'tools' && d.kind === 'ingress')!;
  await eventually(() => [...inbox.service.rows.values()].filter(r => r.T === 'event').map(payload).some(v => v.state === 'pending' && v.attempt > 0 && v.nextAttempt >= v.received + 1000));
  await eventually(() => received.includes('primary')); assert.equal(received.includes('tools'), false);
});

test('all-target shutdown retains every lease until held shared bot-token work actually drains', async t => {
  const f = await fixture(t); await seed(f); const token = deferred(); let waiting = false; let posts = 0;
  const runtime = await startRegistryRuntime(f.config, { ...f.deps, botToken: async () => { waiting = true; await token.promise; return 'synthetic-only'; },
    providerPost: async () => { posts++; return { status: 201, data: Buffer.from('{"id":"forbidden"}') }; } });
  t.after(async () => { token.resolve(); await runtime.stop().catch(() => {}); });
  const sending = fetch(`http://127.0.0.1:${runtime.outboundPort}/targets/tools/v1/deliveries`, { method: 'POST', headers: {
    authorization: 'Bearer callback-tools', 'content-type': 'application/json' }, body: JSON.stringify({ ...finalDelivery, contextId: `${finalDelivery.contextId}-tools` }) }).then(r => r.arrayBuffer(), () => undefined);
  await eventually(() => waiting); const owners = f.domains.map(d => d.service.rows.get('M')!.Owner); let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false); assert.deepEqual(f.domains.map(d => d.service.rows.get('M')!.Owner), owners);
  token.resolve(); await sending; await stopping; await runtime.done; assert.equal(posts, 0);
  assert.ok(f.domains.every(d => d.service.rows.get('M')!.Owner === ''));
});

test('SSO redelivery cannot grant authority to a retained pre-SSO event with its original reply target', { timeout: 20000 }, async t => {
  const f = await fixture(t, true, 1); const graph = await policyFixture(t, f);
  const oid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const message = activity();
  message.from.aadObjectId = oid; message.id = 'historical-work'; message.text = 'do work';
  const converted = convertActivity(message as unknown as Activity, { tenantId: miConfig.tenantId, replyTarget: 'original-pre-sso-reply-target' });
  assert.equal(converted.kind, 'accepted'); if (converted.kind !== 'accepted') throw new Error('Expected normalized event');
  await seed(f, converted.event);
  const target = f.config.targets[0]!; target.config.receiver = { ...miConfig, managedIdentityHost: 'azure-container-apps' };
  Object.assign(target, { taskPassToken: 'controller-primary' });
  const keyFile = join(f.files, 'account-key'); writeFileSync(keyFile, 'ab'.repeat(32), { mode: 0o600 });
  const config = { ...f.config, sso: { accountTable: 'Accounts', keyFile, apiUri: 'api://gateway', connectionName: 'workiq' } };
  const accountBinding = { account: 'example123', table: 'Accounts', appId: target.config.scope.appId, tenantId: target.config.scope.tenantId };
  const authority = { allowed: () => true, revalidate: async () => true, lost: new AbortController().signal };
  const openAccounts = () => createAccountStore(accountBinding, Buffer.from('ab'.repeat(32), 'hex'), f.accounts.dependencies, authority);
  const accounts = openAccounts();
  try {
    const challenge = await accounts.challenge({ objectId: oid }, converted.event.contextId, 'signin', accountContext());
    assert.equal(await accounts.claim(challenge, accountContext()), 'claimed');
    assert.equal(await accounts.complete(challenge, { accessToken: 'synthetic-private-workiq', expiresAt: Date.now() + 3600000 }, accountContext()), true);
  } finally { await accounts.close(); }
  let posts = 0;
  const upstream = await httpsFixture(t, (req, res) => {
    posts++; req.resume(); res.writeHead(202); res.end(JSON.stringify({ status: 'accepted', eventId: converted.event.externalEventId, state: 'Queued' }));
  });
  const native = https.request;
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: any) => url.hostname === 'orka.example.invalid' ?
    native(new URL(url.pathname, upstream.baseUrl), { ...options, ca: upstream.ca, servername: 'localhost' }, callback) : native(url, options, callback));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const held = deferred(); const entered = deferred(); let waiting = false;
  f.accounts.controls.hook = async ({ req, url, reply }) => {
    if (!waiting && req.method === 'GET' && decodeURIComponent(url.href).includes('grant_')) {
      waiting = true; entered.resolve(); await held.promise;
    }
    reply();
  };
  const { botToken: _notUsed, ...base } = graph.deps;
  const runtime = await startRegistryRuntime(config, { ...base,
    managedIdentity: { acaRequest: f.identity.request, entraNetwork: entraNetwork() } });
  t.after(async () => { held.resolve(); await runtime.stop().catch(() => {}); });
  await entered.promise;
  // The SDK path gives this duplicate a fresh opaque candidate, never the stored reply target.
  const response = await post(runtime.port, f.auth.token(), message);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'duplicate' });
  assert.equal([...f.accounts.rows.values()].filter(r => String(r.RowKey).startsWith('grant_')).length, 1);
  held.resolve();
  const stored = () => [...f.domains[0]!.service.rows.values()].filter(r => r.T === 'event').map(payload)[0]!;
  await eventually(() => ['blocked', 'terminal'].includes(stored().state));
  assert.equal(stored().replyTarget, 'original-pre-sso-reply-target');
  assert.equal(stored().state, 'blocked'); assert.equal(stored().reason, 'invalid-event'); assert.equal(posts, 0);
  await runtime.stop(); await runtime.done;
  const reopened = openAccounts();
  try {
    const registered = snapshotRegistry(config).targets[0]!;
    const originalRef = grantReference(target.config.scope, registered, converted.event.externalEventId, converted.event.replyTarget!);
    assert.equal(await reopened.getGrant(originalRef, accountContext()), undefined);
  } finally { await reopened.close(); }
});

test('native registry SSO stores only ciphertext, authenticates invokes, survives restart and disconnects without replaying old work', async t => {
  const f = await fixture(t); const graph = await policyFixture(t, f); const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const oid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const keyFile = join(f.files, 'account-key');
  writeFileSync(keyFile, 'ab'.repeat(32), { mode: 0o600 });
  for (const target of f.config.targets) { target.config.receiver = { ...miConfig, managedIdentityHost: 'azure-container-apps' }; Object.assign(target, { taskPassToken: `controller-${target.id}` }); }
  const config = { ...f.config, sso: { accountTable: 'Accounts', keyFile, apiUri: 'api://gateway', connectionName: 'workiq' } };
  let obo = 0; const workiq = await httpsFixture(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body); assert.equal(form.get('scope'), WORK_IQ_SCOPE); assert.equal(form.has('client_secret'), false);
    assert.equal(form.get('requested_token_use'), 'on_behalf_of'); obo++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'synthetic-private-workiq', expires_in: 3600, token_type: 'Bearer', scope: WORK_IQ_SCOPE }));
  });
  let toolCalls = 0;
  const tool = await httpsFixture(t, async (req, res) => {
    assert.equal(req.url, '/a2a/'); assert.equal(req.headers.authorization, 'Bearer synthetic-private-workiq');
    let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text); toolCalls++;
    assert.equal(body.method, 'SendMessage'); assert.equal(body.params.message.parts[0].text, 'fixture question');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { task: {
      status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: 'fixture answer' }] }] } } }));
  });
  const native = https.request; const sent: { url: string; body: string }[] = []; const events: string[] = [];
  const upstream = await httpsFixture(t, async (req, res) => { let text = ''; for await (const chunk of req) text += chunk;
    events.push(text); const event = JSON.parse(text); res.writeHead(202); res.end(JSON.stringify({ status: 'accepted', eventId: event.externalEventId, state: 'Queued' })); });
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: any) => url.hostname === 'orka.example.invalid' ?
    native(new URL(url.pathname, upstream.baseUrl), { ...options, ca: upstream.ca, servername: 'localhost' }, callback) : native(url, options, callback));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { botToken: _notUsed, ...base } = graph.deps;
  const deps: RegistryRuntimeDependencies = { ...base,
    managedIdentity: { acaRequest: f.identity.request, entraNetwork: entraNetwork() },
    delegatedKeys: async () => new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'sso', alg: 'RS256', use: 'sig' }] })),
    workiqRequest: ((url: URL, options: https.RequestOptions, cb: any) => {
      assert.equal(url.href, 'https://workiq.svc.cloud.microsoft/a2a/');
      return native(new URL(url.pathname, tool.baseUrl), { ...options, ca: tool.ca, servername: 'localhost' }, cb);
    }) as typeof https.request,
    delegatedRequest: ((url: URL, options: https.RequestOptions, cb: any) => {
      assert.equal(url.href, `https://login.microsoftonline.com/${miConfig.tenantId}/oauth2/v2.0/token`);
      return native(new URL('/token', workiq.baseUrl), { ...options, ca: workiq.ca, servername: 'localhost' }, cb);
    }) as typeof https.request,
    providerPost: async (url, bytes) => { sent.push({ url, body: bytes.toString() }); return { status: 201, data: Buffer.from('{"id":"sso-receipt"}') }; } };
  let runtime = await startRegistryRuntime(config, deps); t.after(() => runtime.stop().catch(() => {}));
  const message = activity(); message.from.aadObjectId = oid;
  message.id = 'connect-sso'; message.text = 'use primary'; assert.equal((await post(runtime.port, f.auth.token(), message)).status, 200);
  message.id = 'work-sso'; message.text = 'do work'; assert.equal((await post(runtime.port, f.auth.token(), message)).status, 200);
  assert.equal(events.length, 0); assert.equal(obo, 0); const card = JSON.parse(sent.at(-1)!.body);
  assert.equal(card.attachments[0].contentType, 'application/vnd.microsoft.card.oauth');
  const id = card.attachments[0].content.tokenExchangeResource.id;
  const token = (objectId: string) => jwt.sign({ tid: miConfig.tenantId, oid: objectId, scp: 'access_as_user', aud: miConfig.appId,
    iss: `https://login.microsoftonline.com/${miConfig.tenantId}/v2.0`, exp: Math.floor(Date.now() / 1000) + 3600 }, pair.privateKey, { algorithm: 'RS256', keyid: 'sso' });
  const invoke = { ...message, type: 'invoke', name: 'signin/tokenExchange', value: { id, connectionName: 'workiq', token: token(miConfig.appId) } };
  const before = f.accounts.rows.size; let result = await post(runtime.port, f.auth.token(), invoke);
  assert.equal(result.status, 412); assert.equal(obo, 0); assert.equal(f.accounts.rows.size, before);
  invoke.value.token = token(oid); result = await post(runtime.port, f.auth.token(), invoke);
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { id, connectionName: 'workiq' });
  assert.equal(obo, 1); assert.equal(events.length, 0); assert.match(sent.at(-1)!.body, /Send your request again/);
  await post(runtime.port, f.auth.token(), invoke); assert.equal(obo, 1);
  const notifications = sent.length; await post(runtime.port, f.auth.token(), message); assert.equal(sent.length, notifications); assert.equal(events.length, 0);
  await runtime.stop(); await runtime.done; runtime = await startRegistryRuntime(config, deps);
  await post(runtime.port, f.auth.token(), invoke); assert.equal(obo, 1); assert.equal(sent.length, notifications);
  message.id = 'fresh-work'; await post(runtime.port, f.auth.token(), message); await eventually(() => events.length === 1);
  const delegatedEvent = JSON.parse(events[0]!); assert.equal(delegatedEvent.eventType, 'delegatedText'); assert.match(delegatedEvent.metadata.gatewayGrantRef, /^[a-f0-9]{64}$/);
  const controller = async (path: string, token: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${runtime.outboundPort}${path}`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const passBody = { protocolVersion: 'orka.gateway.v1', grantRef: delegatedEvent.metadata.gatewayGrantRef,
    namespaceUID: 'namespace-uid', gatewayUID: 'gateway-uid', taskUID: 'root-task', tools: ['workiq'], deadline: new Date(Date.now() + 120000).toISOString() };
  const issued = await controller('/v1/task-passes', 'controller-primary', passBody); assert.equal(issued.status, 200);
  assert.deepEqual(await controller('/v1/task-tools/workiq', issued.body.pass, { question: 'fixture question' }), { status: 200, body: { text: 'fixture answer' } });
  assert.equal(toolCalls, 1);
  const pendingPass = (await controller('/v1/task-passes', 'controller-primary', passBody)).body.pass;
  message.id = 'wrong-sender'; message.from.aadObjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await post(runtime.port, f.auth.token(), message); assert.equal(events.length, 1); message.from.aadObjectId = oid;
  message.id = 'disconnect-sso'; message.text = 'disconnect'; await post(runtime.port, f.auth.token(), message);
  assert.match(sent.at(-1)!.body, /disconnected/);
  assert.notEqual((await controller('/v1/task-tools/workiq', pendingPass, { question: 'fixture question' })).status, 200); assert.equal(toolCalls, 1);
  message.id = 'after-disconnect'; message.text = 'do more work'; await post(runtime.port, f.auth.token(), message);
  assert.match(sent.at(-1)!.body, /card.oauth/); assert.equal(events.length, 1);
  const external = JSON.stringify({ sent, events, directory: [...f.directory.rows.values()], inbox: f.domains.map(d => [...d.service.rows.values()]) });
  assert.equal(external.includes('synthetic-private-workiq'), false); assert.equal(external.includes(invoke.value.token), false);
  for (const row of f.accounts.rows.values()) { const payload = Buffer.from(String(row.Payload), 'base64').toString();
    assert.equal(payload.includes('synthetic-private-workiq'), false); assert.equal(payload.includes(invoke.value.token), false); }
});

test('native registry wires optional GitHub custody and checks its secret before ownership', async t => {
  const f = await fixture(t, true, 1); const graph = await policyFixture(t, f);
  const { githubFixture } = await import('./support/github.js'); const remote = await githubFixture(t);
  const { toolsFixture } = await import('./support/github-tools.js'); const api = await toolsFixture(t);
  const keyFile = join(f.files, 'account-key'); const clientSecretFile = join(f.files, 'github-secret');
  writeFileSync(keyFile, 'ab'.repeat(32), { mode: 0o600 });
  for (const target of f.config.targets) { target.config.receiver = { ...miConfig, managedIdentityHost: 'azure-container-apps' }; Object.assign(target, { taskPassToken: `controller-${target.id}` }); }
  const origin = 'https://signin.example.invalid';
  const config = { ...f.config, sso: { accountTable: 'Accounts', keyFile, apiUri: 'api://gateway', connectionName: 'workiq', publicOrigin: origin },
    github: { clientId: 'Iv1.synthetic', clientSecretFile } };
  const { botToken: _notUsed, ...base } = graph.deps; let tableCalls = 0;
  const refusedDeps = { ...base, tableRequest: (() => { tableCalls++; throw new Error('must not own storage'); }) as typeof https.request };
  for (const secret of ['', 'bad\nsecret', 'ingress-primary', 'callback-primary', 'controller-primary', 'ab'.repeat(32)]) {
    writeFileSync(clientSecretFile, secret, { mode: 0o600 }); await assert.rejects(startRegistryRuntime(config, refusedDeps));
  }
  assert.equal(tableCalls, 0); writeFileSync(clientSecretFile, 'CLIENT_PRIVATE');
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048 }); let nonce = ''; const oid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const microsoft = await httpsFixture(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const form = new URLSearchParams(body);
    assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('redirect_uri'), origin + '/oauth/callback');
    const id_token = jwt.sign({ tid: miConfig.tenantId, oid, aud: miConfig.appId, nonce, exp: Math.floor(Date.now() / 1000) + 3600,
      iss: `https://login.microsoftonline.com/${miConfig.tenantId}/v2.0` }, signing.privateKey, { algorithm: 'RS256', keyid: 'github-runtime' });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: 'MS_ACCESS_PRIVATE', refresh_token: 'MS_REFRESH_PRIVATE', token_type: 'Bearer', expires_in: 3600, scope: WORK_IQ_SCOPE, id_token }));
  });
  const sent: string[] = []; const native = https.request;
  const deps: RegistryRuntimeDependencies = { ...base, githubRequest: ((url: URL, options: https.RequestOptions, cb: Parameters<typeof https.request>[2]) =>
    url.pathname.startsWith('/repos/') ? api.request(url, options, cb!) : remote.request(url, options, cb!)) as typeof https.request,
    managedIdentity: { acaRequest: f.identity.request, entraNetwork: entraNetwork() },
    delegatedKeys: async () => new Response(JSON.stringify({ keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'github-runtime', alg: 'RS256', use: 'sig' }] })),
    delegatedRequest: ((url: URL, options: https.RequestOptions, cb: Parameters<typeof https.request>[2]) => {
      assert.equal(url.href, `https://login.microsoftonline.com/${miConfig.tenantId}/oauth2/v2.0/token`);
      return native(new URL(url.pathname, microsoft.baseUrl), { ...options, ca: microsoft.ca, servername: 'localhost' }, cb!);
    }) as typeof https.request,
    providerPost: async (_url, bytes) => { sent.push(bytes.toString()); return { status: 201, data: Buffer.from('{"id":"receipt"}') }; } };
  let runtime = await startRegistryRuntime(config, deps); t.after(() => runtime.stop().catch(() => {}));
  const message = activity(); message.from.aadObjectId = oid; message.id = 'connect-github'; message.text = 'use primary';
  assert.equal((await post(runtime.port, f.auth.token(), message)).status, 200);
  message.id = 'link-github'; message.text = 'link github'; assert.equal((await post(runtime.port, f.auth.token(), message)).status, 200);
  const root = `http://127.0.0.1:${runtime.port}`; const button = new URL(JSON.parse(sent.at(-1)!).attachments[0].content.buttons[0].value);
  const start = await fetch(root + button.pathname + button.search, { redirect: 'manual' }); await start.text(); assert.equal(start.status, 302);
  const ms = new URL(start.headers.get('location')!); nonce = ms.searchParams.get('nonce')!;
  const proof = await fetch(root + '/oauth/callback', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: ms.searchParams.get('state')!, code: 'MS_CODE_PRIVATE' }).toString() }); await proof.text(); assert.equal(proof.status, 302);
  const github = new URL(proof.headers.get('location')!); const cookie = proof.headers.get('set-cookie')!.split(';')[0]!;
  const complete = await fetch(root + '/github/callback?' + new URLSearchParams({ state: github.searchParams.get('state')!, code: 'GH_CODE_PRIVATE' }), { headers: { cookie } });
  assert.equal(complete.status, 200); await complete.text(); assert.equal(remote.requests.length, 2);
  await runtime.stop(); await runtime.done;
  // Seed the controller fixture's admitted authority through public APIs only, with all owners stopped.
  const target = snapshotRegistry(config).targets[0]!; const seed = createAccountStore({ account: target.config.storage.account, table: 'Accounts',
    appId: miConfig.appId, tenantId: miConfig.tenantId }, Buffer.from('ab'.repeat(32), 'hex'), f.accounts.dependencies, { allowed: () => true });
  const ch = await seed.challenge({ objectId: oid }, 'chat-private', 'workiq', accountContext()); await seed.claim(ch, accountContext());
  await seed.complete(ch, { accessToken: 'MS_ACCESS_PRIVATE', refreshToken: 'MS_REFRESH_PRIVATE', expiresAt: Date.now() + 600000 }, accountContext());
  const tools = ['workiq', 'github-read-file', 'github-list-issues', 'github-create-issue', 'github-create-pull-request'];
  const ref = grantReference(target.config.scope, target, 'event-github-tools', 'reply-github-tools');
  await seed.reserveGrant({ ref, objectId: oid, provider: 'workiq', generation: 1, githubGeneration: 2, targetId: target.id,
    targetDigest: target.identityDigest!, eventId: 'event-github-tools', tools }, accountContext()); await seed.close();
  const passBody = { protocolVersion: 'orka.gateway.v1', grantRef: ref, namespaceUID: 'namespace', gatewayUID: target.gatewayUid, taskUID: 'task', tools,
    deadline: new Date(Date.now() + 60000).toISOString() };
  const execute = async () => {
    const issued = await fetch(`http://127.0.0.1:${runtime.outboundPort}/v1/task-passes`, { method: 'POST', headers: {
      authorization: 'Bearer controller-primary', 'content-type': 'application/json' }, body: JSON.stringify(passBody) });
    assert.equal(issued.status, 200); const pass = await issued.json() as { pass: string };
    const result = await fetch(`http://127.0.0.1:${runtime.outboundPort}/v1/task-tools/github-create-issue`, { method: 'POST', headers: {
      authorization: 'Bearer ' + pass.pass, 'content-type': 'application/json', 'Idempotency-Key': 'runtime-operation' },
    body: JSON.stringify({ owner: 'acme', repo: 'repo', title: 'Reviewed issue' }) });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { text: '{"number":8,"url":"https://github.com/acme/repo/issues/8"}' });
  };
  runtime = await startRegistryRuntime(config, deps); await execute(); assert.equal(api.requests.length, 1);
  await runtime.stop(); await runtime.done; runtime = await startRegistryRuntime(config, deps); await execute(); assert.equal(api.requests.length, 1);
  message.id = 'disconnect-github'; message.text = 'disconnect github'; assert.equal((await post(runtime.port, f.auth.token(), message)).status, 200);
  assert.match(sent.at(-1)!, /GitHub account is disconnected/);
  await runtime.stop(); await runtime.done; assert.equal(remote.sockets(), 0);
  assert.doesNotMatch(JSON.stringify({ sent, directory: [...f.directory.rows.values()], accounts: [...f.accounts.rows.values()] }), /PRIVATE/);
});
