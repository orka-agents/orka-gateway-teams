import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionsFixture } from './support/pull-request-decisions.js';
import { context } from './support/directory-table.js';
test('wrong_sender_tenant_digest_never_claims and disconnected_target_never_claims', async t => {
  const f = await decisionsFixture(t);
  for (const subject of [{ ...f.ctx().subject, objectId: 'other' }, { ...f.ctx().subject, tenantId: 'other' }])
    await assert.rejects(f.decide('approve', f.p, { ...f.ctx(), subject }));
  await assert.rejects(f.decide('approve', { ...f.p, payloadDigest: 'f'.repeat(64) }));
  f.connected(false); await assert.rejects(f.decide());
  assert.equal((await f.store.getProposal(f.p.id, context()))?.proposal.state, 'pending');
  assert.equal(f.requests.length, 0);
});
test('relink_requires_new_card for either account generation', async t => {
  const f = await decisionsFixture(t); await f.gh.disconnect(f.subject, context()); await assert.rejects(f.decide());
  assert.equal((await f.store.getProposal(f.p.id, context()))?.proposal.state, 'pending');
  const g = await decisionsFixture(t); await g.store.disconnect(g.subject, context()); await assert.rejects(g.decide());
  assert.equal(g.requests.length, 0);
});
test('expired_task_live_proposal_can_be_rejected without a Task pass or Orka turn', async t => {
  const f = await decisionsFixture(t); f.advance(600001);
  const p = await f.decide('reject'); assert.equal(p.state, 'rejected');
  assert.equal(f.requests.length, 0); assert.equal(p.claim?.invokeActivityId, 'invoke');
});
