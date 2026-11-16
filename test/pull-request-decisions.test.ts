import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionsFixture } from './support/pull-request-decisions.js';
import { context, deferred, eventually } from './support/directory-table.js';
import { proposalFixture } from './support/pull-request-proposal.js';
test('wrong_sender_tenant_digest_never_claims and disconnected_target_never_claims', async t => {
  const f = await decisionsFixture(t);
  for (const subject of [{ ...f.ctx().subject, objectId: 'other' }, { ...f.ctx().subject, tenantId: 'other' }])
    await assert.rejects(f.decide('approve', f.p, { ...f.ctx(), subject }));
  await assert.rejects(f.decide('approve', { ...f.p, payloadDigest: 'f'.repeat(64) }));
  await assert.rejects(f.decide('approve', { ...f.p, objectId: 'other' }, { ...f.ctx(), subject: { ...f.ctx().subject, objectId: 'other' } }));
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
test('approved_payload_is_only_post_body and two_replicas_one_post and returned head mismatch is disclosed', async t => {
  const f = await decisionsFixture(t);
  f.behavior((req, res) => {
    if (req.path === '/user') return void res.end('{"id":123}');
    if (req.path.includes('/git/ref/')) return void res.end(JSON.stringify({ ref: 'refs/heads/orka/fix', object: { type: 'commit', sha: f.p.headSHA } }));
    if (req.method === 'GET') return void res.end('[]');
    res.statusCode = 201; res.end(JSON.stringify(f.result('c'.repeat(40))));
  });
  const other = f.make(f.open());
  await Promise.allSettled([f.decide(), other.decide(f.p, 'approve', 'other-invoke', f.ctx())]);
  const p = await f.settled(); assert.equal(p.state, 'opened');
  assert.equal(p.outcome?.kind, 'opened');
  const posts = f.requests.filter(r => r.method === 'POST'); assert.equal(posts.length, 1);
  assert.deepEqual(posts[0]!.body, { base: 'main', head: 'orka/fix', title: 'Retry the lease read', body: 'Agent-written description' });
  assert.ok(f.requests.every(r => r.method === 'GET' || r.path === '/repos/example/project/pulls'));
  const { buildPullRequestCard } = await import('../src/teams/pull-request-card.js');
  assert.match(JSON.stringify(buildPullRequestCard(p, 'sender', true)), /changed while/);
  assert.match(JSON.stringify(buildPullRequestCard(p, 'sender', true)), /ccccccc/);
});
test('moved_head_opens_nothing and existing_pr_is_linked_without_post', async t => {
  const f = await decisionsFixture(t);
  f.behavior((req, res) => res.end(JSON.stringify(req.path === '/user' ? { id: 123 } : { ref: 'refs/heads/orka/fix', object: { type: 'commit', sha: 'b'.repeat(40) } })));
  await f.decide(); assert.equal((await f.settled()).state, 'branch-moved'); assert.ok(f.requests.every(r => r.method === 'GET'));
  const g = await decisionsFixture(t);
  g.behavior((req, res) => res.end(JSON.stringify(req.path === '/user' ? { id: 123 } : req.path.includes('/git/ref/') ?
    { ref: 'refs/heads/orka/fix', object: { type: 'commit', sha: g.p.headSHA } } : [g.result()])));
  await g.decide(); const p = await g.settled(); assert.equal(p.state, 'opened');
  assert.ok(p.outcome?.kind === 'opened' && p.outcome.existing); assert.ok(g.requests.every(r => r.method === 'GET'));
});
test('slow_post_does_not_hold_invoke and request_disconnect_does_not_cancel_claimed_work', async t => {
  const f = await decisionsFixture(t); const gate = deferred(); let post = false;
  f.behavior((req, res) => {
    if (req.path === '/user') return void res.end('{"id":123}');
    if (req.path.includes('/git/ref/')) return void res.end(JSON.stringify({ ref: 'refs/heads/orka/fix', object: { type: 'commit', sha: f.p.headSHA } }));
    if (req.method === 'GET') return void res.end('[]');
    post = true; void gate.promise.then(() => { res.statusCode = 201; res.end(JSON.stringify(f.result())); });
  });
  const controller = new AbortController(); const started = performance.now();
  const p = await f.decide('approve', f.p, { ...f.ctx(), signal: controller.signal });
  assert.equal(p.state, 'approving'); assert.ok(performance.now() - started < 4000);
  controller.abort(); await eventually(() => post); gate.resolve(); assert.equal((await f.settled()).state, 'opened');
});
test('timeout_or_crash_never_reposts after uncertain native POST', async t => {
  const f = await decisionsFixture(t);
  f.behavior((req, res) => {
    if (req.path === '/user') return void res.end('{"id":123}');
    if (req.path.includes('/git/ref/')) return void res.end(JSON.stringify({ ref: 'refs/heads/orka/fix', object: { type: 'commit', sha: f.p.headSHA } }));
    if (req.method === 'GET') return void res.end('[]'); res.destroy();
  });
  await f.decide(); assert.equal((await f.settled()).state, 'uncertain');
  const other = f.make(f.open()); await other.decide(f.p, 'approve', 'again', f.ctx());
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});
test('disconnect_during_acquire_or_before_post_fences_effect and fresh numeric ID is required', async t => {
  for (const disconnect of [true, false]) {
    const f = await decisionsFixture(t);
    f.behavior((req, res) => {
      assert.equal(req.path, '/user');
      if (disconnect) void f.gh.disconnect(f.subject, context()).then(() => res.end('{"id":123}'));
      else res.end('{"id":999}');
    });
    await f.decide(); await f.settled(); assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  }
});
test('operation_deadline_settles_uncertain_after_native_work_drains', { timeout: 10000 }, async t => {
  const f = await decisionsFixture(t); const reached = deferred();
  f.behavior((req, res) => {
    if (req.path === '/user') return void res.end('{"id":123}');
    if (req.path.includes('/git/ref/')) return void res.end(JSON.stringify({ ref: 'refs/heads/orka/fix', object: { type: 'commit', sha: f.p.headSHA } }));
    if (req.method === 'GET') return void res.end('[]'); reached.resolve();
  });
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => t.mock.timers.reset());
  await f.decide(); await reached.promise;
  t.mock.timers.tick(26001); t.mock.timers.reset();
  const p = await f.settled(); assert.equal(p.state, 'uncertain');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});
test('http_422_is_no_effect_and_read_only_lookup and definite permission differs from generic 403', async t => {
  for (const [status, message, state, kind] of [[422, 'Validation Failed', 'failed', 'validation'], [403, 'Resource not accessible by integration', 'failed', 'permission'], [403, 'API rate limit exceeded', 'uncertain', 'uncertain']] as const) {
    const f = await decisionsFixture(t);
    f.behavior((req, res) => {
      if (req.path === '/user') return void res.end('{"id":123}');
      if (req.path.includes('/git/ref/')) return void res.end(JSON.stringify({ ref: 'refs/heads/orka/fix', object: { type: 'commit', sha: f.p.headSHA } }));
      if (req.method === 'GET') return void res.end('[]'); res.statusCode = status; res.end(JSON.stringify({ message }));
    });
    await f.decide(); const p = await f.settled(); assert.equal(p.state, state); assert.equal(p.outcome?.kind, kind);
    const post = f.requests.findIndex(r => r.method === 'POST'); assert.ok(post >= 0);
    assert.ok(f.requests.slice(post + 1).every(r => r.method === 'GET'));
    if (status === 422) assert.equal(f.requests.at(-1)!.method, 'GET');
  }
});
test('service_close_aborts_and_drains_effects', async t => {
  const f = await decisionsFixture(t); let reached = false;
  f.behavior(() => { reached = true; }); await f.decide(); await eventually(() => reached);
  await f.service.close(); assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  await assert.rejects(f.decide());
});
test('effect_capacity_exhausted_does_not_claim', async t => {
  const f = await decisionsFixture(t); f.behavior(() => {});
  for (let i = 0; i < 4; i++) {
    const p = proposalFixture(`op-${i}`); await f.store.reserveProposal(p, `op-${i}`, context());
    await f.decide('approve', p);
  }
  const p = proposalFixture('fifth'); await f.store.reserveProposal(p, 'fifth', context());
  assert.equal((await f.decide('approve', p)).state, 'pending'); await f.service.close();
});
test('expired_task_live_proposal_can_be_rejected without a Task pass or Orka turn', async t => {
  const f = await decisionsFixture(t); f.advance(600001);
  const p = await f.decide('reject'); assert.equal(p.state, 'rejected');
  assert.equal(f.requests.length, 0); assert.equal(p.claim?.invokeActivityId, 'invoke');
});
