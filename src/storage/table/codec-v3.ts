import { decodeObjectV2, digest, encodeRecordV2, fail, integer, metadataV2, object, rawJSON, uuid } from './codec.js';
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
function decodeLease(input: unknown): LeaseValue | undefined {
  if (typeof input !== 'string' || input.length > 1368) fail();
  const bytes = Buffer.from(input, 'base64');
  if (bytes.length > 1024 || bytes.toString('base64') !== input) fail();
  if (!bytes.length) return undefined;
  const lease = rawJSON(bytes) as LeaseValue;
  if (!encodeLease(lease).equals(bytes)) fail(); return lease;
}
/** Includes every domain field and binding, never a relaxed commit authority. */
export function domainFingerprint(binding: BoundTable, value: MetadataV3): string { return metadataV2(binding, value).digest; }
export function metadataV3(binding: BoundTable, value: Omit<MetadataV3, 'kind' | 'digest'>): MetadataV3 {
  const base = metadataV2(binding, value);
  const lease = value.lease;
  return { ...base, lease, digest: digest(['orka-m-v3', base.digest, encodeLease(lease).toString('base64')]) };
}
export function decodeObjectV3(binding: BoundTable, input: unknown, row?: string, tag?: string): StoredRecordV3 {
  try {
    const v = object(input);
    if (v.RowKey !== 'M') return decodeObjectV2(binding, v, row, tag) as StoredRecordV3;
    if (v.V !== 3 || v['Lease@odata.type'] !== 'Edm.Binary') fail();
    const lease = decodeLease(v.Lease);
    const { Lease: _lease, 'Lease@odata.type': _type, ...wire } = v;
    // Reuse V2's closed service-field, binding, Exit and domain checks; only the
    // version/digest projection is private. No persisted fallback is selected.
    const domain = digest(['orka-m-v2', v.Binding, v.InitId, v.InitDigest, v.Owner, Number(v.Epoch),
      v.Invocation, v.Operation, v.Plan, v.State, v.Result, v.Exit]);
    const record = decodeObjectV2(binding, { ...wire, V: 2, Digest: domain }, row, tag);
    if (record.value.kind !== 'metadata' || Boolean(record.value.owner) !== Boolean(lease)) fail();
    const value = metadataV3(binding, { ...record.value, lease });
    if (v.Digest !== value.digest) fail(); return { ...record, value };
  } catch { throw new TableError('corrupt'); }
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
export function encodeRecordV3(binding: BoundTable, value: MetadataV3 | import('./types.js').DataRecord): Record<string, unknown> {
  if (value.kind === 'data') return encodeRecordV2(binding, value);
  return { ...encodeRecordV2(binding, value), V: 3, Lease: { type: 'Binary', value: encodeLease(value.lease).toString('base64') } };
}
