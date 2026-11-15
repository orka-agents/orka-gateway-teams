import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { proposalDigest, decodeProposal } from '../src/accounts/pull-request-proposal.js';
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
