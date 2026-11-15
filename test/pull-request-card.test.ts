import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPullRequestCard, cardInvokeResponse } from '../src/teams/pull-request-card.js';
import { proposalFixture } from './support/pull-request-proposal.js';
for (const viewer of ['room', 'sender'] as const) test(`${viewer}_preview_has_no_active_decision_buttons`, () => {
  const p = proposalFixture(); const card = buildPullRequestCard(p, viewer, false); const wire = JSON.stringify(card);
  assert.ok(!/pr-approve|pr-reject|pr-revise/.test(wire)); assert.match(wire, /Approval actions are not enabled yet/);
  assert.deepEqual(card.refresh?.userIds, ['29:sender-private']);
  assert.deepEqual(card.refresh?.action?.data, { proposal: p.id, rev: 1, digest: p.payloadDigest });
  for (const privateValue of [p.taskUID, p.grantRef, p.targetId, p.replyTarget]) assert.ok(!wire.includes(privateValue));
  assert.match(wire, /Opens as you/); assert.match(wire, /Description \(written by the agent\)/);
});
test('card_escapes_untrusted_labels_and_fits_20KiB', () => {
  const p = proposalFixture(); p.displayName = '[Admin](https://evil.invalid)'; p.title = '**Do it**'; p.body = '[x](https://evil.invalid)'.repeat(700);
  p.files = Array.from({ length: 10 }, () => ({ path: '\\'.repeat(4000), additions: 1, deletions: 1 })); p.fileCount = 300; p.filesComplete = false;
  const card = buildPullRequestCard(p, 'room', false); const wire = JSON.stringify(card);
  assert.ok(Buffer.byteLength(JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] })) <= 20 * 1024);
  assert.ok(!wire.includes('[Admin](')); assert.match(wire, /incomplete/); assert.match(wire, /truncated/);
  p.title = '&'.repeat(256); p.body = '&'.repeat(16384); p.displayName = '&'.repeat(1024);
  p.owner = 'a'.repeat(100); p.repo = '_'.repeat(100); p.head = '_'.repeat(256); p.base = '_'.repeat(256);
  p.files = Array.from({ length: 10 }, () => ({ path: '&'.repeat(4096), additions: 1, deletions: 1 }));
  for (const viewer of ['room', 'sender'] as const) {
    const escaped = buildPullRequestCard(p, viewer, false);
    assert.ok(Buffer.byteLength(JSON.stringify({ type: 'message', replyToId: p.activityId, attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: escaped }] })) <= 20 * 1024);
    assert.ok(cardInvokeResponse({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: escaped }));
  }
});
test('expired_or_superseded_card_shows_current_state and closed invoke projection drops extra wrapper fields', () => {
  for (const state of ['expired', 'superseded'] as const) {
    const card = buildPullRequestCard({ ...proposalFixture(), state }, 'sender', false);
    assert.match(JSON.stringify(card), state === 'expired' ? /Expired/ : /Replaced/);
    const projected = cardInvokeResponse({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card, secret: 'hidden' });
    assert.deepEqual(Object.keys(projected!), ['statusCode', 'type', 'value']); assert.ok(!JSON.stringify(projected).includes('hidden'));
  }
  assert.equal(cardInvokeResponse({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: { type: 'AdaptiveCard', version: '1.5', body: [], secret: 'hidden' } }), undefined);
});
