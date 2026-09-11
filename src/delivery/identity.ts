import { createHash } from 'node:crypto';
import {
  MAX_HTTP_BODY_BYTES, MAX_IDENTITY_BYTES, MAX_METADATA_ENTRIES,
  MAX_METADATA_KEY_BYTES, MAX_METADATA_VALUE_BYTES, MAX_TEXT_BYTES, PROTOCOL_VERSION,
} from '../protocol/types.js';
import { DeliveryJournalError } from './types.js';
import type { DeliveryClaim, DeliveryOutcome, JournalScope } from './types.js';

export interface RequestIdentity { deliveryId: string; idempotencyId: string; digest: string }

export function requestIdentity(value: unknown, scope: JournalScope): RequestIdentity {
  const request = record(value, [
    'protocolVersion', 'deliveryId', 'idempotencyId', 'originatingEventId', 'taskRef', 'sessionRef',
    'kind', 'accountId', 'contextId', 'threadId', 'replyTarget', 'text', 'metadata',
  ]);
  if (request.protocolVersion !== PROTOCOL_VERSION || !['final', 'error'].includes(request.kind as string)) invalid();
  const deliveryId = identity(request.deliveryId);
  const idempotencyId = identity(request.idempotencyId);
  const accountId = identity(request.accountId);
  if (accountId !== scope.tenantId) invalid();
  const metadata = 'metadata' in request ? record(request.metadata) : {};
  const keys = Object.keys(metadata);
  if (keys.length > MAX_METADATA_ENTRIES) invalid();
  const entries = keys.sort().map((key) => {
    identity(key);
    if (Buffer.byteLength(key, 'utf8') > MAX_METADATA_KEY_BYTES) invalid();
    return [key, string(metadata[key], MAX_METADATA_VALUE_BYTES, false)];
  });
  const canonical = JSON.stringify([
    'teams-delivery-v1', scope.appId, scope.tenantId, request.protocolVersion,
    // Delivery aliases deliberately have the stable ID's fingerprint.
    idempotencyId, idempotencyId, identity(request.originatingEventId),
    'taskRef' in request ? reference(request.taskRef) : null,
    'sessionRef' in request ? reference(request.sessionRef) : null,
    request.kind, accountId, identity(request.contextId),
    'threadId' in request && request.threadId !== '' ? identity(request.threadId) : '',
    identity(request.replyTarget), string(request.text, MAX_TEXT_BYTES, true), entries,
  ]);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_HTTP_BODY_BYTES) invalid();
  return { deliveryId, idempotencyId, digest: createHash('sha256').update(canonical, 'utf8').digest('hex') };
}

export function validateClaim(value: unknown): DeliveryClaim {
  const claim = record(value, ['idempotencyId', 'attemptId']);
  return { idempotencyId: identity(claim.idempotencyId), attemptId: identity(claim.attemptId) };
}

export function validateOutcome(value: unknown): DeliveryOutcome {
  const outcome = record(value, ['kind', 'providerMessageId']);
  if (outcome.kind === 'delivered') return { kind: 'delivered', providerMessageId: identity(outcome.providerMessageId) };
  if ('providerMessageId' in outcome || !['unknown', 'rejected', 'retryable'].includes(outcome.kind as string)) invalid();
  return { kind: outcome.kind as 'unknown' | 'rejected' | 'retryable' };
}

function reference(value: unknown): [string, string] {
  const ref = record(value, ['namespace', 'name']);
  return [identity(ref.namespace), identity(ref.name)];
}

function string(value: unknown, maxBytes: number, text: boolean): string {
  if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value) || Buffer.byteLength(value, 'utf8') > maxBytes ||
      (text ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u : /\p{Cc}/u).test(value)) invalid();
  return value;
}

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || (keys && !keys.includes(key)) ||
        !descriptor.enumerable || !('value' in descriptor)) invalid();
  }
  return value as Record<string, unknown>;
}

export function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\uD800-\uDFFF]/u.test(value) ||
      Buffer.byteLength(value, 'utf8') > MAX_IDENTITY_BYTES ||
      /\p{Cc}/u.test(value) || /^\p{White_Space}|\p{White_Space}$/u.test(value)) invalid();
  return value;
}

export function validateScope(value: unknown): JournalScope {
  const scope = record(value, ['appId', 'tenantId']);
  return { appId: identity(scope.appId), tenantId: identity(scope.tenantId) };
}

function invalid(): never { throw new DeliveryJournalError('invalid-input'); }
