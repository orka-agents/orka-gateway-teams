import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Agent } from 'node:https';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import type { ReplyRoute } from '../src/ingress/types.js';
import { createProviderSender } from '../src/outbound/sender.js';
import type { ProviderPost } from '../src/outbound/sender.js';
import { formatDelivery } from '../src/teams/format.js';
import { finalDelivery, finalMessage } from './fixtures/outgoing.js';
import { httpsFixture } from './support/ingress-https.js';

const route: ReplyRoute = { serviceUrl: 'https://smba.trafficmanager.net/teams/', channelId: 'msteams', bot: { id: 'bot-fixture', role: 'bot' },
  conversation: { id: 'opaque/a%2Fb?c#d:日本', conversationType: 'personal', tenantId: finalDelivery.accountId } };
const delivered = { kind: 'delivered', providerMessageId: 'provider-fixture' } as const;
const token = () => randomBytes(24).toString('base64url');
const receipt = () => ({ status: 201, data: Buffer.from('{"id":"provider-fixture"}') });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

for (const status of [200, 201]) test(`public SDK HTTPS POST ${status} preserves path, exact formatter bytes and authentication`, async (t) => {
  const bearer = token(); let calls = 0; let path = ''; let body = Buffer.alloc(0); let authenticated = false;
  const tls = await httpsFixture(t, async (req, res) => {
    calls++; path = req.url!; authenticated = req.headers.authorization === `Bearer ${bearer}`;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); body = Buffer.concat(chunks);
    res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"id":"provider-fixture"}');
  });
  const sender = createProviderSender(async () => bearer, { ca: tls.ca }); t.after(() => sender.stop());
  assert.deepEqual(await sender.send({ ...route, serviceUrl: `${tls.baseUrl}saved/base/` }, formatDelivery(finalDelivery)), delivered);
  assert.equal(calls, 1); assert.equal(authenticated, true);
  assert.equal(path, '/saved/base/v3/conversations/opaque%2Fa%252Fb%3Fc%23d%3A%E6%97%A5%E6%9C%AC/activities');
  assert.equal(body.toString(), JSON.stringify(finalMessage));
  assert.equal(body.length <= 20 * 1024, true);
});

test('actual near-limit formatter body is sent unchanged without SDK enrichment', async (t) => {
  let bytes = Buffer.alloc(0);
  const tls = await httpsFixture(t, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); bytes = Buffer.concat(chunks);
    res.end('{"id":"provider-fixture"}');
  });
  const sender = createProviderSender(async () => token(), { ca: tls.ca }); t.after(() => sender.stop());
  const message = formatDelivery({ ...finalDelivery, text: 'x'.repeat(64 * 1024) });
  assert.deepEqual(await sender.send({ ...route, serviceUrl: tls.baseUrl }, message), delivered);
  assert.equal(bytes.equals(Buffer.from(JSON.stringify(message))), true);
  assert.ok(bytes.length > 20 * 1024 - 10 && bytes.length <= 20 * 1024);
  const activity = JSON.parse(bytes.toString());
  for (const field of ['id', 'from', 'conversation', 'serviceUrl']) assert.equal(field in activity, false);
});

test('trusted post seam receives fresh public SDK configs and explicit validated string token', async (t) => {
  const bearer = token(); const configs: Parameters<ProviderPost>[2][] = [];
  const sender = createProviderSender(async () => bearer, { post: async (url, body, config) => {
    configs.push(config);
    assert.equal(url, 'https://smba.trafficmanager.net/teams/v3/conversations/opaque%2Fa%252Fb%3Fc%23d%3A%E6%97%A5%E6%9C%AC/activities');
    assert.equal(body.toString(), JSON.stringify(finalMessage)); assert.equal(config.token === bearer, true);
    assert.equal(config.maxRedirects, 0); assert.equal(config.proxy, false); assert.equal(config.responseType, 'arraybuffer');
    assert.equal(config.decompress, false); assert.equal(config.maxContentLength, 64 * 1024); assert.equal(config.maxBodyLength, 20 * 1024);
    assert.ok(config.httpsAgent instanceof Agent); assert.equal(config.httpsAgent.options.rejectUnauthorized, true);
    assert.equal(config.validateStatus?.(503), true); assert.equal(config.validateStatus?.(307), true);
    assert.ok(config.timeout! > 0 && config.timeout! <= 9000); assert.equal(config.signal?.aborted, false);
    delete config.token; // Models the documented withConfig mutation, not Axios internals.
    return receipt();
  } }); t.after(() => sender.stop());
  assert.deepEqual(await sender.send(route, finalMessage), delivered);
  assert.deepEqual(await sender.send(route, finalMessage), delivered);
  assert.notEqual(configs[0], configs[1]); assert.notEqual(configs[0]!.headers, configs[1]!.headers);
});

test('redirects, non-2xx and invalid raw receipts are unknown with one actual POST', async (t) => {
  let calls = 0; let status = 200; let data = Buffer.from('{}'); let compressed = false; let truncated = false;
  const tls = await httpsFixture(t, async (req, res) => {
    calls++; for await (const _chunk of req) { /* consume the entire request before replying */ }
    res.writeHead(status, { 'content-type': 'application/json', location: '/redirect-target',
      ...(compressed ? { 'content-encoding': 'gzip' } : {}), ...(truncated ? { 'content-length': data.length + 10 } : {}) });
    res.end(data);
  });
  const sender = createProviderSender(async () => token(), { ca: tls.ca }); t.after(() => sender.stop());
  const destination = { ...route, serviceUrl: tls.baseUrl };
  for (const code of [202, 204, 301, 302, 307, 308, 400, 401, 429, 500, 503]) {
    status = code; data = Buffer.from('{"id":"provider-fixture"}'); const before = calls;
    assert.deepEqual(await sender.send(destination, finalMessage), { kind: 'unknown' }, `status ${code}`);
    assert.equal(calls, before + 1);
  }
  status = 200;
  for (const bytes of [Buffer.from('{}'), Buffer.from('null'), Buffer.from('{'), Buffer.from('{"id":"ok"}{}'),
    Buffer.from([0xff]), Buffer.concat([Buffer.from('{"id":"bad-'), Buffer.from([0xff]), Buffer.from('"}')]),
    Buffer.from('{"id":"\\ud800"}'), Buffer.from('{"id":" x"}'), Buffer.from('{"id":1}'),
    Buffer.from('{"id":""}'), Buffer.from(JSON.stringify({ id: 'é'.repeat(129) })), Buffer.alloc(64 * 1024 + 1, ' ')]) {
    data = bytes; const before = calls;
    assert.deepEqual(await sender.send(destination, finalMessage), { kind: 'unknown' }); assert.equal(calls, before + 1);
  }
  data = Buffer.from('{"id":"provider-fixture"}'.padEnd(64 * 1024));
  assert.deepEqual(await sender.send(destination, finalMessage), delivered);
  compressed = true; data = gzipSync(Buffer.from('{"id":"provider-fixture"}'));
  assert.deepEqual(await sender.send(destination, finalMessage), { kind: 'unknown' });
  compressed = false; truncated = true; data = Buffer.from('{"id":"provider-fixture"}');
  // Closing a truncated response is an explicit socket barrier, not a sleep.
  const sending = sender.send(destination, finalMessage);
  tls.server.once('request', (_req, res) => res.once('finish', () => res.socket?.destroy()));
  assert.deepEqual(await sending, { kind: 'unknown' });
});

test('untrusted HTTPS certificate fails unknown after handoff without a provider request', async (t) => {
  let calls = 0; const tls = await httpsFixture(t, (_req, res) => { calls++; res.end('{"id":"provider-fixture"}'); });
  const sender = createProviderSender(async () => token()); t.after(() => sender.stop());
  assert.deepEqual(await sender.send({ ...route, serviceUrl: tls.baseUrl }, finalMessage), { kind: 'unknown' });
  assert.equal(calls, 0);
});

test('unsafe URLs, dot segments, invalid tokens and oversize bodies fail before POST', async (t) => {
  let calls = 0; let acquisitions = 0; let value: unknown = token();
  const sender = createProviderSender(async () => { acquisitions++; return value as string; }, { post: async () => { calls++; return receipt(); } });
  t.after(() => sender.stop());
  for (const url of ['http://localhost/', 'https://user@localhost/', 'https://localhost/?q=1', 'https://localhost/#x',
    'https://localhost/a/../', 'https://localhost/%2e/', 'https://localhost/no-trailing-slash', 'https://localhost/\\evil/']) {
    assert.deepEqual(await sender.send({ ...route, serviceUrl: url }, finalMessage), { kind: 'retryable' });
  }
  for (const id of ['.', '..', '', ' bad', '\ud800']) assert.deepEqual(await sender.send({ ...route, conversation: { ...route.conversation, id } }, finalMessage), { kind: 'retryable' });
  const oversized = structuredClone(finalMessage); oversized.attachments[0].content.fallbackText = 'x'.repeat(20 * 1024);
  assert.deepEqual(await sender.send(route, oversized), { kind: 'retryable' });
  assert.equal(acquisitions, 0);
  for (value of [undefined, null, '', ' ', 'a\r\nb', {}, () => token(), 'x'.repeat(8193)]) {
    assert.deepEqual(await sender.send(route, finalMessage), { kind: 'retryable' });
  }
  assert.equal(calls, 0);
});

test('single-flight uncancellable token work survives caller deadlines but cannot produce late POSTs', async () => {
  const gate = deferred<string>(); const started = deferred<void>(); let acquisitions = 0; let calls = 0;
  const sender = createProviderSender(() => { acquisitions++; started.resolve(); return gate.promise; }, { post: async () => { calls++; return receipt(); } });
  try {
    const first = sender.send(route, finalMessage, { deadline: performance.now() + 25 }); await started.promise;
    const secondAbort = new AbortController(); const second = sender.send(route, finalMessage, { signal: secondAbort.signal }); secondAbort.abort();
    assert.deepEqual(await second, { kind: 'retryable' }); assert.deepEqual(await first, { kind: 'retryable' });
    for (let i = 0; i < 5; i++) {
      const abort = new AbortController(); const waiting = sender.send(route, finalMessage, { signal: abort.signal }); abort.abort();
      assert.deepEqual(await waiting, { kind: 'retryable' });
    }
    assert.equal(acquisitions, 1);
    let stopped = false; const stopping = sender.stop().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false);
    gate.resolve(token()); await stopping;
    assert.equal(calls, 0); assert.equal(acquisitions, 1);
    assert.deepEqual(await sender.send(route, finalMessage), { kind: 'retryable' });
  } finally { gate.resolve(token()); await sender.stop(); }
});

test('completed token waiters release their bodies while shared acquisition remains unresolved', { timeout: 10000 }, async (t) => {
  const child = fork(new URL('./support/outbound-token-retention.ts', import.meta.url), {
    execArgv: ['--expose-gc', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; });
  type Sample = { bodyBytes: number; acquisitions: number; posts: number; tokenSettled: boolean;
    after1000: number; after2000: number; afterDrain: number; postsAfterDrain: number };
  const sample = await new Promise<Sample>((resolve, reject) => {
    child.once('message', (value) => resolve(value as Sample));
    child.once('error', () => reject(new Error('Retention fixture failed to start.')));
    child.once('exit', () => reject(new Error('Retention fixture exited before reporting.')));
  });
  assert.equal(await exited, 0); assert.equal(sample.bodyBytes, 20480);
  assert.equal(sample.acquisitions, 1); assert.equal(sample.posts, 0); assert.equal(sample.tokenSettled, false);
  // Allow a small, fixed Buffer-accounting margin, not growth per completed call.
  assert.ok(sample.after1000 <= 4 * sample.bodyBytes && sample.after2000 <= 4 * sample.bodyBytes, JSON.stringify(sample));
  assert.ok(sample.afterDrain <= 4 * sample.bodyBytes); assert.equal(sample.postsAfterDrain, 0);
});

test('a live caller may share pending acquisition without reviving an expired caller', async (t) => {
  const gate = deferred<string>(); let acquisitions = 0; let calls = 0;
  const sender = createProviderSender(() => { acquisitions++; return gate.promise; }, { post: async () => { calls++; return receipt(); } });
  t.after(() => sender.stop());
  const abort = new AbortController(); const old = sender.send(route, finalMessage, { signal: abort.signal }); abort.abort();
  assert.deepEqual(await old, { kind: 'retryable' });
  const current = sender.send(route, finalMessage); gate.resolve(token());
  assert.deepEqual(await current, delivered); assert.equal(acquisitions, 1); assert.equal(calls, 1);
});

test('synchronous token failure is retryable and a later acquisition can succeed', async (t) => {
  let acquisitions = 0;
  const sender = createProviderSender(() => { if (++acquisitions === 1) throw new Error('synthetic private failure'); return Promise.resolve(token()); }, { post: async () => receipt() });
  t.after(() => sender.stop());
  assert.deepEqual(await sender.send(route, finalMessage), { kind: 'retryable' });
  assert.deepEqual(await sender.send(route, finalMessage), delivered);
});

test('monotonic deadline fence blocks POST even before expired timer callbacks run', async (t) => {
  let calls = 0; const deadline = performance.now() + 20;
  const sender = createProviderSender(async () => {
    // Model synchronous work that exhausts the budget without yielding to timers.
    while (performance.now() <= deadline) { /* explicit monotonic barrier */ }
    return token();
  }, { post: async () => { calls++; return receipt(); } }); t.after(() => sender.stop());
  assert.deepEqual(await sender.send(route, finalMessage, { deadline }), { kind: 'retryable' }); assert.equal(calls, 0);
});

test('abort after POST is unknown and stop drains the actual post promise before destroying its agent', async () => {
  const gate = deferred<ReturnType<typeof receipt>>(); const handedOff = deferred<void>(); const abort = new AbortController(); let destroyed = false;
  const sender = createProviderSender(async () => token(), { post: (_url, _body, config) => {
    const agent = config.httpsAgent as Agent; const destroy = agent.destroy.bind(agent);
    agent.destroy = () => { destroyed = true; destroy(); }; handedOff.resolve(); return gate.promise;
  } });
  try {
    const sending = sender.send(route, finalMessage, { signal: abort.signal }); await handedOff.promise; abort.abort();
    assert.deepEqual(await sending, { kind: 'unknown' });
    const first = sender.stop(); assert.equal(sender.stop(), first);
    await Promise.resolve(); assert.equal(destroyed, false);
    gate.resolve(receipt()); await first; assert.equal(destroyed, true);
  } finally { gate.resolve(receipt()); await sender.stop(); }
});

test('actual HTTPS hanging response observes caller cancellation and closes its socket', async (t) => {
  const accepted = deferred<void>(); const closed = deferred<void>();
  const tls = await httpsFixture(t, (req, res) => { req.resume(); res.on('close', () => closed.resolve()); accepted.resolve(); });
  const abort = new AbortController(); const sender = createProviderSender(async () => token(), { ca: tls.ca }); t.after(() => sender.stop());
  const sending = sender.send({ ...route, serviceUrl: tls.baseUrl }, finalMessage, { signal: abort.signal });
  await accepted.promise; abort.abort(); assert.deepEqual(await sending, { kind: 'unknown' }); await closed.promise;
});

test('default 9s budget is absolute even with an active slow-dripping HTTPS response', { timeout: 12000 }, async (t) => {
  const closed = deferred<void>(); let calls = 0; let drips = 0;
  const tls = await httpsFixture(t, (req, res) => {
    req.resume(); calls++; res.writeHead(200); res.write('{');
    const timer = setInterval(() => { drips++; res.write(' '); }, 100);
    res.once('close', () => { clearInterval(timer); closed.resolve(); });
  });
  const sender = createProviderSender(async () => token(), { ca: tls.ca }); t.after(() => sender.stop());
  const start = performance.now();
  assert.deepEqual(await sender.send({ ...route, serviceUrl: tls.baseUrl }, finalMessage), { kind: 'unknown' });
  assert.ok(performance.now() - start >= 8900); assert.ok(drips > 1); assert.equal(calls, 1); await closed.promise;
});

test('shorter caller deadline bounds actual HTTPS response wait', { timeout: 3000 }, async (t) => {
  let calls = 0; const closed = deferred<void>();
  const tls = await httpsFixture(t, (req, res) => { req.resume(); calls++; res.once('close', () => closed.resolve()); });
  const sender = createProviderSender(async () => token(), { ca: tls.ca }); t.after(() => sender.stop());
  assert.deepEqual(await sender.send({ ...route, serviceUrl: tls.baseUrl }, finalMessage, { deadline: performance.now() + 500 }), { kind: 'unknown' });
  assert.equal(calls, 1); await closed.promise;
});

test('environment proxy never receives the provider request or bearer', async (t) => {
  let proxyCalls = 0; const proxy = createServer((_req, res) => { proxyCalls++; res.writeHead(502); res.end(); });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); });
  const address = proxy.address(); assert.ok(address && typeof address !== 'string');
  const names = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => { for (const name of names) { const value = original.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.HTTPS_PROXY = process.env.https_proxy = `http://127.0.0.1:${address.port}`;
  process.env.NO_PROXY = process.env.no_proxy = '';
  const bearer = token(); let authenticated = false;
  const tls = await httpsFixture(t, (req, res) => { authenticated = req.headers.authorization === `Bearer ${bearer}`; req.resume(); res.end('{"id":"provider-fixture"}'); });
  const sender = createProviderSender(async () => bearer, { ca: tls.ca }); t.after(() => sender.stop());
  assert.deepEqual(await sender.send({ ...route, serviceUrl: tls.baseUrl }, finalMessage), delivered);
  assert.equal(authenticated, true); assert.equal(proxyCalls, 0);
});

test('TLS bypass is refused initially and rechecked after token acquisition', async (t) => {
  const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED; delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  t.after(() => { if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original; });
  let calls = 0; let acquisitions = 0;
  const sender = createProviderSender(async () => { acquisitions++; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; return token(); },
    { post: async () => { calls++; return receipt(); } }); t.after(() => sender.stop());
  assert.deepEqual(await sender.send(route, finalMessage), { kind: 'retryable' });
  assert.deepEqual(await sender.send(route, finalMessage), { kind: 'retryable' });
  assert.equal(acquisitions, 1); assert.equal(calls, 0);
});
