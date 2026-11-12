import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { bindingName } from '../src/directory/codec.js';
import { openDirectory } from '../src/directory/store.js';
import type { ConnectionRecord, ControlRecord, DirectoryContext } from '../src/directory/types.js';
import { memoryDirectoryTable } from './support/directory-memory.js';

const scope = { appId: 'app-a', tenantId: 'tenant-a' };
const context = (): DirectoryContext => ({ signal: new AbortController().signal, deadline: performance.now() + 10000 });
const connection = (targetId = 'tools'): ConnectionRecord => ({ schema: 1, kind: 'conn', scope, conversationId: 'chat-a', chatKind: 'personal',
  targetId, identityDigest: 'a'.repeat(64), bindingName: bindingName(scope, 'chat-a', 'a'.repeat(64)), state: 'reserved' });
const control = (): ControlRecord => ({ schema: 1, kind: 'control', scope, conversationId: 'chat-a', chatKind: 'personal', activityId: 'activity-a',
  fingerprint: 'b'.repeat(64), currentTargetDigest: null, desiredTargetDigest: null,
  route: { serviceUrl: 'https://service.example.invalid/', channelId: 'msteams', bot: { id: 'bot-a', role: 'bot' },
    conversation: { id: 'chat-a', tenantId: 'tenant-a', conversationType: 'personal' } }, reply: { kind: 'no-access' }, state: 'ready' });

// A check-then-overwrite implementation would lose the permanent first choice.
test('competing targets have one permanent winner; same-target resumes without reassignment', async () => {
  const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, context());
  const results = await Promise.allSettled([directory.reserveConnection(connection(), context()), directory.reserveConnection(connection('platform'), context())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const saved = await directory.getConnection('chat-a', context()); assert.equal(saved?.targetId, 'tools');
  assert.deepEqual(await directory.reserveConnection(connection(), context()), saved);
  await assert.rejects(directory.reserveConnection({ ...connection(), identityDigest: 'c'.repeat(64), bindingName: bindingName(scope, 'chat-a', 'c'.repeat(64)) }, context()), { code: 'conflict' });
  await directory.close();
});

test('connection lost ACK is resolved by saved truth; successful empty ACK is not truth', async () => {
  const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, context());
  f.mode('lost'); assert.equal((await directory.reserveConnection(connection(), context())).targetId, 'tools');
  f.mode('lie'); await assert.rejects(directory.reserveConnection({ ...connection(), conversationId: 'chat-b', bindingName: bindingName(scope, 'chat-b', 'a'.repeat(64)) }, context()), { code: 'unavailable' });
  await directory.close();
});

test('provisioning is monotonic and refuses changed Binding evidence', async () => {
  const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, context());
  const reserved = await directory.reserveConnection(connection(), context());
  const binding = { namespace: 'gateway', name: reserved.bindingName, uid: 'uid-a', generation: 1,
    spec: { gatewayRef: { name: 'gateway-a' }, match: { accountId: 'tenant-a', contextId: 'chat-a' } } };
  const done = await directory.markProvisioned(reserved, binding, context()); assert.equal(done.state, 'provisioned');
  assert.deepEqual(await directory.markProvisioned(reserved, binding, context()), done);
  await assert.rejects(directory.markProvisioned(reserved, { ...binding, uid: 'uid-b' }, context()), { code: 'conflict' });
  assert.equal((await directory.reserveConnection(connection(), context())).state, 'provisioned'); await directory.close();
});

test('control receipt before connection deduplicates identity and rejects altered input/target', async () => {
  const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, context()); const input = control();
  assert.deepEqual(await directory.reserveControl(input, context()), input);
  assert.equal(await directory.getConnection('chat-a', context()), undefined);
  assert.deepEqual(await directory.reserveControl(input, context()), input);
  for (const changed of [{ fingerprint: 'c'.repeat(64) }, { desiredTargetDigest: 'd'.repeat(64) }]) {
    await assert.rejects(directory.reserveControl({ ...input, ...changed }, context()), { code: 'conflict' });
  }
  await directory.close();
});

test('duplicate receipts preserve original observations without granting current send authority', async () => {
  const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, context());
  const input: ControlRecord = { ...control(), desiredTargetDigest: 'a'.repeat(64), reply: { kind: 'connected', targetId: 'tools', label: 'Tools' } };
  await directory.reserveControl(input, context());
  const saved = await directory.reserveControl({ ...input, currentTargetDigest: 'a'.repeat(64),
    reply: { kind: 'connected', targetId: 'tools', label: 'Renamed tools' }, route: { ...input.route, serviceUrl: 'https://current.example.invalid/' } }, context());
  assert.deepEqual(saved, input); assert.equal(f.writes(), 1);
  const key = { kind: 'control' as const, conversationId: input.conversationId, activityId: input.activityId };
  await assert.rejects(directory.armControl(key, { ...context(), authorizeWrite: () => false }), { code: 'unready' });
  assert.equal((await directory.getControl(key, context()))?.state, 'ready'); await directory.close();
});

test('control attempt fencing allows only proved no-effect retry and preserves terminal outcomes', async () => {
  const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, context()); const input = control();
  await directory.reserveControl(input, context()); const key = { kind: 'control' as const, conversationId: input.conversationId, activityId: input.activityId };
  const first = await directory.armControl(key, context()); assert.equal(first.state, 'armed');
  await assert.rejects(directory.armControl(key, context()), { code: 'conflict' });
  await assert.rejects(directory.settleControl(key, randomUUID(), { kind: 'delivered', providerMessageId: 'message-a' }, context()), { code: 'conflict' });
  assert.equal((await directory.settleControl(key, first.attemptUUID, { kind: 'no-effect' }, context())).state, 'ready');
  const second = await directory.armControl(key, context()); assert.notEqual(second.attemptUUID, first.attemptUUID);
  assert.equal((await directory.settleControl(key, second.attemptUUID, { kind: 'delivered', providerMessageId: 'message-a' }, context())).state, 'delivered');
  await assert.rejects(directory.settleControl(key, first.attemptUUID, { kind: 'unknown' }, context()), { code: 'conflict' });
  await assert.rejects(directory.armControl(key, context()), { code: 'conflict' }); await directory.close();
});

test('settlement snapshots the outcome before awaiting storage so unknown cannot become ready', async () => {
  const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, context()); await directory.reserveControl(control(), context());
  const key = { kind: 'control' as const, conversationId: 'chat-a', activityId: 'activity-a' }; const armed = await directory.armControl(key, context());
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const get = f.table.get;
  f.table.get = async (...args) => { await gate; return get(...args); };
  const outcome: { kind: 'unknown' | 'no-effect' } = { kind: 'unknown' };
  const settling = directory.settleControl(key, armed.attemptUUID, outcome, context()); outcome.kind = 'no-effect'; release();
  assert.equal((await settling).state, 'unknown');
  await assert.rejects(directory.armControl(key, context()), { code: 'conflict' }); await directory.close();
});

test('successor retires inherited arms and late old receipts cannot reverse unknown', async () => {
  const f = memoryDirectoryTable(); const old = await openDirectory(f.table, context()); const input = control();
  await old.reserveControl(input, context()); const key = { kind: 'control' as const, conversationId: 'chat-a', activityId: 'activity-a' };
  const attempt = await old.armControl(key, context()); const successor = await openDirectory(f.table, context());
  assert.equal((await successor.getControl(key, context()))?.state, 'unknown');
  await assert.rejects(old.settleControl(key, attempt.attemptUUID, { kind: 'delivered', providerMessageId: 'late' }, context()), { code: 'conflict' });
  await assert.rejects(successor.armControl(key, context()), { code: 'conflict' }); await old.close(); await successor.close();
});

test('a foreign arm arriving after opening is also terminal unknown', async () => {
  const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, context());
  const key = { kind: 'control' as const, conversationId: 'chat-a', activityId: 'activity-a' };
  f.save(key, { ...control(), state: 'armed', ownerUUID: randomUUID(), attemptUUID: randomUUID() });
  assert.equal((await directory.getControl(key, context()))?.state, 'unknown');
  await assert.rejects(directory.armControl(key, context()), { code: 'conflict' }); await directory.close();
});

test('failed recovery and false successful arm ACK grant no send authority', async () => {
  const broken = memoryDirectoryTable(); broken.failList(); await assert.rejects(openDirectory(broken.table, context()), { code: 'unready' });
  const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, context()); await directory.reserveControl(control(), context());
  f.mode('lie'); await assert.rejects(directory.armControl({ kind: 'control', conversationId: 'chat-a', activityId: 'activity-a' }, context()), { code: 'unavailable' });
  await directory.close();
});

test('lost authority after a write cannot publish an arm; subsequent startup recovers unknown', async () => {
  const f = memoryDirectoryTable(); let allowed = true;
  const directory = await openDirectory(f.table, context(), { allowed: () => allowed }); await directory.reserveControl(control(), context());
  const replace = f.table.replace; f.table.replace = async (...args) => { const result = await replace(...args); allowed = false; return result; };
  const key = { kind: 'control' as const, conversationId: 'chat-a', activityId: 'activity-a' };
  await assert.rejects(directory.armControl(key, context()), { code: 'unready' });
  f.table.replace = replace; const next = await openDirectory(f.table, context()); assert.equal((await next.getControl(key, context()))?.state, 'unknown');
  await directory.close(); await next.close();
});
