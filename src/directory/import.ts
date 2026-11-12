import { identity } from '../ingress/codec.js';
import type { RegistryConfig } from '../registry/config.js';
import { snapshotRegistry } from '../registry/config.js';
import { integer, object } from '../storage/table/codec.js';
import { canonicalJSON, snapshotDirectoryRecord } from './codec.js';
import type { Directory } from './store.js';
import type { ConnectionRecord, DirectoryContext } from './types.js';
import { DirectoryError } from './types.js';

/** Validate an entire reviewed export before opening storage or making any write. */
export function validateDirectoryImport(input: unknown, registryInput: RegistryConfig): readonly ConnectionRecord[] {
  try {
    const registry = snapshotRegistry(registryInput); const root = object(input, ['schemaVersion', 'connections']);
    if (root.schemaVersion !== 1 || !Array.isArray(root.connections) || !root.connections.length || root.connections.length > 1000) invalid();
    const seen = new Set<string>();
    return root.connections.map(item => {
      const v = object(item, ['appId', 'tenantId', 'conversationId', 'chatKind', 'targetId', 'identityDigest', 'binding', 'importId']);
      const target = registry.targets.find(t => t.id === v.targetId); const conversationId = identity(v.conversationId);
      if (!target || target.config.scope.appId !== v.appId || target.config.scope.tenantId !== v.tenantId || target.identityDigest !== v.identityDigest) invalid();
      const key = canonicalJSON([v.appId, v.tenantId, conversationId]); if (seen.has(key)) invalid(); seen.add(key);
      const binding = object(v.binding, ['namespace', 'name', 'uid', 'generation', 'spec']);
      const spec = object(binding.spec, ['gatewayRef', 'agentRef', 'match', 'senderPolicy', 'priority', 'session', 'taskDefaults', 'activeTurnBehavior']);
      const gateway = object(spec.gatewayRef, ['name']); const agent = object(spec.agentRef, ['name']);
      const match = object(spec.match, ['accountId', 'contextId', 'senderId', 'threadId']);
      if (binding.namespace !== target.config.scope.gatewayNamespace || gateway.name !== target.config.scope.gatewayName ||
          agent.name !== target.frontAgent.name || match.accountId !== v.tenantId || match.contextId !== conversationId ||
          (match.threadId !== undefined && match.threadId !== '')) invalid();
      if (match.senderId !== undefined && match.senderId !== '') identity(match.senderId);
      if (spec.priority !== undefined) integer(spec.priority, -1000, 1000);
      if (spec.senderPolicy !== undefined) {
        const policy = object(spec.senderPolicy, ['mode', 'allowedSenderIds']);
        if (policy.mode !== undefined && !['all', 'allowlist'].includes(policy.mode as string)) invalid();
        if (policy.allowedSenderIds !== undefined) {
          if (!Array.isArray(policy.allowedSenderIds) || policy.allowedSenderIds.length > 100) invalid(); policy.allowedSenderIds.forEach(identity);
        }
      }
      if (spec.session !== undefined) {
        const session = object(spec.session, ['mode', 'name']);
        if (session.mode !== undefined && !['ephemeral', 'context', 'thread', 'sender', 'context-sender', 'thread-sender', 'explicit'].includes(session.mode as string)) invalid();
        if (session.name !== undefined && session.name !== '') identity(session.name);
      }
      if (spec.activeTurnBehavior !== undefined && spec.activeTurnBehavior !== 'queue') invalid();
      if (spec.taskDefaults !== undefined) {
        const defaults = object(spec.taskDefaults, ['priority', 'timeout', 'retryPolicy', 'agentRuntimeMaxTurns']);
        if (defaults.priority !== undefined) integer(defaults.priority, 0, 1000);
        if (defaults.agentRuntimeMaxTurns !== undefined) integer(defaults.agentRuntimeMaxTurns, 1, 1000);
        if (defaults.timeout !== undefined) identity(defaults.timeout);
        if (defaults.retryPolicy !== undefined) {
          const retry = object(defaults.retryPolicy, ['maxRetries', 'backoffMultiplier', 'initialDelay']);
          if (retry.maxRetries !== undefined) integer(retry.maxRetries, 0, 10);
          if (retry.backoffMultiplier !== undefined && (typeof retry.backoffMultiplier !== 'number' || !Number.isFinite(retry.backoffMultiplier) || retry.backoffMultiplier < 1 || retry.backoffMultiplier > 10)) invalid();
          if (retry.initialDelay !== undefined) identity(retry.initialDelay);
        }
      }
      return snapshotDirectoryRecord({ schema: 1, kind: 'conn', scope: { appId: v.appId, tenantId: v.tenantId }, conversationId,
        chatKind: v.chatKind, targetId: v.targetId, identityDigest: v.identityDigest, bindingName: binding.name,
        lineage: { kind: 'imported', importId: v.importId }, state: 'provisioned', binding }) as ConnectionRecord;
    });
  } catch { throw new DirectoryError('invalid-input'); }
}

/** Preflight all conflicts; concurrent inserts can still leave an idempotent valid prefix. */
export async function importDirectory(input: readonly ConnectionRecord[], directory: Directory, context: DirectoryContext): Promise<void> {
  const rows = input.map(row => snapshotDirectoryRecord(row) as ConnectionRecord); const seen = new Set<string>();
  for (const row of rows) {
    const key = canonicalJSON([row.scope, row.conversationId]);
    if (row.kind !== 'conn' || row.lineage.kind !== 'imported' || row.state !== 'provisioned' || seen.has(key)) invalid(); seen.add(key);
    const existing = await directory.getConnection(row.conversationId, context);
    if (existing && canonicalJSON(existing) !== canonicalJSON(row)) throw new DirectoryError('conflict');
  }
  for (const row of rows) {
    const saved = await directory.reserveConnection(row, context);
    if (canonicalJSON(saved) !== canonicalJSON(row)) throw new DirectoryError('conflict');
  }
}
function invalid(): never { throw new DirectoryError('invalid-input'); }
