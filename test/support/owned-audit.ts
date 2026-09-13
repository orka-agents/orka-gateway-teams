import type { TestContext } from 'node:test';
import { createTableKernel, createTableKernelV2 } from '../../src/storage/table/index.js';
import type { OwnedAuditBudget, TableLimits } from '../../src/storage/table/index.js';
import { boundBytes, hash, partition, stamp, tableBinding, tableService } from './table-service.js';

export const budget = (overrides: Partial<OwnedAuditBudget> = {}): OwnedAuditBudget => ({
  maxPages: 20, maxPageBytes: 1024 * 1024, maxDurationMs: 30000, maxTrackingBytes: 128 * 1024, ...overrides,
});
export const visitor = () => ({ passes: 1 as const, record() {}, endPass() {}, finalize() {} });
export const code = (want: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === want &&
  e.message === 'Table storage: ' + want && !('cause' in e) && !('request' in e) && !('response' in e);
export const emptyInput = { input: Buffer.alloc(0), keys: [] };
export const emptyPlan = () => ({ state: Buffer.alloc(0), result: Buffer.alloc(0), actions: [] });
export async function owned(t: TestContext, format: 1 | 2, limits: Partial<TableLimits> = {}) {
  const s = await tableService(t, 'delivery', format);
  const k = (format === 1 ? createTableKernel : createTableKernelV2)(tableBinding, s.dependencies, limits);
  await k.initialize(); await k.acquire(); return { s, k };
}
// Independent data envelope: no production codec/encoder/row or digest recipe helpers.
export function wireData(id = 'item', payload = Buffer.from('audit payload')) {
  const e: Record<string, unknown> = { PartitionKey: partition, RowKey: 'delivery_' + Buffer.from(id).toString('base64url'), V: 1,
    T: 'delivery', Id: id, Length: payload.length, Count: Math.ceil(payload.length / 65536),
    Digest: hash(['orka-data-v1', boundBytes.toString('base64'), 'delivery', id, payload.toString('base64')]) };
  for (let i = 0; i < Number(e.Count); i++) { e['B' + i] = payload.subarray(i * 65536, (i + 1) * 65536).toString('base64'); e['B' + i + '@odata.type'] = 'Edm.Binary'; }
  return stamp(e, 90);
}
export function putData(s: Awaited<ReturnType<typeof tableService>>, id = 'item') {
  const e = wireData(id); s.rows.set(String(e.RowKey), e); return String(e.RowKey);
}
