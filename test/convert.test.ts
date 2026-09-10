import assert from 'node:assert/strict';
import test from 'node:test';
import type { Activity } from '@microsoft/teams.api';
import { convertActivity } from '../src/teams/convert.js';
import type { ConversionContext, ConversionResult } from '../src/teams/convert.js';
import { MAX_IDENTITY_BYTES, MAX_TEXT_BYTES } from '../src/protocol/types.js';
import { conversionContext, personalMessage, expectedEvent } from './fixtures/incoming.js';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Test-only bridge: real wire payloads can omit roles, unlike SDK Account types.
// These independent synthetic inputs also let us exercise malformed external data.
function rawActivity(overrides: Record<string, unknown> = {}): Readonly<Activity> {
  return freeze({
    type: 'message',
    id: 'fixture-message-1',
    channelId: 'msteams',
    from: { id: '29:fixture-person', name: 'Example Person' },
    recipient: { id: '28:fixture-app', name: 'Orka' },
    conversation: { id: '19:fixture-personal', conversationType: 'personal' },
    channelData: { tenant: { id: '11111111-1111-4111-8111-111111111111' } },
    text: 'Summarize this project.\n\nこんにちは 🧑🏽‍💻',
    ...overrides,
  }) as unknown as Readonly<Activity>;
}

const context = freeze({ ...conversionContext });

function rawContext(overrides: Record<string, unknown>): Readonly<ConversionContext> {
  return freeze({ ...context, ...overrides }) as unknown as Readonly<ConversionContext>;
}

function assertInvalid(result: ConversionResult, reason: string, description?: string) {
  assert.equal(result.kind, 'invalid', description);
  assert.deepEqual(result, { kind: 'invalid', reason }, description);
}

function accepted(activity: Readonly<Activity> = rawActivity(), options = context) {
  const result = convertActivity(activity, options);
  assert.equal(result.kind, 'accepted');
  assert.ok(result.kind === 'accepted');
  return result.event;
}

test('the real converter maps the SDK message to the independent golden event', () => {
  assert.deepEqual(convertActivity(personalMessage, context), { kind: 'accepted', event: expectedEvent });
});

test('conversion emits only the wire allowlist and never mutates frozen input or context', () => {
  const activity = rawActivity({
    replyToId: 'previous-message',
    timestamp: '2026-01-01T00:00:00Z',
    localTimestamp: '2026-01-01T00:00:00Z',
    serviceUrl: 'https://teams-service.example.invalid/',
    metadata: { private: 'not-for-output' },
    attachments: [{ contentType: 'text/plain', content: { text: 'not-activity-text' } }],
    conversationReference: { activityId: 'private-routing-state' },
  });
  const before = structuredClone(activity);
  const first = accepted(activity);
  assert.deepEqual(first, expectedEvent);
  assert.deepEqual(Object.keys(first).sort(), [
    'accountId', 'contextId', 'eventType', 'externalEventId', 'protocolVersion', 'replyTarget', 'sender', 'text',
  ]);
  assert.deepEqual(Object.keys(first.sender).sort(), ['displayName', 'id']);
  assert.deepEqual(accepted(activity), first);
  assert.deepEqual(activity, before);
  assert.deepEqual(context, conversionContext);
});

for (const [name, overrides, reason] of [
  ['typing', { type: 'typing' }, 'unsupported-activity'],
  ['join notification', { type: 'conversationUpdate', membersAdded: [{ id: 'new-person' }] }, 'unsupported-activity'],
  ['edit', { type: 'messageUpdate', channelData: { eventType: 'editMessage' } }, 'unsupported-activity'],
  ['undelete', { type: 'messageUpdate', channelData: { eventType: 'undeleteMessage' } }, 'unsupported-activity'],
  ['delete', { type: 'messageDelete', channelData: { eventType: 'softDeleteMessage' } }, 'unsupported-activity'],
  ['non-Teams channel', { channelId: 'webchat' }, 'unsupported-activity'],
  ['group chat', { conversation: { id: 'group', conversationType: 'groupChat' } }, 'unsupported-conversation'],
  ['channel', { conversation: { id: 'channel', conversationType: 'channel', isGroup: false } }, 'unsupported-conversation'],
  ['contradictory personal group', { conversation: { id: 'group', conversationType: 'personal', isGroup: true } }, 'unsupported-conversation'],
  ['explicit bot role', { from: { id: 'ordinary-id', role: 'bot' } }, 'bot-message'],
  ['explicit skill role', { from: { id: 'ordinary-id', role: 'skill' } }, 'bot-message'],
  ['explicit bot account', { from: { id: 'ordinary-id', role: 'user', type: 'bot' } }, 'bot-message'],
  ['identifiable self', { from: { id: '28:fixture-app' } }, 'bot-message'],
  ['self even with user role', { from: { id: '28:fixture-app', role: 'user' } }, 'bot-message'],
  ['missing text', { text: undefined }, 'empty-text'],
  ['empty text', { text: '' }, 'empty-text'],
  ['whitespace-only text', { text: ' \t\r\n\u2003\u00a0 ' }, 'empty-text'],
  ['attachment only', { text: undefined, attachments: [{ content: { text: 'not-a-request' } }] }, 'empty-text'],
] as const) {
  test(`ignores ${name}`, () => {
    assert.deepEqual(convertActivity(rawActivity(overrides), context), { kind: 'ignored', reason });
  });
}

for (const eventType of ['editMessage', 'undeleteMessage', 'softDeleteMessage', 'future-event']) {
  test(`a message with event marker ${eventType} is not a new request`, () => {
    assert.deepEqual(convertActivity(rawActivity({
      channelData: { tenant: { id: context.tenantId }, eventType },
    }), context), { kind: 'ignored', reason: 'unsupported-activity' });
  });
}

test('documented role-less accounts and optional tenant fields are eligible candidates', () => {
  for (const overrides of [
    {},
    { channelData: undefined, conversation: { id: '19:fixture-personal', conversationType: 'personal', tenantId: context.tenantId } },
    { conversation: { id: '19:fixture-personal', conversationType: 'personal', tenantId: context.tenantId, isGroup: false } },
    { from: { id: '29:fixture-person', name: 'Example Person', role: 'user', type: 'person' } },
    { recipient: undefined },
    { recipient: { name: 'unidentified recipient', role: 42, properties: null } },
  ]) assert.deepEqual(accepted(rawActivity(overrides)), expectedEvent);
});

test('stable sender IDs are not replaced by names, AAD IDs, or prefix heuristics', () => {
  for (const id of ['28:not-self', '29:another-person', 'unprefixed', 'Person@EXAMPLE.invalid']) {
    const event = accepted(rawActivity({ from: { id, name: 'Shared Name', aadObjectId: 'not-the-sender-id' } }));
    assert.deepEqual(event.sender, { id, displayName: 'Shared Name' });
    assert.equal(event.externalEventId, expectedEvent.externalEventId, 'sender is not an event identity component');
  }
});

test('tenant, conversation and activity identity each change the event ID case-sensitively', () => {
  const events = [
    accepted(),
    accepted(rawActivity({ channelData: { tenant: { id: 'OTHER-tenant' } } }), { ...context, tenantId: 'OTHER-tenant' }),
    accepted(rawActivity({ channelData: { tenant: { id: 'other-tenant' } } }), { ...context, tenantId: 'other-tenant' }),
    accepted(rawActivity({ conversation: { id: '19:Fixture-personal', conversationType: 'personal' } })),
    accepted(rawActivity({ id: 'Fixture-message-1' })),
  ];
  assert.equal(new Set(events.map(event => event.externalEventId)).size, events.length);
  assert.equal(events[1]?.accountId, 'OTHER-tenant');
  assert.equal(events[3]?.contextId, '19:Fixture-personal');
});

for (const [name, overrides, reason] of [
  ['no tenant claims', { channelData: {} }, 'missing-identity'],
  ['empty channel tenant', { channelData: { tenant: { id: '' } } }, 'missing-identity'],
  ['missing channel tenant ID', { channelData: { tenant: {} } }, 'missing-identity'],
  ['wrong tenant', { channelData: { tenant: { id: 'another-tenant' } } }, 'tenant-mismatch'],
  ['conflicting conversation claim', { conversation: { id: 'chat', conversationType: 'personal', tenantId: 'another-tenant' } }, 'tenant-mismatch'],
  ['conflicting channel claim', { channelData: { tenant: { id: 'another-tenant' } }, conversation: { id: 'chat', conversationType: 'personal', tenantId: context.tenantId } }, 'tenant-mismatch'],
  ['malformed conversation claim despite matching channel claim', { conversation: { id: 'chat', conversationType: 'personal', tenantId: null } }, 'invalid-field'],
  ['malformed channel claim despite matching conversation claim', { channelData: { tenant: { id: null } }, conversation: { id: 'chat', conversationType: 'personal', tenantId: context.tenantId } }, 'invalid-field'],
  ['empty conversation claim despite matching channel claim', { conversation: { id: 'chat', conversationType: 'personal', tenantId: '' } }, 'missing-identity'],
  ['numeric tenant claim', { channelData: { tenant: { id: 17 } } }, 'invalid-field'],
  ['null tenant container', { channelData: { tenant: null } }, 'invalid-field'],
  ['array tenant container', { channelData: { tenant: [] } }, 'invalid-field'],
  ['missing activity ID', { id: undefined }, 'missing-identity'],
  ['empty activity ID', { id: '' }, 'missing-identity'],
  ['null activity ID', { id: null }, 'invalid-field'],
  ['numeric activity ID', { id: 17 }, 'invalid-field'],
  ['missing sender', { from: undefined }, 'missing-identity'],
  ['missing sender ID', { from: {} }, 'missing-identity'],
  ['missing sender ID despite name and AAD ID', { from: { name: 'Person', aadObjectId: 'not-a-sender-id' } }, 'missing-identity'],
  ['malformed sender ID', { from: { id: [] } }, 'invalid-field'],
  ['null sender', { from: null }, 'invalid-field'],
  ['array sender', { from: [] }, 'invalid-field'],
  ['missing conversation', { conversation: undefined }, 'missing-identity'],
  ['null conversation', { conversation: null }, 'invalid-field'],
  ['array conversation', { conversation: [] }, 'invalid-field'],
  ['missing conversation ID', { conversation: { conversationType: 'personal' } }, 'missing-identity'],
  ['malformed conversation ID', { conversation: { id: {}, conversationType: 'personal' } }, 'invalid-field'],
  ['null channel data', { channelData: null }, 'invalid-field'],
  ['array channel data', { channelData: [] }, 'invalid-field'],
  ['null text', { text: null }, 'invalid-field'],
  ['object text', { text: { text: 'not-a-string' } }, 'invalid-field'],
] as const) {
  test(`rejects ${name}`, () => {
    assert.deepEqual(convertActivity(rawActivity(overrides), context), { kind: 'invalid', reason });
  });
}

for (const [name, overrides] of [
  ['missing activity type', { type: undefined }],
  ['object activity type', { type: {} }],
  ['missing channel', { channelId: undefined }],
  ['numeric channel', { channelId: 12 }],
  ['missing conversation type even with isGroup false', { conversation: { id: 'chat', isGroup: false } }],
  ['object conversation type', { conversation: { id: 'chat', conversationType: {}, isGroup: false } }],
  ['string isGroup', { conversation: { id: 'chat', conversationType: 'personal', isGroup: 'false' } }],
  ['null isGroup', { conversation: { id: 'chat', conversationType: 'personal', isGroup: null } }],
  ['numeric role', { from: { id: 'person', role: 1 } }],
  ['unknown role', { from: { id: 'person', role: 'administrator' } }],
  ['object account type', { from: { id: 'person', type: {} } }],
  ['null event marker', { channelData: { tenant: { id: context.tenantId }, eventType: null } }],
  ['array event marker', { channelData: { tenant: { id: context.tenantId }, eventType: [] } }],
  ['empty event marker', { channelData: { tenant: { id: context.tenantId }, eventType: '' } }],
] as const) {
  test(`malformed discriminator: ${name}`, () => {
    assert.deepEqual(convertActivity(rawActivity(overrides), context), { kind: 'invalid', reason: 'invalid-field' });
  });
}

for (const text of [
  '  Leading\ttext\r\n\n```ts\nconst x = "quoted";\n```\n  ',
  'こんにちは مرحبا 中文 हिन्दी e\u0301 🧑🏽‍💻 👨‍👩‍👧‍👦 🇺🇳',
]) {
  test(`preserves useful text verbatim: ${JSON.stringify(text)}`, () => {
    assert.equal(accepted(rawActivity({ text, attachments: null })).text, text);
  });
}

const identityCases: Array<[string, (value: unknown) => ConversionResult]> = [
  ['configured tenant', value => convertActivity(rawActivity({ channelData: { tenant: { id: value } } }), rawContext({ tenantId: value }))],
  ['conversation', value => convertActivity(rawActivity({ conversation: { id: value, conversationType: 'personal' } }), context)],
  ['activity', value => convertActivity(rawActivity({ id: value }), context)],
  ['sender', value => convertActivity(rawActivity({ from: { id: value } }), context)],
  ['reply target', value => convertActivity(rawActivity(), rawContext({ replyTarget: value }))],
];
const unsafeIdentityValues = [
  '\ud800', '\udfff', 'x\ud800y', '\udc00\ud800', '\ud800\ud800',
  'x\u0000y', 'x\u001fy', 'x\u007fy', 'x\u0080y', 'x\u0085y', 'x\u009fy',
  'x\ty', 'x\ny', 'x\ry', ' x', 'x ', '\u00a0x', 'x\u2003', '\u0085x', 'x\u3000',
];

for (const [name, convert] of identityCases) {
  test(`${name} identity requires a nonempty string`, () => {
    for (const [value, reason] of [
      [undefined, 'missing-identity'], ['', 'missing-identity'],
      [null, 'invalid-field'], [42, 'invalid-field'], [[], 'invalid-field'], [{}, 'invalid-field'],
    ] as const) assertInvalid(convert(value), reason, `${name}: ${JSON.stringify(value)}`);
  });
  test(`${name} identity rejects unsafe Unicode, controls and boundary whitespace`, () => {
    for (const value of unsafeIdentityValues) assertInvalid(convert(value), 'invalid-field', JSON.stringify(value));
  });
  test(`${name} identity accepts exactly 256 UTF-8 bytes and rejects excess without truncation`, () => {
    for (const value of ['a'.repeat(MAX_IDENTITY_BYTES), '😀'.repeat(64), '界'.repeat(85) + 'x']) {
      assert.equal(Buffer.byteLength(value, 'utf8'), 256);
      assert.equal(convert(value).kind, 'accepted');
      assertInvalid(convert(value + 'x'), 'field-too-large');
    }
  });
  test(`${name} identity accepts format characters, internal spaces and valid surrogate pairs`, () => {
    for (const value of ['\ufeffID\ufeff', 'a b', '会話🧑🏽‍💻', '\ud800\udc00', 'e\u0301', '\u200bID']) {
      assert.equal(convert(value).kind, 'accepted', JSON.stringify(value));
    }
  });
}

for (const location of ['channelData', 'conversation'] as const) {
  test(`${location} tenant claim cannot hide malformed or oversized values behind a matching claim`, () => {
    for (const value of [undefined, '', null, 42, ...unsafeIdentityValues, 'a'.repeat(257)]) {
      // A missing conversation.tenantId is legitimate; an explicit tenant:{} is not a claim ID.
      if (location === 'conversation' && value === undefined) continue;
      const overrides = location === 'channelData'
        ? { channelData: { tenant: { id: value } }, conversation: { id: 'chat', conversationType: 'personal', tenantId: context.tenantId } }
        : { conversation: { id: 'chat', conversationType: 'personal', tenantId: value } };
      const reason = value === undefined || value === '' ? 'missing-identity'
        : value === 'a'.repeat(257) ? 'field-too-large' : 'invalid-field';
      assertInvalid(convertActivity(rawActivity(overrides), context), reason, JSON.stringify(value));
    }
  });
}

test('opaque IDs and format characters are preserved without normalization', () => {
  const event = accepted(rawActivity({
    from: { id: '\ufeffPerson e\u0301\ufeff', name: '\ufeffLabel\ufeff' },
    conversation: { id: '\ufeffChat\ufeff', conversationType: 'personal' },
    channelData: { tenant: { id: '\ufeffTenant\ufeff' } },
  }), { tenantId: '\ufeffTenant\ufeff', replyTarget: '\ufeffOpaque Key\ufeff' });
  assert.equal(event.accountId, '\ufeffTenant\ufeff');
  assert.equal(event.contextId, '\ufeffChat\ufeff');
  assert.deepEqual(event.sender, { id: '\ufeffPerson e\u0301\ufeff', displayName: '\ufeffLabel\ufeff' });
  assert.equal(event.replyTarget, '\ufeffOpaque Key\ufeff');
});

test('text is bounded by UTF-8 bytes, never shortened or counted as UTF-16 units', () => {
  for (const text of ['a'.repeat(MAX_TEXT_BYTES), '😀'.repeat(16_384), '界'.repeat(21_845) + 'x']) {
    assert.equal(Buffer.byteLength(text, 'utf8'), 65_536);
    assert.equal(accepted(rawActivity({ text })).text, text);
    assertInvalid(convertActivity(rawActivity({ text: text + 'x' }), context), 'field-too-large');
  }
});

test('text rejects lone surrogates and all Cc controls other than TAB, LF and CR', () => {
  const controls = Array.from({ length: 160 }, (_, code) => code)
    .filter(code => (code < 32 || code >= 127) && ![9, 10, 13].includes(code));
  for (const text of ['\ud800', '\udfff', 'a\ud800b', '\udc00\ud800', ...controls.map(code => `a${String.fromCharCode(code)}b`)]) {
    assertInvalid(convertActivity(rawActivity({ text }), context), 'invalid-field', JSON.stringify(text));
  }
  assertInvalid(convertActivity(rawActivity({ text: '\u0085' }), context), 'invalid-field');
  assertInvalid(convertActivity(rawActivity({ text: ' '.repeat(MAX_TEXT_BYTES + 1) }), context), 'field-too-large');
});

test('text accepts format characters and valid surrogate pairs without treating FEFF as White_Space', () => {
  for (const text of ['\ufeff', '\u200b', '\ud800\udc00', 'a\tb\nc\rd', '\u200d', 'a\u2028b\u2029c']) {
    assert.equal(accepted(rawActivity({ text })).text, text);
  }
});

for (const [description, name, expected] of [
  ['absent', undefined, { id: 'person' }],
  ['empty', '', { id: 'person' }],
  ['whitespace-only', ' \u00a0\u2003 ', { id: 'person' }],
  ['boundary whitespace', ' \u00a0Label e\u0301\u2003 ', { id: 'person', displayName: 'Label e\u0301' }],
  ['emoji', 'Label 🧑🏽‍💻', { id: 'person', displayName: 'Label 🧑🏽‍💻' }],
  ['exact ASCII limit', 'a'.repeat(256), { id: 'person', displayName: 'a'.repeat(256) }],
  ['exact multibyte limit', '😀'.repeat(64), { id: 'person', displayName: '😀'.repeat(64) }],
] as const) {
  test(`optional display label is normalized or omitted: ${description}`, () => {
    assert.deepEqual(accepted(rawActivity({ from: { id: 'person', name } })).sender, expected);
  });
}

test('display labels validate raw bytes, types, controls and Unicode before trimming', () => {
  for (const [name, reason] of [
    [null, 'invalid-field'], [42, 'invalid-field'], [{}, 'invalid-field'],
    ['\ud800', 'invalid-field'], ['\udfff', 'invalid-field'],
    ['Label\u0085', 'invalid-field'], ['\tLabel', 'invalid-field'], ['Label\n', 'invalid-field'],
    ['Label\u0000', 'invalid-field'], ['Label\u009f', 'invalid-field'],
    [' '.repeat(256) + 'x', 'field-too-large'], [' '.repeat(257), 'field-too-large'],
    ['😀'.repeat(65), 'field-too-large'],
  ] as const) assertInvalid(convertActivity(rawActivity({ from: { id: 'person', name } }), context), reason);
});

test('only a supplied recipient identity is validated; recipient metadata does not classify humans', () => {
  for (const recipient of [null, [], { id: null }, { id: 42 }, { id: '\ud800' }, { id: ' app' }]) {
    assertInvalid(convertActivity(rawActivity({ recipient }), context), 'invalid-field');
  }
  assertInvalid(convertActivity(rawActivity({ recipient: { id: 'a'.repeat(257) } }), context), 'field-too-large');
  assert.deepEqual(accepted(rawActivity({ recipient: { id: '28:fixture-app', name: 42, role: {} } })), expectedEvent);
});

test('malformed root activity and context return safe results without throwing', () => {
  for (const value of [undefined, null, [], 'message', 42]) {
    // Deliberately cross the external-input boundary; not a production cast.
    assertInvalid(convertActivity(value as unknown as Activity, context), 'invalid-field');
    assertInvalid(convertActivity(rawActivity(), value as unknown as ConversionContext), 'invalid-field');
  }
});

for (const [name, overrides] of [
  ['activity type', (value: string) => ({ type: value })],
  ['channel', (value: string) => ({ channelId: value })],
  ['conversation type', (value: string) => ({ conversation: { id: 'chat', conversationType: value } })],
  ['event marker', (value: string) => ({ channelData: { tenant: { id: context.tenantId }, eventType: value } })],
  ['account type', (value: string) => ({ from: { id: 'person', type: value } })],
  ['account role', (value: string) => ({ from: { id: 'person', role: value } })],
] as const) {
  test(`${name} discriminator validates consumed Unicode, controls, whitespace and bounds`, () => {
    for (const value of ['\ud800', 'value\u0000', ' value', 'value ', 'a'.repeat(257)]) {
      assertInvalid(convertActivity(rawActivity(overrides(value)), context), value.length === 257 ? 'field-too-large' : 'invalid-field');
    }
  });
}
