import { createHash } from 'node:crypto';
import type { DeliveryRequest } from '../protocol/types.js';
import { identity, validateScope } from './identity.js';
import { DeliveryJournalError } from './types.js';
import type { JournalScope } from './types.js';

export const MAX_SESSION_CORRELATIONS = 100000;
export interface SessionObservation { sessionDigest: string; originDigest: string }
export type SessionObservationResult = { kind: 'observed'; continuation: boolean } | { kind: 'full' };
export interface SessionCorrelationPort {
  observeSession(input: Readonly<SessionObservation>): SessionObservationResult | Promise<SessionObservationResult>;
}

function invalid(): never { throw new DeliveryJournalError('invalid-input'); }
function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  if (fields) for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) invalid();
    field(value as Record<string, unknown>, key);
  }
  return value as Record<string, unknown>;
}
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) invalid();
  return descriptor.value;
}
function hash(tuple: readonly string[]): string { return createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex'); }

/** Project only consumed identifiers synchronously; neither body nor raw frame is retained. */
export function createSessionObservation(inputScope: JournalScope, inputRequest: Readonly<DeliveryRequest>): SessionObservation | undefined {
  const request = record(inputRequest);
  if (!Object.hasOwn(request, 'sessionRef')) return undefined;
  const scope = validateScope(inputScope);
  const reference = record(field(request, 'sessionRef'), ['namespace', 'name']);
  const accountId = identity(field(request, 'accountId'));
  if (accountId !== scope.tenantId) invalid();
  const thread = Object.hasOwn(request, 'threadId') ? field(request, 'threadId') : '';
  return {
    sessionDigest: hash(['teams-session-correlation-v1', scope.appId, scope.tenantId, accountId,
      identity(field(request, 'contextId')), thread === '' ? '' : identity(thread),
      identity(field(reference, 'namespace')), identity(field(reference, 'name'))]),
    originDigest: hash(['teams-session-origin-v1', 'originatingEventId', identity(field(request, 'originatingEventId'))]),
  };
}

export function validateSessionObservation(value: unknown): SessionObservation {
  const input = record(value, ['sessionDigest', 'originDigest']);
  const sessionDigest = field(input, 'sessionDigest'); const originDigest = field(input, 'originDigest');
  if (typeof sessionDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(sessionDigest) ||
      typeof originDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(originDigest)) invalid();
  return { sessionDigest, originDigest };
}
export function sessionCorrelationLimit(value: unknown = MAX_SESSION_CORRELATIONS): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_SESSION_CORRELATIONS) invalid();
  return value;
}
export function sessionScopeDigest(input: Readonly<JournalScope>): string {
  const scope = validateScope(input);
  return hash(['teams-session-scope-v1', scope.appId, scope.tenantId]);
}
