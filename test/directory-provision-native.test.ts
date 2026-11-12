import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bindingName } from '../src/directory/codec.js';
import { createBindingProvisioner } from '../src/directory/provision.js';
import { openDirectory } from '../src/directory/store.js';
import type { ConnectionRecord } from '../src/directory/types.js';
import { snapshotRegistry } from '../src/registry/config.js';
import { createKubernetesReader } from '../src/registry/kubernetes.js';
import { memoryDirectoryTable } from './support/directory-memory.js';
import { httpsFixture } from './support/ingress-https.js';
import { registryInput } from './support/registry.js';

for (const mode of ['ack', 'lost', 'conflict', 'lie', 'foreign', 'revoked'] as const) test(`native ${mode} create grants only freshly verified directory Binding evidence`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'binding-native-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token'); writeFileSync(tokenFile, JSON.stringify({ token: 'synthetic-only', expiresAt: new Date(Date.now() + 3600000).toISOString() }), { mode: 0o600 });
  const target = snapshotRegistry({ ...registryInput(), targets: registryInput().targets.map(value => ({ ...value, kubernetesTokenFile: tokenFile })) }).targets[0]!;
  const scope = { appId: target.config.scope.appId, tenantId: target.config.scope.tenantId };
  const connection: ConnectionRecord = { schema: 1, kind: 'conn', scope, conversationId: '19:native', chatKind: 'groupChat', targetId: target.id,
    identityDigest: target.identityDigest!, bindingName: bindingName(scope, '19:native', target.identityDigest!), state: 'reserved', lineage: { kind: 'provisioner' } };
  const expectedSpec = { gatewayRef: { name: 'teams' }, agentRef: { name: 'front' }, match: { accountId: scope.tenantId, contextId: '19:native' },
    priority: 0, senderPolicy: { mode: 'all' }, session: { mode: 'context' } };
  const root = '/apis/gateway.orka.ai/v1alpha1/namespaces/default';
  let binding: any; let posts = 0; let requests = 0; let closes = 0; let allowed = true;
  const server = await httpsFixture(t, async (req, res) => {
    requests++; assert.equal(req.headers.authorization === 'Bearer synthetic-only', true);
    if (req.method === 'POST') {
      assert.equal(req.url, `${root}/gatewaybindings`); posts++;
      let body = ''; for await (const chunk of req) body += chunk;
      const value = JSON.parse(body); assert.deepEqual(value.spec, expectedSpec);
      assert.deepEqual(value.metadata.annotations, { 'gateway.orka.ai/teams-target-digest': target.identityDigest, 'gateway.orka.ai/teams-gateway-uid': 'gateway-uid' });
      assert.equal(value.metadata.ownerReferences, undefined);
      if (mode !== 'lie') binding = { ...value, metadata: { ...value.metadata, uid: 'native-binding-uid', generation: 1 }, status: { ready: true, observedGeneration: 1 } };
      if (mode === 'foreign') binding.spec.priority = 999;
      if (mode === 'revoked') allowed = false;
      if (mode === 'lost') { req.socket.destroy(); return; }
      res.writeHead(mode === 'conflict' ? 409 : 201); res.end('{}'); return;
    }
    let value: unknown;
    if (req.url === `${root}/gateways/teams`) value = { apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'Gateway', metadata: { namespace: 'default', name: 'teams', uid: 'gateway-uid', generation: 2 }, status: { ready: true, observedGeneration: 2 } };
    else if (req.url === '/apis/core.orka.ai/v1alpha1/namespaces/default/agents/front') value = { apiVersion: 'core.orka.ai/v1alpha1', kind: 'Agent', metadata: { namespace: 'default', name: 'front' } };
    else if (req.url === `${root}/gatewaybindings?limit=100`) value = { apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'GatewayBindingList', metadata: {}, items: binding ? [binding] : [] };
    else if (req.url === `${root}/gatewaybindings/${connection.bindingName}`) value = binding;
    else assert.fail('Unexpected Kubernetes destination');
    res.writeHead(value ? 200 : 404); res.end(JSON.stringify(value ?? {}));
  });
  const request = ((url: URL, options: https.RequestOptions, callback: any) => {
    assert.equal(url.origin, 'https://kubernetes.example.invalid'); assert.equal(options.rejectUnauthorized, true);
    const pending = https.request(new URL(url.pathname + url.search, server.baseUrl), { ...options, ca: server.ca, servername: 'localhost' }, callback);
    pending.once('close', () => closes++); return pending;
  }) as typeof https.request;
  const client = createKubernetesReader(target, { request }); t.after(() => client.close());
  const context = { signal: new AbortController().signal, deadline: performance.now() + 3000, allowed: () => allowed, authorizeWrite: () => allowed };
  const table = memoryDirectoryTable(); const store = await openDirectory(table.table, context, { allowed: () => allowed }); t.after(() => store.close());
  const reserved = await store.reserveConnection(connection, context); const provisioner = createBindingProvisioner(target, client);
  if (mode === 'lie' || mode === 'foreign' || mode === 'revoked') {
    await assert.rejects(provisioner.reconcile(reserved, context), { category: mode === 'foreign' ? 'binding-conflict' : 'target-paused' });
    assert.equal([...table.rows.values()][0]!.value.state, 'reserved');
  } else {
    const evidence = await provisioner.reconcile(reserved, context); const saved = await store.markProvisioned(reserved, evidence, context);
    assert.equal(saved.state, 'provisioned'); assert.deepEqual(evidence.spec, expectedSpec);
    assert.equal((await provisioner.check(saved, context)).uid, 'native-binding-uid');
    binding.spec.priority = 1; await assert.rejects(provisioner.check(saved, context), { category: 'binding-conflict' });
  }
  assert.equal(posts, 1); await client.close(); assert.equal(closes, requests);
});
