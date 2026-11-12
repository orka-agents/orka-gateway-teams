import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingName } from '../src/directory/codec.js';
import { createBindingProvisioner } from '../src/directory/provision.js';
import type { ConnectionRecord } from '../src/directory/types.js';
import { snapshotRegistry } from '../src/registry/config.js';
import { registryInput } from './support/registry.js';

function fixture(chatKind: 'personal' | 'groupChat' = 'personal') {
  const target = snapshotRegistry(registryInput()).targets[0]!; const scope = target.config.scope;
  const connection: ConnectionRecord = { schema: 1, kind: 'conn', scope: { appId: scope.appId, tenantId: scope.tenantId }, conversationId: '19:exact', chatKind,
    targetId: target.id, identityDigest: target.identityDigest!, bindingName: bindingName({ appId: scope.appId, tenantId: scope.tenantId }, '19:exact', target.identityDigest!), lineage: { kind: 'provisioner' }, state: 'reserved' };
  const spec = { gatewayRef: { name: 'teams' }, agentRef: { name: 'front' }, match: { accountId: scope.tenantId, contextId: '19:exact' },
    priority: 0, senderPolicy: { mode: 'all' }, session: { mode: chatKind === 'personal' ? 'context-sender' : 'context' } };
  const gateway: any = { apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'Gateway', metadata: { namespace: 'default', name: 'teams', uid: 'gateway-uid', generation: 1 }, status: { ready: true, observedGeneration: 1 } };
  const agent: any = { apiVersion: 'core.orka.ai/v1alpha1', kind: 'Agent', metadata: { namespace: 'default', name: 'front', uid: 'agent-uid', generation: 1 } };
  let binding: any; let overlaps: any[] = []; let creates = 0; let reads = 0; let readyAfter = 0; let allowed = true;
  let onCreate: (() => void) | undefined; let lost = false;
  const client = {
    async getGateway() { return structuredClone(gateway); }, async getAgent() { return structuredClone(agent); },
    async listBindings() { return structuredClone(overlaps); },
    async getBinding(name: string) { assert.equal(name, connection.bindingName); reads++; if (binding && reads >= readyAfter) binding.status = { ready: true, observedGeneration: 1 }; return structuredClone(binding); },
    async createBinding(value: Record<string, unknown>) {
      creates++; assert.deepEqual(value.spec, spec); binding = { ...structuredClone(value), metadata: { ...(value.metadata as object), uid: 'binding-uid', generation: 1 }, status: {} };
      onCreate?.(); if (lost) throw new Error('lost ACK'); return { kind: 'ack' as const };
    },
  };
  const provisioner = createBindingProvisioner(target, client);
  return { target, connection, spec, gateway, agent, provisioner, creates: () => creates, reads: () => reads,
    context: (ms = 2000) => ({ signal: new AbortController().signal, deadline: performance.now() + ms, allowed: () => allowed }),
    revoke() { allowed = false; }, afterCreate(fn: () => void) { onCreate = fn; }, loseAck() { lost = true; }, readyAfter(n: number) { readyAfter = n; },
    overlap(value: any[]) { overlaps = value; }, binding: () => binding, setBinding(value: any) { binding = value; readyAfter = Infinity; } };
}
for (const kind of ['personal', 'groupChat'] as const) test(`new ${kind} Binding is read back with current readiness and exact spec`, async () => {
  const f = fixture(kind); const evidence = await f.provisioner.reconcile(f.connection, f.context());
  assert.equal(f.creates(), 1); assert.equal(evidence.uid, 'binding-uid'); assert.equal(evidence.generation, 1); assert.deepEqual(evidence.spec, f.spec);
  const saved = { ...f.connection, state: 'provisioned' as const, binding: evidence };
  assert.deepEqual(await f.provisioner.check(saved, f.context()), evidence); assert.equal(f.creates(), 1);
});
test('lost create ACK reconciles deterministic truth, waits for asynchronous readiness', async () => {
  const f = fixture(); f.loseAck(); f.readyAfter(3);
  assert.equal((await f.provisioner.reconcile(f.connection, f.context())).uid, 'binding-uid'); assert.equal(f.creates(), 1); assert.ok(f.reads() >= 3);
});
test('not-ready status expires within original deadline without granting evidence', async () => {
  const f = fixture(); f.readyAfter(Infinity);
  await assert.rejects(f.provisioner.reconcile(f.connection, f.context(140)), { category: 'target-paused' }); assert.equal(f.creates(), 1);
});
// Missing readiness, immutable evidence checks or overlap checks would let a changed route authorize forwarding.
for (const fault of ['gateway-uid', 'gateway-stale', 'agent', 'overlap-before', 'overlap-after', 'binding-uid', 'binding-spec', 'binding-generation', 'marker', 'missing'] as const)
  test(`current Binding check refuses ${fault} without create/repair`, async () => {
    const f = fixture(); const binding = await f.provisioner.reconcile(f.connection, f.context());
    const saved: ConnectionRecord = { ...f.connection, state: 'provisioned', binding };
    if (fault === 'gateway-uid') f.gateway.metadata.uid = 'replacement';
    if (fault === 'gateway-stale') f.gateway.status.observedGeneration = 0;
    if (fault === 'agent') f.agent.metadata.name = 'other';
    if (fault === 'binding-uid') f.binding().metadata.uid = 'replacement';
    if (fault === 'binding-spec') f.binding().spec.priority = 1;
    if (fault === 'binding-generation') f.binding().metadata.generation = 2;
    if (fault === 'marker') f.binding().metadata.annotations['gateway.orka.ai/teams-target-digest'] = 'foreign';
    if (fault === 'missing') f.setBinding(undefined);
    if (fault.startsWith('overlap')) f.overlap([{ apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'GatewayBinding', metadata: { name: 'foreign', namespace: 'default' },
      spec: { gatewayRef: { name: 'teams' }, match: { accountId: f.connection.scope.tenantId, contextId: '19:exact', senderId: 'someone-else' }, priority: 999 }, status: { ready: false } }]);
    await assert.rejects(f.provisioner.check(saved, f.context(140))); assert.equal(f.creates(), 1);
  });
test('foreign overlap refuses first create; overlap introduced during create refuses readiness', async () => {
  for (const late of [false, true]) {
    const f = fixture(); const overlap = [{ kind: 'GatewayBinding', apiVersion: 'gateway.orka.ai/v1alpha1', metadata: { name: 'foreign', namespace: 'default' },
      spec: { gatewayRef: { name: 'teams' }, match: { accountId: f.connection.scope.tenantId, contextId: '19:exact' } } }];
    if (late) f.afterCreate(() => f.overlap(overlap)); else f.overlap(overlap);
    await assert.rejects(f.provisioner.reconcile(f.connection, f.context()), { category: 'binding-conflict' }); assert.equal(f.creates(), late ? 1 : 0);
  }
});
test('authority loss after create leaves only remote progress and cannot publish evidence', async () => {
  const f = fixture(); f.afterCreate(() => f.revoke());
  await assert.rejects(f.provisioner.reconcile(f.connection, f.context()), { category: 'target-paused' }); assert.equal(f.creates(), 1);
});
test('imported nondefault spec is compared intact and never fabricated as owned or recreated', async () => {
  const f = fixture(); const spec = { ...f.spec, priority: -30, senderPolicy: { mode: 'allowlist', allowedSenderIds: ['29:original'] }, taskDefaults: { retryPolicy: { backoffMultiplier: 1.5 } } };
  const evidence = { namespace: 'default', name: f.connection.bindingName, uid: 'imported-uid', generation: 7, spec };
  const imported: ConnectionRecord = { ...f.connection, lineage: { kind: 'imported', importId: 'reviewed-import' }, state: 'provisioned', binding: evidence };
  f.setBinding({ apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'GatewayBinding', metadata: { namespace: 'default', name: f.connection.bindingName, uid: 'imported-uid', generation: 7 }, spec, status: { ready: true, observedGeneration: 7 } });
  assert.deepEqual(await f.provisioner.check(imported, f.context()), evidence); assert.equal(f.creates(), 0);
  f.setBinding(undefined); await assert.rejects(f.provisioner.reconcile(imported, f.context()), { category: 'binding-conflict' }); assert.equal(f.creates(), 0);
});
test('cross-target, cancelled, expired and unprovisioned check cannot start Kubernetes work', async () => {
  const f = fixture();
  await assert.rejects(f.provisioner.reconcile({ ...f.connection, targetId: 'tools' }, f.context()), { category: 'binding-conflict' });
  await assert.rejects(f.provisioner.check(f.connection, f.context()), { category: 'binding-conflict' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.provisioner.reconcile(f.connection, { ...f.context(), signal: abort.signal }));
  await assert.rejects(f.provisioner.reconcile(f.connection, f.context(-1))); assert.equal(f.reads(), 0); assert.equal(f.creates(), 0);
});
