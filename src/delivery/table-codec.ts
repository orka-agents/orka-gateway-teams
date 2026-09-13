import { object, rawJSON } from '../storage/table/codec.js';
import type { StoredRecord } from '../storage/table/types.js';
import { identity, validateClaim, validateOutcome } from './identity.js';
import type { RequestIdentity } from './identity.js';
import { DeliveryJournalError } from './types.js';
import type { BeginDeliveryResult, DeliveryClaim, DeliveryOutcome, SettlementResult } from './types.js';

export interface Operation {
  schema: 1; fingerprint: 1; digest: string; attemptId: string; attemptEpoch: number;
  state: 'ready' | 'sending' | 'delivered' | 'rejected' | 'unknown'; providerMessageId: string | null;
}
export interface Alias { schema: 1; idempotencyId: string }
export type Result = { schema: 1; operation: 'initialize' } |
  { schema: 1; operation: 'begin'; identity: RequestIdentity; result: BeginDeliveryResult } |
  { schema: 1; operation: 'settle'; claim: DeliveryClaim; outcome: DeliveryOutcome; result: SettlementResult };
export const marker = () => encode({ journal: 'teams-delivery', schema: 1, fingerprint: 1 });
export function encode(value: unknown): Buffer { return Buffer.from(JSON.stringify(value)); }
export function corrupt(): never { throw new DeliveryJournalError('corrupt'); }
function stored<T>(read: () => T): T {
  try { return read(); } catch (e) {
    if (e instanceof DeliveryJournalError && e.code === 'unsupported-schema') throw e;
    return corrupt();
  }
}
function shape(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const v = object(value, keys); if (Object.keys(v).length !== keys.length) corrupt(); return v;
}
function version(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) corrupt();
  if (value !== 1) throw new DeliveryJournalError('unsupported-schema');
}
function uuid(value: unknown): string {
  const id = identity(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) corrupt(); return id;
}
function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) corrupt(); return value;
}
export function validateMarker(bytes: Uint8Array): void {
  stored(() => {
    const v = shape(rawJSON(bytes), ['journal', 'schema', 'fingerprint']);
    if (v.journal !== 'teams-delivery') corrupt(); version(v.schema); version(v.fingerprint);
  });
}
export function decodeAlias(record: StoredRecord): Alias {
  return stored(() => {
    if (record.value.kind !== 'data' || record.value.type !== 'alias') corrupt(); identity(record.value.id);
    const v = shape(rawJSON(record.value.payload), ['schema', 'idempotencyId']); version(v.schema);
    return { schema: 1, idempotencyId: identity(v.idempotencyId) };
  });
}
export function decodeOperation(record: StoredRecord, epoch: number): Operation {
  return stored(() => {
    if (record.value.kind !== 'data' || record.value.type !== 'delivery') corrupt(); identity(record.value.id);
    const v = shape(rawJSON(record.value.payload), ['schema', 'fingerprint', 'digest', 'attemptId', 'attemptEpoch', 'state', 'providerMessageId']);
    version(v.schema); version(v.fingerprint); const digest = hex(v.digest); const attemptId = uuid(v.attemptId);
    if (typeof v.attemptEpoch !== 'number' || !Number.isSafeInteger(v.attemptEpoch) || v.attemptEpoch < 1 || v.attemptEpoch > epoch ||
        !['ready', 'sending', 'delivered', 'rejected', 'unknown'].includes(v.state as string)) corrupt();
    const state = v.state as Operation['state'];
    const providerMessageId = state === 'delivered' ? identity(v.providerMessageId) : null;
    if (state !== 'delivered' && v.providerMessageId !== null) corrupt();
    return { schema: 1, fingerprint: 1, digest, attemptId, attemptEpoch: v.attemptEpoch, state, providerMessageId };
  });
}
export function decodeResult(bytes: Uint8Array): Result {
  return stored(() => {
    const raw = object(rawJSON(bytes)); version(raw.schema);
    if (raw.operation === 'initialize') { shape(raw, ['schema', 'operation']); return { schema: 1, operation: 'initialize' }; }
    if (raw.operation === 'begin') {
      shape(raw, ['schema', 'operation', 'identity', 'result']);
      const key = shape(raw.identity, ['deliveryId', 'idempotencyId', 'digest']);
      const request = { deliveryId: identity(key.deliveryId), idempotencyId: identity(key.idempotencyId), digest: hex(key.digest) };
      const result = object(raw.result); let decoded: BeginDeliveryResult;
      if (result.kind === 'claimed') {
        shape(result, ['kind', 'claim']); const claim = validateClaim(result.claim); uuid(claim.attemptId);
        if (claim.idempotencyId !== request.idempotencyId) corrupt(); decoded = { kind: 'claimed', claim };
      } else if (result.kind === 'delivered') {
        shape(result, ['kind', 'providerMessageId']); decoded = { kind: 'delivered', providerMessageId: identity(result.providerMessageId) };
      } else {
        shape(result, ['kind']); if (!['inFlight', 'conflict', 'rejected', 'unknown'].includes(result.kind as string)) corrupt();
        decoded = { kind: result.kind as 'inFlight' | 'conflict' | 'rejected' | 'unknown' };
      }
      return { schema: 1, operation: 'begin', identity: request, result: decoded };
    }
    if (raw.operation === 'settle') {
      shape(raw, ['schema', 'operation', 'claim', 'outcome', 'result']);
      const claim = validateClaim(raw.claim); const outcome = validateOutcome(raw.outcome);
      if (!['recorded', 'unchanged', 'stale'].includes(raw.result as string)) corrupt();
      return { schema: 1, operation: 'settle', claim, outcome, result: raw.result as SettlementResult };
    }
    return corrupt();
  });
}

/** All retained rows are checked, including aliases unrelated to the next request.
 * Historical results are validated as data, never used as send authority. */
export function audit(records: readonly StoredRecord[], genesis = false): number {
  const m = records.find(r => r.row === 'M'); if (!m || m.value.kind !== 'metadata') corrupt();
  const metadata = m.value;
  if (genesis) {
    if (records.length !== 1 || metadata.epoch !== 1 || metadata.state.length || metadata.result.length) corrupt();
    return metadata.epoch;
  }
  validateMarker(metadata.state); const result = decodeResult(metadata.result);
  const operations = new Map<string, Operation>(); const aliases = new Map<string, string>();
  for (const record of records) {
    if (record.row === 'M') continue;
    if (record.value.kind !== 'data') corrupt(); const id = record.value.id;
    if (record.value.type === 'delivery') {
      if (operations.has(id)) corrupt(); operations.set(id, decodeOperation(record, metadata.epoch));
    } else if (record.value.type === 'alias') {
      if (aliases.has(id)) corrupt(); aliases.set(id, decodeAlias(record).idempotencyId);
    } else corrupt();
  }
  for (const id of operations.keys()) if (aliases.get(id) !== id) corrupt();
  for (const id of aliases.values()) if (!operations.has(id)) corrupt();
  auditResult(result, operations, aliases, metadata.epoch);
  return metadata.epoch;
}
/** Cross-check only evidence retained by the latest result, not a global history
 * proof. Acquisition/release/barriers preserve it without changing domain rows. */
function auditResult(saved: Result, operations: ReadonlyMap<string, Operation>, aliases: ReadonlyMap<string, string>, epoch: number): void {
  if (saved.operation === 'initialize') {
    if (operations.size || aliases.size) corrupt(); return;
  }
  if (saved.operation === 'begin') {
    const { identity: key, result } = saved; const operation = operations.get(key.idempotencyId);
    const stable = aliases.get(key.idempotencyId); const delivery = aliases.get(key.deliveryId);
    if (result.kind === 'conflict') {
      if (!((stable !== undefined && stable !== key.idempotencyId) || (delivery !== undefined && delivery !== key.idempotencyId) ||
          (operation && operation.digest !== key.digest))) corrupt();
      return;
    }
    if (!operation || stable !== key.idempotencyId || delivery !== key.idempotencyId || operation.digest !== key.digest) corrupt();
    // Claimed/inFlight describe physical sending when recorded, even if a later
    // acquisition now projects that same stored attempt to logical unknown.
    if (result.kind === 'claimed' || result.kind === 'inFlight') {
      if (operation.state !== 'sending' || (result.kind === 'claimed' && operation.attemptId !== result.claim.attemptId)) corrupt();
    } else if (effectiveState(operation, epoch) !== result.kind ||
        (result.kind === 'delivered' && operation.providerMessageId !== result.providerMessageId)) corrupt();
    return;
  }
  if (saved.result === 'stale') return; // Opaque attempts and absent operations are legitimate stale results.
  const operation = operations.get(saved.claim.idempotencyId);
  if (!operation || operation.attemptId !== saved.claim.attemptId) corrupt();
  const state = saved.outcome.kind === 'retryable' ? 'ready' : saved.outcome.kind;
  const receipt = saved.outcome.kind === 'delivered' ? saved.outcome.providerMessageId : null;
  // Recorded settlement physically updates the row; unchanged may instead have
  // observed old sending as unknown without any rewrite.
  if ((saved.result === 'recorded' ? operation.state : effectiveState(operation, epoch)) !== state || operation.providerMessageId !== receipt) corrupt();
}
export function effectiveState(operation: Operation, epoch: number): Operation['state'] {
  return operation.state === 'sending' && operation.attemptEpoch < epoch ? 'unknown' : operation.state;
}
