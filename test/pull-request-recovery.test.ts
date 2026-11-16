import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionsFixture } from './support/pull-request-decisions.js';
import { proposalFixture } from './support/pull-request-proposal.js';
import { context, eventually, deferred } from './support/directory-table.js';
async function claim(f: Awaited<ReturnType<typeof decisionsFixture>>, reserve = false) {
  await f.store.claimProposal(f.p, { decision: 'approve', tenantId: f.p.tenantId, objectId: f.p.objectId, invokeActivityId: 'original', decidedAt: f.now() }, context());
  const p = (await f.store.getProposal(f.p.id, context()))!.proposal;
  if (reserve) assert.equal((await f.store.reserveProposalWrite(p, context())).kind, 'send');
  return p;
}
test('restart_after_claim_before_projection_never_posts and confirmed_abandoned_fence_marks_failed', async t => {
  const f = await decisionsFixture(t);
  f.controls.hook = ({ req, body, res, reply }) => {
    if (req.method === 'PUT' && /^proposal_[a-f0-9]{64}$/u.test(String(body?.RowKey))) res.destroy(); else reply();
  };
  await assert.rejects(claim(f)); delete f.controls.hook;
  const other = f.make(f.open()); await other.recover(context());
  const p = (await f.store.getProposal(f.p.id, context()))!.proposal;
  assert.equal(p.state, 'failed'); assert.equal(p.outcome?.kind, 'failed'); assert.equal(f.requests.length, 0);
  assert.equal((await f.store.reserveProposalWrite({ ...p, state: 'approving' }, context())).kind, 'uncertain');
});
test('restart_after_reservation_before_post_stays_uncertain and lost_response_finds_matching_pr GET only', async t => {
  const f = await decisionsFixture(t); await claim(f, true);
  const other = f.make(f.open()); await other.recover(context());
  assert.equal((await f.store.getProposal(f.p.id, context()))?.proposal.state, 'uncertain');
  assert.ok(f.requests.every(r => r.method === 'GET')); const firstLookups = f.requests.filter(r => r.path.includes('/pulls?')).length;
  assert.equal(firstLookups, 1);
  f.behavior((req, res) => res.end(JSON.stringify(req.path === '/user' ? { id: 123 } : [f.result('c'.repeat(40))])));
  await other.recover(context());
  const p = (await f.store.getProposal(f.p.id, context()))!.proposal; assert.equal(p.state, 'opened');
  assert.ok(p.outcome?.kind === 'opened' && p.outcome.headSHA === 'c'.repeat(40));
  assert.ok(f.requests.every(r => r.method === 'GET'));
});
test('no_or_ambiguous_match_stays_uncertain and recovery cannot borrow a new account generation', async t => {
  const f = await decisionsFixture(t); await claim(f, true);
  f.behavior((req, res) => res.end(JSON.stringify(req.path === '/user' ? { id: 123 } : [f.result(), f.result()])));
  const other = f.make(f.open()); await other.recover(context());
  assert.equal((await f.store.getProposal(f.p.id, context()))?.proposal.state, 'uncertain');
  assert.ok(f.requests.every(r => r.method === 'GET')); const n = f.requests.length;
  await f.gh.disconnect(f.subject, context()); await other.recover(context()); assert.equal(f.requests.length, n);
});
test('server_side_range_excludes_other_provider_rows_and_obeys_continuations with one visit per claim', async t => {
  const f = await decisionsFixture(t);
  for (let i = 0; i < 6; i++) {
    const p = proposalFixture(`more-${i}`); await f.store.reserveProposal(p, `more-${i}`, context());
    await f.store.claimProposal(p, { decision: 'reject', tenantId: p.tenantId, objectId: p.objectId, invokeActivityId: `invoke-${i}`, decidedAt: f.now() }, context());
  }
  // Deliberately corrupt unrelated ciphertext: a partition-wide scan would fail decoding it.
  const unrelated = [...f.rows.values()].find(r => String(r.RowKey).startsWith('account_'))!;
  unrelated.Payload = 'not ciphertext';
  const seen: string[] = []; await f.open().visitRecoverableProposals(context(), async p => { seen.push(p.id); });
  assert.equal(new Set(seen).size, 6); assert.equal(seen.length, 6);
  const queries = f.tableRequests.filter(r => r.url.pathname === '/Directory()');
  assert.ok(queries.length > 1); assert.ok(queries.some(r => r.url.searchParams.has('NextRowKey')));
  assert.ok(queries.every(r => r.url.searchParams.get('$filter')?.endsWith("and RowKey ge 'proposal_' and RowKey lt 'proposal`'")));
  assert.equal(f.requests.length, 0);
});
test('startup_recovery_cannot_cancel_a_live_claim_during_projection', async t => {
  const f = await decisionsFixture(t); const entered = deferred(); const release = deferred(); let hold = true;
  f.controls.hook = async ({ req, body, reply }) => {
    if (hold && req.method === 'PUT' && /^proposal_[a-f0-9]{64}$/u.test(String(body?.RowKey))) {
      hold = false; entered.resolve(); await release.promise;
    }
    reply();
  };
  const pending = f.decide(); await entered.promise;
  try { await f.service.recover(context()); } finally { release.resolve(); }
  await pending; assert.equal((await f.settled()).state, 'opened');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});
test('shutdown_drains_held_lookup_before_store_close and recovery never posts', async t => {
  const f = await decisionsFixture(t); await claim(f, true); let held = false;
  f.behavior(() => { held = true; });
  const other = f.make(f.open()); const recovery = other.recover(context());
  await eventually(() => held); await other.close(); await recovery;
  assert.ok(f.requests.every(r => r.method === 'GET'));
});
