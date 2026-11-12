import assert from 'node:assert/strict';
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
import { randomUUID } from 'node:crypto';
import type { ControlRecord } from '../src/directory/types.js';
import { TestClock } from './support/table-v3.js';
import { payload } from './support/table-ingress-store.js';

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
  const directory = await directoryFixture(t, syntheticToken);
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
  return { config, deps, domains, auth, identity, directory, bindings, kubernetesCalls: () => kubernetesCalls,
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

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const provider = prepareStorageIdentity(f.config.targets[0]!.config.storage.identity).createProvider(f.deps.storageIdentity);
  try { for (const target of f.config.targets) {
    const c = target.config; const inbox = createTableIngressStoreV3({ kind: 'ingress', account: c.storage.account, table: c.storage.table,
      storeId: c.storage.ingressStoreId, scope: c.scope }, { token: provider.token, request: f.deps.tableRequest },
    { audit: c.storage.audit, maxIndexBytes: c.storage.maxIndexBytes, policy: c.policy });
    await inbox.open();
    const event = { ...expectedEvent, contextId: target.id === 'primary' ? expectedEvent.contextId : `${expectedEvent.contextId}-${target.id}` };
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
