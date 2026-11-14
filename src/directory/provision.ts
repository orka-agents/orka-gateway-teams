import { setTimeout as delay } from 'node:timers/promises';
import { identity } from '../ingress/codec.js';
import type { RegistryTarget } from '../registry/config.js';
import { snapshotRegistry } from '../registry/config.js';
import type { createKubernetesReader, KubernetesContext } from '../registry/kubernetes.js';
import { canonicalJSON, snapshotDirectoryRecord } from './codec.js';
import type { BindingEvidence, CanonicalValue, ConnectionRecord } from './types.js';

const apiVersion = 'gateway.orka.ai/v1alpha1';
const digestMarker = 'gateway.orka.ai/teams-target-digest';
const gatewayMarker = 'gateway.orka.ai/teams-gateway-uid';
type KubernetesClient = Pick<ReturnType<typeof createKubernetesReader>, 'getGateway' | 'getAgent' | 'listBindings' | 'getBinding' | 'createBinding'>;
export class BindingCheckError extends Error {
  constructor(readonly category: 'target-paused' | 'binding-conflict' | 'credential-expiring') { super(category); this.name = 'BindingCheckError'; }
}
const conflict = (): never => { throw new BindingCheckError('binding-conflict'); };
const paused = (): never => { throw new BindingCheckError('target-paused'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return conflict(); return value as Record<string, unknown>;
}
function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return conflict(); return value as number;
}
function metadata(value: Record<string, unknown>, kind: string, version: string, namespace: string, name: string) {
  const meta = object(value.metadata);
  if (value.apiVersion !== version || value.kind !== kind || meta.namespace !== namespace || meta.name !== name || meta.deletionTimestamp !== undefined) conflict();
  return meta;
}
function ready(value: Record<string, unknown>, current: number): boolean {
  const status = object(value.status ?? {}); return status.ready === true && status.observedGeneration === current;
}

/** No ownership, background queue or Teams effect: the caller reserves first and owns drain/markProvisioned.
 * Every check is fresh; never use this result as a cached authorization for a later event. */
export function createBindingProvisioner(input: RegistryTarget, client: KubernetesClient) {
  const { taskPassToken: _controllerOnly, ...targetConfig } = input;
  const target = snapshotRegistry({ schemaVersion: 1, targets: [targetConfig] }).targets[0]!;
  const scope = target.config.scope; const namespace = scope.gatewayNamespace;
  function capture(context: KubernetesContext): KubernetesContext {
    const signal = context.signal; const deadline = Math.min(context.deadline, performance.now() + 10000); const allowed = context.allowed.bind(context);
    return { signal, deadline, allowed };
  }
  function active(context: KubernetesContext): void {
    if (context.signal.aborted || !Number.isFinite(context.deadline) || performance.now() >= context.deadline || !context.allowed()) paused();
  }
  async function wait(context: KubernetesContext): Promise<void> {
    active(context); await delay(Math.min(100, Math.max(1, context.deadline - performance.now())), undefined, { signal: context.signal }); active(context);
  }
  function connection(input: ConnectionRecord, requireProvisioned: boolean): ConnectionRecord {
    const saved = snapshotDirectoryRecord(input);
    if (saved.kind !== 'conn' || saved.targetId !== target.id || saved.identityDigest !== target.identityDigest ||
        saved.scope.appId !== scope.appId || saved.scope.tenantId !== scope.tenantId || (requireProvisioned && saved.state !== 'provisioned')) conflict();
    const value = saved as ConnectionRecord;
    if (value.state === 'provisioned' && (value.binding.namespace !== namespace || value.binding.name !== value.bindingName)) conflict();
    if (value.state === 'provisioned') {
      const spec = value.binding.spec;
      if (object(spec.gatewayRef).name !== scope.gatewayName || object(spec.agentRef).name !== target.frontAgent.name ||
          object(spec.match).accountId !== scope.tenantId || object(spec.match).contextId !== value.conversationId) conflict();
    }
    return value;
  }
  function desired(value: ConnectionRecord) {
    return {
      apiVersion, kind: 'GatewayBinding', metadata: { namespace, name: value.bindingName,
        annotations: { [digestMarker]: target.identityDigest!, [gatewayMarker]: target.gatewayUid } },
      spec: { gatewayRef: { name: scope.gatewayName }, agentRef: { name: target.frontAgent.name },
        match: { accountId: scope.tenantId, contextId: value.conversationId }, priority: 0,
        senderPolicy: { mode: 'all' }, session: { mode: value.chatKind === 'personal' ? 'context-sender' : 'context' } },
    };
  }
  async function gateway(context: KubernetesContext, waitReady: boolean): Promise<void> {
    for (;;) {
      active(context); const value = await client.getGateway(context); active(context);
      const meta = metadata(value, 'Gateway', apiVersion, namespace, scope.gatewayName);
      if (meta.uid !== target.gatewayUid) conflict();
      if (ready(value, generation(meta.generation))) return;
      if (!waitReady) paused(); await wait(context);
    }
  }
  async function overlap(value: ConnectionRecord, context: KubernetesContext): Promise<void> {
    active(context); const bindings = await client.listBindings(context); active(context);
    for (const binding of bindings) {
      const meta = object(binding.metadata); const spec = object(binding.spec); const match = object(spec.match);
      if (binding.apiVersion !== apiVersion || binding.kind !== 'GatewayBinding' || meta.namespace !== namespace || typeof meta.name !== 'string' ||
          typeof object(spec.gatewayRef).name !== 'string' || typeof match.accountId !== 'string' || typeof match.contextId !== 'string') conflict();
      // Sender, thread, priority and readiness cannot make a foreign overlap safe.
      if (meta.name !== value.bindingName && object(spec.gatewayRef).name === scope.gatewayName &&
          match.accountId === scope.tenantId && match.contextId === value.conversationId) conflict();
    }
  }
  function evidence(value: ConnectionRecord, binding: Record<string, unknown>): BindingEvidence {
    const meta = metadata(binding, 'GatewayBinding', apiVersion, namespace, value.bindingName);
    const uid = identity(meta.uid); const current = generation(meta.generation); const spec = object(binding.spec);
    const expected = value.state === 'provisioned' ? value.binding.spec : desired(value).spec;
    if (canonicalJSON(spec) !== canonicalJSON(expected)) conflict();
    if (value.state === 'provisioned' && (uid !== value.binding.uid || current !== value.binding.generation)) conflict();
    const annotations = object(meta.annotations);
    if (annotations[digestMarker] !== target.identityDigest || annotations[gatewayMarker] !== target.gatewayUid) conflict();
    return { namespace, name: value.bindingName, uid, generation: current, spec: structuredClone(spec) as { [key: string]: CanonicalValue } };
  }
  async function run(input: ConnectionRecord, supplied: KubernetesContext, checkOnly: boolean): Promise<BindingEvidence> {
    try {
      const context = capture(supplied); active(context); const value = connection(input, checkOnly);
      await gateway(context, !checkOnly); active(context);
      const agent = await client.getAgent(context); active(context);
      metadata(agent, 'Agent', 'core.orka.ai/v1alpha1', namespace, target.frontAgent.name);
      await overlap(value, context); active(context);
      let binding = await client.getBinding(value.bindingName, context); active(context);
      if (!binding) {
        if (checkOnly || value.state === 'provisioned') conflict();
        active(context);
        try { await client.createBinding(desired(value), context); }
        catch (error) {
          // Transport failure may hide a committed deterministic create. Never repeat the POST.
          if (error instanceof Error && error.message === 'credential-expiring') throw error;
        }
        active(context); binding = await client.getBinding(value.bindingName, context); active(context);
        if (!binding) paused();
      }
      let result: BindingEvidence;
      for (;;) {
        active(context); result = evidence(value, binding!);
        if (ready(binding!, result.generation)) break;
        if (checkOnly) paused();
        await wait(context); binding = await client.getBinding(value.bindingName, context); active(context);
        if (!binding) conflict();
      }
      await overlap(value, context); await gateway(context, false); active(context);
      return result;
    } catch (error) {
      if (error instanceof BindingCheckError) throw error;
      throw new BindingCheckError(error instanceof Error && error.message === 'credential-expiring' ? 'credential-expiring' : 'target-paused');
    }
  }
  return Object.freeze({
    reconcile: (value: ConnectionRecord, context: KubernetesContext) => run(value, context, false),
    check: (value: ConnectionRecord, context: KubernetesContext) => run(value, context, true),
  });
}
