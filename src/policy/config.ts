import { createHash } from 'node:crypto';
import { ConfigurationError } from '../ingress/config.js';
import type { RegistryConfig } from '../registry/config.js';
import { snapshotRegistry } from '../registry/config.js';
import { absoluteFile, readRegistryFile } from '../registry/files.js';
import { auditFields } from '../storage/table/audit.js';

export type PolicyChatKind = 'personal' | 'groupChat';
export interface GroupRule { readonly groupId: string; readonly chatKinds: readonly PolicyChatKind[] }
export interface GroupPolicy {
  readonly tenantId: string; readonly graphIdentityClientId: string; readonly digest: string;
  readonly groupIds: readonly string[];
  readonly targets: readonly Readonly<{ id: string; label: string; rules: readonly GroupRule[] }>[];
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw new ConfigurationError();
  return value.toLowerCase();
}
/** Closed startup-only policy. Absence of a target rule is never an implicit grant. */
export function snapshotGroupPolicy(input: unknown, registry: RegistryConfig): GroupPolicy {
  try {
    const registered = snapshotRegistry(registry);
    const root = auditFields(input, ['schemaVersion', 'graphIdentityClientId', 'policies']);
    const tenantId = uuid(registered.targets[0]!.config.scope.tenantId);
    const graphIdentityClientId = uuid(root.graphIdentityClientId);
    if (root.schemaVersion !== 1 || !Array.isArray(root.policies) || root.policies.length > 32) throw new ConfigurationError();
    const policies = new Map<string, readonly GroupRule[]>(); const groups = new Set<string>(); let count = 0;
    for (const item of root.policies) {
      const p = auditFields(item, ['schemaVersion', 'targetId', 'frontAgent', 'rules']);
      const target = registered.targets.find(t => t.id === p.targetId);
      if (p.schemaVersion !== 1 || !target || policies.has(target.id) || p.frontAgent !== target.frontAgent.name || !Array.isArray(p.rules)) throw new ConfigurationError();
      const rules = p.rules.map((item): GroupRule => {
        if (++count > 256) throw new ConfigurationError();
        const rule = auditFields(item, ['groupId', 'chatKinds']); const groupId = uuid(rule.groupId);
        if (!Array.isArray(rule.chatKinds) || !rule.chatKinds.length || rule.chatKinds.length > 2 ||
            rule.chatKinds.some(k => k !== 'personal' && k !== 'groupChat') || new Set(rule.chatKinds).size !== rule.chatKinds.length) throw new ConfigurationError();
        groups.add(groupId);
        return Object.freeze({ groupId, chatKinds: Object.freeze([...rule.chatKinds].sort() as PolicyChatKind[]) });
      }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
      policies.set(target.id, Object.freeze(rules));
    }
    const targets = registered.targets.map(t => Object.freeze({ id: t.id, label: t.label, rules: policies.get(t.id) ?? Object.freeze([]) }));
    const digest = createHash('sha256').update(JSON.stringify(['teams-group-policy-v1', tenantId,
      targets.map(t => [t.id, t.rules]).sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en'))])).digest('hex');
    return Object.freeze({ tenantId, graphIdentityClientId, digest, groupIds: Object.freeze([...groups].sort()), targets: Object.freeze(targets) });
  } catch { throw new ConfigurationError(); }
}
export function readGroupPolicy(file: string, registry: RegistryConfig): GroupPolicy {
  try { return snapshotGroupPolicy(JSON.parse(readRegistryFile(absoluteFile(file), 256 * 1024, false)), registry); }
  catch { throw new ConfigurationError(); }
}
