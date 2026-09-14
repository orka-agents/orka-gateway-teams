import type { TestContext } from 'node:test';
import { createTableIngressStore } from '../../src/ingress/table-store.js';
import type { TableIngressStoreOptions } from '../../src/ingress/table-store.js';
import { auditBudget, indexBudget, pair } from './table-ingress-audit.js';
import { ingressBinding, tableService } from './table-service.js';
export const options = { audit: auditBudget, maxIndexBytes: indexBudget, now: () => 100 };
export const code = (expected: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === expected && !('cause' in e);
export async function initialized(t: TestContext) {
  const s = await tableService(t, 'ingress', 2);
  await createTableIngressStore(ingressBinding, s.dependencies, options).initialize(); return s;
}
export async function opened(t: TestContext, extra: Partial<TableIngressStoreOptions> = {}) {
  const s = await initialized(t); const j = createTableIngressStore(ingressBinding, s.dependencies, { ...options, ...extra });
  await j.open(); t.after(() => j.close().catch(() => undefined)); return { s, j };
}
export async function granted(t: TestContext, extra: Partial<TableIngressStoreOptions> = {}) {
  const fixture = await opened(t, extra); const p = pair(); await fixture.j.admit(p.event.body!, p.route.route);
  const g = await fixture.j.claimForForwarding(); if (!g) throw new Error('Expected native grant'); return { ...fixture, g, p };
}
export const payload = (row: Record<string, unknown>) => JSON.parse(Buffer.concat(Array.from({ length: Number(row.Count) }, (_, i) => Buffer.from(String(row['B' + i]), 'base64'))).toString());
export const state = (s: Awaited<ReturnType<typeof tableService>>) => JSON.parse(Buffer.from(String(s.rows.get('M')?.State), 'base64').toString());
export const result = (s: Awaited<ReturnType<typeof tableService>>) => JSON.parse(Buffer.from(String(s.rows.get('M')?.Result), 'base64').toString());
export const rowKey = (type: string, id: string) => type + '_' + Buffer.from(id).toString('base64url');
