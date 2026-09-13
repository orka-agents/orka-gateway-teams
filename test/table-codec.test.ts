import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { bindTable, dataRow, decodePage, decodeRecord, encodeRecord, rawJSON } from '../src/storage/table/codec.js';
import type { TableBinding } from '../src/storage/table/types.js';
import { mDigest, stamp, wireM } from './support/table-service.js';

export const binding: TableBinding = { account: 'Example123', table: 'Journal', storeId: 'stable', kind: 'delivery', scope: { appId: 'App', tenantId: 'Tenant' } };
const bindingBytes = Buffer.from(JSON.stringify(['orka-table-v1', 'example123', 'journal', 'delivery', 'stable', ['App', 'Tenant']]));
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function fixture(id = 'item', payload = Buffer.from('hello')): Record<string, unknown> {
  return { PartitionKey: 'v1_delivery_c3RhYmxl', RowKey: `delivery_${Buffer.from(id).toString('base64url')}`,
    Timestamp: '2026-01-02T03:04:05.1234567Z', 'Timestamp@odata.type': 'Edm.DateTime',
    'odata.etag': 'W/"datetime\'2026-01-02T03%3A04%3A05.1234567Z\'"', 'odata.type': 'example123.Journal',
    'odata.id': `https://example123.table.core.windows.net/Journal(PartitionKey='v1_delivery_c3RhYmxl',RowKey='delivery_${Buffer.from(id).toString('base64url')}')`,
    'odata.editLink': `Journal(PartitionKey='v1_delivery_c3RhYmxl',RowKey='delivery_${Buffer.from(id).toString('base64url')}')`,
    V: 1, T: 'delivery', Id: id, Length: payload.length, Count: Math.ceil(payload.length / 65536),
    Digest: hash(['orka-data-v1', bindingBytes.toString('base64'), 'delivery', id, payload.toString('base64')]),
    ...Object.fromEntries(Array.from({ length: Math.ceil(payload.length / 65536) }, (_, i) => [
      [`B${i}`, payload.subarray(i * 65536, (i + 1) * 65536).toString('base64')], [`B${i}@odata.type`, 'Edm.Binary'],
    ]).flat()),
  };
}
function decode(value: Record<string, unknown>) { return decodeRecord(bindTable(binding), Buffer.from(JSON.stringify(value))); }
function rejects(value: Record<string, unknown>) { assert.throws(() => decode(value), (e: unknown) => e instanceof Error && e.message === 'Table storage: corrupt'); }

test('resource casing is stable; partition ignores immutable scope but envelopes bind it', () => {
  const b = bindTable(binding);
  assert.equal(b.account, 'example123'); assert.equal(b.table, 'journal'); assert.equal(b.partition, 'v1_delivery_c3RhYmxl');
  assert.equal(b.bytes.equals(bindingBytes), true);
  assert.equal(bindTable({ ...binding, scope: { appId: 'Other', tenantId: 'Tenant' } }).partition, b.partition);
  assert.throws(() => decodeRecord(bindTable({ ...binding, scope: { appId: 'Other', tenantId: 'Tenant' } }), Buffer.from(JSON.stringify(fixture()))));
});
test('FULLmetadata preserves service Timestamp, per-row ETag and four binary chunks', () => {
  for (const size of [0, 1, 65536, 65537, 262144]) {
    const decoded = decode(fixture('item', Buffer.alloc(size, 7)));
    assert.equal(decoded.timestamp, '2026-01-02T03:04:05.1234567Z');
    assert.equal(decoded.value.kind === 'data' && decoded.value.payload.equals(Buffer.alloc(size, 7)), true);
  }
});
for (const [field, lexeme, empty] of [
  ['V', '1.0', false], ['V', '1.0000000000000001', false], ['V', '1e0', false],
  ['Length', '5.0', false], ['Length', '5.0000000000000001', false], ['Length', '5e0', false],
  ['Count', '1.0', false], ['Count', '1e0', false], ['Count', '1E+0', false],
  ['Length', '-0', true], ['Count', '-0', true], ['Length', '9007199254740993', false],
] as const) test(`point/page reject noncanonical ${field} number lexeme ${lexeme}`, () => {
  const record = fixture('item', Buffer.from(empty ? '' : 'hello'));
  const text = JSON.stringify(record).replace(`"${field}":${record[field]}`, `"${field}":${lexeme}`);
  const corrupt = (e: unknown) => e instanceof Error && e.message === 'Table storage: corrupt';
  assert.throws(() => decodeRecord(bindTable(binding), Buffer.from(text)), corrupt);
  assert.throws(() => decodePage(bindTable(binding), Buffer.from(`{"value":[${text}]}`)), corrupt);
});
test('closed raw grammar preserves canonical safe integers without rounding numeric tokens', () => {
  assert.deepEqual(rawJSON(Buffer.from('[0,1,9007199254740991,true,false,null,"1.0"]')), [0, 1, Number.MAX_SAFE_INTEGER, true, false, null, '1.0']);
  for (const token of ['9007199254740992', '9007199254740993', '1e400', '-1', '-0', '01', '1.0', '1.0000000000000001']) {
    assert.throws(() => rawJSON(Buffer.from(`[${token}]`)), (e: unknown) => e instanceof Error && e.message === 'Table storage: corrupt');
  }
});
test('digest-valid release receipts reject fractional and exponent epoch lexemes before projection', () => {
  const entity: Record<string, unknown> = { ...wireM('', 1), Operation: 'release' };
  const receipt = JSON.stringify(['22222222-2222-4222-8222-222222222222', 1, entity.Invocation, entity.Plan]);
  const control = { ...entity, Release: Buffer.from(receipt).toString('base64') };
  assert.equal(decode(stamp({ ...control, Digest: mDigest(control) }, 1)).value.kind, 'metadata');
  for (const lexeme of ['1.0', '1.0000000000000001', '1e0', '1E+0', '9007199254740993', '-0']) {
    const changed = { ...entity, Release: Buffer.from(receipt.replace(',1,', `,${lexeme},`)).toString('base64') };
    rejects(stamp({ ...changed, Digest: mDigest(changed) }, 1));
  }
});
test('legal 256 UTF8-byte IDs are injective and byte-preserving', () => {
  const b = bindTable(binding);
  for (const id of ['a/b?\\#', '界'.repeat(85), '😀'.repeat(64), 'é', 'é']) {
    assert.equal(dataRow(b, { type: 'delivery', id }), `delivery_${Buffer.from(id).toString('base64url')}`);
    assert.equal(decode(fixture(id)).value.kind, 'data');
  }
  for (const id of ['', 'a'.repeat(257), '\ud800', ' space', 'a\u0085']) assert.throws(() => dataRow(b, { type: 'delivery', id }));
  assert.throws(() => dataRow(b, { type: 'event', id: 'a' }));
});
const malformed: Record<string, unknown>[] = [
  { Timestamp: undefined }, { Timestamp: '2026-02-30T00:00:00Z' }, { 'Timestamp@odata.type': 'Edm.String' },
  { 'odata.etag': undefined }, { 'odata.etag': '*' }, { 'odata.editlink': 'alias' }, { PartitionKey: 'other' },
  { RowKey: 'delivery_aXRlbQ==' }, { Id: 'other' }, { Digest: '0'.repeat(64) }, { V: 2 },
  { B0: 'aGVsbG8' }, { B0: 'aGVsbG9=' }, { 'B0@odata.type': undefined }, { 'B0@odata.type': 'Edm.String' },
  { B1: '', 'B1@odata.type': 'Edm.Binary' }, { Count: 2 }, { Length: 4 }, { extra: true }, { partitionKey: 'alias' },
  { 'Ghost@odata.type': 'Edm.Binary' }, { 'Id@odata.type': 'Edm.Guid' }, { 'odata.type': 3 },
  { toString: 'hidden' }, { constructor: 'hidden' }, { ['__proto__']: 'hidden' },
];
for (const [i, change] of malformed.entries()) test(`raw fullmetadata rejects malformed envelope ${i}`, () => rejects({ ...fixture(), ...change }));
test('owned mutation binds immutable initialization and all mutable fields, with 64KiB binary state/result', () => {
  const initId = '11111111-1111-4111-8111-111111111111';
  const initDigest = hash(['orka-init-v1', bindingBytes.toString('base64'), initId]);
  const fields = { kind: 'metadata' as const, initId, initDigest, owner: '55555555-5555-4555-8555-555555555555', epoch: 1,
    invocation: '66666666-6666-4666-8666-666666666666', operation: 'mutate' as const, plan: '',
    state: Buffer.alloc(65536), result: Buffer.alloc(65536), release: Buffer.alloc(0) };
  fields.plan = hash(['mutate', fields.invocation, wireM(fields.owner, 1).Digest, [], fields.state.toString('base64'), fields.result.toString('base64')]);
  const digest = hash(['orka-m-v1', bindingBytes.toString('base64'), initId, initDigest, fields.owner, fields.epoch, fields.invocation, fields.operation, fields.plan,
    fields.state.toString('base64'), fields.result.toString('base64'), '']);
  const entity = { PartitionKey: 'v1_delivery_c3RhYmxl', RowKey: 'M', Timestamp: '2026-01-02T00:00:00Z',
    'Timestamp@odata.type': 'Edm.DateTime', 'odata.etag': 'W/"m"', V: 1,
    Binding: bindingBytes.toString('base64'), 'Binding@odata.type': 'Edm.Binary', InitId: initId, InitDigest: initDigest,
    Owner: fields.owner, Epoch: String(fields.epoch), 'Epoch@odata.type': 'Edm.Int64', Invocation: fields.invocation, Operation: fields.operation, Plan: fields.plan,
    State: fields.state.toString('base64'), 'State@odata.type': 'Edm.Binary', Result: fields.result.toString('base64'),
    'Result@odata.type': 'Edm.Binary', Release: '', 'Release@odata.type': 'Edm.Binary', Digest: digest };
  assert.equal(decode(entity).value.digest, digest);
  const encoded = encodeRecord(bindTable(binding), { ...fields, digest });
  assert.equal((encoded.State as { type: string }).type, 'Binary');
  for (const change of [{ Owner: 'bad' }, { Epoch: '9007199254740992' }, { Binding: '' }, { InitDigest: '0'.repeat(64) },
    { Result: Buffer.alloc(65537).toString('base64') }, { Release: Buffer.alloc(1025).toString('base64') }, { State: '' }]) rejects({ ...entity, ...change });
});
const currentOwner = '55555555-5555-4555-8555-555555555555';
const otherInvocation = '66666666-6666-4666-8666-666666666666';
const released = wireM('', 1);
const receipt = (owner: string, epoch: number) => Buffer.from(JSON.stringify([owner, epoch, otherInvocation, 'b'.repeat(64)])).toString('base64');
const invalidMetadata: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ['initialize at a positive epoch', wireM(), { Epoch: '1' }],
  ['initialize with an owner', wireM(currentOwner, 1), { Operation: 'initialize' }],
  ['initialize invocation differs from init ID', wireM(), { Invocation: otherInvocation }],
  ['initialize plan differs from exact init plan', wireM(), { Plan: '0'.repeat(64) }],
  ['genesis state is nonempty', wireM(), { State: 'eA==' }],
  ['genesis result is nonempty', wireM(), { Result: 'eA==' }],
  ['genesis barrier state is nonempty', wireM(), { Operation: 'barrier', State: 'eA==' }],
  ['genesis barrier result is nonempty', wireM(), { Operation: 'barrier', Result: 'eA==' }],
  ['epoch zero owner', wireM(), { Owner: currentOwner }],
  ['epoch zero receipt', wireM(), { Release: released.Release }],
  ['epoch zero acquire', wireM(), { Operation: 'acquire' }],
  ['epoch zero mutate', wireM(), { Operation: 'mutate' }],
  ['epoch zero release', wireM(), { Operation: 'release' }],
  ['owner-empty acquire', released, { Operation: 'acquire' }],
  ['owner-empty mutate', released, { Operation: 'mutate' }],
  ['first acquire invents state', wireM(currentOwner, 1), { State: 'eA==' }],
  ['first acquire invents result', wireM(currentOwner, 1), { Result: 'eA==' }],
  ['first owned epoch has a release', wireM(currentOwner, 1), { Release: released.Release }],
  ['second owned epoch has no release', wireM(currentOwner, 2), { Release: '' }],
  ['owned epoch skips a release', wireM(currentOwner, 3), { Release: released.Release }],
  ['owned receipt uses current epoch', wireM(currentOwner, 2), { Release: receipt('22222222-2222-4222-8222-222222222222', 2) }],
  ['owned receipt uses future epoch', wireM(currentOwner, 2), { Release: receipt('22222222-2222-4222-8222-222222222222', 3) }],
  ['owned receipt repeats current owner', wireM(currentOwner, 2), { Release: receipt(currentOwner, 1) }],
  ['owned barrier loses release', wireM(currentOwner, 2), { Operation: 'barrier', Release: '' }],
  ['unowned positive barrier has no receipt', released, { Operation: 'barrier', Release: '' }],
  ['unowned barrier receipt is stale', wireM('', 2), { Operation: 'barrier', Release: released.Release }],
  ['release has no receipt', released, { Release: '' }],
  ['release still has an owner', released, { Owner: currentOwner }],
  ['release invocation differs from receipt', released, { Invocation: otherInvocation }],
  ['release plan differs from receipt', released, { Plan: '0'.repeat(64) }],
];
for (const [name, original, change] of invalidMetadata) test(`digest-valid M rejects ${name}`, () => {
  const changed = { ...original, ...change };
  const record = stamp({ ...changed, Digest: mDigest(changed) }, 1);
  rejects(record);
  assert.throws(() => decodePage(bindTable(binding), Buffer.from(JSON.stringify({ value: [record] }))),
    (e: unknown) => e instanceof Error && e.message === 'Table storage: corrupt');
});
test('reachable M lifecycle shapes preserve opaque bytes and receipts across barriers', () => {
  for (const original of [wireM(), wireM(currentOwner, 1), wireM(currentOwner, 2), wireM('', 1), wireM('', 2)]) {
    assert.equal(decode(stamp(original, 1)).value.kind, 'metadata');
    const barrier = { ...original, Operation: 'barrier', Invocation: otherInvocation, Plan: 'b'.repeat(64) };
    assert.equal(decode(stamp({ ...barrier, Digest: mDigest(barrier) }, 2)).value.kind, 'metadata');
  }
  for (const operation of ['mutate', 'barrier']) {
    const changed = { ...wireM(currentOwner, 2), Operation: operation, State: 'eA==', Result: 'eQ==' };
    assert.equal(decode(stamp({ ...changed, Digest: mDigest(changed) }, 3)).value.kind, 'metadata');
  }
});
test('decoded duplicate names, invalid UTF8, BOM and point ETag disagreement fail before projection', () => {
  const b = bindTable(binding); const text = JSON.stringify(fixture());
  // Prefix exactly one extra key; these are duplicate-key inputs, not string sanitizers.
  const duplicates = ['{"Id":"item",' + text.slice(1), '{"\\u0049d":"item",' + text.slice(1)];
  for (const duplicate of duplicates) assert.deepEqual(JSON.parse(duplicate), JSON.parse(text));
  for (const bytes of [...duplicates.map(duplicate => Buffer.from(duplicate)),
    Buffer.concat([Buffer.from([0xff]), Buffer.from(text)]), Buffer.from('\ufeff' + text)]) {
    assert.throws(() => decodeRecord(b, bytes), (e: unknown) => e instanceof Error && e.message === 'Table storage: corrupt');
  }
  assert.throws(() => decodeRecord(b, Buffer.from(text), 'delivery_aXRlbQ', 'W/"different"'));
});
