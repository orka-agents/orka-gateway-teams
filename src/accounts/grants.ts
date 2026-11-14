import { createHash } from 'node:crypto';
import { identity } from '../ingress/codec.js';
import { integer, object } from '../storage/table/codec.js';

export interface GrantBinding { namespaceUID: string; gatewayUID: string; taskUID: string; tools: string[]; deadline: number }
export interface TaskGrant {
  ref: string; objectId: string; generation: number; provider: 'workiq'; targetId: string; targetDigest: string; eventId: string;
  tools: string[]; binding?: GrantBinding;
}
export function grantReference(scope: { appId: string; tenantId: string }, target: { id: string; identityDigest?: string }, eventId: string, replyTarget: string): string {
  // Only the winning inbox candidate can use its grant; a redelivery has a fresh reply target.
  return createHash('sha256').update(JSON.stringify(['teams-task-grant-v1', identity(scope.appId), identity(scope.tenantId),
    identity(target.id), identity(target.identityDigest!), identity(eventId), identity(replyTarget)])).digest('hex');
}
export function grantRef(ref: unknown): string {
  if (typeof ref !== 'string' || !/^[a-f0-9]{64}$/u.test(ref)) throw new Error('Invalid grant'); return ref;
}
export function grantTools(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length || input.length > 16 || input.some(t => t !== 'workiq')) throw new Error('Invalid tools');
  return [...new Set(input as string[])].sort();
}
export function grantBinding(input: unknown): GrantBinding {
  const v = object(input, ['namespaceUID', 'gatewayUID', 'taskUID', 'tools', 'deadline']);
  return { namespaceUID: identity(v.namespaceUID), gatewayUID: identity(v.gatewayUID), taskUID: identity(v.taskUID),
    tools: grantTools(v.tools), deadline: integer(v.deadline, 1, Number.MAX_SAFE_INTEGER) };
}
export function taskGrant(input: unknown): TaskGrant {
  const v = object(input, ['ref', 'objectId', 'generation', 'provider', 'targetId', 'targetDigest', 'eventId', 'tools', 'binding']);
  if (v.provider !== 'workiq') throw new Error('Invalid provider');
  return { ref: grantRef(v.ref), objectId: identity(v.objectId), generation: integer(v.generation, 1, Number.MAX_SAFE_INTEGER), provider: 'workiq',
    targetId: identity(v.targetId), targetDigest: grantRef(v.targetDigest), eventId: identity(v.eventId), tools: grantTools(v.tools),
    ...(v.binding === undefined ? {} : { binding: grantBinding(v.binding) }) };
}
