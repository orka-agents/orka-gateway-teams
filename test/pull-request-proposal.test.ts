import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { canonicalJSON } from '../src/directory/codec.js';
import { proposalDigest, decodeProposal, projectClaim } from '../src/accounts/pull-request-proposal.js';
import { taskGrant } from '../src/accounts/grants.js';
import { binding, context } from './support/directory-table.js';
import { grantsFixture } from './support/task-grants.js';
import { proposalFixture } from './support/pull-request-proposal.js';

// Catches plaintext persistence, omitted binding fields, broken expiry and replay reads.
test('proposal_survives_reopen_without_plaintext', async t => {
  const f = await grantsFixture(t); const p = proposalFixture();
  const saved = await f.store.reserveProposal(p, 'operation', context());
  assert.equal(saved.expiresAt, saved.createdAt + 3_600_000);
  assert.equal(saved.payloadDigest, proposalDigest(saved));
  const wire = JSON.stringify([...f.rows.values()]) + [...f.rows.values()].map(r => Buffer.from(String(r.Payload), 'base64').toString()).join('');
  for (const secret of [p.title, p.senderMRI, p.body, p.taskUID]) assert.ok(!wire.includes(secret));
  await f.store.close(); const reopened = f.open();
  assert.deepEqual((await reopened.getProposal(p.id, context()))?.proposal, saved);
  f.advance(3_600_001); assert.equal((await reopened.getProposal(p.id, context()))?.proposal.state, 'expired');
});
test('revision admission is mutable evidence outside the frozen digest, decoded only on a winning revision', () => {
  const p = proposalFixture(); const claimed = projectClaim(p, { decision: 'revise', tenantId: p.tenantId, objectId: p.objectId,
    invokeActivityId: 'invoke', decidedAt: p.createdAt, note: 'saved note', revisionReplyTarget: 'saved-reply' });
  for (const revisionAdmission of ['pending', 'delivered', 'full', 'signin-required', 'conflict'] as const) {
    const revised = { ...claimed, revisionAdmission }; assert.equal(proposalDigest(revised), p.payloadDigest);
    assert.deepEqual(decodeProposal(revised), revised);
  }
  for (const revised of [{ ...claimed, revisionAdmission: 'accepted' }, { ...p, revisionAdmission: 'delivered' },
    { ...claimed, claim: undefined }, { ...claimed, revisionAdmission: { delivered: true } },
    { ...claimed, claim: { ...claimed.claim, token: 'forged' } }]) assert.throws(() => decodeProposal(revised));
});
test('proposal_row_swap_rejected', async t => {
  const f = await grantsFixture(t); const p = proposalFixture();
  await f.store.reserveProposal(p, 'operation', context());
  const q = proposalFixture('second'); await f.store.reserveProposal(q, 'second', context());
  const rows = [...f.rows.values()].filter(r => /^proposal_[a-f0-9]{64}$/u.test(String(r.RowKey)));
  const a = rows[0]!; a.Payload = rows[1]!.Payload;
  a.Digest = createHash('sha256').update(JSON.stringify(['teams-accounts-row-v1', a.PartitionKey, a.RowKey, a.Payload])).digest('hex');
  await assert.rejects(f.store.getProposal(p.id, context()), /corrupt/);
});
test('proposal_same_key_changed_payload_conflicts', async t => {
  const f = await grantsFixture(t); const p = proposalFixture(); await f.store.reserveProposal(p, 'operation', context());
  const changed = { ...p, title: 'changed' }; changed.payloadDigest = proposalDigest(changed);
  await assert.rejects(f.store.reserveProposal(changed, 'operation', context()), /operation-conflict/);
  assert.throws(() => decodeProposal({ ...p, token: 'untrusted' }));
  assert.throws(() => decodeProposal({ ...p, expiresAt: p.expiresAt + 1 }));
  assert.notEqual(proposalDigest({ ...p, headSHA: 'b'.repeat(40) }), p.payloadDigest);
});
test('concurrent_proposals_have_one_current_winner', async t => {
  const f = await grantsFixture(t); const ps = [proposalFixture(), proposalFixture('second')];
  await Promise.allSettled(ps.map((p, i) => f.store.reserveProposal(p, i ? 'second' : 'operation', context())));
  const states = await Promise.all(ps.map(async p => (await f.store.getProposal(p.id, context()))?.proposal.state));
  assert.equal(states.filter(s => s === 'pending').length, 1);
  const loser = ps[states.findIndex(s => s !== 'pending')]!;
  assert.equal((await f.store.reserveProposal(loser, loser.id === ps[0]!.id ? 'operation' : 'second', context())).state, 'superseded');
});
// Inject a future PR2 claim through the real encrypted Table boundary, not a production test API.
test('replacement_cannot_erase_unprojected_claim_or_note', async t => {
  const f = await grantsFixture(t); const p = proposalFixture(); await f.store.reserveProposal(p, 'operation', context());
  const row = [...f.rows.values()].find(r => String(r.RowKey).startsWith('proposal_selector_'))!;
  const bytes = Buffer.from(String(row.Payload), 'base64'); const generation = bytes.readBigUInt64BE();
  const aad = Buffer.from(JSON.stringify([row.PartitionKey, row.RowKey, Number(generation), 1]));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 7), bytes.subarray(8, 20));
  decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(-16));
  const selector = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(20, -16)), decipher.final()]).toString());
  selector.state = 'claimed'; selector.claim = { decision: 'revise', tenantId: binding.tenantId, objectId: p.objectId,
    invokeActivityId: 'invoke', decidedAt: p.createdAt + 1, note: 'keep this private note', revisionReplyTarget: 'revision-reply' };
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv); cipher.setAAD(aad);
  row.Payload = Buffer.concat([bytes.subarray(0, 8), iv, cipher.update(JSON.stringify(selector)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  row.Digest = createHash('sha256').update(JSON.stringify(['teams-accounts-row-v1', row.PartitionKey, row.RowKey, row.Payload])).digest('hex');
  f.controls.hook = ({ req, body, res, reply }) => {
    if (req.method === 'PUT' && /^proposal_[a-f0-9]{64}$/u.test(String(body?.RowKey))) res.destroy(); else reply();
  };
  await assert.rejects(f.store.reserveProposal(proposalFixture('second'), 'second', context()), /unavailable/);
  assert.equal((await f.store.getProposal(p.id, context()))?.proposal.state, 'revise-requested');
  delete f.controls.hook;
  await f.store.reserveProposal(proposalFixture('second'), 'second', context());
  const old = (await f.store.getProposal(p.id, context()))!.proposal;
  assert.equal(old.claim?.note, 'keep this private note'); assert.equal(old.claim?.revisionReplyTarget, 'revision-reply');
});
test('double_click_has_one_winner and new_proposal_and_approve_share_selector', async t => {
  const f = await grantsFixture(t); const p = proposalFixture(); await f.store.reserveProposal(p, 'operation', context());
  const claim = { decision: 'approve' as const, tenantId: p.tenantId, objectId: p.objectId, invokeActivityId: 'invoke-1', decidedAt: f.now() };
  const results = await Promise.allSettled([f.store.claimProposal(p, claim, context()), f.open().claimProposal(p, claim, context())]);
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value).length, 1);
  assert.equal((await f.store.getProposal(p.id, context()))?.proposal.state, 'approving');
  await f.store.reserveProposal(proposalFixture('second'), 'second', context());
  const old = (await f.store.getProposal(p.id, context()))!.proposal;
  assert.deepEqual(old.claim, claim); assert.equal(old.state, 'approving');
  assert.equal(await f.store.claimProposal(p, claim, context()), false);
});
test('expired_boundary_cannot_claim and replacement_before_decision_wins', async t => {
  const f = await grantsFixture(t); const p = proposalFixture(); await f.store.reserveProposal(p, 'operation', context());
  const claim = { decision: 'reject' as const, tenantId: p.tenantId, objectId: p.objectId, invokeActivityId: 'invoke-1', decidedAt: f.now() };
  await f.store.reserveProposal(proposalFixture('second'), 'second', context());
  assert.equal(await f.store.claimProposal(p, claim, context()), false);
  const q = (await f.store.getProposal(proposalFixture('second').id, context()))!.proposal;
  f.advance(3_600_000);
  assert.equal(await f.store.claimProposal(q, { ...claim, decidedAt: f.now() }, context()), false);
  assert.equal((await f.store.getProposal(q.id, context()))?.proposal.state, 'expired');
});
test('proposal_owned_write_grants_one_send_and_never_borrows_Task_authority', async t => {
  const f = await grantsFixture(t); const p = proposalFixture(); await f.store.reserveProposal(p, 'operation', context());
  await assert.rejects(f.store.reserveProposalWrite(p, context()));
  await f.store.claimProposal(p, { decision: 'approve', tenantId: p.tenantId, objectId: p.objectId, invokeActivityId: 'invoke', decidedAt: f.now() }, context());
  const claimed = (await f.store.getProposal(p.id, context()))!.proposal;
  const r = await f.store.reserveProposalWrite(claimed, context()); assert.equal(r.kind, 'send');
  assert.equal((await f.open().reserveProposalWrite(claimed, context())).kind, 'uncertain');
  const outcome = { kind: 'opened' as const, number: 12, url: 'https://github.com/example/project/pull/12', headSHA: p.headSHA };
  await f.store.completeProposalWrite(claimed, outcome, context());
  assert.deepEqual(await f.open().reserveProposalWrite(claimed, context()), { kind: 'done', outcome });
});
test('legacy_near_limit_preview_retains_digest_and_files_when_claim_and_result_are_added', async t => {
  const f = await grantsFixture(t); const p = proposalFixture(); p.body = 'b'.repeat(16384);
  p.files = Array.from({ length: 8 }, (_, i) => ({ path: String(i) + 'x'.repeat(4090), additions: 1, deletions: 1 })); p.fileCount = 8;
  const bytes = () => Buffer.byteLength(canonicalJSON({ kind: 'proposal', objectId: p.objectId, generation: p.generation, proposal: p }));
  p.payloadDigest = proposalDigest(p);
  p.files[7]!.path = p.files[7]!.path.slice(0, p.files[7]!.path.length - (bytes() - (48 * 1024 - 8))); p.payloadDigest = proposalDigest(p);
  assert.ok(bytes() <= 48 * 1024 && bytes() > 48 * 1024 - 32);
  const saved = await f.store.reserveProposal(p, 'operation', context()); assert.deepEqual(saved.files, p.files);
  assert.equal(await f.store.claimProposal(p, { decision: 'approve', tenantId: p.tenantId, objectId: p.objectId, invokeActivityId: 'i'.repeat(256), decidedAt: f.now() }, context()), true);
  const version = (await f.store.getProposal(p.id, context()))!;
  const outcome = { kind: 'opened' as const, number: 12, url: 'https://github.com/example/project/pull/12', headSHA: p.headSHA };
  await f.store.replaceProposal(version, { ...version.proposal, state: 'opened', outcome }, context());
  const reopened = (await f.open().getProposal(p.id, context()))!.proposal;
  assert.equal(reopened.payloadDigest, p.payloadDigest); assert.deepEqual(reopened.files, p.files); assert.equal(reopened.outcome?.kind, 'opened');
  assert.ok([...f.rows.values()].every(row => Buffer.from(String(row.Payload), 'base64').length <= 65536));
});
test('claim_rejects_wrong_actor_digest_and_future_claim_time', async t => {
  const f = await grantsFixture(t); const p = proposalFixture(); await f.store.reserveProposal(p, 'operation', context());
  const claim = { decision: 'approve' as const, tenantId: p.tenantId, objectId: p.objectId, invokeActivityId: 'invoke', decidedAt: f.now() };
  for (const bad of [{ ...claim, objectId: 'other' }, { ...claim, tenantId: 'other' }, { ...claim, decidedAt: f.now() + 1 }])
    assert.equal(await f.store.claimProposal(p, bad, context()), false);
  assert.equal(await f.store.claimProposal({ ...p, payloadDigest: 'f'.repeat(64) }, claim, context()), false);
  assert.equal((await f.store.getProposal(p.id, context()))?.proposal.state, 'pending');
});
test('old_grant_round_trip_unchanged and child_inherits_origin_not_parent_tool_authority', async t => {
  const f = await grantsFixture(t); assert.deepEqual(taskGrant(f.input), f.input);
  const p = proposalFixture(); const { conversationId, replyTarget, route, senderMRI, objectId, displayName, activityId } = p;
  const origin = { conversationId, replyTarget, route, senderMRI, objectId, displayName, activityId };
  const input = { ...f.input, proposalOrigin: origin, tools: ['workiq', 'github-propose-pull-request'] };
  await f.store.reserveGrant(input, context());
  const root = { namespaceUID: 'ns', gatewayUID: 'gateway', taskUID: 'root', tools: input.tools, deadline: f.now() + 60_000 };
  await f.store.bindGrant(input.ref, input.targetId, root, context());
  await f.store.bindGrant(input.ref, input.targetId, { ...root, taskUID: 'child', parentTaskUID: 'root', tools: ['workiq'] }, context());
  const child = await f.store.getGrant(input.ref, context(), 'child');
  assert.deepEqual(child?.proposalOrigin, origin); assert.deepEqual(child?.binding?.tools, ['workiq']);
});
