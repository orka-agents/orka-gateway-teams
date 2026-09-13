import type https from 'node:https';
import type { IngressScope } from '../../ingress/types.js';
import type { JournalScope } from '../../delivery/types.js';

export type TableBinding = { account: string; table: string; storeId: string } & (
  { kind: 'ingress'; scope: Readonly<IngressScope> } | { kind: 'delivery'; scope: Readonly<JournalScope> });
export type DataType = 'event' | 'route' | 'delivery' | 'alias' | 'control';
export interface DataKey { type: DataType; id: string }
export interface BoundTable { account: string; table: string; kind: 'ingress' | 'delivery'; partition: string; bytes: Buffer }
export type TableErrorCode = 'invalid-input' | 'corrupt' | 'missing' | 'exists' | 'busy' | 'unavailable' | 'incomplete' | 'unresolved' | 'not-submitted' | 'unready' | 'closed';
export class TableError extends Error {
  constructor(readonly code: TableErrorCode) { super(`Table storage: ${code}`); this.name = 'TableError'; }
}
export interface Metadata {
  kind: 'metadata'; initId: string; initDigest: string; owner: string; epoch: number;
  invocation: string; operation: 'initialize' | 'acquire' | 'mutate' | 'barrier' | 'release';
  plan: string; state: Buffer; result: Buffer; release: Buffer; digest: string;
}
export interface DataRecord extends DataKey { kind: 'data'; payload: Buffer; digest: string }
export type RecordValue = Metadata | DataRecord;
export interface StoredRecord { row: string; etag: string; timestamp: string; value: RecordValue }
export type DataAction = { kind: 'create'; key: DataKey; payload: Uint8Array } |
  { kind: 'replace'; key: DataKey; payload: Uint8Array; etag: string };
export interface Plan { state: Uint8Array; result: Uint8Array; actions: readonly DataAction[] }
export interface MutationInput { input: Uint8Array; keys: readonly DataKey[] }
export interface PlannerView { input: Buffer; state: Buffer; records: readonly (StoredRecord | undefined)[] }
export type Planner = (view: PlannerView) => Plan;
export type MutationResult = { kind: 'committed'; result: Buffer } | { kind: 'cancelled' };
export interface CallOptions { signal?: AbortSignal; timeoutMs?: number }
export interface TableDependencies {
  token: (scope: 'https://storage.azure.com/.default', context: { signal: AbortSignal; deadline: number }) => Promise<string>;
  /** Trusted native I/O seam for library tests, never an endpoint/TLS configuration option. */
  request?: typeof https.request;
}
export interface TableLimits {
  maxPending: number; maxPendingBytes: number; callTimeoutMs: number; cleanupTimeoutMs: number;
  reconciliationReads: number; scanPages: number; scanBytes: number;
}
export const DEFAULT_LIMITS: Readonly<TableLimits> = Object.freeze({ maxPending: 96, maxPendingBytes: 32 * 1024 * 1024,
  callTimeoutMs: 30000, cleanupTimeoutMs: 30000, reconciliationReads: 4, scanPages: 10000, scanBytes: 64 * 1024 * 1024 });
export const MAX_WIRE_BYTES = 4 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_STATE_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 512 * 1024;
