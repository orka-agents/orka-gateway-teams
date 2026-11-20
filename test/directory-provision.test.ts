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
    targetId: target.id, identityDigest: target.identityDigest!, bindingName: bindingName({ appId: scope.appId, tenantId: scope.tenantId }, '19:exact', target.identityDigest!), state: 'reserved' };
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
test('cross-target, cancelled, expired and unprovisioned check cannot start Kubernetes work', async () => {
  const f = fixture();
  await assert.rejects(f.provisioner.reconcile({ ...f.connection, targetId: 'tools' }, f.context()), { category: 'binding-conflict' });
  await assert.rejects(f.provisioner.check(f.connection, f.context()), { category: 'binding-conflict' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.provisioner.reconcile(f.connection, { ...f.context(), signal: abort.signal }));
  await assert.rejects(f.provisioner.reconcile(f.connection, f.context(-1))); assert.equal(f.reads(), 0); assert.equal(f.creates(), 0);
});

// Orka names a session by Binding UID: a later epoch must be a new, outranking Binding beside the old one.
test('a later epoch creates its own higher-priority Binding and leaves the earlier one untouched', async () => {
  const target = snapshotRegistry(registryInput()).targets[0]!; const s = target.config.scope; const scope = { appId: s.appId, tenantId: s.tenantId };
  const name = (epoch: number) => bindingName(scope, '19:exact', target.identityDigest!, epoch);
  const spec = (priority: number) => ({ gatewayRef: { name: 'teams' }, agentRef: { name: 'front' }, match: { accountId: s.tenantId, contextId: '19:exact' },
    priority, senderPolicy: { mode: 'all' }, session: { mode: 'context-sender' } });
  const annotations = { 'gateway.orka.ai/teams-target-digest': target.identityDigest, 'gateway.orka.ai/teams-gateway-uid': target.gatewayUid };
  const bindings = new Map<string, any>([[name(0), { apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'GatewayBinding',
    metadata: { namespace: 'default', name: name(0), uid: 'uid-0', generation: 1, annotations }, spec: spec(0), status: { ready: true, observedGeneration: 1 } }]]);
  const original = structuredClone(bindings.get(name(0)));
  const agent = { apiVersion: 'core.orka.ai/v1alpha1', kind: 'Agent', metadata: { namespace: 'default', name: 'front', uid: 'agent-uid', generation: 7 } };
  const provisioner = createBindingProvisioner(target, {
    async getGateway() { return { apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'Gateway', metadata: { namespace: 'default', name: 'teams', uid: target.gatewayUid, generation: 1 }, status: { ready: true, observedGeneration: 1 } }; },
    async getAgent() { return structuredClone(agent); }, async listBindings() { return structuredClone([...bindings.values()]); },
    async getBinding(n: string) { return structuredClone(bindings.get(n)); },
    async createBinding(value: any) { bindings.set(value.metadata.name, { ...structuredClone(value), metadata: { ...value.metadata, uid: 'uid-1', generation: 1 }, status: { ready: true, observedGeneration: 1 } }); return { kind: 'ack' as const }; },
  });
  const context = { signal: new AbortController().signal, deadline: performance.now() + 2000, allowed: () => true };
  assert.deepEqual(await provisioner.revision(context), { uid: 'agent-uid', generation: 7 });
  const next: ConnectionRecord = { schema: 1, kind: 'conn', scope, conversationId: '19:exact', chatKind: 'personal', targetId: target.id,
    identityDigest: target.identityDigest!, bindingName: name(1), epoch: 1, state: 'reserved' };
  const evidence = await provisioner.reconcile(next, context);
  assert.deepEqual([evidence.name, evidence.uid, evidence.spec], [name(1), 'uid-1', spec(1)]);
  assert.deepEqual(bindings.get(name(0)), original);
  // A move that stopped before its directory write leaves the next epoch beside the current one: still checkable, then adoptable.
  const { epoch: _epoch, ...base } = next;
  const first: ConnectionRecord = { ...base, bindingName: name(0), state: 'provisioned', binding: { namespace: 'default', name: name(0), uid: 'uid-0', generation: 1, spec: spec(0) } };
  assert.equal((await provisioner.check(first, context)).uid, 'uid-0');
  assert.equal((await provisioner.reconcile(next, context)).uid, 'uid-1');
  // A sibling name is trusted only with the exact spec and markers this gateway would create.
  bindings.get(name(1)).spec.priority = 1000; await assert.rejects(provisioner.check(first, context), { category: 'binding-conflict' });
  bindings.get(name(1)).spec.priority = 1; bindings.get(name(1)).metadata.annotations = {};
  await assert.rejects(provisioner.check(first, context), { category: 'binding-conflict' });
  bindings.set(name(2), { ...structuredClone(bindings.get(name(0))), metadata: { ...bindings.get(name(0)).metadata, name: name(2) }, spec: spec(2) });
  bindings.get(name(1)).metadata.annotations = annotations;
  await assert.rejects(provisioner.check(first, context), { category: 'binding-conflict' }, 'two epochs ahead is not a stopped move');
});

// Orka cancels a Task, and its children, at the Binding's timeout (30m by default).
test('a target task timeout goes on the next epoch\'s Binding; earlier epochs without it stay trusted', async () => {
  const input = registryInput(); (input.targets[0] as Record<string, unknown>).taskTimeout = '75m';
  const target = snapshotRegistry(input).targets[0]!; const s = target.config.scope; const scope = { appId: s.appId, tenantId: s.tenantId };
  const name = (epoch: number) => bindingName(scope, '19:exact', target.identityDigest!, epoch);
  const spec = (priority: number) => ({ gatewayRef: { name: 'teams' }, agentRef: { name: 'front' }, match: { accountId: s.tenantId, contextId: '19:exact' },
    priority, senderPolicy: { mode: 'all' }, session: { mode: 'context-sender' } });
  const annotations = { 'gateway.orka.ai/teams-target-digest': target.identityDigest, 'gateway.orka.ai/teams-gateway-uid': target.gatewayUid };
  const bindings = new Map<string, any>([[name(0), { apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'GatewayBinding',
    metadata: { namespace: 'default', name: name(0), uid: 'uid-0', generation: 1, annotations }, spec: spec(0), status: { ready: true, observedGeneration: 1 } }]]);
  const original = structuredClone(bindings.get(name(0)));
  const provisioner = createBindingProvisioner(target, {
    async getGateway() { return { apiVersion: 'gateway.orka.ai/v1alpha1', kind: 'Gateway', metadata: { namespace: 'default', name: 'teams', uid: target.gatewayUid, generation: 1 }, status: { ready: true, observedGeneration: 1 } }; },
    async getAgent() { return { apiVersion: 'core.orka.ai/v1alpha1', kind: 'Agent', metadata: { namespace: 'default', name: 'front', uid: 'agent-uid', generation: 2 } }; },
    async listBindings() { return structuredClone([...bindings.values()]); }, async getBinding(n: string) { return structuredClone(bindings.get(n)); },
    async createBinding(value: any) { bindings.set(value.metadata.name, { ...structuredClone(value), metadata: { ...value.metadata, uid: 'uid-1', generation: 1 }, status: { ready: true, observedGeneration: 1 } }); return { kind: 'ack' as const }; },
  });
  const context = { signal: new AbortController().signal, deadline: performance.now() + 2000, allowed: () => true };
  const base = { schema: 1 as const, kind: 'conn' as const, scope, conversationId: '19:exact', chatKind: 'personal' as const, targetId: target.id, identityDigest: target.identityDigest! };
  // The chat's current Binding was created before the timeout was configured: it is checked against its recorded spec.
  const first: ConnectionRecord = { ...base, bindingName: name(0), state: 'provisioned', binding: { namespace: 'default', name: name(0), uid: 'uid-0', generation: 1, spec: spec(0) } };
  assert.equal((await provisioner.check(first, context)).uid, 'uid-0');
  const evidence = await provisioner.reconcile({ ...base, bindingName: name(1), epoch: 1, state: 'reserved' }, context);
  assert.deepEqual(evidence.spec, { ...spec(1), taskDefaults: { timeout: '75m' } });
  assert.deepEqual(bindings.get(name(0)), original);
  const second: ConnectionRecord = { ...base, bindingName: name(1), epoch: 1, state: 'provisioned', binding: { namespace: 'default', name: name(1), uid: 'uid-1', generation: 1, spec: evidence.spec } };
  assert.equal((await provisioner.check(second, context)).uid, 'uid-1');
  // A Binding whose timeout changed after it was recorded is still a conflict.
  bindings.get(name(1)).spec.taskDefaults.timeout = '24h';
  await assert.rejects(provisioner.check(second, context), { category: 'binding-conflict' });
  // A move interrupted before its directory write, then retried after the timeout was configured, adopts the Binding it created.
  bindings.delete(name(1)); bindings.set(name(1), { ...structuredClone(original), metadata: { ...original.metadata, name: name(1), uid: 'uid-1' }, spec: spec(1) });
  const adopted = await provisioner.reconcile({ ...base, bindingName: name(1), epoch: 1, state: 'reserved' }, context);
  assert.deepEqual([adopted.uid, adopted.spec], ['uid-1', spec(1)]);
  bindings.get(name(1)).spec.taskDefaults = { timeout: '75m', retryPolicy: { maxRetries: 3 } };
  await assert.rejects(provisioner.reconcile({ ...base, bindingName: name(1), epoch: 1, state: 'reserved' }, context), { category: 'binding-conflict' });
  await assert.rejects(provisioner.check(first, context), { category: 'binding-conflict' }, 'a sibling may differ only in its timeout');
  bindings.get(name(1)).spec.taskDefaults = { timeout: '2h' };
  assert.equal((await provisioner.reconcile({ ...base, bindingName: name(1), epoch: 1, state: 'reserved' }, context)).uid, 'uid-1');
  bindings.get(name(1)).spec.priority = 9;
  await assert.rejects(provisioner.reconcile({ ...base, bindingName: name(1), epoch: 1, state: 'reserved' }, context), { category: 'binding-conflict' });
});
