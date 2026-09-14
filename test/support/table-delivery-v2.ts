import { createTableDeliveryJournalV2 } from '../../src/delivery/table-journal.js';
import type { TestContext } from 'node:test';
import { request, rowKey } from './table-delivery.js';
import { boundBytes, hash, tableBinding, tableService } from './table-service.js';
import { changedM2, invocation, oldOwner } from './table-v2.js';

type Service = Awaited<ReturnType<typeof tableService>>;
export type RecipeFault = 'count' | 'order' | 'row-tag' | 'end-tag' | 'domain-tag' | 'payload-hash' | 'binding';
/** Independent test-only commitment over raw fixture entities, not production codecs. */
export function disposition(s: Pick<Service, 'rows'>, fault?: RecipeFault, bindingBytes = boundBytes): string {
  const m = s.rows.get('M')!;
  const binding = fault === 'binding' ? '' : bindingBytes.toString('base64');
  const rows = [...s.rows.entries()].filter(([key]) => key !== 'M').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (fault === 'order') rows.reverse();
  let h = hash(['orka-recovery-data-v2', binding]);
  for (const [row, entity] of rows) h = hash([fault === 'row-tag' ? 'orka-recovery-row-v1' : 'orka-recovery-row-v2', h, row,
    fault === 'payload-hash' ? hash(entity.B0) : entity.Digest]);
  const count = rows.length + (fault === 'count' ? 1 : 0);
  const data = hash([fault === 'end-tag' ? 'orka-recovery-data-v2' : 'orka-recovery-data-end-v2', h, count]);
  return hash([fault === 'domain-tag' ? 'orka-ingress-recovery-v2' : 'orka-delivery-recovery-v2', binding, m.State, m.Result, data, count, 'epoch-restart']);
}
/** Reader fixture only: this neither executes recovery nor establishes operator authority. */
export function installRecovery(s: Service, digest = disposition(s)): string {
  const m = s.rows.get('M')!;
  const exit = Buffer.from(JSON.stringify({ kind: 'operator-recovery', oldOwner, oldEpoch: Number(m.Epoch), invocation,
    originalMDigest: m.Digest, planDigest: 'a'.repeat(64), domainDispositionDigest: digest, operatorAttestationDigest: 'd'.repeat(64) })).toString('base64');
  s.rows.set('M', changedM2(m, { Owner: '', Operation: 'recover', Invocation: invocation, Plan: 'a'.repeat(64), Exit: exit }, 91000));
  return exit;
}
export async function recoveryHistory(t: TestContext, two = false) {
  const s = await tableService(t, 'delivery', 2);
  const init = createTableDeliveryJournalV2(tableBinding, s.dependencies); await init.initialize();
  const j = createTableDeliveryJournalV2(tableBinding, s.dependencies); await j.open();
  const first = await j.begin(request); if (first.kind !== 'claimed') throw new Error('Fixture claim missing');
  const secondRequest = { ...request, idempotencyId: 'second-stable', deliveryId: 'second-alias' };
  if (two) {
    const second = await j.begin(secondRequest); if (second.kind !== 'claimed') throw new Error('Fixture claim missing');
    await j.settle(second.claim, { kind: 'delivered', providerMessageId: 'retained-second-receipt' });
  }
  await j.close(); const exit = installRecovery(s);
  return { s, exit, claim: first.claim, secondRequest };
}
export function deleteFirstGraph(s: Service): void {
  for (const [type, id] of [['delivery', request.idempotencyId], ['alias', request.idempotencyId], ['alias', request.deliveryId]]) s.rows.delete(rowKey(type!, id!));
}
