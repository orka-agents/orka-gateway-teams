import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as codec from '../src/directory/codec.js';
import type { ConnectionRecord, ControlRecord } from '../src/directory/types.js';

export const scope = { appId: 'app', tenantId: 'tenant' };
export const connKey = { kind: 'conn' as const, conversationId: 'chat;messageid=exact' };
export function connection(): ConnectionRecord {
  return { schema: 1, kind: 'conn', scope, conversationId: connKey.conversationId, chatKind: 'personal',
    targetId: 'tools', identityDigest: 'a'.repeat(64), bindingName: codec.bindingName(scope, connKey.conversationId, 'a'.repeat(64)),
    lineage: { kind: 'provisioner' }, state: 'reserved' };
}
export function control(): ControlRecord {
  return { schema: 1, kind: 'control', scope, conversationId: connKey.conversationId, chatKind: 'personal', activityId: 'activity',
    fingerprint: codec.textDigest('use tools'), currentTargetDigest: null, desiredTargetDigest: 'a'.repeat(64),
    route: { serviceUrl: 'https://smba.trafficmanager.net/teams/', channelId: 'msteams', bot: { id: 'bot', role: 'bot' },
      conversation: { id: connKey.conversationId, tenantId: 'tenant', conversationType: 'personal' } },
    reply: { kind: 'connected', targetId: 'tools', label: 'Tools' }, state: 'ready' };
}

test('use command reserves only an exact whole ASCII command after outer trim', () => {
  assert.equal(codec.parseUseCommand('  use tools  '), 'tools');
  for (const text of ['Use tools', 'use\ttools', 'use  tools', 'use tools again', 'use tools\nmore', 'use é', 'use A', 'use -a', 'use '+ 'a'.repeat(64)]) assert.equal(codec.parseUseCommand(text), undefined);
});
test('control fingerprint binds exact sender, text, desired target and authenticated event scope', () => {
  const fingerprint = codec.controlFingerprint(scope, 'chat', 'activity', 'sender', 'use tools', 'a'.repeat(64));
  assert.equal(fingerprint, createHash('sha256').update(JSON.stringify(['teams-control-fingerprint-v1', 'app', 'tenant', 'chat', 'activity', 'sender', 'use tools', 'a'.repeat(64)])).digest('hex'));
  for (const [s, conversation, activity, sender, text, desired] of [
    [{ ...scope, appId: 'other' }, 'chat', 'activity', 'sender', 'use tools', 'a'.repeat(64)],
    [{ ...scope, tenantId: 'other' }, 'chat', 'activity', 'sender', 'use tools', 'a'.repeat(64)],
    [scope, 'chat-other', 'activity', 'sender', 'use tools', 'a'.repeat(64)],
    [scope, 'chat', 'activity-other', 'sender', 'use tools', 'a'.repeat(64)],
    [scope, 'chat', 'activity', 'other', 'use tools', 'a'.repeat(64)],
    [scope, 'chat', 'activity', 'sender', 'use tools ', 'a'.repeat(64)],
    [scope, 'chat', 'activity', 'sender', 'use tools', 'b'.repeat(64)],
    [scope, 'chat', 'activity', 'sender', 'use tools', null],
  ] as const) assert.notEqual(codec.controlFingerprint(s, conversation, activity, sender, text, desired), fingerprint);
  assert.doesNotThrow(() => codec.controlFingerprint(scope, 'chat', 'activity', 'sender', 'line1\nline2\tline3', null));
  assert.throws(() => codec.controlFingerprint(scope, 'chat', 'activity', '', 'use tools', null));
  assert.throws(() => codec.controlFingerprint(scope, 'chat', 'activity', 'sender', 'x'.repeat(65537), null));
  assert.throws(() => codec.controlFingerprint(scope, 'chat', 'activity', 'sender', '\u0001', null));
});
test('keys isolate exact app tenant conversation and conn/control activity', () => {
  const key = codec.directoryKey(scope, connKey);
  for (const other of [{ ...scope, appId: 'App' }, { ...scope, tenantId: 'other' }]) assert.notDeepEqual(codec.directoryKey(other, connKey), key);
  assert.notDeepEqual(codec.directoryKey(scope, { ...connKey, conversationId: 'chat' }), key);
  assert.notDeepEqual(codec.directoryKey(scope, { kind: 'control', conversationId: connKey.conversationId, activityId: 'a' }), key);
  assert.notEqual(codec.bindingName(scope, 'chat', 'a'.repeat(64)), codec.bindingName(scope, 'chat', 'b'.repeat(64)));
  assert.match(connection().bindingName, /^teams-[a-f0-9]{56}$/);
});
test('canonical import JSON rejects duplicates and unsafe magnitudes without changing Unicode', () => {
  assert.equal(codec.canonicalJSON(codec.parseCanonicalJSON(Buffer.from('{"z":-2,"a":{"é":"é"}}'))), '{"a":{"é":"é"},"z":-2}');
  for (const json of ['{"x":1,"\\u0078":2}', '9007199254740992', '1e309', '-1e309', '-9007199254740992', '['.repeat(25)+'0'+']'.repeat(25), '['+'0,'.repeat(16384)+'0]', '"\\ud800"']) assert.throws(() => codec.parseCanonicalJSON(Buffer.from(json)));
  assert.throws(() => codec.parseCanonicalJSON(Buffer.from([0xff])));
  assert.equal(codec.textDigest(' use tools '), createHash('sha256').update(' use tools ').digest('hex'));
  assert.notEqual(codec.textDigest(' use tools '), codec.textDigest('use tools'));
});
test('control routes use the established canonical Teams HTTPS service base and exact bounded identities', () => {
  for (const serviceUrl of ['https://smba.trafficmanager.net:444/teams/', 'https://smba.trafficmanager.net/teams', 'https://SMBA.trafficmanager.net/teams/', 'https://smba.trafficmanager.net:443/teams/', 'https://user@smba.trafficmanager.net/teams/', 'https://smba.trafficmanager.net/teams/?q=1']) {
    assert.throws(() => codec.encodeRecord({ ...control(), route: { ...control().route, serviceUrl } }));
  }
  for (const bad of [' app', 'app ', 'app\u00a0', 'a'.repeat(257)]) {
    assert.throws(() => codec.encodeRecord({ ...connection(), scope: { ...scope, appId: bad } }));
    assert.throws(() => codec.directoryKey(scope, { kind: 'conn', conversationId: bad }));
  }
  assert.throws(() => codec.controlFingerprint(scope, 'chat', 'activity', ' sender', 'use tools', null));
  assert.throws(() => codec.controlFingerprint(scope, 'chat', 'activity', 'sender', ' \t\n', null));
});
test('canonical parsing and serialization share the 16384 value-node budget', () => {
  const json = '{'+Array.from({ length: 9000 }, (_, i) => `"k${i}":0`).join(',')+'}';
  assert.equal(Object.keys(codec.parseCanonicalJSON(Buffer.from(json)) as object).length, 9000);
  assert.doesNotThrow(() => codec.canonicalJSON(codec.parseCanonicalJSON(Buffer.from(json))));
});
test('closed records round trip canonical payloads and reject hidden durable data', () => {
  for (const value of [connection(), control()]) {
    const encoded = codec.encodeRecord(value); assert.deepEqual(codec.decodeRecord(encoded), value);
    for (const field of ['text', 'token', 'groups', 'targetUrl']) assert.throws(() => codec.encodeRecord({ ...value, [field]: 'private' } as never));
  }
  assert.throws(() => codec.encodeRecord({ ...control(), route: { ...control().route, requester: { id: 'person' } } } as never));
  assert.throws(() => codec.encodeRecord({ ...connection(), bindingName: 'random' }));
  assert.throws(() => codec.encodeRecord({ ...control(), state: 'armed' } as never));
  const armed = { ...control(), state: 'armed' as const, ownerUUID: '11111111-1111-4111-8111-111111111111', attemptUUID: '22222222-2222-4222-8222-222222222222' };
  assert.deepEqual(codec.decodeRecord(codec.encodeRecord(armed)), armed);
});
test('imported lineage preserves the entire Binding spec including legitimate fractional retry backoff', () => {
  const imported = { ...connection(), state: 'provisioned' as const, bindingName: 'existing', lineage: { kind: 'imported' as const, importId: 'reviewed-export' },
    binding: { namespace: 'gateway', name: 'existing', uid: 'uid', generation: 3, spec: { priority: -4, senderPolicy: { mode: 'allow', senders: ['exact'] }, taskDefaults: { retryPolicy: { backoffMultiplier: 1.5 } } } } };
  assert.deepEqual(codec.decodeRecord(codec.encodeRecord(imported)), imported);
  assert.equal(codec.canonicalJSON(codec.parseCanonicalJSON(Buffer.from('{"backoffMultiplier":15e-1,"retry":1E+2}'))), '{"backoffMultiplier":1.5,"retry":100}');
  for (const n of [Infinity, NaN, -Infinity, Number.MAX_SAFE_INTEGER+1]) assert.throws(() => codec.canonicalJSON(n));
  assert.throws(() => codec.encodeRecord({ ...imported, binding: { ...imported.binding, generation: 0 } }));
  assert.throws(() => codec.encodeRecord({ ...imported, binding: { ...imported.binding, spec: { value: 'x'.repeat(48*1024) } } }));
  assert.throws(() => codec.encodeRecord({ ...connection(), state: 'provisioned' } as never));
});
test('store-facing snapshot and key helpers detach records and retain both key forms', () => {
  const value = connection(); const copy = codec.snapshotDirectoryRecord(value);
  assert.deepEqual(copy, value); assert.notEqual(copy, value); assert.notEqual(copy.scope, value.scope);
  assert.deepEqual(codec.recordKey(value), connKey);
});
test('Table rows require exact identity, digest, Armed, ETag and Timestamp', () => {
  const value = connection(); const key = codec.directoryKey(scope, connKey);
  const row = { ...codec.encodeEntity(scope, connKey, value), Timestamp: '2026-11-11T00:00:00Z', 'odata.etag': 'W/"exact"' };
  assert.deepEqual(codec.decodeEntity(scope, row, connKey).value, value);
  for (const bad of [{ ...row, Armed: true }, { ...row, Digest: 'b'.repeat(64) }, { ...row, Extra: 'secret' }, { ...row, RowKey: 'control_'+'a'.repeat(64) }, { ...row, 'Payload@odata.type': 'Edm.String' }, { ...row, PartitionKey: key.partition+'x' }, { ...row, Timestamp: undefined }, { ...row, 'odata.etag': undefined }]) assert.throws(() => codec.decodeEntity(scope, bad, connKey));
  assert.throws(() => codec.decodeEntity(scope, row, connKey, '"different"'));
  assert.throws(() => codec.encodeRecord({ ...control(), reply: { kind: 'discovery', targets: [{ id: 'tools', label: 'a'.repeat(49000) }] } }));
});
