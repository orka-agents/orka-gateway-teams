import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest, encode, MAX_REPLAY_WINDOW_MS, validateEvent, validateRoute } from '../src/ingress/codec.js';
import { decodeEvent, decodeRoute, decodeSeal, decodeState, encodeEvent, encodeRoute, encodeSeal, encodeState } from '../src/ingress/table-codec.js';
import { MAX_EVENT_PAYLOAD_BYTES, MAX_INBOX_RECORDS, MAX_INBOX_STATE_BYTES, MAX_INBOX_TIME,
  MAX_ROUTE_PAYLOAD_BYTES, MAX_SEAL_PAYLOAD_BYTES } from '../src/ingress/table-types.js';
import type { EventPayload, HandoffClockArm, InboxState, RoutePayload, SealPayload } from '../src/ingress/table-types.js';
import { MAX_PAYLOAD_BYTES } from '../src/storage/table/types.js';
import { armId, attemptId, eventFixture, eventKey, generationKey, rejectsSafely, routeFixture, routeKey, sealFixture, stateFixture } from './support/table-ingress.js';

const empty = '{"journal":"teams-inbox","schema":1,"fingerprintVersion":1,"records":0,"bodies":0,"lastNow":0,"restartEpoch":1,"currentGeneration":null,"handoffClockArm":null}';
const reverse = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;

test('empty marker has the independent canonical encoding, regardless of encoder input order', () => {
  const value = JSON.parse(empty) as InboxState;
  assert.equal(encodeState(reverse(value)).equals(Buffer.from(empty)), true);
  assert.equal(encode(decodeState(Buffer.from(empty))).equals(Buffer.from(empty)), true);
});

for (const [name, value, write, read] of [
  ['event', eventFixture(), (v: unknown) => encodeEvent(eventKey, v as EventPayload), (b: Uint8Array) => decodeEvent(eventKey, b)],
  ['route', routeFixture(), (v: unknown) => encodeRoute(routeKey, v as RoutePayload), (b: Uint8Array) => decodeRoute(routeKey, b)],
  ['seal', sealFixture(), (v: unknown) => encodeSeal(generationKey, v as SealPayload), (b: Uint8Array) => decodeSeal(generationKey, b)],
  ['state', stateFixture(), (v: unknown) => encodeState(v as InboxState), decodeState],
] as const) {
  test(`${name} uses closed canonical outer order and independent wire fixtures`, () => {
    const expected = encode(value);
    assert.equal(write(reverse(value)).equals(expected), true);
    assert.equal(encode(read(expected)).equals(expected), true);
  });
  for (const [label, change] of [
    ['unknown field', (v: Record<string, unknown>) => { v.extra = 1; }],
    ['missing field', (v: Record<string, unknown>) => { delete v.schema; }],
    ['wrong version', (v: Record<string, unknown>) => { v.schema = 2; }],
  ] as const) test(`${name} refuses ${label} at both boundaries`, () => {
    const bad = structuredClone(value) as unknown as Record<string, unknown>; change(bad);
    rejectsSafely(() => write(bad), 'invalid-input');
    rejectsSafely(() => read(encode(bad)), 'corrupt');
  });
  for (const [label, change] of [
    ['duplicate key', (s: string) => s.replace('"schema":1', '"schema":1,"schema":1')],
    ['escaped duplicate key', (s: string) => s.replace('"schema":1', '"schema":1,"sche\\u006da":1')],
    ['reordered fields', () => JSON.stringify(reverse(value))],
    ['whitespace', (s: string) => ` ${s}`],
    ['exponent integer', (s: string) => s.replace('"schema":1', '"schema":1e0')],
    ['fractional integer', (s: string) => s.replace('"schema":1', '"schema":1.0')],
    ['negative zero', (s: string) => s.replace('"schema":1', '"schema":-0')],
    ['escaped noncanonical key', (s: string) => s.replace('"schema"', '"sche\\u006da"')],
  ] as const) test(`${name} refuses ${label} before canonical publication`, () => {
    rejectsSafely(() => read(Buffer.from(change(JSON.stringify(value)))), 'corrupt');
  });
  test(`${name} refuses invalid UTF8, BOM, excessive bytes and non-byte input`, () => {
    for (const bytes of [Buffer.from([0xc0, 0x80]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encode(value)]),
      Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 32), null as unknown as Uint8Array]) rejectsSafely(() => read(bytes), 'corrupt');
  });
}

const eventChanges: [string, Record<string, unknown>][] = [
  ['fingerprint version', { fingerprintVersion: 2 }], ['extra external ID', { externalEventId: eventKey.id }],
  ['wrong body digest', { bodyDigest: 'b'.repeat(64) }], ['short fingerprint', { fingerprint: 'a'.repeat(63) }],
  ['uppercase fingerprint', { fingerprint: 'A'.repeat(64) }], ['short body digest', { bodyDigest: 'a'.repeat(63) }],
  ['empty target', { replyTarget: '' }], ['body target disagreement', { replyTarget: 'different-target' }],
  ['missing nonterminal body', { body: null }], ['nonterminal receipt', { receipt: { status: 'accepted', eventId: 'receipt', state: 'Queued' } }],
  ['terminal body retained', { state: 'terminal', receipt: { status: 'accepted', eventId: 'receipt', state: 'Queued' } }],
  ['terminal receipt missing', { state: 'terminal', body: null }],
  ['invalid receipt pair', { state: 'terminal', body: null, receipt: { status: 'accepted', eventId: 'receipt', state: 'Completed' } }],
  ['terminal reason', { state: 'terminal', body: null, receipt: { status: 'accepted', eventId: 'receipt', state: 'Queued' }, reason: 'conflict' }],
  ['blocked reason missing', { state: 'blocked' }], ['physical deadline', { state: 'blocked', reason: 'deadline' }],
  ['physical regression', { state: 'blocked', reason: 'clock-regression' }], ['physical uncertainty', { state: 'blocked', reason: 'clock-uncertain' }],
  ['pending reason', { reason: 'redirect' }], ['unknown state', { state: 'ready' }],
  ['zero forwarding', { state: 'forwarding' }], ['zero attempt ID', { attemptId }], ['zero attempt epoch', { attemptEpoch: 1 }],
  ['positive attempt without ID', { attempt: 1, attemptEpoch: 1 }], ['positive attempt without epoch', { attempt: 1, attemptId }],
  ['invalid UUID', { attempt: 1, attemptId: 'not-a-uuid', attemptEpoch: 1 }],
  ['attempt overflow', { attempt: Number.MAX_SAFE_INTEGER + 1 }], ['negative attempt', { attempt: -1 }],
  ['epoch overflow', { attempt: 1, attemptId, attemptEpoch: Number.MAX_SAFE_INTEGER + 1 }],
  ['received outside clock range', { received: MAX_INBOX_TIME + 1 }], ['negative received', { received: -1 }],
  ['deadline not after received', { deadline: 100 }], ['deadline past replay maximum', { deadline: 101 + MAX_REPLAY_WINDOW_MS }],
  ['next attempt overflow', { nextAttempt: Number.MAX_SAFE_INTEGER + 1 }], ['negative next attempt', { nextAttempt: -1 }],
  ['zero order', { order: 0 }], ['order overflow', { order: 100001 }], ['zero generation', { generation: 0 }],
  ['generation after order', { generation: 2 }],
];
for (const [label, change] of eventChanges) test(`event rejects ${label}`, () => {
  const bad = { ...eventFixture(), ...change } as EventPayload;
  rejectsSafely(() => encodeEvent(eventKey, bad), 'invalid-input');
  rejectsSafely(() => decodeEvent(eventKey, encode(bad)), 'corrupt');
});

test('event validates the external physical key and body identity', () => {
  for (const key of [{ type: 'route' as const, id: eventKey.id }, { type: 'event' as const, id: 'different' },
    { type: 'event' as const, id: '' }, { ...eventKey, extra: true }]) {
    rejectsSafely(() => encodeEvent(key, eventFixture()), 'invalid-input');
    rejectsSafely(() => decodeEvent(key, encode(eventFixture())), 'corrupt');
  }
});

test('event preserves body and sender property order for the existing digest', () => {
  const original = eventFixture(); const body = reverse({ ...original.body!, sender: { displayName: 'Name', id: 'sender' },
    occurredAt: '2025-01-01T00:00:00.123456789+00:00' });
  const event = eventFixture({ body, bodyDigest: digest(encode(body)) });
  const bytes = encodeEvent(eventKey, event);
  assert.equal(bytes.equals(encode(event)), true);
  assert.equal(encode(decodeEvent(eventKey, bytes).body).equals(encode(body)), true);
  rejectsSafely(() => decodeEvent(eventKey, encode({ ...event, body: reverse(body) })), 'corrupt');
});

test('nested event corruption cannot hide behind a recomputed body digest', () => {
  const body = eventFixture().body!;
  for (const bad of [{ ...body, extra: true }, { ...body, externalEventId: 'different' },
    { ...body, sender: { ...body.sender, extra: true } }, { ...body, text: '\u0000' },
    { ...body, replyTarget: '界'.repeat(86) }, { ...body, occurredAt: 'invalid' }]) {
    const event = { ...eventFixture(), body: bad, bodyDigest: digest(encode(bad)) };
    rejectsSafely(() => encodeEvent(eventKey, event), 'invalid-input');
    rejectsSafely(() => decodeEvent(eventKey, encode(event)), 'corrupt');
  }
  const wire = JSON.stringify(eventFixture()).replace('"id":"synthetic-sender"', '"id":"synthetic-sender","id":"synthetic-sender"');
  rejectsSafely(() => decodeEvent(eventKey, Buffer.from(wire)), 'corrupt');
});

test('terminal historical fingerprint and body digest need syntax, not a fabricated body', () => {
  const event = eventFixture({ state: 'terminal', body: null, fingerprint: 'b'.repeat(64), bodyDigest: 'c'.repeat(64),
    attempt: 1, attemptId, attemptEpoch: 1, receipt: { status: 'duplicate', eventId: 'receipt', state: 'Completed' } });
  assert.equal(encodeEvent(eventKey, event).equals(encode(event)), true);
  assert.equal(decodeEvent(eventKey, encode(event)).state, 'terminal');
});

for (const reason of ['conflict', 'invalid-event', 'redirect'] as const) test(`explicit ${reason} retains its physical body`, () => {
  const event = eventFixture({ state: 'blocked', reason, attempt: 1, attemptId, attemptEpoch: 1 });
  assert.equal(encodeEvent(eventKey, event).equals(encode(event)), true);
  assert.equal(decodeEvent(eventKey, encode(event)).reason, reason);
});
test('pending retries retain historical attempt identity and saturated nextAttempt', () => {
  const event = eventFixture({ attempt: 2, attemptId, attemptEpoch: 1, nextAttempt: Number.MAX_SAFE_INTEGER });
  assert.equal(encode(decodeEvent(eventKey, encodeEvent(eventKey, event))).equals(encode(event)), true);
});

for (const [label, change] of [
  ['wrong route digest', { routeDigest: 'b'.repeat(64) }], ['short digest', { routeDigest: 'a' }],
  ['empty reverse ID', { externalEventId: '' }], ['unknown reverse ID field', { eventId: eventKey.id }],
  ['invalid route', { route: { ...routeFixture().route, serviceUrl: 'http://synthetic.example.invalid/' } }],
] as const) test(`route rejects ${label}`, () => {
  const bad = { ...routeFixture(), ...change } as RoutePayload;
  rejectsSafely(() => encodeRoute(routeKey, bad), 'invalid-input');
  rejectsSafely(() => decodeRoute(routeKey, encode(bad)), 'corrupt');
});
test('route keys require route type and valid identity; relationships belong to audit', () => {
  for (const key of [{ type: 'event' as const, id: routeKey.id }, { type: 'route' as const, id: '' }]) {
    rejectsSafely(() => encodeRoute(key, routeFixture()), 'invalid-input');
    rejectsSafely(() => decodeRoute(key, encode(routeFixture())), 'corrupt');
  }
  assert.equal(decodeRoute({ type: 'route', id: 'another-valid-target' }, encode(routeFixture())).schema, 1);
});
test('encoder normalizes routes and receipts through the existing validators, decoder requires normalized bytes', () => {
  const route = routeFixture({ route: reverse(routeFixture().route) });
  assert.equal(encodeRoute(routeKey, route).equals(encode(routeFixture())), true);
  rejectsSafely(() => decodeRoute(routeKey, encode(route)), 'corrupt');
  const event = eventFixture({ state: 'terminal', body: null, receipt: { status: 'accepted', eventId: 'receipt', state: 'Queued' } });
  const input = { ...event, receipt: { ...event.receipt!, message: 'discarded synthetic description' } };
  assert.equal(encodeEvent(eventKey, input).equals(encode(event)), true);
  rejectsSafely(() => decodeEvent(eventKey, encode(input)), 'corrupt');
});

for (const [label, change] of [
  ['zero generation', { generation: 0 }], ['last order before generation', { generation: 2, lastOrder: 1 }],
  ['last order overflow', { lastOrder: 100001 }], ['watermark overflow', { watermark: MAX_INBOX_TIME + 1 }],
  ['observation equals watermark', { observation: 150 }], ['observation above watermark', { observation: 151 }],
  ['regression without sample', { observation: null }], ['negative observation', { observation: -1 }],
  ['uncertain with sample', { reason: 'clock-uncertain', observation: 140 }], ['unsupported reason', { reason: 'deadline' }],
  ['zero epoch', { epoch: 0 }], ['epoch overflow', { epoch: Number.MAX_SAFE_INTEGER + 1 }], ['unknown kind', { kind: 'seal' }],
] as const) test(`seal rejects ${label}`, () => {
  const bad = { ...sealFixture(), ...change } as SealPayload;
  rejectsSafely(() => encodeSeal(generationKey, bad), 'invalid-input');
  rejectsSafely(() => decodeSeal(generationKey, encode(bad)), 'corrupt');
});
test('seal keys are derived canonical generation controls', () => {
  for (const key of [{ type: 'event' as const, id: generationKey.id }, { type: 'control' as const, id: 'generation:01' },
    { type: 'control' as const, id: 'generation:2' }]) {
    rejectsSafely(() => encodeSeal(key, sealFixture()), 'invalid-input');
    rejectsSafely(() => decodeSeal(key, encode(sealFixture())), 'corrupt');
  }
});
test('clock-uncertain seals retain a null observation as reader representation', () => {
  const seal = sealFixture({ observation: null, reason: 'clock-uncertain' });
  assert.equal(encode(decodeSeal(generationKey, encodeSeal(generationKey, seal))).equals(encode(seal)), true);
});

for (const [label, change] of [
  ['wrong journal', { journal: 'teams-delivery' }], ['fingerprint version', { fingerprintVersion: 2 }],
  ['negative records', { records: -1 }], ['record ceiling', { records: 100001 }], ['negative bodies', { bodies: -1 }],
  ['bodies above records', { bodies: 2 }], ['unsafe watermark', { lastNow: MAX_INBOX_TIME + 1 }],
  ['negative watermark', { lastNow: -1 }], ['zero epoch', { restartEpoch: 0 }], ['unsafe epoch', { restartEpoch: Number.MAX_SAFE_INTEGER + 1 }],
  ['zero generation', { currentGeneration: 0 }], ['generation above records', { currentGeneration: 2 }],
  ['arm without records', { records: 0, bodies: 0, currentGeneration: null,
    handoffClockArm: { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId } }],
] as const) test(`state rejects ${label}`, () => {
  const bad = { ...stateFixture(), ...change } as InboxState;
  rejectsSafely(() => encodeState(bad), 'invalid-input');
  rejectsSafely(() => decodeState(encode(bad)), 'corrupt');
});
for (const [label, change] of [
  ['missing attempt ID', { attemptId: undefined }], ['invalid arm UUID', { id: 'invalid' }], ['invalid attempt UUID', { attemptId: 'invalid' }],
  ['zero owner epoch', { ownerEpoch: 0 }], ['unsafe owner epoch', { ownerEpoch: Number.MAX_SAFE_INTEGER + 1 }],
  ['zero generation', { generation: 0 }], ['generation after order', { generation: 2 }], ['order above records', { order: 2 }], ['extra field', { extra: true }],
] as const) test(`state arm rejects ${label}`, () => {
  const bad = stateFixture({ handoffClockArm: Object.assign({ id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId }, change) as unknown as HandoffClockArm });
  rejectsSafely(() => encodeState(bad), 'invalid-input');
  rejectsSafely(() => decodeState(encode(bad)), 'corrupt');
});
test('structural state accepts old-owner arms and arms in sealed rather than current generations', () => {
  for (const currentGeneration of [null, 2]) {
    const state = stateFixture({ records: 2, restartEpoch: 2, currentGeneration,
      handoffClockArm: { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId } });
    assert.equal(encode(decodeState(encodeState(state))).equals(encode(state)), true);
  }
});

test('encoder guards descriptors without invoking caller getters or retaining thrown details', () => {
  let calls = 0;
  const body = eventFixture().body!;
  Object.defineProperty(body, 'text', { enumerable: true, get() { calls++; throw new Error('synthetic private detail'); } });
  rejectsSafely(() => encodeEvent(eventKey, eventFixture({ body })), 'invalid-input');
  assert.equal(calls, 0);
  rejectsSafely(() => encodeState({ ...stateFixture(), [Symbol('extra')]: 1 }), 'invalid-input');
});

test('maximum legal escaped inputs fit every candidate cap without shortening V1 acceptance', t => {
  const id = '\\'.repeat(256); const text = '"'.repeat(64 * 1024);
  const body = validateEvent({ protocolVersion: 'orka.gateway.v1', externalEventId: id, eventType: 'text', accountId: id,
    contextId: id, sender: { id, displayName: id }, text, replyTarget: id, occurredAt: '2025-01-01T00:00:00.123456789+00:00' });
  assert.equal(Buffer.byteLength(body.text), 65536); assert.equal(Buffer.byteLength(body.sender.displayName!), 256);
  const event = eventFixture({ replyTarget: id, body, bodyDigest: digest(encode(body)), received: MAX_INBOX_TIME,
    deadline: Number.MAX_SAFE_INTEGER, nextAttempt: Number.MAX_SAFE_INTEGER, attempt: Number.MAX_SAFE_INTEGER, attemptId,
    attemptEpoch: Number.MAX_SAFE_INTEGER, order: 100000, generation: 100000, state: 'forwarding' });
  const prefix = 'https://synthetic.example.invalid/';
  const route = validateRoute({ serviceUrl: prefix + 'x'.repeat(2048 - prefix.length - 1) + '/', channelId: 'msteams',
    bot: { id, role: 'bot' }, conversation: { id, conversationType: 'personal', tenantId: id } });
  assert.equal(route.serviceUrl.length, 2048);
  const routePayload = routeFixture({ externalEventId: id, route, routeDigest: digest(encode(route)) });
  const seal = sealFixture({ generation: 100000, lastOrder: 100000, watermark: MAX_INBOX_TIME,
    observation: MAX_INBOX_TIME - 1, epoch: Number.MAX_SAFE_INTEGER });
  const state = stateFixture({ records: MAX_INBOX_RECORDS, bodies: MAX_INBOX_RECORDS, lastNow: MAX_INBOX_TIME,
    restartEpoch: Number.MAX_SAFE_INTEGER, currentGeneration: 100000,
    handoffClockArm: { id: armId, ownerEpoch: Number.MAX_SAFE_INTEGER, generation: 100000, order: 100000, attemptId } });
  const terminal = { ...event, state: 'terminal' as const, body: null, receipt: { status: 'deadLettered' as const, eventId: id, state: 'DeadLettered' } };
  const eventBytes = encodeEvent({ type: 'event', id }, event); const routeBytes = encodeRoute({ type: 'route', id }, routePayload);
  const sealBytes = encodeSeal({ type: 'control', id: 'generation:100000' }, seal); const stateBytes = encodeState(state);
  const terminalBytes = encodeEvent({ type: 'event', id }, terminal);
  const blocked = { ...event, state: 'blocked' as const, reason: 'invalid-event' as const };
  const blockedBytes = encodeEvent({ type: 'event', id }, blocked);
  assert.equal(blockedBytes.equals(encode(blocked)), true);
  assert.equal(encode(decodeEvent({ type: 'event', id }, blockedBytes)).equals(blockedBytes), true);
  for (const [bytes, max] of [[eventBytes, MAX_EVENT_PAYLOAD_BYTES], [routeBytes, MAX_ROUTE_PAYLOAD_BYTES],
    [sealBytes, MAX_SEAL_PAYLOAD_BYTES], [stateBytes, MAX_INBOX_STATE_BYTES], [terminalBytes, MAX_EVENT_PAYLOAD_BYTES],
    [blockedBytes, MAX_EVENT_PAYLOAD_BYTES]] as const) {
    assert.equal(bytes.length <= max && bytes.length < MAX_PAYLOAD_BYTES && Math.ceil(bytes.length / 65536) <= 4, true);
  }
  assert.equal(eventBytes.equals(encode(event)), true); assert.equal(routeBytes.equals(encode(routePayload)), true);
  assert.equal(encode(decodeEvent({ type: 'event', id }, eventBytes)).equals(eventBytes), true);
  assert.equal(encode(decodeEvent({ type: 'event', id }, terminalBytes)).equals(terminalBytes), true);
  assert.equal(encode(decodeRoute({ type: 'route', id }, routeBytes)).equals(routeBytes), true);
  assert.equal(encode(decodeSeal({ type: 'control', id: 'generation:100000' }, sealBytes)).equals(sealBytes), true);
  assert.equal(encode(decodeState(stateBytes)).equals(stateBytes), true);
  t.diagnostic(`maximum fixture bytes: body=${encode(body).length}, event=${eventBytes.length}, blocked=${blockedBytes.length}, route=${routeBytes.length}, seal=${sealBytes.length}, state=${stateBytes.length}, terminal=${terminalBytes.length}`);
});

test('V1 maximum UTF8 and permitted escape characters survive unchanged, one byte over does not', () => {
  const id = 'é'.repeat(128);
  for (const text of ['é'.repeat(32768), 'x' + '\t'.repeat(65535), 'x' + '\n'.repeat(65535), 'x' + '\r'.repeat(65535), '\\'.repeat(65536)]) {
    const body = validateEvent({ ...eventFixture().body!, externalEventId: id, replyTarget: id, text });
    assert.equal(Buffer.byteLength(body.externalEventId), 256); assert.equal(Buffer.byteLength(body.text), 65536);
    const event = eventFixture({ body, replyTarget: id, bodyDigest: digest(encode(body)) });
    const bytes = encodeEvent({ type: 'event', id }, event);
    assert.equal(bytes.length <= 140 * 1024, true);
    assert.equal(encode(decodeEvent({ type: 'event', id }, bytes).body).equals(encode(body)), true);
    const over = { ...body, text: text + 'x' };
    rejectsSafely(() => encodeEvent({ type: 'event', id }, { ...event, body: over, bodyDigest: digest(encode(over)) }), 'invalid-input');
    rejectsSafely(() => decodeEvent({ type: 'event', id }, encode({ ...event, body: over, bodyDigest: digest(encode(over)) })), 'corrupt');
  }
  const body = { ...eventFixture().body!, externalEventId: id + 'x' };
  const event = eventFixture({ body, bodyDigest: digest(encode(body)) });
  rejectsSafely(() => encodeEvent({ type: 'event', id: id + 'x' }, event), 'invalid-input');
  rejectsSafely(() => decodeEvent({ type: 'event', id: id + 'x' }, encode(event)), 'corrupt');
});

test('codecs do not mutate caller body, sender, route, receipt or arm graphs', () => {
  const event = eventFixture(); const route = routeFixture();
  const state = stateFixture({ handoffClockArm: { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId } });
  const terminal = eventFixture({ state: 'terminal', body: null, receipt: { status: 'accepted', eventId: 'receipt', state: 'Queued' } });
  Object.freeze(event.body!.sender); Object.freeze(event.body); Object.freeze(event);
  Object.freeze(route.route.bot); Object.freeze(route.route.conversation); Object.freeze(route.route); Object.freeze(route);
  Object.freeze(state.handoffClockArm); Object.freeze(state); Object.freeze(terminal.receipt); Object.freeze(terminal);
  const before = encode([event, route, state, terminal]);
  const decodedEvent = decodeEvent(eventKey, encodeEvent(eventKey, event));
  const decodedRoute = decodeRoute(routeKey, encodeRoute(routeKey, route));
  const decodedState = decodeState(encodeState(state));
  const decodedTerminal = decodeEvent(eventKey, encodeEvent(eventKey, terminal));
  decodedEvent.body!.sender.id = 'changed'; decodedRoute.route.bot.id = 'changed';
  decodedState.handoffClockArm!.order = 2; decodedTerminal.receipt!.eventId = 'changed';
  assert.equal(encode([event, route, state, terminal]).equals(before), true);
});

// Bootstrap availability is an assertion, not an unhandled missing-import error.
test('inbox row and state codecs expose the Task1 boundary', async () => {
  const path = '../src/ingress/table-codec.js';
  const api = await import(path).catch(() => ({})) as Record<string, unknown>;
  for (const name of ['encodeState', 'decodeState', 'encodeEvent', 'decodeEvent', 'encodeRoute', 'decodeRoute', 'encodeSeal', 'decodeSeal']) {
    assert.equal(typeof api[name], 'function', name);
  }
});
