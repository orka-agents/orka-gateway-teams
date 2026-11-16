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
  assert.match(wire, new RegExp(p.baseSHA + '\\.\\.\\.' + p.headSHA));
  assert.match(wire, /Opens as you/); assert.match(wire, /Description \(written by the agent\)/);
});
test('sender_can_approve_or_reject_only_pending_and_closed_projection_keeps_actions', () => {
  const p = proposalFixture();
  const card = buildPullRequestCard(p, 'sender', true);
  assert.deepEqual(card.actions!.filter(a => a.type === 'Action.Execute').map(a => a.verb), ['pr-approve', 'pr-reject']);
  const revise = card.actions!.find(a => a.type === 'Action.ShowCard' && a.title === 'Revise'); assert.ok(revise?.type === 'Action.ShowCard' && revise.card);
  assert.deepEqual(revise.card.body, [{ type: 'Input.Text', id: 'note', isMultiline: true, maxLength: 2000, placeholder: 'What should change?' }]);
  assert.deepEqual(revise.card.actions, [{ type: 'Action.Execute', title: 'Send', verb: 'pr-revise', data: { proposal: p.id, rev: 1, digest: p.payloadDigest } }]);
  assert.ok(cardInvokeResponse({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card }));
  for (const state of ['approving', 'opened', 'rejected', 'expired', 'superseded', 'uncertain', 'failed', 'branch-moved'] as const) {
    const current = buildPullRequestCard({ ...p, state }, 'sender', true);
    assert.equal(current.actions!.filter(a => a.type === 'Action.Execute').length, 0);
  }
  assert.equal(buildPullRequestCard(p, 'room', true).actions!.filter(a => a.type === 'Action.Execute').length, 0);
  const forged = structuredClone(card); (forged.actions![0] as any).verb = 'pr-revise';
  assert.equal(cardInvokeResponse({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: forged }), undefined);
});
test('closed projection admits only the bounded nested Revise input and Execute, including alongside description expansion', () => {
  const card = buildPullRequestCard({ ...proposalFixture(), body: 'x'.repeat(1000) }, 'sender', true);
  const response = (value: unknown) => cardInvokeResponse({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value });
  assert.equal(card.actions!.length, 5); assert.ok(response(card));
  for (const mutate of [
    (c: any) => { c.actions.find((a: any) => a.title === 'Revise').card.body[0].maxLength = 2001; },
    (c: any) => { c.actions.find((a: any) => a.title === 'Revise').card.body[0].id = 'token'; },
    (c: any) => { c.actions.find((a: any) => a.title === 'Revise').card.actions[0].verb = 'pr-approve'; },
    (c: any) => { c.actions.find((a: any) => a.title === 'Revise').card.actions.push(c.actions[0]); },
    (c: any) => { c.body.push(c.actions.find((a: any) => a.title === 'Revise').card.body[0]); },
    (c: any) => { c.actions.find((a: any) => a.title.startsWith('Show full')).card.actions = [c.actions[0]]; },
  ]) { const forged = structuredClone(card); mutate(forged); assert.equal(response(forged), undefined); }
});
test('revision cards show pending/signin/conflict rather than claiming delivery; delivered note is escaped', () => {
  const p = proposalFixture();
  for (const status of ['pending', 'full', 'signin-required', 'conflict', 'delivered'] as const) {
    const wire = JSON.stringify(buildPullRequestCard({ ...p, state: 'revise-requested', revisionAdmission: status,
      claim: { decision: 'revise', tenantId: p.tenantId, objectId: p.objectId, invokeActivityId: 'invoke', decidedAt: p.createdAt, note: '**test** <at>someone</at>', revisionReplyTarget: 'new-reply' } }, 'sender', true));
    assert.match(wire, status === 'delivered' ? /asked for changes/ : status === 'signin-required' ? /Sign in, then send your revision again/ : status === 'conflict' ? /not sent/ : /Sending your revision/);
    assert.equal(wire.includes('asked for changes'), status === 'delivered'); assert.ok(!wire.includes('pr-revise'));
    assert.ok(!wire.includes('**test**')); assert.ok(!wire.includes('<at>'));
    if (status === 'delivered') assert.ok(wire.includes('&lt;at&gt;someone&lt;/at&gt;'));
  }
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
test('description expansion follows escaped-byte truncation rather than character count', () => {
  const p = proposalFixture();
  for (const body of ['字'.repeat(120), '&'.repeat(200), 'x'.repeat(300), '&'.repeat(500)]) {
    const card = buildPullRequestCard({ ...p, body }, 'sender', false);
    const action = card.actions!.find(a => a.type === 'Action.ShowCard'); assert.ok(action);
    assert.equal(action.title, body.length === 500 ? 'Show more description (truncated)' : 'Show full description');
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
