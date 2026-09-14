import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InboxIndex } from '../src/ingress/table-index.js';
import { initialState } from '../src/ingress/table-state.js';
import { validateResult } from '../src/ingress/table-result.js';
import { context, Graph, ordinary } from './support/table-ingress-result.js';
import { MAX_INBOX_TIME } from '../src/ingress/table-types.js';
import type { EventSummary, InboxState, SealPayload } from '../src/ingress/table-types.js';
import { OWNED_AUDIT_BUDGET_EXHAUSTED, TableError } from '../src/storage/table/types.js';

const working = 4194304;
const uuid = '12345678-1234-4123-8123-123456789abc';
const stamp = '2025-01-02T03:04:05.1234567Z';
function version(n = 1) { return { etag: `"v${n}"`, digest: n.toString(16).padStart(64, '0'), timestamp: stamp }; }
function event(order = 1, patch: Partial<EventSummary> = {}): EventSummary {
  return { schema: 1, fingerprintVersion: 1, externalEventId: `event-${order}`, replyTarget: `target-${order}`,
    fingerprint: 'ab'.repeat(32), bodyDigest: 'cd'.repeat(32), state: 'pending', received: 100, deadline: 200,
    nextAttempt: 100, attempt: 0, attemptId: null, attemptEpoch: 0, order, generation: 1, receipt: null, reason: null, ...patch };
}
function eventRow(e = event()) { return { event: e, version: version(), bodyEncodingBytes: e.state === 'terminal' ? 0 : 1000, payloadBytes: 1500 }; }
function routeRow(e = event()) { return { replyTarget: e.replyTarget, externalEventId: e.externalEventId,
  botId: 'bot', conversationId: 'conversation', routeDigest: 'ef'.repeat(32), version: version(2), routeEncodingBytes: 500, payloadBytes: 700 }; }
function seal(patch: Partial<SealPayload> = {}): SealPayload { return { schema: 1, kind: 'generation-seal', generation: 1,
  lastOrder: 1, watermark: 150, observation: 140, epoch: 1, reason: 'clock-regression', ...patch }; }
function state(records = 1, patch: Partial<InboxState> = {}): InboxState {
  return { ...initialState(), records, bodies: records, lastNow: 150, currentGeneration: records ? 1 : null, ...patch };
}
function corrupt(work: () => unknown) { assert.throws(work, e => e instanceof TableError && e.code === 'corrupt' && e.cause === undefined); }
function exhausted(work: () => unknown) { assert.throws(work, e => e === OWNED_AUDIT_BUDGET_EXHAUSTED); }
function openIndex(max = 1024 * 1024 * 1024) { const index = new InboxIndex(max); index.begin(); return index; }
function pass2(index: InboxIndex, events: EventSummary[], seals: SealPayload[] = []) {
  index.endPass(1);
  for (const s of seals) index.seePass2({ type: 'control', id: `generation:${s.generation}` }, version(3));
  for (const e of events) index.seePass2({ type: 'event', id: e.externalEventId }, version());
  for (const e of events) index.seePass2({ type: 'route', id: e.replyTarget }, version(2));
  index.endPass(2);
}

test('constructor does not allocate index state and bad configuration is invalid-input', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 1073741825, '100' as unknown as number]) {
    assert.throws(() => new InboxIndex(value), e => e instanceof TableError && e.code === 'invalid-input');
  }
  const index = new InboxIndex(1);
  assert.equal(index.diagnostics().chargedBytes, 0);
  exhausted(() => index.begin()); assert.equal(index.diagnostics().chargedBytes, 0);
  index.dispose(); corrupt(() => index.begin());
});

test('named working credits share the delta cap and cannot double spend or resurrect', () => {
  const index = openIndex(working);
  assert.equal(index.diagnostics().chargedBytes, working);
  const limits = { meta: 65536, scratch: 2359296, frame: 1048576, delta: 524288, derivedKeys: 65536 } as const;
  for (const phase of ['meta', 'scratch', 'frame', 'delta', 'derivedKeys'] as const) {
    const used = index.diagnostics().working[phase];
    const credit = index.reserveWorking(phase, limits[phase] - used);
    exhausted(() => index.reserveWorking(phase, 1));
    index.releaseWorking(credit);
  }
  const credit = index.reserveWorking('scratch', 10);
  corrupt(() => index.releaseWorking({} as typeof credit));
  index.releaseWorking(credit); corrupt(() => index.releaseWorking(credit));
  index.dispose(); index.dispose(); assert.equal(index.diagnostics().chargedBytes, 0);
  corrupt(() => index.reserveWorking('scratch', 1)); corrupt(() => index.addEvent(eventRow()));
});

test('event growth reserves ALL old/new capacities at the exact one-byte boundary', () => {
  // One event: arena4096 + two maps16 + ordinal4 = 4132 bytes.
  const index = openIndex(working + 4132 + 8264 - 1);
  index.addEvent(eventRow());
  assert.equal(index.diagnostics().chargedBytes, working + 4132);
  exhausted(() => index.addEvent(eventRow(event(2))));
  assert.equal(index.diagnostics().chargedBytes, working + 4132);
  assert.equal(index.eventById('event-2'), undefined);
  const exact = openIndex(working + 4132 + 8264);
  exact.addEvent(eventRow()); exact.addEvent(eventRow(event(2)));
  assert.equal(exact.diagnostics().peakBytes, working + 4132 + 8264);
  assert.equal(exact.diagnostics().chargedBytes, working + 8264);
  index.dispose(); exact.dispose();
});

test('provisional control growth accounts for seal and generation arrays before events exist', () => {
  const index = openIndex(working + 516 + 1032 - 1);
  index.addSeal({ seal: seal(), version: version(3), payloadBytes: 200 });
  exhausted(() => index.addSeal({ seal: seal({ generation: 2, lastOrder: 2 }), version: version(3), payloadBytes: 200 }));
  assert.equal(index.diagnostics().chargedBytes, working + 516);
  assert.equal(index.eventByOrder(1), undefined); index.dispose();
});

test('maximum UTF8 IDs, binary hashes, ETags, UUID, receipt and lengths roundtrip without retaining caller extras', () => {
  const id = 'é'.repeat(128), target = '界'.repeat(85) + 'x';
  const e = event(1, { externalEventId: id, replyTarget: target, state: 'terminal', received: MAX_INBOX_TIME,
    deadline: Number.MAX_SAFE_INTEGER, nextAttempt: Number.MAX_SAFE_INTEGER, attempt: Number.MAX_SAFE_INTEGER,
    attemptId: uuid, attemptEpoch: Number.MAX_SAFE_INTEGER, receipt: { status: 'duplicate', eventId: 'z'.repeat(256), state: 'Completed' } });
  const input = { ...eventRow(e), body: Buffer.alloc(8), extra: { serviceUrl: 'https://synthetic.invalid/' } };
  Object.defineProperty(e, 'body', { get() { throw new Error('must not read extra property'); } });
  const v = { ...version(), etag: `"${'a'.repeat(254)}"` }; input.version = v;
  const index = openIndex(); index.addEvent(input);
  const route = { ...routeRow(e), botId: 'b'.repeat(256), conversationId: 'c'.repeat(256), version: { ...v, digest: version(2).digest },
    routeEncodingBytes: 16384, payloadBytes: 16384 };
  index.addRoute(route);
  const got = index.eventById(id)!;
  assert.equal(got.replyTarget === target && got.fingerprint === 'ab'.repeat(32) && got.bodyDigest === 'cd'.repeat(32), true);
  assert.equal(got.attemptId === uuid && got.receipt?.eventId === 'z'.repeat(256), true);
  assert.equal(got.received, MAX_INBOX_TIME); assert.equal(got.attempt, Number.MAX_SAFE_INTEGER);
  assert.equal('body' in got, false); assert.equal('serviceUrl' in index.routeByTarget(target)!, false);
  assert.equal(index.version({ type: 'event', id }).etag.length, 256);
  assert.equal(index.routeByTarget(target)!.routeEncodingBytes, 16384);
  assert.equal(index.eventLengths(id).payloadBytes, 1500);
  e.replyTarget = 'changed'; e.receipt!.eventId = 'changed'; v.etag = '"changed"'; route.botId = 'changed';
  got.receipt!.eventId = 'changed';
  assert.equal(index.eventById(id)!.receipt!.eventId.length, 256);
  assert.equal(index.routeByTarget(target)!.botId.length, 256); assert.equal(index.version({ type: 'event', id }).etag.length, 256);
  index.dispose();
});

for (const [field, bad] of [ ['order', 0], ['order', 100001], ['order', 1.5], ['generation', NaN], ['generation', 2],
  ['received', -1], ['received', MAX_INBOX_TIME + 1], ['attempt', Number.MAX_SAFE_INTEGER + 1], ['nextAttempt', Infinity],
  ['externalEventId', 'é'.repeat(129)], ['fingerprint', 'ab'.repeat(31)], ['attemptId', 'not-a-uuid'] ] as const) {
  test(`invalid event ${field} is corrupt before any capacity enrollment`, () => {
    const index = openIndex(); corrupt(() => index.addEvent(eventRow(event(1, { [field]: bad }))));
    assert.equal(index.diagnostics().chargedBytes, working); index.dispose();
  });
}
for (const patch of [{ etag: 'x'.repeat(257) }, { digest: 'A'.repeat(64) }, { timestamp: '2025-01-02T03:04:05.12345678Z' }]) {
  test('version fields never truncate to fit a slot', () => {
    const index = openIndex(); corrupt(() => index.addEvent({ ...eventRow(), version: { ...version(), ...patch } }));
    assert.equal(index.diagnostics().chargedBytes, working); index.dispose();
  });
}
for (const patch of [{ bodyEncodingBytes: -1 }, { payloadBytes: 143361 }, { bodyEncodingBytes: 1.1 }, { payloadBytes: 0 }]) {
  test('encoding and payload length bounds reject malformed counts before growth', () => {
    const index = openIndex(); corrupt(() => index.addEvent({ ...eventRow(), ...patch })); index.dispose();
  });
}

test('small ordinary bucket collisions use exact identity bytes and preserve both lookup maps through growth', () => {
  const index = openIndex();
  // Four buckets at two rows; these ASCII suffixes have equal low two FNV bits.
  const first = event(1, { externalEventId: 'a', replyTarget: 'i' });
  const second = event(2, { externalEventId: 'e', replyTarget: 'm' });
  index.addEvent(eventRow(first)); index.addEvent(eventRow(second));
  assert.equal(index.eventById('a')!.order, 1); assert.equal(index.eventById('e')!.order, 2);
  assert.equal(index.eventByTarget('i')!.order, 1); assert.equal(index.eventByTarget('m')!.order, 2);
  assert.equal(index.eventById('q'), undefined);
  corrupt(() => index.addEvent(eventRow(event(3, { externalEventId: 'a' }))));
  corrupt(() => index.addEvent(eventRow(event(3, { replyTarget: 'm' }))));
  corrupt(() => index.addEvent(eventRow(event(2)))); index.dispose();
});

test('controls before events and routes complete both passes and a body-free graph', () => {
  const index = openIndex(); const s = seal(); const e = event();
  index.addSeal({ seal: s, version: version(3), payloadBytes: 200 });
  index.addEvent(eventRow(e)); index.addRoute(routeRow(e)); pass2(index, [e], [s]);
  index.finishBuild(state(1, { currentGeneration: null }));
  assert.equal(index.sealByGeneration(1)!.watermark, 150); assert.equal(index.firstDue(150), undefined);
  assert.equal(index.diagnostics().events, 1); assert.equal(index.diagnostics().routes, 1); assert.equal(index.diagnostics().seals, 1);
  index.dispose();
});

test('orphan, reverse mismatch, repeated attachment and late event are closed corruption', () => {
  const index = openIndex(); corrupt(() => index.addRoute(routeRow()));
  index.addEvent(eventRow()); corrupt(() => index.addRoute({ ...routeRow(), externalEventId: 'other' }));
  index.addRoute(routeRow()); corrupt(() => index.addRoute(routeRow()));
  corrupt(() => index.addEvent(eventRow(event(2)))); index.dispose();
});

for (const missing of ['event', 'route', 'control'] as const) test(`second pass cannot omit ${missing}`, () => {
  const index = openIndex(); index.addSeal({ seal: seal(), version: version(3), payloadBytes: 200 });
  index.addEvent(eventRow()); index.addRoute(routeRow()); index.endPass(1);
  if (missing !== 'event') index.seePass2({ type: 'event', id: 'event-1' }, version());
  if (missing !== 'route') index.seePass2({ type: 'route', id: 'target-1' }, version(2));
  if (missing !== 'control') index.seePass2({ type: 'control', id: 'generation:1' }, version(3));
  corrupt(() => index.endPass(2)); index.dispose();
});
for (const kind of ['etag', 'digest', 'timestamp', 'extra', 'duplicate'] as const) test(`second pass rejects ${kind} drift without weakening published versions`, () => {
  const index = openIndex(); index.addEvent(eventRow()); index.addRoute(routeRow()); index.endPass(1);
  const key = { type: 'event' as const, id: kind === 'extra' ? 'other' : 'event-1' };
  if (kind === 'duplicate') index.seePass2(key, version());
  const v = { ...version(), ...(kind === 'etag' ? { etag: '"new"' } : kind === 'digest' ? { digest: 'ff'.repeat(32) } :
    kind === 'timestamp' ? { timestamp: '2025-01-03T03:04:05Z' } : {}) };
  corrupt(() => index.seePass2(key, v)); index.dispose();
});

for (const issue of ['counts', 'bodies', 'gap', 'received', 'generation', 'watermark', 'epoch', 'interval', 'missing-route'] as const) {
  test(`final graph rejects ${issue} contradictions independent of current policy`, () => {
    const index = openIndex();
    const events = [event(), event(issue === 'gap' ? 3 : 2, issue === 'received' ? { received: 99 } : issue === 'generation' ? { generation: 2 } :
      issue === 'watermark' ? { received: 151 } : issue === 'epoch' ? { attempt: 1, attemptId: uuid, attemptEpoch: 2 } : {})];
    const seals = issue === 'interval' ? [seal({ lastOrder: 2 })] : [];
    for (const s of seals) index.addSeal({ seal: s, version: version(3), payloadBytes: 200 });
    for (const e of events) index.addEvent(eventRow(e));
    for (const e of events.slice(0, issue === 'missing-route' ? 1 : 2)) index.addRoute(routeRow(e));
    if (issue === 'missing-route') corrupt(() => index.endPass(1));
    else {
      pass2(index, events, seals);
      corrupt(() => index.finishBuild(state(issue === 'counts' ? 1 : 2, issue === 'bodies' ? { bodies: 1 } : {})));
    }
    index.dispose();
  });
}

test('first due scans ordinal rather than retry time and old forwarding projects without rewriting evidence', () => {
  const index = openIndex(); const events = [event(1, { nextAttempt: 180 }), event(2, { state: 'forwarding', attempt: 1, attemptId: uuid, attemptEpoch: 1 })];
  for (const e of events) index.addEvent(eventRow(e)); for (const e of events) index.addRoute(routeRow(e));
  pass2(index, events); index.finishBuild(state(2, { restartEpoch: 2 }));
  assert.equal(index.firstDue(150)!.order, 2); assert.equal(index.firstDue(180)!.order, 1);
  assert.equal(index.eventByOrder(2)!.attemptId, uuid); assert.equal(index.eventByOrder(2)!.state, 'forwarding');
  corrupt(() => index.eventByOrder(100001)); corrupt(() => index.sealByGeneration(Infinity)); index.dispose();
});

function builtIndex(max = 1073741824, records = 1) {
  const index = openIndex(max); const events = Array.from({ length: records }, (_, n) => event(n + 1));
  for (const e of events) index.addEvent(eventRow(e)); for (const e of events) index.addRoute(routeRow(e));
  pass2(index, events); index.finishBuild(state(records)); return index;
}
function admission(order = 2) {
  const e = event(order); return { state: state(order), event: eventRow(e), route: routeRow(e),
    manifest: [{ key: { type: 'event' as const, id: e.externalEventId }, digest: version(4).digest },
      { key: { type: 'route' as const, id: e.replyTarget }, digest: version(5).digest }] };
}
function update(patch: Partial<EventSummary> = {}) {
  return { state: state(), event: eventRow(event(1, { nextAttempt: 170, ...patch })),
    manifest: [{ key: { type: 'event' as const, id: 'event-1' }, digest: version(4).digest }] };
}

test('prepare is opaque and invisible; confirmed all-row refresh alone permits atomic admission publication', () => {
  const index = builtIndex(); const input = admission(); const before = index.diagnostics().chargedBytes;
  const token = index.prepare(input);
  assert.equal(Object.keys(token).length, 0); assert.equal(index.eventByOrder(2), undefined);
  assert.equal(index.state().records, 1); assert.equal(index.diagnostics().chargedBytes, before + 8264);
  corrupt(() => index.publish(token));
  corrupt(() => index.refresh(token, input.manifest[0]!.key, version(4)));
  index.confirm(token);
  corrupt(() => index.publish(token));
  index.refresh(token, input.manifest[0]!.key, version(4)); corrupt(() => index.publish(token));
  assert.equal(index.eventById('event-2'), undefined); assert.equal(index.routeByTarget('target-2'), undefined);
  input.event.event.replyTarget = 'caller-mutated'; input.state.records = 99; input.manifest[1]!.digest = version(6).digest;
  index.refresh(token, { type: 'route', id: 'target-2' }, version(5));
  index.publish(token);
  assert.equal(index.state().records, 2); assert.equal(index.eventByOrder(2)!.replyTarget, 'target-2');
  assert.equal(index.version({ type: 'event', id: 'event-2' }).etag, '"v4"');
  assert.equal(index.version({ type: 'route', id: 'target-2' }).etag, '"v5"');
  assert.equal(index.diagnostics().chargedBytes, working + 8264); assert.equal(index.diagnostics().working.delta, 0);
  corrupt(() => index.publish(token)); corrupt(() => index.confirm(token)); index.dispose();
});

test('staged refresh requires exact planned digests and never adopts new unmanifested ETags', () => {
  const index = builtIndex(); const token = index.prepare(update()); index.confirm(token);
  corrupt(() => index.refresh(token, { type: 'event', id: 'event-1' }, version(6)));
  corrupt(() => index.refresh(token, { type: 'route', id: 'target-1' }, { ...version(2), etag: '"new"' }));
  corrupt(() => index.refresh(token, { type: 'route', id: 'absent' }, version(2)));
  index.refresh(token, { type: 'route', id: 'target-1' }, version(2));
  corrupt(() => index.publish(token)); index.refresh(token, { type: 'event', id: 'event-1' }, version(4));
  assert.equal(index.eventById('event-1')!.nextAttempt, 100);
  index.publish(token); assert.equal(index.eventById('event-1')!.nextAttempt, 170);
  assert.equal(index.version({ type: 'route', id: 'target-1' }).etag, '"v2"'); index.dispose();
});

test('unconfirmed abort restores graph and credits; stale and foreign handles cannot authorize work', () => {
  const index = builtIndex(), other = builtIndex(); const baseline = index.diagnostics();
  const token = index.prepare(admission()); corrupt(() => index.prepare(update()));
  corrupt(() => other.confirm(token)); corrupt(() => index.confirm({} as typeof token));
  index.abort(token); assert.equal(index.state().records, 1);
  assert.equal(index.diagnostics().chargedBytes, baseline.chargedBytes); assert.equal(index.diagnostics().working.delta, 0);
  const next = index.prepare(admission()); corrupt(() => index.confirm(token)); index.abort(next);
  corrupt(() => index.abort(token)); index.dispose(); other.dispose();
});

test('confirmed discard retires the index rather than allowing replay or simulated rollback', () => {
  const index = builtIndex(); const token = index.prepare(update()); index.confirm(token);
  corrupt(() => index.abort(token)); index.discardConfirmed(token);
  corrupt(() => index.prepare(update())); corrupt(() => index.eventById('event-1'));
  corrupt(() => index.state()); corrupt(() => index.publish(token));
  index.dispose(); index.dispose(); assert.equal(index.diagnostics().chargedBytes, 0);
  corrupt(() => index.begin());
});

test('M-only state advance has zero data manifest but still requires confirmation', () => {
  const index = builtIndex(); const token = index.prepare({ state: state(1, { lastNow: 180 }), manifest: [] });
  corrupt(() => index.publish(token)); index.confirm(token); index.publish(token);
  assert.equal(index.state().lastNow, 180); assert.equal(index.version({ type: 'event', id: 'event-1' }).etag, '"v1"'); index.dispose();
});

test('seal-only publication quarantines by generation without changing any event version or arena capacity', () => {
  const index = builtIndex(1073741824, 3); const before = index.diagnostics();
  const token = index.prepare({ state: state(3, { currentGeneration: null }), seal: { seal: seal({ lastOrder: 3 }), payloadBytes: 200 },
    manifest: [{ key: { type: 'control', id: 'generation:1' }, digest: version(3).digest }] });
  assert.equal(index.firstDue(150)!.order, 1); index.confirm(token);
  index.refresh(token, { type: 'control', id: 'generation:1' }, version(3)); index.publish(token);
  assert.equal(index.firstDue(150), undefined); assert.equal(index.eventByOrder(1)!.state, 'pending');
  assert.equal(index.version({ type: 'event', id: 'event-1' }).etag, '"v1"');
  assert.equal(index.diagnostics().eventCapacity, before.eventCapacity);
  assert.equal(index.diagnostics().chargedBytes, before.chargedBytes + 516); index.dispose();
});

for (const [field, value] of [['externalEventId', 'changed'], ['replyTarget', 'changed'], ['fingerprint', 'ee'.repeat(32)],
  ['bodyDigest', 'ee'.repeat(32)], ['received', 101], ['deadline', 201], ['order', 2], ['generation', 2]] as const) {
  test(`event replacement cannot mutate immutable ${field}`, () => {
    const index = builtIndex(); const before = index.diagnostics().chargedBytes;
    corrupt(() => index.prepare(update({ [field]: value })));
    assert.equal(index.diagnostics().chargedBytes, before); assert.equal(index.diagnostics().working.delta, 0); index.dispose();
  });
}

test('generation replacement rejects a structurally coherent repartition', () => {
  const index = builtIndex(1073741824, 2); const before = index.diagnostics();
  try {
    corrupt(() => index.prepare({
      state: state(2, { currentGeneration: 2 }),
      event: { event: event(2, { generation: 2 }), bodyEncodingBytes: 1000, payloadBytes: 1500 },
      seal: { seal: seal({ lastOrder: 1, watermark: 100, observation: 90 }), payloadBytes: 200 },
      manifest: [
        { key: { type: 'event', id: 'event-2' }, digest: version(4).digest },
        { key: { type: 'control', id: 'generation:1' }, digest: version(3).digest },
      ],
    }));
    assert.equal(index.eventByOrder(2)!.generation, 1);
    assert.equal(index.state().currentGeneration, 1);
    assert.equal(index.sealByGeneration(1), undefined);
    assert.equal(index.diagnostics().chargedBytes, before.chargedBytes);
    assert.equal(index.diagnostics().working.delta, 0);
    assert.equal(index.version({ type: 'event', id: 'event-2' }).etag, '"v1"');
  } finally { index.dispose(); }
});

test('claim retry and terminal slot updates preserve route and historical immutable evidence', () => {
  const index = builtIndex();
  const changes: Partial<EventSummary>[] = [
    { state: 'forwarding', attempt: 1, attemptId: uuid, attemptEpoch: 1 },
    { state: 'pending', attempt: 1, attemptId: uuid, attemptEpoch: 1, nextAttempt: 175 },
    { state: 'terminal', attempt: 1, attemptId: uuid, attemptEpoch: 1, receipt: { status: 'accepted', eventId: 'receipt', state: 'Queued' } },
  ];
  for (const patch of changes) {
    const input = update(patch); if (patch.state === 'terminal') input.state.bodies = 0;
    const token = index.prepare(input); index.confirm(token); index.refresh(token, { type: 'event', id: 'event-1' }, version(4)); index.publish(token);
    assert.equal(index.eventByOrder(1)!.state, patch.state); assert.equal(index.eventByOrder(1)!.bodyDigest === 'cd'.repeat(32), true);
    assert.equal(index.routeByTarget('target-1')!.botId, 'bot');
  }
  assert.equal(index.eventLengths('event-1').bodyEncodingBytes, 0); assert.equal(index.state().bodies, 0); index.dispose();
});

for (const kind of ['missing-route', 'route-replace', 'missing-manifest', 'extra-manifest', 'wrong-key', 'duplicate-key', 'bad-digest', 'bad-state'] as const) {
  test(`prepare rejects ${kind} before mutation enrollment`, () => {
    const index = builtIndex(); const input = admission();
    if (kind === 'missing-route') delete (input as Partial<typeof input>).route;
    if (kind === 'route-replace') { input.route = routeRow(); input.manifest[1]!.key.id = 'target-1'; }
    if (kind === 'missing-manifest') input.manifest.pop();
    if (kind === 'extra-manifest') input.manifest.push({ key: { type: 'event', id: 'extra' }, digest: version(4).digest });
    if (kind === 'wrong-key') input.manifest[0]!.key.id = 'wrong';
    if (kind === 'duplicate-key') input.manifest[1] = input.manifest[0]!;
    if (kind === 'bad-digest') input.manifest[0]!.digest = 'invalid';
    if (kind === 'bad-state') input.state.bodies = 1;
    const before = index.diagnostics().chargedBytes; corrupt(() => index.prepare(input));
    assert.equal(index.diagnostics().chargedBytes, before); assert.equal(index.diagnostics().working.delta, 0); index.dispose();
  });
}

test('staging charges slot/manifest copies against the SAME delta quota as store payload copies', () => {
  const index = builtIndex();
  // Admission stores one event slot4096 (route embedded) and one state slot4096;
  // expected key/digest manifest is encoded in those slots, not a second JS copy.
  const payloads = index.reserveWorking('delta', 524288 - 8192 + 1);
  exhausted(() => index.prepare(admission())); assert.equal(index.eventByOrder(2), undefined);
  index.releaseWorking(payloads);
  const exact = index.reserveWorking('delta', 524288 - 8192);
  const token = index.prepare(admission()); assert.equal(index.diagnostics().working.delta, 524288);
  index.abort(token); index.releaseWorking(exact); assert.equal(index.diagnostics().working.delta, 0); index.dispose();
});

test('prepare growth shortfall preserves the old complete graph at exact overlap boundary', () => {
  const index = builtIndex(working + 4132 + 8264 - 1);
  exhausted(() => index.prepare(admission())); assert.equal(index.state().records, 1);
  assert.equal(index.diagnostics().chargedBytes, working + 4132); assert.equal(index.diagnostics().working.delta, 0);
  assert.equal(index.eventById('event-2'), undefined); index.dispose();
});

for (const malformed of [NaN, -1, 1.5, 100001]) test('first-due refuses malformed planned state even when no loop iteration would select a row', () => {
  const index = builtIndex(); corrupt(() => index.firstDue(150, state(1, { records: malformed }))); index.dispose();
});
for (const patch of [{ generation: 0 }, { nextAttempt: NaN }, { state: 'unknown' as EventSummary['state'] }]) {
  test('first-due validates every supplied overlay before projection, including an ineligible row', () => {
    const index = builtIndex(); corrupt(() => index.firstDue(150, state(), { event: event(1, { nextAttempt: 180, ...patch }) })); index.dispose();
  });
}
test('first-due rejects an out-of-range overlay rather than silently ignoring it', () => {
  const index = builtIndex(); corrupt(() => index.firstDue(150, state(), { event: event(2) })); index.dispose();
});
test('encoding lengths cannot exceed their enclosing physical payload', () => {
  const index = openIndex(); corrupt(() => index.addEvent({ ...eventRow(), bodyEncodingBytes: 1501 }));
  index.addEvent(eventRow()); corrupt(() => index.addRoute({ ...routeRow(), routeEncodingBytes: 701 })); index.dispose();
});

test('allocation failure after growth enrollment is exhaustion, with old graph and charges preserved', () => {
  const index = builtIndex(); const before = index.diagnostics().chargedBytes;
  const allocate = Buffer.alloc;
  Buffer.alloc = ((size: number, ...rest: Parameters<typeof Buffer.alloc> extends [number, ...infer R] ? R : never) => {
    if (size === 8192) {
      assert.equal(index.diagnostics().chargedBytes, before + 8264);
      throw new RangeError('synthetic allocation failure');
    }
    return allocate(size, ...rest);
  }) as typeof Buffer.alloc;
  try { exhausted(() => index.prepare(admission())); } finally { Buffer.alloc = allocate; }
  assert.equal(index.diagnostics().chargedBytes, before); assert.equal(index.diagnostics().working.delta, 0);
  assert.equal(index.state().records, 1); index.dispose();
});

test('actual Task2a retained-result consumer reads the real index facade without current-policy pruning', () => {
  const index = builtIndex(1073741824, 2); const s = state(2);
  const decision = ordinary('admit', { eventId: 'event-1', replyTarget: 'other', fingerprint: 'ab'.repeat(32),
    policy: { maxRecords: 1, maxPending: 1, replayWindowMs: 1 }, outcome: { kind: 'duplicate', replyTarget: 'target-1' } }, s);
  const c = context(decision, s, new Graph([event(), event(2)]));
  validateResult({ ...c, graph: index }); assert.equal(index.eventByOrder(2)!.order, 2); index.dispose();
});

test('claimed large M count cannot trigger eager event or map allocation', () => {
  const index = openIndex(); index.endPass(1); index.endPass(2);
  corrupt(() => index.finishBuild(state(100000)));
  assert.equal(index.diagnostics().chargedBytes, working); assert.equal(index.diagnostics().eventCapacity, 0);
  assert.equal(index.diagnostics().identityBuckets, 0); index.dispose();
});

test('multi-interval graph preserves frozen seals, terminal body charges, and a current interval', () => {
  const index = openIndex(); const seals = [seal({ watermark: 150 }), seal({ generation: 2, lastOrder: 2, watermark: 175,
    observation: null, reason: 'clock-uncertain', epoch: 3 })];
  const events = [event(), event(2, { generation: 2, received: 150, deadline: 250, state: 'terminal',
    receipt: { status: 'rejected', eventId: 'receipt-2', state: 'Rejected' } }), event(3, { generation: 3, received: 175, deadline: 275 })];
  for (const s of seals) index.addSeal({ seal: s, version: version(3), payloadBytes: 1024 });
  for (const e of events) index.addEvent(eventRow(e)); for (const e of events) index.addRoute(routeRow(e));
  pass2(index, events, seals); index.finishBuild(state(3, { bodies: 2, currentGeneration: 3, lastNow: 175 }));
  assert.equal(index.firstDue(175)!.order, 3); assert.equal(index.sealByGeneration(2)!.observation, null);
  assert.equal(index.sealByGeneration(2)!.epoch, 3); index.dispose();
});

for (const kind of ['route', 'control'] as const) for (const field of ['etag', 'digest', 'timestamp'] as const) {
  test(`pass2 compares the ${kind} ${field} in its own slot region`, () => {
    const index = openIndex(); index.addSeal({ seal: seal(), version: version(3), payloadBytes: 200 });
    index.addEvent(eventRow()); index.addRoute(routeRow()); index.endPass(1);
    const v = version(kind === 'route' ? 2 : 3);
    const drift = { ...v, [field]: field === 'etag' ? '"drift"' : field === 'digest' ? 'ff'.repeat(32) : '2025-01-03T03:04:05Z' };
    corrupt(() => index.seePass2({ type: kind, id: kind === 'route' ? 'target-1' : 'generation:1' }, drift)); index.dispose();
  });
}

test('three-row structural delta needs all three versions; this is not a business-transition proof', () => {
  const index = builtIndex(); const input = admission();
  input.event = eventRow(event(2, { generation: 2, received: 150, deadline: 250 })); input.state.currentGeneration = 2;
  const token = index.prepare({ ...input, seal: { seal: seal(), payloadBytes: 200 }, manifest: [...input.manifest,
    { key: { type: 'control', id: 'generation:1' }, digest: version(3).digest }] });
  assert.equal(index.diagnostics().working.delta, 8704);
  index.confirm(token); index.refresh(token, { type: 'event', id: 'event-2' }, version(4));
  index.refresh(token, { type: 'route', id: 'target-2' }, version(5)); corrupt(() => index.publish(token));
  index.refresh(token, { type: 'control', id: 'generation:1' }, version(3));
  corrupt(() => index.refresh(token, { type: 'control', id: 'generation:1' }, version(3)));
  index.publish(token); assert.equal(index.firstDue(150)!.order, 2); index.dispose();
});

test('seal slots preserve maximum version fields and numbers without exposing backing bytes', () => {
  const index = openIndex(); const s = seal({ watermark: MAX_INBOX_TIME, observation: MAX_INBOX_TIME - 1, epoch: Number.MAX_SAFE_INTEGER });
  const v = { ...version(3), etag: `"${'q'.repeat(254)}"` };
  index.addSeal({ seal: s, version: v, payloadBytes: 1024 });
  const copy = index.sealByGeneration(1)!; copy.watermark = 0; s.observation = 0; v.etag = '"changed"';
  assert.equal(index.sealByGeneration(1)!.watermark, MAX_INBOX_TIME);
  assert.equal(index.sealByGeneration(1)!.observation, MAX_INBOX_TIME - 1);
  assert.equal(index.sealByGeneration(1)!.epoch, Number.MAX_SAFE_INTEGER);
  assert.equal(index.version({ type: 'control', id: 'generation:1' }).etag.length, 256); index.dispose();
});

test('retired index permits draining existing phase credits but never reserves new work', () => {
  const index = builtIndex(); const credit = index.reserveWorking('frame', 1000);
  const token = index.prepare(update()); index.confirm(token); index.discardConfirmed(token);
  index.releaseWorking(credit); assert.equal(index.diagnostics().working.frame, 0);
  corrupt(() => index.reserveWorking('frame', 1)); index.dispose();
});

test('dispose drops every pending capacity and phase reservation without publishing', () => {
  const index = builtIndex(); const token = index.prepare(admission()); index.confirm(token);
  index.dispose(); assert.equal(index.diagnostics().chargedBytes, 0); assert.equal(index.diagnostics().working.delta, 0);
  corrupt(() => index.publish(token)); corrupt(() => index.prepare(admission()));
});

test('structural worst growth overlap is below 1GiB without allocating or executing 100k rows', () => {
  assert.equal(65536 * 4096 + 131072 * 4096 + 65536 * 512 + 131072 * 512 +
    2 * (131072 + 262144) * 8 + 2 * (65536 + 131072) * 4 + working, 918028288);
  assert.equal(918028288 < 1073741824, true);
});
