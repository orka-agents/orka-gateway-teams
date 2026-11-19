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

test('completed Work IQ text remains usable alongside structured data parts without exposing that data', async t => {
  const f = await workIQFixture(t); const client = createWorkIQ({ request: f.request }); t.after(() => client.close());
  f.behavior((_req, res, body) => {
    const result = completed(body.id); (result.result.task.artifacts[0]!.parts as unknown[]).unshift({ data: { private: 'DATA-PRIVATE', nested: { token: 'ACCESS-PRIVATE' } } });
    (result.result.task.artifacts as unknown[]).push({ parts: [{ data: { private: 'OTHER-DATA-PRIVATE' }, metadata: { private: true } }, { text: 'Second text' }] });
    res.end(JSON.stringify(result));
  });
  const result = await client.ask({ question: 'q' }, 'ACCESS-PRIVATE', context());
  assert.deepEqual(result, { text: 'Answer\nSecond text' }, 'only completed text parts may be returned');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/, 'structured data must not leak into tool output');
});

test('A2A 1.0 data values and optional media fields are ignored while text is retained', async t => {
  const f = await workIQFixture(t); const client = createWorkIQ({ request: f.request }); t.after(() => client.close());
  for (const data of [null, [], ['PRIVATE'], 'PRIVATE', 42, true]) {
    f.behavior((_req, res, body) => { const result = completed(body.id); (result.result.task.artifacts[0]!.parts as unknown[]).unshift({ data, mediaType: 'application/json', filename: 'PRIVATE' });
      Object.assign(result.result.task.artifacts[0]!.parts[1]!, { mediaType: 'text/plain' }); res.end(JSON.stringify(result)); });
    assert.deepEqual(await client.ask({ question: 'q' }, 'ACCESS-PRIVATE', context()), { text: 'Answer' }, 'non-text JSON data is valid but must never become the answer');
  }
});

test('structured data cannot make malformed, ambiguous or textless responses acceptable', async t => {
  const f = await workIQFixture(t); const client = createWorkIQ({ request: f.request }); t.after(() => client.close());
  for (const part of [{ data: {}, filename: 42 }, { data: {}, mediaType: [] }, { text: 'Answer', data: {} }, { text: 'Answer', data: null }, { data: {}, extra: true }, { metadata: {} }]) {
    f.behavior((_req, res, body) => { const result = completed(body.id); (result.result.task.artifacts[0]!.parts as unknown[]).push(part); res.end(JSON.stringify(result)); });
    await assert.rejects(client.ask({ question: 'q' }, 'ACCESS-PRIVATE', context()), /Tool unavailable/, 'invalid data or ambiguous part must remain refused');
  }
  f.behavior((_req, res, body) => { const result = completed(body.id); (result.result.task.artifacts[0] as { parts: unknown[] }).parts = [{ data: { private: true } }]; res.end(JSON.stringify(result)); });
  await assert.rejects(client.ask({ question: 'q' }, 'ACCESS-PRIVATE', context()), /Tool unavailable/, 'a data-only response has no usable text answer');
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
    (id: unknown) => { const r = completed(id); (r.result.task.artifacts[0]!.parts as unknown[]).push({ text: 'ambiguous', data: null }); return r; },
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
