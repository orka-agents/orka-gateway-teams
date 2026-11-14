import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkIQ, workIQArguments } from '../src/accounts/workiq.js';
import { context, deferred } from './support/directory-table.js';

import { completed, workIQFixture } from './support/workiq.js';
test('Work IQ sends fixed A2A 1.0 sender query and returns completed artifact text only', async t => {
  const f = await workIQFixture(t); const client = createWorkIQ({ request: f.request }); t.after(() => client.close());
  assert.deepEqual(await client.ask({ question: 'Meetings?', location: { timeZoneOffset: -480, timeZone: 'America/Los_Angeles' } }, 'ACCESS-PRIVATE', context()), { text: 'Answer' });
  const b = f.bodies[0]!; assert.equal(b.method, 'SendMessage'); assert.equal(b.jsonrpc, '2.0'); assert.match(b.id, /^[\da-f-]{36}$/);
  assert.deepEqual(b.params, { message: { role: 'ROLE_USER', messageId: b.params.message.messageId, parts: [{ text: 'Meetings?' }],
    metadata: { Location: { timeZoneOffset: -480, timeZone: 'America/Los_Angeles' } } } });
  assert.notEqual(b.id, b.params.message.messageId);
  await client.ask({ question: 'Another task' }, 'ACCESS-PRIVATE', context());
  assert.equal('contextId' in f.bodies[1]!.params.message, false); assert.equal('metadata' in f.bodies[1]!.params.message, false);
});

test('tool arguments cannot choose context, destination, credentials, identity or arbitrary metadata', () => {
  for (const extra of ['contextId', 'url', 'headers', 'authorization', 'objectId', 'metadata']) assert.throws(() => workIQArguments({ question: 'q', [extra]: 'private' }));
  for (const value of [{}, { question: '' }, { question: 'q'.repeat(32769) }, { question: 'q', location: { timeZone: 'garbage', timeZoneOffset: 0 } },
    { question: 'q', location: { timeZone: 'UTC', timeZoneOffset: 0, url: 'https://evil' } }, { question: 'q', location: { timeZone: 'UTC', timeZoneOffset: 900 } }]) assert.throws(() => workIQArguments(value));
});

test('noncompleted, malformed, credential-bearing and ambiguous Work IQ responses are fixed refusals with no retry', async t => {
  const f = await workIQFixture(t); const client = createWorkIQ({ request: f.request }); t.after(() => client.close());
  const variants = [
    (id: unknown) => ({ ...completed(id), result: { message: { text: 'not an artifact' } } }),
    (id: unknown) => { const r = completed(id); r.result.task.status.state = 'TASK_STATE_WORKING'; return r; },
    (_id: unknown) => completed('wrong-id'),
    (id: unknown) => completed(id, 'ACCESS-PRIVATE'),
    (id: unknown) => ({ jsonrpc: '2.0', id, error: { message: 'ACCESS-PRIVATE' } }),
    (id: unknown) => { const r = completed(id); (r.result.task.artifacts[0]!.parts as unknown[]).push({ data: { private: true } }); return r; },
  ];
  for (const variant of variants) {
    f.behavior((_req, res, b) => res.end(JSON.stringify(variant(b.id))));
    await assert.rejects(client.ask({ question: 'q' }, 'ACCESS-PRIVATE', context()), /^Error: Tool unavailable$/);
  }
  f.behavior((_req, res) => { res.writeHead(302, { location: 'https://evil/' }); res.end('ACCESS-PRIVATE'); });
  await assert.rejects(client.ask({ question: 'q' }, 'ACCESS-PRIVATE', context()), /Tool unavailable/);
  f.behavior((_req, res) => res.destroy());
  await assert.rejects(client.ask({ question: 'q' }, 'ACCESS-PRIVATE', context()), /Tool unavailable/);
  f.behavior((_req, res) => res.end('x'.repeat(262145)));
  await assert.rejects(client.ask({ question: 'q' }, 'ACCESS-PRIVATE', context()), /Tool unavailable/);
  assert.equal(f.bodies.length, variants.length + 3);
});

test('abort and close drain actual native Work IQ work', async t => {
  const f = await workIQFixture(t); const entered = deferred(); f.behavior(() => entered.resolve());
  const client = createWorkIQ({ request: f.request }); const controller = new AbortController();
  const pending = client.ask({ question: 'q' }, 'ACCESS-PRIVATE', { ...context(), signal: controller.signal });
  const rejection = assert.rejects(pending, /Tool unavailable/); await entered.promise; controller.abort(); await client.close(); await rejection;
  await assert.rejects(client.ask({ question: 'q' }, 'ACCESS-PRIVATE', context()), /Tool unavailable/);
});
