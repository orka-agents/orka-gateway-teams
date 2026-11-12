import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingName, controlFingerprint } from '../src/directory/codec.js';
import { openDirectory } from '../src/directory/store.js';
import { createDirectoryTable } from '../src/directory/table.js';
import { snapshotRegistry } from '../src/registry/config.js';
import { binding, context, directoryFixture, sample } from './support/directory-table.js';
import { registryInput } from './support/registry.js';

// State-machine tests alone cannot establish composition with real conditional Table I/O.
test('native directory provisions a reserved connection and recovers an uncertain no-access send across handles', async t => {
  const f = await directoryFixture(t); const registry = snapshotRegistry(registryInput()); const target = registry.targets[0]!;
  const scope = { appId: target.config.scope.appId, tenantId: target.config.scope.tenantId };
  const directory = await openDirectory(createDirectoryTable({ ...binding, ...scope }, f.dependencies), context());
  const connection = { ...sample(), scope, conversationId: 'native-chat', chatKind: 'groupChat' as const,
    targetId: target.id, identityDigest: target.identityDigest!, bindingName: bindingName(scope, 'native-chat', target.identityDigest!) };
  await directory.reserveConnection(connection, context());
  const evidence = { namespace: target.config.scope.gatewayNamespace, name: connection.bindingName,
    uid: 'provisioned-uid', generation: 1, spec: { gatewayRef: { name: target.config.scope.gatewayName },
      agentRef: { name: target.frontAgent.name }, match: { accountId: scope.tenantId, contextId: 'native-chat' },
      priority: 0, senderPolicy: { mode: 'all' }, session: { mode: 'context' } } };
  await directory.markProvisioned(connection, evidence, context());
  assert.deepEqual((await directory.getConnection('native-chat', context()))?.binding?.spec, evidence.spec);
  const key = { kind: 'control' as const, conversationId: 'native-chat', activityId: 'activity-a' };
  await directory.reserveControl({ schema: 1, kind: 'control', scope, conversationId: key.conversationId, activityId: key.activityId,
    chatKind: 'groupChat', fingerprint: controlFingerprint(scope, key.conversationId, key.activityId, 'sender-a', 'private input', null), currentTargetDigest: null, desiredTargetDigest: null,
    route: { serviceUrl: 'https://service.example.invalid/', channelId: 'msteams', bot: { id: 'bot', role: 'bot' },
      conversation: { id: key.conversationId, tenantId: scope.tenantId, conversationType: 'groupChat' } }, reply: { kind: 'no-access' }, state: 'ready' }, context());
  const contenders = await Promise.allSettled([directory.armControl(key, context()), directory.armControl(key, context())]);
  assert.equal(contenders.filter(r => r.status === 'fulfilled').length, 1);
  await directory.close();
  const successor = await openDirectory(createDirectoryTable({ ...binding, ...scope }, f.dependencies), context());
  assert.equal((await successor.getControl(key, context()))?.state, 'unknown');
  await assert.rejects(successor.armControl(key, context()), { code: 'conflict' });
  const payloads = [...f.rows.values()].map(row => Buffer.from(String(row.Payload), 'base64').toString());
  assert.ok(payloads.every(payload => !payload.includes('private input')));
  assert.equal((await successor.getConnection('native-chat', context()))?.binding?.uid, 'provisioned-uid');
  await successor.close(); assert.equal(f.stats.requestCloses, f.stats.sockets); assert.equal(f.stats.socketCloses, f.stats.sockets);
});

test('native store distinguishes a lying successful ACK from a committed write with lost ACK', async t => {
  const f = await directoryFixture(t); const directory = await openDirectory(createDirectoryTable(binding, f.dependencies), context());
  f.controls.hook = ({ req, res, reply }) => { if (req.method === 'POST') { res.writeHead(204); res.end(); } else reply(); };
  await assert.rejects(directory.reserveConnection(sample(), context()), { code: 'unavailable' });
  f.controls.hook = ({ req, res, body, reply }) => {
    if (req.method === 'POST') {
      f.rows.set(String(body!.RowKey), { ...body, Timestamp: '2026-11-11T00:00:00Z', 'odata.etag': 'W/"lost-ack"' }); res.destroy();
    } else reply();
  };
  const saved = await directory.reserveConnection(sample(), context()); assert.equal(saved.targetId, 'tools');
  assert.equal(saved.state, 'reserved'); await directory.close();
});
