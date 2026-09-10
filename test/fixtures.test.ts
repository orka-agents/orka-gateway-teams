import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_HTTP_BODY_BYTES, MAX_TEXT_BYTES } from '../src/protocol/types.js';
import { MAX_OUTGOING_MESSAGE_BYTES } from '../src/teams/format.js';
import { createExternalEventId } from '../src/teams/ids.js';
import { personalMessage, conversionContext, expectedEvent } from './fixtures/incoming.js';
import { finalDelivery, errorDelivery, oversizedDelivery, finalMessage, errorMessage } from './fixtures/outgoing.js';

test('incoming fixture demonstrates the exact personal-chat wire fields', () => {
  assert.equal(expectedEvent.externalEventId, createExternalEventId({
    tenantId: conversionContext.tenantId,
    conversationId: personalMessage.conversation.id,
    activityId: personalMessage.id,
  }));
  assert.equal(expectedEvent.accountId, conversionContext.tenantId);
  assert.equal(expectedEvent.contextId, personalMessage.conversation.id);
  assert.equal(expectedEvent.sender.id, personalMessage.from.id);
  assert.equal(expectedEvent.replyTarget, conversionContext.replyTarget);
  assert.equal(expectedEvent.text, personalMessage.text);
  assert.deepEqual(Object.keys(expectedEvent).sort(), [
    'accountId', 'contextId', 'eventType', 'externalEventId',
    'protocolVersion', 'replyTarget', 'sender', 'text',
  ].sort());
  assert.deepEqual(Object.keys(expectedEvent.sender).sort(), ['displayName', 'id']);
  assert.ok(Buffer.byteLength(JSON.stringify(expectedEvent)) <= MAX_HTTP_BODY_BYTES);
  assert.ok(Buffer.byteLength(expectedEvent.text) <= MAX_TEXT_BYTES);
});

test('generic error delivery omits task and session references', () => {
  assert.equal(errorDelivery.kind, 'error');
  assert.equal('taskRef' in errorDelivery, false);
  assert.equal('sessionRef' in errorDelivery, false);
  assert.ok(finalDelivery.taskRef);
  assert.ok(finalDelivery.sessionRef);
});

test('expected replies are one readable card, not text plus card', () => {
  for (const [message, delivery, title] of [
    [finalMessage, finalDelivery, 'Orka reply'],
    [errorMessage, errorDelivery, 'Orka could not complete the request'],
  ] as const) {
    assert.equal(message.type, 'message');
    assert.ok(message.text === undefined || message.text === '');
    assert.equal(message.attachments.length, 1);
    const attachment = message.attachments[0];
    assert.equal(attachment.contentType, 'application/vnd.microsoft.card.adaptive');
    const card = attachment.content;
    assert.equal(card.type, 'AdaptiveCard');
    assert.ok(card.fallbackText?.trim());
    const heading = card.body?.[0];
    const answer = card.body?.[1];
    assert.ok(heading?.type === 'TextBlock');
    assert.ok(answer?.type === 'TextBlock');
    assert.equal(heading.text, title);
    assert.equal(answer.text, delivery.text);
    assert.equal(answer.wrap, true);
    assert.ok(Buffer.byteLength(JSON.stringify(message)) <= MAX_OUTGOING_MESSAGE_BYTES);
  }
});

test('oversized delivery demonstrates a valid multibyte answer beyond the outgoing budget', () => {
  const bytes = Buffer.byteLength(oversizedDelivery.text, 'utf8');
  assert.ok(bytes > MAX_OUTGOING_MESSAGE_BYTES);
  assert.ok(bytes <= MAX_TEXT_BYTES);
  assert.match(oversizedDelivery.text, /こんにちは 🧑🏽‍💻 e\u0301/u);
});

test('fixture JSON round-trips preserve Unicode and do not mutate inputs', () => {
  const fixtures = [expectedEvent, finalDelivery, errorDelivery, oversizedDelivery, finalMessage, errorMessage];
  const before = structuredClone(fixtures);
  for (const fixture of fixtures) {
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), fixture);
  }
  assert.deepEqual(fixtures, before);
  assert.match(finalDelivery.text, /こんにちは/);
  assert.match(finalDelivery.text, /🧑🏽‍💻/u);
  assert.match(finalDelivery.text, /\n\n/);
});
