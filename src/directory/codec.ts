import { createHash } from 'node:crypto';
import { httpsBase, identity } from '../ingress/codec.js';
import { MAX_TEXT_BYTES } from '../protocol/types.js';
import { etag, hex, integer, object, uuid } from '../storage/table/codec.js';
import type { CanonicalValue, DirectoryKey, DirectoryRecord, DirectoryRow, DirectoryScope } from './types.js';
import { DirectoryError } from './types.js';

export const MAX_DIRECTORY_PAYLOAD = 48 * 1024;
function bad(): never { throw new DirectoryError('invalid-input'); }
function text(v: unknown, max = 4096): string {
  if (typeof v !== 'string' || !v || Buffer.byteLength(v) > max || /[\p{Cc}\uD800-\uDFFF]/u.test(v)) bad(); return v;
}
function target(v: unknown): string { const s = text(v, 63); if (!/^[a-z][a-z0-9-]{0,62}$/u.test(s)) bad(); return s; }
export function parseUseCommand(input: string): string | undefined { return /^use ([a-z][a-z0-9-]{0,62})$/u.exec(input.trim())?.[1]; }
export function textDigest(input: string): string { return createHash('sha256').update(input, 'utf8').digest('hex'); }
function hash(value: unknown): string { return textDigest(JSON.stringify(value)); }
export function controlFingerprint(scope: DirectoryScope, conversationId: string, activityId: string,
  senderId: string, inputText: string, desiredTargetDigest: string | null): string {
  try {
    const s = validateScope(scope);
    const ids = [s.appId, s.tenantId, conversationId, activityId, senderId].map(identity);
    if (typeof inputText !== 'string' || !inputText || /^\p{White_Space}*$/u.test(inputText) || Buffer.byteLength(inputText) > MAX_TEXT_BYTES ||
      /[\uD800-\uDFFF]/u.test(inputText) || /\p{Cc}/u.test(inputText.replace(/[\t\r\n]/gu, ''))) bad();
    if (desiredTargetDigest !== null) hex(desiredTargetDigest);
    return hash(['teams-control-fingerprint-v1', ...ids, inputText, desiredTargetDigest]);
  } catch { throw new DirectoryError('invalid-input'); }
}
export function validateScope(input: unknown): DirectoryScope {
  const s = object(input, ['appId', 'tenantId']); return { appId: identity(s.appId), tenantId: identity(s.tenantId) };
}
export function directoryKey(scope: DirectoryScope, input: DirectoryKey): { partition: string; row: string } {
  const s = validateScope(scope); const k = object(input, ['kind', 'conversationId', ...(input.kind === 'control' ? ['activityId'] : [])]);
  if (k.kind !== 'conn' && k.kind !== 'control') bad();
  const parts = [identity(k.conversationId), ...(k.kind === 'control' ? [identity(k.activityId)] : [])];
  return { partition: `directory_${hash(['teams-directory-v1', s.appId, s.tenantId])}`, row: `${k.kind}_${hash(parts)}` };
}
export function bindingName(scope: DirectoryScope, conversationId: string, identityDigest: string): string {
  const s = validateScope(scope); return `teams-${hash(['teams-binding-v1', s.appId, s.tenantId, identity(conversationId), hex(identityDigest)]).slice(0, 56)}`;
}
/** Full Binding specs include fractional backoff; the kernel envelope remains integer-only. */
export function parseCanonicalJSON(input: Uint8Array, maxNodes = 16384): CanonicalValue {
  try {
    if (!(input instanceof Uint8Array) || input.byteLength > 512 * 1024 || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 131072) bad();
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); let pos = 0; let nodes = 0;
    const space = () => { while (/[\x20\t\r\n]/u.test(source[pos] ?? '!')) pos++; };
    const string = (): string => {
      const start = pos++; let escaped = false;
      while (pos < source.length) {
        const c = source[pos++]!;
        if (c === '"' && !escaped) { const result = JSON.parse(source.slice(start, pos)) as string; if (/[\uD800-\uDFFF]/u.test(result)) bad(); return result; }
        if (c === '\\' && !escaped) escaped = true; else escaped = false;
      }
      return bad();
    };
    const value = (depth: number): void => {
      if (++nodes > maxNodes || depth > 24) bad(); space(); const c = source[pos];
      if (c === '"') { string(); return; }
      if (c === '{' || c === '[') {
        const end = c === '{' ? '}' : ']'; const keys = new Set<string>(); pos++; space();
        if (source[pos] === end) { pos++; return; }
        for (;;) {
          if (c === '{') { if (source[pos] !== '"') bad(); const key = string(); if (keys.has(key)) bad(); keys.add(key); space(); if (source[pos++] !== ':') bad(); }
          value(depth + 1); space(); if (source[pos] === end) { pos++; return; } if (source[pos++] !== ',') bad(); space();
        }
      }
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(pos));
      if (!match || (/^-?\d/u.test(match[0]) && (!Number.isFinite(Number(match[0])) || Math.abs(Number(match[0])) > Number.MAX_SAFE_INTEGER))) bad();
      pos += match[0].length;
    };
    value(0); space(); if (pos !== source.length) bad(); return JSON.parse(source) as CanonicalValue;
  } catch { throw new DirectoryError('corrupt'); }
}
export function canonicalJSON(input: unknown): string {
  let nodes = 0;
  const visit = (v: unknown, depth: number): string => {
    if (++nodes > 16384 || depth > 24) bad();
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') { if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) bad(); return JSON.stringify(v); }
    if (typeof v === 'string') { if (/[\uD800-\uDFFF]/u.test(v)) bad(); return JSON.stringify(v); }
    if (Array.isArray(v)) {
      if (Reflect.ownKeys(v).length !== v.length + 1) bad();
      return '[' + Array.from(v, x => visit(x, depth + 1)).join(',') + ']';
    }
    const o = object(v); return '{' + Object.keys(o).sort().map(k => {
      if (/[\uD800-\uDFFF]/u.test(k)) bad(); return JSON.stringify(k) + ':' + visit(o[k], depth + 1);
    }).join(',') + '}';
  };
  try { return visit(input, 0); } catch { throw new DirectoryError('invalid-input'); }
}
function validate(input: unknown): DirectoryRecord {
  const v = object(input); const s = validateScope(v.scope); const conversationId = identity(v.conversationId);
  if (v.schema !== 1 || !['personal', 'groupChat'].includes(v.chatKind as string)) bad();
  const common = ['schema', 'kind', 'scope', 'conversationId', 'chatKind', 'state'];
  if (v.kind === 'conn') {
    object(v, [...common, 'targetId', 'identityDigest', 'bindingName', ...(v.state === 'provisioned' ? ['binding'] : [])]);
    target(v.targetId); hex(v.identityDigest); const name = text(v.bindingName, 253);
    if (name !== bindingName(s, conversationId, v.identityDigest as string)) bad();
    if (v.state === 'provisioned') {
      const b = object(v.binding, ['namespace', 'name', 'uid', 'generation', 'spec']); text(b.namespace, 253); text(b.uid); integer(b.generation, 1, Number.MAX_SAFE_INTEGER);
      if (text(b.name, 253) !== name) bad(); object(b.spec); canonicalJSON(b.spec);
    } else if (v.state !== 'reserved') bad();
  } else if (v.kind === 'control') {
    const attempted = ['armed', 'delivered', 'rejected', 'unknown'].includes(v.state as string);
    object(v, [...common, 'activityId', 'fingerprint', 'currentTargetDigest', 'desiredTargetDigest', 'route', 'reply',
      ...(attempted ? ['ownerUUID', 'attemptUUID'] : []), ...(v.state === 'delivered' ? ['providerMessageId'] : [])]);
    identity(v.activityId); hex(v.fingerprint); for (const d of [v.currentTargetDigest, v.desiredTargetDigest]) if (d !== null) hex(d);
    if (attempted) { uuid(v.ownerUUID); uuid(v.attemptUUID); } else if (v.state !== 'ready') bad();
    if (v.state === 'delivered') identity(v.providerMessageId);
    const r = object(v.route, ['serviceUrl', 'channelId', 'bot', 'conversation']);
    httpsBase(r.serviceUrl, true); if (r.channelId !== 'msteams') bad();
    const bot = object(r.bot, ['id', 'role']); identity(bot.id); if (bot.role !== 'bot') bad();
    const c = object(r.conversation, ['id', 'tenantId', 'conversationType']);
    if (c.id !== conversationId || c.tenantId !== s.tenantId || c.conversationType !== v.chatKind) bad();
    const reply = object(v.reply); const kind = reply.kind;
    object(reply, kind === 'no-access' ? ['kind'] : kind === 'discovery' ? ['kind', 'targets'] : ['kind', 'targetId', 'label']);
    if (kind === 'discovery') {
      if (!Array.isArray(reply.targets) || !reply.targets.length || reply.targets.length > 32) bad(); const ids = new Set<string>();
      for (const item of reply.targets) { const t = object(item, ['id', 'label']); const id = target(t.id); text(t.label, 256); if (ids.has(id)) bad(); ids.add(id); }
    } else if (kind === 'connected' || kind === 'switching') { target(reply.targetId); text(reply.label, 256); }
    else if (kind !== 'no-access') bad();
  } else bad();
  return v as unknown as DirectoryRecord;
}
export function encodeRecord(input: unknown): Buffer {
  try { const encoded = Buffer.from(canonicalJSON(validate(input))); if (encoded.length > MAX_DIRECTORY_PAYLOAD) bad(); return encoded; }
  catch { throw new DirectoryError('invalid-input'); }
}
export function snapshotDirectoryRecord(input: unknown): DirectoryRecord { return decodeRecord(encodeRecord(input)); }
export function decodeRecord(input: Uint8Array): DirectoryRecord {
  try { const v = validate(parseCanonicalJSON(input)); if (!encodeRecord(v).equals(Buffer.from(input))) bad(); return v; }
  catch { throw new DirectoryError('corrupt'); }
}
export function recordKey(value: DirectoryRecord): DirectoryKey {
  return value.kind === 'conn' ? { kind: 'conn', conversationId: value.conversationId } : { kind: 'control', conversationId: value.conversationId, activityId: value.activityId };
}
export function encodeEntity(scope: DirectoryScope, key: DirectoryKey, value: DirectoryRecord): Record<string, unknown> {
  const payload = encodeRecord(value); const k = directoryKey(scope, key); const own = directoryKey(value.scope, recordKey(value));
  if (k.partition !== own.partition || k.row !== own.row) bad();
  return { PartitionKey: k.partition, RowKey: k.row, V: 1, Payload: payload.toString('base64'), 'Payload@odata.type': 'Edm.Binary',
    Digest: hash(['teams-directory-row-v1', k.partition, k.row, payload.toString('base64')]), Armed: value.kind === 'control' && value.state === 'armed' };
}
export function decodeEntity(scope: DirectoryScope, input: unknown, key?: DirectoryKey, headerETag?: string): DirectoryRow {
  try {
    const types: Record<string, string> = { PartitionKey: 'Edm.String', RowKey: 'Edm.String', V: 'Edm.Int32', Payload: 'Edm.Binary', Digest: 'Edm.String', Armed: 'Edm.Boolean', Timestamp: 'Edm.DateTime' };
    const meta = ['odata.etag', 'odata.metadata', 'odata.id', 'odata.editLink', 'odata.editlink', 'odata.type'];
    const v = object(input, [...Object.keys(types), ...Object.keys(types).map(k => `${k}@odata.type`), ...meta]);
    for (const [k, type] of Object.entries(types)) if (v[`${k}@odata.type`] !== undefined && v[`${k}@odata.type`] !== type) bad();
    if (v['Payload@odata.type'] !== 'Edm.Binary' || typeof v.Payload !== 'string' || v.Payload.length > 4 * Math.ceil(65536 / 3)) bad();
    const payload = Buffer.from(v.Payload, 'base64'); if (payload.length > 65536 || payload.toString('base64') !== v.Payload) bad();
    const value = decodeRecord(payload); const ownKey = recordKey(value); const own = encodeEntity(scope, key ?? ownKey, value);
    for (const k of ['PartitionKey', 'RowKey', 'V', 'Payload', 'Digest', 'Armed']) if (own[k] !== v[k]) bad();
    for (const k of meta.slice(1)) if (v[k] !== undefined) {
      const m = text(v[k]); if (/\s/u.test(m) || (k === 'odata.type' ? !/^[a-zA-Z][\w.]{0,255}$/u.test(m) :
        m.startsWith('//') || (!/^https?:\/\//u.test(m) && !/^[a-zA-Z][a-zA-Z0-9]*\(/u.test(m)))) bad();
    }
    if (v['odata.editLink'] !== undefined && v['odata.editlink'] !== undefined) bad();
    const timestamp = text(v.Timestamp); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/u.test(timestamp) ||
      timestamp < '1601' || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString().slice(0, 19) !== timestamp.slice(0, 19)) bad();
    const tag = etag(v['odata.etag']); if (headerETag !== undefined && etag(headerETag) !== tag) bad();
    return { key: ownKey, row: own.RowKey as string, value, etag: tag, timestamp };
  } catch { throw new DirectoryError('corrupt'); }
}
