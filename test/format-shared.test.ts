import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDelivery, MAX_OUTGOING_MESSAGE_BYTES } from '../src/teams/format.js';
import { finalDelivery, finalMessage } from './fixtures/outgoing.js';

function text(message: ReturnType<typeof formatDelivery>) {
  return message.attachments[0].content.body!.map(block => 'text' in block ? block.text : '').join('\n');
}

test('room attribution escapes Markdown and never includes a provider ID; personal golden remains exact', () => {
  const message = formatDelivery(finalDelivery, { requesterDisplayName: '[Eve](https://evil.invalid) *admin* _x_ `code` \\' });
  assert.ok(text(message).includes('Reply to \\[Eve\\]\\(https://evil\\.invalid\\) \\*admin\\* \\_x\\_ \\`code\\` \\\\'));
  assert.ok(!JSON.stringify(message).includes(finalDelivery.sessionRef!.name));
  assert.deepEqual(formatDelivery(finalDelivery), finalMessage);
  assert.equal(text(formatDelivery(finalDelivery, {})), `Reply to an allowed participant\n${finalDelivery.text}`);
  assert.ok(!text(message).includes('continuing'));
  // One subtle line carries both facts; a room reply has no other chrome.
  assert.deepEqual(formatDelivery(finalDelivery, { requesterDisplayName: 'Ada', continuation: true }).attachments[0].content.body, [
    { type: 'TextBlock', text: 'Reply to Ada · continuing this chat', wrap: true, isSubtle: true, size: 'Small', spacing: 'None' },
    { type: 'TextBlock', text: finalDelivery.text, wrap: true, spacing: 'Small' }]);
  assert.equal(formatDelivery(finalDelivery, { requesterDisplayName: 'Ada', continuation: true }).attachments[0].content.fallbackText,
    `Orka reply — Reply to Ada · continuing this chat: ${finalDelivery.text.replace(/\s+/gu, ' ')}`);
});

test('a question or failure in a room keeps its heading between the label and the text', () => {
  const body = (kind: 'message' | 'error', text: string) => formatDelivery({ ...finalDelivery, kind, text }, { requesterDisplayName: 'Ada' }).attachments[0].content.body!;
  assert.deepEqual(body('message', 'Question: which branch?').slice(1), [
    { type: 'TextBlock', text: 'Question', weight: 'Bolder', wrap: true, spacing: 'Small' },
    { type: 'TextBlock', text: 'Which branch?', wrap: true, spacing: 'Small' }]);
  assert.deepEqual(body('error', 'It failed.').slice(1), [
    { type: 'TextBlock', text: "Couldn't complete the request", weight: 'Bolder', wrap: true, spacing: 'Small', color: 'Attention' },
    { type: 'TextBlock', text: 'It failed.', wrap: true, spacing: 'Small' }]);
  // A prefix with nothing after it is not a question, so nothing is stripped.
  assert.deepEqual(body('message', 'Question: ').slice(1), [{ type: 'TextBlock', text: 'Question: ', wrap: true, spacing: 'Small' }]);
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
  assert.ok(text(message).startsWith('Reply to an allowed participant · continuing this chat\n'));
  assert.equal(message.replyToId, 'root');
  assert.ok(!text(message).includes('\u0301'));
});
