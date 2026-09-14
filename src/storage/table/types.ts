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
/** Latest ownership exit, not an authorization to perform operator recovery. */
export interface CleanReleaseExit {
  kind: 'clean-release'; oldOwner: string; oldEpoch: number; invocation: string; planDigest: string;
}
export interface OperatorRecoveryExit {
  kind: 'operator-recovery'; oldOwner: string; oldEpoch: number; invocation: string;
  originalMDigest: string; planDigest: string; domainDispositionDigest: string; operatorAttestationDigest: string;
}
export type ExitReceipt = CleanReleaseExit | OperatorRecoveryExit;
export interface MetadataV2 extends Omit<Metadata, 'operation' | 'release'> {
  operation: Metadata['operation'] | 'recover'; exit: ExitReceipt | undefined;
}
export type RecordValueV2 = MetadataV2 | DataRecord;
export interface StoredRecordV2 extends Omit<StoredRecord, 'value'> { value: RecordValueV2 }
export interface PlannerViewV2 extends Omit<PlannerView, 'records'> { records: readonly (StoredRecordV2 | undefined)[] }
export type PlannerV2 = (view: PlannerViewV2) => Plan;
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
/** Explicit operational completion budgets, not a domain capacity or RSS promise. */
export interface OwnedAuditBudget {
  maxPages: number; maxPageBytes: number; maxDurationMs: number; maxTrackingBytes: number;
}
export interface OwnedAuditOptions { signal?: AbortSignal; requestTimeoutMs?: number }
/** Trusted synchronous non-I/O callbacks, invoked unbound: return exactly undefined; never return/throw Promises or start async work. */
export interface OwnedAuditVisitor {
  passes: 1 | 2;
  record(this: void, pass: 1 | 2, record: Readonly<StoredRecord>): undefined;
  endPass(this: void, pass: 1 | 2): undefined;
  finalize(this: void): undefined;
}
export interface OwnedAuditVisitorV2 extends Omit<OwnedAuditVisitor, 'record'> {
  record(this: void, pass: 1 | 2, record: Readonly<StoredRecordV2>): undefined;
}
/** Exact foreign V2 M identity; observation only, never authorization or ownership. */
export interface ForeignOwnerFenceV2 {
  initId: string; initDigest: string; owner: string; epoch: number; mDigest: string; etag: string;
}
export type ForeignInspectionBudget = OwnedAuditBudget;
export type ForeignInspectionOptions = OwnedAuditOptions;
export type ForeignInspectionVisitorV2 = OwnedAuditVisitorV2;
/** Only this exact thrown value marks trusted domain-allocator exhaustion. */
export const OWNED_AUDIT_BUDGET_EXHAUSTED: unique symbol = Symbol('owned-audit-budget-exhausted');
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
