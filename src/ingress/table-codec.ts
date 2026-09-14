import { bytes, fail, integer, object, rawJSON } from '../storage/table/codec.js';
import { TableError } from '../storage/table/types.js';
import type { DataKey } from '../storage/table/types.js';
import { digest, encode, identity, MAX_REPLAY_WINDOW_MS, validateEvent, validateReceipt, validateRoute } from './codec.js';
import { MAX_EVENT_PAYLOAD_BYTES, MAX_INBOX_RECORDS, MAX_INBOX_STATE_BYTES, MAX_INBOX_TIME,
  MAX_ROUTE_PAYLOAD_BYTES, MAX_SEAL_PAYLOAD_BYTES } from './table-types.js';
import type { EventPayload, HandoffClockArm, InboxState, RoutePayload, SealPayload } from './table-types.js';

function boundary<T>(code: 'invalid-input' | 'corrupt', work: () => T): T {
  // V1 validators and malformed caller objects must not carry raw causes across this boundary.
  try { return work(); } catch { throw new TableError(code); }
}
function shape(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const v = object(value, keys); if (Object.keys(v).length !== keys.length) fail(); return v;
}
function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) fail(); return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) fail(); return value;
}
function keyId(key: Readonly<DataKey>, type: DataKey['type']): string {
  const v = shape(key, ['type', 'id']); if (v.type !== type) fail(); return identity(v.id);
}
function pack(value: unknown, max: number): Buffer {
  const result = encode(value); if (result.length > max) fail(); return result;
}
function unpack<T>(input: Uint8Array, max: number, normalize: (value: unknown) => T): T {
  const raw = bytes(input, max); const result = normalize(rawJSON(raw));
  if (!encode(result).equals(raw)) fail(); return result;
}
function arm(value: unknown, records: number): HandoffClockArm | null {
  if (value === null) return null;
  const v = shape(value, ['id', 'ownerEpoch', 'generation', 'order', 'attemptId']);
  const order = integer(v.order, 1, records);
  // Owner/attempt binding is audited later. Revalidation can seal an armed generation.
  return { id: uuid(v.id), ownerEpoch: integer(v.ownerEpoch, 1, Number.MAX_SAFE_INTEGER),
    generation: integer(v.generation, 1, order), order, attemptId: uuid(v.attemptId) };
}
function state(value: unknown): InboxState {
  const v = shape(value, ['journal', 'schema', 'fingerprintVersion', 'records', 'bodies', 'lastNow',
    'restartEpoch', 'currentGeneration', 'handoffClockArm']);
  if (v.journal !== 'teams-inbox' || v.schema !== 1 || v.fingerprintVersion !== 1) fail();
  const records = integer(v.records, 0, MAX_INBOX_RECORDS);
  return { journal: 'teams-inbox', schema: 1, fingerprintVersion: 1, records, bodies: integer(v.bodies, 0, records),
    lastNow: integer(v.lastNow, 0, MAX_INBOX_TIME), restartEpoch: integer(v.restartEpoch, 1, Number.MAX_SAFE_INTEGER),
    currentGeneration: v.currentGeneration === null ? null : integer(v.currentGeneration, 1, records),
    handoffClockArm: arm(v.handoffClockArm, records) };
}
function event(key: Readonly<DataKey>, value: unknown): EventPayload {
  const id = keyId(key, 'event');
  const v = shape(value, ['schema', 'fingerprintVersion', 'replyTarget', 'fingerprint', 'bodyDigest', 'body', 'state',
    'received', 'deadline', 'nextAttempt', 'attempt', 'attemptId', 'attemptEpoch', 'order', 'generation', 'receipt', 'reason']);
  if (v.schema !== 1 || v.fingerprintVersion !== 1 || !['pending', 'forwarding', 'blocked', 'terminal'].includes(v.state as string)) fail();
  const replyTarget = identity(v.replyTarget); const fingerprint = hex(v.fingerprint); const bodyDigest = hex(v.bodyDigest);
  const received = integer(v.received, 0, MAX_INBOX_TIME); const order = integer(v.order, 1, MAX_INBOX_RECORDS);
  const attempt = integer(v.attempt, 0, Number.MAX_SAFE_INTEGER);
  if (attempt === 0 && (v.attemptId !== null || v.attemptEpoch !== 0)) fail();
  const attemptId = attempt === 0 ? null : uuid(v.attemptId);
  const attemptEpoch = attempt === 0 ? 0 : integer(v.attemptEpoch, 1, Number.MAX_SAFE_INTEGER);
  if (v.state === 'forwarding' && attempt === 0) fail();
  if (v.state === 'blocked' ? !['conflict', 'invalid-event', 'redirect'].includes(v.reason as string) : v.reason !== null) fail();
  let body: EventPayload['body'] = null; let receipt: EventPayload['receipt'] = null;
  if (v.state === 'terminal') {
    if (v.body !== null) fail(); object(v.receipt); receipt = validateReceipt(v.receipt);
    // Historical terminal fingerprints/body digests have no retained body to recompute.
  } else {
    if (v.receipt !== null) fail();
    const input = object(v.body); object(input.sender); body = validateEvent(input);
    if (body.externalEventId !== id || body.replyTarget !== replyTarget || digest(encode(body)) !== bodyDigest) fail();
  }
  return { schema: 1, fingerprintVersion: 1, replyTarget, fingerprint, bodyDigest, body, state: v.state as EventPayload['state'],
    received, deadline: integer(v.deadline, received + 1, received + MAX_REPLAY_WINDOW_MS),
    nextAttempt: integer(v.nextAttempt, 0, Number.MAX_SAFE_INTEGER), attempt, attemptId, attemptEpoch, order,
    generation: integer(v.generation, 1, order), receipt, reason: v.reason as EventPayload['reason'] };
}
function route(key: Readonly<DataKey>, value: unknown): RoutePayload {
  keyId(key, 'route'); const v = shape(value, ['schema', 'externalEventId', 'route', 'routeDigest']);
  if (v.schema !== 1) fail();
  const input = object(v.route); object(input.bot); object(input.conversation);
  const route = validateRoute(input); const routeDigest = hex(v.routeDigest);
  if (digest(encode(route)) !== routeDigest) fail();
  return { schema: 1, externalEventId: identity(v.externalEventId), route, routeDigest };
}
function seal(key: Readonly<DataKey>, value: unknown): SealPayload {
  const id = keyId(key, 'control');
  const v = shape(value, ['schema', 'kind', 'generation', 'lastOrder', 'watermark', 'observation', 'epoch', 'reason']);
  const generation = integer(v.generation, 1, MAX_INBOX_RECORDS);
  if (v.schema !== 1 || v.kind !== 'generation-seal' || id !== `generation:${generation}` ||
      !['clock-regression', 'clock-uncertain'].includes(v.reason as string)) fail();
  const watermark = integer(v.watermark, 0, MAX_INBOX_TIME);
  if (v.reason === 'clock-uncertain' && v.observation !== null) fail();
  const observation = v.reason === 'clock-uncertain' ? null : integer(v.observation, 0, watermark - 1);
  return { schema: 1, kind: 'generation-seal', generation, lastOrder: integer(v.lastOrder, generation, MAX_INBOX_RECORDS),
    watermark, observation, epoch: integer(v.epoch, 1, Number.MAX_SAFE_INTEGER), reason: v.reason as SealPayload['reason'] };
}

/** Encoders normalize outer order and reuse V1 event/route/receipt validation. */
export function encodeState(value: Readonly<InboxState>): Buffer {
  return boundary('invalid-input', () => pack(state(value), MAX_INBOX_STATE_BYTES));
}
export function decodeState(input: Uint8Array): InboxState {
  return boundary('corrupt', () => unpack(input, MAX_INBOX_STATE_BYTES, state));
}
export function encodeEvent(key: Readonly<DataKey>, value: Readonly<EventPayload>): Buffer {
  return boundary('invalid-input', () => pack(event(key, value), MAX_EVENT_PAYLOAD_BYTES));
}
export function decodeEvent(key: Readonly<DataKey>, input: Uint8Array): EventPayload {
  return boundary('corrupt', () => unpack(input, MAX_EVENT_PAYLOAD_BYTES, value => event(key, value)));
}
export function encodeRoute(key: Readonly<DataKey>, value: Readonly<RoutePayload>): Buffer {
  return boundary('invalid-input', () => pack(route(key, value), MAX_ROUTE_PAYLOAD_BYTES));
}
export function decodeRoute(key: Readonly<DataKey>, input: Uint8Array): RoutePayload {
  return boundary('corrupt', () => unpack(input, MAX_ROUTE_PAYLOAD_BYTES, value => route(key, value)));
}
/** clock-uncertain is a reader representation here, not a recovery writer. */
export function encodeSeal(key: Readonly<DataKey>, value: Readonly<SealPayload>): Buffer {
  return boundary('invalid-input', () => pack(seal(key, value), MAX_SEAL_PAYLOAD_BYTES));
}
export function decodeSeal(key: Readonly<DataKey>, input: Uint8Array): SealPayload {
  return boundary('corrupt', () => unpack(input, MAX_SEAL_PAYLOAD_BYTES, value => seal(key, value)));
}
