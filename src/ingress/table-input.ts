import { integer, object } from '../storage/table/codec.js';
import { TableError } from '../storage/table/types.js';
import type { EventEnvelope } from '../protocol/types.js';
import { identity, matchRoute, validateEvent, validateReceipt, validateRoute } from './codec.js';
import type { IngressClaim, IngressReceipt, IngressScope, ReplyRoute } from './types.js';
import type { ExplicitBlockReason, InboxResultClaim } from './table-types.js';

export type Settlement = { operation: 'complete'; claim: InboxResultClaim; receipt: IngressReceipt } |
  { operation: 'retry'; claim: InboxResultClaim; delayMs: number } |
  { operation: 'block'; claim: InboxResultClaim; reason: ExplicitBlockReason };
export type Command = { operation: 'admit'; event: EventEnvelope & { replyTarget: string }; route: ReplyRoute } |
  { operation: 'claim' } | { operation: 'route'; target: string } | Settlement;
export const FRAME_BYTES = 8192;
const eventKeys = ['protocolVersion', 'externalEventId', 'eventType', 'accountId', 'contextId', 'sender', 'text', 'replyTarget', 'occurredAt'];

/** No encoded/string snapshot is allocated before the domain queue reservation.
 * This bounded character scan gives an upper bound, not an extra retained input. */
export interface AdmissionSources { event: Record<string, unknown>; route: Record<string, unknown> }
export function admissionSources(event: Readonly<EventEnvelope>, route: Readonly<ReplyRoute>): AdmissionSources {
  const e = snapshot(event, eventKeys); e.sender = snapshot(e.sender, ['id', 'displayName']);
  const r = snapshot(route, ['serviceUrl', 'channelId', 'bot', 'conversation']);
  r.bot = snapshot(r.bot, ['id', 'role']); r.conversation = snapshot(r.conversation, ['id', 'conversationType', 'tenantId']);
  stringFields(e, ['sender']); stringFields(e.sender as Record<string, unknown>);
  stringFields(r, ['bot', 'conversation']); stringFields(r.bot as Record<string, unknown>); stringFields(r.conversation as Record<string, unknown>);
  return { event: e, route: r };
}
function stringFields(value: Record<string, unknown>, nested: readonly string[] = []): void {
  for (const key of Object.keys(value)) if (!nested.includes(key) && value[key] !== undefined && typeof value[key] !== 'string') {
    throw new TableError('invalid-input');
  }
}
export function admissionBound(source: AdmissionSources): number {
  return 512 + jsonSize(source.event, 0) + jsonSize(source.route, 0);
}
function jsonSize(value: unknown, depth: number): number {
  if (value === undefined) return 0;
  if (typeof value === 'string') {
    if (value.length > 65536) throw new TableError('invalid-input');
    let size = 2;
    for (let i = 0; i < value.length; i++) {
      const n = value.charCodeAt(i);
      if (n === 34 || n === 92 || n === 8 || n === 9 || n === 10 || n === 12 || n === 13) size += 2;
      else if (n < 32 || (n >= 0xd800 && n <= 0xdfff)) size += 6;
      else size += n < 128 ? 1 : n < 2048 ? 2 : 3;
    }
    return size;
  }
  if (value && typeof value === 'object' && depth < 3) {
    object(value); let total = 2;
    for (const key of Object.keys(value)) {
      const item = Object.getOwnPropertyDescriptor(value, key)!.value;
      if (item !== undefined) total += jsonSize(key, depth + 1) + 2 + jsonSize(item, depth + 1);
    }
    return total;
  }
  throw new TableError('invalid-input');
}
function own(value: object, key: string): unknown { return Object.getOwnPropertyDescriptor(value, key)?.value; }
function snapshot(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  const input = object(value, keys); const copy: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(input)) copy[key] = own(input, key); return copy;
}
export function admission(source: AdmissionSources, scope: Readonly<IngressScope>): Command {
  const e = validateEvent(source.event); const r = validateRoute(source.route); matchRoute(e, r, scope);
  return { operation: 'admit', event: e, route: r };
}
export function claimIdentity(input: Readonly<IngressClaim>): InboxResultClaim {
  // event is intentionally neither enumerated nor accessed. It can be huge,
  // cyclic or accessor-backed and cannot enter settlement ownership.
  if (!input || typeof input !== 'object') throw new TableError('invalid-input');
  const get = (key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) throw new TableError('invalid-input'); return descriptor.value;
  };
  const eventId = identity(get('externalEventId')); const attemptId = identity(get('attemptId'));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(attemptId)) throw new TableError('invalid-input');
  return { eventId, attemptId, attempt: integer(get('attempt'), 1, Number.MAX_SAFE_INTEGER) };
}
export function settlement(operation: Settlement['operation'], claim: InboxResultClaim,
  value: Readonly<IngressReceipt> | number | ExplicitBlockReason): Settlement {
  if (operation === 'complete') return { operation, claim, receipt: validateReceipt(snapshot(value)) };
  if (operation === 'retry') return { operation, claim, delayMs: integer(value, 0, Number.MAX_SAFE_INTEGER) };
  if (value !== 'conflict' && value !== 'invalid-event' && value !== 'redirect') throw new TableError('invalid-input');
  return { operation, claim, reason: value };
}
export function commandBytes(command: Command): Buffer {
  const text = JSON.stringify(command); const buffer = Buffer.alloc(Buffer.byteLength(text)); buffer.write(text); return buffer;
}
export function readCommand(buffer: Buffer): Command { return JSON.parse(buffer.toString('utf8')) as Command; }
