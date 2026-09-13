import { decodePage, decodePageV2, decodeRecord, decodeRecordV2, encodeExit, encodeRecord, encodeRecordV2, fail,
  initializationDigest, initializationDigestV2, metadata, metadataV2 } from './codec.js';
import type { BoundTable, Metadata, MetadataV2, Plan, PlannerView, PlannerViewV2, StoredRecord, StoredRecordV2 } from './types.js';

// Closed internal selection only. Public factories pin this once; neither binding,
// limits nor persisted bytes select a format or authorize a fallback.
export type MetadataFormat = 1 | 2;
export type AnyMetadata = Metadata | MetadataV2;
export type MetadataFor<F extends MetadataFormat> = F extends 1 ? Metadata : MetadataV2;
export type AnyStoredRecord = StoredRecord | StoredRecordV2;
export type StoredFor<F extends MetadataFormat> = F extends 1 ? StoredRecord : StoredRecordV2;
export type PlannerFor<F extends MetadataFormat> = (view: F extends 1 ? PlannerView : PlannerViewV2) => Plan;
export function initDigest(format: MetadataFormat, binding: BoundTable, id: string): string {
  return (format === 1 ? initializationDigest : initializationDigestV2)(binding, id);
}
export function makeMetadata(format: MetadataFormat, binding: BoundTable, value: Omit<Metadata, 'kind' | 'digest'> | Omit<MetadataV2, 'kind' | 'digest'>): AnyMetadata {
  if (format === 1) {
    if (!('release' in value) || 'exit' in value) fail(); return metadata(binding, value);
  }
  if (!('exit' in value) || 'release' in value) fail(); return metadataV2(binding, value);
}
export function encodeMetadata(format: MetadataFormat, binding: BoundTable, value: AnyMetadata): Record<string, unknown> {
  if (format === 1) {
    if (!('release' in value) || 'exit' in value) fail(); return encodeRecord(binding, value);
  }
  if (!('exit' in value) || 'release' in value) fail(); return encodeRecordV2(binding, value);
}
export function readRecord<F extends MetadataFormat>(format: F, binding: BoundTable, body: Uint8Array, row: string, etag?: string): StoredFor<F> {
  return (format === 1 ? decodeRecord : decodeRecordV2)(binding, body, row, etag) as StoredFor<F>;
}
export function readPage<F extends MetadataFormat>(format: F, binding: BoundTable, body: Uint8Array): StoredFor<F>[] {
  return (format === 1 ? decodePage : decodePageV2)(binding, body) as StoredFor<F>[];
}
export function receiptBytes(value: AnyMetadata): Buffer { return 'release' in value ? value.release : encodeExit(value.exit); }
export function cleanRelease(previous: AnyMetadata, invocation: string, plan: string): AnyMetadata {
  const fields = { owner: '', invocation, operation: 'release' as const, plan };
  return 'release' in previous ? { ...previous, ...fields, release: Buffer.from(JSON.stringify([previous.owner, previous.epoch, invocation, plan])) } :
    { ...previous, ...fields, exit: { kind: 'clean-release', oldOwner: previous.owner, oldEpoch: previous.epoch, invocation, planDigest: plan } };
}
export function matchingCleanReceipt(current: AnyMetadata, expected: AnyMetadata): boolean {
  if ('release' in expected) return 'release' in current && current.release.equals(expected.release);
  return 'exit' in current && current.exit?.kind === 'clean-release' && expected.exit?.kind === 'clean-release' &&
    encodeExit(current.exit).equals(encodeExit(expected.exit));
}
