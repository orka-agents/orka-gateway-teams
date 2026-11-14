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

test('a held old-generation renewal does not block acquire after disconnect and relink', async t => {
  const f = await setup(t); await f.link(); f.advance(1001);
  const entered = deferred(); const release = deferred(); let oldSettled = false;
  const old = f.store.acquire(subject, 1, async () => {
    entered.resolve(); await release.promise; return { accessToken: 'OLD-RENEWAL', expiresAt: epoch + 60_000 };
  }, context()).finally(() => { oldSettled = true; });
  await entered.promise;
  assert.equal(await f.store.disconnect(subject, context()), 2);
  await f.link('relinked-during-renewal', { ...tokens(epoch + 1001), accessToken: 'RELINKED', assertion: 'NEW-ASSERTION' });
  f.advance(1001);
  const newRelease = deferred(); let newRefreshing = false; let observed: string | undefined;
  const fresh = f.store.acquire(subject, 2, async assertion => {
    observed = assertion; newRefreshing = true; await newRelease.promise;
    return { accessToken: 'NEW-RENEWAL', expiresAt: epoch + 60_000 };
  }, context());
  try {
    await eventually(() => newRefreshing);
    assert.equal(observed, 'NEW-ASSERTION'); assert.equal(oldSettled, false);
    newRelease.resolve();
    assert.deepEqual(await fresh, { kind: 'token', accessToken: 'NEW-RENEWAL' });
    assert.equal(oldSettled, false);
  } finally { newRelease.resolve(); release.resolve(); await Promise.allSettled([old, fresh]); }
  assert.deepEqual(await old, { kind: 'signin-required' });
});

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

test('late completion cannot pair a newer account token with its stale cached assertion', async t => {
  const f = await setup(t);
  const old = await f.store.challenge(subject, 'chat', 'old-publication', context());
  const winner = await f.store.challenge(subject, 'chat', 'winning-publication', context());
  assert.equal(await f.store.claim(old, context()), 'claimed');
  assert.equal(await f.store.claim(winner, context()), 'claimed');
  const entered = deferred(); const release = deferred(); let published = false; let held = false;
  f.controls.hook = async r => {
    if (r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('account_')) published = true;
    if (published && !held && r.req.method === 'GET' && r.url.pathname.includes("RowKey='challenge_")) {
      held = true; entered.resolve(); await release.promise;
    }
    r.reply();
  };
  const pending = f.store.complete(old, { ...tokens(), accessToken: 'OLD', assertion: 'OLD-ASSERTION' }, context());
  await entered.promise;
  assert.equal(await f.store.complete(winner, { ...tokens(), accessToken: 'WINNER', assertion: 'WINNING-ASSERTION' }, context()), true);
  release.resolve(); const completed = await pending;
  // Usage-only writes must carry the winning assertion's exact revision forward.
  for (let i = 0; i < 2; i++) assert.deepEqual(await f.store.acquire(subject, 1, async () => {
    assert.fail('winning token is still valid');
  }, context()), { kind: 'token', accessToken: 'WINNER' });
  f.advance(1001); let observed: string | undefined;
  assert.deepEqual(await f.store.acquire(subject, 1, async assertion => {
    observed = assertion; return { accessToken: 'RENEWED-WINNER', expiresAt: epoch + 60_000 };
  }, context()), { kind: 'token', accessToken: 'RENEWED-WINNER' });
  assert.equal(observed, 'WINNING-ASSERTION');
  assert.equal(completed, false);
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

test('a later usage-only write does not invalidate an acquire waiting at its final GET', async t => {
  const f = await setup(t); await f.link();
  const entered = deferred(); const release = deferred(); let gets = 0;
  f.controls.hook = async r => {
    if (r.req.method === 'GET' && r.url.pathname.includes("RowKey='account_") && ++gets === 3) {
      entered.resolve(); await release.promise;
    }
    r.reply();
  };
  const noRefresh = async (): Promise<AccountTokens> => { assert.fail('cached access token remains valid'); };
  const first = f.store.acquire(subject, 1, noRefresh, context()); await entered.promise;
  try {
    f.advance(1);
    assert.deepEqual(await f.store.acquire(subject, 1, noRefresh, context()), { kind: 'token', accessToken: 'ACCESS-SENTINEL' });
  } finally { release.resolve(); await first; }
  assert.deepEqual(await first, { kind: 'token', accessToken: 'ACCESS-SENTINEL' });
});

for (const replacement of ['credentials', 'generation', 'expiry', 'idle'] as const) {
  test(`final acquire GET refuses concurrent ${replacement} changes`, async t => {
    const f = await setup(t);
    await f.link('initial', { ...tokens(), expiresAt: epoch + (replacement === 'idle' ? 90 * 86_400_000 : 1000) });
    const entered = deferred(); const release = deferred(); let gets = 0;
    f.controls.hook = async r => {
      if (r.req.method === 'GET' && r.url.pathname.includes("RowKey='account_") && ++gets === 3) {
        entered.resolve(); await release.promise;
      }
      r.reply();
    };
    const pending = f.store.acquire(subject, 1, async () => { assert.fail('initial token remains valid'); }, context());
    await entered.promise;
    try {
      if (replacement === 'credentials') await f.link('replacement', { accessToken: 'REPLACEMENT', expiresAt: epoch + 60_000 });
      else if (replacement === 'generation') {
        assert.equal(await f.store.disconnect(subject, context()), 2);
        await f.link('relinked-same-token', { ...tokens(), expiresAt: epoch + 60_000 });
      } else f.advance(replacement === 'idle' ? 30 * 86_400_000 : 1001);
    } finally { release.resolve(); await pending; }
    assert.deepEqual(await pending, { kind: 'signin-required' });
  });
}

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
  const acquired = Promise.all([a, b, c]);
  try {
    await assert.rejects(f.store.inspect(subject, context()), /Account storage: busy/u);
    const before = await f.store.inspect(subject, context(), true);
    assert.deepEqual(before, { generation: 1, linked: true });
    assert.equal(await f.store.disconnect(subject, context(), before.generation), 2);
  } finally { release.resolve(); await acquired; }
  assert.deepEqual(await acquired, [{ kind: 'signin-required' }, { kind: 'signin-required' }, { kind: 'signin-required' }]);
  await eventually(() => f.stats.sockets === f.stats.socketCloses);
});

test('replayed disconnect generation cannot erase a newly linked account', async t => {
  const f = await setup(t); await f.link(); assert.equal(await f.store.disconnect(subject, context(), 1), 2);
  await f.link('relinked'); assert.equal(await f.store.disconnect(subject, context(), 1), 2);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 2, linked: true });
});

test('browser preparation is repeatable across restart and exposes secrets only through BrowserAttempt', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'browser', context());
  const first = await f.store.prepareBrowser(ch, context()); assert.ok(first);
  assert.match(first.state, new RegExp('^' + ch.id.replaceAll('.', '\\.') + '\\.[A-Za-z0-9_-]{43}$', 'u'));
  assert.match(first.nonce, /^[A-Za-z0-9_-]{43}$/u); assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(await f.store.getChallenge(ch.id, context()), ch);
  await f.store.close(); const next = f.open();
  assert.deepEqual(await next.prepareBrowser(ch, context()), first);
  for (const value of [first.state, first.nonce, first.verifier]) {
    assert.equal(JSON.stringify([...f.rows.values()]).includes(value), false);
    for (const row of f.rows.values()) assert.equal(Buffer.from(String(row.Payload), 'base64').includes(Buffer.from(value)), false);
    assert.equal(JSON.stringify(await next.getChallenge(ch.id, context())).includes(value), false);
  }
  const [a, b] = await Promise.all([next.claimBrowser(first.state, context()), next.claimBrowser(first.state, context())]);
  assert.equal([a, b].filter(Boolean).length, 1);
  const claimed = a ?? b; assert.ok(claimed); assert.equal(claimed.challenge.method, 'browser');
  assert.equal(await next.claimBrowser(first.state, context()), undefined);
  assert.equal(await next.prepareBrowser(claimed.challenge, context()), undefined);
  assert.equal(await next.claim(claimed.challenge, context()), 'unavailable');
  assert.equal(await next.complete(claimed.challenge, { ...tokens(), refreshToken: 'REFRESH-SENTINEL' }, context()), true);
});

test('browser takes over in-flight SSO without permitting its captured challenge to publish', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'takeover', context());
  assert.equal(await f.store.claim(ch, context()), 'claimed');
  const prepared = await f.store.prepareBrowser(ch, context()); assert.ok(prepared);
  const claimed = await f.store.claimBrowser(prepared.state, context()); assert.ok(claimed);
  assert.equal(await f.store.complete(ch, tokens(), context()), false);
  assert.equal(await f.store.claim(ch, context()), 'unavailable');
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 1, linked: false });
  assert.equal(await f.store.complete(claimed.challenge, tokens(), context()), true);
});

test('browser cannot take over after committing begins, even before account publication', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'committing', context());
  assert.equal(await f.store.claim(ch, context()), 'claimed');
  const prepared = await f.store.prepareBrowser(ch, context()); assert.ok(prepared);
  const entered = deferred(); const release = deferred(); let held = false;
  f.controls.hook = async r => {
    if (!held && r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('account_')) {
      held = true; entered.resolve(); await release.promise;
    }
    r.reply();
  };
  const completion = f.store.complete(ch, tokens(), context()); await entered.promise;
  try {
    assert.equal((await f.store.getChallenge(ch.id, context()))?.state, 'committing');
    assert.equal(await f.store.claimBrowser(prepared.state, context()), undefined);
    assert.equal(await f.store.prepareBrowser(ch, context()), undefined);
  } finally { release.resolve(); await completion; }
  assert.equal(await completion, true);
  assert.equal(await f.store.claimBrowser(prepared.state, context()), undefined);
});

test('browser takeover winning the committing CAS prevents SSO account publication', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'commit-race', context());
  assert.equal(await f.store.claim(ch, context()), 'claimed');
  const prepared = await f.store.prepareBrowser(ch, context()); assert.ok(prepared);
  const entered = deferred(); const release = deferred(); let held = false;
  f.controls.hook = async r => {
    if (!held && r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('challenge_')) {
      held = true; entered.resolve(); await release.promise;
    }
    r.reply();
  };
  const completion = f.store.complete(ch, tokens(), context()); await entered.promise;
  try { assert.ok(await f.store.claimBrowser(prepared.state, context())); }
  finally { release.resolve(); await completion; }
  assert.equal(await completion, false);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 1, linked: false });
});

for (const fence of ['expiry', 'disconnect'] as const) test(`browser reservation rejects ${fence} and forged state`, async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', fence, context());
  const prepared = await f.store.prepareBrowser(ch, context()); assert.ok(prepared);
  assert.equal(await f.store.claimBrowser(prepared.state.slice(0, -1) + (prepared.state.endsWith('A') ? 'B' : 'A'), context()), undefined);
  assert.equal(await f.store.claimBrowser('malformed', context()), undefined);
  const requests = f.requests.length;
  assert.equal(await f.store.claimBrowser('a'.repeat(64) + '.' + '-'.repeat(36) + '.' + 'b'.repeat(43), context()), undefined);
  assert.equal(f.requests.length, requests);
  if (fence === 'expiry') f.advance(600_000); else await f.store.disconnect(subject, context());
  assert.equal(await f.store.claimBrowser(prepared.state, context()), undefined);
  assert.equal(await f.store.prepareBrowser(ch, context()), undefined);
});

test('durable browser cache remains linked after restart and rotates or retains refresh credentials', async t => {
  const f = await setup(t); await f.link('cache', { ...tokens(), refreshToken: 'REFRESH-ONE' });
  await f.store.close(); f.advance(1001); const next = f.open();
  assert.deepEqual(await next.inspect(subject, context()), { generation: 1, linked: true });
  const noSSO = async (): Promise<AccountTokens> => { assert.fail('durable cache must win over SSO assertion'); };
  const acquire = (refresh: (token: string) => Promise<AccountTokens>) => next.acquire(subject, 1, noSSO, context(), refresh);
  assert.deepEqual(await acquire(async token => {
    assert.equal(token === 'REFRESH-ONE', true); return { accessToken: 'ROTATED', expiresAt: epoch + 2000, refreshToken: 'REFRESH-TWO' };
  }), { kind: 'token', accessToken: 'ROTATED' });
  f.advance(1000);
  assert.deepEqual(await acquire(async token => {
    assert.equal(token === 'REFRESH-TWO', true); return { accessToken: 'RETAINED', expiresAt: epoch + 3000 };
  }), { kind: 'token', accessToken: 'RETAINED' });
  f.advance(1000);
  await acquire(async token => {
    assert.equal(token === 'REFRESH-TWO', true); throw Object.assign(new Error('private'), { code: 'invalid-grant' });
  });
  assert.deepEqual(await next.inspect(subject, context()), { generation: 2, linked: false });
});

test('same-generation SSO completion and renewal preserve the existing browser refresh cache', async t => {
  const f = await setup(t); await f.link('browser-cache', { ...tokens(), refreshToken: 'PRESERVED-REFRESH' });
  await f.link('sso-relink'); f.advance(1001);
  // Four-argument callers may still renew by SSO; that renewal must not erase the cache.
  assert.equal((await f.store.acquire(subject, 1, async () => ({ accessToken: 'SSO-RENEWED', expiresAt: epoch + 2000 }), context())).kind, 'token');
  await f.store.close(); f.advance(1000); const next = f.open();
  assert.deepEqual(await next.acquire(subject, 1, async () => { assert.fail('no durable assertion'); }, context(), async token => {
    assert.equal(token === 'PRESERVED-REFRESH', true); return { accessToken: 'CACHE-RENEWED', expiresAt: epoch + 60_000 };
  }), { kind: 'token', accessToken: 'CACHE-RENEWED' });
});

for (const invalid of [false, true]) test(`disconnect fences held cache renewal ${invalid ? 'invalid grant' : 'success'}`, async t => {
  const f = await setup(t); await f.link('cache-race', { ...tokens(), refreshToken: 'HELD-REFRESH' }); f.advance(1001);
  const entered = deferred(); const release = deferred();
  const pending = f.store.acquire(subject, 1, async () => { assert.fail('prefer cache'); }, context(), async () => {
    entered.resolve(); await release.promise;
    if (invalid) throw Object.assign(new Error('private'), { code: 'invalid-grant' });
    return { accessToken: 'LATE-CACHE', expiresAt: epoch + 60_000, refreshToken: 'LATE-REFRESH' };
  });
  await entered.promise;
  try { assert.equal(await f.store.disconnect(subject, context()), 2); }
  finally { release.resolve(); await pending; }
  assert.deepEqual(await pending, { kind: 'signin-required' });
  assert.deepEqual(await f.open().inspect(subject, context()), { generation: 2, linked: false });
});

test('publication proof never mistakes an old linked refresh cache for a fresh challenge', async t => {
  const f = await setup(t); const old = await f.link('old-cache', { ...tokens(), refreshToken: 'OLD-REFRESH' });
  const fresh = await f.store.challenge(subject, 'chat', 'fresh-unpublished', context());
  assert.equal(await f.store.published(old, context()), true);
  assert.equal(await f.store.published(fresh, context()), false);
  f.advance(1001);
  assert.deepEqual(await f.store.inspect(subject, context()), { generation: 1, linked: true });
  assert.equal(await f.store.published(old, context()), false);
  assert.equal(await f.store.published(fresh, context()), false);
});

test('publication proof survives failed challenge finalization but binds exact challenge and generation', async t => {
  const f = await setup(t); const ch = await f.store.challenge(subject, 'chat', 'partial', context());
  const other = await f.store.challenge(subject, 'chat', 'unrelated', context());
  assert.equal(await f.store.claim(ch, context()), 'claimed'); let writes = 0;
  f.controls.hook = r => {
    if (r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('challenge_') && ++writes === 2) {
      r.res.writeHead(204); r.res.end();
    } else r.reply();
  };
  assert.equal(await f.store.complete(ch, tokens(), context()), false);
  assert.equal((await f.store.getChallenge(ch.id, context()))?.state, 'committing');
  await f.store.close(); const next = f.open();
  assert.equal(await next.published(ch, context()), true);
  assert.equal(await next.published(other, context()), false);
  assert.equal(await next.published({ ...ch, generation: ch.generation + 1 }, context()), false);
  await next.disconnect(subject, context());
  assert.equal(await next.published(ch, context()), false);
  assert.equal(await next.published({ ...ch, generation: ch.generation + 1 }, context()), false);
});

test('usage and cache renewal preserve publication proof while expiry and invalid grant invalidate it', async t => {
  const f = await setup(t); const ch = await f.link('renew-proof', { ...tokens(), refreshToken: 'RENEW-PROOF' });
  const noSSO = async (): Promise<AccountTokens> => { assert.fail('cached access or refresh must suffice'); };
  assert.equal((await f.store.acquire(subject, 1, noSSO, context())).kind, 'token');
  assert.equal(await f.store.published(ch, context()), true);
  f.advance(1001); assert.equal(await f.store.published(ch, context()), false);
  assert.equal((await f.store.acquire(subject, 1, noSSO, context(), async () => ({ accessToken: 'RENEWED', expiresAt: epoch + 2000 }))).kind, 'token');
  await f.store.close(); const next = f.open();
  assert.equal(await next.published(ch, context()), true);
  f.advance(1000);
  await next.acquire(subject, 1, noSSO, context(), async () => { throw Object.assign(new Error('private'), { code: 'invalid-grant' }); });
  assert.deepEqual(await next.inspect(subject, context()), { generation: 2, linked: false });
  assert.equal(await next.published(ch, context()), false);
  assert.equal(await next.published({ ...ch, generation: 2 }, context()), false);
});

test('publication proof excludes idle accounts even with an unexpired access token', async t => {
  const f = await setup(t); const ch = await f.link('idle-proof', { accessToken: 'LONG', expiresAt: epoch + 90 * 86_400_000 });
  f.advance(30 * 86_400_000);
  assert.equal(await f.store.published(ch, context()), false);
});

test('local handoff guards ignore usage and unrelated accounts, but fence token-pair and generation mutations', async t => {
  const f = await setup(t); await f.link(); const guard = f.store.watch(subject);
  try {
    f.advance(1); assert.equal((await f.store.acquire(subject, 1, async () => tokens(), context())).kind, 'token');
    await f.store.disconnect({ objectId: 'unrelated' }, context()); assert.equal(guard.active(), true);
    f.advance(1000); assert.equal((await f.store.acquire(subject, 1, async () => ({ accessToken: 'ROTATED', expiresAt: epoch + 10000 }), context())).kind, 'token');
    assert.equal(guard.active(), false);
  } finally { guard.release(); }
  const fresh = f.store.watch(subject); assert.equal(fresh.active(), true);
  await f.store.disconnect(subject, context()); assert.equal(fresh.active(), false); fresh.release();
  const next = f.store.watch(subject); guard.release();
  await f.store.disconnect(subject, context()); assert.equal(next.active(), false); next.release();
});
test('guards registered during a conditional account mutation stay invalid after failure and do not poison later handoffs', async t => {
  const f = await setup(t); await f.link(); const entered = deferred(); const release = deferred(); t.after(() => release.resolve());
  f.controls.hook = async r => { if (r.req.method === 'PUT' && String(r.body?.RowKey).startsWith('account_')) { entered.resolve(); await release.promise; r.res.destroy(); } else r.reply(); };
  const before = f.store.watch(subject); const pending = f.store.disconnect(subject, context());
  const rejected = assert.rejects(pending); await entered.promise;
  const during = f.store.watch(subject); assert.equal(before.active(), false); assert.equal(during.active(), false);
  release.resolve(); await rejected; assert.equal(during.active(), false); before.release(); during.release();
  delete f.controls.hook; const after = f.store.watch(subject); assert.equal(after.active(), true);
  await f.store.close(); assert.equal(after.active(), false); after.release();
  const closed = f.store.watch(subject); assert.equal(closed.active(), false); closed.release();
});
test('brief SSO assertions never survive process lifetime even while encrypted access tokens do', async t => {
  const f = await setup(t); await f.link(); await f.store.close(); f.advance(1001);
  let refreshed = false;
  const reopened = f.open();
  assert.deepEqual(await reopened.acquire(subject, 1, async () => { refreshed = true; return tokens(); }, context()), { kind: 'signin-required' });
  assert.equal(refreshed, false);
});
