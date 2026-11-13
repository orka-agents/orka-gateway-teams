import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAccountStore, type AccountTokens } from '../src/accounts/store.js';
import { binding, context, deferred, directoryFixture, eventually } from './support/directory-table.js';

const secret = Buffer.alloc(32, 7);
const subject = { objectId: 'sender-oid' };
const epoch = 1_800_000_000_000;
const tokens = (at = epoch): AccountTokens => ({ accessToken: 'ACCESS-SENTINEL', expiresAt: at + 1000,
  assertion: 'ASSERTION-SENTINEL', assertionExpiresAt: at + 600_000 });
async function setup(t: Parameters<typeof directoryFixture>[0]) {
  const f = await directoryFixture(t); let clock = epoch; let allowed = true;
  const open = (key = secret) => {
    const s = createAccountStore(binding, key, f.dependencies, { allowed: () => allowed }, () => clock);
    t.after(() => s.close()); return s;
  };
  const store = open();
  const link = async (activity = 'message', value = tokens()) => {
    const ch = await store.challenge(subject, 'chat', activity, context());
    assert.equal(await store.claim(ch, context()), 'claimed');
    assert.equal(await store.complete(ch, value, context()), true); return ch;
  };
  return { ...f, store, open, link, advance: (ms: number) => { clock += ms; }, revoke: () => { allowed = false; } };
}

test('native ciphertext survives reopen, never exposes credentials, and disconnect retains its generation', async t => {
  const f = await setup(t);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 0, linked: false });
  const ch = await f.link();
  assert.match(ch.id, /^[a-f0-9]{64}\.[a-f0-9-]{36}$/u);
  assert.deepEqual(await f.store.getChallenge(ch.id, context()), { ...ch, state: 'done' });
  const wire = JSON.stringify([...f.rows.values()]);
  for (const text of ['ACCESS-SENTINEL', 'ASSERTION-SENTINEL', 'sender-oid', 'chat', 'message']) assert.ok(!wire.includes(text));
  for (const row of f.rows.values()) {
    const payload = Buffer.from(String(row.Payload), 'base64').toString();
    assert.ok(!payload.includes('ACCESS-SENTINEL')); assert.ok(!payload.includes('ASSERTION-SENTINEL'));
  }
  await f.store.close(); const reopened = f.open();
  assert.deepEqual(await reopened.acquire(subject, 1, async () => { throw new Error('must not refresh'); }, context()),
    { kind: 'token', accessToken: 'ACCESS-SENTINEL' });
  assert.equal(await reopened.disconnect(subject, context()), 2);
  assert.deepEqual(await reopened.inspect(subject, context()), { generation: 2, linked: false });
  assert.equal(await reopened.claim(ch, context()), 'unavailable');
  assert.deepEqual(await reopened.acquire(subject, 1, async () => tokens(), context()), { kind: 'signin-required' });
  assert.equal(f.rows.size, 2);
});

test('wrong key, transplanted row and transplanted generation fail closed with fixed errors', async t => {
  const f = await setup(t); await f.link();
  await assert.rejects(f.open(Buffer.alloc(32, 8)).inspect(subject, context()), /Account storage: corrupt/u);
  const account = [...f.rows.values()].find(r => String(r.RowKey).startsWith('account_'))!;
  const original = { ...account };
  // Recompute the public digest: only the authentication tag can protect generation.
  const payload = Buffer.from(String(account.Payload), 'base64'); payload.writeBigUInt64BE(2n);
  account.Payload = payload.toString('base64');
  account.Digest = createHash('sha256').update(JSON.stringify(['teams-accounts-row-v1', account.PartitionKey, account.RowKey, account.Payload])).digest('hex');
  await assert.rejects(f.store.inspect(subject, context()), /Account storage: corrupt/u);
  Object.assign(account, original);
  const other = { objectId: 'another-sender' }; await f.store.disconnect(other, context());
  const target = [...f.rows.values()].find(r => String(r.RowKey).startsWith('account_') && r.RowKey !== account.RowKey)!;
  target.Payload = original.Payload;
  target.Digest = createHash('sha256').update(JSON.stringify(['teams-accounts-row-v1', target.PartitionKey, target.RowKey, target.Payload])).digest('hex');
  await assert.rejects(f.store.inspect(other, context()), /Account storage: corrupt/u);
});

test('duplicate and simultaneous challenge creation converge on the durable winning nonce', async t => {
  const f = await setup(t);
  await f.store.disconnect(subject, context());
  const [a, b] = await Promise.all([f.store.challenge(subject, 'chat', 'same', context()), f.store.challenge(subject, 'chat', 'same', context())]);
  assert.deepEqual(a, b); assert.equal(f.rows.size, 2);
  assert.deepEqual(await f.store.challenge(subject, 'chat', 'same', context()), a);
  assert.equal(await f.store.getChallenge(a.id.replace(/.$/u, a.id.endsWith('0') ? '1' : '0'), context()), undefined);
  const [left, right] = await Promise.all([f.store.claim(a, context()), f.store.claim(b, context())]);
  assert.deepEqual([left, right].sort(), ['claimed', 'unavailable']);
  const next = f.open();
  assert.equal(await next.claim(a, context()), 'unavailable');
  assert.equal(await next.complete(a, tokens(), context()), false);
  assert.equal(await f.store.complete({ ...a, conversationId: 'wrong' }, tokens(), context()), false);
  assert.equal(await f.store.complete(a, tokens(), context()), true);
  assert.equal(await next.claim(a, context()), 'done');
});

test('lost insert responses reconcile exactly without retrying mutations', async t => {
  const f = await setup(t); let lost = false;
  f.controls.hook = r => {
    if (!lost && r.req.method === 'POST') { lost = true; r.reply(); r.res.destroy(); } else r.reply();
  };
  const ch = await f.store.challenge(subject, 'chat', 'lost-response', context());
  assert.ok(ch.id); assert.equal(f.requests.filter(r => r.method === 'POST').length, 2);
  f.controls.hook = r => { if (r.req.method === 'PUT') r.res.destroy(); else r.reply(); };
  assert.equal(await f.store.claim(ch, context()), 'unavailable');
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 1);
  assert.equal((await f.store.getChallenge(ch.id, context()))?.state, 'open');
});

for (const failure of [false, true]) for (const competitor of ['disconnect', 'complete'] as const) {
  test(`held renewal ${failure ? 'failure' : 'success'} cannot overwrite concurrent ${competitor}`, async t => {
    const f = await setup(t); await f.link(); f.advance(1001);
    const entered = deferred(); const release = deferred(); let refreshes = 0;
    const refresh = async (assertion: string) => {
      assert.equal(assertion, 'ASSERTION-SENTINEL'); refreshes++; entered.resolve(); await release.promise;
      if (failure) throw Object.assign(new Error('invalid_grant RAW-SECRET'), { code: 'invalid-grant' });
      return { accessToken: 'STALE-REFRESH', expiresAt: epoch + 60_000 };
    };
    const pending = f.store.acquire(subject, 1, refresh, context()); await entered.promise;
    const joined = f.store.acquire(subject, 1, refresh, context());
    if (competitor === 'disconnect') assert.equal(await f.store.disconnect(subject, context()), 2);
    else await f.link('fresh', { accessToken: 'FRESH-COMPLETE', expiresAt: epoch + 60_000 });
    release.resolve();
    assert.deepEqual(await pending, { kind: 'signin-required' }); assert.deepEqual(await joined, { kind: 'signin-required' });
    assert.equal(refreshes, 1);
    const got = await f.store.acquire(subject, competitor === 'disconnect' ? 2 : 1, async () => tokens(), context());
    assert.deepEqual(got, competitor === 'disconnect' ? { kind: 'signin-required' } : { kind: 'token', accessToken: 'FRESH-COMPLETE' });
  });
}

test('renewal is singleflight, preserves assertion expiry, and invalidation is durable', async t => {
  const f = await setup(t); await f.link(); f.advance(1001); let calls = 0;
  const refresh = async (assertion: string) => { calls++; assert.equal(assertion, 'ASSERTION-SENTINEL');
    return { accessToken: 'RENEWED', expiresAt: epoch + 2000 }; };
  const results = await Promise.all([f.store.acquire(subject, 1, refresh, context()), f.store.acquire(subject, 1, refresh, context())]);
  assert.deepEqual(results, [{ kind: 'token', accessToken: 'RENEWED' }, { kind: 'token', accessToken: 'RENEWED' }]); assert.equal(calls, 1);
  f.advance(1000);
  assert.deepEqual(await f.store.acquire(subject, 1, async () => { throw Object.assign(new Error('invalid_grant PRIVATE'), { code: 'invalid-grant' }); }, context()), { kind: 'signin-required' });
  assert.deepEqual(await f.open().inspect(subject, context()), { generation: 2, linked: false });
});

test('transient renewal failure preserves ciphertext and a fresh completion wins', async t => {
  const f = await setup(t); await f.link(); f.advance(1001);
  const before = JSON.stringify([...f.rows.values()]);
  assert.deepEqual(await f.store.acquire(subject, 1, async () => { throw Object.assign(new Error('RAW-TOKEN-PRIVATE'), { code: 'unavailable' }); }, context()),
    { kind: 'signin-required' });
  assert.equal(JSON.stringify([...f.rows.values()]), before);
  await f.link('fresh-after-transient', { accessToken: 'FRESH', expiresAt: epoch + 60_000 });
  assert.deepEqual(await f.store.acquire(subject, 1, async () => { assert.fail('new completion is valid'); }, context()),
    { kind: 'token', accessToken: 'FRESH' });
});

test('challenge, assertion and idle expiry never trigger unattended renewal', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'expires', context());
  f.advance(600_000); assert.equal(await f.store.claim(ch, context()), 'unavailable');
  await f.link('new', { ...tokens(epoch + 600_000), assertionExpiresAt: epoch + 9_000_000 });
  f.advance(600_001);
  const noRefresh = async (): Promise<AccountTokens> => { assert.fail('expired assertion must not be used'); };
  assert.deepEqual(await f.store.acquire(subject, 1, noRefresh, context()), { kind: 'signin-required' });
  await f.link('long-access', { accessToken: 'LONG', expiresAt: epoch + 90 * 86_400_000 });
  f.advance(30 * 86_400_000);
  assert.deepEqual(await f.store.acquire(subject, 1, noRefresh, context()), { kind: 'signin-required' });
});

test('completion rechecks generation and challenge ownership after token publication', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'race', context());
  assert.equal(await f.store.claim(ch, context()), 'claimed');
  const entered = deferred(); const release = deferred(); let published = false; let held = false;
  f.controls.hook = async r => {
    if (r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('account_')) published = true;
    if (published && !held && r.req.method === 'GET' && r.url.pathname.includes("RowKey='account_")) {
      held = true; entered.resolve(); await release.promise;
    }
    r.reply();
  };
  const pending = f.store.complete(ch, tokens(), context()); await entered.promise;
  await f.store.disconnect(subject, context()); release.resolve();
  assert.equal(await pending, false);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 2, linked: false });
});

test('completion CAS cannot overwrite a newer same-generation completion', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'old', context());
  assert.equal(await f.store.claim(ch, context()), 'claimed');
  const entered = deferred(); const release = deferred(); let held = false;
  f.controls.hook = async r => {
    if (!held && r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('account_')) {
      held = true; entered.resolve(); await release.promise;
    }
    r.reply();
  };
  const pending = f.store.complete(ch, tokens(), context()); await entered.promise;
  await f.link('new', { accessToken: 'WINNER', expiresAt: epoch + 60_000 });
  release.resolve(); assert.equal(await pending, false);
  assert.deepEqual(await f.store.acquire(subject, 1, async () => { assert.fail('winner remains valid'); }, context()),
    { kind: 'token', accessToken: 'WINNER' });
});

test('cancellation and authority loss fence publication and close drains held refresh', async t => {
  const f = await setup(t); await f.link(); f.advance(1001);
  const entered = deferred(); const release = deferred(); const controller = new AbortController();
  const pending = f.store.acquire(subject, 1, async () => { entered.resolve(); await release.promise;
    return { accessToken: 'LATE', expiresAt: epoch + 60_000 }; }, { ...context(), signal: controller.signal });
  await entered.promise; controller.abort(); f.revoke();
  let drained = false; const closing = f.store.close().then(() => { drained = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(drained, false);
  release.resolve(); await assert.rejects(pending, /Account storage: (closed|unavailable|unready)/u); await closing;
  await assert.rejects(f.store.inspect(subject, context()), /Account storage: closed/u);
  assert.ok(!JSON.stringify([...f.rows.values()]).includes('LATE'));
});

test('each singleflight waiter rechecks its own cancellation before returning a token', async t => {
  const f = await setup(t); await f.link(); f.advance(1001);
  const entered = deferred(); const release = deferred(); const controller = new AbortController();
  const refresh = async () => { entered.resolve(); await release.promise; return { accessToken: 'RENEWED', expiresAt: epoch + 60_000 }; };
  const first = f.store.acquire(subject, 1, refresh, context()); await entered.promise;
  const second = f.store.acquire(subject, 1, refresh, { ...context(), signal: controller.signal });
  const rejected = assert.rejects(second, /Account storage: unavailable/u);
  controller.abort(); release.resolve();
  assert.deepEqual(await first, { kind: 'token', accessToken: 'RENEWED' }); await rejected;
});

test('expiry between account CAS and caller publication does not return an expired token', async t => {
  const f = await setup(t); await f.link(); let advanced = false;
  f.controls.hook = r => {
    r.reply();
    if (!advanced && r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('account_')) { advanced = true; f.advance(1001); }
  };
  assert.deepEqual(await f.store.acquire(subject, 1, async () => { assert.fail('cached access token starts valid'); }, context()),
    { kind: 'signin-required' });
});

test('exact ResourceNotFound lookup works for account ciphertext without recovery traversal', async t => {
  const f = await setup(t);
  f.controls.hook = r => {
    if (r.req.method === 'GET' && r.url.pathname !== '/Directory()') {
      r.res.writeHead(404, { 'x-ms-error-code': 'ResourceNotFound' }); r.res.end();
    } else r.reply();
  };
  await f.link(); assert.deepEqual(await f.store.inspect(subject, context()), { generation: 1, linked: true });
  for (const r of f.requests.filter(r => r.url.pathname === '/Directory()')) {
    assert.equal(r.url.searchParams.get('$top'), '1'); assert.match(r.url.searchParams.get('$filter')!, / and RowKey eq '/u);
  }
});

test('uncommitted completion is not success and cannot retry inherited exchanging after restart', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'crash', context());
  assert.equal(await f.store.claim(ch, context()), 'claimed');
  f.controls.hook = r => {
    if (r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('challenge_')) { r.res.writeHead(204); r.res.end(); }
    else r.reply();
  };
  assert.equal(await f.store.complete(ch, tokens(), context()), false);
  const next = f.open(); assert.equal(await next.claim(ch, context()), 'unavailable');
  assert.equal(await next.complete(ch, tokens(), context()), false);
});

test('expired completion and malformed token records have no persistent credential effect', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'late', context());
  assert.equal(await f.store.claim(ch, context()), 'claimed');
  await assert.rejects(f.store.complete(ch, { ...tokens(), accessToken: 'RAW-TOKEN\nPRIVATE' }, context()), /Account storage: corrupt/u);
  f.advance(600_000); assert.equal(await f.store.complete(ch, tokens(), context()), false);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 1, linked: false });
});

test('bounded admission leaves disconnect independent of held renewals', async t => {
  const f = await setup(t); const entered = deferred(); const release = deferred();
  await f.link(); f.advance(1001);
  const refresh = async () => { entered.resolve(); await release.promise; return tokens(); };
  const a = f.store.acquire(subject, 1, refresh, context()); await entered.promise;
  const b = f.store.acquire(subject, 1, refresh, context()); const c = f.store.acquire(subject, 1, refresh, context());
  await assert.rejects(f.store.inspect(subject, context()), /Account storage: busy/u);
  assert.equal(await f.store.disconnect(subject, context()), 2);
  release.resolve(); await Promise.all([a, b, c]);
  await eventually(() => f.stats.sockets === f.stats.socketCloses);
});

test('replayed disconnect generation cannot erase a newly linked account', async t => {
  const f = await setup(t); await f.link(); assert.equal(await f.store.disconnect(subject, context(), 1), 2);
  await f.link('relinked'); assert.equal(await f.store.disconnect(subject, context(), 1), 2);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 2, linked: true });
});

test('brief SSO assertions never survive process lifetime even while encrypted access tokens do', async t => {
  const f = await setup(t); await f.link(); await f.store.close(); f.advance(1001);
  let refreshed = false;
  const reopened = f.open();
  assert.deepEqual(await reopened.acquire(subject, 1, async () => { refreshed = true; return tokens(); }, context()), { kind: 'signin-required' });
  assert.equal(refreshed, false);
});
