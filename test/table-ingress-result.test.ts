import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '../src/ingress/codec.js';
import { encodeState } from '../src/ingress/table-codec.js';
import { decodeResult, encodeResult, stateDigest, validateResult } from '../src/ingress/table-result.js';
import { initialState, projectEvent } from '../src/ingress/table-state.js';
import type { InboxResult } from '../src/ingress/table-types.js';
import { MAX_INBOX_TIME } from '../src/ingress/table-types.js';
import { armId, attemptId, rejectsSafely, sealFixture, stateFixture } from './support/table-ingress.js';
import { binding, coherentEvent, context, Graph, hash, ordinary, stateHash } from './support/table-ingress-result.js';

const claim = { eventId: 'synthetic-event-1', attemptId, attempt: 1 };
const arm = { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId };
const receipt = { status: 'accepted' as const, eventId: 'synthetic-receipt', state: 'Queued' };
const policy = { maxRecords: 100000, maxPending: 1000, replayWindowMs: 100 };
const admission = { eventId: claim.eventId, replyTarget: 'synthetic-target-1', fingerprint: coherentEvent().fingerprint, policy,
  outcome: { kind: 'duplicate', replyTarget: 'synthetic-target-1' } };
const samples = [
  ordinary('initialize', { kind: 'initialized' }, initialState(), initialState(), null),
  ordinary('open', { kind: 'opened' }),
  ...['accepted', 'duplicate', 'conflict', 'full'].map(kind => ordinary('admit', { ...admission,
    outcome: ['accepted', 'duplicate'].includes(kind) ? { kind, replyTarget: admission.replyTarget } : { kind } })),
  ordinary('claim', { kind: 'empty' }), ordinary('claim', { kind: 'claimed', ...claim }),
  ...[true, false].flatMap(applied => [ordinary('complete', { claim, receipt, applied }),
    ordinary('retry', { claim, delayMs: 100, applied }), ordinary('block', { claim, reason: 'redirect', applied }),
    ordinary('revalidate', { armId, eligible: applied }),
    ordinary('handoff-finalize', { armId, sampling: 'captured', domainEligible: applied })]),
  ordinary('handoff-finalize', { armId, sampling: 'none', domainEligible: null }, stateFixture(), stateFixture(), null),
];
for (const [index, result] of samples.entries()) {
  test(`closed canonical ordinary result variant ${index}`, () => {
    const expected = encode(result);
    const reverse = Object.fromEntries(Object.entries(result).reverse()) as unknown as InboxResult;
    assert.equal(encodeResult(reverse).equals(expected), true);
    assert.equal(encode(decodeResult(expected)).equals(expected), true);
    assert.equal(expected.length <= 4096, true);
  });
  for (const field of Object.keys(result)) test(`ordinary variant ${index} rejects missing ${field}`, () => {
    const bad = { ...result } as unknown as Record<string, unknown>; delete bad[field];
    rejectsSafely(() => encodeResult(bad as unknown as InboxResult), 'invalid-input');
    rejectsSafely(() => decodeResult(encode(bad)), 'corrupt');
  });
}
const valid = samples[6]!;
for (const [label, mutate] of [
  ['unknown outer', (v: Record<string, unknown>) => { v.body = 'not retained'; }],
  ['schema', (v: Record<string, unknown>) => { v.schema = 2; }],
  ['operation', (v: Record<string, unknown>) => { v.operation = 'take'; }],
  ['epoch zero', (v: Record<string, unknown>) => { v.epoch = 0; }],
  ['epoch unsafe', (v: Record<string, unknown>) => { v.epoch = Number.MAX_SAFE_INTEGER + 1; }],
  ['digest', (v: Record<string, unknown>) => { v.postStateDigest = 'A'.repeat(64); }],
  ['basis null', (v: Record<string, unknown>) => { v.basis = null; }],
  ['basis extra', (v: Record<string, unknown>) => { (v.basis as Record<string, unknown>).body = null; }],
  ['basis missing', (v: Record<string, unknown>) => { delete (v.basis as Record<string, unknown>).arm; }],
  ['basis counts', (v: Record<string, unknown>) => { (v.basis as Record<string, unknown>).bodies = 2; }],
  ['basis range', (v: Record<string, unknown>) => { (v.basis as Record<string, unknown>).records = 100001; }],
  ['basis time', (v: Record<string, unknown>) => { (v.basis as Record<string, unknown>).lastNow = MAX_INBOX_TIME + 1; }],
  ['basis generation', (v: Record<string, unknown>) => { (v.basis as Record<string, unknown>).currentGeneration = 2; }],
  ['basis arm', (v: Record<string, unknown>) => { (v.basis as Record<string, unknown>).arm = { ...arm, attemptId: 'invalid' }; }],
  ['null clock', (v: Record<string, unknown>) => { v.clock = null; }],
  ['clock extra', (v: Record<string, unknown>) => { v.clock = { time: 100, failed: true }; }],
  ['clock range', (v: Record<string, unknown>) => { v.clock = { time: MAX_INBOX_TIME + 1 }; }],
  ['decision extra', (v: Record<string, unknown>) => { v.decision = { kind: 'empty', takeReturnedTrue: false }; }],
  ['decision tag', (v: Record<string, unknown>) => { v.decision = { kind: 'cancelled' }; }],
] as const) test(`result rejects ${label} with closed errors`, () => {
  const v = structuredClone(valid) as unknown as Record<string, unknown>; mutate(v);
  rejectsSafely(() => encodeResult(v as unknown as InboxResult), 'invalid-input');
  rejectsSafely(() => decodeResult(encode(v)), 'corrupt');
});
for (const [operation, decision] of [
  ['admit', { ...admission, policy: { ...policy, maxPending: 100001 } }],
  ['admit', { ...admission, eventId: 'x'.repeat(257) }],
  ['admit', { ...admission, outcome: { kind: 'conflict', replyTarget: 'extra' } }],
  ['claim', { kind: 'claimed', ...claim, attempt: 0 }],
  ['claim', { kind: 'claimed', ...claim, attemptId: 'not-a-uuid' }],
  ['complete', { claim: { ...claim, event: {} }, receipt, applied: true }],
  ['complete', { claim, receipt: { ...receipt, state: 'Completed' }, applied: true }],
  ['retry', { claim, delayMs: -1, applied: true }],
  ['retry', { claim, delayMs: 1, applied: 1 }],
  ['block', { claim, reason: 'deadline', applied: true }],
  ['revalidate', { armId, eligible: null }],
  ['handoff-finalize', { armId, sampling: 'failed', domainEligible: false }],
  ['handoff-finalize', { armId, sampling: 'none', domainEligible: false }],
  ['handoff-finalize', { armId, sampling: 'captured', domainEligible: null }],
  ['open', { kind: 'initialized' }], ['initialize', { kind: 'opened' }],
] as const) test(`invalid ${operation} decision is not an extensible caller history`, () => {
  const v = ordinary(operation, decision);
  rejectsSafely(() => encodeResult(v), 'invalid-input'); rejectsSafely(() => decodeResult(encode(v)), 'corrupt');
});
for (const raw of [
  Buffer.from(' ' + encode(valid).toString()),
  Buffer.from(encode(valid).toString().replace('"schema":1', '"schema":1,"schema":1')),
  Buffer.from(encode(valid).toString().replace('"epoch":1', '"epoch":1e0')),
  Buffer.from(encode(valid).toString().replace('"epoch":1', '"epoch":1.0')),
  Buffer.from(encode(valid).toString().replace('"epoch":1', '"epoch":01')),
  Buffer.from(encode(valid).toString().replace('"schema"', '"schem\\u0061"')),
  Buffer.from([0xff]), Buffer.alloc(4097, 32), Buffer.alloc(0),
]) test('result rejects noncanonical, malformed and over-cap physical bytes', () => rejectsSafely(() => decodeResult(raw), 'corrupt'));
test('result encoder rejects getters without invoking them or retaining raw causes', () => {
  let read = false; const value = { ...valid };
  Object.defineProperty(value, 'decision', { enumerable: true, get() { read = true; throw new Error('private'); } });
  rejectsSafely(() => encodeResult(value), 'invalid-input'); assert.equal(read, false);
});
test('max escaped identities, receipts, arm and safe scalars fit ordinary caps', t => {
  const id = '"'.repeat(256); const max = Number.MAX_SAFE_INTEGER;
  const state = stateFixture({ records: 100000, bodies: 100000, lastNow: MAX_INBOX_TIME, restartEpoch: max,
    currentGeneration: 100000, handoffClockArm: { ...arm, ownerEpoch: max, generation: 100000, order: 100000 } });
  for (const [op, decision] of [
    ['admit', { eventId: id, replyTarget: id, fingerprint: admission.fingerprint,
      policy: { maxRecords: 100000, maxPending: 100000, replayWindowMs: 604800000 }, outcome: { kind: 'accepted', replyTarget: id } }],
    ['complete', { claim: { eventId: id, attemptId, attempt: max }, receipt: { ...receipt, eventId: id }, applied: true }],
    ['retry', { claim: { eventId: id, attemptId, attempt: max }, delayMs: max, applied: true }],
  ]) {
    const result = ordinary(op as string, decision, state); const raw = encodeResult(result);
    assert.equal(raw.length <= 4096, true); assert.equal(encode(decodeResult(raw)).equals(raw), true);
    t.diagnostic(`maximum-field ${op as string} result bytes: ${raw.length}`);
  }
});
test('state digest commits to binding and exact canonical state bytes in distinct domains', () => {
  const state = stateFixture(); const raw = encodeState(state);
  assert.equal(stateDigest(binding, raw) === stateHash(state), true);
  assert.equal(stateDigest(binding, raw, 'operator-recovery') === stateHash(state, true), true);
  assert.equal(stateDigest(binding, raw) === stateDigest(binding, raw, 'operator-recovery'), false);
  assert.equal(stateDigest({ ...binding, bytes: Buffer.from('different synthetic binding') }, raw) === stateHash(state), false);
  rejectsSafely(() => stateDigest(binding, Buffer.from(' ' + raw.toString())), 'invalid-input');
  rejectsSafely(() => stateDigest(binding, raw, 'other' as 'ordinary'), 'invalid-input');
});


test('initialize is only the empty prepared epoch-one domain marker', () => {
  const state = initialState(); const result = ordinary('initialize', { kind: 'initialized' }, state, state, null);
  validateResult(context(result, state, new Graph()));
  const acquired = context(result, state, new Graph(), { epoch: 2, operation: 'acquire' }); validateResult(acquired);
  for (const change of [{ records: 1, bodies: 1, currentGeneration: 1 }, { lastNow: 1 }, { restartEpoch: 2 }]) {
    const bad = { ...state, ...change };
    rejectsSafely(() => validateResult(context(ordinary('initialize', { kind: 'initialized' }, bad, bad, null), bad, new Graph())), 'corrupt');
  }
  rejectsSafely(() => validateResult({ ...context(result, state, new Graph()), dataRowCount: 1 }), 'corrupt');
  const bare = context(result, state, new Graph(), { state: Buffer.alloc(0), result: Buffer.alloc(0) });
  rejectsSafely(() => validateResult(bare), 'corrupt');
});
test('ordinary digest, canonical physical state, supplied state and saved epoch are all bound', () => {
  const state = initialState(); const result = ordinary('initialize', { kind: 'initialized' }, state, state, null);
  const good = context(result, state, new Graph());
  for (const bad of [
    { ...good, metadata: { ...good.metadata, epoch: 0 } },
    { ...good, metadata: { ...good.metadata, state: Buffer.from(' ' + good.metadata.state.toString()) } },
    { ...good, state: { ...state, lastNow: 1 } },
    { ...good, metadata: { ...good.metadata, result: encode({ ...result, postStateDigest: hash(['wrong']) }) } },
  ]) rejectsSafely(() => validateResult(bad), 'corrupt');
});
test('open samples before preparing restart and never clears a prior arm', () => {
  const before = stateFixture({ lastNow: 150 }); const state = { ...before, restartEpoch: 2, currentGeneration: null };
  const graph = new Graph([coherentEvent(1, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 })], [sealFixture({ epoch: 2 })]);
  const good = ordinary('open', { kind: 'opened' }, state, before, 140); validateResult(context(good, state, graph, { epoch: 3 }));
  for (const prior of [{ ...before, restartEpoch: 2 }, { ...before, restartEpoch: 3 }, { ...before, handoffClockArm: arm }]) {
    rejectsSafely(() => validateResult(context(ordinary('open', { kind: 'opened' }, state, prior, 140), state, graph)), 'corrupt');
  }
  const armed = { ...state, handoffClockArm: { ...arm, ownerEpoch: 2 } };
  rejectsSafely(() => validateResult(context(ordinary('open', { kind: 'opened' }, armed, before, 140), armed, graph)), 'corrupt');
  for (const seal of [undefined, sealFixture({ epoch: 1 }), sealFixture({ epoch: 2, observation: 139 }), sealFixture({ epoch: 2, watermark: 151 }), sealFixture({ epoch: 2, lastOrder: 2 })]) {
    const bad = new Graph([...graph.events.values()], seal ? [seal] : []);
    rejectsSafely(() => validateResult(context(good, state, bad)), 'corrupt');
  }
});
test('open without regression preserves high-water, counts and current generation', () => {
  const before = stateFixture(); const state = { ...before, restartEpoch: 2, lastNow: 120 };
  const graph = new Graph([coherentEvent()]); const result = ordinary('open', { kind: 'opened' }, state, before, 120);
  validateResult(context(result, state, graph));
  for (const change of [{ lastNow: 121 }, { bodies: 0 }, { currentGeneration: null }, { records: 2 }]) {
    const bad = { ...state, ...change };
    rejectsSafely(() => validateResult(context(ordinary('open', { kind: 'opened' }, bad, before, 120), bad, graph)), 'corrupt');
  }
});
for (const outcome of ['duplicate', 'conflict', 'full'] as const) test(`admission ${outcome} follows existing-event then occupied-target then captured-capacity precedence`, () => {
  const event = coherentEvent(); const state = stateFixture();
  const decision = outcome === 'duplicate' ? { ...admission, replyTarget: 'different-submitted-target' } :
    outcome === 'conflict' ? { ...admission, fingerprint: hash(['different']), outcome: { kind: outcome } } :
    { ...admission, eventId: 'new-event', replyTarget: 'new-target', policy: { ...policy, maxRecords: 1, maxPending: 1 }, outcome: { kind: outcome } };
  const good = ordinary('admit', decision, state); validateResult(context(good, state, new Graph([event])));
  for (const wrong of ['accepted', 'duplicate', 'conflict', 'full'].filter(kind => kind !== outcome)) {
    const bad = { ...decision, outcome: ['accepted', 'duplicate'].includes(wrong) ? { kind: wrong, replyTarget: event.replyTarget } : { kind: wrong } };
    rejectsSafely(() => validateResult(context(ordinary('admit', bad, state), state, new Graph([event]))), 'corrupt');
  }
});
test('duplicate always names the original target; an absent ID with an occupied target conflicts even at capacity', () => {
  const graph = new Graph([coherentEvent()]);
  rejectsSafely(() => validateResult(context(ordinary('admit', { ...admission, outcome: { kind: 'duplicate', replyTarget: 'other' } }), stateFixture(), graph)), 'corrupt');
  const decision = { ...admission, eventId: 'new-event', policy: { ...policy, maxRecords: 1, maxPending: 1 }, outcome: { kind: 'conflict' } };
  validateResult(context(ordinary('admit', decision), stateFixture(), graph));
  rejectsSafely(() => validateResult(context(ordinary('admit', { ...decision, outcome: { kind: 'full' } }), stateFixture(), graph)), 'corrupt');
});
test('admission full requires actual regression or captured pre-capacity, not current reduced policy', () => {
  const before = stateFixture({ lastNow: 150 }); const state = { ...before, currentGeneration: null };
  const decision = { ...admission, eventId: 'new-event', replyTarget: 'new-target', outcome: { kind: 'full' } };
  validateResult(context(ordinary('admit', decision, state, before, 140), state, new Graph([coherentEvent()], [sealFixture()])));
  rejectsSafely(() => validateResult(context(ordinary('admit', decision))), 'corrupt');
  // No current-policy input exists; retained captured policy remains authoritative.
  const accepted = { ...admission, outcome: { kind: 'accepted', replyTarget: admission.replyTarget } };
  validateResult(context(ordinary('admit', accepted, stateFixture(), initialState(), 100)));
});
test('accepted admission is the newest fresh pending pair with the captured deadline and generation', () => {
  const before = initialState(); const state = stateFixture(); const event = coherentEvent();
  const decision = { ...admission, outcome: { kind: 'accepted', replyTarget: admission.replyTarget } };
  const result = ordinary('admit', decision, state, before, 100); validateResult(context(result, state, new Graph([event])));
  for (const change of [{ received: 99 }, { deadline: 201 }, { nextAttempt: 101 }, { attempt: 1, attemptId, attemptEpoch: 1 },
    { state: 'blocked' as const, reason: 'redirect' as const }, { fingerprint: hash(['different']) }, { replyTarget: 'other' }, { generation: 2 }, { order: 2 }]) {
    rejectsSafely(() => validateResult(context(result, state, new Graph([{ ...event, ...change }]))), 'corrupt');
  }
  for (const prior of [{ ...before, lastNow: 101 }, { ...before, records: 1, bodies: 1, currentGeneration: 1 }]) {
    rejectsSafely(() => validateResult(context(ordinary('admit', decision, state, prior, 100), state, new Graph([event]))), 'corrupt');
  }
  const noCapacity = { ...decision, policy: { ...policy, maxRecords: 1, maxPending: 1 } };
  const second = coherentEvent(2); const next = stateFixture({ records: 2, bodies: 2 });
  rejectsSafely(() => validateResult(context(ordinary('admit', { ...noCapacity, eventId: second.externalEventId, replyTarget: second.replyTarget,
    fingerprint: second.fingerprint, outcome: { kind: 'accepted', replyTarget: second.replyTarget } }, next, state, 100), next, new Graph([event, second]))), 'corrupt');
});
test('accepted admission reuses current generation or starts only the next ordinal after a closed interval', () => {
  const second = coherentEvent(2, { generation: 2, received: 150, deadline: 250, nextAttempt: 150 });
  const before = stateFixture({ lastNow: 150, currentGeneration: null }); const state = { ...before, records: 2, bodies: 2, currentGeneration: 2 };
  const decision = { ...admission, eventId: second.externalEventId, replyTarget: second.replyTarget, fingerprint: second.fingerprint,
    outcome: { kind: 'accepted', replyTarget: second.replyTarget } };
  validateResult(context(ordinary('admit', decision, state, before, 150), state, new Graph([coherentEvent(), second], [sealFixture()])));
  const reused = { ...second, generation: 1 }; const current = { ...state, currentGeneration: 1 };
  validateResult(context(ordinary('admit', decision, current, { ...before, currentGeneration: 1 }, 150), current, new Graph([coherentEvent(), reused])));
});
test('claim scans first due ordinal, reconstructing only its selected pending summary at saved epoch', () => {
  const before = stateFixture({ records: 2, bodies: 2 }); const state = { ...before, handoffClockArm: { ...arm, order: 2 } };
  const first = coherentEvent(1, { nextAttempt: 101 }); const target = coherentEvent(2, { state: 'forwarding', attempt: 2, attemptId, attemptEpoch: 1 });
  const decision = { kind: 'claimed', eventId: target.externalEventId, attemptId, attempt: 2 };
  const result = ordinary('claim', decision, state, before, 100); const graph = new Graph([first, target]);
  validateResult(context(result, state, graph, { epoch: 2, operation: 'acquire' }));
  rejectsSafely(() => validateResult(context(result, state, new Graph([{ ...first, nextAttempt: 100 }, target]))), 'corrupt');
  for (const change of [{ state: 'pending' as const }, { attemptEpoch: 0 }, { attempt: 1 }, { attemptId: armId }, { nextAttempt: 101 }, { deadline: 100 }]) {
    rejectsSafely(() => validateResult(context(result, state, new Graph([first, { ...target, ...change }]))), 'corrupt');
  }
  for (const badArm of [null, { ...arm, order: 1 }, { ...arm, order: 2, ownerEpoch: 2 }, { ...arm, order: 2, generation: 2 }, { ...arm, order: 2, attemptId: armId }]) {
    const bad = { ...state, handoffClockArm: badArm };
    rejectsSafely(() => validateResult(context(ordinary('claim', decision, bad, before, 100), bad, graph)), 'corrupt');
  }
});
test('claim empty uses sampled time, expiry, restart, seals and sticky physical states', () => {
  const state = stateFixture(); const empty = ordinary('claim', { kind: 'empty' }, state);
  rejectsSafely(() => validateResult(context(empty)), 'corrupt');
  for (const event of [coherentEvent(1, { nextAttempt: 101 }), coherentEvent(1, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 }),
    coherentEvent(1, { state: 'blocked', reason: 'redirect' })]) validateResult(context(empty, state, new Graph([event])));
  const old = coherentEvent(1, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  const restarted = { ...state, restartEpoch: 2 };
  rejectsSafely(() => validateResult(context(ordinary('claim', { kind: 'empty' }, restarted), restarted, new Graph([old]))), 'corrupt');
  const expired = { ...state, lastNow: 200 }; validateResult(context(ordinary('claim', { kind: 'empty' }, expired, state, 200), expired, new Graph([old])));
  const sealed = { ...state, currentGeneration: null, lastNow: 150 };
  validateResult(context(ordinary('claim', { kind: 'empty' }, sealed, { ...state, lastNow: 150 }, 140), sealed, new Graph([old], [sealFixture()])));
});
for (const operation of ['complete', 'retry', 'block'] as const) test(`${operation} false means no matching effective forwarding triple at saved domain epoch`, () => {
  const decision = { claim, ...(operation === 'complete' ? { receipt } : operation === 'retry' ? { delayMs: 5 } : { reason: 'redirect' }), applied: false };
  const state = stateFixture(); const result = ordinary(operation, decision); const row = coherentEvent(1, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  rejectsSafely(() => validateResult(context(result, state, new Graph([row]), { epoch: 2 })), 'corrupt');
  for (const event of [coherentEvent(), { ...row, attempt: 2 }, { ...row, attemptId: armId }]) validateResult(context(result, state, new Graph([event])));
  const later = { ...state, restartEpoch: 2 }; validateResult(context(ordinary(operation, decision, later), later, new Graph([row])));
  const expired = { ...state, lastNow: 200 }; validateResult(context(ordinary(operation, decision, expired, state, 200), expired, new Graph([row])));
  const closed = { ...state, lastNow: 150, currentGeneration: null };
  validateResult(context(ordinary(operation, decision, closed, { ...state, lastNow: 150 }, 140), closed, new Graph([row], [sealFixture()])));
  validateResult(context(ordinary(operation, { ...decision, claim: { ...claim, eventId: 'missing' } }), state, new Graph([row])));
});
for (const operation of ['complete', 'retry', 'block'] as const) test(`${operation} applied reconstructs only the forwarding target and checks exact post fields`, () => {
  const before = stateFixture(); const state = { ...before, bodies: operation === 'complete' ? 0 : 1 };
  const decision = { claim, ...(operation === 'complete' ? { receipt } : operation === 'retry' ? { delayMs: 5 } : { reason: 'redirect' }), applied: true };
  const row = coherentEvent(1, { attempt: 1, attemptId, attemptEpoch: 1, ...(operation === 'complete' ? { state: 'terminal', body: null, receipt } :
    operation === 'retry' ? { state: 'pending', nextAttempt: 105 } : { state: 'blocked', reason: 'redirect' }) });
  const result = ordinary(operation, decision, state, before); validateResult(context(result, state, new Graph([row]), { epoch: 2 }));
  for (const change of [{ attemptId: armId }, { attempt: 2 }, { attemptEpoch: 0 }, { state: 'forwarding' as const }]) {
    rejectsSafely(() => validateResult(context(result, state, new Graph([{ ...row, ...change }]))), 'corrupt');
  }
  const expired = { ...state, lastNow: 200 };
  rejectsSafely(() => validateResult(context(ordinary(operation, decision, expired, before, 200), expired, new Graph([row]))), 'corrupt');
  const closed = { ...state, lastNow: 150, currentGeneration: null };
  rejectsSafely(() => validateResult(context(ordinary(operation, decision, closed, { ...before, lastNow: 150 }, 140), closed, new Graph([row], [sealFixture()]))), 'corrupt');
  const wrong = operation === 'complete' ? { ...row, receipt: { ...receipt, eventId: 'other' } } : operation === 'retry' ? { ...row, nextAttempt: 104 } : { ...row, reason: 'conflict' as const };
  rejectsSafely(() => validateResult(context(result, state, new Graph([wrong]))), 'corrupt');
});
test('retry uses saturating safe addition and retains attempt identity without requiring an old UUID', () => {
  const state = stateFixture(); const row = coherentEvent(1, { state: 'pending', attempt: Number.MAX_SAFE_INTEGER, attemptId,
    attemptEpoch: 1, nextAttempt: Number.MAX_SAFE_INTEGER });
  const decision = { claim: { ...claim, attempt: Number.MAX_SAFE_INTEGER }, delayMs: Number.MAX_SAFE_INTEGER, applied: true };
  validateResult(context(ordinary('retry', decision), state, new Graph([row])));
});
for (const operation of ['admit', 'claim', 'complete', 'retry', 'block'] as const) test(`${operation} cannot consume an arm or install an unclaimed arm`, () => {
  const state = stateFixture(); const graph = new Graph([coherentEvent(1, { nextAttempt: 101 })]);
  const decision = operation === 'admit' ? admission : operation === 'claim' ? { kind: 'empty' } :
    { claim, ...(operation === 'complete' ? { receipt } : operation === 'retry' ? { delayMs: 5 } : { reason: 'redirect' }), applied: false };
  const prior = { ...state, handoffClockArm: arm };
  rejectsSafely(() => validateResult(context(ordinary(operation, decision, state, prior), state, graph)), 'corrupt');
  rejectsSafely(() => validateResult(context(ordinary(operation, decision, prior, state), prior, graph)), 'corrupt');
});
for (const operation of ['revalidate', 'handoff-finalize'] as const) test(`${operation} preserves committed domain eligibility regardless of local cancellation`, () => {
  const before = stateFixture({ handoffClockArm: arm }); const state = { ...before, handoffClockArm: operation === 'revalidate' ? arm : null };
  const row = coherentEvent(1, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  const decision = operation === 'revalidate' ? { armId, eligible: true } : { armId, sampling: 'captured', domainEligible: true };
  const result = ordinary(operation, decision, state, before); validateResult(context(result, state, new Graph([row])));
  const falseDecision = operation === 'revalidate' ? { armId, eligible: false } : { armId, sampling: 'captured', domainEligible: false };
  rejectsSafely(() => validateResult(context(ordinary(operation, falseDecision, state, before), state, new Graph([row]))), 'corrupt');
  for (const change of [{ attemptId: armId }, { attemptEpoch: 2 }, { state: 'pending' as const }]) {
    rejectsSafely(() => validateResult(context(result, state, new Graph([{ ...row, ...change }]))), 'corrupt');
  }
  for (const prior of [{ ...before, handoffClockArm: null }, { ...before, handoffClockArm: { ...arm, id: attemptId } },
    { ...before, handoffClockArm: { ...arm, ownerEpoch: 2 } }]) {
    rejectsSafely(() => validateResult(context(ordinary(operation, decision, state, prior), state, new Graph([row]))), 'corrupt');
  }
  const wrongPost = { ...state, handoffClockArm: operation === 'revalidate' ? null : arm };
  rejectsSafely(() => validateResult(context(ordinary(operation, decision, wrongPost, before), wrongPost, new Graph([row]))), 'corrupt');
  const regressed = { ...state, lastNow: 150, currentGeneration: null };
  validateResult(context(ordinary(operation, falseDecision, regressed, { ...before, lastNow: 150 }, 140), regressed, new Graph([row], [sealFixture()])));
  const sealedBefore = { ...before, lastNow: 150, currentGeneration: null };
  validateResult(context(ordinary(operation, falseDecision, { ...regressed, lastNow: 300 }, sealedBefore, 300), { ...regressed, lastNow: 300 }, new Graph([row], [sealFixture()])));
});
test('unsampled retirement alone clears the exact arm without changing clock or claiming eligibility', () => {
  const before = stateFixture({ handoffClockArm: arm }); const state = { ...before, handoffClockArm: null };
  const row = coherentEvent(1, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  const decision = { armId, sampling: 'none', domainEligible: null };
  validateResult(context(ordinary('handoff-finalize', decision, state, before, null), state, new Graph([row])));
  const bad = { ...state, lastNow: 101 };
  rejectsSafely(() => validateResult(context(ordinary('handoff-finalize', decision, bad, before, null), bad, new Graph([row]))), 'corrupt');
  rejectsSafely(() => validateResult(context(ordinary('handoff-finalize', decision, state, before, 100), state, new Graph([row]))), 'corrupt');
});
test('summary projection accepts a genuinely body-free value and never asks for body or route', () => {
  const row = coherentEvent(); assert.equal(Object.hasOwn(row, 'body'), false); assert.equal(Object.hasOwn(row, 'serviceUrl'), false);
  assert.equal(projectEvent(row, stateFixture()).state, 'pending');
});

test('retained result module exposes the codec and consistency boundary', async () => {
  const path = '../src/ingress/table-result.js';
  const api = await import(path).catch(() => ({})) as Record<string, unknown>;
  for (const name of ['encodeResult', 'decodeResult', 'stateDigest', 'validateResult']) {
    assert.equal(typeof api[name], 'function', name);
  }
});
