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
const args = { owner: 'example', repo: 'project', base: 'main', head: 'orka/fix', title: 'Retry the lease read', body: 'Agent-written description' };
const commit = (name = 'Orka Publisher', email = 'publisher@orka.ai') => ({ sha: 'a'.repeat(40), commit: { author: { name, email }, committer: { name: 'Other', email: 'other@example.invalid' } }, author: null });
async function setup(t: test.TestContext) {
  const f = await grantsFixture(t); const remote = await toolsFixture(t); let sent = 0;
  const ghAccounts = createAccountStore(binding, Buffer.alloc(32, 7), f.dependencies, f.authority, f.now, 'github'); t.after(() => ghAccounts.close());
  const ch = await ghAccounts.challenge(f.subject, 'chat-private', 'github', context()); await ghAccounts.claim(ch, context());
  await ghAccounts.complete(ch, { accessToken: 'GH_ACCESS_PRIVATE', refreshToken: 'GH_REFRESH_PRIVATE', providerUserId: '12345', expiresAt: f.now() + 100_000, refreshExpiresAt: f.now() + 1_000_000 }, context());
  const github = createGitHub({ clientId: 'client', clientSecret: 'CLIENT_PRIVATE', publicOrigin: 'https://signin.example.invalid' }, { request: remote.request }); t.after(() => github.close());
  let author: unknown = commit(); let total = 1; let oversized = false; let heldPage = false; let complete = true;
  remote.behavior((req, res) => {
    if (req.path === '/user') return void res.end('{"id":12345,"login":"sender"}');
    if (req.path.includes('/git/ref/heads/')) return void res.end(JSON.stringify({ ref: 'refs/heads/orka/fix', object: { type: 'commit', sha: 'a'.repeat(40) } }));
    if (heldPage && req.path.endsWith('page=2')) return;
    res.end(oversized ? 'x'.repeat(1024 * 1024 + 1) : JSON.stringify({ total_commits: total, base_commit: { sha: 'b'.repeat(40) },
      commits: Array.from({ length: req.path.endsWith('page=1') ? Math.min(total, 100) : total - 100 }, (_, i) => req.path.endsWith('page=2') && i === 0 ? author : commit()),
      files: req.path.endsWith('page=1') ? Array.from({ length: complete ? 1 : 300 }, (_, i) => ({ filename: `src/file-${i}.ts`, additions: 3, deletions: 1, patch: 'PRIVATE PATCH' })) : undefined }));
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
    github: { accounts: ghAccounts, auth: github }, proposals, privateCredentials: ['DELIVERY_PRIVATE'] }); t.after(() => service.close());
  const body = { protocolVersion: 'orka.gateway.v1', grantRef: grant.ref, namespaceUID: 'ns', gatewayUID: 'gateway', taskUID: 'task', tools: grant.tools, deadline: new Date(f.now() + 600000).toISOString() };
  const issue = async (input = body) => { const r = await service.handle('/v1/task-passes', 'CONTROLLER_PRIVATE', input, context()); assert.equal(r.status, 200); return (r.body as { pass: string }).pass; };
  const call = async (value: unknown = args, key = 'operation', ctx = context()) => service.handle('/v1/task-tools/github-propose-pull-request', await issue(), value, ctx, key);
  return { ...f, ...remote, github, proposals, service, grant, body, issue, call, sent: () => sent,
    total: (n: number) => { total = n; }, author: (v: unknown) => { author = v; }, oversized: () => { oversized = true; },
    holdPage: () => { heldPage = true; }, incomplete: () => { complete = false; }, outcome: (v: typeof outcome) => { outcome = v; } };
}
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
test('child_tool_omission_denied and both provider credential sentinels never reach card persistence', async t => {
  const f = await setup(t); await f.issue();
  const child = { ...f.body, taskUID: 'child', parentTaskUID: 'task', tools: ['workiq'] };
  assert.notEqual((await f.service.handle('/v1/task-tools/github-propose-pull-request', await f.issue(child), args, context(), 'child')).status, 200);
  for (const secret of ['ACCESS-PRIVATE', 'REFRESH-PRIVATE', 'GH_ACCESS_PRIVATE', 'GH_REFRESH_PRIVATE', 'CLIENT_PRIVATE', 'DELIVERY_PRIVATE', 'CONTROLLER_PRIVATE']) {
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
