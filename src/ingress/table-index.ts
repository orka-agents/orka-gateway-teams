import { integer } from '../storage/table/codec.js';
import { OWNED_AUDIT_BUDGET_EXHAUSTED, TableError } from '../storage/table/types.js';
import type { DataKey } from '../storage/table/types.js';
import { identity } from './codec.js';
import { decodeState, encodeState } from './table-codec.js';
import { projectEvent } from './table-state.js';
import { MAX_INBOX_RECORDS, MAX_INBOX_TIME } from './table-types.js';
import type { EventSummary, InboxGraph, InboxState, SealPayload } from './table-types.js';
import { bad, E, S, getId, hex, readEvent, readRoute, readSeal, readVersion, validateEventInput, validateRouteInput,
  validateSealInput, validateSealSummary, validateSummary, validateVersion, versionOffsets, writeEvent, writeRoute, writeSeal, writeSummary, writeVersion } from './table-index-slots.js';
import type { EventIndexRow, IndexEventInput, IndexRouteInput, IndexSealInput, IndexVersion, RouteIndexRow, SealIndexRow } from './table-index-slots.js';
export type { EventIndexRow, IndexEventInput, IndexRouteInput, IndexSealInput, IndexVersion, RouteIndexRow, SealIndexRow } from './table-index-slots.js';

export type IndexWorkingPhase = 'meta' | 'scratch' | 'frame' | 'delta' | 'derivedKeys';
declare const creditBrand: unique symbol;
export interface IndexWorkingCredit { readonly [creditBrand]: true }
export interface FirstDueOverlay { event?: Readonly<EventSummary>; seal?: Readonly<SealPayload> }
declare const deltaBrand: unique symbol;
export interface PreparedIndexDelta { readonly [deltaBrand]: true }
export interface IndexDeltaInput {
  state: Readonly<InboxState>; event?: IndexEventInput; route?: IndexRouteInput; seal?: IndexSealInput;
  /** Exact envelope digests from the later store's private planner bytes, not
   * digests reconstructed from these reduced body-free summaries. */
  manifest: readonly { key: Readonly<DataKey>; digest: string }[];
}
interface Staged {
  token: PreparedIndexDelta; event: Buffer | undefined; seal: Buffer | undefined; state: Buffer | undefined;
  stateLength: number; eventSlot: number; sealSlot: number; order: number; generation: number; create: boolean;
  mask: number; refreshed: number; confirmed: boolean; bytes: number; growth: Growth;
}
export interface IndexDiagnostics {
  chargedBytes: number; peakBytes: number; events: number; routes: number; seals: number;
  eventCapacity: number; sealCapacity: number; identityBuckets: number; ordinalCapacity: number; generationCapacity: number;
  working: Record<IndexWorkingPhase, number>;
}
const phases: readonly IndexWorkingPhase[] = ['meta', 'scratch', 'frame', 'delta', 'derivedKeys'];
const quotas = [65536, 2359296, 1048576, 524288, 65536] as const;
const WORKING = 4194304;
// Fixed six-entry vectors, not row-indexed JS arrays: events, seals, ID map,
// target map, ordinal references, generation references. All are Buffer-backed.
type Buffers = [Buffer | undefined, Buffer | undefined, Buffer | undefined, Buffer | undefined, Buffer | undefined, Buffer | undefined];
interface Growth { buffers: Buffers; bytes: number }
const widths = [4096, 512, 8, 8, 4, 4] as const;
const caps = [131072, 131072, 262144, 262144, 131072, 131072] as const;
const blank = (): Buffers => [undefined, undefined, undefined, undefined, undefined, undefined];
function indexBuffer(bytes: number): Buffer {
  try { return Buffer.alloc(bytes); } catch { throw OWNED_AUDIT_BUDGET_EXHAUSTED; }
}
function power(n: number): number { let v = n ? 1 : 0; while (v < n) v *= 2; return v; }
function fnv(b: Buffer): number { let h = 2166136261; for (const byte of b) h = Math.imul(h ^ byte, 16777619); return h >>> 0; }
function sameVersion(a: IndexVersion, b: Readonly<IndexVersion>): boolean {
  return a.etag === b.etag && a.digest === b.digest && a.timestamp === b.timestamp;
}

/** Private projection only: no I/O, owned-job completion, ownership or Ready claim.
 * Construct outside audit; begin inside its owned callback. Pass1 adds physical
 * control/event/route rows; pass2 proves versions/membership; finishBuild proves
 * the local graph. Only the OUTER successful audit may expose this projection.
 * Returned summaries/strings are fresh and caller-owned; callers retaining them
 * must charge their actual Buffer capacities and 2 bytes/UTF16 unit in a named
 * working credit BEFORE the copy. No JS headers/native hash/SDK/GC/RSS claim. */
export class InboxIndex implements InboxGraph {
  readonly maxIndexBytes: number;
  #life: 'new' | 'pass1' | 'pass2' | 'checked' | 'built' | 'retired' | 'disposed' = 'new';
  #buffers: Buffers = blank();
  #charged = 0; #peak = 0; #events = 0; #routes = 0; #seals = 0; #physicalPhase = 0;
  #used = [0, 0, 0, 0, 0];
  #credits: (undefined | { token: IndexWorkingCredit; bytes: number })[] = [undefined, undefined, undefined, undefined, undefined];
  #state: Buffer | undefined; #stateLength = 0;
  #prepared: Staged | undefined;
  constructor(maxIndexBytes: number) {
    integer(maxIndexBytes, 1, 1024 * 1024 * 1024); this.maxIndexBytes = maxIndexBytes;
  }
  #alive(): void { if (this.#life === 'new' || this.#life === 'disposed' || this.#life === 'retired') bad(); }
  #reserve(bytes: number): void {
    if (bytes > this.maxIndexBytes - this.#charged) throw OWNED_AUDIT_BUDGET_EXHAUSTED;
    this.#charged += bytes; this.#peak = Math.max(this.#peak, this.#charged);
  }
  #credit(phase: number, bytes: number): void {
    if (bytes > quotas[phase]! - this.#used[phase]!) throw OWNED_AUDIT_BUDGET_EXHAUSTED;
    this.#used[phase]! += bytes;
  }
  #work<T>(work: () => T): T {
    this.#alive();
    // One call's slot copy, exact key bytes, binary conversion temporaries and
    // bounded reconstructed strings fit 32KiB. Nested graph reads also charge.
    this.#credit(1, 32768);
    try { return work(); } catch (e) {
      if (e === OWNED_AUDIT_BUDGET_EXHAUSTED) throw e;
      throw new TableError('corrupt');
    } finally { this.#used[1]! -= 32768; }
  }
  begin(): void {
    if (this.#life !== 'new') bad();
    this.#reserve(WORKING);
    try { this.#state = indexBuffer(4096); }
    catch { this.#charged = 0; throw OWNED_AUDIT_BUDGET_EXHAUSTED; }
    this.#used[0] = 4096; this.#life = 'pass1';
  }
  /** One external credit per named phase, shared with index-internal use.
   * Keep it through actual lifetime/drain; the index cannot infer SDK lifetimes.
   * The 128KiB headroom is not exposed as additional authorization. */
  reserveWorking(phase: IndexWorkingPhase, bytes: number): IndexWorkingCredit {
    this.#alive(); const p = phases.indexOf(phase);
    if (p < 0 || !Number.isSafeInteger(bytes) || bytes < 0) bad();
    this.#credit(p, bytes);
    if (this.#credits[p]) { this.#used[p]! -= bytes; bad(); }
    const token = Object.freeze({}) as IndexWorkingCredit;
    this.#credits[p] = { token, bytes }; return token;
  }
  releaseWorking(token: IndexWorkingCredit): void {
    if (this.#life === 'new' || this.#life === 'disposed') bad();
    const p = this.#credits.findIndex(c => c?.token === token);
    if (p < 0) bad(); this.#used[p]! -= this.#credits[p]!.bytes; this.#credits[p] = undefined;
  }
  diagnostics(): IndexDiagnostics {
    const capacity = (i: number) => (this.#buffers[i]?.length ?? 0) / widths[i]!;
    return { chargedBytes: this.#charged, peakBytes: this.#peak, events: this.#events, routes: this.#routes, seals: this.#seals,
      eventCapacity: capacity(0), sealCapacity: capacity(1), identityBuckets: capacity(2), ordinalCapacity: capacity(4), generationCapacity: capacity(5),
      working: { meta: this.#used[0]!, scratch: this.#used[1]!, frame: this.#used[2]!, delta: this.#used[3]!, derivedKeys: this.#used[4]! } };
  }
  #mapFind(key: string, target: boolean, buffers = this.#buffers): number {
    const bytes = Buffer.from(identity(key)); const map = buffers[target ? 3 : 2]; if (!map) return -1;
    const arena = buffers[0]!; const count = map.length / 8; const hash = fnv(bytes);
    for (let probe = 0, bucket = hash & (count - 1); probe < count; probe++, bucket = (bucket + 1) & (count - 1)) {
      const ref = map.readUInt32LE(bucket * 8); if (!ref) return -1;
      const base = (ref - 1) * 4096; const n = target ? 1 : 0;
      if (map.readUInt32LE(bucket * 8 + 4) === hash && arena.readUInt16LE(base + E.lengths + n * 2) === bytes.length &&
          arena.compare(bytes, 0, bytes.length, base + n * 256, base + n * 256 + bytes.length) === 0) return ref - 1;
    }
    return bad();
  }
  #mapInsert(map: Buffer, arena: Buffer, slot: number, target: boolean): void {
    const base = slot * 4096; const n = target ? 1 : 0;
    const bytes = arena.subarray(base + n * 256, base + n * 256 + arena.readUInt16LE(base + E.lengths + n * 2));
    const hash = fnv(bytes); const count = map.length / 8;
    for (let probe = 0, bucket = hash & (count - 1); probe < count; probe++, bucket = (bucket + 1) & (count - 1)) {
      if (!map.readUInt32LE(bucket * 8)) { map.writeUInt32LE(slot + 1, bucket * 8); map.writeUInt32LE(hash, bucket * 8 + 4); return; }
    }
    bad();
  }
  #ref(array: number, ordinal: number): number {
    integer(ordinal, 1, MAX_INBOX_RECORDS); const b = this.#buffers[array];
    return b && ordinal <= b.length / 4 ? b.readUInt32LE((ordinal - 1) * 4) - 1 : -1;
  }
  #grow(events: number, seals: number, order: number, generation: number): Growth {
    integer(events, 0, MAX_INBOX_RECORDS); integer(seals, 0, MAX_INBOX_RECORDS);
    integer(order, 0, MAX_INBOX_RECORDS); integer(generation, 0, MAX_INBOX_RECORDS);
    const needs = [events, seals, 2 * events, 2 * events, order, generation];
    const sizes = needs.map((n, i) => Math.max(this.#buffers[i]?.length ?? 0, power(n) * widths[i]!));
    const growth: Growth = { buffers: blank(), bytes: 0 };
    for (let i = 0; i < 6; i++) {
      if (sizes[i]! > caps[i]! * widths[i]!) bad();
      if (sizes[i]! > (this.#buffers[i]?.length ?? 0)) growth.bytes += sizes[i]!;
    }
    // ALL replacements charged in one enrollment while every old reference lives.
    this.#reserve(growth.bytes);
    try {
      for (let i = 0; i < 6; i++) if (sizes[i]! > (this.#buffers[i]?.length ?? 0)) {
        const b = indexBuffer(sizes[i]!); growth.buffers[i] = b;
        if (i === 2 || i === 3) {
          for (let slot = 0; slot < this.#events; slot++) this.#mapInsert(b, this.#buffers[0]!, slot, i === 3);
        } else this.#buffers[i]?.copy(b);
      }
      return growth;
    } catch (e) { this.#discardGrowth(growth); throw e; }
  }
  #discardGrowth(growth: Growth): void {
    growth.buffers = blank(); this.#charged -= growth.bytes; growth.bytes = 0;
  }
  #installGrowth(growth: Growth): void {
    let released = 0;
    for (let i = 0; i < 6; i++) if (growth.buffers[i]) {
      released += this.#buffers[i]?.length ?? 0;
      this.#buffers[i] = growth.buffers[i]; growth.buffers[i] = undefined;
    }
    // No store reference to old backing buffers remains at this point.
    this.#charged -= released; growth.bytes = 0;
  }
  addEvent(input: EventIndexRow): void { this.#work(() => {
    if (this.#life !== 'pass1' || this.#physicalPhase > 1) bad();
    validateEventInput(input); validateVersion(input.version);
    const e = input.event;
    if (this.#mapFind(e.externalEventId, false) >= 0 || this.#mapFind(e.replyTarget, true) >= 0 || this.#ref(4, e.order) >= 0) bad();
    const slot = indexBuffer(4096); writeEvent(slot, input); writeVersion(slot, 'event', input.version); slot[E.eventPass] = 1;
    const growth = this.#grow(this.#events + 1, this.#seals, e.order, 0); this.#installGrowth(growth);
    slot.copy(this.#buffers[0]!, this.#events * 4096);
    this.#mapInsert(this.#buffers[2]!, this.#buffers[0]!, this.#events, false);
    this.#mapInsert(this.#buffers[3]!, this.#buffers[0]!, this.#events, true);
    this.#buffers[4]!.writeUInt32LE(this.#events + 1, (e.order - 1) * 4);
    this.#events++; this.#physicalPhase = 1;
  }); }
  addRoute(input: RouteIndexRow): void { this.#work(() => {
    if (this.#life !== 'pass1') bad(); validateRouteInput(input); validateVersion(input.version);
    const slot = this.#mapFind(input.replyTarget, true); if (slot < 0) bad();
    const base = slot * 4096; const arena = this.#buffers[0]!;
    if (getId(arena, base, 0) !== input.externalEventId || arena[base + E.routePass]) bad();
    const copy = indexBuffer(4096); arena.copy(copy, 0, base, base + 4096);
    writeRoute(copy, input); writeVersion(copy, 'route', input.version); copy[E.routePass] = 1;
    copy.copy(arena, base); this.#routes++; this.#physicalPhase = 2;
  }); }
  addSeal(input: SealIndexRow): void { this.#work(() => {
    if (this.#life !== 'pass1' || this.#physicalPhase !== 0) bad(); validateSealInput(input); validateVersion(input.version);
    const s = input.seal; if (this.#ref(5, s.generation) >= 0) bad();
    const slot = indexBuffer(512); writeSeal(slot, input); writeVersion(slot, 'control', input.version); slot[S.pass] = 1;
    const growth = this.#grow(this.#events, this.#seals + 1, 0, s.generation); this.#installGrowth(growth);
    slot.copy(this.#buffers[1]!, this.#seals * 512);
    this.#buffers[5]!.writeUInt32LE(this.#seals + 1, (s.generation - 1) * 4); this.#seals++;
  }); }
  #locate(key: Readonly<DataKey>): { buffer: Buffer; base: number; type: 'event' | 'route' | 'control' } {
    if (key.type === 'event' || key.type === 'route') {
      const slot = this.#mapFind(key.id, key.type === 'route'); if (slot < 0) bad();
      const buffer = this.#buffers[0]!; const base = slot * 4096;
      if (key.type === 'route' && !buffer[base + E.routePass]) bad(); return { buffer, base, type: key.type };
    }
    if (key.type !== 'control' || !/^generation:[1-9][0-9]{0,5}$/u.test(key.id)) bad();
    const generation = Number(key.id.slice(11)); const slot = this.#ref(5, generation); if (slot < 0) bad();
    return { buffer: this.#buffers[1]!, base: slot * 512, type: 'control' };
  }
  version(key: Readonly<DataKey>): IndexVersion { return this.#work(() => {
    const row = this.#locate(key); return readVersion(row.buffer, row.base, row.type);
  }); }
  checkVersion(key: Readonly<DataKey>, version: Readonly<IndexVersion>): void { this.#work(() => {
    validateVersion(version); const row = this.#locate(key);
    if (!sameVersion(readVersion(row.buffer, row.base, row.type), version)) bad();
  }); }
  seePass2(key: Readonly<DataKey>, version: Readonly<IndexVersion>): void { this.#work(() => {
    if (this.#life !== 'pass2') bad(); validateVersion(version); const row = this.#locate(key); const offset = row.base + versionOffsets(row.type).pass;
    if (row.buffer[offset] !== 1 || !sameVersion(readVersion(row.buffer, row.base, row.type), version)) bad(); row.buffer[offset] = 3;
  }); }
  endPass(pass: 1 | 2): void { this.#work(() => {
    if ((pass === 1 && this.#life !== 'pass1') || (pass === 2 && this.#life !== 'pass2') || (pass !== 1 && pass !== 2)) bad();
    if (this.#events !== this.#routes) bad();
    const expected = pass === 1 ? 1 : 3;
    for (let slot = 0; slot < this.#events; slot++) if (this.#buffers[0]![slot * 4096 + E.eventPass] !== expected ||
        this.#buffers[0]![slot * 4096 + E.routePass] !== expected) bad();
    for (let slot = 0; slot < this.#seals; slot++) if (this.#buffers[1]![slot * 512 + S.pass] !== expected) bad();
    this.#life = pass === 1 ? 'pass2' : 'checked';
  }); }
  eventById(id: string): EventSummary | undefined { return this.#work(() => {
    const slot = this.#mapFind(id, false); return slot < 0 ? undefined : readEvent(this.#buffers[0]!, slot * 4096);
  }); }
  eventByTarget(target: string): EventSummary | undefined { return this.#work(() => {
    const slot = this.#mapFind(target, true); return slot < 0 ? undefined : readEvent(this.#buffers[0]!, slot * 4096);
  }); }
  eventByOrder(order: number): EventSummary | undefined { return this.#work(() => {
    const slot = this.#ref(4, order); return slot < 0 ? undefined : readEvent(this.#buffers[0]!, slot * 4096);
  }); }
  sealByGeneration(generation: number): SealPayload | undefined { return this.#work(() => {
    const slot = this.#ref(5, generation); return slot < 0 ? undefined : readSeal(this.#buffers[1]!, slot * 512);
  }); }
  routeByTarget(target: string): IndexRouteInput | undefined { return this.#work(() => {
    const slot = this.#mapFind(target, true); if (slot < 0 || !this.#buffers[0]![slot * 4096 + E.routePass]) return undefined;
    return readRoute(this.#buffers[0]!, slot * 4096);
  }); }
  eventLengths(id: string): { bodyEncodingBytes: number; payloadBytes: number } { return this.#work(() => {
    const slot = this.#mapFind(id, false); if (slot < 0) bad(); const base = slot * 4096;
    return { bodyEncodingBytes: this.#buffers[0]!.readUInt32LE(base + E.bodyLength), payloadBytes: this.#buffers[0]!.readUInt32LE(base + E.payloadLength) };
  }); }
  #graph(state: Readonly<InboxState>, graph: InboxGraph, events: number, routes: number, seals: number): void {
    if (state.records !== events || routes !== events || seals > events) bad();
    let next = 1, bodies = 0, seenSeals = 0, received = 0, priorWatermark = 0;
    while (next <= events) {
      const generation = next; const seal = graph.sealByGeneration(generation);
      let last: number;
      if (seal) {
        if (seal.lastOrder > events || seal.watermark > state.lastNow || seal.watermark < priorWatermark || state.currentGeneration === generation) bad();
        last = seal.lastOrder; seenSeals++;
      } else { if (state.currentGeneration !== generation) bad(); last = events; }
      for (; next <= last; next++) {
        const e = graph.eventByOrder(next);
        if (!e || e.order !== next || e.generation !== generation || e.received < received || e.received < priorWatermark) bad();
        projectEvent(e, state, seal); received = e.received; if (e.state !== 'terminal') bodies++;
      }
      if (seal) priorWatermark = seal.watermark;
    }
    if (bodies !== state.bodies || seenSeals !== seals || (events === 0 && state.currentGeneration !== null)) bad();
  }
  finishBuild(state: Readonly<InboxState>): void { this.#work(() => {
    if (this.#life !== 'checked') bad(); const bytes = encodeState(state); const normalized = decodeState(bytes);
    this.#graph(normalized, this, this.#events, this.#routes, this.#seals);
    bytes.copy(this.#state!); this.#stateLength = bytes.length; this.#life = 'built';
  }); }
  state(): InboxState { return this.#work(() => {
    if (this.#life !== 'built') bad(); return decodeState(this.#state!.subarray(0, this.#stateLength));
  }); }
  firstDue(time: number, state?: Readonly<InboxState>, overlay?: Readonly<FirstDueOverlay>): EventSummary | undefined { return this.#work(() => {
    integer(time, 0, MAX_INBOX_TIME); const s = state ? decodeState(encodeState(state)) : this.state();
    if (overlay?.event) { validateSummary(overlay.event); if (overlay.event.order > s.records) bad(); }
    if (overlay?.seal) { validateSealSummary(overlay.seal); if (overlay.seal.lastOrder > s.records) bad(); }
    for (let order = 1; order <= s.records; order++) {
      const e = overlay?.event?.order === order ? overlay.event : this.eventByOrder(order); if (!e) bad();
      const seal = overlay?.seal?.generation === e.generation ? overlay.seal : this.sealByGeneration(e.generation);
      if (projectEvent(e, s, seal).state === 'pending' && e.nextAttempt <= time) {
        // Explicit copy through a bounded slot strips even caller overlay extras.
        const slot = indexBuffer(4096); writeSummary(slot, e); return readEvent(slot, 0);
      }
    }
    return undefined;
  }); }
  /** Reserve growth plus all bounded private slot/manifest copies BEFORE the
   * store submits a mutation. Existing rows and state stay untouched. One token
   * only; the index checks structure/immutability, not business transitions. */
  prepare(input: Readonly<IndexDeltaInput>): PreparedIndexDelta { return this.#work(() => {
    if (this.#life !== 'built' || this.#prepared) bad();
    const stateBytes = encodeState(input.state); const next = decodeState(stateBytes);
    if (!Array.isArray(input.manifest) || input.manifest.length > 3) bad();
    if (input.event) validateEventInput(input.event);
    if (input.route) validateRouteInput(input.route);
    if (input.seal) validateSealInput(input.seal);
    const e = input.event?.event; const s = input.seal?.seal;
    const eventSlot = e ? this.#mapFind(e.externalEventId, false) : -1;
    const create = e !== undefined && eventSlot < 0;
    if (create) {
      if (!input.route || e.order !== this.#events + 1 || this.#mapFind(e.replyTarget, true) >= 0 || this.#ref(4, e.order) >= 0) bad();
    } else if (input.route) bad(); // Retained routes are immutable create-only.
    if (e && !create) {
      const old = readEvent(this.#buffers[0]!, eventSlot * 4096);
      for (const key of ['externalEventId', 'replyTarget', 'fingerprint', 'bodyDigest', 'received', 'deadline', 'order', 'generation'] as const) {
        if (e[key] !== old[key]) bad();
      }
    }
    if (input.route && (!e || input.route.externalEventId !== e.externalEventId || input.route.replyTarget !== e.replyTarget)) bad();
    if (s && this.#ref(5, s.generation) >= 0) bad(); // Seals are immutable too.
    const mask = (e ? 1 : 0) | (input.route ? 2 : 0) | (s ? 4 : 0);
    let seen = 0;
    // Validate every manifest before reserving; no caller objects/strings survive.
    for (const item of input.manifest) {
      hex(item.digest); const k = item.key;
      const bit = e && k.type === 'event' && k.id === e.externalEventId ? 1 : input.route && k.type === 'route' && k.id === input.route.replyTarget ? 2 :
        s && k.type === 'control' && k.id === `generation:${s.generation}` ? 4 : 0;
      if (!bit || (seen & bit)) bad(); seen |= bit;
    }
    if (seen !== mask) bad();
    // Manifest keys derive from these copied identities/ordinal, and expected
    // digests occupy the corresponding binary version fields. No JS key cache.
    const bytes = 4096 + (e ? 4096 : 0) + (s ? 512 : 0);
    this.#credit(3, bytes);
    const staged: Staged = { token: Object.freeze({}) as PreparedIndexDelta, event: undefined, seal: undefined, state: undefined,
      stateLength: stateBytes.length, eventSlot: create ? this.#events : eventSlot, sealSlot: this.#seals, order: e?.order ?? 0,
      generation: s?.generation ?? 0, create, mask, refreshed: 0, confirmed: false, bytes, growth: { buffers: blank(), bytes: 0 } };
    try {
      staged.state = indexBuffer(4096); stateBytes.copy(staged.state);
      if (input.event) {
        staged.event = indexBuffer(4096);
        if (!create) this.#buffers[0]!.copy(staged.event, 0, eventSlot * 4096, (eventSlot + 1) * 4096);
        writeEvent(staged.event, input.event); staged.event[E.eventPass] = 3;
        if (input.route) { writeRoute(staged.event, input.route); staged.event[E.routePass] = 3; }
      }
      if (input.seal) { staged.seal = indexBuffer(512); writeSeal(staged.seal, input.seal); staged.seal[S.pass] = 3; }
      for (const item of input.manifest) {
        const type = item.key.type as 'event' | 'route' | 'control';
        (type === 'control' ? staged.seal! : staged.event!).write(item.digest, versionOffsets(type).hash, 32, 'hex');
      }
      // A temporary body-free facade over the copied slots validates the whole
      // next graph without modifying/rekeying a single published slot.
      const graph: InboxGraph = {
        eventByOrder: order => staged.event && order === staged.order ? readEvent(staged.event, 0) : this.eventByOrder(order),
        sealByGeneration: generation => staged.seal && generation === staged.generation ? readSeal(staged.seal, 0) : this.sealByGeneration(generation),
        eventById: id => staged.event && getId(staged.event, 0, 0) === id ? readEvent(staged.event, 0) : this.eventById(id),
        eventByTarget: target => staged.event && getId(staged.event, 0, 1) === target ? readEvent(staged.event, 0) : this.eventByTarget(target),
      };
      this.#graph(next, graph, this.#events + (create ? 1 : 0), this.#routes + (create ? 1 : 0), this.#seals + (s ? 1 : 0));
      staged.growth = this.#grow(this.#events + (create ? 1 : 0), this.#seals + (s ? 1 : 0), staged.order, staged.generation);
      this.#prepared = staged; return staged.token;
    } catch (error) { this.#dropStaged(staged); throw error; }
  }); }
  #staged(token: PreparedIndexDelta): Staged {
    if (this.#life !== 'built' || !this.#prepared || this.#prepared.token !== token) bad(); return this.#prepared;
  }
  #dropStaged(staged: Staged): void {
    staged.event = undefined; staged.seal = undefined; staged.state = undefined;
    this.#discardGrowth(staged.growth); this.#used[3]! -= staged.bytes; staged.bytes = 0;
    if (this.#prepared === staged) this.#prepared = undefined;
  }
  /** This is an explicit STORE assertion after kernel confirmation. The index
   * has no I/O and cannot establish commit proof or authorize mutation replay. */
  confirm(token: PreparedIndexDelta): void { this.#work(() => {
    const staged = this.#staged(token); if (staged.confirmed) bad(); staged.confirmed = true;
  }); }
  /** Kernel-validated owned read versions only, after confirmed own write.
   * Domain payload/summary equality and exact planner-byte provenance remain
   * outer auditor/store obligations; the manifest digest binds those bytes. */
  refresh(token: PreparedIndexDelta, key: Readonly<DataKey>, version: Readonly<IndexVersion>): void { this.#work(() => {
    const staged = this.#staged(token); if (!staged.confirmed) bad(); validateVersion(version);
    const bit = staged.event && key.type === 'event' && key.id === getId(staged.event, 0, 0) ? 1 :
      (staged.mask & 2) && staged.event && key.type === 'route' && key.id === getId(staged.event, 0, 1) ? 2 :
        staged.seal && key.type === 'control' && key.id === `generation:${staged.generation}` ? 4 : 0;
    if (!bit) { this.checkVersion(key, version); return; }
    const type = key.type as 'event' | 'route' | 'control'; const buffer = bit === 4 ? staged.seal! : staged.event!;
    const offset = versionOffsets(type).hash;
    if (staged.refreshed & bit || buffer.toString('hex', offset, offset + 32) !== version.digest) bad();
    writeVersion(buffer, type, version); staged.refreshed |= bit;
  }); }
  /** No caller callback, I/O, revalidation or backing-buffer allocation is
   * interleaved here. Growth was allocated/rehash-prepared before submission. */
  publish(token: PreparedIndexDelta): void { this.#work(() => {
    const staged = this.#staged(token);
    if (!staged.confirmed || staged.refreshed !== staged.mask) bad();
    this.#installGrowth(staged.growth);
    if (staged.event) {
      staged.event.copy(this.#buffers[0]!, staged.eventSlot * 4096);
      if (staged.create) {
        this.#mapInsert(this.#buffers[2]!, this.#buffers[0]!, staged.eventSlot, false);
        this.#mapInsert(this.#buffers[3]!, this.#buffers[0]!, staged.eventSlot, true);
        this.#buffers[4]!.writeUInt32LE(staged.eventSlot + 1, (staged.order - 1) * 4); this.#events++; this.#routes++;
      }
    }
    if (staged.seal) {
      staged.seal.copy(this.#buffers[1]!, staged.sealSlot * 512);
      this.#buffers[5]!.writeUInt32LE(staged.sealSlot + 1, (staged.generation - 1) * 4); this.#seals++;
    }
    staged.state!.copy(this.#state!); this.#stateLength = staged.stateLength; this.#dropStaged(staged);
  }); }
  abort(token: PreparedIndexDelta): void { this.#work(() => {
    const staged = this.#staged(token); if (staged.confirmed) bad(); this.#dropStaged(staged);
  }); }
  discardConfirmed(token: PreparedIndexDelta): void { this.#work(() => {
    const staged = this.#staged(token); if (!staged.confirmed) bad(); this.#dropStaged(staged); this.#life = 'retired';
  }); }
  dispose(): void {
    if (this.#life === 'disposed') return;
    if (this.#prepared) this.#dropStaged(this.#prepared);
    this.#buffers = blank(); this.#state = undefined; this.#stateLength = 0;
    this.#credits.fill(undefined); this.#used.fill(0); this.#charged = 0;
    this.#events = 0; this.#routes = 0; this.#seals = 0; this.#life = 'disposed';
  }
}
