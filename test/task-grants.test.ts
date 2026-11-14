import assert from 'node:assert/strict';
import test from 'node:test';
import { grantReference } from '../src/accounts/grants.js';
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
  await assert.rejects(f.store.reserveGrant({ ...f.input, ref: grantReference(binding, target, 'new'), eventId: 'new' }, context()), /unavailable/);
  assert.equal(writes, 2);
});

test('authority loss and expired binding forbid further grant use', async t => {
  const f = await grantsFixture(t); await f.store.reserveGrant(f.input, context());
  await assert.rejects(f.store.bindGrant(f.input.ref, target.id, { ...frozen, deadline: epoch }, context()), /invalid-input/);
  f.revoke(); await assert.rejects(f.store.getGrant(f.input.ref, context()), /unready/);
});
