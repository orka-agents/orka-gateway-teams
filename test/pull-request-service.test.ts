import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountStore } from '../src/accounts/store.js';
import { createGitHub } from '../src/accounts/github.js';
import { createPullRequestService } from '../src/accounts/pull-request-service.js';
import { createTaskService } from '../src/accounts/task-service.js';
import { proposalIdentity } from '../src/accounts/pull-request-proposal.js';
import { grantsFixture } from './support/task-grants.js';
import { toolsFixture } from './support/github-tools.js';
import { binding, context } from './support/directory-table.js';
import { proposalFixture } from './support/pull-request-proposal.js';
import { decisionsFixture } from './support/pull-request-decisions.js';
import { eventually, deferred } from './support/directory-table.js';
async function revisionStatus(f: Awaited<ReturnType<typeof decisionsFixture>>, status: string) {
  for (let i = 0; i < 1000; i++) {
    const p = (await f.store.getProposal(f.p.id, context()))!.proposal;
    if (p.revisionAdmission === status) return p;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('revision did not settle');
}
const args = { owner: 'example', repo: 'project', base: 'main', head: 'orka/fix', title: 'Retry the lease read', body: 'Agent-written description' };
const commit = (name = 'Orka Publisher', email = 'publisher@orka.ai') => ({ sha: 'a'.repeat(40), commit: { author: { name, email }, committer: { name: 'Other', email: 'other@example.invalid' } }, author: null });
async function setup(t: test.TestContext) {
  const f = await grantsFixture(t); const remote = await toolsFixture(t); let sent = 0;
  const ghAccounts = createAccountStore(binding, Buffer.alloc(32, 7), f.dependencies, f.authority, f.now, 'github'); t.after(() => ghAccounts.close());
  const ch = await ghAccounts.challenge(f.subject, 'chat-private', 'github', context()); await ghAccounts.claim(ch, context());
  await ghAccounts.complete(ch, { accessToken: 'GH_ACCESS_PRIVATE', refreshToken: 'GH_REFRESH_PRIVATE', providerUserId: '12345', expiresAt: f.now() + 100_000, refreshExpiresAt: f.now() + 1_000_000 }, context());
  const github = createGitHub({ clientId: 'client', clientSecret: 'CLIENT_PRIVATE', publicOrigin: 'https://signin.example.invalid' }, { request: remote.request }); t.after(() => github.close());
  let author: unknown = commit(); let total = 1; let oversized = false; let heldPage = false; let complete = true; let longFiles = false;
  remote.behavior((req, res) => {
    if (req.path === '/user') return void res.end('{"id":12345,"login":"sender"}');
    if (req.path.includes('/git/ref/heads/')) return void res.end(JSON.stringify({ ref: 'refs/heads/orka/fix', object: { type: 'commit', sha: 'a'.repeat(40) } }));
    if (heldPage && req.path.endsWith('page=2')) return;
    res.end(oversized ? 'x'.repeat(1024 * 1024 + 1) : JSON.stringify({ total_commits: total, base_commit: { sha: 'b'.repeat(40) },
      commits: Array.from({ length: req.path.endsWith('page=1') ? Math.min(total, 100) : total - 100 }, (_, i) => req.path.endsWith('page=2') && i === 0 ? author : commit()),
      files: req.path.endsWith('page=1') ? Array.from({ length: longFiles ? 10 : complete ? 1 : 300 }, (_, i) => ({ filename: longFiles ? 'f'.repeat(3990) + `${i}.ts` : `src/file-${i}.ts`, additions: 3, deletions: 1, patch: 'PRIVATE PATCH' })) : undefined }));
  });
  const p = proposalFixture(); const { conversationId, replyTarget, route, senderMRI, objectId, displayName, activityId } = p;
  const grant = { ...f.input, githubGeneration: 2, tools: ['workiq', 'github-propose-pull-request'],
    proposalOrigin: { conversationId, replyTarget, route, senderMRI, objectId, displayName, activityId } };
  await f.store.reserveGrant(grant, context());
  let outcome: 'delivered' | 'uncertain' | 'unavailable' = 'delivered';
  const proposals = createPullRequestService({ accounts: f.store, githubAccounts: ghAccounts, github, scope: { appId: binding.appId, tenantId: binding.tenantId }, now: f.now,
    postProposal: async (proposal, ctx) => { assert.equal((await f.store.getProposal(proposal.id, ctx))?.proposal.state, 'pending'); sent++; return outcome; } });
  const service = createTaskService({ accounts: f.store, authority: f.authority, now: f.now,
    targets: [{ id: 'tools', gatewayUid: 'gateway', identityDigest: f.input.targetDigest, taskPassToken: 'CONTROLLER_PRIVATE' }],
    auth: { exchange: async () => { throw new Error('not SSO'); }, refresh: async () => { throw new Error('not renewal'); } },
    github: { accounts: ghAccounts, auth: github }, proposals, privateCredentials: ['DELIVERY_PRIVATE', 'QUOTED_"_PRIVATE'] }); t.after(() => service.close());
  const body = { protocolVersion: 'orka.gateway.v1', grantRef: grant.ref, namespaceUID: 'ns', gatewayUID: 'gateway', taskUID: 'task', tools: grant.tools, deadline: new Date(f.now() + 600000).toISOString() };
  const issue = async (input = body) => { const r = await service.handle('/v1/task-passes', 'CONTROLLER_PRIVATE', input, context()); assert.equal(r.status, 200); return (r.body as { pass: string }).pass; };
  const call = async (value: unknown = args, key = 'operation', ctx = context()) => service.handle('/v1/task-tools/github-propose-pull-request', await issue(), value, ctx, key);
  return { ...f, ...remote, github, proposals, service, grant, body, issue, call, sent: () => sent,
    total: (n: number) => { total = n; }, author: (v: unknown) => { author = v; }, oversized: () => { oversized = true; },
    holdPage: () => { heldPage = true; }, longFiles: () => { longFiles = true; }, incomplete: () => { complete = false; }, outcome: (v: typeof outcome) => { outcome = v; } };
}
test('revise_note_becomes_one_normal_turn and new_note_cannot_replace_winning_note', async t => {
  const f = await decisionsFixture(t); const gate = deferred(); let admissions = 0;
  const service = f.make(f.store, async (p, ctx) => {
    admissions++; const saved = (await f.store.getProposal(p.id, context()))!.proposal;
    assert.deepEqual(saved.claim, p.claim); assert.equal(saved.revisionAdmission, 'pending');
    assert.equal(p.claim?.note, 'also add a regression test'); assert.equal(ctx.subject.objectId, p.objectId);
    await gate.promise; return 'delivered';
  });
  const immediate = await service.decide(f.p, 'revise', 'first-invoke', f.ctx(), 'also add a regression test');
  assert.equal(immediate.state, 'revise-requested'); assert.equal(immediate.revisionAdmission, 'pending');
  await eventually(() => admissions === 1);
  await service.decide(f.p, 'revise', 'second-invoke', f.ctx(), 'different note');
  gate.resolve(); const p = await revisionStatus(f, 'delivered');
  assert.equal(p.claim?.invokeActivityId, 'first-invoke'); assert.equal(p.claim?.note, 'also add a regression test');
  assert.ok(p.claim?.revisionReplyTarget); assert.notEqual(p.claim?.revisionReplyTarget, p.replyTarget);
  assert.equal(admissions, 1); assert.equal(f.requests.length, 0);
});

test('note_at_2000_chars_accepted_2001_rejected and invalid Unicode/controls never claims', async t => {
  const f = await decisionsFixture(t); let admissions = 0;
  const service = f.make(f.store, async () => { admissions++; return 'delivered'; });
  for (const note of [' ', 'x'.repeat(2001), '😀'.repeat(2001), '\ud800', 'text\u0000', 'text\u001b', 'text\u0085']) {
    await assert.rejects(service.decide(f.p, 'revise', 'invalid', f.ctx(), note));
    assert.equal((await f.store.getProposal(f.p.id, context()))!.proposal.state, 'pending');
  }
  await service.decide(f.p, 'revise', 'valid', f.ctx(), '😀'.repeat(2000));
  assert.equal((await revisionStatus(f, 'delivered')).claim?.note, '😀'.repeat(2000)); assert.equal(admissions, 1);
});
test('full/pending admission resumes only under the current authenticated sender, with first bytes after restart', async t => {
  const f = await decisionsFixture(t); const seen: unknown[] = [];
  const first = f.make(f.store, async (p, ctx) => { seen.push({ claim: p.claim, sender: ctx.subject }); return 'full'; });
  await first.decide(f.p, 'revise', 'first', f.ctx(), 'first note'); const pending = await revisionStatus(f, 'full'); await first.close();
  const restarted = f.make(f.open(), async (p, ctx) => { seen.push({ claim: p.claim, sender: ctx.subject }); return 'delivered'; });
  await restarted.recover(context()); restarted.refresh(pending);
  restarted.refresh(pending, { ...f.ctx(), subject: { ...f.ctx().subject, objectId: 'other' } });
  restarted.refresh(pending, { ...f.ctx(), deadline: performance.now() - 1 });
  restarted.refresh(pending, { ...f.ctx(), delegatedTenant: false });
  restarted.refresh(pending, { ...f.ctx(), controlRecipient: { id: '29:other' } });
  await f.store.getProposal(f.p.id, context()); assert.equal(seen.length, 1);
  await restarted.decide(f.p, 'revise', 'new-id', f.ctx(), 'new note');
  await revisionStatus(f, 'delivered'); assert.equal(seen.length, 2); assert.deepEqual(seen[1], seen[0]);
  assert.equal(f.requests.length, 0);
});
for (const crash of ['before-admit', 'after-admit'] as const) test(`crash_${crash}_replays_same_event and replacement preserves pending first claim`, async t => {
  const f = await decisionsFixture(t); const admitted = new Map<string, string>(); let firstAttempt = true; const attempted = deferred();
  const admission = async (p: typeof f.p) => {
    const key = p.claim!.invokeActivityId; const bytes = JSON.stringify({ claim: p.claim, route: p.route, sender: p.senderMRI, profile: p.displayName });
    if (admitted.has(key)) assert.equal(admitted.get(key), bytes); attempted.resolve();
    if (firstAttempt && crash === 'before-admit') throw new Error('simulated crash before inbox');
    admitted.set(key, bytes);
    if (firstAttempt) throw new Error('simulated lost inbox result');
    return 'delivered' as const;
  };
  const service = f.make(f.store, admission);
  await service.decide(f.p, 'revise', 'original-invoke', f.ctx(), 'original note');
  // close drains this failed owned effect; evidence remains pending in retained Table maps.
  await attempted.promise; await service.close();
  const pending = (await f.store.getProposal(f.p.id, context()))!.proposal; assert.equal(pending.revisionAdmission, 'pending');
  const next = proposalFixture('replacement'); await f.store.reserveProposal(next, 'replacement', context());
  assert.deepEqual((await f.store.getProposal(f.p.id, context()))!.proposal.claim, pending.claim);
  firstAttempt = false; const restarted = f.make(f.open(), admission);
  await restarted.recover(context()); assert.equal(admitted.size, crash === 'before-admit' ? 0 : 1);
  restarted.refresh(pending, f.ctx()); const delivered = await revisionStatus(f, 'delivered');
  assert.equal(admitted.size, 1); assert.deepEqual(delivered.claim, pending.claim);
  assert.equal((await f.store.getProposal(next.id, context()))!.proposal.state, 'pending');
  assert.equal(f.requests.length, 0);
});
test('claim projection failure resumes the selector winner on authenticated refresh, never startup', async t => {
  const f = await decisionsFixture(t); let admissions = 0;
  const service = f.make(f.store, async () => { admissions++; return 'delivered'; });
  f.controls.hook = ({ req, body, res, reply }) => {
    if (req.method === 'PUT' && /^proposal_[a-f0-9]{64}$/u.test(String(body?.RowKey))) res.destroy(); else reply();
  };
  await assert.rejects(service.decide(f.p, 'revise', 'first', f.ctx(), 'first note'));
  const projected = (await f.store.getProposal(f.p.id, context()))!; assert.equal(projected.needsProjection, true);
  assert.equal(projected.proposal.claim?.note, 'first note'); assert.equal(admissions, 0); delete f.controls.hook; await service.close();
  const resumed = f.make(f.open(), async p => { admissions++; assert.equal(p.claim?.note, 'first note'); return 'delivered'; });
  await resumed.recover(context()); assert.equal(admissions, 0);
  resumed.refresh(projected.proposal, f.ctx()); await revisionStatus(f, 'delivered'); assert.equal(admissions, 1);
  assert.equal((await f.store.getProposal(f.p.id, context()))!.needsProjection, undefined);
});
test('maximum revision note fits retained near-48KiB previews without duplicating the note', async t => {
  const f = await decisionsFixture(t); const p = proposalFixture('large'); p.body = 'b'.repeat(16384);
  p.files = Array.from({ length: 8 }, (_, n) => ({ path: 'f'.repeat(4090) + n, additions: 1, deletions: 1 })); p.fileCount = 8; f.redigest(p);
  const size = () => Buffer.byteLength(JSON.stringify({ kind: 'proposal', objectId: p.objectId, generation: p.generation, proposal: p }));
  p.files[7]!.path = p.files[7]!.path.slice(0, p.files[7]!.path.length - (size() - (48 * 1024 - 128))); f.redigest(p);
  assert.ok(size() <= 48 * 1024 && size() > 48 * 1024 - 256);
  const saved = await f.store.reserveProposal(p, 'large', context()); assert.deepEqual(saved.files, p.files);
  const service = f.make(f.store, async () => 'delivered'); await service.decide(saved, 'revise', 'max-note', f.ctx(), '😀'.repeat(2000));
  const delivered = await revisionStatus({ ...f, p: saved }, 'delivered'); assert.equal(delivered.claim?.note, '😀'.repeat(2000));
  assert.equal(delivered.payloadDigest, saved.payloadDigest); assert.deepEqual(delivered.files, p.files);
  assert.ok([...f.rows.values()].every(row => Buffer.from(String(row.Payload), 'base64').length <= 65536));
});

test('propose_is_local_not_pulls_post and same_operation_replays_without_reads_or_new_candidate', async t => {
  const f = await setup(t); const first = await f.call(); assert.equal(first.status, 200); assert.match(JSON.stringify(first.body), /Approval card sent/);
  assert.ok(f.requests.every(r => r.method === 'GET')); const n = f.requests.length;
  assert.deepEqual(await f.call(), first); assert.equal(f.requests.length, n);
  assert.equal((await f.call({ ...args, title: 'changed' })).status, 403); assert.equal(f.requests.length, n);
  const p = (await f.store.getProposal(proposalIdentity(f.grant.ref, 'task', 'operation'), context()))!.proposal;
  assert.equal(p.githubId, '12345'); assert.equal(p.githubLogin, 'sender'); assert.equal(p.files.length, 1);
  assert.ok(!JSON.stringify(p).includes('PRIVATE PATCH'));
  for (const invalid of [{ ...args, draft: true }, { ...args, head: 'other:branch' }, { ...args, base: '../main' }]) assert.notEqual((await f.call(invalid, 'invalid')).status, 200);
});
test('replaying the original proposal after Revise reports no longer pending without another card or GitHub read', async t => {
  const f = await setup(t); assert.equal((await f.call()).status, 200);
  const p = (await f.store.getProposal(proposalIdentity(f.grant.ref, 'task', 'operation'), context()))!.proposal;
  assert.equal(await f.store.claimProposal(p, { decision: 'revise', tenantId: p.tenantId, objectId: p.objectId,
    invokeActivityId: 'revise-invoke', decidedAt: f.now(), note: 'add a test', revisionReplyTarget: 'revision-reply' }, context()), true);
  const requests = f.requests.length;
  const replay = await f.call(); assert.equal(replay.status, 200); assert.match(JSON.stringify(replay.body), /no longer pending/);
  assert.equal(f.sent(), 1); assert.equal(f.requests.length, requests);
  const saved = (await f.store.getProposal(p.id, context()))!.proposal;
  assert.equal(saved.state, 'revise-requested'); assert.equal(saved.claim?.note, 'add a test');
});
test('expired saved revision sign-in requires a fresh ordinary message challenge, not renewal of the old activity', async t => {
  const f = await grantsFixture(t); const saved = await f.store.challenge(f.subject, 'chat-private', 'revision-invoke', context());
  f.advance(600001);
  const replay = await f.store.challenge(f.subject, 'chat-private', 'revision-invoke', context());
  assert.equal(replay.id, saved.id); assert.ok(replay.expiresAt < f.now());
  assert.equal(await f.store.claim(replay, context()), 'unavailable');
  const fresh = await f.store.challenge(f.subject, 'chat-private', 'ordinary-message', context());
  assert.notEqual(fresh.id, saved.id); assert.ok(fresh.expiresAt > f.now());
  assert.equal(await f.store.claim(fresh, context()), 'claimed');
});
test('pagination_checks_later_authors and compare_requires_every_git_author', async t => {
  const f = await setup(t); f.total(101);
  for (const author of [null, { sha: 'a'.repeat(40), commit: { author: null } }, commit('Foreign'), commit('Orka Publisher', 'other@example.invalid')]) {
    f.author(author); const result = await f.call(args, `bad-${f.requests.length}`); assert.equal(result.status, 503);
  }
  assert.equal(f.sent(), 0); f.author(commit()); assert.equal((await f.call()).status, 200);
  assert.ok(f.requests.some(r => r.path.includes('b'.repeat(40) + '...' + 'a'.repeat(40)) && r.path.endsWith('page=2')));
});
test('compare_over_1MiB_is_fixed_unavailable and paginated_author_checks_stop_at_existing_deadline_without_card', async t => {
  const f = await setup(t); f.oversized(); assert.equal((await f.call()).status, 503); assert.equal(f.sent(), 0);
  const h = await setup(t); h.total(101); h.holdPage();
  assert.equal((await h.call(args, 'deadline', { ...context(), deadline: performance.now() + 1000 })).status, 503); assert.equal(h.sent(), 0);
});
test('300 returned files explicitly mark incomplete counts without storing patches or all filenames', async t => {
  const f = await setup(t); f.incomplete(); assert.equal((await f.call()).status, 200);
  const p = (await f.store.getProposal(proposalIdentity(f.grant.ref, 'task', 'operation'), context()))!.proposal;
  assert.equal(p.filesComplete, false); assert.equal(p.fileCount, 300); assert.equal(p.additions, 900); assert.equal(p.files.length, 10);
});
test('large descriptions and filename previews respect the complete encrypted document budget', async t => {
  const f = await setup(t); f.longFiles();
  assert.equal((await f.call({ ...args, body: 'b'.repeat(16384) })).status, 200);
  const p = (await f.store.getProposal(proposalIdentity(f.grant.ref, 'task', 'operation'), context()))!.proposal;
  assert.equal(p.fileCount, 10); assert.equal(p.additions, 30); assert.ok(p.files.length > 0 && p.files.length < 10);
});
test('child_tool_omission_denied and both provider credential sentinels never reach card persistence', async t => {
  const f = await setup(t); await f.issue();
  const child = { ...f.body, taskUID: 'child', parentTaskUID: 'task', tools: ['workiq'] };
  assert.notEqual((await f.service.handle('/v1/task-tools/github-propose-pull-request', await f.issue(child), args, context(), 'child')).status, 200);
  for (const secret of ['ACCESS-PRIVATE', 'REFRESH-PRIVATE', 'GH_ACCESS_PRIVATE', 'GH_REFRESH_PRIVATE', 'CLIENT_PRIVATE', 'DELIVERY_PRIVATE', 'CONTROLLER_PRIVATE', 'QUOTED_"_PRIVATE']) {
    assert.equal((await f.call({ ...args, body: secret }, 'secret-' + secret)).status, 503);
  }
  assert.equal(f.sent(), 0); assert.equal([...f.rows.values()].filter(r => /^proposal_[a-f0-9]{64}$/u.test(String(r.RowKey))).length, 0);
});
test('candidate publication can resume after selector CREATE was proven absent without refetching GitHub', async t => {
  const f = await setup(t); let fail = true;
  f.controls.hook = ({ req, body, res, reply }) => {
    if (fail && req.method === 'POST' && String(body?.RowKey).startsWith('proposal_selector_')) res.destroy(); else reply();
  };
  assert.equal((await f.call()).status, 503); const reads = f.requests.length; assert.equal(f.sent(), 0);
  fail = false; assert.equal((await f.call()).status, 200); assert.equal(f.requests.length, reads); assert.equal(f.sent(), 1);
});
test('saved proposal distinguishes unknown card arrival from proven no-effect', async t => {
  const f = await setup(t); f.outcome('uncertain'); const r = await f.call(); assert.equal(r.status, 200); assert.match(JSON.stringify(r.body), /could not confirm/);
  f.outcome('unavailable'); assert.equal((await f.call(args, 'other')).status, 503);
});
