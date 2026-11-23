import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDelivery, MAX_OUTGOING_MESSAGE_BYTES } from '../src/teams/format.js';
import { finalDelivery, finalMessage } from './fixtures/outgoing.js';

type Body = NonNullable<ReturnType<typeof formatDelivery>['attachments'][0]['content']['body']>;
// Every line a reader sees, top to bottom.
const flat = (body: Body): string[] => body.flatMap(block => 'text' in block && typeof block.text === 'string' ? [block.text] : []);
function text(message: ReturnType<typeof formatDelivery>) {
  return flat(message.attachments[0].content.body!).join('\n');
}
const grey = (text: string) => ({ type: 'TextBlock', text, wrap: true, isSubtle: true, size: 'Small', spacing: 'None' });
const plain = (text: string) => ({ type: 'TextBlock', text, wrap: true, spacing: 'Small' });

test('room attribution escapes Markdown and never includes a provider ID; personal golden remains exact', () => {
  const message = formatDelivery(finalDelivery, { requesterDisplayName: '[Eve](https://evil.invalid) *admin* _x_ `code` \\' });
  assert.ok(text(message).includes('Reply to \\[Eve\\]\\(https://evil\\.invalid\\) \\*admin\\* \\_x\\_ \\`code\\` \\\\'));
  assert.ok(!JSON.stringify(message).includes(finalDelivery.sessionRef!.name));
  assert.deepEqual(formatDelivery(finalDelivery), finalMessage);
  assert.equal(text(formatDelivery(finalDelivery, {})), `Reply to an allowed participant\n${finalDelivery.text}`);
  assert.ok(!text(message).includes('history'));
  // One subtle line carries both facts, above the reply as plain text.
  assert.deepEqual(formatDelivery(finalDelivery, { requesterDisplayName: 'Ada', continuation: true }).attachments[0].content.body,
    [grey("Reply to Ada · uses this chat's history"), plain(finalDelivery.text)]);
  assert.equal(formatDelivery(finalDelivery, { requesterDisplayName: 'Ada', continuation: true }).attachments[0].content.fallbackText,
    `Orka reply — Reply to Ada · uses this chat's history: ${finalDelivery.text.replace(/\s+/gu, ' ')}`);
});

test('a room card says whose turn it is and whether the agent is done: working, a question with how to answer, a reply or a failure', () => {
  const body = (kind: 'message' | 'error' | 'final', text: string, continuation = false) => formatDelivery({ ...finalDelivery, kind, text }, { requesterDisplayName: 'Ada', continuation }).attachments[0].content.body!;
  assert.deepEqual(body('message', 'Reading the logs.'), [grey('Working for Ada'), plain('Reading the logs.')]);
  // The caption replaces the old heading. A group chat only hears mentions, so the card says how to answer.
  assert.deepEqual(body('message', 'Question: which branch?'), [grey('Question for Ada'), plain('Which branch?'),
    { type: 'TextBlock', text: 'Answer by mentioning @Orka.', wrap: true, spacing: 'Small', isSubtle: true, size: 'Small' }]);
  assert.deepEqual(body('final', 'Done.'), [grey('Reply to Ada'), plain('Done.')]);
  assert.deepEqual(body('error', 'It failed.'), [grey('Reply to Ada'),
    { type: 'TextBlock', text: "Couldn't complete the request", weight: 'Bolder', wrap: true, spacing: 'Small', color: 'Attention' },
    plain('It failed.'), plain('Try again, or ask in a different way.')]);
  // A prefix with nothing after it is not a question, so nothing is stripped and no answer is asked for.
  assert.deepEqual(body('message', 'Question: '), [grey('Working for Ada'), plain('Question: ')]);
  // The fallback calls it what the card does.
  assert.equal(formatDelivery({ ...finalDelivery, kind: 'message', text: 'Question: \t ' }, { requesterDisplayName: 'Ada' }).attachments[0].content.fallbackText, 'Orka update — Working for Ada: Question:');
  // Every kind says when it draws on the chat's earlier turns, and the fallback carries the same caption.
  for (const [kind, text, caption] of [['message', 'Reading.', 'Working for Ada'], ['message', 'Question: which?', 'Question for Ada'], ['final', 'Done.', 'Reply to Ada'], ['error', 'It failed.', 'Reply to Ada']] as const)
    assert.deepEqual(body(kind, text, true)[0], grey(`${caption} · uses this chat's history`));
  assert.equal(formatDelivery({ ...finalDelivery, kind: 'message', text: 'Question: which?' }, { requesterDisplayName: 'Ada' }).attachments[0].content.fallbackText, 'Orka question — Question for Ada: Which?');
  // Without a saved name the caption still says who may answer.
  assert.deepEqual(formatDelivery({ ...finalDelivery, kind: 'message', text: 'Question: which?' }, {}).attachments[0].content.body![0], grey('Question for an allowed participant'));
});

test('whole shared message budget includes requester, continuation and exact replyToId; fallback and graphemes stay bounded', () => {
  const prefix = '🧑🏽‍💻é';
  const message = formatDelivery({ ...finalDelivery, text: prefix.repeat(7000) }, {
    requesterDisplayName: '*'.repeat(256), continuation: true, replyToId: 'r'.repeat(256),
  });
  assert.equal(message.replyToId, 'r'.repeat(256));
  assert.ok(Buffer.byteLength(JSON.stringify(message)) <= MAX_OUTGOING_MESSAGE_BYTES);
  assert.ok(Buffer.byteLength(message.attachments[0].content.fallbackText!) <= 512);
  const answer = flat(message.attachments[0].content.body!).find(line => line.startsWith(prefix));
  assert.ok(answer);
  assert.ok(prefix.repeat(7000).startsWith(answer));
  assert.ok(answer.endsWith('é') || answer.endsWith('🧑🏽‍💻'));
  assert.ok(text(message).includes('Reply shortened'));
});

test('giant first grapheme leaves shared attribution, reply target and bounded fallback readable', () => {
  const message = formatDelivery({ ...finalDelivery, text: 'a' + '\u0301'.repeat(30000) }, { replyToId: 'root', continuation: true });
  assert.ok(Buffer.byteLength(JSON.stringify(message)) <= MAX_OUTGOING_MESSAGE_BYTES);
  assert.ok(Buffer.byteLength(message.attachments[0].content.fallbackText!) <= 512);
  assert.ok(text(message).startsWith("Reply to an allowed participant · uses this chat's history\n"));
  assert.equal(message.replyToId, 'root');
  assert.ok(!text(message).includes('\u0301'));
});
