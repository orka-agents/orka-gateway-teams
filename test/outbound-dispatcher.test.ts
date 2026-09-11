import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from '@microsoft/teams.common/http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import { safeSdkLogger } from '../src/ingress/logger.js';
import type { ReplyRoute } from '../src/ingress/types.js';
import { createDeliveryDispatcher } from '../src/outbound/dispatcher.js';
import { createProviderSender } from '../src/outbound/sender.js';
import type { DispatcherOptions, ProviderResult, ProviderSender } from '../src/outbound/types.js';
import { finalDelivery, finalMessage } from './fixtures/outgoing.js';
import { expectedEvent } from './fixtures/incoming.js';
import { httpsFixture } from './support/ingress-https.js';

const scope = { appId: 'app-fixture', tenantId: finalDelivery.accountId };
const route: ReplyRoute = { serviceUrl: 'https://smba.trafficmanager.net/teams/', channelId: 'msteams', bot: { id: 'bot-fixture', role: 'bot' },
  conversation: { id: finalDelivery.contextId, conversationType: 'personal', tenantId: scope.tenantId } };
const delivered = { kind: 'delivered', providerMessageId: 'provider-fixture' } as const;
const response = { status: 'delivered', providerMessageId: 'provider-fixture' } as const;
const retryable = { status: 'retryableError', message: 'Delivery is temporarily unavailable.' } as const;
const nonRetryable = { status: 'nonRetryableError', message: 'Delivery cannot be completed safely.' } as const;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-outbound-')); const path = join(directory, 'delivery.sqlite');
  initializeDeliveryJournal(path, scope); const journal = openDeliveryJournal(path, scope);
  const dispatchers: ReturnType<typeof createDeliveryDispatcher>[] = [];
  t.after(async () => { for (const dispatcher of dispatchers) await dispatcher.stop(); journal.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, journal, create(overrides: Partial<DispatcherOptions> = {}) {
    const dispatcher = createDeliveryDispatcher({ journal, scope, getRoute: (key) => key === finalDelivery.replyTarget ? structuredClone(route) : undefined,
      serviceUrls: [route.serviceUrl], recipientIds: [route.bot.id], sender: { send: async () => delivered, stop: async () => {} }, ...overrides });
    dispatchers.push(dispatcher); return dispatcher;
  } };
}

function operation(path: string) {
  const db = new DatabaseSync(path);
  try { return db.prepare('SELECT state, attempt_id AS attemptId, idempotency_id AS idempotencyId, provider_message_id AS receipt FROM operations').get()!; }
  finally { db.close(); }
}

test('claim is committed before sending; receipt is durable before V1 success and alias replay', async (t) => {
  const f = fixture(t); let calls = 0;
  const dispatcher = f.create({ sender: { send: async (saved, message) => {
    calls++; assert.equal(operation(f.path).state, 'sending'); assert.deepEqual(saved, route); assert.deepEqual(message, finalMessage); return delivered;
  }, stop: async () => {} } });
  assert.deepEqual(await dispatcher.deliver(finalDelivery), response);
  assert.equal(operation(f.path).state, 'delivered'); assert.equal(operation(f.path).receipt, 'provider-fixture');
  assert.deepEqual(await dispatcher.deliver({ ...finalDelivery, deliveryId: 'another-alias' }), response);
  assert.deepEqual(await dispatcher.deliver({ ...finalDelivery, text: 'different', deliveryId: 'conflicting-alias' }), nonRetryable);
  assert.deepEqual(await dispatcher.deliver({ ...finalDelivery, idempotencyId: 'different-stable' }), nonRetryable);
  assert.equal(calls, 1); assert.equal(dispatcher.healthy, true);
});

test('concurrent aliases return inFlight without a second provider call', async (t) => {
  const f = fixture(t); const gate = deferred<ProviderResult>(); const started = deferred<void>(); let calls = 0;
  const dispatcher = f.create({ sender: { send: () => { calls++; started.resolve(); return gate.promise; }, stop: async () => { gate.resolve({ kind: 'unknown' }); } } });
  const first = dispatcher.deliver(finalDelivery); await started.promise;
  const aliases = await Promise.all(Array.from({ length: 8 }, (_, i) => dispatcher.deliver({ ...finalDelivery, deliveryId: `alias-${i}` })));
  for (const result of aliases) assert.deepEqual(result, retryable);
  gate.resolve(delivered); assert.deepEqual(await first, response); assert.equal(calls, 1);
});

test('immutable request snapshot precedes first await and caller mutations do not alter replay identity or body', async (t) => {
  const f = fixture(t); const gate = deferred<string>(); let body = ''; const bearer = randomBytes(24).toString('base64url');
  const sender = createProviderSender(() => gate.promise, { post: async (_url, bytes) => { body = bytes.toString(); return { status: 201, data: Buffer.from('{"id":"provider-fixture"}') }; } });
  const dispatcher = f.create({ sender });
  const input = { ...finalDelivery, taskRef: { ...finalDelivery.taskRef }, sessionRef: { ...finalDelivery.sessionRef }, metadata: { task: 'original' } };
  const original = structuredClone(input); const pending = dispatcher.deliver(input);
  input.text = 'changed'; input.contextId = 'different'; input.replyTarget = 'https://untrusted.invalid/'; input.taskRef.name = 'changed'; input.sessionRef.name = 'changed'; input.metadata.task = 'changed';
  gate.resolve(bearer); assert.deepEqual(await pending, response); assert.equal(body, JSON.stringify(finalMessage));
  assert.deepEqual(await dispatcher.deliver({ ...original, deliveryId: 'original-alias' }), response);
  assert.deepEqual(await dispatcher.deliver(input), nonRetryable);
});

test('terminal replay precedes current route policy and removed allowlists without consulting storage', async (t) => {
  const f = fixture(t); const initial = f.create(); assert.deepEqual(await initial.deliver(finalDelivery), response); await initial.stop();
  const next = f.create({ serviceUrls: [], recipientIds: [], getRoute: () => { throw new Error('must not read a route'); },
    sender: { send: async () => { throw new Error('must not send'); }, stop: async () => {} } });
  assert.deepEqual(await next.deliver({ ...finalDelivery, deliveryId: 'new-alias' }), response); assert.equal(next.healthy, true);
});

for (const [label, changed, requestChange] of [
  ['missing', undefined, {}], ['tenant', { ...route, conversation: { ...route.conversation, tenantId: 'other' } }, {}],
  ['context', { ...route, conversation: { ...route.conversation, id: 'other' } }, {}],
  ['group', { ...route, conversation: { ...route.conversation, conversationType: 'groupChat' } }, {}],
  ['channel', { ...route, channelId: 'other' }, {}], ['bot role', { ...route, bot: { ...route.bot, role: 'user' } }, {}],
  ['recipient', { ...route, bot: { ...route.bot, id: 'other-bot' } }, {}],
  ['service allowlist', { ...route, serviceUrl: 'https://other.invalid/' }, {}],
  ['HTTP', { ...route, serviceUrl: 'http://smba.trafficmanager.net/teams/' }, {}],
  ['custom port', { ...route, serviceUrl: 'https://smba.trafficmanager.net:8443/teams/' }, {}],
  ['malformed route', { serviceUrl: route.serviceUrl }, {}], ['thread', route, { threadId: 'thread-1' }],
] as const) test(`fresh ${label} route is durably rejected without provider work`, async (t) => {
  const f = fixture(t); let calls = 0;
  const dispatcher = f.create({ getRoute: () => changed as ReplyRoute | undefined,
    ...(label === 'custom port' ? { serviceUrls: ['https://smba.trafficmanager.net:8443/teams/'] } : {}),
    sender: { send: async () => { calls++; return delivered; }, stop: async () => {} } });
  const input = { ...finalDelivery, ...requestChange };
  assert.deepEqual(await dispatcher.deliver(input), nonRetryable); assert.equal(operation(f.path).state, 'rejected');
  assert.deepEqual(await dispatcher.deliver({ ...input, deliveryId: 'alias' }), nonRetryable);
  assert.equal(calls, 0); assert.equal(dispatcher.healthy, true);
});

test('copies scope and allowlists; metadata and refs never choose the destination', async (t) => {
  const f = fixture(t); let calls = 0; const services = [route.serviceUrl]; const recipients = [route.bot.id]; const mutableScope = { ...scope };
  const options: Partial<DispatcherOptions> = { serviceUrls: services, recipientIds: recipients, scope: mutableScope,
    sender: { send: async (saved) => { calls++; assert.deepEqual(saved, route); return delivered; }, stop: async () => {} } };
  const dispatcher = f.create(options);
  services[0] = 'https://other.invalid/'; recipients[0] = 'other'; mutableScope.tenantId = 'other'; options.getRoute = () => undefined;
  const input = { ...finalDelivery, threadId: '', metadata: { serviceUrl: 'https://other.invalid/', conversation: 'other', replyTarget: 'other' },
    taskRef: { namespace: 'other', name: 'other' }, originatingEventId: 'internal-orka-event-not-teams-id' };
  assert.deepEqual(await dispatcher.deliver(input), response); assert.equal(calls, 1);
});

for (const outcome of [{ kind: 'unknown' }, { kind: 'retryable' }] as const) test(`${outcome.kind} settlement has correct durable retry semantics`, async (t) => {
  const f = fixture(t); let calls = 0;
  const dispatcher = f.create({ sender: { send: async () => { calls++; return calls === 1 ? outcome : delivered; }, stop: async () => {} } });
  assert.deepEqual(await dispatcher.deliver(finalDelivery), outcome.kind === 'retryable' ? retryable : nonRetryable);
  assert.equal(operation(f.path).state, outcome.kind === 'retryable' ? 'ready' : 'unknown');
  const attempt = operation(f.path).attemptId;
  assert.deepEqual(await dispatcher.deliver({ ...finalDelivery, deliveryId: 'retry-alias' }), outcome.kind === 'retryable' ? response : nonRetryable);
  assert.equal(calls, outcome.kind === 'retryable' ? 2 : 1);
  if (outcome.kind === 'retryable') assert.notEqual(operation(f.path).attemptId, attempt);
});

test('invalid external input cannot claim or poison the dispatcher', async (t) => {
  const f = fixture(t); const dispatcher = f.create();
  assert.deepEqual(await dispatcher.deliver({ ...finalDelivery, text: '' }), nonRetryable);
  assert.equal(operation(f.path), undefined); assert.equal(dispatcher.healthy, true);
  assert.deepEqual(await dispatcher.deliver(finalDelivery), response);
});

test('actual token cancellation settles ready and late completion cannot settle or resend the old attempt', async (t) => {
  const f = fixture(t); const gate = deferred<string>(); const started = deferred<void>(); let calls = 0; let acquisitions = 0;
  const sender = createProviderSender(() => { acquisitions++; started.resolve(); return gate.promise; }, { post: async () => { calls++; return { status: 200, data: Buffer.from('{"id":"provider-fixture"}') }; } });
  const dispatcher = f.create({ sender }); const abort = new AbortController();
  const first = dispatcher.deliver(finalDelivery, { signal: abort.signal }); await started.promise; abort.abort();
  assert.deepEqual(await first, retryable); assert.equal(operation(f.path).state, 'ready'); const old = operation(f.path).attemptId;
  const second = dispatcher.deliver({ ...finalDelivery, deliveryId: 'retry-alias' });
  gate.resolve(randomBytes(24).toString('base64url')); assert.deepEqual(await second, response);
  assert.notEqual(operation(f.path).attemptId, old); assert.equal(calls, 1); assert.equal(acquisitions, 1);
});

test('expired deadline after synchronous route work prevents sender handoff, without relying on a timer', async (t) => {
  const f = fixture(t); let calls = 0; const deadline = performance.now() + 20;
  const dispatcher = f.create({ getRoute: () => { while (performance.now() <= deadline) { /* monotonic barrier */ } return route; },
    sender: { send: async () => { calls++; return delivered; }, stop: async () => {} } });
  assert.deepEqual(await dispatcher.deliver(finalDelivery, { deadline }), retryable); assert.equal(calls, 0); assert.equal(operation(f.path).state, 'ready');
});

test('validated receipt wins over caller cancellation while durable settlement still follows', async (t) => {
  const f = fixture(t); const abort = new AbortController();
  const dispatcher = f.create({ sender: { send: async () => { abort.abort(); return delivered; }, stop: async () => {} } });
  assert.deepEqual(await dispatcher.deliver(finalDelivery, { signal: abort.signal }), response);
  assert.equal(operation(f.path).state, 'delivered');
});

test('SQLite begin lock failure poisons health and emits fixed retryable without sending', async (t) => {
  const f = fixture(t); let calls = 0; const blocker = new DatabaseSync(f.path);
  const dispatcher = f.create({ sender: { send: async () => { calls++; return delivered; }, stop: async () => {} } });
  try {
    blocker.exec('BEGIN IMMEDIATE'); assert.deepEqual(await dispatcher.deliver(finalDelivery), retryable);
    assert.equal(dispatcher.healthy, false); blocker.exec('ROLLBACK');
    assert.deepEqual(await dispatcher.deliver(finalDelivery), retryable); assert.equal(calls, 0);
  } finally { blocker.close(); }
});

test('real getRoute storage error poisons dispatcher without sending or closing caller stores', async (t) => {
  const f = fixture(t); const ingressPath = join(f.directory, 'ingress.sqlite');
  const ingressScope = { ...scope, orkaBaseUrl: 'https://orka.invalid/', gatewayNamespace: 'fixture', gatewayName: 'gateway' };
  initializeIngressStore(ingressPath, ingressScope); const ingress = openIngressStore(ingressPath, ingressScope);
  ingress.admit(expectedEvent, route); ingress.close();
  let calls = 0; const dispatcher = f.create({ getRoute: (key) => ingress.getRoute(key), sender: { send: async () => { calls++; return delivered; }, stop: async () => {} } });
  assert.deepEqual(await dispatcher.deliver(finalDelivery), retryable); assert.equal(dispatcher.healthy, false); assert.equal(calls, 0);
  await dispatcher.stop(); assert.doesNotThrow(() => f.journal.begin(finalDelivery));
});

test('receipt COMMIT lock failure never reports delivered and recovered attempt is unknown', async (t) => {
  const f = fixture(t); const blocker = new DatabaseSync(f.path);
  const dispatcher = f.create({ sender: { send: async () => { blocker.exec('BEGIN; SELECT * FROM operations'); return delivered; }, stop: async () => {} } });
  try {
    assert.deepEqual(await dispatcher.deliver(finalDelivery), retryable); assert.equal(dispatcher.healthy, false);
    blocker.exec('ROLLBACK'); assert.equal(operation(f.path).state, 'sending');
    await dispatcher.stop(); f.journal.close();
    const recovered = openDeliveryJournal(f.path, scope);
    try { assert.deepEqual(recovered.begin(finalDelivery), { kind: 'unknown' }); } finally { recovered.close(); }
  } finally { blocker.close(); }
});

for (const interference of ['stale', 'unchanged'] as const) test(`${interference} settlement never fabricates V1 success`, async (t) => {
  const f = fixture(t);
  const dispatcher = f.create({ sender: { send: async () => {
    const row = operation(f.path); const claim = { idempotencyId: row.idempotencyId as string, attemptId: row.attemptId as string };
    f.journal.settle(claim, interference === 'unchanged' ? delivered : { kind: 'unknown' }); return delivered;
  }, stop: async () => {} } });
  assert.deepEqual(await dispatcher.deliver(finalDelivery), retryable); assert.equal(dispatcher.healthy, false);
});

test('stop aborts tracked dispatch, settles uncertainty, drains sender and leaves journal open', async (t) => {
  const f = fixture(t); const entered = deferred<void>(); const drained = deferred<void>(); let stopped = false;
  const sender: ProviderSender = { send: (_route, _message, context) => new Promise((resolve) => {
    context!.signal!.addEventListener('abort', () => resolve({ kind: 'unknown' }), { once: true }); entered.resolve();
  }), stop: async () => { await drained.promise; stopped = true; } };
  const dispatcher = f.create({ sender }); const sending = dispatcher.deliver(finalDelivery); await entered.promise;
  const stopping = dispatcher.stop(); assert.equal(dispatcher.stop(), stopping);
  assert.deepEqual(await sending, nonRetryable); assert.equal(operation(f.path).state, 'unknown'); assert.equal(stopped, false);
  assert.deepEqual(await dispatcher.deliver({ ...finalDelivery, deliveryId: 'new' }), retryable);
  drained.resolve(); await stopping; assert.equal(stopped, true); assert.deepEqual(f.journal.begin(finalDelivery), { kind: 'unknown' });
});

test('real saved ingress route and SDK HTTPS receipt survive dispatcher stop without closing either store', async (t) => {
  const f = fixture(t); const ingressPath = join(f.directory, 'ingress.sqlite');
  const ingressScope = { ...scope, orkaBaseUrl: 'https://orka.invalid/', gatewayNamespace: 'fixture', gatewayName: 'gateway' };
  initializeIngressStore(ingressPath, ingressScope); const ingress = openIngressStore(ingressPath, ingressScope); t.after(() => ingress.close());
  ingress.admit(expectedEvent, route);
  let calls = 0; let body = ''; const tls = await httpsFixture(t, async (req, res) => {
    calls++; const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); body = Buffer.concat(chunks).toString();
    res.end('{"id":"provider-fixture"}');
  });
  const client = new Client({ logger: safeSdkLogger });
  const sender = createProviderSender(async () => randomBytes(24).toString('base64url'), { ca: tls.ca, post: (url, bytes, config) => {
    assert.equal(url, `${route.serviceUrl}v3/conversations/${encodeURIComponent(finalDelivery.contextId)}/activities`);
    return client.post(new URL(new URL(url).pathname.slice(1), tls.baseUrl).href, bytes, config);
  } });
  const options: DispatcherOptions = { journal: f.journal, scope, getRoute: (key) => ingress.getRoute(key), sender,
    serviceUrls: [route.serviceUrl], recipientIds: [route.bot.id] };
  const dispatcher = createDeliveryDispatcher(options); t.after(() => dispatcher.stop());
  options.getRoute = () => undefined; options.sender = { send: async () => ({ kind: 'unknown' }), stop: async () => {} };
  assert.deepEqual(await dispatcher.deliver(finalDelivery), response); assert.equal(body, JSON.stringify(finalMessage));
  assert.deepEqual(await dispatcher.deliver({ ...finalDelivery, deliveryId: 'another-alias' }), response); assert.equal(calls, 1);
  await dispatcher.stop(); assert.deepEqual(ingress.getRoute(finalDelivery.replyTarget), route); assert.deepEqual(f.journal.begin(finalDelivery), delivered);
});

// The parent observes provider acceptance over HTTPS, then kills the owner while
// the receipt is withheld. Reopening uses the actual journal recovery path.
test('SIGKILL after actual provider acceptance and lost receipt reopens unknown with no second POST', { timeout: 10000 }, async (t) => {
  const f = fixture(t); f.journal.close(); const accepted = deferred<void>(); let calls = 0;
  const tls = await httpsFixture(t, async (req, _res) => { for await (const _chunk of req) { /* full request acceptance barrier */ } calls++; accepted.resolve(); });
  const child = fork(new URL('./support/outbound-worker.ts', import.meta.url), [f.path, tls.baseUrl], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  t.after(async () => { child.kill('SIGKILL'); await exit; });
  child.send({ ca: tls.ca.toString('utf8') }); await accepted.promise;
  assert.equal(operation(f.path).state, 'sending'); child.kill('SIGKILL'); await exit;
  const recovered = openDeliveryJournal(f.path, scope); t.after(() => recovered.close());
  const dispatcher = f.create({ journal: recovered, sender: { send: async () => { calls++; return delivered; }, stop: async () => {} } });
  assert.deepEqual(await dispatcher.deliver(finalDelivery), nonRetryable);
  assert.deepEqual(await dispatcher.deliver({ ...finalDelivery, deliveryId: 'post-crash-alias' }), nonRetryable);
  assert.equal(operation(f.path).state, 'unknown'); assert.equal(calls, 1);
});
