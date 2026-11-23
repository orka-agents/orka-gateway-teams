import assert from 'node:assert/strict';
import test from 'node:test';
import type { IAdaptiveCard } from '@microsoft/teams.cards';
import { MAX_TEXT_BYTES } from '../src/protocol/types.js';
import type { DeliveryRequest } from '../src/protocol/types.js';
import { formatDelivery, MAX_OUTGOING_MESSAGE_BYTES } from '../src/teams/format.js';
import type { OutgoingTeamsMessage } from '../src/teams/format.js';
import { finalDelivery, errorDelivery, finalMessage, errorMessage } from './fixtures/outgoing.js';

for (const [delivery, expected] of [
  [finalDelivery, finalMessage], [errorDelivery, errorMessage],
] as const) {
  test(`${delivery.kind} delivery formats as the independent one-card sample`, () => {
    const message = formatDelivery(delivery);
    assert.deepEqual(message, expected);
    assert.deepEqual(Object.keys(message).sort(), ['attachments', 'type']);
    assert.equal(message.type, 'message');
    assert.ok(message.text === undefined || message.text === '');
    assert.equal(message.attachments.length, 1);
    const attachment = message.attachments[0];
    assert.equal(attachment.contentType, 'application/vnd.microsoft.card.adaptive');
    // Attachment.content is any in the SDK; narrow explicitly before inspecting it.
    const card: IAdaptiveCard = attachment.content;
    assert.equal(card.type, 'AdaptiveCard');
    assert.equal(card.version, '1.4');
    assert.ok(card.fallbackText?.trim());
    // A reply is the agent's box alone under the bot's name. A failure with no cause is its heading, in the alert colour, and what to do.
    assert.equal(card.body?.length, delivery.kind === 'final' ? 1 : 2);
    const heading = delivery.kind === 'final' ? undefined : card.body?.[0];
    assert.deepEqual(heading, delivery.kind === 'final' ? undefined
      : { type: 'TextBlock', text: "Couldn't complete the request", weight: 'Bolder', wrap: true, spacing: 'Small', color: 'Attention' });
    assert.equal(answerOf(card).text, delivery.kind === 'final' ? delivery.text : 'Try again, or ask in a different way.');
  });
}

function cardOf(message: OutgoingTeamsMessage): IAdaptiveCard {
  return message.attachments[0].content;
}

function answerOf(card: IAdaptiveCard) {
  // Text from Orka is the last line of its tinted box. Without a box, the answer is the gateway's own line under any failure heading.
  const box = card.body?.find(block => block.type === 'Container');
  const answer = box?.type === 'Container' ? box.items?.at(-1) : card.body?.find(block => block.type === 'TextBlock' && block.weight !== 'Bolder');
  assert.ok(answer?.type === 'TextBlock');
  assert.equal(answer.wrap, true);
  return answer;
}

function formatText(text: string, kind: DeliveryRequest['kind'] = 'final') {
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES, 'test input is protocol-bounded');
  return formatDelivery({ ...errorDelivery, kind, text });
}

function messageBytes(message: OutgoingTeamsMessage) {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

function assertShortened(card: IAdaptiveCard) {
  const notice = card.body?.at(-1);
  assert.notEqual(notice, answerOf(card));
  assert.ok(notice?.type === 'TextBlock');
  assert.equal(notice.wrap, true);
  assert.equal(notice.isSubtle, true);
  assert.match(notice.text, /shorten/i);
  assert.ok(card.fallbackText);
  assert.match(card.fallbackText, /shorten|abbreviat|…/iu);
}

for (const [kind, expectedText] of [
  ['final', 'Orka finished without a text reply.'],
  ['error', 'Try again, or ask in a different way.'],
] as const) {
  test(`${kind} empty and whitespace-only answers get a readable neutral body and fallback`, () => {
    for (const text of ['', ' \t\r\n \u2003 ']) {
      const card = cardOf(formatText(text, kind));
      assert.equal(answerOf(card).text, expectedText);
      assert.ok(card.fallbackText?.includes(kind === 'final' ? expectedText : 'This request could not be completed.'));
      assert.equal(card.body?.length, kind === 'final' ? 1 : 2);
      // Only text from Orka is fenced as the agent's.
      assert.ok(!JSON.stringify(card).includes('Written by the agent'));
    }
  });
}

for (const [name, text] of [
  ['meaningful whitespace and Markdown', '  First paragraph.\n\n- item one\n- item two\n\n```ts\nconst x = "quoted";\n\tconsole.log(x);\n```\n\nTrailing spaces  '],
  ['Unicode and graphemes', 'こんにちは مرحبا 中文 हिन्दी e\u0301 🧑🏽‍💻 👨‍👩‍👧‍👦 🇺🇳'],
  ['a long fitting line', 'x'.repeat(10_000)],
] as const) {
  test(`fitting ${name} stays unchanged without a shortening notice`, () => {
    const message = formatText(text);
    const card = cardOf(message);
    assert.equal(answerOf(card).text, text);
    assert.equal(card.body?.length, 1);
    assert.ok(messageBytes(message) <= MAX_OUTGOING_MESSAGE_BYTES);
    assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
  });
}

test('fallback is independently bounded and honestly abbreviated while a larger body fits', () => {
  for (const text of ['a'.repeat(3_000), '🧑🏽‍💻 e\u0301 界 '.repeat(150), 'a' + '\u0301'.repeat(1_024)]) {
    const card = cardOf(formatText(text));
    assert.equal(answerOf(card).text, text);
    assert.equal(card.body?.length, 1);
    assert.ok(card.fallbackText);
    assert.ok(card.fallbackText.trim());
    assert.ok(Buffer.byteLength(card.fallbackText, 'utf8') <= 512, 'fallback is at most 512 UTF-8 bytes');
    assert.match(card.fallbackText, /shorten|abbreviat|…/iu);
    assert.doesNotMatch(card.fallbackText, /[\uD800-\uDFFF]/u);
  }
});

test('fallback abbreviation preserves whole accents, emoji sequences and flags', () => {
  const card = cardOf(formatText('e\u0301🧑🏽‍💻👨‍👩‍👧‍👦🇺🇳'.repeat(80)));
  assert.ok(card.fallbackText);
  assert.match(card.fallbackText, /^Orka reply: (?:e\u0301|🧑🏽‍💻|👨‍👩‍👧‍👦|🇺🇳)+… \(shortened\)$/u);
});

test('a whitespace-heavy shortened body is disclosed even when its normalized fallback fits', () => {
  const card = cardOf(formatText('Visible start' + '\n '.repeat(15_000) + 'end'));
  assertShortened(card);
  assert.ok(card.fallbackText?.startsWith('Orka reply: Visible start'));
});

for (const kind of ['final', 'error'] as const) {
  test(`${kind} retains an answer at the complete JSON byte boundary and shortens one byte over`, () => {
    // A long fitting ASCII body saturates the independently bounded fallback.
    const sample = formatText('a'.repeat(2_000), kind);
    const overhead = messageBytes(sample) - 2_000;
    const text = 'a'.repeat(MAX_OUTGOING_MESSAGE_BYTES - overhead);
    const exact = formatText(text, kind);
    assert.equal(messageBytes(exact), MAX_OUTGOING_MESSAGE_BYTES);
    assert.ok(answerOf(cardOf(exact)).text === text, 'exact-boundary answer is unchanged');
    assert.equal(cardOf(exact).body?.length, kind === 'final' ? 1 : 3);
    const over = formatText(text + 'a', kind);
    assert.ok(messageBytes(over) <= MAX_OUTGOING_MESSAGE_BYTES, 'one-byte-over answer fits after shortening');
    assertShortened(cardOf(over));
    assert.ok(answerOf(cardOf(over)).text.length < text.length);
  });

  for (const [name, text] of [
    ['ASCII', 'a'.repeat(MAX_TEXT_BYTES)],
    ['multi-byte scripts', '界'.repeat(20_000)],
    ['JSON escapes', '"\\\n\t'.repeat(12_000)],
    ['combined emoji and accents', 'e\u0301🧑🏽‍💻👨‍👩‍👧‍👦🇺🇳界'.repeat(1_000)],
  ] as const) {
    test(`${kind} oversized ${name} keeps a maximal grapheme prefix within the entire message budget`, () => {
      const message = formatText(text, kind);
      const card = cardOf(message);
      const retained = answerOf(card).text;
      assert.ok(messageBytes(message) <= MAX_OUTGOING_MESSAGE_BYTES, 'complete serialized message fits');
      assertShortened(card);
      assert.ok(retained.length > 0 && retained.length < text.length);
      assert.ok(text.startsWith(retained), 'body remains an exact prefix');
      assert.doesNotMatch(retained, /[\uD800-\uDFFF]/u, 'no broken surrogate pair');
      assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
      const segments = new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text);
      const next = segments.containing(retained.length);
      assert.ok(next);
      assert.equal(next.index, retained.length, 'retained body ends at a grapheme boundary');
      // Adding just the next whole grapheme must exceed the measured envelope budget.
      const expanded = structuredClone(message);
      answerOf(cardOf(expanded)).text += next.segment;
      assert.ok(messageBytes(expanded) > MAX_OUTGOING_MESSAGE_BYTES, 'no fitting next grapheme was discarded');
    });
  }
}

test('a clustered fallback near its limit cannot cause a false body-shortening notice', () => {
  const cluster = 'a' + '\u0301'.repeat(247);
  const padding = Math.floor((MAX_OUTGOING_MESSAGE_BYTES - messageBytes(formatText(cluster))) / 2) + 1;
  const text = cluster + '\n'.repeat(padding);
  const message = formatText(text);
  const card = cardOf(message);
  assert.ok(messageBytes(message) <= MAX_OUTGOING_MESSAGE_BYTES);
  if (card.body?.length === 2) {
    assert.ok(answerOf(card).text.length < text.length, 'a body-shortening notice requires actual body shortening');
  } else {
    assert.ok(answerOf(card).text === text, 'unchanged body needs no notice');
  }
});

test('a first grapheme larger than the budget terminates with a readable bounded indication', { timeout: 2_000 }, () => {
  const text = 'a' + '\u0301'.repeat(16_000);
  const message = formatText(text);
  const card = cardOf(message);
  assert.ok(messageBytes(message) <= MAX_OUTGOING_MESSAGE_BYTES, 'giant cluster cannot overflow the message');
  assert.equal(answerOf(card).text, '');
  assertShortened(card);
  assert.ok(card.fallbackText);
  assert.ok(card.fallbackText.startsWith('Orka reply'));
  assert.ok(Buffer.byteLength(card.fallbackText, 'utf8') <= 512, 'giant cluster cannot overflow fallback');
  assert.ok(!card.fallbackText.includes('\u0301'), 'fallback does not split the giant cluster');
});

test('formatting ignores routing and internal references and does not mutate frozen inputs', () => {
  for (const text of [finalDelivery.text, 'a'.repeat(MAX_TEXT_BYTES)]) {
    const delivery = {
      ...finalDelivery,
      text,
      taskRef: Object.freeze({ ...finalDelivery.taskRef }),
      sessionRef: Object.freeze({ ...finalDelivery.sessionRef }),
      threadId: 'fixture-thread',
      metadata: Object.freeze({ provider: 'fixture-provider', detail: 'fixture-private-detail' }),
    };
    const before = structuredClone(delivery);
    Object.freeze(delivery);
    const first = formatDelivery(delivery);
    assert.deepEqual(formatDelivery(delivery), first);
    assert.deepEqual(delivery, before);
    assert.deepEqual(first, formatText(text));
  }
});

test('a personal reply is fenced as agent text; an update and a question each say so in one grey line', () => {
  const grey = (text: string) => ({ type: 'TextBlock', text, wrap: true, isSubtle: true, size: 'Small', spacing: 'None' });
  const box = (text: string) => ({ type: 'Container', style: 'emphasis', spacing: 'Small', items: [grey('Written by the agent'), { type: 'TextBlock', text, wrap: true, spacing: 'Small' }] });
  assert.deepEqual(cardOf(formatText('Done.')).body, [box('Done.')]);
  assert.deepEqual(cardOf(formatText('Reading the logs.', 'message')).body, [grey('Still working'), box('Reading the logs.')]);
  // A personal chat needs no name and no mention, so the question has neither.
  assert.deepEqual(cardOf(formatText('Question: which branch?', 'message')).body, [grey('Question'), box('Which branch?')]);
  assert.equal(cardOf(formatText('Reading the logs.', 'message')).fallbackText, 'Orka update: Reading the logs.');
});

test('a failure gives its cause once, fenced, then what to do; Orka\'s own no-cause sentence is not repeated under the heading', () => {
  const heading = { type: 'TextBlock', text: "Couldn't complete the request", weight: 'Bolder', wrap: true, spacing: 'Small', color: 'Attention' };
  const next = { type: 'TextBlock', text: 'Try again, or ask in a different way.', wrap: true, spacing: 'Small' };
  const known = cardOf(formatText('The model ran out of time.', 'error')).body!;
  // The cause is fenced without the agent's caption: Orka may have written it.
  assert.deepEqual(known, [heading, { type: 'Container', style: 'emphasis', spacing: 'Small', items: [{ type: 'TextBlock', text: 'The model ran out of time.', wrap: true }] }, next]);
  for (const text of ['This request could not be completed.', ' This request could not be completed.\n', '']) assert.deepEqual(cardOf(formatText(text, 'error')).body, [heading, next]);
  // Anything else Orka sends is a cause, even one that starts the same way.
  assert.equal(cardOf(formatText('This request could not be completed. Quota reached.', 'error')).body?.length, 3);
});
