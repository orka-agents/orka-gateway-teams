import type { TestContext } from 'node:test';
import { createTableDeliveryJournal, createTableDeliveryJournalV2 } from '../../src/delivery/table-journal.js';
import type { TableDeliveryJournalLimits } from '../../src/delivery/table-journal.js';
import { DeliveryJournalError } from '../../src/delivery/types.js';
import { finalDelivery } from '../fixtures/outgoing.js';
import { boundBytes, hash, mDigest, partition, stamp, tableBinding, tableService, wireM } from './table-service.js';
import { mDigestV2, wireM2 } from './table-v2.js';

export const request = { ...finalDelivery, accountId: 'Tenant' };
export const scope = { appId: 'App', tenantId: 'Tenant' };
export const code = (want: string) => (e: unknown) => e instanceof DeliveryJournalError && e.code === want && !('cause' in e);
export const rowKey = (type: string, id: string) => `${type}_${Buffer.from(id).toString('base64url')}`;
export function payload(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(Buffer.from(String(row.B0), 'base64').toString()) as Record<string, unknown>;
}
export function dataEntity(type: string, id: string, value: unknown) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return stamp({ PartitionKey: partition, RowKey: rowKey(type, id), V: 1, T: type, Id: id, Length: b.length, Count: 1,
    B0: b.toString('base64'), 'B0@odata.type': 'Edm.Binary', Digest: hash(['orka-data-v1', boundBytes.toString('base64'), type, id, b.toString('base64')]) }, 90000);
}
export function replacePayload(s: Awaited<ReturnType<typeof tableService>>, type: string, id: string, value: unknown) {
  s.rows.set(rowKey(type, id), dataEntity(type, id, value));
}
function replaceControlFor(format: 1 | 2, s: Awaited<ReturnType<typeof tableService>>, field: 'State' | 'Result', value: unknown) {
  const m = { ...s.rows.get('M')!, [field]: (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString('base64') };
  s.rows.set('M', stamp({ ...m, Digest: (format === 1 ? mDigest : mDigestV2)(m) }, 90001));
}
export async function initialized(t: TestContext) {
  const s = await tableService(t); const init = createTableDeliveryJournal(tableBinding, s.dependencies);
  await init.initialize(); await init.close(); return s;
}
/** Explicit format parameter controls the factory, HTTPS oracle and EVERY M rewrite. */
export function deliveryFormat(format: 1 | 2) {
  const create = format === 1 ? createTableDeliveryJournal : createTableDeliveryJournalV2;
  const service = (t: TestContext) => tableService(t, 'delivery', format);
  const initialized = async (t: TestContext) => {
    const s = await service(t); const init = create(tableBinding, s.dependencies); await init.initialize(); await init.close(); return s;
  };
  const opened = async (t: TestContext, limits: TableDeliveryJournalLimits = {}) => {
    const s = await initialized(t); const j = create(tableBinding, s.dependencies, limits); await j.open();
    t.after(async () => { await j.close().catch(() => undefined); }); return { s, j };
  };
  return { create, tableService: service, initialized, opened, wireM: format === 1 ? wireM : wireM2,
    replaceControl: (s: Awaited<ReturnType<typeof tableService>>, field: 'State' | 'Result', value: unknown) => replaceControlFor(format, s, field, value) };
}
