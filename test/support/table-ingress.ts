import { digest, encode } from '../../src/ingress/codec.js';
import type { EventPayload, InboxState, RoutePayload, SealPayload } from '../../src/ingress/table-types.js';
import type { DataKey } from '../../src/storage/table/types.js';
import { TableError } from '../../src/storage/table/types.js';
import assert from 'node:assert/strict';

export const eventKey: DataKey = { type: 'event', id: 'synthetic-event' };
export const routeKey: DataKey = { type: 'route', id: 'synthetic-target' };
export const generationKey: DataKey = { type: 'control', id: 'generation:1' };
export const attemptId = '11111111-1111-4111-8111-111111111111';
export const armId = '22222222-2222-4222-8222-222222222222';
export function stateFixture(change: Partial<InboxState> = {}): InboxState {
  return { journal: 'teams-inbox', schema: 1, fingerprintVersion: 1, records: 1, bodies: 1,
    lastNow: 100, restartEpoch: 1, currentGeneration: 1, handoffClockArm: null, ...change };
}
export function eventFixture(change: Partial<EventPayload> = {}): EventPayload {
  const body = { protocolVersion: 'orka.gateway.v1' as const, externalEventId: eventKey.id, eventType: 'text' as const,
    accountId: 'synthetic-tenant', contextId: 'synthetic-conversation', sender: { id: 'synthetic-sender' },
    text: 'Synthetic inbox text', replyTarget: routeKey.id };
  return { schema: 1, fingerprintVersion: 1, replyTarget: routeKey.id, fingerprint: 'a'.repeat(64), bodyDigest: digest(encode(body)),
    body, state: 'pending', received: 100, deadline: 200, nextAttempt: 100, attempt: 0, attemptId: null,
    attemptEpoch: 0, order: 1, generation: 1, receipt: null, reason: null, ...change };
}
export function routeFixture(change: Partial<RoutePayload> = {}): RoutePayload {
  const route = { serviceUrl: 'https://synthetic.example.invalid/', channelId: 'msteams' as const,
    bot: { id: 'synthetic-bot', role: 'bot' as const },
    conversation: { id: 'synthetic-conversation', conversationType: 'personal' as const, tenantId: 'synthetic-tenant' } };
  return { schema: 1, externalEventId: eventKey.id, route, routeDigest: digest(encode(route)), ...change };
}
export function sealFixture(change: Partial<SealPayload> = {}): SealPayload {
  return { schema: 1, kind: 'generation-seal', generation: 1, lastOrder: 1, watermark: 150, observation: 140,
    epoch: 1, reason: 'clock-regression', ...change };
}
/** Failure diagnostics intentionally contain no payload, digest, identity or raw exception. */
export function rejectsSafely(work: () => unknown, code: 'corrupt' | 'invalid-input'): void {
  let safe = false;
  try { work(); } catch (error) {
    safe = error instanceof TableError && error.code === code && error.cause === undefined &&
      error.message === `Table storage: ${code}`;
  }
  assert.equal(safe, true, `expected closed ${code}`);
}
