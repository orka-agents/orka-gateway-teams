import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDelivery, MAX_OUTGOING_MESSAGE_BYTES } from '../src/teams/format.js';
import { finalDelivery, finalMessage } from './fixtures/outgoing.js';

function text(message: ReturnType<typeof formatDelivery>) {
  return message.attachments[0].content.body!.map(block => 'text' in block ? block.text : '').join('\n');
}

test('room attribution escapes Markdown and never includes a provider ID; personal golden remains exact', () => {
  const message = formatDelivery(finalDelivery, { requesterDisplayName: '[Eve](https://evil.invalid) *admin* _x_ `code` \\' });
  assert.ok(text(message).includes('Asked by \\[Eve\\]\\(https://evil\\.invalid\\) \\*admin\\* \\_x\\_ \\`code\\` \\\\'));
  assert.ok(!JSON.stringify(message).includes(finalDelivery.sessionRef!.name));
  assert.deepEqual(formatDelivery(finalDelivery), finalMessage);
  assert.ok(text(formatDelivery(finalDelivery, {})).includes('Asked by an allowed participant'));
  assert.ok(!text(message).includes('Continuing'));
  assert.ok(text(formatDelivery(finalDelivery, { continuation: true })).includes("Continuing the room's conversation"));
});

test('whole shared message budget includes requester, continuation and exact replyToId; fallback and graphemes stay bounded', () => {
  const prefix = '🧑🏽‍💻é';
  const message = formatDelivery({ ...finalDelivery, text: prefix.repeat(7000) }, {
    requesterDisplayName: '*'.repeat(256), continuation: true, replyToId: 'r'.repeat(256),
  });
  assert.equal(message.replyToId, 'r'.repeat(256));
  assert.ok(Buffer.byteLength(JSON.stringify(message)) <= MAX_OUTGOING_MESSAGE_BYTES);
  assert.ok(Buffer.byteLength(message.attachments[0].content.fallbackText!) <= 512);
  const blocks = message.attachments[0].content.body!;
  const answer = blocks.find(block => 'text' in block && typeof block.text === 'string' && block.text.startsWith('🧑'));
  assert.ok(answer && 'text' in answer && typeof answer.text === 'string');
  assert.ok(prefix.repeat(7000).startsWith(answer.text));
  assert.ok(answer.text.endsWith('é') || answer.text.endsWith('🧑🏽‍💻'));
  assert.ok(text(message).includes('Reply shortened'));
});

test('giant first grapheme leaves shared attribution, reply target and bounded fallback readable', () => {
  const message = formatDelivery({ ...finalDelivery, text: 'a' + '\u0301'.repeat(30000) }, { replyToId: 'root', continuation: true });
  assert.ok(Buffer.byteLength(JSON.stringify(message)) <= MAX_OUTGOING_MESSAGE_BYTES);
  assert.ok(Buffer.byteLength(message.attachments[0].content.fallbackText!) <= 512);
  assert.ok(text(message).includes('Asked by an allowed participant'));
  assert.equal(message.replyToId, 'root');
  assert.ok(!text(message).includes('\u0301'));
});
