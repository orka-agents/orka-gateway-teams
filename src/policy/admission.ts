import type { PolicyRequestContext } from '../auth/graph-identity.js';
import { tlsVerificationEnabled } from '../ingress/config.js';
import { subscribeAuditAbort } from '../storage/table/audit.js';
import type { GroupPolicy, PolicyChatKind } from './config.js';
import { uuid } from './config.js';
import type { GraphMembershipClient } from './graph.js';

export const NO_ACCESS_TEXT = "You don't have access to an Orka for this chat.";
export interface PolicySubject { readonly tenantId: string; readonly objectId?: string; readonly chatKind?: PolicyChatKind }
export type PolicyAdmission =
  | Readonly<{ kind: 'eligible'; targets: readonly Readonly<{ id: string; label: string }>[] }>
  | Readonly<{ kind: 'no-access'; text: string }>
  | Readonly<{ kind: 'unavailable'; category: 'graph-unavailable' }>;
const noAccess: PolicyAdmission = Object.freeze({ kind: 'no-access', text: NO_ACCESS_TEXT });
const unavailable: PolicyAdmission = Object.freeze({ kind: 'unavailable', category: 'graph-unavailable' });

/** Call only after transport/body scope authentication and accepted candidate conversion.
 * Request-local Graph identity must never replace the persisted protocol sender. */
export function readPolicySubject(activity: unknown, tenantId: string): PolicySubject {
  try {
    const tenant = uuid(tenantId);
    if (!record(activity) || !record(activity.from) || !record(activity.conversation)) throw new Error();
    const kind = activity.conversation.conversationType;
    if ((kind !== 'personal' && kind !== 'groupChat') || (kind === 'personal' && activity.conversation.isGroup === true)) throw new Error();
    return Object.freeze({ tenantId: tenant, objectId: uuid(activity.from.aadObjectId), chatKind: kind });
  } catch { return Object.freeze({ tenantId }); }
}
interface CompleteMembership { readonly groups: readonly string[]; readonly wall: number; readonly mono: number }

/** In-memory policy only: no admission receipt, connection, Task, log or Teams send. */
export function createGroupAuthorizer(policy: GroupPolicy, membership: GraphMembershipClient) {
  const cache = new Map<string, CompleteMembership>(); const work = new Set<Promise<PolicyAdmission>>();
  const shutdown = new AbortController(); let closing: Promise<void> | undefined;
  let lastWall = Date.now(); let lastMono = performance.now();
  function clock() {
    const wall = Date.now(); const mono = performance.now();
    const valid = Number.isFinite(wall) && Number.isFinite(mono) && wall >= lastWall && mono >= lastMono;
    lastWall = wall; lastMono = mono;
    if (!valid) { cache.clear(); throw new Error(); }
    return { wall, mono };
  }
  const fresh = (entry: CompleteMembership, time: { wall: number; mono: number }) =>
    time.wall >= entry.wall && time.mono >= entry.mono && time.wall - entry.wall < 60000 && time.mono - entry.mono < 60000;
  return Object.freeze({
    authorize(subject: PolicySubject, context: PolicyRequestContext, targetId?: string): Promise<PolicyAdmission> {
      try {
        const signal = context.signal; const deadline = context.deadline;
        const eligible = () => !closing && !signal.aborted && !shutdown.signal.aborted && tlsVerificationEnabled() && Number.isFinite(deadline) &&
          Number.isFinite(performance.now()) && performance.now() < deadline;
        if (!eligible() || work.size >= 32) return Promise.resolve(unavailable);
        const started = clock();
        let objectId: string;
        try {
          if (uuid(subject.tenantId) !== policy.tenantId || (subject.chatKind !== 'personal' && subject.chatKind !== 'groupChat')) return Promise.resolve(noAccess);
          objectId = uuid(subject.objectId);
        } catch { return Promise.resolve(noAccess); }
        const kind = subject.chatKind;
        const key = JSON.stringify([policy.tenantId, objectId, policy.digest]);
        const operation = (async (): Promise<PolicyAdmission> => {
          let entry = cache.get(key);
          if (entry && !fresh(entry, started)) { cache.delete(key); entry = undefined; }
          if (!entry) {
            let groups: readonly string[] = Object.freeze([]);
            if (policy.groupIds.length) {
              // Dispose subscriptions on the process-lifetime shutdown signal after actual work drains.
              const controller = new AbortController(); const abort = () => controller.abort();
              const caller = subscribeAuditAbort(signal, abort); const owner = subscribeAuditAbort(shutdown.signal, abort);
              if (signal.aborted || shutdown.signal.aborted) abort();
              try { groups = await membership.lookup(objectId, policy.groupIds, { signal: controller.signal, deadline }); }
              finally { caller(); owner(); }
            }
            entry = Object.freeze({ groups, ...started });
            // A late/partial/failed lookup never creates usable cache or a durable effect.
            if (!eligible() || !fresh(entry, clock())) return unavailable;
          }
          if (!eligible() || !fresh(entry, clock())) return unavailable;
          cache.delete(key); if (cache.size >= 1024) cache.delete(cache.keys().next().value!); cache.set(key, entry);
          const targets = policy.targets.filter(t => t.rules.some(r => r.chatKinds.includes(kind) && entry!.groups.includes(r.groupId)))
            .map(t => Object.freeze({ id: t.id, label: t.label }));
          if (!targets.length || (targetId !== undefined && !targets.some(t => t.id === targetId))) return noAccess;
          return Object.freeze({ kind: 'eligible', targets: Object.freeze(targets) });
        })().catch(() => unavailable);
        work.add(operation); void operation.then(() => work.delete(operation), () => work.delete(operation)); return operation;
      } catch { return Promise.resolve(unavailable); }
    },
    close() {
      if (!closing) {
        shutdown.abort();
        closing = Promise.allSettled([...work, membership.close()]).then(() => { cache.clear(); });
      }
      return closing;
    },
  });
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
