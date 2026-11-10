import { auditConfig } from '../storage/table/audit.js';
import { bindTable, digest, hex } from '../storage/table/codec.js';
import { createTableForeignInspectorV2, createTableForeignInspectorV3 } from '../storage/table/inspection.js';
import { createTableLeaseExpirerV3, createTableOperatorReclaimerV2, createTableOperatorReclaimerV3 } from '../storage/table/recovery.js';
import { OWNED_AUDIT_BUDGET_EXHAUSTED, TableError } from '../storage/table/types.js';
import type { BoundTable, ForeignOwnerFenceV2, ForeignInspectionBudget, ForeignInspectionOptions, StoredRecordV2, StoredRecordV3, TableBinding, TableDependencies, TableLeaseDependencies } from '../storage/table/types.js';
import { auditV2Foreign, auditV3Foreign, corrupt, deliveryRecoveryDigest } from './table-codec.js';

/** Compare complete native envelope identities as well as rows (not just page counts).
 * Payloads are bound by their decoded digest; ETags detect same-payload rewrites. */
function same(a: StoredRecordV2 | undefined, b: Readonly<StoredRecordV2>): void {
  if (!a || a.row !== b.row || a.etag !== b.etag || a.value.digest !== b.value.digest) corrupt();
}
function validator(bound: BoundTable, maxTrackingBytes: number, expected: Readonly<ForeignOwnerFenceV2>, format: 2 | 3) {
  const records: StoredRecordV2[] = []; let index = 0; let used = 0; let validated: { state: Buffer; result: Buffer } | undefined;
  return {
    records,
    visitor: { passes: 2 as const,
      record(pass: 1 | 2, record: Readonly<StoredRecordV2>): undefined {
        if (pass === 1) {
          // Bound our retained complete graph separately from native traversal tracking.
          used += 256 + record.row.length * 2 + record.etag.length * 2 +
            (record.value.kind === 'data' ? record.value.payload.length : record.value.state.length + record.value.result.length);
          if (used > maxTrackingBytes) throw OWNED_AUDIT_BUDGET_EXHAUSTED;
          records.push(record);
        } else same(records[index++], record);
      },
      endPass(pass: 1 | 2): undefined {
        if (pass === 1 && !records.length) corrupt();
        if (pass === 2 && index !== records.length) corrupt();
      },
      finalize(): undefined {
        if (index !== records.length) corrupt();
        // The selected inspector has already decoded every envelope in its format.
        validated = format === 2 ? auditV2Foreign(bound, records, expected) : auditV3Foreign(bound, records as StoredRecordV3[], expected);
      },
    },
    check() { if (!validated) corrupt(); return validated; },
  };
}

/** One-shot DELIVERY reclaim. Two read-only inspector passes establish the old
 * graph; native recovery repeats and compares the entire fenced snapshot before
 * writing. The transport is drained on both success and failure. */
export async function reclaimTableDeliveryOperatorV2(binding: TableBinding, dependencies: TableDependencies,
  expected: Readonly<ForeignOwnerFenceV2>, budget: ForeignInspectionBudget, operatorAttestationDigest: string,
  options?: ForeignInspectionOptions): Promise<void> {
  return reclaim(binding, dependencies, expected, budget, 2, operatorAttestationDigest, options);
}
/** V3 manual recovery still requires independently retained termination evidence. */
export async function reclaimTableDeliveryOperatorV3(binding: TableBinding, dependencies: TableLeaseDependencies,
  expected: Readonly<ForeignOwnerFenceV2>, budget: ForeignInspectionBudget, operatorAttestationDigest: string,
  options?: ForeignInspectionOptions): Promise<void> {
  return reclaim(binding, dependencies, expected, budget, 3, hex(operatorAttestationDigest), options);
}
/** Automatic expiry has no operator attestation: the checked transport proves the
 * exact lease and safe observation time in addition to this complete domain proof. */
export async function expireTableDeliveryV3(binding: TableBinding, dependencies: TableLeaseDependencies,
  expected: Readonly<ForeignOwnerFenceV2>, budget: ForeignInspectionBudget, options?: ForeignInspectionOptions): Promise<void> {
  return reclaim(binding, dependencies, expected, budget, 3, undefined, options);
}
async function reclaim(binding: TableBinding, dependencies: TableLeaseDependencies,
  expected: Readonly<ForeignOwnerFenceV2>, budget: ForeignInspectionBudget, format: 2 | 3,
  operatorAttestationDigest: string | undefined, options?: ForeignInspectionOptions): Promise<void> {
  const bound = bindTable(binding);
  if (bound.kind !== 'delivery') throw new TableError('invalid-input');
  const attestation = operatorAttestationDigest === undefined && format === 3 ? undefined : hex(operatorAttestationDigest);
  const config = auditConfig<2>({ passes: 2, record() {}, endPass() {}, finalize() {} }, budget, options);
  const auditBudget = { maxPages: config.maxPages, maxPageBytes: config.maxPageBytes,
    maxDurationMs: config.maxDurationMs, maxTrackingBytes: config.maxTrackingBytes };
  const auditOptions = { ...(config.signal ? { signal: config.signal } : {}), requestTimeoutMs: config.requestTimeoutMs };
  const inspector = (format === 2 ? createTableForeignInspectorV2 : createTableForeignInspectorV3)(binding, dependencies, expected);
  const proof = validator(bound, config.maxTrackingBytes, expected, format);
  try { await inspector.inspect(proof.visitor, auditBudget, auditOptions); }
  finally { await inspector.close(); }
  const { state, result } = proof.check();
  const b = bound.bytes.toString('base64'); let h = digest(['orka-recovery-data-v2', b]); let count = 0;
  for (const record of proof.records) if (record.row !== 'M') {
    h = digest(['orka-recovery-row-v2', h, record.row, record.value.digest]); count++;
  }
  const preData = digest(['orka-recovery-data-end-v2', h, count]);
  const dispositionDigest = deliveryRecoveryDigest(bound, state, result, preData, count);
  const reclaimer = format === 2 ? createTableOperatorReclaimerV2(binding, dependencies, expected) :
    attestation === undefined ? createTableLeaseExpirerV3(binding, dependencies, expected) : createTableOperatorReclaimerV3(binding, dependencies, expected);
  let index = 0; let finished = false; let failure: unknown;
  try {
    await reclaimer.reclaim({ passes: 2,
      record(pass, record): undefined {
        const position = pass === 1 ? index : index - proof.records.length;
        same(proof.records[position], record); index++;
      },
      endPass(pass): undefined { if (index !== proof.records.length * pass) corrupt(); },
      finalize(): undefined { if (index !== proof.records.length * 2) corrupt(); finished = true; },
    }, auditBudget, {
      state, dispositionDigest, ...(attestation === undefined ? {} : { operatorAttestationDigest: attestation }),
      complete(summary) {
        if (!finished || summary.dataRowCount !== count + 1) corrupt();
        return { result, domainDispositionDigest: deliveryRecoveryDigest(bound, state, result,
          summary.postDataDigest, summary.dataRowCount) };
      },
    }, auditOptions);
  } catch (error) { failure = error; }
  try { await reclaimer.close(); } catch (error) { if (!failure) failure = error; }
  if (failure) throw failure;
}
