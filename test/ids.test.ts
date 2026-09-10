import assert from 'node:assert/strict';
import test from 'node:test';
import { createExternalEventId } from '../src/teams/ids.js';
import { MAX_IDENTITY_BYTES } from '../src/protocol/types.js';

const identity = Object.freeze({
  tenantId: '11111111-1111-4111-8111-111111111111',
  conversationId: '19:fixture-personal',
  activityId: 'fixture-message-1',
});

test('event identity has a fixed versioned encoding', () => {
  const expected = 'teams:v1:a4e643cbbb0d029bc04f9432b734fd0d0af2e1aa33002e05ef9b74fcc0bc0a98';
  const before = structuredClone(identity);
  assert.equal(createExternalEventId(identity), expected);
  assert.equal(createExternalEventId(identity), expected);
  assert.deepEqual(identity, before);
});

test('tenant, conversation, and activity each affect the ID', () => {
  const ids = [
    identity,
    { ...identity, tenantId: '22222222-2222-4222-8222-222222222222' },
    { ...identity, conversationId: '19:other-personal' },
    { ...identity, activityId: 'fixture-message-2' },
  ].map(createExternalEventId);
  assert.equal(new Set(ids).size, ids.length);
});

test('tuple encoding avoids delimiter ambiguity', () => {
  assert.notEqual(
    createExternalEventId({ tenantId: 'a:b', conversationId: 'c', activityId: 'd' }),
    createExternalEventId({ tenantId: 'a', conversationId: 'b:c', activityId: 'd' }),
  );
});

test('Unicode identities produce stable bounded ASCII IDs', () => {
  const value = { ...identity, conversationId: '会話🧑🏽‍💻', activityId: '消息🌍' };
  const result = createExternalEventId(value);
  assert.match(result, /^teams:v1:[a-f0-9]{64}$/);
  assert.equal(result, createExternalEventId(value));
  assert.ok(Buffer.byteLength(result, 'utf8') <= MAX_IDENTITY_BYTES);
  assert.notEqual(result, createExternalEventId({ ...value, activityId: '消息🌎' }));
});
