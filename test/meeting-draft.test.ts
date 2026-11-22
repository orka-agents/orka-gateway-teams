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
const max = (attendees: 'everyone' | 'named') => { const m: Record<string, string> = { ...metadata, 'meeting.subject': '\\'.repeat(200), 'meeting.attendees': attendees,
  'meeting.durationMinutes': '480', 'meeting.preferredWindow': '\\'.repeat(256), 'meeting.suggestedStart': '2028-02-29T12:00:00Z' };
  for (let i = 0; i < 5; i++) m[`meeting.agenda.${i}`] = '\\'.repeat(256);
  if (attendees === 'named') for (let i = 0; i < 10; i++) m[`meeting.name.${i}`] = '\\'.repeat(128);
  return decodeMeetingDraft(m)!; };
const facts = (card: { body?: unknown[] }) => (card.body!.find((b: any) => b.type === 'FactSet') as any).facts as { title: string; value: string }[];
const lines = (card: { body?: unknown[] }) => card.body!.filter((b: any) => b.type === 'TextBlock').map((b: any) => b.text as string);

test('card layout: caption, bold subject, facts in the viewer\'s local time, agenda, then what happens next', () => {
  const draft = decodeMeetingDraft({ ...metadata, 'meeting.agenda.1': 'Decide', 'meeting.preferredWindow': 'Tuesday afternoon', 'meeting.suggestedStart': '2026-11-24T21:00:00Z' })!;
  const message = formatMeetingDraft(draft, { labels: ['Ada', 'Grace'], count: 2 }, 'https://teams.microsoft.com/l/meeting/new?subject=x', { requesterDisplayName: 'Ada' });
  assert.deepEqual(message.attachments[0].content, { type: 'AdaptiveCard', version: '1.4',
    fallbackText: 'Meeting draft. Nothing scheduled. Review the agenda, duration and time suggestions in Teams.',
    body: [
      { type: 'TextBlock', text: 'Meeting draft · asked by Ada', wrap: true, isSubtle: true, size: 'Small', spacing: 'None' },
      { type: 'TextBlock', text: 'A \\+ B', wrap: true, weight: 'Bolder', size: 'Medium', spacing: 'Small' },
      { type: 'FactSet', spacing: 'Small', facts: [
        // One row says when: a suggested time already carries the length, and the range it came from would only contradict it.
        { title: 'When', value: '{{DATE(2026-11-24T21:00:00Z, SHORT)}} {{TIME(2026-11-24T21:00:00Z)}}–{{TIME(2026-11-24T21:30:00Z)}} (suggested)' },
        { title: 'Who', value: 'Everyone here (2): Ada, Grace' }] },
      { type: 'TextBlock', text: 'Agenda', wrap: true, weight: 'Bolder', size: 'Small', spacing: 'Medium' },
      { type: 'TextBlock', text: '1. Review \\[design\\]\n2. Decide', wrap: true, spacing: 'Small' },
      { type: 'TextBlock', text: 'Nothing is scheduled until you open it in Teams and send it.', wrap: true, isSubtle: true, size: 'Small', spacing: 'Medium' }],
    // The card's only action is the filled one.
    actions: [{ type: 'Action.OpenUrl', title: 'Open in Teams', style: 'positive', url: 'https://teams.microsoft.com/l/meeting/new?subject=x' }] });
});

test('facts: a range alone is "When" with a length; a personal chat has no asker', () => {
  const windowOnly = decodeMeetingDraft({ ...metadata, 'meeting.preferredWindow': 'Next *week*' })!;
  const card = formatMeetingDraft(windowOnly, { labels: [], count: 0 }).attachments[0].content;
  assert.deepEqual(facts(card), [{ title: 'When', value: 'Next \\*week\\*' }, { title: 'Length', value: '30 min' }, { title: 'Who', value: 'Everyone here' }]);
  assert.equal(lines(card)[0], 'Meeting draft');
  const many = formatMeetingDraft(windowOnly, { labels: Array.from({ length: 12 }, (_, i) => `P${i}`), count: 14 }).attachments[0].content;
  assert.equal(facts(many).at(-1)!.value, 'Everyone here (14): P0, P1, P2, P3, P4, P5, P6, P7, P8, P9; 4 more');
  assert.equal(lines(many).at(-1), 'Nothing is scheduled. This draft has no meeting link.');
  assert.equal(lines(formatMeetingDraft(windowOnly, { labels: [], count: 0 }, undefined, {}).attachments[0].content)[0], 'Meeting draft · asked by an allowed participant');
});

test('who: named people show as the members they matched, a name that matched nobody is listed as not found, and unconfirmed names are dropped', () => {
  const named = decodeMeetingDraft({ ...metadata, 'meeting.attendees': 'named', 'meeting.name.0': '[ada] l', 'meeting.name.1': 'Grace' })!;
  const who = (...rest: Parameters<typeof formatMeetingDraft> extends [unknown, ...infer R] ? R : never) => facts(formatMeetingDraft(named, ...rest).attachments[0].content).find(f => f.title === 'Who')?.value;
  assert.equal(who({ labels: ['[Ada] L', 'Grace H'], count: 2 }, 'https://teams.microsoft.com/l/meeting/new?subject=x'), '\\[Ada\\] L, Grace H');
  assert.equal(who({ labels: ['Grace H'], count: 1, notFound: ['[ada] l'] }, undefined, undefined, 'attendees'), 'Grace H; not found: \\[ada\\] l');
  assert.equal(who({ labels: [], count: 0, notFound: ['[ada] l', 'Grace'] }, undefined, undefined, 'attendees'), 'not found: \\[ada\\] l, Grace');
  // Before any member list is read, the request's own names are all there is.
  assert.equal(who({ labels: [], count: 0 }, undefined, undefined, 'disabled'), '\\[ada\\] l, Grace');
  // The member list could not be read: no names, and one thing to do.
  const unconfirmed = formatMeetingDraft(named, { labels: [], count: 0 }, undefined, undefined, 'roster').attachments[0].content;
  assert.deepEqual(facts(unconfirmed), [{ title: 'Length', value: '30 min' }]); assert.ok(!JSON.stringify(unconfirmed).includes('Grace'));
  assert.equal(lines(unconfirmed).at(-1), "Nothing is scheduled. Couldn't confirm who is in this chat, so there is no meeting link. Create the meeting in Teams yourself.");
  const everyone = decodeMeetingDraft(metadata)!;
  assert.equal(facts(formatMeetingDraft(everyone, { labels: ['You'], count: 1, personal: true }, 'https://teams.microsoft.com/l/meeting/new?subject=x').attachments[0].content).at(-1)!.value, 'Just you. Add people in Teams.');
});

test('local time takes whole seconds and keeps the draft\'s own offset, so the client can convert it', () => {
  const draft = decodeMeetingDraft({ ...metadata, 'meeting.suggestedStart': '2028-02-29T23:45:00.123456789+05:30' })!;
  const when = facts(formatMeetingDraft(draft, { labels: [], count: 0 }).attachments[0].content)[0]!;
  assert.equal(when.value, '{{DATE(2028-02-29T23:45:00+05:30, SHORT)}} {{TIME(2028-02-29T23:45:00+05:30)}}–{{TIME(2028-03-01T00:15:00+05:30)}} (suggested)');
  // The Adaptive Cards date functions accept exactly this spelling.
  for (const [, time] of when.value.matchAll(/\((\d\S+?)[,)]/gu)) assert.match(time!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/u);
  // Free text from the agent cannot start a time of its own.
  const forged = decodeMeetingDraft({ ...metadata, 'meeting.subject': '{{DATE(2020-01-01T00:00:00Z)}}', 'meeting.preferredWindow': '{{TIME(2020-01-01T00:00:00Z)}}' })!;
  assert.ok(!JSON.stringify(formatMeetingDraft(forged, { labels: ['{{TIME(2020-01-01T00:00:00Z)}}'], count: 1 })).includes('{{'));
});

for (const [reason, text] of [['disabled', 'Meeting drafts are turned off here, so there is no meeting link.'], ['channel', 'Meeting links work only in personal and group chats, not channels.'],
  ['roster', "Couldn't confirm who is in this chat, so there is no meeting link. Create the meeting in Teams yourself."], ['attendees', "Couldn't match every requested attendee to one person in this chat, so there is no meeting link."],
  ['link-too-long', 'The full meeting link is too long, so there is no link. No partial attendee list was used.'],
  ['card-too-large', "The full meeting link doesn't fit in one message, so there is no link. No partial attendee list was used."]] as const) test(`no link (${reason}): one closing line says why, and there is no button`, () => {
  const card = formatMeetingDraft(decodeMeetingDraft(metadata)!, { labels: ['Ada'], count: 1 }, 'https://teams.microsoft.com/l/meeting/new?subject=x', undefined, reason).attachments[0].content;
  assert.equal(lines(card).at(-1), `Nothing is scheduled. ${text}`); assert.equal(card.actions, undefined);
  assert.equal(card.fallbackText, 'Meeting draft. Nothing scheduled. Review the agenda, duration and time suggestions in Teams. No meeting link is available.');
});

test('maximum escaped structured fields and roster labels fall back visibly without truncating the draft', () => {
  const draft = max('everyone'); const before = JSON.stringify(draft);
  const message = formatMeetingDraft(draft, { labels: Array(10).fill('\\'.repeat(256)), count: 10 },
    'https://teams.microsoft.com/' + 'x'.repeat(2000), { requesterDisplayName: '\\'.repeat(256), continuation: true, replyToId: '\\'.repeat(256) });
  const card = message.attachments[0].content;
  assert.equal(card.actions, undefined); assert.equal(message.text, undefined); assert.equal(message.attachments.length, 1);
  assert.equal(card.version, '1.4'); assert.ok(Buffer.byteLength(card.fallbackText!) <= 512);
  assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 20480); assert.equal(JSON.stringify(draft), before);
  assert.equal(message.replyToId, '\\'.repeat(256));
  assert.deepEqual(lines(card), [`Meeting draft · asked by ${'\\'.repeat(512)} · continuing this chat`, '\\'.repeat(400), 'Agenda',
    Array.from({ length: 5 }, (_, i) => `${i + 1}. ${'\\'.repeat(512)}`).join('\n'),
    "Nothing is scheduled. The full meeting link doesn't fit in one message, so there is no link. No partial attendee list was used."]);
  assert.deepEqual(facts(card), [{ title: 'When', value: '{{DATE(2028-02-29T12:00:00Z, SHORT)}} {{TIME(2028-02-29T12:00:00Z)}}–{{TIME(2028-02-29T20:00:00Z)}} (suggested)' },
    { title: 'Who', value: 'Everyone here (10); names left out to fit the message limit' }]);
  // The largest named draft fits with its link. A matched member's name is the requested name, so it is no longer.
  const named = formatMeetingDraft(max('named'), { labels: Array(10).fill('\\'.repeat(128)), count: 10 },
    'https://teams.microsoft.com/' + 'x'.repeat(2000), { requesterDisplayName: '\\'.repeat(256), continuation: true, replyToId: '\\'.repeat(256) });
  assert.ok(Buffer.byteLength(JSON.stringify(named)) <= 20480); assert.equal(named.attachments[0].content.actions?.length, 1);
  assert.equal(facts(named.attachments[0].content).at(-1)!.value, Array(10).fill('\\'.repeat(256)).join(', '));
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
  const body = JSON.stringify(card.body); for (const text of ['A \\\\+ B', '{{TIME(2028-01-01T12:00:00Z)}}–{{TIME(2028-01-01T12:30:00Z)}} (suggested)', 'Nothing is scheduled. ', ' · continuing this chat']) assert.ok(body.includes(text), text);
  assert.ok(body.includes('\\\\[Ada\\\\]')); assert.ok(body.includes('asked by \\\\[Owner\\\\]'));
  assert.ok(body.includes('Review \\\\[design\\\\]')); assert.ok(body.includes('too long'));
  const action = formatMeetingDraft(draft, { labels: ['You'], count: 1 }, meetingLink(draft, ['one@example.test']));
  assert.equal(action.attachments[0].content.actions?.[0]?.type, 'Action.OpenUrl');
  assert.equal(action.attachments[0].content.actions?.[0]?.title, 'Open in Teams');
});
