import assert from 'node:assert/strict';
import test from 'node:test';
import { requestIdentity } from '../src/delivery/identity.js';
import { decodeDelivery, snapshotDelivery } from '../src/outbound/validate.js';
import { finalDelivery } from './fixtures/outgoing.js';

const scope = { appId: 'app-fixture', tenantId: finalDelivery.accountId };
const invalid = (value: unknown) => assert.throws(() => snapshotDelivery(value, scope), { message: 'Invalid delivery request.' });

test('snapshot preserves exact strings and domain fingerprint in independent frozen data', () => {
  const input = { ...finalDelivery, taskRef: { ...finalDelivery.taskRef }, sessionRef: { ...finalDelivery.sessionRef }, metadata: { 'A.b/c-d_0': ' value ' }, threadId: '' };
  const before = structuredClone(input);
  const output = snapshotDelivery(input, scope);
  assert.deepEqual(output, before);
  assert.deepEqual(requestIdentity(output, scope), requestIdentity(input, scope));
  input.text = 'changed'; input.taskRef.name = 'changed'; input.sessionRef.namespace = 'changed'; input.metadata['A.b/c-d_0'] = 'changed';
  assert.deepEqual(output, before);
  for (const value of [output, output.taskRef, output.sessionRef, output.metadata]) assert.equal(Object.isFrozen(value), true);
});

test('decoder accepts one exact UTF-8 JSON request including whitespace-only nonempty text', () => {
  const input = { ...finalDelivery, text: '\t\r\n', metadata: { empty: '' } };
  assert.deepEqual(decodeDelivery(Buffer.from(` \n${JSON.stringify(input)}\t `), scope), input);
  assert.deepEqual(snapshotDelivery(Object.assign(Object.create(null), input), scope), input);
});

test('HTTP body bound counts raw bytes even when JSON has valid padding', () => {
  const json = JSON.stringify(finalDelivery);
  const boundary = Buffer.concat([Buffer.from(json), Buffer.alloc(256 * 1024 - Buffer.byteLength(json), ' ')]);
  assert.deepEqual(decodeDelivery(boundary, scope), finalDelivery);
  assert.throws(() => decodeDelivery(Buffer.concat([boundary, Buffer.from(' ')]), scope));
  assert.equal(snapshotDelivery({ ...finalDelivery, text: '\r'.repeat(64 * 1024) }, scope).text.length, 64 * 1024);
});

// Escaped allowed text is at most twice its raw size. The HTTP limit is also
// tested with raw padding above; this independently checks the text byte bound.
test('exact byte limits accept Unicode without trimming or normalization', () => {
  const input = { ...finalDelivery, text: 'é'.repeat(32768), deliveryId: 'é'.repeat(128), threadId: '',
    metadata: { ['a'.repeat(256)]: 'é'.repeat(128) } };
  assert.deepEqual(snapshotDelivery(input, scope), input);
  assert.deepEqual(snapshotDelivery({ ...finalDelivery, text: '🧑🏽‍💻', contextId: '\ufeffcontext\ufeff' }, scope).contextId, '\ufeffcontext\ufeff');
});

const invalidUtf8Parts = JSON.stringify({ ...finalDelivery, text: 'invalid-utf8-fixture' }).split('invalid-utf8-fixture');
for (const [label, bytes] of [
  ['trailing JSON', Buffer.from(`${JSON.stringify(finalDelivery)}{}`)],
  ['truncated', Buffer.from('{')], ['invalid UTF-8', Buffer.from([0xc0, 0xaf])],
  ['invalid UTF-8 in text', Buffer.concat([Buffer.from(invalidUtf8Parts[0]!), Buffer.from([0xff]), Buffer.from(invalidUtf8Parts[1]!)])],
  ['BOM', Buffer.from(`\ufeff${JSON.stringify(finalDelivery)}`)], ['null', Buffer.from('null')],
] as const) test(`decoder rejects ${label}`, () => assert.throws(() => decodeDelivery(bytes, scope), { message: 'Invalid delivery request.' }));

const changes: [string, Record<string, unknown>][] = [
  ['version', { protocolVersion: 'orka.gateway.v2' }], ['kind', { kind: 'progress' }], ['account scope', { accountId: 'other' }],
  ['empty text', { text: '' }], ['null text', { text: null }], ['missing text', { text: undefined }],
  ['oversize text', { text: 'é'.repeat(32769) }], ['surrogate', { text: '\ud800' }], ['control', { text: '\0' }], ['C1', { text: '\u0085' }],
  ['unknown field', { unexpected: 'fixture' }], ['null thread', { threadId: null }], ['oversize thread', { threadId: 'x'.repeat(257) }],
  ['partial ref', { taskRef: { namespace: 'ns' } }], ['extra ref', { sessionRef: { ...finalDelivery.sessionRef, extra: true } }],
  ['null ref', { taskRef: null }], ['null metadata', { metadata: null }], ['array metadata', { metadata: [] }],
  ['metadata count', { metadata: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v'])) }],
  ['metadata key bytes', { metadata: { ['k'.repeat(257)]: 'v' } }], ['metadata value bytes', { metadata: { k: 'é'.repeat(129) } }],
  ['metadata control', { metadata: { k: '\n' } }], ['metadata nonstring', { metadata: { k: 0 } }],
  ...[' leading', 'é', '_bad', '-bad', 'x:y', 'x y', ''].map((key): [string, Record<string, unknown>] => [`metadata key ${key}`, { metadata: { [key]: 'v' } }]),
];
for (const field of ['deliveryId', 'idempotencyId', 'originatingEventId', 'contextId', 'replyTarget']) {
  for (const [label, value] of [['missing', undefined], ['empty', ''], ['null', null], ['space', ' x'], ['control', 'x\ny'], ['bytes', 'é'.repeat(129)], ['surrogate', '\udc00']] as const) {
    changes.push([`${field} ${label}`, { [field]: value }]);
  }
}
for (const [label, change] of changes) test(`snapshot rejects ${label}`, () => invalid({ ...finalDelivery, ...change }));

test('rejects non-data objects and nested accessors without invoking them', () => {
  let reads = 0;
  const accessor = { get name() { reads++; return 'name'; }, namespace: 'ns' };
  for (const value of [null, [], 1, Object.assign(Object.create({ inherited: true }), finalDelivery),
    { ...finalDelivery, get text() { reads++; return 'text'; } }, { ...finalDelivery, taskRef: accessor },
    { ...finalDelivery, metadata: { get key() { reads++; return 'value'; } } },
    { ...finalDelivery, [Symbol('extra')]: true }, Object.defineProperty({ ...finalDelivery }, 'hidden', { value: true }),
    { ...finalDelivery, taskRef: Object.assign(Object.create({ inherited: true }), finalDelivery.taskRef) }]) invalid(value);
  assert.equal(reads, 0);
});
