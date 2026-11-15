import assert from 'node:assert/strict';
import test from 'node:test';
import { grantReference, taskGrant } from '../src/accounts/grants.js';
import { binding, context } from './support/directory-table.js';

const epoch = 1_800_000_000_000;
const target = { id: 'tools', identityDigest: 'a'.repeat(64) };
const frozen = { namespaceUID: 'ns', gatewayUID: 'gateway', taskUID: 'task', tools: ['workiq'], deadline: epoch + 600_000 };
import { grantsFixture } from './support/task-grants.js';
test('grant reservation is encrypted, durable, immutable by sender/generation/routing/event and never relinks', async t => {
  const f = await grantsFixture(t); const grant = await f.store.reserveGrant(f.input, context());
  assert.deepEqual(grant, f.input);
  const writes = f.requests.filter(r => r.method !== 'GET').length;
  assert.deepEqual(await f.store.reserveGrant({ ...f.input, tools: ['workiq', 'workiq'] }, context()), grant);
  assert.equal(f.requests.filter(r => r.method !== 'GET').length, writes);
  for (const change of [{ objectId: 'other' }, { generation: 2 }, { targetId: 'other' }, { targetDigest: 'b'.repeat(64) }, { eventId: 'other' }]) {
    await assert.rejects(f.store.reserveGrant({ ...f.input, ...change }, context()), /conflict/);
  }
  const wire = JSON.stringify([...f.rows.values()]) + [...f.rows.values()].map(r => Buffer.from(String(r.Payload), 'base64').toString()).join('');
  for (const sentinel of ['sender-private', 'event-private', 'ACCESS-PRIVATE', 'REFRESH-PRIVATE']) assert.ok(!wire.includes(sentinel));
  await f.store.close(); const reopened = f.open();
  assert.deepEqual(await reopened.getGrant(f.input.ref, context()), grant);
  await reopened.disconnect(f.subject, context());
  assert.equal(await reopened.getGrant(f.input.ref, context()), undefined);
  await assert.rejects(reopened.reserveGrant({ ...f.input, generation: 2 }, context()), /conflict/);
});

test('redelivery candidates cannot replace the original grant or relink it after an account generation change', async t => {
  const f = await grantsFixture(t);
  const originalRef = grantReference(binding, target, f.input.eventId, 'original-reply-target');
  const candidateRef = grantReference(binding, target, f.input.eventId, 'redelivery-candidate');
  const original = { ...f.input, ref: originalRef };
  await f.store.reserveGrant(original, context());
  assert.deepEqual(await f.store.getGrant(originalRef, context()), original);
  await f.store.disconnect(f.subject, context()); await f.link('reconnect');
  const account = await f.store.inspect(f.subject, context()); assert.equal(account.generation, 2);
  await f.store.reserveGrant({ ...f.input, ref: candidateRef, generation: 2 }, context());
  assert.equal(await f.store.getGrant(originalRef, context()), undefined);
  assert.equal((await f.store.getGrant(candidateRef, context()))?.generation, 2);
  await assert.rejects(f.store.reserveGrant({ ...original, generation: 2 }, context()), /conflict/);
});

test('first binding freezes every UID, canonical tools and absolute deadline across restart', async t => {
  const f = await grantsFixture(t); await f.store.reserveGrant(f.input, context());
  const bound = await f.store.bindGrant(f.input.ref, target.id, frozen, context());
  assert.deepEqual(bound.binding, frozen);
  await f.store.close(); const reopened = f.open();
  assert.deepEqual(await reopened.bindGrant(f.input.ref, target.id, { ...frozen, tools: ['workiq', 'workiq'] }, context()), bound);
  for (const change of [{ namespaceUID: 'other' }, { gatewayUID: 'other' }, { taskUID: 'child' }, { tools: [] }, { deadline: frozen.deadline + 1 }]) {
    await assert.rejects(reopened.bindGrant(f.input.ref, target.id, { ...frozen, ...change }, context()), /conflict|invalid-input/);
  }
  await assert.rejects(reopened.bindGrant(f.input.ref, 'other', frozen, context()), /conflict/);
});

test('lost grant publication response reconciles exact ciphertext once; absent uncertain write is never retried', async t => {
  const f = await grantsFixture(t); let writes = 0;
  f.controls.hook = ({ req, body, res, reply }) => {
    if (req.method === 'POST' && String(body?.RowKey).startsWith('grant_')) { writes++; reply(); res.destroy(); } else reply();
  };
  assert.deepEqual(await f.store.reserveGrant(f.input, context()), f.input); assert.equal(writes, 1);
  f.controls.hook = ({ req, body, res, reply }) => {
    if (req.method === 'POST' && String(body?.RowKey).startsWith('grant_')) { writes++; res.destroy(); } else reply();
  };
  await assert.rejects(f.store.reserveGrant({ ...f.input, ref: grantReference(binding, target, 'new', 'new-reply'), eventId: 'new' }, context()), /unavailable/);
  assert.equal(writes, 2);
});

test('mixed provider generation is immutable while old Work IQ-only grants retain their exact shape', async t => {
  const f = await grantsFixture(t); const mixed = { ...f.input, githubGeneration: 0,
    tools: ['workiq', 'github-read-file', 'github-list-issues', 'github-create-issue', 'github-create-pull-request'] };
  const saved = await f.store.reserveGrant(mixed, context()); assert.equal(saved.githubGeneration, 0); assert.equal(saved.tools.length, 5);
  await assert.rejects(f.store.reserveGrant({ ...mixed, githubGeneration: 2 }, context()), /conflict/);
  await f.store.close(); assert.deepEqual(await f.open().getGrant(f.input.ref, context()), saved);
});

test('child bindings preserve root ciphertext and exactly reacquire nested authority after restart', async t => {
  const f = await grantsFixture(t); await f.store.reserveGrant(f.input, context());
  const root = await f.store.bindGrant(f.input.ref, target.id, frozen, context());
  assert.equal(Object.hasOwn(root.binding!, 'parentTaskUID'), false);
  assert.throws(() => taskGrant({ ...root, binding: { ...frozen, parentTaskUID: 'forged' } }));
  const rootRow = JSON.stringify([...f.rows.values()].find(r => String(r.RowKey).startsWith('grant_')));
  const child = { ...frozen, taskUID: 'child', parentTaskUID: 'task', deadline: frozen.deadline - 1 };
  const leaf = { ...child, taskUID: 'leaf', parentTaskUID: 'child', deadline: child.deadline - 1 };
  const bound = await f.store.bindGrant(f.input.ref, target.id, child, context());
  assert.deepEqual(bound.binding, child);
  await f.store.bindGrant(f.input.ref, target.id, leaf, context());
  assert.equal(JSON.stringify([...f.rows.values()].find(r => String(r.RowKey).startsWith('grant_'))), rootRow);
  assert.deepEqual(await f.store.getGrant(f.input.ref, context()), root);
  await f.store.close(); const reopened = f.open();
  assert.deepEqual(await reopened.bindGrant(f.input.ref, target.id, { ...child, tools: ['workiq', 'workiq'] }, context()), bound);
  assert.deepEqual((await reopened.getGrant(f.input.ref, context(), 'leaf'))?.binding, leaf);
  assert.deepEqual(await reopened.getGrant(f.input.ref, context(), 'task'), root);
  assert.equal(await reopened.getGrant(f.input.ref, context(), 'unknown'), undefined);
  await reopened.disconnect(f.subject, context());
  assert.equal(await reopened.getGrant(f.input.ref, context(), 'child'), undefined);
});

test('child bindings refuse missing, cross-grant, inconsistent, widening and cyclic parent links', async t => {
  const f = await grantsFixture(t); await f.store.reserveGrant(f.input, context());
  const child = { ...frozen, taskUID: 'child', parentTaskUID: 'task', deadline: frozen.deadline - 1 };
  assert.equal(await f.store.getGrant(f.input.ref, context(), 'child'), undefined);
  await assert.rejects(f.store.bindGrant(f.input.ref, target.id, child, context()), /conflict/);
  await f.store.bindGrant(f.input.ref, target.id, frozen, context());
  await f.store.bindGrant(f.input.ref, target.id, child, context());
  const writes = f.requests.filter(r => r.method !== 'GET').length;
  for (const change of [{ parentTaskUID: 'missing' }, { parentTaskUID: 'child' }, { parentTaskUID: 'leaf' },
    { namespaceUID: 'child-execution-namespace' }, { gatewayUID: 'other' }, { tools: ['github-read-file'] },
    { deadline: frozen.deadline + 1 }, { deadline: child.deadline - 1 }]) {
    await assert.rejects(f.store.bindGrant(f.input.ref, target.id, { ...child, ...change }, context()), /conflict|invalid-input/);
  }
  await assert.rejects(f.store.bindGrant(f.input.ref, target.id, { ...frozen, parentTaskUID: 'child' }, context()), /conflict/);
  await assert.rejects(f.store.bindGrant(f.input.ref, 'other', { ...child, taskUID: 'new' }, context()), /conflict/);
  const other = { ...f.input, ref: 'b'.repeat(64), eventId: 'other' }; await f.store.reserveGrant(other, context());
  await f.store.bindGrant(other.ref, target.id, { ...frozen, taskUID: 'other-root' }, context());
  await assert.rejects(f.store.bindGrant(other.ref, target.id, child, context()), /conflict/);
  // Only the other grant and its root were created; no refusal mutated authority.
  assert.equal(f.requests.filter(r => r.method !== 'GET').length, writes + 2);
});

test('child binding CAS admits only exact winner and reconciles lost publication without retry', async t => {
  const f = await grantsFixture(t); await f.store.reserveGrant(f.input, context());
  await f.store.bindGrant(f.input.ref, target.id, frozen, context());
  const child = { ...frozen, taskUID: 'child', parentTaskUID: 'task' };
  let creates = 0;
  f.controls.hook = ({ req, body, res, reply }) => {
    if (req.method === 'POST' && String(body?.RowKey).startsWith('binding_')) { creates++; reply(); res.destroy(); } else reply();
  };
  assert.deepEqual((await f.store.bindGrant(f.input.ref, target.id, child, context())).binding, child);
  assert.equal(creates, 1); delete f.controls.hook;
  const candidates = [0, 1].map(n => ({ ...child, taskUID: 'racing-child', deadline: frozen.deadline - n }));
  const results = await Promise.allSettled(candidates.map(b => f.store.bindGrant(f.input.ref, target.id, b, context())));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const winner = results.find(r => r.status === 'fulfilled')!;
  if (winner.status === 'fulfilled') assert.deepEqual(await f.store.getGrant(f.input.ref, context(), 'racing-child'), winner.value);
});

test('authority loss and expired binding forbid further grant use', async t => {
  const f = await grantsFixture(t); await f.store.reserveGrant(f.input, context());
  await assert.rejects(f.store.bindGrant(f.input.ref, target.id, { ...frozen, deadline: epoch }, context()), /invalid-input/);
  f.revoke(); await assert.rejects(f.store.getGrant(f.input.ref, context()), /unready/);
});
