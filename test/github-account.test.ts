import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountStore, type AccountTokens } from '../src/accounts/store.js';
import { binding, context, deferred, directoryFixture } from './support/directory-table.js';

const epoch = 1_800_000_000_000; const subject = { objectId: 'sender-oid' };
const pair = (accessToken = 'GITHUB-ACCESS', refreshToken = 'GITHUB-REFRESH'): AccountTokens => ({ accessToken, refreshToken,
  expiresAt: epoch + 1000, refreshExpiresAt: epoch + 100_000, providerUserId: '12345' });
async function setup(t: Parameters<typeof directoryFixture>[0]) {
  const f = await directoryFixture(t); let clock = epoch;
  const open = (provider: 'github' | 'workiq' = 'github') => {
    const store = createAccountStore(binding, Buffer.alloc(32, 7), f.dependencies, { allowed: () => true }, () => clock, provider);
    t.after(() => store.close()); return store;
  };
  const store = open();
  const claimed = async (activity = 'link', s = store) => {
    const ch = await s.challenge(subject, 'chat', activity, context()); assert.equal(await s.claim(ch, context()), 'claimed'); return ch;
  };
  const link = async (activity = 'link', tokens = pair()) => { const ch = await claimed(activity);
    assert.equal(await store.complete(ch, tokens, context()), true); return ch; };
  return { ...f, store, open, claimed, link, advance: (ms: number) => { clock += ms; } };
}
const unused = async (): Promise<AccountTokens> => { assert.fail('must not use Microsoft assertion'); };

test('GitHub rows and challenges are isolated; publication and relink advance only GitHub generation', async t => {
  const f = await setup(t); const workiq = f.open('workiq');
  const w = await f.claimed('same', workiq);
  assert.equal(await workiq.complete(w, { accessToken: 'WORKIQ-ACCESS', expiresAt: epoch + 90_000 }, context()), true);
  const g = await f.link('same'); assert.notEqual(w.id.slice(0, 64), g.id.slice(0, 64));
  assert.equal(await f.store.getChallenge(w.id, context()), undefined);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 2, linked: true });
  assert.equal(await f.store.published(g, context()), true);
  assert.deepEqual(await f.store.acquire(subject, 1, unused, context()), { kind: 'signin-required' });
  await f.link('relink'); assert.deepEqual(await f.store.inspect(subject, context()), { generation: 3, linked: true });
  assert.equal(await f.store.published(g, context()), false);
  await f.store.disconnect(subject, context());
  assert.deepEqual(await workiq.acquire(subject, 1, unused, context()), { kind: 'token', accessToken: 'WORKIQ-ACCESS' });
  const wire = JSON.stringify([...f.rows.values()]);
  for (const secret of ['GITHUB-ACCESS', 'GITHUB-REFRESH', 'WORKIQ-ACCESS', 'sender-oid']) assert.ok(!wire.includes(secret));
});

for (const missing of ['providerUserId', 'refreshToken', 'refreshExpiresAt'] as const) test(`GitHub completion rejects missing ${missing}`, async t => {
  const f = await setup(t); const ch = await f.claimed(); const tokens = pair(); delete tokens[missing];
  await assert.rejects(f.store.complete(ch, tokens, context()), /Account storage: (corrupt|unavailable)/u);
  assert.equal((await f.store.inspect(subject, context())).linked, false);
});
for (const id of ['0', '01', '-1', 'user@example.invalid']) test(`GitHub completion rejects noncanonical user ID ${id}`, async t => {
  const f = await setup(t); const ch = await f.claimed();
  await assert.rejects(f.store.complete(ch, { ...pair(), providerUserId: id }, context()), /Account storage: corrupt/u);
});

test('simultaneous GitHub completions publish one new generation only', async t => {
  const f = await setup(t); const a = await f.claimed('a'); const b = await f.claimed('b');
  const results = await Promise.all([f.store.complete(a, pair('A'), context()), f.store.complete(b, pair('B'), context())]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 2, linked: true });
});

test('GitHub continuation requires local Microsoft browser claim and consumes only the matching cookie once', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'browser', context());
  assert.equal(await f.store.prepareGitHub({ challenge: ch, state: '', nonce: '', verifier: '' }, context()), undefined);
  assert.equal(await f.store.prepareBrowser(ch, context()), undefined);
  const ms = await f.store.prepareBrowser(ch, context(), 'a'.repeat(43)); assert.ok(ms);
  assert.deepEqual(await f.store.prepareBrowser(ch, context(), 'a'.repeat(43)), ms);
  assert.equal(await f.store.prepareBrowser(ch, context(), 'b'.repeat(43)), undefined);
  assert.equal(await f.store.claimBrowser(ms.state, context()), undefined);
  assert.equal(await f.store.claimBrowser(ms.state, context(), 'b'.repeat(43)), undefined);
  const verified = await f.store.claimBrowser(ms.state, context(), 'a'.repeat(43)); assert.ok(verified);
  assert.equal(await f.open().prepareGitHub(verified, context()), undefined);
  const github = await f.store.prepareGitHub(verified, context()); assert.ok(github);
  assert.notEqual(github.state, ms.state); assert.notEqual(github.verifier, ms.verifier);
  assert.ok(!JSON.stringify([...f.rows.values()]).includes(github.cookie));
  assert.equal(await f.store.claimGitHub(github.state, '', context()), undefined);
  assert.equal(await f.store.claimGitHub(github.state, 'x'.repeat(43), context()), undefined);
  const winner = await f.store.claimGitHub(github.state, github.cookie, context()); assert.ok(winner);
  assert.equal(await f.store.claimGitHub(github.state, github.cookie, context()), undefined);
  assert.equal(await f.store.complete(winner.challenge, pair(), context()), true);
});

test('disconnect and expiry fence GitHub browser continuations', async t => {
  for (const invalidate of ['disconnect', 'expire']) {
    const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', invalidate, context());
    const ms = await f.store.prepareBrowser(ch, context(), 'a'.repeat(43)); const verified = await f.store.claimBrowser(ms!.state, context(), 'a'.repeat(43));
    const github = await f.store.prepareGitHub(verified!, context()); assert.ok(github);
    if (invalidate === 'disconnect') await f.store.disconnect(subject, context()); else f.advance(600_000);
    assert.equal(await f.store.claimGitHub(github.state, github.cookie, context()), undefined);
  }
});

test('refresh rotates the complete pair once, retaining generation and immutable ID', async t => {
  const f = await setup(t); await f.link(); f.advance(1001); const entered = deferred(); const release = deferred(); let calls = 0;
  const refresh = async (token: string) => { assert.equal(token, 'GITHUB-REFRESH'); calls++; entered.resolve(); await release.promise;
    return { ...pair('NEW-ACCESS', 'NEW-REFRESH'), expiresAt: epoch + 5000 }; };
  const first = f.store.acquire(subject, 2, unused, context(), refresh); await entered.promise;
  const second = f.store.acquire(subject, 2, unused, context(), refresh); release.resolve();
  for (const result of await Promise.all([first, second])) assert.deepEqual(result, { kind: 'token', accessToken: 'NEW-ACCESS' });
  assert.equal(calls, 1); assert.deepEqual(await f.store.inspect(subject, context()), { generation: 2, linked: true });
  f.advance(4000);
  await f.store.acquire(subject, 2, unused, context(), async token => { assert.equal(token, 'NEW-REFRESH'); return { ...pair('THIRD'), expiresAt: epoch + 9000 }; });
});

for (const failure of ['uncertain', 'invalid', 'identity', 'missing-pair']) test(`refresh ${failure} invalidates durably without retrying the token`, async t => {
  const f = await setup(t); await f.link(); f.advance(1001); let calls = 0;
  const refresh = async () => { calls++;
    if (failure === 'identity') return { ...pair(), providerUserId: '999', expiresAt: epoch + 5000 };
    if (failure === 'missing-pair') return { accessToken: 'NEW', expiresAt: epoch + 5000 };
    throw Object.assign(new Error('PRIVATE'), { code: failure === 'invalid' ? 'invalid-grant' : 'unavailable' }); };
  assert.deepEqual(await f.store.acquire(subject, 2, unused, context(), refresh), { kind: 'signin-required' });
  assert.deepEqual(await f.open().inspect(subject, context()), { generation: 3, linked: false });
  assert.deepEqual(await f.store.acquire(subject, 2, unused, context(), refresh), { kind: 'signin-required' }); assert.equal(calls, 1);
});

test('expired refresh invalidates without an external call even while access is nominally valid', async t => {
  const f = await setup(t); const ch = await f.link('long-access', { ...pair(), expiresAt: epoch + 200_000 }); f.advance(100_000);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 2, linked: false });
  assert.equal(await f.store.published(ch, context()), false);
  assert.deepEqual(await f.store.acquire(subject, 2, unused, context(), unused), { kind: 'signin-required' });
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 3, linked: false });
});

test('durable renewal marker prevents a successor retry even while original remote work is held', async t => {
  const f = await setup(t); await f.link(); f.advance(1001); const entered = deferred(); const release = deferred();
  const pending = f.store.acquire(subject, 2, unused, context(), async () => { entered.resolve(); await release.promise;
    return { ...pair('LATE'), expiresAt: epoch + 5000 }; });
  await entered.promise; const successor = f.open();
  assert.deepEqual(await successor.acquire(subject, 2, unused, context(), unused), { kind: 'signin-required' });
  assert.deepEqual(await successor.inspect(subject, context()), { generation: 3, linked: false }); release.resolve();
  assert.deepEqual(await pending, { kind: 'signin-required' });
});

test('a verified continuation can resume after reopen, but its consumed state never can', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'restart', context());
  const ms = await f.store.prepareBrowser(ch, context(), 'a'.repeat(43)); const verified = await f.store.claimBrowser(ms!.state, context(), 'a'.repeat(43));
  assert.equal(await f.store.complete(verified!.challenge, pair(), context()), false);
  const github = await f.store.prepareGitHub(verified!, context()); assert.ok(github);
  await f.store.close(); const successor = f.open();
  const attempt = await successor.claimGitHub(github.state, github.cookie, context()); assert.ok(attempt);
  await successor.close(); assert.equal(await f.open().claimGitHub(github.state, github.cookie, context()), undefined);
});

test('lost pair publication leaves a renewal marker, never permission to retry the spent token', async t => {
  const f = await setup(t); await f.link(); f.advance(1001); let calls = 0;
  f.controls.hook = r => {
    if (r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('account_') && ++calls === 2) r.res.destroy(); else r.reply();
  };
  let refreshes = 0;
  const refresh = async () => { refreshes++; return { ...pair('ROTATED'), expiresAt: epoch + 5000 }; };
  assert.deepEqual(await f.store.acquire(subject, 2, unused, context(), refresh), { kind: 'signin-required' });
  delete f.controls.hook;
  assert.deepEqual(await f.open().acquire(subject, 2, unused, context(), refresh), { kind: 'signin-required' });
  assert.equal(refreshes, 1); assert.deepEqual(await f.store.inspect(subject, context()), { generation: 3, linked: false });
});

test('GitHub generation+1 publication is reconciled only for its own challenge after failed finalization', async t => {
  const f = await setup(t); const ch = await f.claimed(); let changes = 0;
  f.controls.hook = r => {
    if (r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('challenge_') && ++changes === 2) r.res.destroy(); else r.reply();
  };
  assert.equal(await f.store.complete(ch, pair(), context()), false); assert.equal(await f.store.published(ch, context()), true);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 2, linked: true });
  delete f.controls.hook; await f.store.disconnect(subject, context()); assert.equal(await f.store.published(ch, context()), false);
});

test('disconnect/relink during refresh cannot be overwritten by the old whole pair', async t => {
  const f = await setup(t); await f.link(); f.advance(1001); const entered = deferred(); const release = deferred();
  const pending = f.store.acquire(subject, 2, unused, context(), async () => { entered.resolve(); await release.promise;
    return { ...pair('LATE'), expiresAt: epoch + 9000 }; });
  await entered.promise; await f.store.disconnect(subject, context());
  await f.link('new-link', { ...pair('WINNER'), expiresAt: epoch + 9000 }); release.resolve();
  assert.deepEqual(await pending, { kind: 'signin-required' });
  assert.deepEqual(await f.store.acquire(subject, 4, unused, context()), { kind: 'token', accessToken: 'WINNER' });
});

test('nonselected pin preserves GitHub pair and generation without refreshing or invalidating watches', async t => {
  const f = await setup(t); await f.link(); const guard = f.store.watch(subject);
  assert.equal(await f.store.pin(subject, 2, context()), true); assert.equal(guard.active(), true);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 2, linked: true });
  assert.deepEqual(await f.store.acquire(subject, 2, unused, context()), { kind: 'token', accessToken: 'GITHUB-ACCESS' });
  assert.equal(await f.store.pin(subject, 1, context()), false);
  f.advance(1001); let refreshed = 0;
  assert.deepEqual(await f.store.acquire(subject, 2, unused, context(), async token => {
    refreshed++; assert.equal(token, 'GITHUB-REFRESH'); return { ...pair('NEW-ACCESS', 'NEW-REFRESH'), expiresAt: epoch + 5000 };
  }), { kind: 'token', accessToken: 'NEW-ACCESS' });
  assert.equal(refreshed, 1); guard.release();
});
