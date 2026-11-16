import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHub } from '../src/accounts/github.js';
import { toolsFixture } from './support/github-tools.js';
import { proposalFixture } from './support/pull-request-proposal.js';
import { context } from './support/directory-table.js';
async function setup(t: test.TestContext) {
  const f = await toolsFixture(t); const github = createGitHub({ clientId: 'client', clientSecret: 'CLIENT_PRIVATE', publicOrigin: 'https://signin.example.invalid' }, { request: f.request });
  t.after(() => github.close()); const p = proposalFixture();
  const result = () => ({ number: 12, html_url: 'https://github.com/example/project/pull/12', head: { ref: p.head, sha: p.headSHA, repo: { full_name: 'example/project' } }, base: { ref: p.base, repo: { full_name: 'example/project' } } });
  return { ...f, github, p, result };
}
test('GitHub complete 422 is definite validation and permission vs rate limit is not misreported', async t => {
  const f = await setup(t);
  for (const [status, message, want] of [[422, 'Validation Failed', 'validation'], [403, 'Resource not accessible by integration', 'permission'], [403, 'API rate limit exceeded', 'unavailable']] as const) {
    f.behavior((_req, res) => { res.statusCode = status; res.end(JSON.stringify({ message })); });
    await assert.rejects(f.github.openProposedPullRequest(f.p, 'TOKEN_PRIVATE', context()), (e: any) => e.code === want);
  }
  assert.equal(f.requests.length, 3); assert.ok(f.requests.every(r => r.method === 'POST'));
});
test('findPullRequest validates repository refs URLs and uniqueness across pages', async t => {
  const f = await setup(t); let page = 0;
  f.behavior((_req, res) => { page++; const unrelated = { ...f.result(), head: { ...f.result().head, ref: 'other' } }; res.end(JSON.stringify(page === 1 ? Array.from({ length: 100 }, () => unrelated) : [f.result()])); });
  assert.deepEqual(await f.github.findPullRequest(f.p, 'TOKEN_PRIVATE', context(), true), { kind: 'opened', number: 12, url: 'https://github.com/example/project/pull/12', headSHA: f.p.headSHA, existing: true });
  assert.equal(f.requests.length, 2); assert.ok(f.requests.every(r => r.method === 'GET' && r.path.includes('state=all')));
  f.behavior((_req, res) => res.end(JSON.stringify([f.result(), f.result()])));
  await assert.rejects(f.github.findPullRequest(f.p, 'TOKEN_PRIVATE', context(), true));
  f.behavior((_req, res) => res.end(JSON.stringify([{ ...f.result(), html_url: 'https://evil.invalid/' }])));
  await assert.rejects(f.github.findPullRequest(f.p, 'TOKEN_PRIVATE', context(), true));
});
