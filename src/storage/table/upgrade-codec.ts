import { bytes, data, decodeExit, digest, encodeExit, fail, hex, integer, metadataV2, object, rawJSON, uuid } from './codec.js';
import type { BoundTable, FormatUpgradeExit, MetadataV2, StoredRecordV2 } from './types.js';
import { TableError } from './types.js';

export interface FormatUpgradeAudit {
  schema: 1; kind: 'format-upgrade-audit'; invocation: string; epoch: number; originalMDigest: string;
  previousInvocation: string; previousOperation: MetadataV2['operation']; previousPlan: string;
  dataDigest: string; dataRowCount: number; upgradeAttestationDigest: string;
}
export const upgradeAuditId = (invocation: string) => `control_format_upgrade:${uuid(invocation)}`;
export function encodeUpgradeAudit(input: FormatUpgradeAudit): Buffer {
  const v = object(input, ['schema', 'kind', 'invocation', 'epoch', 'originalMDigest', 'previousInvocation', 'previousOperation',
    'previousPlan', 'dataDigest', 'dataRowCount', 'upgradeAttestationDigest']);
  if (Object.keys(v).length !== 11 || v.schema !== 1 || v.kind !== 'format-upgrade-audit' ||
      !['initialize', 'release', 'recover', 'barrier'].includes(v.previousOperation as string)) fail();
  return bytes(Buffer.from(JSON.stringify({ schema: 1, kind: 'format-upgrade-audit', invocation: uuid(v.invocation),
    epoch: integer(v.epoch, 0, Number.MAX_SAFE_INTEGER - 1), originalMDigest: hex(v.originalMDigest),
    previousInvocation: uuid(v.previousInvocation), previousOperation: v.previousOperation, previousPlan: hex(v.previousPlan),
    dataDigest: hex(v.dataDigest), dataRowCount: integer(v.dataRowCount, 0, Number.MAX_SAFE_INTEGER),
    upgradeAttestationDigest: hex(v.upgradeAttestationDigest) })), 1024);
}
export function decodeUpgradeAudit(input: Uint8Array): FormatUpgradeAudit {
  try { const raw = bytes(input, 1024); const a = rawJSON(raw) as FormatUpgradeAudit;
    if (!encodeUpgradeAudit(a).equals(raw)) fail(); return a;
  } catch { throw new TableError('corrupt'); }
}
export const upgradePlan = (a: FormatUpgradeAudit, auditDigest: string) => digest(['format-upgrade', a.originalMDigest, a.invocation, auditDigest]);
export const isUpgradeAudit = (record: Readonly<StoredRecordV2>) => record.value.kind === 'data' &&
  record.value.type === 'control' && record.value.id.startsWith('control_format_upgrade:');

interface UpgradeReference { readonly epoch: number; readonly invocation: string; readonly plan: string }
/** Retain only the mandatory audit link while acquisition replaces M's operation. */
function upgradeReference(m: MetadataV2): UpgradeReference | undefined {
  const x = m.exit;
  return x?.kind === 'format-upgrade' ? Object.freeze({ epoch: x.oldEpoch, invocation: x.invocation, plan: x.planDigest }) : undefined;
}
export function upgradeExit(m: MetadataV2, a: FormatUpgradeAudit, auditDigest: string): FormatUpgradeExit {
  return { kind: 'format-upgrade', oldOwner: m.exit?.oldOwner ?? '', oldEpoch: m.epoch, invocation: a.invocation,
    originalMDigest: m.digest, planDigest: upgradePlan(a, auditDigest), auditDigest, previousExit: encodeExit(m.exit).toString('base64') };
}
/** The format transition retains the prior ownership Exit byte-for-byte. */
export function domainExit(m: MetadataV2) {
  return m.exit?.kind === 'format-upgrade' ? decodeExit(Buffer.from(m.exit.previousExit, 'base64')) : m.exit;
}
/** Validate the historical bridge without changing M or granting ownership.
 * Complete data is checked only at conversion/acquisition, before legitimate later mutations. */
export function upgradeEvidence(binding: BoundTable, m: MetadataV2) {
  const required = upgradeReference(m);
  let evidence: FormatUpgradeAudit | undefined; let seen = 0;
  let fold = digest(['orka-recovery-data-v2', binding.bytes.toString('base64')]); let count = 0;
  const boundary = (a: FormatUpgradeAudit) => m.operation === 'format-upgrade' ||
    (m.operation === 'acquire' && m.epoch === a.epoch + 1);
  return {
    record(record: Readonly<StoredRecordV2>): boolean {
      if (record.value.kind !== 'data') return false;
      const d = record.value;
      if (!isUpgradeAudit(record)) { fold = digest(['orka-recovery-row-v2', fold, record.row, d.digest]); count++; return false; }
      if (!('lease' in m) || ++seen !== 1) fail();
      const a = decodeUpgradeAudit(d.payload); evidence = a;
      if (d.id !== upgradeAuditId(a.invocation) || data(binding, { type: d.type, id: d.id }, d.payload).digest !== d.digest ||
          a.epoch > m.epoch || (m.owner && a.epoch >= m.epoch)) fail();
      if (required && (a.epoch !== required.epoch || a.invocation !== required.invocation || upgradePlan(a, d.digest) !== required.plan ||
          m.exit?.kind !== 'format-upgrade' || m.exit.originalMDigest !== a.originalMDigest || m.exit.auditDigest !== d.digest)) throw new TableError('corrupt');
      if (boundary(a)) {
        const previous = metadataV2(binding, { ...m, owner: '', epoch: a.epoch, invocation: a.previousInvocation,
          operation: a.previousOperation, plan: a.previousPlan, exit: domainExit(m) });
        if (previous.digest !== a.originalMDigest || (m.operation === 'format-upgrade' &&
            (m.owner || m.invocation !== a.invocation || m.plan !== upgradePlan(a, d.digest)))) fail();
      }
      return true;
    },
    finish(): void {
      if ((required || m.operation === 'format-upgrade') && !evidence) throw new TableError('corrupt');
      if (evidence && boundary(evidence) && (evidence.dataRowCount !== count ||
          evidence.dataDigest !== digest(['orka-recovery-data-end-v2', fold, count]))) fail();
    },
  };
}
export function sameUpgradeDomain(a: MetadataV2, b: MetadataV2): boolean {
  return a.initId === b.initId && a.initDigest === b.initDigest && a.epoch === b.epoch &&
    a.state.equals(b.state) && a.result.equals(b.result) && b.exit?.kind === 'format-upgrade' &&
    encodeExit(a.exit).toString('base64') === b.exit.previousExit && b.exit.originalMDigest === a.digest;
}
