import { boundBytes, hash, partition, stamp } from './table-service.js';

// Independent raw-wire fixtures: no production encoder, digest or transition helper.
export const initId = '11111111-1111-4111-8111-111111111111';
export const oldOwner = '22222222-2222-4222-8222-222222222222';
export const invocation = '33333333-3333-4333-8333-333333333333';
export const nextOwner = '44444444-4444-4444-8444-444444444444';
export function exitFixture(kind: 'clean-release' | 'operator-recovery' = 'clean-release', epoch = 1) {
  const common = { kind, oldOwner, oldEpoch: epoch, invocation };
  return kind === 'clean-release' ? { ...common, planDigest: 'a'.repeat(64) } : { ...common,
    originalMDigest: 'b'.repeat(64), planDigest: 'a'.repeat(64), domainDispositionDigest: 'c'.repeat(64), operatorAttestationDigest: 'd'.repeat(64) };
}
export function mDigestV2(m: Record<string, unknown>): string {
  return hash(['orka-m-v2', m.Binding, m.InitId, m.InitDigest, m.Owner, Number(m.Epoch), m.Invocation, m.Operation, m.Plan, m.State, m.Result, m.Exit]);
}
export function wireM2(owner = '', epoch = 0, kind: 'clean-release' | 'operator-recovery' = 'clean-release'): Record<string, unknown> {
  const m = { PartitionKey: partition, RowKey: 'M', V: 2, Binding: boundBytes.toString('base64'), 'Binding@odata.type': 'Edm.Binary',
    InitId: initId, InitDigest: hash(['orka-init-v2', boundBytes.toString('base64'), initId]), Owner: owner, Epoch: String(epoch), 'Epoch@odata.type': 'Edm.Int64',
    Invocation: epoch === 0 ? initId : invocation, Operation: epoch === 0 ? 'initialize' : owner ? 'acquire' : kind === 'clean-release' ? 'release' : 'recover',
    Plan: epoch === 0 ? hash(['initialize', initId]) : 'a'.repeat(64), State: '', 'State@odata.type': 'Edm.Binary', Result: '', 'Result@odata.type': 'Edm.Binary',
    Exit: epoch === 0 || (owner && epoch === 1) ? '' : Buffer.from(JSON.stringify(exitFixture(kind, owner ? epoch - 1 : epoch))).toString('base64'), 'Exit@odata.type': 'Edm.Binary' };
  return { ...m, Digest: mDigestV2(m) };
}
export function changedM2(original: Record<string, unknown>, change: Record<string, unknown>, version = 1) {
  const m = { ...original, ...change }; return stamp({ ...m, Digest: mDigestV2(m) }, version);
}
