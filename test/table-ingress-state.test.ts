import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '../src/ingress/codec.js';
import { decodeSeal, decodeState, encodeSeal, encodeState } from '../src/ingress/table-codec.js';
import { advanceClock, initialState, projectEvent, sealKey } from '../src/ingress/table-state.js';
import { MAX_INBOX_TIME } from '../src/ingress/table-types.js';
import type { EventPayload } from '../src/ingress/table-types.js';
import { armId, attemptId, eventFixture, rejectsSafely, sealFixture, stateFixture } from './support/table-ingress.js';

test('initial state is fresh and can advance time without creating a generation', () => {
  const first = initialState(); first.records = 1;
  assert.equal(initialState().records, 0);
  const result = advanceClock(initialState(), 50, 1);
  assert.equal(result.state.lastNow, 50); assert.equal(result.state.currentGeneration, null);
  assert.equal(result.seal, undefined);
});

test('seal key derives the closed control ID and rejects invalid ordinal inputs', () => {
  assert.deepEqual(sealKey(1), { type: 'control', id: 'generation:1' });
  assert.deepEqual(sealKey(100000), { type: 'control', id: 'generation:100000' });
  for (const value of [0, -1, 1.5, 100001, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1' as unknown as number]) {
    rejectsSafely(() => sealKey(value), 'invalid-input');
  }
});

for (const time of [100, 101, MAX_INBOX_TIME]) test(`nonregressing clock ${time === MAX_INBOX_TIME ? 'maximum' : time} preserves generation and raises only the watermark`, () => {
  const before = stateFixture(); const result = advanceClock(before, time, 2);
  assert.equal(result.state.lastNow, time); assert.equal(result.state.restartEpoch, 1);
  assert.equal(result.state.currentGeneration, 1); assert.equal(result.state.records, 1); assert.equal(result.state.bodies, 1);
  assert.equal(result.seal, undefined); assert.equal(before.lastNow, 100);
});

test('regression seals exactly the current nonempty interval with old watermark and actual sample', () => {
  const before = stateFixture({ records: 5, bodies: 2, lastNow: 200, currentGeneration: 3,
    handoffClockArm: { id: armId, ownerEpoch: 1, generation: 3, order: 4, attemptId } });
  const result = advanceClock(before, 140, 2);
  assert.deepEqual(result.seal, { schema: 1, kind: 'generation-seal', generation: 3, lastOrder: 5, watermark: 200,
    observation: 140, epoch: 2, reason: 'clock-regression' });
  assert.equal(result.state.currentGeneration, null); assert.equal(result.state.lastNow, 200);
  assert.equal(result.state.records, 5); assert.equal(result.state.bodies, 2); assert.equal(result.state.restartEpoch, 1);
  assert.equal(encode(result.state.handoffClockArm).equals(encode(before.handoffClockArm)), true);
  // The prepared epoch is advanced by the future open planner, not clock processing.
  assert.equal(decodeState(encodeState(result.state)).restartEpoch, 1);
  assert.equal(decodeSeal(sealKey(3), encodeSeal(sealKey(3), result.seal!)).epoch, 2);
});

test('a nonempty all-terminal interval still seals, but repeated empty regressions never create controls', () => {
  const once = advanceClock(stateFixture({ records: 3, bodies: 0, lastNow: 200 }), 150, 1);
  assert.equal(once.seal?.lastOrder, 3);
  for (const time of [140, 0, 199, 200, 300, 250]) {
    const next = advanceClock(once.state, time, 1);
    assert.equal(next.seal, undefined); assert.equal(next.state.currentGeneration, null);
    assert.equal(next.state.lastNow, Math.max(200, time));
  }
  const empty = advanceClock({ ...initialState(), lastNow: 200 }, 0, 2);
  assert.equal(empty.seal, undefined); assert.equal(empty.state.records, 0);
});

for (const value of [-1, MAX_INBOX_TIME + 1, 1.1, NaN, Infinity, '100' as unknown as number]) {
  test('invalid external clock samples are safe invalid-input, without changing state', () => {
    const state = stateFixture(); const before = encode(state);
    rejectsSafely(() => advanceClock(state, value, 1), 'invalid-input');
    assert.equal(encode(state).equals(before), true);
  });
}
for (const value of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1' as unknown as number]) {
  test('invalid external epochs cannot seal or change the watermark', () => {
    const state = stateFixture(); const before = encode(state);
    rejectsSafely(() => advanceClock(state, 0, value), 'invalid-input');
    assert.equal(encode(state).equals(before), true);
  });
}

test('maximum safe epoch remains representable without clock-side increment', () => {
  const result = advanceClock(stateFixture({ restartEpoch: Number.MAX_SAFE_INTEGER }), 0, Number.MAX_SAFE_INTEGER);
  assert.equal(result.state.restartEpoch, Number.MAX_SAFE_INTEGER); assert.equal(result.seal?.epoch, Number.MAX_SAFE_INTEGER);
});

for (const physical of ['pending', 'forwarding'] as const) {
  const event = eventFixture({ state: physical, attempt: 1, attemptId, attemptEpoch: 1 });
  test(`${physical} becomes deadline-blocked at equality in the current generation`, () => {
    assert.deepEqual(projectEvent(event, stateFixture({ lastNow: 199 })), { state: physical, reason: null, attemptId });
    assert.deepEqual(projectEvent(event, stateFixture({ lastNow: 200 })), { state: 'blocked', reason: 'deadline', attemptId });
  });
  test(`${physical} expired before later regression stays deadline-blocked`, () => {
    const high = advanceClock(stateFixture(), 200, 1).state;
    const closed = advanceClock(high, 110, 1);
    assert.deepEqual(projectEvent(event, closed.state, closed.seal), { state: 'blocked', reason: 'deadline', attemptId });
  });
  for (const reason of ['clock-regression', 'clock-uncertain'] as const) test(`${physical} ${reason} stays frozen despite later global expiry and restart`, () => {
    const seal = sealFixture({ reason, observation: reason === 'clock-uncertain' ? null : 140 });
    const state = stateFixture({ lastNow: 1000, restartEpoch: 2, currentGeneration: null });
    assert.deepEqual(projectEvent(event, state, seal), { state: 'blocked', reason, attemptId });
    assert.deepEqual(projectEvent({ ...event, deadline: 150 }, state, seal), { state: 'blocked', reason: 'deadline', attemptId });
    const laterGeneration = { ...state, records: 2, currentGeneration: 2 };
    assert.deepEqual(projectEvent(event, laterGeneration, seal), { state: 'blocked', reason, attemptId });
  });
}

for (const reason of ['conflict', 'invalid-event', 'redirect'] as const) test(`explicit ${reason} precedes deadline, seals and epoch projection`, () => {
  const event = eventFixture({ state: 'blocked', reason, attempt: 1, attemptId, attemptEpoch: 1 });
  const state = stateFixture({ lastNow: 1000, restartEpoch: 2, currentGeneration: null });
  for (const seal of [undefined, sealFixture(), sealFixture({ reason: 'clock-uncertain', observation: null })]) {
    assert.deepEqual(projectEvent(event, state, seal), { state: 'blocked', reason, attemptId });
  }
});
test('terminal receipt and physical body removal never become deadline, seal or restart states', () => {
  const event = eventFixture({ state: 'terminal', body: null, attempt: 1, attemptId, attemptEpoch: 1,
    receipt: { status: 'accepted', eventId: 'synthetic-receipt', state: 'Queued' } });
  const before = encode(event);
  const state = stateFixture({ bodies: 0, lastNow: 1000, restartEpoch: 2, currentGeneration: null });
  for (const seal of [undefined, sealFixture(), sealFixture({ reason: 'clock-uncertain', observation: null })]) {
    assert.deepEqual(projectEvent(event, state, seal), { state: 'terminal', reason: null, attemptId });
  }
  assert.equal(encode(event).equals(before), true);
});

test('only otherwise-active old forwarding becomes pending and loses the effective attempt ID', () => {
  const event = eventFixture({ state: 'forwarding', attempt: 2, attemptId, attemptEpoch: 1 });
  const before = encode(event);
  assert.deepEqual(projectEvent(event, stateFixture()), { state: 'forwarding', reason: null, attemptId });
  assert.deepEqual(projectEvent(event, stateFixture({ restartEpoch: 2 })), { state: 'pending', reason: null, attemptId: null });
  assert.deepEqual(projectEvent({ ...event, state: 'pending' }, stateFixture({ restartEpoch: 2 })), { state: 'pending', reason: null, attemptId });
  assert.deepEqual(projectEvent(eventFixture(), stateFixture({ restartEpoch: 2 })), { state: 'pending', reason: null, attemptId: null });
  assert.equal(encode(event).equals(before), true);
});

for (const state of ['pending', 'forwarding', 'blocked', 'terminal'] as const) test(`future physical ${state} attempt epochs fail closed`, () => {
  const event = eventFixture({ state, attempt: 1, attemptId, attemptEpoch: 3,
    reason: state === 'blocked' ? 'conflict' : null, body: state === 'terminal' ? null : eventFixture().body,
    receipt: state === 'terminal' ? { status: 'accepted', eventId: 'synthetic-receipt', state: 'Queued' } : null });
  rejectsSafely(() => projectEvent(event, stateFixture({ restartEpoch: 2 })), 'corrupt');
});

for (const [label, event, state, seal] of [
  ['ordinal beyond state count', eventFixture({ order: 2 }), stateFixture(), undefined],
  ['received above high-water', eventFixture(), stateFixture({ lastNow: 99 }), undefined],
  ['missing closed-generation seal', eventFixture(), stateFixture({ currentGeneration: null }), undefined],
  ['different current generation', eventFixture(), stateFixture({ records: 2, currentGeneration: 2 }), undefined],
  ['current generation also sealed', eventFixture(), stateFixture({ lastNow: 150 }), sealFixture()],
  ['mismatched seal generation', eventFixture(), stateFixture({ records: 2, lastNow: 150, currentGeneration: null }), sealFixture({ generation: 2, lastOrder: 2 })],
  ['event beyond seal interval', eventFixture({ order: 2 }), stateFixture({ records: 2, lastNow: 150, currentGeneration: null }), sealFixture()],
  ['seal extends beyond records', eventFixture(), stateFixture({ lastNow: 150, currentGeneration: null }), sealFixture({ lastOrder: 2 })],
  ['seal overlaps current interval', eventFixture(), stateFixture({ records: 2, lastNow: 150, currentGeneration: 2 }), sealFixture({ lastOrder: 2 })],
  ['seal watermark above state', eventFixture(), stateFixture({ currentGeneration: null }), sealFixture()],
  ['received above seal watermark', eventFixture(), stateFixture({ currentGeneration: null }), sealFixture({ watermark: 99, observation: 98 })],
  ['attempt newer than its seal', eventFixture({ attempt: 1, attemptId, attemptEpoch: 2 }), stateFixture({ restartEpoch: 2, lastNow: 150, currentGeneration: null }), sealFixture()],
] as const) test(`projection rejects ${label} instead of granting eligibility`, () => {
  rejectsSafely(() => projectEvent(event, state, seal), 'corrupt');
});

test('clock processing before open epoch preparation can safely project a newly sealed old attempt', () => {
  const event = eventFixture({ state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  const result = advanceClock(stateFixture({ lastNow: 150 }), 140, 2);
  assert.equal(result.state.restartEpoch, 1);
  assert.deepEqual(projectEvent(event, result.state, result.seal), { state: 'blocked', reason: 'clock-regression', attemptId });
});

test('pure helpers leave frozen caller state, arm, event and seal untouched', () => {
  const arm = Object.freeze({ id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId });
  const state = Object.freeze(stateFixture({ lastNow: 150, handoffClockArm: arm }));
  const source = eventFixture({ state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  Object.freeze(source.body!.sender); Object.freeze(source.body); const event: Readonly<EventPayload> = Object.freeze(source);
  const stateBefore = encode(state); const eventBefore = encode(event);
  const result = advanceClock(state, 140, 2); Object.freeze(result.seal);
  const projected = projectEvent(event, result.state, result.seal);
  assert.equal(encode(projected).equals(encode({ state: 'blocked', reason: 'clock-regression', attemptId })), true);
  result.state.handoffClockArm!.order = 2; result.state.lastNow = 160;
  projected.attemptId = null;
  assert.equal(encode(state).equals(stateBefore), true); assert.equal(encode(event).equals(eventBefore), true);
});

test('inbox projection exposes initial state and the pure helper boundary', async () => {
  const path = '../src/ingress/table-state.js';
  const api = await import(path).catch(() => ({})) as Record<string, unknown>;
  for (const name of ['initialState', 'sealKey', 'advanceClock', 'projectEvent']) assert.equal(typeof api[name], 'function', name);
  const initialState = api.initialState as () => unknown;
  assert.deepEqual(initialState(), { journal: 'teams-inbox', schema: 1, fingerprintVersion: 1, records: 0, bodies: 0,
    lastNow: 0, restartEpoch: 1, currentGeneration: null, handoffClockArm: null });
});
