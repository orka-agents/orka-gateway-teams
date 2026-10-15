import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeMeetingDraft, meetingEnd } from '../src/teams/meeting-draft.js';
import { meetingLink, formatMeetingDraft } from '../src/teams/meeting-card.js';

const metadata = { 'meeting.version': '1', 'meeting.subject': 'A + B', 'meeting.durationMinutes': '30',
  'meeting.attendees': 'everyone', 'meeting.agenda.0': 'Review [design]' };

test('closed typed projection decodes without parsing ordinary text or changing fields', () => {
  assert.equal(decodeMeetingDraft(undefined), undefined);
  assert.equal(decodeMeetingDraft({ other: 'hello' }), undefined);
  assert.deepEqual(decodeMeetingDraft(metadata), { subject: 'A + B', durationMinutes: 30, attendees: 'everyone', agenda: ['Review [design]'] });
  const draft = decodeMeetingDraft({ ...metadata, 'meeting.attendees': 'named', 'meeting.name.0': '  Ada  ', 'meeting.name.1': 'Grace',
    'meeting.preferredWindow': 'Next week', 'meeting.suggestedStart': '2028-02-29T23:45:00.123456789+05:30' })!;
  assert.deepEqual(draft.names, ['  Ada  ', 'Grace']); assert.equal(draft.preferredWindow, 'Next week');
  assert.equal(meetingEnd(draft.suggestedStart!, draft.durationMinutes), '2028-03-01T00:15:00.123456789+05:30');
});

for (const patch of [
  { 'meeting.version': '2' }, { 'meeting.version': '' }, { 'meeting.foo': 'x' }, { 'meeting.agenda.2': 'gap' },
  { 'meeting.agenda.5': 'over' }, { 'meeting.subject': '' }, { 'meeting.subject': 'é'.repeat(101) },
  { 'meeting.subject': '\ud800' }, { 'meeting.agenda.0': 'x\n' }, { 'meeting.agenda.0': '界'.repeat(86) },
  { 'meeting.durationMinutes': '0' }, { 'meeting.durationMinutes': '481' }, { 'meeting.durationMinutes': '01' },
  { 'meeting.durationMinutes': '1.5' }, { 'meeting.attendees': 'other' }, { 'meeting.name.0': 'contradiction' },
  { 'meeting.attendees': 'named' }, { 'meeting.attendees': 'named', 'meeting.name.1': 'gap' },
  { 'meeting.attendees': 'named', 'meeting.name.0': 'x@y' }, { 'meeting.attendees': 'named', 'meeting.name.0': 'x'.repeat(129) },
  { 'meeting.preferredWindow': '' }, { 'meeting.preferredWindow': 'x'.repeat(257) },
] as const) test('decoder rejects unknown, missing, gapped, contradictory or out-of-bound draft metadata', () => {
  assert.throws(() => decodeMeetingDraft({ ...metadata, ...patch }), { message: 'Invalid meeting draft.' });
});
for (const value of ['2027-02-29T12:00:00Z', '2028-04-31T12:00:00Z', '2028-01-01T24:00:00Z',
  '2028-01-01T12:00Z', '2028-01-01T12:00:00', '2028-01-01T12:00:60Z', '2028-01-01T12:00:00+24:00',
  '0000-01-01T12:00:00Z', '9999-12-31T23:50:00Z', '2028-01-01T12:00:00.1234567890Z']) {
  test('suggested start rejects relaxed/invalid ISO or overflowing computed end', () => {
    assert.throws(() => decodeMeetingDraft({ ...metadata, 'meeting.suggestedStart': value }));
  });
}
test('maximum fixed projection (21 keys) preserves exact draft bounds', () => {
  const m: Record<string, string> = { ...metadata, 'meeting.subject': 's'.repeat(200), 'meeting.attendees': 'named',
    'meeting.durationMinutes': '480', 'meeting.preferredWindow': 'w'.repeat(256), 'meeting.suggestedStart': '2028-02-29T12:00:00Z' };
  for (let i = 0; i < 5; i++) m[`meeting.agenda.${i}`] = 'a'.repeat(256);
  for (let i = 0; i < 10; i++) m[`meeting.name.${i}`] = 'n'.repeat(128);
  assert.equal(Object.keys(m).length, 21); const draft = decodeMeetingDraft(m)!;
  assert.equal(draft.agenda.length, 5); assert.equal(draft.names?.length, 10);
});
test('fixed meeting URL independently encodes fields, never adds duration or guessed times', () => {
  const draft = decodeMeetingDraft(metadata)!;
  assert.equal(meetingLink(draft, ['one@example.test', 'guest_x#EXT#@tenant.test']),
    'https://teams.microsoft.com/l/meeting/new?subject=A%20%2B%20B&attendees=one%40example.test%2Cguest_x%23EXT%23%40tenant.test&content=Review%20%5Bdesign%5D');
  const timed = decodeMeetingDraft({ ...metadata, 'meeting.suggestedStart': '2028-02-29T23:45:00+05:30' })!;
  const url = meetingLink(timed, ['one@example.test'])!;
  assert.ok(url.includes('startTime=2028-02-29T23%3A45%3A00%2B05%3A30'));
  assert.ok(url.includes('endTime=2028-03-01T00%3A15%3A00%2B05%3A30'));
  assert.equal(url.includes('duration'), false); assert.ok(url.length <= 2048); assert.equal(/[^\x20-\x7e]/u.test(url), false);
});
test('maximum escaped structured fields and roster labels fall back visibly without truncating the draft', () => {
  const m: Record<string, string> = { ...metadata, 'meeting.subject': '\\'.repeat(200), 'meeting.attendees': 'named',
    'meeting.durationMinutes': '480', 'meeting.preferredWindow': '\\'.repeat(256), 'meeting.suggestedStart': '2028-02-29T12:00:00Z' };
  for (let i = 0; i < 5; i++) m[`meeting.agenda.${i}`] = '\\'.repeat(256);
  for (let i = 0; i < 10; i++) m[`meeting.name.${i}`] = '\\'.repeat(128);
  const draft = decodeMeetingDraft(m)!;
  const before = JSON.stringify(draft);
  const message = formatMeetingDraft(draft, { labels: Array(10).fill('\\'.repeat(256)), count: 10 },
    'https://teams.microsoft.com/' + 'x'.repeat(2000), { requesterDisplayName: '\\'.repeat(256), replyToId: '\\'.repeat(256) });
  const card = message.attachments[0].content;
  assert.equal(card.actions, undefined); assert.equal(message.text, undefined); assert.equal(message.attachments.length, 1);
  assert.equal(card.version, '1.4'); assert.ok(Buffer.byteLength(card.fallbackText!) <= 512);
  assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 20480); assert.equal(JSON.stringify(draft), before);
  assert.equal(message.replyToId, '\\'.repeat(256));
  const texts = card.body!.map(block => (block as { text: string }).text);
  assert.equal(texts.includes('\\'.repeat(400)), true);
  assert.equal(texts.includes('Preferred window: ' + '\\'.repeat(512)), true);
  assert.equal(texts.some(text => text === 'Agenda:\n' + Array.from({ length: 5 }, (_, i) => `${i + 1}. ${'\\'.repeat(512)}`).join('\n')), true);
  assert.equal(texts.some(text => text === 'Requested attendees: ' + Array(10).fill('\\'.repeat(256)).join(', ')), true);
  assert.equal(texts.some(text => text.includes('10') && text.includes('omitted')), true);
  assert.equal(texts.some(text => text.includes('No partial link or recipient list')), true);
});

test('link overflow never emits a partial action; measured dedicated card preserves every field and room presentation', () => {
  const draft = decodeMeetingDraft({ ...metadata, 'meeting.attendees': 'named', 'meeting.name.0': '[Ada]',
    'meeting.preferredWindow': 'Next week', 'meeting.suggestedStart': '2028-01-01T12:00:00Z' })!;
  assert.equal(meetingLink(draft, Array.from({ length: 100 }, () => 'long-address@example.test')), undefined);
  const message = formatMeetingDraft(draft, { labels: ['[Ada]'], count: 1 }, undefined,
    { requesterDisplayName: '[Owner]', continuation: true, replyToId: 'root' }, 'link-too-long');
  assert.equal(message.text, undefined); assert.equal(message.attachments.length, 1); assert.equal(message.replyToId, 'root');
  const card = message.attachments[0].content; assert.equal(card.version, '1.4'); assert.equal(card.actions, undefined);
  assert.ok(Buffer.byteLength(card.fallbackText!) <= 512); assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 20480);
  const body = JSON.stringify(card.body); for (const text of ['A \\\\+ B', '30 minutes', 'Next week', '2028-01-01T12:00:00Z', 'Nothing scheduled', "Continuing the room's conversation"]) assert.ok(body.includes(text));
  assert.ok(body.includes('\\\\[Ada\\\\]')); assert.ok(body.includes('\\\\[Owner\\\\]'));
  assert.ok(body.includes('Review \\\\[design\\\\]')); assert.ok(body.includes('too long'));
  const action = formatMeetingDraft(draft, { labels: ['You'], count: 1 }, meetingLink(draft, ['one@example.test']));
  assert.equal(action.attachments[0].content.actions?.[0]?.type, 'Action.OpenUrl');
  assert.equal(action.attachments[0].content.actions?.[0]?.title, 'Open in Teams');
});
