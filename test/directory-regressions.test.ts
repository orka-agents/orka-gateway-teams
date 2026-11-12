import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { bindingName, directoryKey, encodeEntity } from '../src/directory/codec.js';
import { openDirectory } from '../src/directory/store.js';
import { createDirectoryTable } from '../src/directory/table.js';
import type { ControlRecord } from '../src/directory/types.js';
import { binding, context, deferred, directoryFixture, eventually, key, sample } from './support/directory-table.js';

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

function seedArms(f: Awaited<ReturnType<typeof directoryFixture>>, count: number) {
  const scope = { appId: binding.appId, tenantId: binding.tenantId };
  for (let i = 0; i < count; i++) {
    const value: ControlRecord = { schema: 1, kind: 'control', scope, conversationId: 'chat', chatKind: 'personal', activityId: `activity-${i}`,
      fingerprint: 'a'.repeat(64), currentTargetDigest: null, desiredTargetDigest: null, state: 'armed', ownerUUID: randomUUID(), attemptUUID: randomUUID(),
      route: { serviceUrl: 'https://service.example.invalid/', channelId: 'msteams', bot: { id: 'bot', role: 'bot' },
        conversation: { id: 'chat', tenantId: binding.tenantId, conversationType: 'personal' } }, reply: { kind: 'no-access' } };
    const row = encodeEntity(scope, { kind: 'control', conversationId: 'chat', activityId: value.activityId }, value);
    f.rows.set(String(row.RowKey), { ...row, Timestamp: '2026-01-01T00:00:00Z', 'odata.etag': `"${i}"` });
  }
}

test('bounded native recovery commits each page before a later failure so another opening progresses', async t => {
  const f = await directoryFixture(t); seedArms(f, 6);
  f.controls.hook = ({ url, res, reply }) => {
    if (url.pathname === '/Directory()' && url.searchParams.has('NextRowKey')) { res.writeHead(503); res.end(); } else reply();
  };
  await assert.rejects(openDirectory(createDirectoryTable(binding, f.dependencies), context()), { code: 'unready' });
  assert.equal([...f.rows.values()].filter(row => row.Armed === false).length, 4);
  delete f.controls.hook;
  const directory = await openDirectory(createDirectoryTable(binding, f.dependencies), context());
  assert.equal([...f.rows.values()].filter(row => row.Armed === false).length, 6); await directory.close();
});

for (const mode of ['cancel', 'authority'] as const) test(`native streaming recovery stops between pages on ${mode} loss`, async t => {
  const f = await directoryFixture(t); seedArms(f, 6); const abort = new AbortController(); let allowed = true;
  f.controls.hook = ({ url, reply }) => {
    if (url.pathname === '/Directory()' && url.searchParams.has('NextRowKey')) {
      if (mode === 'cancel') abort.abort(); else allowed = false;
    }
    reply();
  };
  await assert.rejects(openDirectory(createDirectoryTable(binding, f.dependencies), { ...context(), signal: abort.signal }, { allowed: () => allowed }), { code: 'unready' });
  assert.equal([...f.rows.values()].filter(row => row.Armed === false).length, 4);
  assert.equal(f.stats.requestCloses, f.stats.requests); assert.equal(f.stats.socketCloses, f.stats.sockets);
});

test('stream visitor is drained on close and cannot publish a late completed scan', async t => {
  const f = await directoryFixture(t); seedArms(f, 1); const gate = deferred(); let entered = false; let closed = false;
  const table = createDirectoryTable(binding, f.dependencies);
  const scan = table.list(context(), true, async () => { entered = true; await gate.promise; });
  const failure = assert.rejects(scan, { code: 'unavailable' });
  await eventually(() => entered); const stopping = table.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  gate.resolve(); await Promise.all([stopping, failure]);
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
