import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { createAccountStore } from '../src/accounts/store.js';
import { createGitHub } from '../src/accounts/github.js';
import { createTaskService } from '../src/accounts/task-service.js';
import { startTargetOutboundServer } from '../src/outbound/server.js';
import { binding, context, deferred } from './support/directory-table.js';
import { grantsFixture } from './support/task-grants.js';
import { toolsFixture } from './support/github-tools.js';
import { completed, workIQFixture } from './support/workiq.js';
const tools = ['workiq', 'github-read-file', 'github-list-issues', 'github-create-issue', 'github-create-pull-request'];
const args = { owner: 'acme', repo: 'repo', title: 'Reviewed issue' };
async function setup(t: test.TestContext, linked = true) {
  const f = await grantsFixture(t); const remote = await toolsFixture(t); const w = await workIQFixture(t);
  const openGithub = () => { const s = createAccountStore(binding, Buffer.alloc(32, 7), f.dependencies, f.authority, f.now, 'github'); t.after(() => s.close()); return s; };
  const githubAccounts = openGithub(); const tokens = (accessToken = 'GH_ACCESS_PRIVATE', refreshToken = 'GH_REFRESH_PRIVATE') => ({ accessToken, refreshToken, providerUserId: '12345', expiresAt: f.now() + 100000, refreshExpiresAt: f.now() + 1000000 });
  const linkGithub = async (id = 'github-link') => { const ch = await githubAccounts.challenge(f.subject, 'chat-private', id, context()); await githubAccounts.claim(ch, context()); assert.equal(await githubAccounts.complete(ch, tokens(), context()), true); };
  if (linked) await linkGithub();
  const grant = { ...f.input, tools, githubGeneration: linked ? 2 : 0 }; await f.store.reserveGrant(grant, context());
  const github = createGitHub({ clientId: 'Iv1.synthetic', clientSecret: 'CLIENT_PRIVATE', publicOrigin: 'https://signin.example.invalid' }, { request: remote.request, now: f.now }); t.after(() => github.close());
  let refresh = async (_token: string) => tokens('GH_ROTATED_PRIVATE', 'GH_ROTATED_REFRESH_PRIVATE');
  const open = (accounts = f.store, ghAccounts = githubAccounts) => createTaskService({ accounts, authority: f.authority, now: f.now,
    targets: [{ id: 'tools', gatewayUid: 'gateway', identityDigest: f.input.targetDigest, taskPassToken: 'CONTROLLER_PRIVATE' }],
    auth: { exchange: async () => { throw new Error('not SSO'); }, refresh: async () => ({ accessToken: 'ACCESS-PRIVATE', expiresAt: f.now() + 100000, refreshToken: 'REFRESH-PRIVATE' }) },
    github: { accounts: ghAccounts, auth: { ...github, refresh: token => refresh(token) } }, workiq: { request: w.request }, privateCredentials: ['DELIVERY_PRIVATE'] });
  const service = open(); t.after(() => service.close());
  const body = { protocolVersion: 'orka.gateway.v1', grantRef: grant.ref, namespaceUID: 'ns', gatewayUID: 'gateway', taskUID: 'task', tools, deadline: new Date(f.now() + 600000).toISOString() };
  const issue = async (s = service, input: unknown = body) => { const result = await s.handle('/v1/task-passes', 'CONTROLLER_PRIVATE', input, context()); assert.equal(result.status, 200); return (result.body as { pass: string }).pass; };
  const call = async (tool = 'github-create-issue', value: unknown = args, key: string | undefined = 'operation', s = service) => s.handle('/v1/task-tools/' + tool, await issue(s), value, context(), key);
  const server = await startTargetOutboundServer({ host: '127.0.0.1', port: 0 }, [{ prefix: '/targets/tools', bearerToken: 'DELIVERY_PRIVATE', scope: { appId: 'app', tenantId: 'tenant' },
    dispatcher: { healthy: true, deliver: async () => { throw new Error('not delivery'); }, stop: async () => {} } }], () => true, service); t.after(() => server.stop());
  return { ...f, ...remote, service, server, githubAccounts, openGithub, openService: open, linkGithub, tokens, body, issue, call, w, refresh: (fn: typeof refresh) => { refresh = fn; } };
}
test('one mixed-tool grant preserves Work IQ with unlinked GitHub, and cannot adopt a later link', async t => {
  const f = await setup(t, false); assert.deepEqual(await f.call('workiq', { question: 'Question' }), { status: 200, body: { text: 'Answer' } });
  assert.deepEqual((await f.call('github-list-issues', { owner: 'acme', repo: 'repo' })).body, { error: 'signin-required' }); assert.equal(f.requests.length, 0);
  await f.linkGithub(); assert.deepEqual((await f.call('github-list-issues', { owner: 'acme', repo: 'repo' })).body, { error: 'signin-required' });
  assert.equal((await f.call('workiq', { question: 'Question' })).status, 200);
});
test('positive frozen GitHub generation fences issuance and calls across disconnect/relink, without parallel grant rows', async t => {
  const f = await setup(t); const pass = await f.issue();
  await f.githubAccounts.disconnect(f.subject, context()); await f.linkGithub('relink');
  assert.notEqual((await f.service.handle('/v1/task-tools/github-list-issues', pass, { owner: 'acme', repo: 'repo' }, context())).status, 200);
  assert.notEqual((await f.service.handle('/v1/task-passes', 'CONTROLLER_PRIVATE', f.body, context())).status, 200); assert.equal(f.requests.length, 0);
  assert.equal([...f.rows.values()].filter(r => String(r.RowKey).startsWith('grant_')).length, 1);
});
test('write success is cached by grant/tool/raw operation identity; changed arguments cannot reuse it', async t => {
  const f = await setup(t); const first = await f.call(); assert.equal(first.status, 200);
  assert.deepEqual(await f.call(), first); assert.equal(f.requests.length, 1);
  assert.equal((await f.call('github-create-issue', { ...args, title: 'different' })).status, 403); assert.equal(f.requests.length, 1);
  await f.service.close(); const successor = f.openService(f.open(), f.openGithub()); t.after(() => successor.close());
  assert.deepEqual(await f.call('github-create-issue', args, 'operation', successor), first); assert.equal(f.requests.length, 1);
  assert.ok(!JSON.stringify([...f.rows.values()]).includes('Reviewed issue'));
});
test('concurrent same operation sends once; a reservation is uncertain rather than a second send right', async t => {
  const f = await setup(t); const entered = deferred(); const release = deferred();
  f.behavior((_req, res) => { entered.resolve(); void release.promise.then(() => { res.statusCode = 201; res.end('{"number":8,"html_url":"https://github.com/acme/repo/issues/8"}'); }); });
  const first = f.call(); await entered.promise; assert.equal((await f.call()).status, 503); assert.equal(f.requests.length, 1); release.resolve(); assert.equal((await first).status, 200);
});
for (const failure of ['lost', '500', 'bad-result', 'completion-write', 'completion-read', 'deadline'] as const) test(`write ${failure} remains503/408 and cannot POST again after restart`, async t => {
  const f = await setup(t);
  if (failure === 'lost') f.behavior((_req, res) => res.destroy());
  if (failure === '500') f.behavior((_req, res) => { res.statusCode = 500; res.end('{}'); });
  if (failure === 'bad-result') f.behavior((_req, res) => { res.statusCode = 201; res.end('{}'); });
  if (failure === 'deadline') f.behavior((_req, res) => { f.advance(600001); res.statusCode = 201; res.end('{"number":8,"html_url":"https://github.com/acme/repo/issues/8"}'); });
  if (failure.startsWith('completion')) f.controls.hook = r => {
    if (r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('write_')) { if (failure === 'completion-read') r.reply(); else r.res.destroy(); }
    else if (failure === 'completion-read' && f.requests.length && r.req.method === 'GET' && r.url.pathname.includes("RowKey='write_")) r.res.destroy(); else r.reply();
  };
  const result = await f.call(); assert.ok([503, 408].includes(result.status)); assert.equal(f.requests.length, 1);
  delete f.controls.hook; await f.service.close(); const successor = f.openService(f.open(), f.openGithub()); t.after(() => successor.close());
  // Deadline fixture's grant expired; rewind is not needed to prove zero further effects.
  if (failure === 'deadline') { assert.notEqual((await successor.handle('/v1/task-passes', 'CONTROLLER_PRIVATE', f.body, context())).status, 200); }
  else assert.ok([503, 408].includes((await f.call('github-create-issue', args, 'operation', successor)).status));
  assert.equal(f.requests.length, 1);
});
test('a held native write deadline returns503/408 and never replays the operation', async t => {
  const f = await setup(t); const pass = await f.issue(); const entered = deferred(); f.behavior(() => entered.resolve());
  const pending = f.service.handle('/v1/task-tools/github-create-issue', pass, args, { ...context(), deadline: performance.now() + 1000 }, 'native-deadline');
  await entered.promise; assert.ok([503, 408].includes((await pending).status));
  assert.equal((await f.call('github-create-issue', args, 'native-deadline')).status, 503); assert.equal(f.requests.length, 1);
});
test('failed reservation read cannot misreport an earlier possible effect as403', async t => {
  const f = await setup(t); f.behavior((_req, res) => res.destroy()); assert.equal((await f.call()).status, 503);
  f.controls.hook = r => { if (r.req.method === 'GET' && r.url.pathname.includes("RowKey='write_")) r.res.destroy(); else r.reply(); };
  assert.equal((await f.call()).status, 503); assert.equal(f.requests.length, 1);
});
for (const race of ['owner', 'github', 'workiq', 'expiry'] as const) test(`${race} changing after write reservation sends zeroPOST`, async t => {
  const f = await setup(t); const reserve = f.store.reserveWrite;
  f.store.reserveWrite = async (...input) => { const value = await reserve(...input);
    if (race === 'owner') f.revoke(); if (race === 'github') await f.githubAccounts.disconnect(f.subject, context());
    if (race === 'workiq') await f.store.disconnect(f.subject, context()); if (race === 'expiry') f.advance(300001); return value; };
  assert.equal((await f.call()).status, 503); assert.equal(f.requests.length, 0);
});
test('GitHub disconnect inside the final awaited Work IQ grant read fences native POST', async t => {
  const f = await setup(t); const pass = await f.issue(); const entered = deferred(); const release = deferred(); t.after(() => release.resolve());
  const get = f.store.getGrant; let reads = 0;
  f.store.getGrant = async (...input) => { const result = await get(...input); if (++reads === 4) { entered.resolve(); await release.promise; } return result; };
  const pending = f.service.handle('/v1/task-tools/github-create-issue', pass, args, context(), 'final-gap');
  await entered.promise; await f.githubAccounts.disconnect(f.subject, context()); release.resolve();
  assert.equal((await pending).status, 503); assert.equal(f.requests.length, 0);
});
test('an uncertain operation replay after revocation cannot become a no-effect403', async t => {
  const f = await setup(t); f.behavior((_req, res) => res.destroy()); assert.equal((await f.call()).status, 503);
  const pass = await f.issue(); await f.githubAccounts.disconnect(f.subject, context());
  assert.equal((await f.service.handle('/v1/task-tools/github-create-issue', pass, args, context(), 'operation')).status, 503);
  assert.equal(f.requests.length, 1);
});
test('cancellation before queued write handling cannot turn a prior uncertain operation into403', async t => {
  const f = await setup(t); f.behavior((_req, res) => res.destroy()); assert.equal((await f.call()).status, 503);
  const pass = await f.issue(); const controller = new AbortController();
  const pending = f.service.handle('/v1/task-tools/github-create-issue', pass, args, { ...context(), signal: controller.signal }, 'operation');
  controller.abort(); assert.equal((await pending).status, 503); assert.equal(f.requests.length, 1);
});
test('API401 invalidates only the rejected token revision, never a same-generation refreshed pair', async t => {
  for (const rotate of [false, true]) {
    const f = await setup(t); const entered = deferred(); const release = deferred();
    f.behavior((_req, res) => { entered.resolve(); void release.promise.then(() => { res.statusCode = 401; res.end('{}'); }); });
    const pending = f.call('github-list-issues', { owner: 'acme', repo: 'repo' }); await entered.promise;
    if (rotate) { f.advance(100001); await f.githubAccounts.acquire(f.subject, 2, async () => { throw new Error(); }, context(), async () => f.tokens('GH_NEW_ACCESS', 'GH_NEW_REFRESH')); }
    release.resolve(); assert.notEqual((await pending).status, 200);
    assert.deepEqual(await f.githubAccounts.inspect(f.subject, context()), { generation: rotate ? 2 : 3, linked: rotate });
  }
});
test('HTTP write operation keys preserve UTF8 bytes, reject duplicates/control/oversize and never enter tool arguments', async t => {
  const f = await setup(t);
  const observed: (string | undefined)[] = []; const handle = f.service.handle;
  f.service.handle = (...values) => { if (values[0].includes('task-tools')) observed.push(values[4]); return handle(...values); };
  const httpCall = async (key: string | string[] | undefined) => {
    const pass = await f.issue();
    return new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: f.server.port, path: '/v1/task-tools/github-create-issue', method: 'POST', headers: {
        authorization: 'Bearer ' + pass, 'content-type': 'application/json', ...(key === undefined ? {} : { 'Idempotency-Key': key }) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      // Buffer body preserves raw Latin1 header bytes; string bodies make Node re-encode headers as UTF8.
      req.on('error', reject); req.end(Buffer.from(JSON.stringify(args)));
    });
  };
  const unicode = Buffer.from('op-é-東京', 'utf8').toString('latin1');
  const firstStatus = await httpCall(unicode); assert.deepEqual(observed, ['op-é-東京'], String(firstStatus));
  assert.equal(firstStatus, 200); assert.equal(await httpCall(unicode), 200); assert.equal(f.requests.length, 1);
  assert.equal(await httpCall('x'.repeat(256)), 200);
  assert.equal(await httpCall(Buffer.from('é'.repeat(128)).toString('latin1')), 200);
  assert.equal(await httpCall(Buffer.from('\uFEFFop').toString('latin1')), 200); assert.equal(observed.at(-1), '\uFEFFop');
  for (const key of [undefined, ['one', 'two'], 'x'.repeat(257), 'invalid\tkey', '\xff']) assert.equal(await httpCall(key), 400);
  assert.equal(f.requests.length, 4); assert.deepEqual(f.requests[0]!.body, { title: 'Reviewed issue' });
});
test('unknown paths, cross Task/target, unfrozen tools and arguments have no GitHub effect', async t => {
  const f = await setup(t); const pass = await f.issue();
  assert.equal(f.service.authenticate('/v1/task-tools/unknown', pass), false);
  assert.notEqual((await f.service.handle('/v1/task-passes', 'WRONG', f.body, context())).status, 200);
  for (const change of [{ taskUID: 'other' }, { namespaceUID: 'other' }, { gatewayUID: 'other' }, { tools: ['unknown'] }]) assert.notEqual((await f.service.handle('/v1/task-passes', 'CONTROLLER_PRIVATE', { ...f.body, ...change }, context())).status, 200);
  assert.equal((await f.call('github-create-issue', { ...args, url: 'https://evil' })).status, 400); assert.equal(f.requests.length, 0);
});
test('the first binding tool subset cannot authorize another named endpoint', async t => {
  const f = await setup(t); const pass = await f.issue(f.service, { ...f.body, tools: ['workiq'] });
  assert.notEqual((await f.service.handle('/v1/task-tools/github-create-issue', pass, args, context(), 'not-frozen')).status, 200);
  assert.equal(f.requests.length, 0);
});
test('two simultaneous absent reservation reads still give only the exact CREATE winner send permission', async t => {
  const f = await setup(t); const passes = [await f.issue(), await f.issue()]; const both = deferred(); let reads = 0;
  f.controls.hook = async r => { if (r.req.method === 'GET' && r.url.pathname.includes("RowKey='write_")) {
    if (++reads === 2) both.resolve(); if (reads <= 2) await both.promise; } r.reply(); };
  const results = await Promise.all(passes.map(pass => f.service.handle('/v1/task-tools/github-create-issue', pass, args, context(), 'create-race')));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 503]); assert.equal(f.requests.length, 1);
});
test('held failed reservation lookup after an earlier possible effect remains uncertain on caller cancellation', async t => {
  const f = await setup(t); f.behavior((_req, res) => res.destroy()); assert.equal((await f.call()).status, 503);
  const pass = await f.issue(); const entered = deferred(); const release = deferred(); t.after(() => release.resolve());
  f.controls.hook = async r => { if (r.req.method === 'GET' && r.url.pathname.includes("RowKey='write_")) { entered.resolve(); await release.promise; r.res.destroy(); } else r.reply(); };
  const controller = new AbortController(); const pending = f.service.handle('/v1/task-tools/github-create-issue', pass, args, { ...context(), signal: controller.signal }, 'operation');
  await entered.promise; controller.abort(); release.resolve(); assert.equal((await pending).status, 503); assert.equal(f.requests.length, 1);
});
test('each grant selects its original user credentials; operation identity is scoped by grant and tool', async t => {
  const f = await setup(t); const other = { objectId: 'other-sender' };
  const w = await f.store.challenge(other, 'chat-private', 'other-workiq', context()); await f.store.claim(w, context());
  await f.store.complete(w, { accessToken: 'OTHER_MS_PRIVATE', refreshToken: 'OTHER_MS_REFRESH', expiresAt: f.now() + 100000 }, context());
  const g = await f.githubAccounts.challenge(other, 'chat-private', 'other-github', context()); await f.githubAccounts.claim(g, context());
  await f.githubAccounts.complete(g, { ...f.tokens('OTHER_GH_PRIVATE', 'OTHER_GH_REFRESH'), providerUserId: '67890' }, context());
  const otherGrant = { ...f.input, ...other, ref: 'b'.repeat(64), eventId: 'other-event', githubGeneration: 2, tools };
  await f.store.reserveGrant(otherGrant, context());
  const otherPass = await f.issue(f.service, { ...f.body, grantRef: otherGrant.ref, taskUID: 'other-task' });
  const result = await f.service.handle('/v1/task-tools/github-create-issue', otherPass, args, context(), 'operation'); assert.equal(result.status, 200);
  assert.equal((await f.call()).status, 200);
  assert.equal((await f.call('github-create-pull-request', { ...args, head: 'existing', base: 'main' })).status, 200);
  assert.deepEqual(f.requests.map(r => [r.authorization, r.path]), [['Bearer OTHER_GH_PRIVATE', '/repos/acme/repo/issues'], ['Bearer GH_ACCESS_PRIVATE', '/repos/acme/repo/issues'], ['Bearer GH_ACCESS_PRIVATE', '/repos/acme/repo/pulls']]);
});
test('both providers and operator/controller secrets are excluded from read and write output', async t => {
  const f = await setup(t);
  for (const secret of ['GH_ACCESS_PRIVATE', 'GH_REFRESH_PRIVATE', 'ACCESS-PRIVATE', 'REFRESH-PRIVATE', 'CLIENT_PRIVATE', 'CONTROLLER_PRIVATE', 'DELIVERY_PRIVATE']) {
    f.behavior((_req, res) => res.end(JSON.stringify([{ number: 7, title: secret, state: 'open', html_url: 'https://github.com/acme/repo/issues/7' }])));
    const result = await f.call('github-list-issues', { owner: 'acme', repo: 'repo' }); assert.notEqual(result.status, 200); assert.ok(!JSON.stringify(result).includes(secret));
    f.w.behavior((_req, res, body) => res.end(JSON.stringify(completed(body.id, secret))));
    const workiq = await f.call('workiq', { question: 'Question' }); assert.notEqual(workiq.status, 200); assert.ok(!JSON.stringify(workiq).includes(secret));
  }
});
