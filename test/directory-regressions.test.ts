import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { bindingName, directoryKey, encodeEntity, parseCanonicalJSON } from '../src/directory/codec.js';
import { validateDirectoryImport } from '../src/directory/import.js';
import { openDirectory } from '../src/directory/store.js';
import { createDirectoryTable } from '../src/directory/table.js';
import type { ControlRecord } from '../src/directory/types.js';
import { snapshotRegistry } from '../src/registry/config.js';
import { binding, context, deferred, directoryFixture, eventually, key, sample } from './support/directory-table.js';
import { registryInput } from './support/registry.js';

test('native timeout retains the original deadline when caller context is reused', async t => {
  const f = await directoryFixture(t); f.controls.hook = () => {};
  const table = createDirectoryTable(binding, f.dependencies); t.after(() => table.close());
  const ctx = context(100); const result = table.get({ kind: 'conn', conversationId: 'held' }, ctx).then(() => 'success', () => 'aborted');
  await eventually(() => f.stats.requests === 1); ctx.deadline = performance.now() + 60000;
  let timer: ReturnType<typeof setTimeout>;
  try { assert.equal(await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve('overdue'), 500); })]), 'aborted'); }
  finally { clearTimeout(timer!); }
  assert.equal(f.stats.socketCloses, 1);
});

test('Table read fallback and conditional write retain their original request keys', async t => {
  const f = await directoryFixture(t); const scope = { appId: binding.appId, tenantId: binding.tenantId };
  const other = { ...sample(), conversationId: 'other-chat', bindingName: bindingName(scope, 'other-chat', 'a'.repeat(64)) };
  const otherKey = { kind: 'conn' as const, conversationId: other.conversationId }; const otherRow = encodeEntity(scope, otherKey, other);
  f.rows.set(String(otherRow.RowKey), { ...otherRow, Timestamp: '2026-01-01T00:00:00Z', 'odata.etag': '"other"' });
  const table = createDirectoryTable(binding, f.dependencies); t.after(() => table.close()); const gate = deferred(); let waiting = false;
  f.controls.hook = async ({ url, res, reply }) => {
    if (url.pathname !== '/Directory()') { waiting = true; await gate.promise; res.writeHead(404, { 'x-ms-error-code': 'ResourceNotFound' }); res.end(); }
    else reply();
  };
  const requested = { ...key }; const pending = table.get(requested, context()); await eventually(() => waiting);
  requested.conversationId = other.conversationId; gate.resolve(); assert.equal(await pending, undefined);
  delete f.controls.hook; await table.insert(key, sample(), context()); const saved = await table.get(key, context());
  const replaceKey = { ...key }; const replacing = table.replace(replaceKey, saved!.etag, sample(), context()); replaceKey.conversationId = other.conversationId;
  await replacing;
  assert.ok(f.requests.at(-1)?.url.pathname.includes(`RowKey='${directoryKey(scope, key).row}'`));
});

test('startup recovers multiple pages of large valid discovery receipts without an oversized response', async t => {
  const f = await directoryFixture(t); const scope = { appId: binding.appId, tenantId: binding.tenantId };
  for (let i = 0; i < 60; i++) {
    const value: ControlRecord = { schema: 1, kind: 'control', scope, conversationId: 'chat', chatKind: 'personal', activityId: `activity-${i}`,
      fingerprint: 'a'.repeat(64), currentTargetDigest: null, desiredTargetDigest: null, state: 'armed', ownerUUID: randomUUID(), attemptUUID: randomUUID(),
      route: { serviceUrl: 'https://service.example.invalid/', channelId: 'msteams', bot: { id: 'bot', role: 'bot' },
        conversation: { id: 'chat', tenantId: binding.tenantId, conversationType: 'personal' } },
      reply: { kind: 'discovery', targets: Array.from({ length: 32 }, (_, n) => ({ id: `target-${n}`, label: 'x'.repeat(256) })) } };
    const row = encodeEntity(scope, { kind: 'control', conversationId: 'chat', activityId: value.activityId }, value);
    f.rows.set(String(row.RowKey), { ...row, Timestamp: '2026-01-01T00:00:00Z', 'odata.etag': `"${i}"` });
  }
  const directory = await openDirectory(createDirectoryTable(binding, f.dependencies), context());
  assert.equal(f.rows.size, 60);
  for (const row of f.rows.values()) assert.equal(JSON.parse(Buffer.from(String(row.Payload), 'base64').toString()).state, 'unknown');
  assert.ok(f.requests.filter(r => r.url.pathname === '/Directory()').length > 1); await directory.close();
});

test('whole-export parser accepts valid sender arrays within the file size without weakening record parsing', () => {
  const registry = snapshotRegistry(registryInput()); const target = registry.targets[0]!;
  const connections = Array.from({ length: 180 }, (_, i) => ({ appId: target.config.scope.appId, tenantId: target.config.scope.tenantId,
    conversationId: `chat-${i}`, chatKind: 'personal', targetId: target.id, identityDigest: target.identityDigest, importId: 'export',
    binding: { namespace: target.config.scope.gatewayNamespace, name: `binding-${i}`, uid: `uid-${i}`, generation: 1,
      spec: { gatewayRef: { name: target.config.scope.gatewayName }, agentRef: { name: target.frontAgent.name },
        match: { accountId: target.config.scope.tenantId, contextId: `chat-${i}` },
        senderPolicy: { mode: 'allowlist', allowedSenderIds: Array.from({ length: 100 }, (_, n) => String(n)) } } } }));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, connections })); assert.ok(bytes.length < 256 * 1024);
  assert.throws(() => parseCanonicalJSON(bytes), { code: 'corrupt' });
  assert.equal(validateDirectoryImport(parseCanonicalJSON(bytes, 131072), registry).length, 180);
});
