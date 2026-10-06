import assert from 'node:assert/strict';
import test from 'node:test';
import type { Activity } from '@microsoft/teams.api';
import { convertActivity } from '../src/teams/convert.js';
import { MAX_IDENTITY_BYTES, MAX_TEXT_BYTES } from '../src/protocol/types.js';
import { conversionContext, expectedEvent, personalMessage } from './fixtures/incoming.js';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const context = freeze({ ...conversionContext });
const botId = '28:fixture-app';
const botText = '<at>Orka</at>';
const sender = { id: '29:fixture-person', aadObjectId: 'fixture-aad-person', name: ' Example Person ' };

function mention(id: unknown = botId, text: unknown = botText) {
  return { type: 'mention', mentioned: { id, name: 'unused label' }, text };
}

// Synthetic external payloads deliberately cross the SDK's static-only boundary.
function activity(overrides: Record<string, unknown> = {}): Readonly<Activity> {
  return freeze({
    type: 'message',
    id: 'fixture-message-1',
    channelId: 'msteams',
    from: sender,
    recipient: { id: botId, name: 42, role: {} },
    conversation: { id: '19:fixture-personal', conversationType: 'groupChat', isGroup: true },
    channelData: { tenant: { id: context.tenantId } },
    entities: [mention()],
    text: `${botText} Summarize this project.\n\nこんにちは 🧑🏽‍💻`,
    ...overrides,
  }) as unknown as Readonly<Activity>;
}

function accepted(input: Readonly<Activity> = activity()) {
  const result = convertActivity(input, context);
  assert.equal(result.kind, 'accepted');
  assert.ok(result.kind === 'accepted');
  return result.event;
}

function invalid(overrides: Record<string, unknown>, reason = 'invalid-field') {
  assert.deepEqual(convertActivity(activity(overrides), context), { kind: 'invalid', reason });
}

for (const conversationType of ['groupChat', 'channel'] as const) {
  test(`${conversationType} maps AAD sender and emits only normalized wire fields`, () => {
    const input = activity({
      conversation: { id: expectedEvent.contextId, conversationType },
      serviceUrl: 'https://fixture.example.invalid/',
      attachments: [{ content: { text: 'unused' } }],
      metadata: { unused: 'unused' },
      timestamp: 'unused',
    });
    const before = structuredClone(input);
    assert.deepEqual(accepted(input), {
      ...expectedEvent,
      sender: { id: sender.aadObjectId, displayName: 'Example Person' },
      ...(conversationType === 'channel' ? { threadId: 'fixture-message-1' } : {}),
    });
    assert.deepEqual(input, before);
    assert.deepEqual(context, conversionContext);
  });
}

test('groupChat never maps a reply or thread-looking context to threadId', () => {
  const event = accepted(activity({
    conversation: { id: '19:group;messageid=not-a-channel-root', conversationType: 'groupChat' },
    replyToId: { unused: true },
    channelData: { tenant: { id: context.tenantId }, channel: { id: 'not-the-context' } },
  }));
  assert.equal(event.contextId, '19:group;messageid=not-a-channel-root');
  assert.equal(Object.hasOwn(event, 'threadId'), false);
});

for (const [description, conversationId, activityId, replyToId, root] of [
  ['documented suffix', '19:channel@thread.skype;messageid=root-1', 'reply-2', undefined, 'root-1'],
  ['matching suffix and reply', '19:channel@thread.skype;messageid=root-1', 'reply-2', 'root-1', 'root-1'],
  ['replyToId without suffix', '19:channel@thread.skype', 'reply-2', 'root-1', 'root-1'],
  ['top-level activity fallback', '19:channel@thread.skype', 'root-1', undefined, 'root-1'],
  ['top-level suffix', '19:channel@thread.skype;messageid=root-1', 'root-1', undefined, 'root-1'],
  ['opaque root preserved', '19:channel;messageid=Root e\u0301🧑🏽‍💻', 'reply-2', 'Root e\u0301🧑🏽‍💻', 'Root e\u0301🧑🏽‍💻'],
] as const) {
  test(`channel root extraction: ${description}`, () => {
    const event = accepted(activity({
      id: activityId,
      conversation: { id: conversationId, conversationType: 'channel' },
      ...(replyToId === undefined ? {} : { replyToId }),
      channelData: { tenant: { id: context.tenantId }, channel: { id: 'not-a-root' }, team: { id: 'not-a-root' } },
    }));
    assert.equal(event.contextId, conversationId);
    assert.equal(event.threadId, root);
  });
}

for (const [description, id, replyToId, reason] of [
  ['contradictory roots', '19:channel;messageid=root-1', 'root-2', 'invalid-field'],
  ['empty suffix', '19:channel;messageid=', undefined, 'missing-identity'],
  ['no conversation before suffix', ';messageid=root-1', undefined, 'invalid-field'],
  ['multiple suffixes', '19:channel;messageid=root-1;messageid=root-2', undefined, 'invalid-field'],
  ['nonterminal suffix', '19:channel;messageid=root-1;other=value', undefined, 'invalid-field'],
  ['malformed known suffix', '19:channel;messageid', undefined, 'invalid-field'],
  ['suffix boundary whitespace', '19:channel;messageid= root-1', undefined, 'invalid-field'],
  ['empty reply identity', '19:channel', '', 'missing-identity'],
  ['null reply identity', '19:channel', null, 'invalid-field'],
  ['numeric reply identity', '19:channel', 42, 'invalid-field'],
  ['unsafe reply identity', '19:channel', 'root\ud800', 'invalid-field'],
  ['oversized reply identity', '19:channel', 'x'.repeat(257), 'field-too-large'],
] as const) {
  test(`channel fails closed: ${description}`, () => {
    invalid({ conversation: { id, conversationType: 'channel' }, replyToId }, reason);
  });
}

test('shared text removes only exact bot mentions and retains other mentions and useful whitespace', () => {
  const otherText = '<at>Other Person</at>';
  const event = accepted(activity({
    entities: [mention('29:other', otherText), mention(), mention(botId, '<at>Second Bot Label</at>')],
    text: `  ${botText}\n Ask ${otherText}\tto review ${botText} and <at>Second Bot Label</at>.  `,
  }));
  assert.equal(event.text, `Ask ${otherText}\tto review  and .`);
});

test('repeated mention entities do not remove unrelated text', () => {
  assert.equal(accepted(activity({ entities: [mention(), mention()], text: `${botText} Orka stays. ${botText}` })).text,
    'Orka stays.');
});

for (const text of [botText, ` \t${botText}\n\u2003 `, `${botText} ${botText}`]) {
  test('a verified bot-mention-only request is empty after removal', () => {
    assert.deepEqual(convertActivity(activity({ text }), context), { kind: 'ignored', reason: 'empty-text' });
  });
}

for (const entities of [undefined, [], [mention('29:another-app')], [mention('28:FIXTURE-app')], [{ type: 'clientInfo', arbitrary: null }]]) {
  test('shared requests without an exact bot mention are ignored', () => {
    assert.deepEqual(convertActivity(activity({ entities }), context), { kind: 'ignored', reason: 'unmentioned' });
  });
}

for (const [description, entities, reason] of [
  ['non-array entities', {}, 'invalid-field'],
  ['null entities', null, 'invalid-field'],
  ['non-object entity', [null], 'invalid-field'],
  ['malformed entity discriminator', [{ type: 42 }], 'invalid-field'],
  ['missing mentioned account', [{ type: 'mention', text: botText }], 'missing-identity'],
  ['null mentioned account', [{ type: 'mention', mentioned: null, text: botText }], 'invalid-field'],
  ['missing mention target', [{ type: 'mention', mentioned: {}, text: botText }], 'missing-identity'],
  ['empty mention target', [mention('')], 'missing-identity'],
  ['numeric mention target', [mention(42)], 'invalid-field'],
  ['unsafe mention target', [mention('id\ud800')], 'invalid-field'],
  ['oversized mention target', [mention('x'.repeat(257))], 'field-too-large'],
  ['null bot mention text', [mention(botId, null)], 'invalid-field'],
  ['empty bot mention text', [mention(botId, '')], 'missing-identity'],
  ['unsafe bot mention text', [mention(botId, '\ud800')], 'invalid-field'],
  ['oversized bot mention text', [mention(botId, 'x'.repeat(257))], 'field-too-large'],
  ['bot mention text absent from activity text', [mention(botId, '<at>Absent</at>')], 'invalid-field'],
  ['one valid mention cannot mask an invalid bot mention', [mention(), mention(botId, null)], 'invalid-field'],
] as const) {
  test(`shared mention validation: ${description}`, () => invalid({ entities }, reason));
}

test('ambiguous mention text cannot strip another recipient mention', () => {
  invalid({ entities: [mention(), mention('29:other', botText)] });
  invalid({ entities: [mention(botId, 'Bot'), mention('29:other', '<at>Bot Person</at>')], text: '<at>Bot Person</at>' });
  invalid({ entities: [mention(botId, 'abc'), mention('29:other', 'bcd')], text: 'abcd' });
});

for (const [name, make] of [
  ['AAD sender', (value: unknown) => ({ from: { ...sender, aadObjectId: value } })],
  ['Teams sender used for self detection', (value: unknown) => ({ from: { ...sender, id: value } })],
  ['recipient', (value: unknown) => ({ recipient: { id: value } })],
] as const) {
  test(`shared ${name} validates consumed identity`, () => {
    for (const [value, reason] of [
      [undefined, 'missing-identity'], ['', 'missing-identity'], [null, 'invalid-field'],
      [42, 'invalid-field'], [[], 'invalid-field'], ['\ud800', 'invalid-field'],
      ['id\u0000', 'invalid-field'], [' id', 'invalid-field'], ['id ', 'invalid-field'],
      ['x'.repeat(257), 'field-too-large'],
    ] as const) invalid(make(value), reason);
  });
}

test('shared recipient is mandatory, not inferred from mention labels or AAD metadata', () => {
  invalid({ recipient: undefined }, 'missing-identity');
  invalid({ recipient: null });
  invalid({ recipient: { name: 'Orka', aadObjectId: botId } }, 'missing-identity');
});

test('shared bot and self detection still uses role/type and exact Teams account ID', () => {
  for (const from of [
    { ...sender, role: 'bot' }, { ...sender, role: 'skill' }, { ...sender, type: 'bot' },
    { id: botId }, { id: botId, aadObjectId: 'not-the-bot', role: 'user' },
  ]) assert.deepEqual(convertActivity(activity({ from }), context), { kind: 'ignored', reason: 'bot-message' });
  assert.equal(accepted(activity({ from: { ...sender, aadObjectId: botId } })).sender.id, botId);
});

test('shared AAD mapping preserves identity bytes and optional label normalization', () => {
  for (const id of ['x'.repeat(MAX_IDENTITY_BYTES), '😀'.repeat(64), '\ufeffID\ufeff', 'Case e\u0301']) {
    assert.deepEqual(accepted(activity({ from: { ...sender, aadObjectId: id, name: ' \u2003 ' } })).sender, { id });
  }
  invalid({ from: { ...sender, name: 42 } });
  invalid({ from: { ...sender, name: '\ud800' } });
  invalid({ from: { ...sender, name: 'x'.repeat(257) } }, 'field-too-large');
});

test('shared raw text is validated before stripping or trimming', () => {
  invalid({ text: `${botText}\u0000` });
  invalid({ text: `${botText}\ud800` });
  invalid({ text: `${botText}${'x'.repeat(MAX_TEXT_BYTES)}` }, 'field-too-large');
  const remainingBytes = MAX_TEXT_BYTES - Buffer.byteLength(botText);
  const text = botText + '😀'.repeat(Math.floor(remainingBytes / 4)) + 'x'.repeat(remainingBytes % 4);
  assert.equal(Buffer.byteLength(text), MAX_TEXT_BYTES);
  assert.equal(accepted(activity({ text })).text, text.slice(botText.length));
});

test('shared tenant, conversation and activity fields retain existing validation', () => {
  invalid({ channelData: { tenant: { id: 'other-tenant' } } }, 'tenant-mismatch');
  invalid({ channelData: { tenant: { id: context.tenantId } }, conversation: { id: 'group', conversationType: 'groupChat', tenantId: null } });
  invalid({ id: '' }, 'missing-identity');
  invalid({ conversation: { id: ' group', conversationType: 'groupChat' } });
  invalid({ conversation: { id: 'x'.repeat(257), conversationType: 'groupChat' } }, 'field-too-large');
  invalid({ conversation: { id: 'group', conversationType: 'groupChat', isGroup: 'true' } });
});

for (const recipient of [botId, '29:other'] as const) {
  test(`aggregate overlapping ${recipient === botId ? 'bot' : 'other'} tokens fail closed before amplified matching`, () => {
    const text = 'B' + 'x'.repeat(MAX_TEXT_BYTES - 1);
    const entities = [mention(botId, 'B'), ...Array.from({ length: 256 }, (_, n) => mention(recipient, 'x'.repeat(n + 1)))];
    assert.ok(Buffer.byteLength(JSON.stringify({ text, entities })) < 256 * 1024);
    const result = convertActivity(activity({ text, entities }), context);
    assert.equal(result.kind, 'invalid'); if (result.kind === 'invalid') assert.equal(result.reason, 'invalid-field');
  });
}

test('sublimit mention count still refuses aggregate scan work before enumeration', () => {
  const text = 'B' + 'x'.repeat(MAX_TEXT_BYTES - 1);
  const entities = [mention(botId, 'B'), ...Array.from({ length: 32 }, (_, n) => mention('29:other', 'x'.repeat(n + 1)))];
  const result = convertActivity(activity({ text, entities }), context);
  assert.equal(result.kind, 'invalid'); if (result.kind === 'invalid') assert.equal(result.reason, 'invalid-field');
});

test('one heavily repeated token consumes an aggregate occurrence budget rather than scanning every overlap', () => {
  const text = 'x'.repeat(MAX_TEXT_BYTES);
  assert.deepEqual(convertActivity(activity({ text, entities: [mention(botId, 'x')] }), context), { kind: 'invalid', reason: 'invalid-field' });
});

test('a single heavily repeated other-recipient token also consumes the occurrence budget', () => {
  const text = 'B' + 'x'.repeat(MAX_TEXT_BYTES - 1);
  const result = convertActivity(activity({ text, entities: [mention(botId, 'B'), mention('29:other', 'x')] }), context);
  assert.equal(result.kind, 'invalid'); if (result.kind === 'invalid') assert.equal(result.reason, 'invalid-field');
});

test('many distinct short-input tokens cannot bypass the token budget', () => {
  const entities = [mention(botId, 'B'), ...Array.from({ length: 64 }, (_, n) => mention('29:other', 'absent-' + n))];
  assert.deepEqual(convertActivity(activity({ text: 'B request', entities }), context), { kind: 'invalid', reason: 'invalid-field' });
});

test('bounded overlapping bot tokens still preserve all disjoint other mention text', () => {
  const text = 'abcabc <at>Other Person</at> request';
  assert.equal(accepted(activity({ text, entities: [mention(botId, 'abc'), mention(botId, 'bc'), mention('29:other', '<at>Other Person</at>')] })).text,
    '<at>Other Person</at> request');
});

test('personal fixtures remain byte-identical and ignore unused shared fields', () => {
  assert.deepEqual(convertActivity(personalMessage, context), { kind: 'accepted', event: expectedEvent });
  const input = activity({
    conversation: { id: expectedEvent.contextId, conversationType: 'personal' },
    from: { id: expectedEvent.sender.id, name: expectedEvent.sender.displayName, aadObjectId: null },
    recipient: undefined,
    entities: null,
    replyToId: { unused: true },
    text: expectedEvent.text,
  });
  assert.deepEqual(convertActivity(input, context), { kind: 'accepted', event: expectedEvent });
  const text = `  ${botText} useful text  `;
  assert.equal(accepted(activity({
    conversation: { id: expectedEvent.contextId, conversationType: 'personal' }, text,
  })).text, text);
});
