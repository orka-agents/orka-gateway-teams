import type { TestContext } from 'node:test';
import { createTableKernelV2 } from '../../src/storage/table/index.js';
import { bindTable } from '../../src/storage/table/codec.js';
import { encodeState } from '../../src/ingress/table-codec.js';
import { digest, encode, fingerprint } from '../../src/ingress/codec.js';
import type { EventPayload, InboxState, InboxResult, RoutePayload, SealPayload } from '../../src/ingress/table-types.js';
import type { DataAction, TableDependencies } from '../../src/storage/table/types.js';
import type { TableKernelV2 } from '../../src/storage/table/index.js';
import { eventFixture, routeFixture } from './table-ingress.js';
import { encodeResult, stateDigest } from '../../src/ingress/table-result.js';
import { initialState } from '../../src/ingress/table-state.js';
import { hash, ingressBinding, stamp, tableService } from './table-service.js';

export const auditBudget = { maxPages: 64, maxPageBytes: 8 * 1024 * 1024, maxDurationMs: 30000, maxTrackingBytes: 1024 * 1024 };
export const indexBudget = 8 * 1024 * 1024;
export function pair(id = 'event-a', target = 'target-a', order = 1) {
  const route = routeFixture(); route.externalEventId = id;
  route.route.conversation.tenantId = ingressBinding.scope.tenantId;
  route.routeDigest = digest(encode(route.route));
  const body = { ...eventFixture().body!, externalEventId: id, replyTarget: target, accountId: ingressBinding.scope.tenantId };
  const event = eventFixture({ body, replyTarget: target, bodyDigest: digest(encode(body)),
    fingerprint: fingerprint(body, route.route, ingressBinding.scope as never), order });
  return { id, target, event, route };
}
export interface History {
  state: InboxState; pairs: { id: string; target: string; event: EventPayload; route: RoutePayload }[];
  seals?: SealPayload[]; result?: InboxResult;
}
export function ordinary(state: InboxState): Extract<InboxResult, { operation: 'complete' }> {
  return { schema: 1, operation: 'complete', epoch: state.restartEpoch,
    basis: { records: state.records, bodies: state.bodies, lastNow: state.lastNow, restartEpoch: state.restartEpoch,
      currentGeneration: state.currentGeneration, arm: state.handoffClockArm }, clock: { time: state.lastNow },
    decision: { claim: { eventId: 'absent-event', attemptId: '33333333-3333-4333-8333-333333333333', attempt: 1 },
      receipt: { status: 'accepted', eventId: 'receipt', state: 'Queued' }, applied: false },
    postStateDigest: stateDigest(bindTable(ingressBinding), encodeState(state)) };
}
export function wireData(s: Awaited<ReturnType<typeof tableService>>, type: string, id: string, payload: Buffer) {
  const m = s.rows.get('M')!;
  const e: Record<string, unknown> = { PartitionKey: m.PartitionKey, RowKey: type + '_' + Buffer.from(id).toString('base64url'),
    V: 1, T: type, Id: id, Length: payload.length, Count: Math.ceil(payload.length / 65536),
    Digest: hash(['orka-data-v1', m.Binding, type, id, payload.toString('base64')]) };
  for (let i = 0; i < Number(e.Count); i++) { e['B' + i] = payload.subarray(i * 65536, (i + 1) * 65536).toString('base64'); e['B' + i + '@odata.type'] = 'Edm.Binary'; }
  return stamp(e, 90);
}
export async function install(k: TableKernelV2, history: History): Promise<void> {
  const actions: DataAction[] = [];
  for (const p of history.pairs) {
    actions.push({ kind: 'create', key: { type: 'event', id: p.id }, payload: encode(p.event) });
    actions.push({ kind: 'create', key: { type: 'route', id: p.target }, payload: encode(p.route) });
  }
  for (const seal of history.seals ?? []) actions.push({ kind: 'create', key: { type: 'control', id: 'generation:' + seal.generation }, payload: encode(seal) });
  await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state: encodeState(history.state),
    result: encodeResult(history.result ?? ordinary(history.state)), actions }));
}
/** Native public SDK fixture; only existing kernel mutations install test history. */
export async function inboxOwned(t: TestContext) {
  const s = await tableService(t, 'ingress', 2);
  const tokens: { hook?: TableDependencies['token'] } = {};
  const k = createTableKernelV2(ingressBinding, { ...s.dependencies, token: (...args) => (tokens.hook ?? s.dependencies.token)(...args) });
  await k.initialize(); await k.acquire(); await k.scan();
  const state = encodeState(initialState());
  await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state,
    result: encodeResult({ schema: 1, operation: 'initialize', epoch: 1, basis: null, clock: null,
      decision: { kind: 'initialized' }, postStateDigest: stateDigest(bindTable(ingressBinding), state) }), actions: [] }));
  return { s, k, tokens };
}
