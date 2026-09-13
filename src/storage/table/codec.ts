import { createHash } from 'node:crypto';
import { identity, validateScope as deliveryScope } from '../../delivery/identity.js';
import { validateScope as ingressScope } from '../../ingress/codec.js';
import { MAX_PAYLOAD_BYTES, MAX_RESPONSE_BYTES, TableError } from './types.js';
import type { BoundTable, DataKey, DataRecord, ExitReceipt, Metadata, MetadataV2, RecordValue, RecordValueV2, StoredRecord, StoredRecordV2, TableBinding } from './types.js';

export function fail(): never { throw new TableError('invalid-input'); }
export function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !d.enumerable || !('value' in d) || (keys && !keys.includes(key))) fail();
  }
  return value as Record<string, unknown>;
}
export function bytes(value: unknown, max: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength > max) fail();
  return Buffer.from(value);
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(); return value;
}
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function bindTable(value: TableBinding): BoundTable {
  try {
    const v = object(value, ['account', 'table', 'storeId', 'kind', 'scope']);
    if (typeof v.account !== 'string' || !/^[a-z0-9]{3,24}$/iu.test(v.account) || typeof v.table !== 'string' ||
        !/^[a-z][a-z0-9]{2,62}$/iu.test(v.table) || !['ingress', 'delivery'].includes(v.kind as string)) fail();
    const kind = v.kind as 'ingress' | 'delivery'; const account = v.account.toLowerCase(); const table = v.table.toLowerCase();
    const storeId = identity(v.storeId);
    // Guard descriptors before reusing the established pure scope validators.
    object(v.scope);
    const scope = kind === 'delivery' ? deliveryScope(v.scope) : ingressScope(v.scope);
    const scopeFields = kind === 'delivery' ? [scope.appId, scope.tenantId] :
      [scope.appId, scope.tenantId, (scope as ReturnType<typeof ingressScope>).orkaBaseUrl,
        (scope as ReturnType<typeof ingressScope>).gatewayNamespace, (scope as ReturnType<typeof ingressScope>).gatewayName];
    const encoded = Buffer.from(JSON.stringify(['orka-table-v1', account, table, kind, storeId, scopeFields]));
    return { account, table, kind, partition: `v1_${kind}_${Buffer.from(storeId).toString('base64url')}`, bytes: bytes(encoded, 16384) };
  } catch { throw new TableError('invalid-input'); }
}
export function dataRow(binding: BoundTable, key: DataKey): string {
  try {
    const v = object(key, ['type', 'id']);
    if (!(binding.kind === 'ingress' ? ['event', 'route', 'control'] : ['delivery', 'alias', 'control']).includes(v.type as string)) fail();
    return `${v.type}_${Buffer.from(identity(v.id)).toString('base64url')}`;
  } catch { throw new TableError('invalid-input'); }
}
export function etag(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || !/^(?:W\/)?"[\x21\x23-\x7e]+"$/u.test(value)) fail(); return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) fail(); return value;
}
function hex(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) fail(); return value; }
function binary(value: unknown, max: number): Buffer {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(max / 3)) fail();
  const result = Buffer.from(value, 'base64'); if (result.toString('base64') !== value || result.length > max) fail(); return result;
}
export function initializationDigest(binding: BoundTable, id: string): string { return digest(['orka-init-v1', binding.bytes.toString('base64'), id]); }
export function metadata(binding: BoundTable, value: Omit<Metadata, 'digest' | 'kind'>): Metadata {
  const m = { kind: 'metadata' as const, ...value };
  return { ...m, digest: digest(['orka-m-v1', binding.bytes.toString('base64'), m.initId, m.initDigest, m.owner, m.epoch,
    m.invocation, m.operation, m.plan, m.state.toString('base64'), m.result.toString('base64'), m.release.toString('base64')]) };
}
export function data(binding: BoundTable, key: DataKey, payload: Uint8Array): DataRecord {
  dataRow(binding, key); const copy = bytes(payload, MAX_PAYLOAD_BYTES);
  return { kind: 'data', type: key.type, id: key.id, payload: copy,
    digest: digest(['orka-data-v1', binding.bytes.toString('base64'), key.type, key.id, copy.toString('base64')]) };
}

/** Bounded JSON grammar detects decoded-key duplicates before JSON/SDK projection. */
export function rawJSON(body: Uint8Array): unknown {
  try {
    if (body.byteLength > MAX_RESPONSE_BYTES) fail();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    let pos = 0; let nodes = 0;
    const space = () => { while (/[\x20\t\r\n]/u.test(text[pos] ?? '!')) pos++; };
    const string = (): string => {
      const start = pos++; let escaped = false;
      while (pos < text.length) {
        const c = text[pos++]!;
        if (c === '"' && !escaped) return JSON.parse(text.slice(start, pos)) as string;
        if (c === '\\' && !escaped) escaped = true; else escaped = false;
      }
      return fail();
    };
    const value = (depth: number): void => {
      if (++nodes > 8192 || depth > 8) fail(); space();
      const c = text[pos];
      if (c === '"') { string(); return; }
      if (c === '{' || c === '[') {
        const end = c === '{' ? '}' : ']'; pos++; space(); const keys = new Set<string>();
        if (text[pos] === end) { pos++; return; }
        for (;;) {
          if (c === '{') {
            if (text[pos] !== '"') fail(); const key = string(); if (keys.has(key)) fail(); keys.add(key);
            space(); if (text[pos++] !== ':') fail();
          }
          value(depth + 1); space(); if (text[pos] === end) { pos++; return; }
          if (text[pos++] !== ',') fail(); space();
        }
      }
      // Wire numbers are nonnegative integers (Epoch is a string; payloads are Binary).
      // Refuse Double syntax and inexact integers before JSON.parse loses their lexemes.
      const match = /^(?:true|false|null|0|[1-9]\d*)/u.exec(text.slice(pos));
      if (!match || (/^\d/u.test(match[0]) && !Number.isSafeInteger(Number(match[0])))) fail(); pos += match[0].length;
    };
    value(0); space(); if (pos !== text.length) fail(); return JSON.parse(text) as unknown;
  } catch { throw new TableError('corrupt'); }
}
function serviceFields(v: Record<string, unknown>): { timestamp: string; etag: string } {
  const stamp = v.Timestamp;
  if (typeof stamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/u.test(stamp) ||
      !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString().slice(0, 19) !== stamp.slice(0, 19) ||
      stamp < '1601' || (v['Timestamp@odata.type'] !== undefined && v['Timestamp@odata.type'] !== 'Edm.DateTime')) fail();
  for (const name of ['odata.metadata', 'odata.id', 'odata.editLink', 'odata.editlink', 'odata.type']) if (v[name] !== undefined) {
    const x = v[name];
    if (typeof x !== 'string' || !x || Buffer.byteLength(x) > 4096 || /[\p{Cc}\s\uD800-\uDFFF]/u.test(x)) fail();
    if (name === 'odata.type' && !/^[a-zA-Z][\w.]{0,255}$/u.test(x)) fail();
    if (name !== 'odata.type' && (x.startsWith('//') || (!/^https?:\/\//u.test(x) && !/^[a-zA-Z][a-zA-Z0-9]*\(/u.test(x)))) fail();
  }
  if (v['odata.editLink'] !== undefined && v['odata.editlink'] !== undefined) fail();
  return { timestamp: stamp, etag: etag(v['odata.etag']) };
}
export function decodeObject(binding: BoundTable, input: unknown, row?: string, headerETag?: string): StoredRecord {
  try {
    const v = object(input); const service = serviceFields(v);
    if (v.PartitionKey !== binding.partition || typeof v.RowKey !== 'string' || (row !== undefined && row !== v.RowKey) ||
        (headerETag !== undefined && etag(headerETag) !== service.etag) || v.V !== 1) fail();
    const allowed: Record<string, string> = { PartitionKey: 'Edm.String', RowKey: 'Edm.String', Timestamp: 'Edm.DateTime', V: 'Edm.Int32', Digest: 'Edm.String' };
    let result: RecordValue;
    if (v.RowKey === 'M') {
      Object.assign(allowed, { Binding: 'Edm.Binary', InitId: 'Edm.String', InitDigest: 'Edm.String', Owner: 'Edm.String', Epoch: 'Edm.Int64',
        Invocation: 'Edm.String', Operation: 'Edm.String', Plan: 'Edm.String', State: 'Edm.Binary', Result: 'Edm.Binary', Release: 'Edm.Binary' });
      const initId = uuid(v.InitId); const initDigest = hex(v.InitDigest);
      if (!binary(v.Binding, 16384).equals(binding.bytes) || initializationDigest(binding, initId) !== initDigest ||
          typeof v.Epoch !== 'string' || !/^(?:0|[1-9]\d{0,15})$/u.test(v.Epoch) ||
          !['initialize', 'acquire', 'mutate', 'barrier', 'release'].includes(v.Operation as string)) fail();
      result = metadata(binding, { initId, initDigest, owner: v.Owner === '' ? '' : uuid(v.Owner), epoch: integer(Number(v.Epoch), 0, Number.MAX_SAFE_INTEGER),
        invocation: uuid(v.Invocation), operation: v.Operation as Metadata['operation'], plan: hex(v.Plan), state: binary(v.State, 65536),
        result: binary(v.Result, 65536), release: binary(v.Release, 1024) });
      let releaseOwner = ''; let releaseEpoch = 0;
      if (result.release.length) {
        const receipt = rawJSON(result.release);
        if (!Array.isArray(receipt) || receipt.length !== 4) fail();
        releaseOwner = uuid(receipt[0]); releaseEpoch = integer(receipt[1], 1, result.epoch); uuid(receipt[2]); hex(receipt[3]);
        if (result.operation === 'release' && (result.owner !== '' || receipt[1] !== result.epoch ||
            receipt[2] !== result.invocation || receipt[3] !== result.plan)) fail();
      }
      // These are kernel lifecycle invariants, independent of future domain audits.
      // Barriers preserve ownership/state/receipts; only a clean release permits the next epoch.
      if (result.epoch === 0) {
        if (result.owner || releaseEpoch || result.state.length || result.result.length ||
            !['initialize', 'barrier'].includes(result.operation)) fail();
      } else if (result.owner) {
        if (!['acquire', 'mutate', 'barrier'].includes(result.operation) ||
            (result.epoch === 1 ? releaseEpoch !== 0 : releaseEpoch !== result.epoch - 1 || releaseOwner === result.owner)) fail();
        if (result.operation === 'acquire' && result.epoch === 1 && (result.state.length || result.result.length)) fail();
      } else if (!['release', 'barrier'].includes(result.operation) || releaseEpoch !== result.epoch) fail();
      if (result.operation === 'initialize' && (result.invocation !== result.initId || result.plan !== digest(['initialize', result.initId]))) fail();
    } else {
      Object.assign(allowed, { T: 'Edm.String', Id: 'Edm.String', Length: 'Edm.Int32', Count: 'Edm.Int32' });
      const key = { type: v.T as DataKey['type'], id: v.Id as string };
      if (dataRow(binding, key) !== v.RowKey) fail();
      const length = integer(v.Length, 0, MAX_PAYLOAD_BYTES); const count = integer(v.Count, 0, 4);
      if (count !== Math.ceil(length / 65536)) fail(); const chunks: Buffer[] = [];
      for (let i = 0; i < count; i++) {
        allowed[`B${i}`] = 'Edm.Binary'; const chunk = binary(v[`B${i}`], 65536);
        if (chunk.length !== Math.min(65536, length - i * 65536)) fail(); chunks.push(chunk);
      }
      result = data(binding, key, Buffer.concat(chunks));
    }
    if (hex(v.Digest) !== result.digest) fail();
    checkProperties(v, allowed);
    return { row: v.RowKey, ...service, value: result };
  } catch { throw new TableError('corrupt'); }
}
function checkProperties(v: Record<string, unknown>, allowed: Record<string, string>): void {
  const serviceNames = ['odata.metadata', 'odata.id', 'odata.editLink', 'odata.editlink', 'odata.type', 'odata.etag'];
  for (const key of Object.keys(v)) {
    if (serviceNames.includes(key)) continue;
    if (key.endsWith('@odata.type')) {
      const property = key.slice(0, -11); if (!Object.hasOwn(allowed, property) || allowed[property] !== v[key]) fail();
    } else if (!Object.hasOwn(allowed, key)) fail();
  }
  for (const [key, type] of Object.entries(allowed)) if (['Edm.Binary', 'Edm.Int64'].includes(type) && v[`${key}@odata.type`] !== type) fail();
}
export function decodeRecord(binding: BoundTable, body: Uint8Array, row?: string, headerETag?: string): StoredRecord {
  return decodeObject(binding, rawJSON(body), row, headerETag);
}
export function decodePage(binding: BoundTable, body: Uint8Array): StoredRecord[] {
  try {
    const page = object(rawJSON(body), ['odata.metadata', 'value']);
    if (page['odata.metadata'] !== undefined && (typeof page['odata.metadata'] !== 'string' || page['odata.metadata'].length > 4096 ||
      !/^https?:\/\/[^\s]+$/u.test(page['odata.metadata']))) fail();
    if (!Array.isArray(page.value) || page.value.length > 1) fail();
    return page.value.map((v: unknown) => decodeObject(binding, v));
  } catch { throw new TableError('corrupt'); }
}
/** Closed layouts: <=13 custom properties; <=~290KiB logical entity data including UTF16 names/strings.
 * Binary is measured decoded, not by its larger base64 JSON representation. */
export function encodeRecord(binding: BoundTable, value: RecordValue): Record<string, unknown> {
  const entity: Record<string, unknown> = { partitionKey: binding.partition, rowKey: value.kind === 'metadata' ? 'M' : dataRow(binding, { type: value.type, id: value.id }), V: 1, Digest: value.digest };
  const bin = (v: Uint8Array) => ({ type: 'Binary', value: Buffer.from(v).toString('base64') });
  if (value.kind === 'metadata') Object.assign(entity, { Binding: bin(binding.bytes), InitId: value.initId, InitDigest: value.initDigest,
    Owner: value.owner, Epoch: { type: 'Int64', value: String(value.epoch) }, Invocation: value.invocation, Operation: value.operation,
    Plan: value.plan, State: bin(value.state), Result: bin(value.result), Release: bin(value.release) });
  else {
    Object.assign(entity, { T: value.type, Id: value.id, Length: value.payload.length, Count: Math.ceil(value.payload.length / 65536) });
    for (let i = 0; i < Math.ceil(value.payload.length / 65536); i++) entity[`B${i}`] = bin(value.payload.subarray(i * 65536, (i + 1) * 65536));
  }
  return entity;
}

/** V2 receipts are typed values with one canonical wire representation. */
export function encodeExit(input: ExitReceipt | undefined): Buffer {
  if (input === undefined) return Buffer.alloc(0);
  const v = object(input);
  const common = ['kind', 'oldOwner', 'oldEpoch', 'invocation'];
  const keys = v.kind === 'clean-release' ? [...common, 'planDigest'] :
    v.kind === 'operator-recovery' ? [...common, 'originalMDigest', 'planDigest', 'domainDispositionDigest', 'operatorAttestationDigest'] : fail();
  object(v, keys);
  const base = { kind: v.kind, oldOwner: uuid(v.oldOwner), oldEpoch: integer(v.oldEpoch, 1, Number.MAX_SAFE_INTEGER), invocation: uuid(v.invocation) };
  const receipt = v.kind === 'clean-release' ? { ...base, planDigest: hex(v.planDigest) } : { ...base,
    originalMDigest: hex(v.originalMDigest), planDigest: hex(v.planDigest), domainDispositionDigest: hex(v.domainDispositionDigest),
    operatorAttestationDigest: hex(v.operatorAttestationDigest) };
  return bytes(Buffer.from(JSON.stringify(receipt)), 1024);
}
export function decodeExit(input: Uint8Array): ExitReceipt | undefined {
  try {
    const raw = bytes(input, 1024); if (!raw.length) return undefined;
    const receipt = rawJSON(raw) as ExitReceipt;
    if (!encodeExit(receipt).equals(raw)) fail(); return receipt;
  } catch { throw new TableError('corrupt'); }
}
export function initializationDigestV2(binding: BoundTable, id: string): string { return digest(['orka-init-v2', binding.bytes.toString('base64'), id]); }
export function metadataV2(binding: BoundTable, value: Omit<MetadataV2, 'digest' | 'kind'>): MetadataV2 {
  const m = { kind: 'metadata' as const, ...value };
  return { ...m, digest: digest(['orka-m-v2', binding.bytes.toString('base64'), m.initId, m.initDigest, m.owner, m.epoch,
    m.invocation, m.operation, m.plan, m.state.toString('base64'), m.result.toString('base64'), encodeExit(m.exit).toString('base64')]) };
}
export function decodeObjectV2(binding: BoundTable, input: unknown, row?: string, headerETag?: string): StoredRecordV2 {
  try {
    const v = object(input);
    // Data retains the exact V1 decoder, but M can never fall back to it.
    if (v.RowKey !== 'M') {
      const record = decodeObject(binding, v, row, headerETag);
      if (record.value.kind !== 'data') fail(); return { ...record, value: record.value };
    }
    const service = serviceFields(v);
    if (v.PartitionKey !== binding.partition || (row !== undefined && row !== 'M') ||
        (headerETag !== undefined && etag(headerETag) !== service.etag) || v.V !== 2) fail();
    checkProperties(v, { PartitionKey: 'Edm.String', RowKey: 'Edm.String', Timestamp: 'Edm.DateTime', V: 'Edm.Int32', Digest: 'Edm.String',
      Binding: 'Edm.Binary', InitId: 'Edm.String', InitDigest: 'Edm.String', Owner: 'Edm.String', Epoch: 'Edm.Int64',
      Invocation: 'Edm.String', Operation: 'Edm.String', Plan: 'Edm.String', State: 'Edm.Binary', Result: 'Edm.Binary', Exit: 'Edm.Binary' });
    const initId = uuid(v.InitId); const initDigest = hex(v.InitDigest);
    if (!binary(v.Binding, 16384).equals(binding.bytes) || initializationDigestV2(binding, initId) !== initDigest ||
        typeof v.Epoch !== 'string' || !/^(?:0|[1-9]\d{0,15})$/u.test(v.Epoch) ||
        !['initialize', 'acquire', 'mutate', 'barrier', 'release', 'recover'].includes(v.Operation as string)) fail();
    const result = metadataV2(binding, { initId, initDigest, owner: v.Owner === '' ? '' : uuid(v.Owner), epoch: integer(Number(v.Epoch), 0, Number.MAX_SAFE_INTEGER),
      invocation: uuid(v.Invocation), operation: v.Operation as MetadataV2['operation'], plan: hex(v.Plan), state: binary(v.State, 65536),
      result: binary(v.Result, 65536), exit: decodeExit(binary(v.Exit, 1024)) });
    const exit = result.exit;
    if (result.epoch === 0) {
      if (result.owner || exit || result.state.length || result.result.length || !['initialize', 'barrier'].includes(result.operation)) fail();
    } else if (result.owner) {
      if (!['acquire', 'mutate', 'barrier'].includes(result.operation) ||
          (result.epoch === 1 ? exit !== undefined : !exit || exit.oldEpoch !== result.epoch - 1 || exit.oldOwner === result.owner)) fail();
      if (result.operation === 'acquire' && result.epoch === 1 && (result.state.length || result.result.length)) fail();
    } else {
      if (!exit || exit.oldEpoch !== result.epoch || !['release', 'recover', 'barrier'].includes(result.operation)) fail();
      if (result.operation !== 'barrier' && (exit.kind !== (result.operation === 'release' ? 'clean-release' : 'operator-recovery') ||
          exit.invocation !== result.invocation || exit.planDigest !== result.plan)) fail();
    }
    if (result.operation === 'initialize' && (result.invocation !== result.initId || result.plan !== digest(['initialize', result.initId]))) fail();
    if (hex(v.Digest) !== result.digest) fail(); return { row: 'M', ...service, value: result };
  } catch { throw new TableError('corrupt'); }
}
export function decodeRecordV2(binding: BoundTable, body: Uint8Array, row?: string, headerETag?: string): StoredRecordV2 {
  return decodeObjectV2(binding, rawJSON(body), row, headerETag);
}
export function decodePageV2(binding: BoundTable, body: Uint8Array): StoredRecordV2[] {
  try {
    const page = object(rawJSON(body), ['odata.metadata', 'value']);
    if (page['odata.metadata'] !== undefined && (typeof page['odata.metadata'] !== 'string' || page['odata.metadata'].length > 4096 ||
      !/^https?:\/\/[^\s]+$/u.test(page['odata.metadata']))) fail();
    if (!Array.isArray(page.value) || page.value.length > 1) fail();
    return page.value.map((v: unknown) => decodeObjectV2(binding, v));
  } catch { throw new TableError('corrupt'); }
}
export function encodeRecordV2(binding: BoundTable, value: RecordValueV2): Record<string, unknown> {
  if (value.kind === 'data') return encodeRecord(binding, value);
  const bin = (v: Uint8Array) => ({ type: 'Binary', value: Buffer.from(v).toString('base64') });
  return { partitionKey: binding.partition, rowKey: 'M', V: 2, Digest: value.digest, Binding: bin(binding.bytes), InitId: value.initId, InitDigest: value.initDigest,
    Owner: value.owner, Epoch: { type: 'Int64', value: String(value.epoch) }, Invocation: value.invocation, Operation: value.operation,
    Plan: value.plan, State: bin(value.state), Result: bin(value.result), Exit: bin(encodeExit(value.exit)) };
}
