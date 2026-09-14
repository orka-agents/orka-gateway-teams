import { createHash } from 'node:crypto';
import { MAX_HTTP_BODY_BYTES, MAX_IDENTITY_BYTES, MAX_TEXT_BYTES, PROTOCOL_VERSION } from '../protocol/types.js';
import type { EventEnvelope } from '../protocol/types.js';
import { IngressStoreError } from './types.js';
import type { IngressPolicy, IngressReceipt, IngressScope, ReplyRoute } from './types.js';

export const MAX_REPLAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function invalid(): never { throw new IngressStoreError('invalid-input'); }
export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some((key) => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
export function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_IDENTITY_BYTES ||
      /[\uD800-\uDFFF]|\p{Cc}|^\p{White_Space}|\p{White_Space}$/u.test(value)) return invalid();
  return value;
}
export function httpsBase(value: unknown, service = false): string {
  if (typeof value !== 'string' || value.length > 2048) return invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash ||
      (service && url.port) || url.href !== value || !url.pathname.endsWith('/')) return invalid();
  return url.href;
}
export function validateScope(value: unknown): Readonly<IngressScope> {
  const input = record(value, ['appId', 'tenantId', 'orkaBaseUrl', 'gatewayNamespace', 'gatewayName']);
  return Object.freeze({ appId: identity(input.appId), tenantId: identity(input.tenantId),
    orkaBaseUrl: httpsBase(input.orkaBaseUrl), gatewayNamespace: identity(input.gatewayNamespace), gatewayName: identity(input.gatewayName) });
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
export function validatePolicy(value: unknown = { maxPending: 1000, maxRecords: 100000, replayWindowMs: 86400000 }): IngressPolicy {
  const input = record(value, ['maxPending', 'maxRecords', 'replayWindowMs']);
  const maxRecords = integer(input.maxRecords, 1, 100000);
  return { maxRecords, maxPending: integer(input.maxPending, 1, maxRecords), replayWindowMs: integer(input.replayWindowMs, 1, MAX_REPLAY_WINDOW_MS) };
}
export function validateEvent(value: unknown): EventEnvelope & { replyTarget: string } {
  // This slice accepts the converter's personal-text envelope, not SDK activities,
  // arbitrary metadata, server-owned receivedAt, or transport/authentication data.
  const input = record(value, ['protocolVersion', 'externalEventId', 'eventType', 'accountId', 'contextId', 'sender', 'text', 'replyTarget', 'occurredAt']);
  if (input.protocolVersion !== PROTOCOL_VERSION || input.eventType !== 'text') return invalid();
  identity(input.externalEventId); identity(input.accountId); identity(input.contextId); identity(input.replyTarget);
  const sender = record(input.sender, ['id', 'displayName']); identity(sender.id);
  if (sender.displayName !== undefined) identity(sender.displayName);
  if (typeof input.text !== 'string' || !input.text || /^\p{White_Space}*$/u.test(input.text) ||
      Buffer.byteLength(input.text) > MAX_TEXT_BYTES || /[\uD800-\uDFFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(input.text)) return invalid();
  if (input.occurredAt !== undefined && (typeof input.occurredAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/u.test(input.occurredAt) || !Number.isFinite(Date.parse(input.occurredAt)))) return invalid();
  const bytes = encode(input);
  if (bytes.length > MAX_HTTP_BODY_BYTES) return invalid();
  return decode(bytes) as EventEnvelope & { replyTarget: string };
}
export function validateRoute(value: unknown): ReplyRoute {
  const input = record(value, ['serviceUrl', 'channelId', 'bot', 'conversation']);
  const bot = record(input.bot, ['id', 'role']); const conversation = record(input.conversation, ['id', 'conversationType', 'tenantId']);
  if (input.channelId !== 'msteams' || bot.role !== 'bot' || conversation.conversationType !== 'personal') return invalid();
  return { serviceUrl: httpsBase(input.serviceUrl, true), channelId: 'msteams', bot: { id: identity(bot.id), role: 'bot' },
    conversation: { id: identity(conversation.id), conversationType: 'personal', tenantId: identity(conversation.tenantId) } };
}
export function matchRoute(event: EventEnvelope, route: Pick<ReplyRoute, 'bot' | 'conversation'>, scope: Readonly<IngressScope>): void {
  if (event.accountId !== scope.tenantId || route.conversation.tenantId !== scope.tenantId ||
      event.contextId !== route.conversation.id || event.sender.id === route.bot.id) invalid();
}
export function fingerprint(event: EventEnvelope, route: Pick<ReplyRoute, 'bot'>, scope: Readonly<IngressScope>): string {
  return digest(encode([scope.appId, scope.tenantId, event.protocolVersion, event.externalEventId, event.eventType,
    event.accountId, event.contextId, event.sender.id, event.text, route.bot.id, event.occurredAt ?? null]));
}
export function validateReceipt(value: unknown): IngressReceipt {
  const input = record(value, ['status', 'eventId', 'state', 'message']);
  if (!['accepted', 'duplicate', 'rejected', 'deadLettered'].includes(input.status as string) ||
      !['Accepted', 'Queued', 'Dispatching', 'TaskCreated', 'Completed', 'Rejected', 'DeadLettered', 'Expired'].includes(input.state as string)) return invalid();
  // Service.AdmitEvent returns new admissions as Queued (or Accepted), explicit
  // denials as Rejected/DeadLettered, and duplicates at any durable lifecycle state.
  if ((input.status === 'accepted' && !['Accepted', 'Queued'].includes(input.state as string)) ||
      (input.status === 'rejected' && !['Rejected', 'DeadLettered'].includes(input.state as string)) ||
      (input.status === 'deadLettered' && input.state !== 'DeadLettered')) return invalid();
  return { status: input.status as IngressReceipt['status'], eventId: identity(input.eventId), state: input.state as string };
}
export function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function encode(value: unknown): Buffer { return Buffer.from(JSON.stringify(value), 'utf8'); }
export function decode(value: unknown): unknown {
  if (!(value instanceof Uint8Array)) throw new IngressStoreError('corrupt');
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
    if (!Buffer.from(text).equals(value)) throw new Error();
    return JSON.parse(text) as unknown;
  } catch { throw new IngressStoreError('corrupt'); }
}
