import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '../src/ingress/codec.js';
import { encodeState } from '../src/ingress/table-codec.js';
import { decodeResult, encodeResult, validateResult } from '../src/ingress/table-result.js';
import { initialState, projectEvent } from '../src/ingress/table-state.js';
import type { InboxRecoveryResult, InboxResult, InboxState } from '../src/ingress/table-types.js';
import { MAX_INBOX_TIME } from '../src/ingress/table-types.js';
import type { ExitReceipt, OperatorRecoveryExit } from '../src/storage/table/types.js';
import { armId, attemptId, rejectsSafely, sealFixture, stateFixture } from './support/table-ingress.js';
import { binding, coherentEvent, context, fold, Graph, hash, invocation, laterInvocation, nextOwner, ordinary, owner, physicalRows, stateHash } from './support/table-ingress-result.js';

const receipt = { status: 'accepted' as const, eventId: 'synthetic-receipt', state: 'Queued' };
function recovery(state: InboxState, graph: Graph, disposition: InboxRecoveryResult['disposition'] = { kind: 'inbox-unarmed' }): InboxRecoveryResult {
  const rows = physicalRows(graph);
  return { schema: 1, operation: 'operator-recovery', invocation, oldEpoch: state.restartEpoch, originalMDigest: hash(['synthetic-original-M']),
    disposition, postStateDigest: stateHash(state, true), postDataDigest: fold(rows), dataRowCount: rows.length };
}
function exit(result: InboxRecoveryResult): OperatorRecoveryExit {
  return { kind: 'operator-recovery', oldOwner: owner, oldEpoch: result.oldEpoch, invocation: result.invocation,
    originalMDigest: result.originalMDigest, planDigest: hash(['synthetic-recovery-plan']),
    domainDispositionDigest: hash(['orka-inbox-recovery-v2', binding.bytes.toString('base64'), encode(result).toString('base64')]),
    operatorAttestationDigest: hash(['synthetic-attestation']) };
}
function recovered(result: InboxRecoveryResult, state: InboxState, graph: Graph) {
  const receipt = exit(result);
  return context(result, state, graph, { owner: '', epoch: result.oldEpoch, operation: 'recover', invocation: result.invocation,
    plan: receipt.planDigest, exit: receipt });
}
function uncertain() {
  const graph = new Graph([
    coherentEvent(1, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 }),
    coherentEvent(2, { deadline: 150 }),
    coherentEvent(3, { state: 'blocked', reason: 'redirect' }),
    coherentEvent(4, { state: 'terminal', body: null, receipt, attempt: 1, attemptId, attemptEpoch: 1 }),
  ], [sealFixture({ lastOrder: 4, observation: null, reason: 'clock-uncertain' })]);
  const state = stateFixture({ records: 4, bodies: 3, currentGeneration: null, lastNow: 150 });
  const result = recovery(state, graph, { kind: 'inbox-clock-uncertain', armId, generation: 1, watermark: 150 });
  return { graph, state, result };
}
for (const variant of ['unarmed', 'uncertain'] as const) test(`recovery ${variant} uses exactly the reviewed ordered closed representation`, () => {
  const { result } = variant === 'uncertain' ? uncertain() : { result: recovery(initialState(), new Graph()) };
  const expected = encode(result); const reverse = Object.fromEntries(Object.entries(result).reverse()) as unknown as InboxResult;
  assert.equal(encodeResult(reverse).equals(expected), true);
  assert.equal(encode(decodeResult(expected)).equals(expected), true);
  assert.equal(expected.length <= 1024, true);
  for (const field of Object.keys(result)) {
    const bad = { ...result } as unknown as Record<string, unknown>; delete bad[field];
    rejectsSafely(() => encodeResult(bad as unknown as InboxResult), 'invalid-input');
    rejectsSafely(() => decodeResult(encode(bad)), 'corrupt');
  }
});
for (const [label, changes] of [
  ['schema', { schema: 2 }], ['invocation', { invocation: 'bad' }], ['old epoch', { oldEpoch: 0 }],
  ['old epoch overflow', { oldEpoch: Number.MAX_SAFE_INTEGER + 1 }], ['old digest', { originalMDigest: 'A'.repeat(64) }],
  ['unknown field', { takeReturnedTrue: false }], ['raw arm', { handoffClockArm: {} }], ['ordinary epoch', { epoch: 1 }],
  ['unarmed extra', { disposition: { kind: 'inbox-unarmed', watermark: 0 } }],
  ['disposition kind', { disposition: { kind: 'clock-regression' } }],
  ['arm id', { disposition: { kind: 'inbox-clock-uncertain', armId: 'bad', generation: 1, watermark: 150 } }],
  ['generation', { disposition: { kind: 'inbox-clock-uncertain', armId, generation: 0, watermark: 150 } }],
  ['watermark', { disposition: { kind: 'inbox-clock-uncertain', armId, generation: 1, watermark: MAX_INBOX_TIME + 1 } }],
  ['missing arm', { disposition: { kind: 'inbox-clock-uncertain', generation: 1, watermark: 150 } }],
  ['extra disposition', { disposition: { kind: 'inbox-clock-uncertain', armId, generation: 1, watermark: 150, observation: null } }],
  ['state hash', { postStateDigest: 'bad' }], ['data hash', { postDataDigest: 'bad' }],
  ['negative count', { dataRowCount: -1 }], ['fractional count', { dataRowCount: 1.5 }], ['count overflow', { dataRowCount: Number.MAX_SAFE_INTEGER + 1 }],
] as const) test(`recovery rejects ${label} without disclosing evidence`, () => {
  const bad = { ...uncertain().result, ...changes } as InboxResult;
  rejectsSafely(() => encodeResult(bad), 'invalid-input'); rejectsSafely(() => decodeResult(encode(bad)), 'corrupt');
});
test('recovery cap is independent of the ordinary cap, with maximum legal scalars still fitting', t => {
  const result = { ...uncertain().result, oldEpoch: Number.MAX_SAFE_INTEGER, dataRowCount: Number.MAX_SAFE_INTEGER,
    disposition: { kind: 'inbox-clock-uncertain' as const, armId, generation: 100000, watermark: MAX_INBOX_TIME } };
  const raw = encodeResult(result); assert.equal(raw.length <= 1024, true);
  t.diagnostic(`maximum-scalar recovery bytes: ${raw.length}`);
  assert.equal(encode(decodeResult(raw)).equals(raw), true);
  rejectsSafely(() => decodeResult(Buffer.concat([raw, Buffer.alloc(1025 - raw.length, 32)])), 'corrupt');
  rejectsSafely(() => decodeResult(Buffer.from(encode(result).toString().replace('"schema":1', '"schema":1,"schema":1'))), 'corrupt');
  rejectsSafely(() => decodeResult(Buffer.from(encode(result).toString().replace('"oldEpoch":9007199254740991', '"oldEpoch":9.007199254740991e15'))), 'corrupt');
  rejectsSafely(() => decodeResult(encode(Object.fromEntries(Object.entries(result).reverse()))), 'corrupt');
  rejectsSafely(() => decodeResult(encode({ ...result, disposition: Object.fromEntries(Object.entries(result.disposition).reverse()) })), 'corrupt');
});
test('empty recovery golden recipes are JSON-hash domains over exact binding/state/result base64', () => {
  const state = initialState(); const graph = new Graph(); const result = recovery(state, graph);
  const b = binding.bytes.toString('base64');
  const h0 = hash(['orka-recovery-data-v2', b]);
  assert.equal(result.postDataDigest === hash(['orka-recovery-data-end-v2', h0, 0]), true);
  assert.equal(result.postStateDigest === hash(['orka-recovery-state-v2', b, encodeState(state).toString('base64')]), true);
  validateResult(recovered(result, state, graph));
  for (const change of [
    { postStateDigest: stateHash(state) },
    { postDataDigest: hash(['orka-recovery-data-end-v2', h0, 1]) },
    { postDataDigest: hash(['orka-recovery-data-v2', b, []]) },
  ]) rejectsSafely(() => validateResult(recovered({ ...result, ...change }, state, graph)), 'corrupt');
});
test('one event plus retained route fold has row-key order, full envelope digests, and an explicit end count', () => {
  const state = stateFixture(); const graph = new Graph([coherentEvent()]); const rows = physicalRows(graph);
  assert.equal(rows.length, 2); assert.equal(rows[0]!.rowKey.startsWith('event_'), true); assert.equal(rows[1]!.rowKey.startsWith('route_'), true);
  const seed = hash(['orka-recovery-data-v2', binding.bytes.toString('base64')]);
  const h1 = hash(['orka-recovery-row-v2', seed, rows[0]!.rowKey, rows[0]!.rowDigest]);
  const h2 = hash(['orka-recovery-row-v2', h1, rows[1]!.rowKey, rows[1]!.rowDigest]);
  const result = recovery(state, graph);
  assert.equal(result.postDataDigest === hash(['orka-recovery-data-end-v2', h2, 2]), true);
  validateResult(recovered(result, state, graph));
  const base = recovered(result, state, graph);
  for (const change of [
    { postDataDigest: fold(rows.slice(0, 1)), dataRowCount: 1 },
    { postDataDigest: fold([...rows].reverse()) },
    { postDataDigest: fold([{ ...rows[0]!, rowDigest: hash(['substitution']) }, rows[1]!]) },
    { dataRowCount: 3 },
  ]) rejectsSafely(() => validateResult({ ...base, ...change }), 'corrupt');
});
test('unarmed recovery preserves content and allows recovery after acquisition but before domain open', () => {
  const state = stateFixture(); const graph = new Graph([coherentEvent(1, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 })]);
  const result = { ...recovery(state, graph), oldEpoch: 2 }; const base = recovered(result, state, graph);
  validateResult(base); validateResult({ ...base, metadata: { ...base.metadata, owner: nextOwner, epoch: 3, operation: 'acquire' } });
  const armedState = { ...state, handoffClockArm: { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId } };
  rejectsSafely(() => validateResult(recovered(recovery(armedState, graph), armedState, graph)), 'corrupt');
  rejectsSafely(() => validateResult({ ...base, metadata: { ...base.metadata, epoch: 1 } }), 'corrupt');
  const future = { ...state, restartEpoch: 3 }; const futureResult = { ...recovery(future, graph), oldEpoch: 2 };
  rejectsSafely(() => validateResult(recovered(futureResult, future, graph)), 'corrupt');
});
test('uncertain recovery retains bodies and prior terminal, explicit and deadline reasons', () => {
  const { state, graph, result } = uncertain(); validateResult(recovered(result, state, graph));
  assert.equal(state.bodies, 3); assert.equal(result.dataRowCount, 9);
  for (const [order, reason] of [[1, 'clock-uncertain'], [2, 'deadline'], [3, 'redirect'], [4, null]] as const) {
    const event = graph.eventByOrder(order)!; assert.equal(Object.hasOwn(event, 'body'), false);
    assert.equal(projectEvent(event, state, graph.sealByGeneration(1)).reason === reason, true);
  }
  const base = recovered(result, state, graph);
  const missing = physicalRows(graph).slice(1);
  rejectsSafely(() => validateResult({ ...base, postDataDigest: fold(missing), dataRowCount: missing.length }), 'corrupt');
  for (const change of [{ currentGeneration: 1 }, { lastNow: 151 }, { restartEpoch: 2 }]) {
    const bad = { ...state, ...change };
    const updated = { ...result, postStateDigest: stateHash(bad, true) };
    rejectsSafely(() => validateResult(recovered(updated, bad, graph)), 'corrupt');
  }
  for (const disposition of [
    { kind: 'inbox-clock-uncertain' as const, armId, generation: 2, watermark: 150 },
    { kind: 'inbox-clock-uncertain' as const, armId, generation: 1, watermark: 149 },
  ]) rejectsSafely(() => validateResult(recovered({ ...result, disposition }, state, graph)), 'corrupt');
});
test('uncertain recovery requires the exact final interval and seal rather than an unproved lost sample', () => {
  const { state, graph, result } = uncertain(); const base = recovered(result, state, graph);
  for (const seal of [undefined, sealFixture({ reason: 'clock-uncertain', observation: null, lastOrder: 3 }),
    sealFixture({ reason: 'clock-uncertain', observation: null, lastOrder: 4, watermark: 149 }),
    sealFixture({ reason: 'clock-uncertain', observation: null, lastOrder: 4, epoch: 2 })]) {
    // Already audited full-fold inputs are supplied explicitly; only disposition consistency is under test.
    const bad = new Graph([...graph.events.values()], seal ? [seal] : []);
    rejectsSafely(() => validateResult({ ...base, graph: bad }), 'corrupt');
  }
});
test('already proved regression seal stays regression; later durable high-water cannot relabel its reasons', () => {
  const { graph } = uncertain(); graph.seals.set(1, sealFixture({ lastOrder: 4 }));
  const state = stateFixture({ records: 4, bodies: 3, currentGeneration: null, lastNow: 180 });
  const result = recovery(state, graph, { kind: 'inbox-clock-uncertain', armId, generation: 1, watermark: 180 });
  validateResult(recovered(result, state, graph));
  assert.equal(projectEvent(graph.eventByOrder(1)!, state, graph.sealByGeneration(1)).reason, 'clock-regression');
  assert.equal(projectEvent(graph.eventByOrder(2)!, state, graph.sealByGeneration(1)).reason, 'deadline');
});
test('matching retained operator Exit must correlate invocation, old epoch, original M and disposition digest', () => {
  const { state, graph, result } = uncertain(); const base = recovered(result, state, graph); const x = base.metadata.exit!;
  validateResult(base);
  for (const change of [{ invocation: laterInvocation }, { oldEpoch: 2 }, { originalMDigest: hash(['different']) },
    { domainDispositionDigest: hash(['different']) }]) {
    rejectsSafely(() => validateResult({ ...base, metadata: { ...base.metadata, exit: { ...x, ...change } } }), 'corrupt');
  }
  rejectsSafely(() => validateResult({ ...base, metadata: { ...base.metadata, exit: undefined } }), 'corrupt');
  const clean: ExitReceipt = { kind: 'clean-release', oldOwner: owner, oldEpoch: 1, invocation: laterInvocation, planDigest: hash(['clean']) };
  rejectsSafely(() => validateResult({ ...base, metadata: { ...base.metadata, exit: clean } }), 'corrupt');
  const wrongRecipe = { ...x, domainDispositionDigest: hash(['orka-inbox-recovery-v2', binding.bytes.toString('base64'), result]) };
  rejectsSafely(() => validateResult({ ...base, metadata: { ...base.metadata, exit: wrongRecipe } }), 'corrupt');
});
test('later clean release replaces Exit without creating a permanent recovery audit dependency', () => {
  const { state, graph, result } = uncertain(); const base = recovered(result, state, graph);
  const later: ExitReceipt = { kind: 'clean-release', oldOwner: attemptId, oldEpoch: 2, invocation: laterInvocation, planDigest: hash(['later']) };
  const ctx = { ...base, metadata: { ...base.metadata, epoch: 2, operation: 'barrier' as const, exit: later } };
  validateResult(ctx); validateResult({ ...ctx, metadata: { ...ctx.metadata, owner: nextOwner, epoch: 3, operation: 'acquire' } });
  rejectsSafely(() => validateResult({ ...ctx, postDataDigest: hash(['changed-data']) }), 'corrupt');
  rejectsSafely(() => validateResult({ ...ctx, metadata: { ...ctx.metadata, exit: { ...later, invocation } } }), 'corrupt');
});
test('a later inbox recovery must replace its domain result, not retain an older recovery commitment', () => {
  const { state, graph, result } = uncertain(); const base = recovered(result, state, graph);
  const later: ExitReceipt = { ...exit(result), oldOwner: attemptId, oldEpoch: 2, invocation: laterInvocation,
    originalMDigest: hash(['later-M']), domainDispositionDigest: hash(['later-disposition']) };
  rejectsSafely(() => validateResult({ ...base, metadata: { ...base.metadata, epoch: 2, operation: 'barrier', exit: later } }), 'corrupt');
});
test('an older retained operator Exit is not revalidated as the current ordinary result commitment', () => {
  const graph = new Graph([coherentEvent(1, { nextAttempt: 180 })]); const oldState = stateFixture(); const old = recovery(oldState, graph);
  const state = { ...oldState, lastNow: 120, restartEpoch: 2 };
  const result = ordinary('open', { kind: 'opened' }, state, oldState, 120);
  validateResult(context(result, state, graph, { epoch: 2, exit: exit(old) }));
});
