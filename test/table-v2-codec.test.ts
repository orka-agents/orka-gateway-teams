import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import type { ExitReceipt, Metadata, MetadataV2, Planner, PlannerV2, StoredRecord, StoredRecordV2 } from '../src/storage/table/index.js';
import * as codec from '../src/storage/table/codec.js';
import { OwnedTableClient } from '../src/storage/table/client.js';
import { boundBytes, hash, stamp, tableBinding, wireM } from './support/table-service.js';
import { changedM2, exitFixture, initId, invocation, nextOwner, oldOwner, wireM2 } from './support/table-v2.js';

const decodeRecord = codec.decodeRecordV2;
const decodePage = codec.decodePageV2;
const binding = codec.bindTable(tableBinding);
const corrupt = (e: unknown) => e instanceof Error && e.message === 'Table storage: corrupt' && !('cause' in e);
function decode(value: Record<string, unknown>) { return decodeRecord(binding, Buffer.from(JSON.stringify(value))); }
function rejects(value: Record<string, unknown>) {
  assert.throws(() => decode(value), corrupt);
  assert.throws(() => decodePage(binding, Buffer.from(JSON.stringify({ value: [value] }))), corrupt);
}

test('V2 independent genesis digest and envelope decode without changing V1 binding bytes', () => {
  const raw = stamp(wireM2(), 1); const result = decode(raw);
  assert.equal(binding.bytes.equals(boundBytes), true); assert.equal(result.value.digest, raw.Digest);
  assert.equal(result.value.kind, 'metadata');
  assert.equal(raw.InitDigest, hash(['orka-init-v2', boundBytes.toString('base64'), initId]));
});
for (const kind of ['clean-release', 'operator-recovery'] as const) {
  for (const [owner, epoch] of [['', 1], ['', 2], [nextOwner, 2], [nextOwner, 3]] as const) {
    for (const barrier of [false, true]) test(`V2 accepts ${kind} owner=${!!owner} epoch=${epoch} barrier=${barrier}`, () => {
      const raw = changedM2(wireM2(owner, epoch, kind), barrier ? { Operation: 'barrier' } : {});
      const value = decode(raw).value;
      assert.equal(value.kind, 'metadata');
      assert.equal(value.digest, raw.Digest);
    });
  }
}
for (const operation of ['initialize', 'barrier', 'acquire', 'mutate']) test(`V2 accepts initial ${operation} shape`, () => {
  const raw = changedM2(wireM2(operation === 'acquire' || operation === 'mutate' ? nextOwner : '', operation === 'acquire' || operation === 'mutate' ? 1 : 0), { Operation: operation });
  assert.equal(decode(raw).value.kind, 'metadata');
});
test('both explicit codecs reject opposite metadata formats without fallback', () => {
  assert.throws(() => codec.decodeRecord(binding, Buffer.from(JSON.stringify(stamp(wireM2(), 1)))), corrupt);
  rejects(stamp(wireM(), 1));
});
const badShapes: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ['zero owner', wireM2(), { Owner: nextOwner }], ['zero exit', wireM2(), { Exit: wireM2('', 1).Exit }],
  ['zero state', wireM2(), { State: 'eA==' }], ['zero result', wireM2(), { Result: 'eA==' }],
  ...['acquire', 'mutate', 'release', 'recover'].map(op => [`zero ${op}`, wireM2(), { Operation: op }] as [string, Record<string, unknown>, Record<string, unknown>]),
  ['init invocation', wireM2(), { Invocation: invocation }], ['init plan', wireM2(), { Plan: 'a'.repeat(64) }],
  ['init positive', wireM2('', 1), { Operation: 'initialize' }], ['first state', wireM2(nextOwner, 1), { State: 'eA==' }],
  ['first result', wireM2(nextOwner, 1), { Result: 'eA==' }], ['first exit', wireM2(nextOwner, 1), { Exit: wireM2('', 1).Exit }],
  ['later no exit', wireM2(nextOwner, 2), { Exit: '' }], ['skipped epoch', wireM2(nextOwner, 2), { Epoch: '3' }],
  ['same owner', wireM2(nextOwner, 2), { Owner: oldOwner }], ['empty acquire', wireM2('', 1), { Operation: 'acquire' }],
  ['empty mutate', wireM2('', 1), { Operation: 'mutate' }], ['owned release', wireM2('', 1), { Owner: nextOwner }],
  ['owned recover', wireM2('', 1, 'operator-recovery'), { Owner: nextOwner }],
  ['release recovery tag', wireM2('', 1, 'operator-recovery'), { Operation: 'release' }],
  ['recover clean tag', wireM2('', 1), { Operation: 'recover' }],
  ['release invocation', wireM2('', 1), { Invocation: nextOwner }], ['release plan', wireM2('', 1), { Plan: 'e'.repeat(64) }],
  ['recover invocation', wireM2('', 1, 'operator-recovery'), { Invocation: nextOwner }], ['recover plan', wireM2('', 1, 'operator-recovery'), { Plan: 'e'.repeat(64) }],
  ['barrier missing exit', wireM2('', 1), { Operation: 'barrier', Exit: '' }], ['barrier stale exit', wireM2('', 1), { Operation: 'barrier', Epoch: '2' }],
  ['mixed fields', wireM2(), { Release: '', 'Release@odata.type': 'Edm.Binary' }], ['v1 digest domain', wireM2(), { InitDigest: wireM().InitDigest }],
  ['epoch overflow', wireM2('', 1), { Epoch: '9007199254740992' }], ['epoch zero lexeme', wireM2(), { Epoch: '00' }],
  ['epoch exponent', wireM2('', 1), { Epoch: '1e0' }], ['epoch fractional', wireM2('', 1), { Epoch: '1.0' }],
];
for (const [name, original, change] of badShapes) test(`V2 rejects digest-valid lifecycle: ${name}`, () => rejects(changedM2(original, change)));
for (const kind of ['clean-release', 'operator-recovery'] as const) {
  const receipt = exitFixture(kind); const canonical = JSON.stringify(receipt);
  const invalid = [
    '', '[]', 'null', 'true', '{}', JSON.stringify({ ...receipt, kind: 'release' }), JSON.stringify({ ...receipt, extra: true }),
    JSON.stringify({ ...receipt, oldOwner: 'bad' }),
    JSON.stringify({ ...receipt, oldEpoch: 0 }), JSON.stringify({ ...receipt, invocation: 'bad' }), JSON.stringify({ ...receipt, planDigest: 'A'.repeat(64) }),
    canonical.replace('"oldEpoch":1', '"oldEpoch":1.0'), canonical.replace('"oldEpoch":1', '"oldEpoch":1e0'),
    canonical.replace('"oldEpoch":1', '"oldEpoch":-0'), canonical.replace('"oldEpoch":1', '"oldEpoch":9007199254740993'),
    '{ ' + canonical.slice(1), canonical + '\n', '{"kind":"' + kind + '",' + canonical.slice(1),
    JSON.stringify(Object.fromEntries(Object.entries(receipt).reverse())), '\ufeff' + canonical,
    ...Object.keys(receipt).map(key => JSON.stringify(Object.fromEntries(Object.entries(receipt).filter(([k]) => k !== key)))),
  ];
  for (const [i, text] of invalid.entries()) test(`V2 rejects ${kind} noncanonical/closed Exit ${i}`, () => rejects(changedM2(wireM2('', 1, kind), { Exit: Buffer.from(text).toString('base64') })));
  for (const field of ['originalMDigest', 'domainDispositionDigest', 'operatorAttestationDigest']) test(`V2 ${kind} rejects invalid ${field}`, () => {
    rejects(changedM2(wireM2('', 1, kind), { Exit: Buffer.from(JSON.stringify({ ...receipt, [field]: 'Z'.repeat(64) })).toString('base64') }));
  });
}
for (const [i, change] of [
  { Timestamp: undefined }, { Timestamp: '2026-02-30T00:00:00Z' }, { 'Timestamp@odata.type': 'Edm.String' },
  { 'odata.etag': undefined }, { 'odata.etag': '*' }, { PartitionKey: 'other' }, { Binding: '' }, { 'Binding@odata.type': undefined },
  { Exit: 'eA' }, { Exit: Buffer.alloc(1025).toString('base64') }, { Exit: Buffer.from([0xff]).toString('base64') },
  { 'Exit@odata.type': 'Edm.String' }, { 'Exit@odata.type': undefined }, { State: Buffer.alloc(65537).toString('base64') },
  { Result: Buffer.alloc(65537).toString('base64') }, { 'Epoch@odata.type': undefined }, { V: 3 }, { V: '2' }, { 'V@odata.type': 'Edm.Double' },
  { extra: true }, { ['__proto__']: 'bad' }, { constructor: 'bad' },
].entries()) test(`V2 rejects raw boundary ${i}`, () => rejects({ ...changedM2(wireM2(), change), ...change }));
test('V2 rejects duplicate outer fields, number lexemes and header ETag mismatch', () => {
  const text = JSON.stringify(stamp(wireM2(), 1));
  for (const raw of ['{"V":2,' + text.slice(1), text.replace('"V":2', '"V":2.0'), text.replace('"V":2', '"V":2e0')]) {
    assert.throws(() => decodeRecord(binding, Buffer.from(raw)), corrupt);
    assert.throws(() => decodePage(binding, Buffer.from('{"value":[' + raw + ']}')), corrupt);
  }
  assert.throws(() => decodeRecord(binding, Buffer.from(text), 'M', 'W/"other"'), corrupt);
});
test('fixed independent V1 and V2 checksum/encoder vectors retain their exact formats', () => {
  assert.equal(codec.initializationDigest(binding, initId), '00ebcdb2cf17e37d1e1879ec6298af9f27be8e28eb665a9357f37012bb6bbe46');
  assert.equal(codec.initializationDigestV2(binding, initId), 'b845f9386509eae424176db4aca1068427141d895ea6ab481e52b8e075995dd7');
  assert.equal(codec.decodeRecord(binding, Buffer.from(JSON.stringify(stamp(wireM(), 1)))).value.digest, '7c812b60964f53913e321f5ff2fdf1313e59858296ca63562f85ef1728c57040');
  assert.equal(decode(stamp(wireM2(), 1)).value.digest, 'abe2d2771738bda45d8ee6d577a905da3907ee203571251e3aa042ab784b27ec');
  for (const [kind, length, receiptDigest, metadataDigest] of [
    ['clean-release', 219, '7efb486a15af7888e5e4abb6398b7cb2cdc9eabd8129571ba89ef45f47ed375b', 'd0d0a192231cf565e2608b7a5e30a375ee2f8c165852356d9121f398422cce7d'],
    ['operator-recovery', 496, '5c28d79578361e0081b623f9a9ccf08dd112fdd7acb1bc397f706d3fc6528f97', 'eeea8e185d0f126aeaac135b44ec7e4eda28a74658b73ddb3fb3f09bb8decc02'],
  ] as const) {
    const receipt = exitFixture(kind) as ExitReceipt; const raw = wireM2('', 1, kind); const value = decode(stamp(raw, 1)).value;
    assert.equal(value.digest, metadataDigest); assert.equal(value.kind, 'metadata');
    const exit = codec.encodeExit(receipt); assert.equal(exit.length, length); assert.equal(exit.toString(), JSON.stringify(receipt));
    assert.equal(createHash('sha256').update(exit).digest('hex'), receiptDigest); assert.deepEqual(codec.decodeExit(exit), receipt);
    if (value.kind !== 'metadata') throw new Error('Expected metadata');
    assert.deepEqual(value.exit, receipt); assert.equal('release' in value, false);
    const expected = { partitionKey: raw.PartitionKey, rowKey: 'M', V: 2, Digest: metadataDigest, Binding: { type: 'Binary', value: raw.Binding }, InitId: initId,
      InitDigest: raw.InitDigest, Owner: '', Epoch: { type: 'Int64', value: '1' }, Invocation: invocation, Operation: raw.Operation, Plan: raw.Plan,
      State: { type: 'Binary', value: '' }, Result: { type: 'Binary', value: '' }, Exit: { type: 'Binary', value: raw.Exit } };
    assert.deepEqual(codec.encodeRecordV2(binding, value), expected);
    assert.equal(codec.metadataV2(binding, value).digest, metadataDigest);
  }
  const release = Buffer.from(JSON.stringify([oldOwner, 1, invocation, 'a'.repeat(64)]));
  assert.equal(release.length, 148); assert.equal(createHash('sha256').update(release).digest('hex'), '4dd12635f7c773617b6ab839fd89a4e4ca6995158246cd85ef8777caa5589119');
  const m = codec.metadata(binding, { initId, initDigest: codec.initializationDigest(binding, initId), owner: '', epoch: 1, invocation,
    operation: 'release', plan: 'a'.repeat(64), state: Buffer.alloc(0), result: Buffer.alloc(0), release });
  assert.equal(m.digest, 'b8949357ed067566ba3a5867688d50bbd234df7d97d5e0825f6a5a6b32d9381a');
  const encoded = codec.encodeRecord(binding, m); assert.equal(encoded.V, 1); assert.equal('Exit' in encoded, false);
  assert.deepEqual(encoded.Release, { type: 'Binary', value: release.toString('base64') });
});
test('V2 data codec uses independent V1 envelope and rejects a data-version fork', () => {
  const raw = { PartitionKey: binding.partition, RowKey: 'delivery_aXRlbQ', V: 1, T: 'delivery', Id: 'item', Length: 5, Count: 1,
    B0: 'aGVsbG8=', 'B0@odata.type': 'Edm.Binary', Digest: hash(['orka-data-v1', boundBytes.toString('base64'), 'delivery', 'item', 'aGVsbG8=']) };
  const decoded = decode(stamp(raw, 1)); assert.equal(decoded.value.kind === 'data' && decoded.value.payload.toString(), 'hello');
  assert.deepEqual(codec.encodeRecordV2(binding, decoded.value), { partitionKey: binding.partition, rowKey: raw.RowKey, V: 1, Digest: raw.Digest,
    T: 'delivery', Id: 'item', Length: 5, Count: 1, B0: { type: 'Binary', value: 'aGVsbG8=' } });
  rejects(stamp({ ...raw, V: 2 }, 1));
});
test('V2 direct-object and Exit boundaries reject prototypes/accessors without invoking them', () => {
  let calls = 0; const raw = stamp(wireM2(), 1); const receipt = exitFixture();
  for (const value of [Object.assign(Object.create({ inherited: true }), raw), { ...raw, get Exit() { calls++; return ''; } },
    Object.defineProperty({ ...raw }, 'hidden', { value: true }), { ...raw, [Symbol('extra')]: true }]) {
    assert.throws(() => codec.decodeObjectV2(binding, value), corrupt);
  }
  for (const value of [Object.assign(Object.create({ inherited: true }), receipt), { ...receipt, get oldOwner() { calls++; return oldOwner; } },
    Object.defineProperty({ ...receipt }, 'hidden', { value: true }), { ...receipt, [Symbol('extra')]: true }]) {
    assert.throws(() => codec.encodeExit(value as ExitReceipt));
  }
  assert.equal(calls, 0);
  assert.equal(codec.decodeObjectV2(binding, Object.assign(Object.create(null), raw)).value.kind, 'metadata');
  for (const field of ['PartitionKey', 'RowKey', 'V', 'Digest', 'Binding', 'InitId', 'InitDigest', 'Owner', 'Epoch', 'Invocation', 'Operation', 'Plan', 'State', 'Result', 'Exit',
    'Timestamp', 'odata.etag', 'Binding@odata.type', 'Epoch@odata.type', 'State@odata.type', 'Result@odata.type', 'Exit@odata.type']) rejects({ ...raw, [field]: undefined });
});
// Compile-time compatibility: no fabricated V1 release or recovery operation can
// escape the V1 API, while V2 planner/records expose the tagged Exit union.
function publicTypes(v1: Metadata, v2: MetadataV2, r1: StoredRecord, r2: StoredRecordV2, p1: Planner, p2: PlannerV2): void {
  // @ts-expect-error A V2 client requires an explicit runtime format, not a generic-only opt-in.
  new OwnedTableClient<2>(binding, { token: async () => '' });
  const legacyClient = new OwnedTableClient(binding, { token: async () => '' });
  // @ts-expect-error Default V1 client write metadata remains V1-only.
  legacyClient.write(v2, undefined, [], { signal: new AbortController().signal, deadline: 1 });
  const release: Buffer = v1.release; void release;
  const exit: ExitReceipt | undefined = v2.exit; void exit;
  // @ts-expect-error V1 has no recovery operation.
  v1.operation = 'recover';
  // @ts-expect-error V2 does not fabricate a release Buffer.
  const fake: Buffer = v2.release; void fake;
  // @ts-expect-error V2 records are not V1 records.
  r1 = r2;
  // @ts-expect-error V2 planner is not the V1 planner.
  p1 = p2;
  void r1; void p1;
}
void publicTypes;
