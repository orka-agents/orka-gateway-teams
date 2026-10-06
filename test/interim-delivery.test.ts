import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { requestIdentity } from '../src/delivery/identity.js';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { createTableDeliveryJournal, createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import { DeliveryJournalError } from '../src/delivery/types.js';
import type { DeliveryRequest } from '../src/protocol/types.js';
import { decodeDelivery, snapshotDelivery } from '../src/outbound/validate.js';
import { formatDelivery } from '../src/teams/format.js';
import { finalDelivery, errorDelivery } from './fixtures/outgoing.js';
import { tableBinding, tableService } from './support/table-service.js';

const scope = { appId: 'app-fixture', tenantId: finalDelivery.accountId };
const message = { ...finalDelivery, kind: 'message' } satisfies DeliveryRequest;
const invalid = (error: unknown) => error instanceof DeliveryJournalError && error.code === 'invalid-input';

for (const [label, text] of [
  ['ASCII', 'a'.repeat(16384)], ['two-byte', 'é'.repeat(8192)], ['four-byte', '😀'.repeat(4096)],
  ['Unicode', '界'.repeat(5461) + 'a'],
] as const) test(`message ${label}: exact 16 KiB accepted; one byte over rejected at identity/snapshot/HTTP decoding`, () => {
  const bounded = { ...message, text };
  assert.doesNotThrow(() => requestIdentity(bounded, scope));
  assert.ok(snapshotDelivery(bounded, scope).text === text);
  assert.ok(decodeDelivery(Buffer.from(JSON.stringify(bounded)), scope).text === text);
  const over = { ...bounded, text: text + 'a' };
  assert.throws(() => requestIdentity(over, scope), invalid);
  assert.throws(() => snapshotDelivery(over, scope));
  assert.throws(() => decodeDelivery(Buffer.from(JSON.stringify(over)), scope));
  // The smaller interim bound must not leak into terminal validation.
  for (const kind of ['final', 'error'] as const) assert.doesNotThrow(() => snapshotDelivery({ ...over, kind }, scope));
});

for (const [label, text] of [
  ['empty', ''], ['whitespace', ' \t\r\n\u2003'], ['BOM-only', '\ufeff'], ['surrogate', '\ud800'],
  ['C0', 'a\u0000'], ['C1', 'a\u0085'], ['nonstring', 1],
] as const) test(`malformed message ${label} is rejected consistently without repair`, () => {
  const bad = { ...message, text };
  assert.throws(() => requestIdentity(bad, scope), invalid);
  assert.throws(() => snapshotDelivery(bad, scope));
  assert.throws(() => decodeDelivery(Buffer.from(JSON.stringify(bad)), scope));
});

test('terminal fingerprint goldens remain exact and message kind participates in identity', () => {
  assert.equal(requestIdentity(finalDelivery, scope).digest, 'f3b26cfc732067e842fd1a07aadff5e457cc38db118d1a7f8134137fad884ee1');
  assert.equal(requestIdentity(errorDelivery, scope).digest, '4f8adc936942c1f49bd58473c5bae2236609fa733b75005e54c430d415a873df');
  assert.notEqual(requestIdentity(message, scope).digest, requestIdentity(finalDelivery, scope).digest);
});

test('SQLite message aliases/conflicts and original receipt survive fresh-handle restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-interim-journal-')); const path = join(directory, 'journal.sqlite');
  initializeDeliveryJournal(path, scope); let journal = openDeliveryJournal(path, scope);
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.throws(() => journal.begin({ ...message, text: 'é'.repeat(8193) }), invalid);
  const begun = journal.begin(message); assert.equal(begun.kind, 'claimed');
  if (begun.kind !== 'claimed') throw new Error('Missing fixture claim');
  assert.deepEqual(journal.begin({ ...message, deliveryId: 'message-alias' }), { kind: 'inFlight' });
  const receipt = { kind: 'delivered', providerMessageId: 'interim-sqlite-receipt' } as const;
  assert.equal(journal.settle(begun.claim, receipt), 'recorded'); journal.close(); journal = openDeliveryJournal(path, scope);
  assert.deepEqual(journal.begin({ ...message, deliveryId: 'restart-alias' }), receipt);
  for (const change of [{ text: message.text + ' ' }, { kind: 'final' as const }, { idempotencyId: 'other-operation' }]) {
    assert.deepEqual(journal.begin({ ...message, ...change }), { kind: 'conflict' });
  }
});

for (const version of [1, 2] as const) test(`Table V${version} message validation, aliases/conflicts and receipt restart use unchanged domain shapes`, async t => {
  const service = await tableService(t, 'delivery', version);
  const factory = version === 1 ? createTableDeliveryJournal : createTableDeliveryJournalV2;
  const initial = factory(tableBinding, service.dependencies); await initial.initialize(); await initial.close();
  let journal = factory(tableBinding, service.dependencies); await journal.open();
  t.after(() => journal.close());
  const input = { ...message, accountId: tableBinding.scope.tenantId, text: '😀'.repeat(4096) };
  const before = service.stats.writes;
  assert.throws(() => journal.begin({ ...input, text: input.text + 'a' }), invalid);
  assert.equal(service.stats.writes, before);
  const begun = await journal.begin(input); assert.equal(begun.kind, 'claimed');
  if (begun.kind !== 'claimed') throw new Error('Missing fixture claim');
  assert.deepEqual(await journal.begin({ ...input, deliveryId: 'table-message-alias' }), { kind: 'inFlight' });
  const receipt = { kind: 'delivered', providerMessageId: 'interim-table-receipt' } as const;
  assert.equal(await journal.settle(begun.claim, receipt), 'recorded'); await journal.close();
  journal = factory(tableBinding, service.dependencies); await journal.open();
  assert.deepEqual(await journal.begin({ ...input, deliveryId: 'table-restart-alias' }), receipt);
  for (const change of [{ text: 'changed' }, { kind: 'error' as const }, { idempotencyId: 'other-operation' }]) {
    assert.deepEqual(await journal.begin({ ...input, ...change }), { kind: 'conflict' });
  }
  const operation = [...service.rows.values()].find(row => row.T === 'delivery')!;
  const saved = JSON.parse(Buffer.from(operation.B0 as string, 'base64').toString());
  assert.deepEqual(Object.keys(saved), ['schema', 'fingerprint', 'digest', 'attemptId', 'attemptEpoch', 'state', 'providerMessageId']);
  assert.equal(saved.schema, 1); assert.equal(saved.fingerprint, 1); assert.equal(saved.providerMessageId, receipt.providerMessageId);
  await journal.close(); assert.equal(service.stats.requests, service.stats.requestCloses);
  assert.equal(service.stats.requests, service.stats.socketCloses); assert.equal(service.stats.violation, false);
});

for (const [text, title] of [
  ['Question: Which option?', 'Orka question'], ['An update', 'Orka update'], ['Which option?', 'Orka update'],
  ['question: Which option?', 'Orka update'], [' Question: Which option?', 'Orka update'],
] as const) test(`message heading uses explicit convention only (${title}) and preserves body`, () => {
  const input = Object.freeze({ ...message, text }); const card = formatDelivery(input).attachments[0].content;
  const heading = card.body?.[0]; const body = card.body?.[1];
  assert.ok(heading?.type === 'TextBlock' && heading.text === title);
  assert.ok(body?.type === 'TextBlock' && body.text === text);
  assert.ok(card.fallbackText?.startsWith(title + ': '));
});

test('message cards budget escaping, attribution and root with grapheme-safe body/fallback shortening', () => {
  const unit = '🧑🏽‍💻e\u0301' + '"\\\n'.repeat(6);
  const text = 'Question: ' + unit.repeat(440); assert.ok(Buffer.byteLength(text) <= 16384);
  const input = Object.freeze({ ...message, text });
  const presentation = Object.freeze({ requesterDisplayName: '['.repeat(256), continuation: true, replyToId: 'r'.repeat(256) });
  const output = formatDelivery(input, presentation); const card = output.attachments[0].content;
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 20480); assert.equal(output.replyToId, presentation.replyToId);
  assert.ok(card.fallbackText && Buffer.byteLength(card.fallbackText) <= 512);
  const heading = card.body?.[0]; assert.ok(heading?.type === 'TextBlock' && heading.text === 'Orka question');
  assert.equal(card.body?.length, 5);
  const body = card.body?.[3]; assert.ok(body?.type === 'TextBlock'); assert.ok(body.text.length < text.length && text.startsWith(body.text));
  const ends = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map(s => s.index + s.segment.length);
  assert.ok(body.text.length === 0 || ends.includes(body.text.length));
  assert.ok(JSON.stringify(formatDelivery(input, presentation)) === JSON.stringify(output));
  // A wire-bounded body with many escapes exceeds the complete card budget.
  const escaped = formatDelivery({ ...message, text: '\n'.repeat(16383) + 'a' }, presentation).attachments[0].content;
  assert.equal(escaped.body?.length, 5); assert.ok(escaped.fallbackText?.includes('(shortened)'));
  assert.ok(Buffer.byteLength(JSON.stringify(formatDelivery({ ...message, text: '\n'.repeat(16383) + 'a' }, presentation))) <= 20480);
  const giantText = 'a' + '\u0301'.repeat(8000);
  const giant = formatDelivery({ ...message, text: giantText }).attachments[0].content;
  assert.ok(giant.body?.[1]?.type === 'TextBlock' && giant.body[1].text === giantText);
  assert.equal(giant.fallbackText, 'Orka update: … (shortened)');
});
