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
test('closePullRequest sends one PATCH and succeeds only when GitHub reports that pull request closed', async t => {
  const f = await setup(t);
  f.behavior((_req, res) => res.end(JSON.stringify({ ...f.result(), state: 'closed' })));
  await f.github.closePullRequest(f.p, 12, 'TOKEN_PRIVATE', context());
  assert.deepEqual(f.requests.map(r => [r.method, r.path, r.body]), [['PATCH', '/repos/example/project/pulls/12', { state: 'closed' }]]);
  for (const answer of [{ ...f.result(), state: 'open' }, { ...f.result(), number: 13, html_url: 'https://github.com/example/project/pull/13', state: 'closed' }, { state: 'closed' }]) {
    f.behavior((_req, res) => res.end(JSON.stringify(answer)));
    await assert.rejects(f.github.closePullRequest(f.p, 12, 'TOKEN_PRIVATE', context()));
  }
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

test('no-response is reported only when GitHub gave no answer: a server error or a dropped connection, never an answer the gateway did not expect or its own stop', async t => {
  const f = await setup(t); const code = async (work: Promise<unknown>) => { try { await work; return 'none'; } catch (e: any) { return e.code as string; } };
  for (const status of [500, 502, 503]) {
    f.behavior((_req, res) => { res.statusCode = status; res.end('{}'); });
    assert.equal(await code(f.github.readHead(f.p, 'TOKEN_PRIVATE', context())), 'no-response', String(status));
  }
  // A proxy's error page is not JSON; it is still no answer from GitHub.
  f.behavior((_req, res) => { res.statusCode = 502; res.setHeader('content-type', 'text/html'); res.end('<html></html>'); });
  assert.equal(await code(f.github.readHead(f.p, 'TOKEN_PRIVATE', context())), 'no-response');
  f.behavior((_req, res) => { res.destroy(); });
  assert.equal(await code(f.github.findPullRequest(f.p, 'TOKEN_PRIVATE', context())), 'no-response');
  f.behavior((_req, res) => { res.write('[{"number"'); setImmediate(() => res.destroy()); });
  assert.equal(await code(f.github.findPullRequest(f.p, 'TOKEN_PRIVATE', context())), 'no-response');
  // GitHub answered: a deleted branch, a rate limit, an unexpected body.
  for (const [status, body] of [[404, '{"message":"Not Found"}'], [403, '{"message":"API rate limit exceeded"}'], [200, '{"ref":"refs/heads/other"}'], [200, 'not json']] as const) {
    f.behavior((_req, res) => { res.statusCode = status; res.end(body); });
    assert.equal(await code(f.github.readHead(f.p, 'TOKEN_PRIVATE', context())), 'unavailable', `${status} ${body}`);
  }
  f.behavior((_req, res) => { res.statusCode = 401; res.end('{}'); });
  assert.equal(await code(f.github.readHead(f.p, 'TOKEN_PRIVATE', context())), 'unauthorized');
  // The gateway's own stop while GitHub is still working is not GitHub's silence.
  const stop = new AbortController(); f.behavior(() => { stop.abort(); });
  assert.equal(await code(f.github.readHead(f.p, 'TOKEN_PRIVATE', { ...context(), signal: stop.signal })), 'unavailable');
  // Nor is a deadline of the gateway's own that is shorter than the request's eight seconds.
  f.behavior(() => { /* never answers */ });
  assert.equal(await code(f.github.readHead(f.p, 'TOKEN_PRIVATE', { ...context(), deadline: performance.now() + 200 })), 'unavailable');
});
