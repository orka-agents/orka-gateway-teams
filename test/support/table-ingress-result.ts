import { createHash } from 'node:crypto';
import { digest, encode, fingerprint, matchRoute, validateScope } from '../../src/ingress/codec.js';
import { encodeEvent, encodeRoute, encodeSeal, encodeState } from '../../src/ingress/table-codec.js';
import type { EventPayload, EventSummary, InboxGraph, InboxResult, InboxResultBasis, InboxState, SealPayload } from '../../src/ingress/table-types.js';
import type { ResultValidationContext } from '../../src/ingress/table-result.js';
import { bindTable, data, dataRow, initializationDigestV2, metadataV2 } from '../../src/storage/table/codec.js';
import type { DataKey, MetadataV2 } from '../../src/storage/table/types.js';
import { eventFixture, routeFixture, stateFixture } from './table-ingress.js';

export const owner = '33333333-3333-4333-8333-333333333333';
export const nextOwner = '66666666-6666-4666-8666-666666666666';
export const invocation = '44444444-4444-4444-8444-444444444444';
export const laterInvocation = '55555555-5555-4555-8555-555555555555';
export const scope = validateScope({ appId: 'synthetic-app', tenantId: 'synthetic-tenant',
  orkaBaseUrl: 'https://synthetic.orka.invalid/', gatewayNamespace: 'synthetic-ns', gatewayName: 'synthetic-gateway' });
export const binding = bindTable({ account: 'syntheticaccount', table: 'synthetictable', storeId: 'synthetic-inbox', kind: 'ingress', scope });
/** Independent JSON-hash recipe, not the production Table/result helper. */
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
export function stateHash(state: InboxState, recovery = false): string {
  return hash([recovery ? 'orka-recovery-state-v2' : 'orka-inbox-state-v1', binding.bytes.toString('base64'), encodeState(state).toString('base64')]);
}
export function coherentEvent(order = 1, change: Partial<EventPayload> = {}): EventSummary {
  const body = { ...eventFixture().body!, externalEventId: `synthetic-event-${order}`, replyTarget: `synthetic-target-${order}` };
  const route = routeFixture().route; matchRoute(body, route, scope);
  const payload = { ...eventFixture(), body, replyTarget: body.replyTarget, bodyDigest: digest(encode(body)), fingerprint: fingerprint(body, route, scope), order, ...change };
  const { body: ignored, ...summary } = payload; void ignored;
  // The fixture's full fingerprint uses the real synthetic scope and route, not Task1's placeholder.
  encodeEvent({ type: 'event', id: body.externalEventId }, payload);
  return { ...summary, externalEventId: body.externalEventId };
}
/** Small receiver-dependent maps exist only in tests. No fabricated body in summaries. */
export class Graph implements InboxGraph {
  readonly events = new Map<number, EventSummary>();
  readonly seals = new Map<number, SealPayload>();
  constructor(events: EventSummary[] = [], seals: SealPayload[] = []) {
    for (const event of events) this.events.set(event.order, event);
    for (const seal of seals) this.seals.set(seal.generation, seal);
  }
  eventById(id: string): EventSummary | undefined { for (const event of this.events.values()) if (event.externalEventId === id) return event; return undefined; }
  eventByTarget(target: string): EventSummary | undefined { for (const event of this.events.values()) if (event.replyTarget === target) return event; return undefined; }
  eventByOrder(order: number): EventSummary | undefined { return this.events.get(order); }
  sealByGeneration(generation: number): SealPayload | undefined { return this.seals.get(generation); }
}
export function basis(state: InboxState): InboxResultBasis {
  return { records: state.records, bodies: state.bodies, lastNow: state.lastNow, restartEpoch: state.restartEpoch,
    currentGeneration: state.currentGeneration, arm: state.handoffClockArm };
}
export function ordinary(operation: string, decision: unknown, state = stateFixture(), before = state,
  time: number | null = state.lastNow): InboxResult {
  return { schema: 1, operation, epoch: state.restartEpoch, basis: operation === 'initialize' ? null : basis(before),
    clock: time === null ? null : { time }, decision, postStateDigest: stateHash(state) } as InboxResult;
}
/** Complete synthetic physical rows are built only for independent recovery-fold tests. */
export function physicalRows(graph: Graph): { rowKey: string; rowDigest: string }[] {
  const rows: { rowKey: string; rowDigest: string }[] = [];
  const add = (key: DataKey, payload: Buffer) => rows.push({ rowKey: dataRow(binding, key), rowDigest: data(binding, key, payload).digest });
  for (const event of graph.events.values()) {
    const { externalEventId, ...summary } = event;
    const body = event.state === 'terminal' ? null : { ...eventFixture().body!, externalEventId, replyTarget: event.replyTarget };
    add({ type: 'event', id: externalEventId }, encodeEvent({ type: 'event', id: externalEventId }, { ...summary, body }));
    add({ type: 'route', id: event.replyTarget }, encodeRoute({ type: 'route', id: event.replyTarget }, { ...routeFixture(), externalEventId }));
  }
  for (const seal of graph.seals.values()) {
    const key: DataKey = { type: 'control', id: `generation:${seal.generation}` }; add(key, encodeSeal(key, seal));
  }
  return rows.sort((a, b) => a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0);
}
export function fold(rows: { rowKey: string; rowDigest: string }[]): string {
  let h = hash(['orka-recovery-data-v2', binding.bytes.toString('base64')]);
  for (const row of rows) h = hash(['orka-recovery-row-v2', h, row.rowKey, row.rowDigest]);
  return hash(['orka-recovery-data-end-v2', h, rows.length]);
}
export function context(result: InboxResult, state = stateFixture(), graph = new Graph([coherentEvent()]),
  changes: Partial<MetadataV2> = {}): ResultValidationContext {
  // Ordinary predicate negatives may deliberately contradict local row rules. Do not
  // accidentally test a fixture encoder instead of the retained-result boundary.
  const rows = result.operation === 'operator-recovery' ? physicalRows(graph) : undefined;
  const epoch = changes.epoch ?? state.restartEpoch;
  const metadata = metadataV2(binding, { initId: invocation, initDigest: initializationDigestV2(binding, invocation), owner: epoch === 1 ? owner : nextOwner,
    epoch, invocation, operation: 'mutate', plan: hash(['synthetic-plan']), state: encodeState(state), result: encode(result),
    exit: epoch === 1 ? undefined : { kind: 'clean-release', oldOwner: owner, oldEpoch: epoch - 1,
      invocation: laterInvocation, planDigest: hash(['synthetic-clean-plan']) }, ...changes });
  return { binding, metadata, state, graph, postDataDigest: rows ? fold(rows) : hash(['synthetic-unused-ordinary-fold']),
    dataRowCount: rows?.length ?? graph.events.size * 2 + graph.seals.size };
}
