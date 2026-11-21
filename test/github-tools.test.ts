import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHub, githubArguments, headAllowed, repositoryAllowed, REPOSITORY_NOT_ALLOWED } from '../src/accounts/github.js';
import { context, deferred } from './support/directory-table.js';
import { toolsFixture } from './support/github-tools.js';

const config = { clientId: 'Iv1.synthetic', clientSecret: 'CLIENT_PRIVATE', publicOrigin: 'https://signin.example.invalid' };
const repository = { owner: 'acme', repo: 'repo' };
test('four GitHub operations have closed arguments and fixed encoded resource paths, methods and safe projections', async t => {
  const f = await toolsFixture(t); const client = createGitHub(config, { request: f.request }); t.after(() => client.close());
  assert.deepEqual(await client.tool('github-read-file', { ...repository, path: 'dir/file.txt', ref: 'feature/one' }, 'ACCESS_PRIVATE', context()), { text: 'Hello\n' });
  assert.deepEqual(await client.tool('github-list-issues', { ...repository, state: 'open' }, 'ACCESS_PRIVATE', context()), { text: '[{"number":7,"title":"Bug","state":"open","url":"https://github.com/acme/repo/issues/7"}]' });
  assert.deepEqual(await client.tool('github-create-issue', { ...repository, title: 'Issue', body: 'Description' }, 'ACCESS_PRIVATE', context()), { text: '{"number":8,"url":"https://github.com/acme/repo/issues/8"}' });
  assert.deepEqual(await client.tool('github-create-pull-request', { ...repository, title: 'PR', head: 'contributor:feature/one', base: 'main' }, 'ACCESS_PRIVATE', context()), { text: '{"number":8,"url":"https://github.com/acme/repo/pull/8"}' });
  assert.deepEqual(f.requests.map(r => [r.method, r.path]), [['GET', '/repos/acme/repo/contents/dir/file.txt?ref=feature%2Fone'], ['GET', '/repos/acme/repo/issues?state=open&per_page=30&page=1'], ['POST', '/repos/acme/repo/issues'], ['POST', '/repos/acme/repo/pulls']]);
  assert.deepEqual(f.requests[2]!.body, { title: 'Issue', body: 'Description' }); assert.deepEqual(f.requests[3]!.body, { title: 'PR', head: 'contributor:feature/one', base: 'main' });
  assert.ok(f.requests.every(r => r.authorization === 'Bearer ACCESS_PRIVATE'));
  for (const extra of ['url', 'headers', 'token', 'objectId', 'identity', 'provider']) assert.throws(() => githubArguments('github-create-issue', { ...repository, title: 't', [extra]: 'x' }));
  for (const invalid of [{ owner: '..' }, { owner: 'https://evil' }, { repo: '.' }, { repo: 'repo/other' }, { title: '' }, { title: 'x'.repeat(257) }]) assert.throws(() => githubArguments('github-create-issue', { ...repository, title: 't', ...invalid }));
  for (const path of ['../secret', '/absolute', 'dir/../x', 'dir//x', 'dir\\x', 'x\u0000']) assert.throws(() => githubArguments('github-read-file', { ...repository, path }));
  assert.throws(() => githubArguments('github-list-issues', { ...repository, state: 'anything' }));
});
test('a full thirty-issue REST page is accepted before reducing it to the bounded projection', async t => {
  const f = await toolsFixture(t); const client = createGitHub(config, { request: f.request }); t.after(() => client.close());
  const user = { login: 'example-user', id: 1, node_id: 'synthetic-user', avatar_url: 'https://avatars.githubusercontent.com/u/1',
    gravatar_id: '', url: 'https://api.github.com/users/example-user', html_url: 'https://github.com/example-user',
    followers_url: 'https://api.github.com/users/example-user/followers', following_url: 'https://api.github.com/users/example-user/following{/other_user}',
    gists_url: 'https://api.github.com/users/example-user/gists{/gist_id}', starred_url: 'https://api.github.com/users/example-user/starred{/owner}{/repo}',
    subscriptions_url: 'https://api.github.com/users/example-user/subscriptions', organizations_url: 'https://api.github.com/users/example-user/orgs',
    repos_url: 'https://api.github.com/users/example-user/repos', events_url: 'https://api.github.com/users/example-user/events{/privacy}',
    received_events_url: 'https://api.github.com/users/example-user/received_events', type: 'User', site_admin: false };
  const page = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, node_id: `synthetic-issue-${i + 1}`, number: i + 1,
    url: `https://api.github.com/repos/acme/repo/issues/${i + 1}`, repository_url: 'https://api.github.com/repos/acme/repo',
    labels_url: `https://api.github.com/repos/acme/repo/issues/${i + 1}/labels{/name}`, comments_url: `https://api.github.com/repos/acme/repo/issues/${i + 1}/comments`,
    events_url: `https://api.github.com/repos/acme/repo/issues/${i + 1}/events`, html_url: `https://github.com/acme/repo/issues/${i + 1}`,
    title: `Example ${i + 1}`, user, labels: [], state: 'open', locked: false, assignee: null, assignees: [], milestone: null, comments: 0,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null, author_association: 'CONTRIBUTOR',
    active_lock_reason: null, body: 'A routine issue description. '.repeat(100), closed_by: null,
    reactions: { url: `https://api.github.com/repos/acme/repo/issues/${i + 1}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: `https://api.github.com/repos/acme/repo/issues/${i + 1}/timeline`, performed_via_github_app: null, state_reason: null }));
  const payload = JSON.stringify(page); assert.ok(Buffer.byteLength(payload) > 65536);
  f.behavior((_req, res) => res.end(payload));
  const result = await client.tool('github-list-issues', repository, 'ACCESS_PRIVATE', context());
  const issues = JSON.parse(result.text) as unknown[];
  assert.equal(issues.length, 30);
  assert.deepEqual(issues[0], { number: 1, title: 'Example 1', state: 'open', url: 'https://github.com/acme/repo/issues/1' });
  assert.deepEqual(issues[29], { number: 30, title: 'Example 30', state: 'open', url: 'https://github.com/acme/repo/issues/30' });
  assert.ok(Buffer.byteLength(result.text) < 32768); assert.ok(!result.text.includes('routine issue description'));
  assert.equal(f.requests.length, 1);
  // Valid JSON with a tiny projection must still be refused when its REST body exceeds the bound.
  f.behavior((_req, res) => res.end(JSON.stringify([{ ...page[0], body: 'x'.repeat(1024 * 1024) }])));
  await assert.rejects(client.tool('github-list-issues', repository, 'ACCESS_PRIVATE', context()), { code: 'unavailable' });
  assert.equal(f.requests.length, 2);
});
test('native API creates require201 and cannot forward raw or credential-bearing provider output', async t => {
  const f = await toolsFixture(t); const client = createGitHub(config, { request: f.request }); t.after(() => client.close());
  for (const [status, response] of [[200, { number: 8 }], [201, { number: 8, html_url: 'https://evil.invalid/' }],
    [201, { number: 8, html_url: 'https://github.com/acme/repo/issues/8', extra: 'CLIENT_PRIVATE' }]]) {
    f.behavior((_req, res) => { res.statusCode = status as number; res.end(JSON.stringify(response)); });
    // Unused provider fields cannot leak. A valid number/URL projection is safe even with secret extra fields.
    if (status === 201 && 'extra' in (response as object)) assert.doesNotMatch(JSON.stringify(await client.tool('github-create-issue', { ...repository, title: 't' }, 'ACCESS_PRIVATE', context())), /PRIVATE/);
    else await assert.rejects(client.tool('github-create-issue', { ...repository, title: 't' }, 'ACCESS_PRIVATE', context()));
  }
  for (const text of ['ACCESS_PRIVATE', 'CLIENT_PRIVATE']) {
    f.behavior((_req, res) => res.end(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: text.length })));
    await assert.rejects(client.tool('github-read-file', { ...repository, path: 'file' }, 'ACCESS_PRIVATE', context()));
  }
  for (const response of [{ type: 'dir' }, { type: 'file', encoding: 'none', content: '' }, { type: 'file', encoding: 'base64', content: '/w==', size: 1 }]) {
    f.behavior((_req, res) => res.end(JSON.stringify(response))); await assert.rejects(client.tool('github-read-file', { ...repository, path: 'file' }, 'ACCESS_PRIVATE', context()));
  }
});
test('API401 is classified privately; final authority/deadline and close fence or drain native work', async t => {
  const f = await toolsFixture(t); const client = createGitHub(config, { request: f.request }); t.after(() => client.close());
  f.behavior((_req, res) => { res.statusCode = 401; res.end('{"message":"PRIVATE"}'); });
  await assert.rejects(client.tool('github-list-issues', repository, 'ACCESS_PRIVATE', context()), { code: 'unauthorized' });
  const before = f.requests.length;
  await assert.rejects(client.tool('github-list-issues', repository, 'ACCESS_PRIVATE', { ...context(), authorizeWrite: () => false }));
  await assert.rejects(client.tool('github-list-issues', repository, 'ACCESS_PRIVATE', { ...context(), deadline: performance.now() - 1 })); assert.equal(f.requests.length, before);
  const entered = deferred(); f.behavior(() => entered.resolve()); const pending = client.tool('github-list-issues', repository, 'ACCESS_PRIVATE', context());
  const rejected = assert.rejects(pending); await entered.promise; await client.close(); await rejected;
});
test('github-read-issue returns a bounded issue projection with a truncation note and closed arguments', async t => {
  const f = await toolsFixture(t); const client = createGitHub(config, { request: f.request }); t.after(() => client.close());
  const issue = (v: Record<string, unknown> = {}) => ({ number: 71, title: 'Reader', state: 'open', body: 'Steps', labels: [{ name: 'bug' }, 'area/ui'],
    html_url: 'https://github.com/acme/repo/issues/71', user: { login: 'not-forwarded' }, ...v });
  const read = async (v: Record<string, unknown> = {}) => { f.behavior((_req, res) => res.end(JSON.stringify(issue(v))));
    return JSON.parse((await client.tool('github-read-issue', { ...repository, number: 71 }, 'ACCESS_PRIVATE', context())).text) as Record<string, unknown>; };
  assert.deepEqual(await read(), { number: 71, title: 'Reader', state: 'open', labels: ['bug', 'area/ui'], url: 'https://github.com/acme/repo/issues/71', body: 'Steps' });
  assert.deepEqual(f.requests.map(r => [r.method, r.path]), [['GET', '/repos/acme/repo/issues/71']]);
  assert.deepEqual(await read({ state: 'closed', body: null, labels: [] }), { number: 71, title: 'Reader', state: 'closed', labels: [], url: 'https://github.com/acme/repo/issues/71', body: '' });
  assert.equal((await read({ pull_request: {}, html_url: 'https://github.com/acme/repo/pull/71' })).url, 'https://github.com/acme/repo/pull/71');
  // Escapes count toward the cap, so control-heavy bodies cannot push the whole result past the 32 KiB tool bound.
  for (const unit of ['x', '\u0001', '\u00e9', '\ud83d\ude00']) {
    const body = unit.repeat(40000); const result = await read({ body });
    assert.ok(body.startsWith(result.body as string)); assert.ok(Buffer.byteLength(JSON.stringify(result.body)) <= 16386);
    assert.ok(Buffer.byteLength(JSON.stringify(result.body)) > 16000); assert.match(String(result.bodyTruncated), /16384 bytes/u);
  }
  assert.equal((await read({ body: 'y'.repeat(16384) })).bodyTruncated, undefined);
  for (const bad of [{ number: 72 }, { state: 'merged' }, { title: 7 }, { body: 7 }, { labels: [{}] }, { html_url: 'https://evil.invalid/71' }]) {
    f.behavior((_req, res) => res.end(JSON.stringify(issue(bad)))); await assert.rejects(client.tool('github-read-issue', { ...repository, number: 71 }, 'ACCESS_PRIVATE', context()));
  }
  f.behavior((_req, res) => { res.statusCode = 404; res.end('{"message":"Not Found"}'); });
  await assert.rejects(client.tool('github-read-issue', { ...repository, number: 71 }, 'ACCESS_PRIVATE', context()), { code: 'unavailable' });
  for (const number of [0, -1, 1.5, '071', '7.1', ' 71', 2 ** 31, String(2 ** 31), undefined]) assert.throws(() => githubArguments('github-read-issue', { ...repository, number }));
  assert.deepEqual(githubArguments('github-read-issue', { ...repository, number: '71' }), githubArguments('github-read-issue', { ...repository, number: 71 }));
  assert.throws(() => githubArguments('github-read-issue', { ...repository, number: 71, state: 'open' }));
});
test('a repository is allowed only by its own entry or its owner wildcard, compared without ASCII case', () => {
  const list = ['example/project', 'acme/*'];
  for (const [owner, repo] of [['example', 'project'], ['Example', 'PROJECT'], ['EXAMPLE', 'Project'], ['acme', 'repo'], ['ACME', 'Any.Repo_1-x'], ['acme', 'project']])
    assert.equal(repositoryAllowed(list, owner!, repo!), true, `${owner}/${repo}`);
  for (const [owner, repo] of [['example', 'other'], ['example', 'project2'], ['example', 'projec'], ['example', '*'], ['other', 'project'], ['acme-corp', 'repo'],
    ['acm', 'repo'], ['*', 'project'], ['example/project', ''], ['', 'example/project'], ['acme/x', 'repo'], ['\u212Aacme', 'repo'], ['ac\u212Ae', 'repo'],
    ['example', 'pro\u212Aect'], ['exa\u0130ple', 'project']])
    assert.equal(repositoryAllowed(list, owner!, repo!), false, `${owner}/${repo}`);
  assert.equal(repositoryAllowed(['ake/*'], 'a\u212Ae', 'repo'), false, 'only ASCII is folded');
  assert.equal(repositoryAllowed(undefined, 'example', 'project'), false); assert.equal(repositoryAllowed([], 'example', 'project'), false);
  assert.doesNotMatch(REPOSITORY_NOT_ALLOWED, /example|acme|project/u);
});
test('a fork-qualified pull request head needs its owner wildcard unless it names the base owner', () => {
  const list = ['example/project', 'acme/*'];
  for (const head of ['feature', 'feature/one', 'example:feature', 'EXAMPLE:feature', 'acme:feature', 'Acme:a:b']) assert.equal(headAllowed(list, 'example', head), true, head);
  for (const head of ['other:feature', 'example-fork:feature', ':feature', 'acme-corp:feature', '\u212Aacme:feature', 'other/project:feature'])
    assert.equal(headAllowed(list, 'example', head), false, head);
  assert.equal(headAllowed(undefined, 'example', 'other:feature'), false); assert.equal(headAllowed(undefined, 'example', 'feature'), true);
});
