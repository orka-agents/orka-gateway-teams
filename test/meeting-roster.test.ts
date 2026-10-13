import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createProviderSender } from '../src/outbound/sender.js';
import { resolveMeetingAttendees } from '../src/outbound/meeting-roster.js';
import type { ReplyRoute } from '../src/ingress/types.js';
import { httpsFixture } from './support/ingress-https.js';

const route: ReplyRoute = { serviceUrl: 'https://smba.trafficmanager.net/teams/', channelId: 'msteams', bot: { id: 'bot', role: 'bot' },
  conversation: { id: 'chat/a%2Fb?c#d:日本', conversationType: 'groupChat', tenantId: 'tenant' }, requester: { id: 'owner' } };
const members = [{ id: 'bot', name: 'Installed bot' }, { id: 'one', name: '[Ada]', userPrincipalName: 'private-one@example.test' },
  { id: 'guest', name: 'Grace', userPrincipalName: 'guest_x#EXT#@tenant.test' }];
const draft = { subject: 'Review', agenda: ['Design'], attendees: 'everyone' as const, durationMinutes: 30 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test('verified native SDK GET uses exact saved conversation, same bot authority, no POST or redirects', async t => {
  const bearer = randomBytes(24).toString('base64url'); let path = ''; let calls = 0; let authorized = false; let get = false;
  const tls = await httpsFixture(t, (req, res) => { calls++; path = req.url!; get = req.method === 'GET'; authorized = req.headers.authorization === `Bearer ${bearer}`;
    req.resume(); res.end(JSON.stringify({ members })); });
  const sender = createProviderSender(async () => bearer, { ca: tls.ca }); t.after(() => sender.stop());
  assert.equal(typeof sender.getMembers, 'function');
  const result = await sender.getMembers!({ ...route, serviceUrl: `${tls.baseUrl}saved/base/` });
  assert.equal(result.kind, 'members'); assert.equal(calls, 1); assert.equal(get, true); assert.equal(authorized, true);
  assert.equal(path, '/saved/base/v3/conversations/chat%2Fa%252Fb%3Fc%23d%3A%E6%97%A5%E6%9C%AC/pagedMembers');
  if (result.kind !== 'members') throw new Error('Missing roster fixture result');
  const selected = resolveMeetingAttendees(draft, route, result.members);
  assert.equal(selected.kind, 'attendees');
  if (selected.kind === 'attendees') {
    assert.equal(selected.upns.join(',') === 'private-one@example.test,guest_x#EXT#@tenant.test', true);
    assert.deepEqual(selected.audience, { count: 2, labels: ['[Ada]', 'Grace'] });
  }
});

test('raw complete roster validation refuses continuation, excess bounds, malformed JSON and permanent GET failure', async t => {
  let status = 200; let data = Buffer.from(JSON.stringify({ members })); let calls = 0;
  const tls = await httpsFixture(t, (_req, res) => { calls++; res.writeHead(status, { location: '/must-not-follow' }); res.end(data); });
  const sender = createProviderSender(async () => 'token', { ca: tls.ca }); t.after(() => sender.stop());
  assert.equal(typeof sender.getMembers, 'function'); const saved = { ...route, serviceUrl: tls.baseUrl };
  for (const raw of [JSON.stringify({ members, continuationToken: 'next' }), JSON.stringify({ members, continuationToken: null }),
    JSON.stringify({ members: Array.from({ length: 1001 }, () => members[1]) }), '{', '{}', '{"members":[]}{}',
    '{"members":[{"id":"one","name":"\\ud800"}]}', JSON.stringify({ members: [null] }),
    JSON.stringify({ members: [members[1], { ...members[1], userPrincipalName: 'contradictory@example.test' }] })]) {
    data = Buffer.from(raw); assert.equal((await sender.getMembers!(saved)).kind, 'unavailable');
  }
  data = Buffer.from(JSON.stringify({ members: Array.from({ length: 1000 }, (_, i) => ({ id: `member-${i}`, userPrincipalName: `private-${i}@example.test` })) }));
  const complete = await sender.getMembers!(saved); assert.equal(complete.kind, 'members');
  if (complete.kind === 'members') assert.equal(complete.members.length, 1000);
  data = Buffer.from(JSON.stringify({ members }).padEnd(256 * 1024));
  assert.equal((await sender.getMembers!(saved)).kind, 'members');
  data = Buffer.from(JSON.stringify({ members }).padEnd(256 * 1024 + 1));
  assert.equal((await sender.getMembers!(saved)).kind, 'unavailable');
  data = Buffer.from(JSON.stringify({ members }));
  for (status of [401, 403, 302, 307, 400]) {
    const before = calls; assert.equal((await sender.getMembers!(saved)).kind, 'unavailable'); assert.equal(calls, before + 1);
  }
  for (status of [408, 429, 500, 503]) assert.equal((await sender.getMembers!(saved)).kind, 'retryable');
});

test('untrusted TLS and unsafe/channel routes never reach fixture GET', async t => {
  let calls = 0; let tokens = 0;
  const tls = await httpsFixture(t, (_req, res) => { calls++; res.end(JSON.stringify({ members })); });
  const sender = createProviderSender(async () => { tokens++; return 'token'; }); t.after(() => sender.stop());
  assert.equal(typeof sender.getMembers, 'function');
  assert.equal((await sender.getMembers!({ ...route, serviceUrl: tls.baseUrl })).kind, 'retryable'); assert.equal(calls, 0);
  for (const serviceUrl of ['http://localhost/', 'https://user@localhost/', 'https://localhost/a/../']) {
    assert.equal((await sender.getMembers!({ ...route, serviceUrl })).kind, 'unavailable');
  }
  assert.equal((await sender.getMembers!({ ...route, conversation: { ...route.conversation, conversationType: 'channel' }, threadId: 'root' })).kind, 'unavailable');
  assert.equal(tokens, 1); assert.equal(calls, 0);
});

test('native hanging GET is cancelled, actually drained, and never becomes a POST', async t => {
  const accepted = deferred<void>(); const closed = deferred<void>(); let posts = 0;
  const tls = await httpsFixture(t, (req, res) => { if (req.method === 'POST') posts++; res.once('close', () => closed.resolve()); accepted.resolve(); });
  const sender = createProviderSender(async () => 'token', { ca: tls.ca }); t.after(() => sender.stop());
  assert.equal(typeof sender.getMembers, 'function'); const abort = new AbortController();
  const getting = sender.getMembers!({ ...route, serviceUrl: tls.baseUrl }, { signal: abort.signal }); await accepted.promise; abort.abort();
  assert.equal((await getting).kind, 'retryable'); await sender.stop(); await closed.promise; assert.equal(posts, 0);
});

test('GET shares lazy stalled token singleflight with POST and stop waits actual acquisition without late I/O', async () => {
  const gate = deferred<string>(); let acquisitions = 0; let posts = 0; let gets = 0;
  const sender = createProviderSender(() => { acquisitions++; return gate.promise; }, { post: async () => { posts++; return { status: 200, data: Buffer.from('{"id":"ok"}') }; },
    get: async () => { gets++; return { status: 200, data: Buffer.from(JSON.stringify({ members })) }; } });
  try {
    assert.equal(typeof sender.getMembers, 'function');
    const abort = new AbortController(); const get = sender.getMembers!(route, { signal: abort.signal });
    const post = sender.send(route, { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard', version: '1.4', body: [] } }] }, { signal: abort.signal });
    await Promise.resolve(); abort.abort(); assert.equal((await get).kind, 'retryable'); assert.equal((await post).kind, 'retryable');
    assert.equal(acquisitions, 1); let stopped = false; const stopping = sender.stop().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false); gate.resolve('token'); await stopping;
    assert.equal(gets, 0); assert.equal(posts, 0);
  } finally { gate.resolve('token'); await sender.stop(); }
});

test('native roster GET ignores environment proxies and returns only safe failures without retries', async t => {
  let proxyCalls = 0; const proxy = createServer((_req, res) => { proxyCalls++; res.writeHead(502); res.end(); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); });
  const address = proxy.address(); assert.ok(address && typeof address !== 'string');
  const keys = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;
  const original = new Map(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { const value = original.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.HTTPS_PROXY = process.env.https_proxy = `http://127.0.0.1:${address.port}`; process.env.NO_PROXY = process.env.no_proxy = '';
  let calls = 0; let authenticated = false;
  const tls = await httpsFixture(t, (req, res) => { calls++; authenticated = req.headers.authorization === 'Bearer token';
    res.writeHead(403); res.end(JSON.stringify({ members, email: 'private-failure@example.test' })); });
  const sender = createProviderSender(async () => 'token', { ca: tls.ca }); t.after(() => sender.stop());
  const result = await sender.getMembers!({ ...route, serviceUrl: tls.baseUrl });
  assert.deepEqual(result, { kind: 'unavailable' }); assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(authenticated, true); assert.equal(proxyCalls, 0); assert.equal(calls, 1);
});

test('unique full display-name matches only, guest UPN preserved, addresses redacted, duplicates deduplicated', () => {
  const full = [...members, { id: 'otherbot', name: 'Robot', role: 'bot', userPrincipalName: 'bot@example.test' },
    { id: 'tag', name: 'Tag', type: 'tag', userPrincipalName: 'tag@example.test' },
    { id: 'two', name: 'private-label@example.test', userPrincipalName: 'private-two@example.test' },
    { id: 'duplicate', name: 'Duplicate recipient', userPrincipalName: 'private-one@example.test' }];
  const all = resolveMeetingAttendees(draft, route, full); assert.equal(all.kind, 'attendees');
  if (all.kind === 'attendees') {
    assert.equal(all.upns.length, 3); assert.equal(all.audience.count, 3);
    assert.equal(JSON.stringify(all.audience).includes('@'), false);
    assert.deepEqual(all.audience.labels, ['[Ada]', 'Grace', 'a participant']);
  }
  const named = resolveMeetingAttendees({ ...draft, attendees: 'named', names: ['  grace ', '[ADA]'] }, route, members);
  assert.equal(named.kind, 'attendees'); if (named.kind === 'attendees') assert.equal(named.upns[0] === 'guest_x#EXT#@tenant.test', true);
  for (const names of [['Ada'], ['[Ad'], ['Outsider'], ['Grace', 'Missing']]) assert.equal(resolveMeetingAttendees({ ...draft, attendees: 'named', names }, route, members).kind, 'unavailable');
  assert.equal(resolveMeetingAttendees({ ...draft, attendees: 'named', names: ['Grace'] }, route, [...members, { ...members[2]!, id: 'ambiguous' }]).kind, 'unavailable');
  for (const userPrincipalName of ['', 'one@example.test,outsider@example.test', 'one @example.test', 'one@@example.test',
    'one@example.test\n', '\ud800@example.test', 'x'.repeat(1025) + '@example.test']) {
    assert.equal(resolveMeetingAttendees(draft, route, [...members, { id: 'invalid', name: 'Invalid', userPrincipalName }]).kind, 'unavailable');
  }
  const missing = { id: 'missing', name: 'Missing', email: 'not-fallback@example.test' };
  assert.equal(resolveMeetingAttendees(draft, route, [...members, missing]).kind, 'unavailable');
  const personal: ReplyRoute = { serviceUrl: route.serviceUrl, bot: route.bot, channelId: route.channelId,
    conversation: { ...route.conversation, conversationType: 'personal' } };
  const you = resolveMeetingAttendees(draft, personal, members.slice(0, 2)); assert.equal(you.kind, 'attendees');
  if (you.kind === 'attendees') assert.deepEqual(you.audience, { labels: ['You'], count: 1 });
  assert.equal(resolveMeetingAttendees(draft, personal, members).kind, 'unavailable');
});
