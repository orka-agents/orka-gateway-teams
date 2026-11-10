import { bytes, decodeObjectV3Envelope, digest, encodeRecordV2, fail, hex, integer, metadataV2, object, rawJSON, uuid } from './codec.js';
import type { BoundTable, LeaseValue, MetadataV3, StoredRecordV3 } from './types.js';
import { TableError } from './types.js';

export function encodeLease(input: LeaseValue | undefined): Buffer {
  if (input === undefined) return Buffer.alloc(0);
  const v = object(input, ['schema', 'durationMs', 'skewMs', 'handoffMs', 'sequence', 'invocation', 'expiresAt']);
  if (Object.keys(v).length !== 7 || v.schema !== 1 || v.durationMs !== 120000 || v.skewMs !== 5000 || v.handoffMs !== 1000) fail();
  return Buffer.from(JSON.stringify({ schema: 1, durationMs: 120000, skewMs: 5000, handoffMs: 1000,
    sequence: integer(v.sequence, 1, Number.MAX_SAFE_INTEGER), invocation: uuid(v.invocation),
    expiresAt: integer(v.expiresAt, 1, Number.MAX_SAFE_INTEGER) }));
}
/** Includes every domain field and binding, never a relaxed commit authority. */
export function domainFingerprint(binding: BoundTable, value: MetadataV3): string { return metadataV2(binding, value).digest; }
export function metadataV3(binding: BoundTable, value: Omit<MetadataV3, 'kind' | 'digest'>): MetadataV3 {
  const base = metadataV2(binding, value);
  const lease = value.lease;
  return { ...base, lease, digest: digest(['orka-m-v3', base.digest, encodeLease(lease).toString('base64')]) };
}
export function decodeObjectV3(binding: BoundTable, input: unknown, row?: string, tag?: string): StoredRecordV3 {
  return decodeObjectV3Envelope(binding, input, row, tag);
}
export function decodeRecordV3(binding: BoundTable, body: Uint8Array, row?: string, tag?: string): StoredRecordV3 {
  return decodeObjectV3(binding, rawJSON(body), row, tag);
}
export function decodePageV3(binding: BoundTable, body: Uint8Array): StoredRecordV3[] {
  try {
    const v = object(rawJSON(body), ['odata.metadata', 'value']);
    if (v['odata.metadata'] !== undefined && (typeof v['odata.metadata'] !== 'string' || v['odata.metadata'].length > 4096 ||
      !/^https?:\/\/[^\s]+$/u.test(v['odata.metadata']))) fail();
    if (!Array.isArray(v.value) || v.value.length > 1) fail(); return v.value.map(r => decodeObjectV3(binding, r));
  } catch { throw new TableError('corrupt'); }
}
export function expiryAuditId(invocation: string): string { return `control_lease_expiry:${uuid(invocation)}`; }
export function encodeExpiryAudit(input: import('./types.js').LeaseExpiryAudit): Buffer {
  const v = object(input, ['schema', 'kind', 'invocation', 'oldOwner', 'oldEpoch', 'originalMDigest', 'dispositionDigest', 'lease', 'observedAt']);
  if (Object.keys(v).length !== 9 || v.schema !== 1 || v.kind !== 'lease-expiry-audit') fail();
  const lease = rawJSON(encodeLease(v.lease as LeaseValue)) as LeaseValue;
  const observedAt = integer(v.observedAt, 1, Number.MAX_SAFE_INTEGER);
  if (observedAt <= lease.expiresAt + 5000) fail();
  return bytes(Buffer.from(JSON.stringify({ schema: 1, kind: 'lease-expiry-audit', invocation: uuid(v.invocation), oldOwner: uuid(v.oldOwner),
    oldEpoch: integer(v.oldEpoch, 1, Number.MAX_SAFE_INTEGER), originalMDigest: hex(v.originalMDigest), dispositionDigest: hex(v.dispositionDigest), lease, observedAt })), 1024);
}
export function decodeExpiryAudit(input: Uint8Array): import('./types.js').LeaseExpiryAudit {
  try { const raw = bytes(input, 1024); const value = rawJSON(raw) as import('./types.js').LeaseExpiryAudit;
    if (!encodeExpiryAudit(value).equals(raw)) fail(); return value;
  } catch { throw new TableError('corrupt'); }
}
export function encodeRecordV3(binding: BoundTable, value: MetadataV3 | import('./types.js').DataRecord): Record<string, unknown> {
  if (value.kind === 'data') return encodeRecordV2(binding, value);
  return { ...encodeRecordV2(binding, value), V: 3, Lease: { type: 'Binary', value: encodeLease(value.lease).toString('base64') } };
}
