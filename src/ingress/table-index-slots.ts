import { etag, integer, object } from '../storage/table/codec.js';
import { TableError } from '../storage/table/types.js';
import { identity, MAX_REPLAY_WINDOW_MS, validateReceipt } from './codec.js';
import { MAX_EVENT_PAYLOAD_BYTES, MAX_INBOX_RECORDS, MAX_INBOX_TIME, MAX_ROUTE_PAYLOAD_BYTES, MAX_SEAL_PAYLOAD_BYTES } from './table-types.js';
import type { EventSummary, SealPayload } from './table-types.js';

export interface IndexVersion { etag: string; digest: string; timestamp: string }
export interface IndexEventInput { event: Readonly<EventSummary>; bodyEncodingBytes: number; payloadBytes: number }
export interface IndexRouteInput {
  replyTarget: string; externalEventId: string; botId: string; conversationId: string;
  routeDigest: string; routeEncodingBytes: number; payloadBytes: number;
}
export interface IndexSealInput { seal: Readonly<SealPayload>; payloadBytes: number }
export type EventIndexRow = IndexEventInput & { version: Readonly<IndexVersion> };
export type RouteIndexRow = IndexRouteInput & { version: Readonly<IndexVersion> };
export type SealIndexRow = IndexSealInput & { version: Readonly<IndexVersion> };

// Exact 2123-byte content ledger, reserved inside each 4096-byte event slot.
// All offsets are bytes. Arenas/slots are 8-byte aligned. Buffer accessors handle
// the final unaligned uint32 lengths; no typed-array alias escapes this module.
export const E = Object.freeze({ ids: 0, etags: 1280, hashes: 1792, timestamps: 1952, uuid: 2008,
  numbers: 2024, unusedSealRef: 2080, lengths: 2084, state: 2100, reason: 2101,
  receiptStatus: 2102, receiptState: 2103, presence: 2104, eventPass: 2105, routePass: 2106,
  bodyLength: 2107, routeLength: 2111, payloadLength: 2115, routePayloadLength: 2119 });
// Exact 375-byte content ledger in a 512-byte seal slot. Numbers at316 are
// deliberately unaligned; read/writeDoubleLE preserves validated safe integers.
export const S = Object.freeze({ etag: 0, hash: 256, timestamp: 288, numbers: 316,
  unusedRefs: 356, etagLength: 364, timestampLength: 366, reason: 367,
  observation: 368, pass: 369, unusedRange: 370, payloadLength: 371 });
const states = ['pending', 'forwarding', 'blocked', 'terminal'] as const;
const reasons = [null, 'conflict', 'invalid-event', 'redirect'] as const;
const statuses = ['accepted', 'duplicate', 'rejected', 'deadLettered'] as const;
const receiptStates = ['Accepted', 'Queued', 'Dispatching', 'TaskCreated', 'Completed', 'Rejected', 'DeadLettered', 'Expired'] as const;
const eventNumbers = ['received', 'deadline', 'nextAttempt', 'attempt', 'attemptEpoch', 'order', 'generation'] as const;
const sealNumbers = ['generation', 'lastOrder', 'watermark', 'observation', 'epoch'] as const;
export function bad(): never { throw new TableError('corrupt'); }
export function hex(v: unknown): string { if (typeof v !== 'string' || !/^[0-9a-f]{64}$/u.test(v)) bad(); return v; }
function uuid(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v)) bad(); return v;
}
export function validateVersion(v: Readonly<IndexVersion>): void {
  object(v); etag(v.etag); hex(v.digest);
  const t = v.timestamp;
  if (typeof t !== 'string' || t.length > 28 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/u.test(t) ||
      !Number.isFinite(Date.parse(t)) || new Date(t).toISOString().slice(0, 19) !== t.slice(0, 19) || t < '1601') bad();
}
export function validateSummary(e: Readonly<EventSummary>): void {
  // Explicit field reads only: never spread a caller object (even if it has body).
  identity(e.externalEventId); identity(e.replyTarget); hex(e.fingerprint); hex(e.bodyDigest);
  if (e.schema !== 1 || e.fingerprintVersion !== 1 || !states.includes(e.state) || !reasons.includes(e.reason)) bad();
  integer(e.received, 0, MAX_INBOX_TIME); integer(e.deadline, e.received + 1, e.received + MAX_REPLAY_WINDOW_MS);
  integer(e.nextAttempt, 0, Number.MAX_SAFE_INTEGER); integer(e.attempt, 0, Number.MAX_SAFE_INTEGER);
  integer(e.order, 1, MAX_INBOX_RECORDS); integer(e.generation, 1, e.order);
  if (e.attempt === 0) { if (e.attemptId !== null || e.attemptEpoch !== 0 || e.state === 'forwarding') bad(); }
  else { uuid(e.attemptId); integer(e.attemptEpoch, 1, Number.MAX_SAFE_INTEGER); }
  if (e.state === 'blocked' ? e.reason === null : e.reason !== null) bad();
  if (e.state === 'terminal') { object(e.receipt); validateReceipt(e.receipt); }
  else if (e.receipt !== null) bad();
}
export function validateEventInput(input: IndexEventInput): void {
  const e = input.event; validateSummary(e);
  integer(input.payloadBytes, 1, MAX_EVENT_PAYLOAD_BYTES);
  integer(input.bodyEncodingBytes, e.state === 'terminal' ? 0 : 1, e.state === 'terminal' ? 0 : input.payloadBytes);
}
export function validateRouteInput(input: IndexRouteInput): void {
  identity(input.replyTarget); identity(input.externalEventId); identity(input.botId); identity(input.conversationId); hex(input.routeDigest);
  integer(input.payloadBytes, 1, MAX_ROUTE_PAYLOAD_BYTES); integer(input.routeEncodingBytes, 1, input.payloadBytes);
}
export function validateSealSummary(s: Readonly<SealPayload>): void {
  if (s.schema !== 1 || s.kind !== 'generation-seal') bad();
  integer(s.generation, 1, MAX_INBOX_RECORDS); integer(s.lastOrder, s.generation, MAX_INBOX_RECORDS);
  integer(s.watermark, 0, MAX_INBOX_TIME); integer(s.epoch, 1, Number.MAX_SAFE_INTEGER);
  if (s.reason === 'clock-regression') integer(s.observation, 0, s.watermark - 1);
  else if (s.reason !== 'clock-uncertain' || s.observation !== null) bad();
}
export function validateSealInput(input: IndexSealInput): void {
  validateSealSummary(input.seal); integer(input.payloadBytes, 1, MAX_SEAL_PAYLOAD_BYTES);
}
function text(b: Buffer, offset: number, width: number, value: string): number {
  b.fill(0, offset, offset + width); return b.write(value, offset, width, 'utf8');
}
function hash(b: Buffer, offset: number, value: string): void { b.write(value, offset, 32, 'hex'); }
function putId(b: Buffer, n: number, value: string): void { b.writeUInt16LE(text(b, n * 256, 256, value), E.lengths + n * 2); }
export function getId(b: Buffer, base: number, n: number): string {
  const offset = base + n * 256; return b.toString('utf8', offset, offset + b.readUInt16LE(base + E.lengths + n * 2));
}
export function writeSummary(b: Buffer, e: Readonly<EventSummary>): void {
  putId(b, 0, e.externalEventId); putId(b, 1, e.replyTarget);
  hash(b, E.hashes + 64, e.fingerprint); hash(b, E.hashes + 96, e.bodyDigest);
  b.fill(0, E.uuid, E.uuid + 16); if (e.attemptId) b.write(e.attemptId.replaceAll('-', ''), E.uuid, 16, 'hex');
  for (let n = 0; n < eventNumbers.length; n++) b.writeDoubleLE(e[eventNumbers[n]!] as number, E.numbers + n * 8);
  b[E.state] = states.indexOf(e.state); b[E.reason] = reasons.indexOf(e.reason);
  b[E.presence] = (e.attemptId ? 1 : 0) | (e.receipt ? 2 : 0);
  putId(b, 4, e.receipt?.eventId ?? '');
  b[E.receiptStatus] = e.receipt ? statuses.indexOf(e.receipt.status) : 0;
  b[E.receiptState] = e.receipt ? receiptStates.indexOf(e.receipt.state as typeof receiptStates[number]) : 0;
}
export function writeEvent(b: Buffer, input: IndexEventInput): void {
  writeSummary(b, input.event);
  b.writeUInt32LE(input.bodyEncodingBytes, E.bodyLength); b.writeUInt32LE(input.payloadBytes, E.payloadLength);
}
export function writeRoute(b: Buffer, input: IndexRouteInput): void {
  putId(b, 2, input.botId); putId(b, 3, input.conversationId); hash(b, E.hashes + 128, input.routeDigest);
  b.writeUInt32LE(input.routeEncodingBytes, E.routeLength); b.writeUInt32LE(input.payloadBytes, E.routePayloadLength);
}
export function writeSeal(b: Buffer, input: IndexSealInput): void {
  for (let n = 0; n < sealNumbers.length; n++) b.writeDoubleLE(input.seal[sealNumbers[n]!] ?? 0, S.numbers + n * 8);
  b[S.reason] = input.seal.reason === 'clock-regression' ? 0 : 1; b[S.observation] = input.seal.observation === null ? 0 : 1;
  b.writeUInt32LE(input.payloadBytes, S.payloadLength);
}
export function versionOffsets(type: 'event' | 'route' | 'control'): { etag: number; hash: number; stamp: number; etagLength: number; stampLength: number; pass: number } {
  if (type === 'control') return { etag: S.etag, hash: S.hash, stamp: S.timestamp, etagLength: S.etagLength, stampLength: S.timestampLength, pass: S.pass };
  const route = type === 'route' ? 1 : 0;
  return { etag: E.etags + route * 256, hash: E.hashes + route * 32, stamp: E.timestamps + route * 28,
    etagLength: E.lengths + 10 + route * 2, stampLength: E.lengths + 14 + route, pass: route ? E.routePass : E.eventPass };
}
export function writeVersion(b: Buffer, type: 'event' | 'route' | 'control', v: Readonly<IndexVersion>): void {
  const o = versionOffsets(type); b.writeUInt16LE(text(b, o.etag, 256, v.etag), o.etagLength);
  hash(b, o.hash, v.digest); b[o.stampLength] = text(b, o.stamp, 28, v.timestamp);
}
export function readVersion(b: Buffer, base: number, type: 'event' | 'route' | 'control'): IndexVersion {
  const o = versionOffsets(type);
  return { etag: b.toString('utf8', base + o.etag, base + o.etag + b.readUInt16LE(base + o.etagLength)),
    digest: b.toString('hex', base + o.hash, base + o.hash + 32),
    timestamp: b.toString('utf8', base + o.stamp, base + o.stamp + b[base + o.stampLength]!) };
}
export function readEvent(b: Buffer, base: number): EventSummary {
  const n = (index: number) => b.readDoubleLE(base + E.numbers + index * 8);
  const u = b.toString('hex', base + E.uuid, base + E.uuid + 16);
  return { schema: 1, fingerprintVersion: 1, externalEventId: getId(b, base, 0), replyTarget: getId(b, base, 1),
    fingerprint: b.toString('hex', base + E.hashes + 64, base + E.hashes + 96),
    bodyDigest: b.toString('hex', base + E.hashes + 96, base + E.hashes + 128), state: states[b[base + E.state]!]!,
    received: n(0), deadline: n(1), nextAttempt: n(2), attempt: n(3), attemptEpoch: n(4), order: n(5), generation: n(6),
    attemptId: b[base + E.presence]! & 1 ? `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}` : null,
    receipt: b[base + E.presence]! & 2 ? { status: statuses[b[base + E.receiptStatus]!]!, eventId: getId(b, base, 4), state: receiptStates[b[base + E.receiptState]!]! } : null,
    reason: reasons[b[base + E.reason]!]! };
}
export function readRoute(b: Buffer, base: number): IndexRouteInput {
  return { externalEventId: getId(b, base, 0), replyTarget: getId(b, base, 1), botId: getId(b, base, 2), conversationId: getId(b, base, 3),
    routeDigest: b.toString('hex', base + E.hashes + 128, base + E.hashes + 160),
    routeEncodingBytes: b.readUInt32LE(base + E.routeLength), payloadBytes: b.readUInt32LE(base + E.routePayloadLength) };
}
export function readSeal(b: Buffer, base: number): SealPayload {
  const n = (index: number) => b.readDoubleLE(base + S.numbers + index * 8);
  return { schema: 1, kind: 'generation-seal', generation: n(0), lastOrder: n(1), watermark: n(2),
    observation: b[base + S.observation] ? n(3) : null, epoch: n(4), reason: b[base + S.reason] ? 'clock-uncertain' : 'clock-regression' };
}
