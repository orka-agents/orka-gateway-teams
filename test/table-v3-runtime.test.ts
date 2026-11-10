import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeTableStore, startIngressRuntime, StartupFailure } from '../src/ingress/main.js';
import type { IngressRuntimeDependencies } from '../src/ingress/main.js';
import { createTableIngressStoreV3 } from '../src/ingress/table-store.js';
import { createTableDeliveryJournalV3 } from '../src/delivery/table-journal.js';
import { runtimeIdentity, runtimeTableService, tableRuntimeConfig } from './support/table-runtime.js';
import { authFixture, post, receiverConfig, scope } from './support/ingress-auth.js';
import { TestClock } from './support/table-v3.js';
import { deferred, eventually } from './support/table-service.js';
import { finalDelivery } from './fixtures/outgoing.js';
import { httpsFixture } from './support/ingress-https.js';
import { NativeAdapter } from '../src/ingress/http-adapter.js';

async function fixture(t: test.TestContext, both = true) {
  const tables = await runtimeTableService(t, scope, 3); const identity = await runtimeIdentity(t);
  const config = tableRuntimeConfig(scope); config.storage.backend = 'table-v3';
  const deps = { tableRequest: tables.request, storageIdentity: { request: identity.request }, managedIdentity: { acaRequest: identity.request } };
  for (const kind of (both ? ['ingress', 'delivery'] : ['ingress']) as ('ingress' | 'delivery')[]) await initializeTableStore({ kind, scope,
    storage: { backend: 'table-v3', account: 'example123', table: 'journal', identity: config.storage.identity, storeId: 'stable' }, ...(kind === 'ingress' ? { audit: config.storage.audit, maxIndexBytes: config.storage.maxIndexBytes } : {}) } as never, { tableRequest: deps.tableRequest, storageIdentity: deps.storageIdentity });
  return { tables, identity, config, deps };
}

test('real runtime SIGKILL before listeners leaves one audited successor on the same Table maps', { timeout: 20000 }, async t => {
  const f = await fixture(t); const directory = mkdtempSync(join(tmpdir(), 'v3-runtime-kill-')); const clockFile = join(directory, 'clock');
  writeFileSync(clockFile, '0'); t.after(() => rmSync(directory, { recursive: true, force: true }));
  function launch() {
    const child = fork(new URL('./support/table-runtime-worker.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const messages: { kind: string; port?: number; outboundPort?: number }[] = []; let ended = false;
    child.on('message', raw => { assert.ok(messages.length < 8); messages.push(raw as typeof messages[number]); });
    const exit = new Promise<void>(resolve => child.once('exit', () => { ended = true; resolve(); }));
    t.after(async () => { if (!ended) { child.kill('SIGCONT'); child.kill('SIGKILL'); } await exit; });
    child.send({ tableUrl: f.tables.fixture.baseUrl, tableCA: f.tables.fixture.ca.toString(), identityUrl: f.identity.baseUrl, clockFile });
    return { child, messages, exit, async next() { await eventually(() => messages.length > 0 || ended); assert.ok(messages.length); return messages.shift()!; } };
  }
  const gate = deferred(); let held = false;
  f.tables.inbox.controls.hook = async e => {
    if (!held && e.req.method === 'GET' && f.tables.inbox.rows.get('M')?.Owner) { held = true; await gate.promise; }
    e.reply();
  };
  const old = launch(); await eventually(() => held); assert.equal(old.messages.length, 0, 'old worker never published listening');
  old.child.kill('SIGSTOP'); await eventually(() => /^State:\s+T/mu.test(readFileSync(`/proc/${old.child.pid}/status`, 'utf8')));
  old.child.kill('SIGKILL'); await old.exit; gate.resolve(); writeFileSync(clockFile, '125001');
  const next = launch(); const ready = await next.next(); assert.equal(ready.kind, 'ready');
  assert.equal((await fetch(`http://127.0.0.1:${ready.outboundPort}/v1/health`, {
    headers: { authorization: `Bearer ${f.config.outbound!.bearerToken}` } })).status, 200);
  next.child.send('close'); assert.equal((await next.next()).kind, 'closed'); await next.exit;
  assert.equal(f.tables.inbox.rows.get('M')?.Owner, ''); assert.equal(f.tables.delivery.rows.get('M')?.Owner, '');
  assert.equal(f.tables.inbox.stats.violation || f.tables.delivery.stats.violation, false);
});

// A V2 factory behind the new selector must fail this persisted-format assertion.
test('explicit V3 initialization writes both V3 domains, never V2', async t => {
  const f = await fixture(t); assert.equal(f.tables.inbox.rows.get('M')?.V, 3); assert.equal(f.tables.delivery.rows.get('M')?.V, 3);
});
for (const domain of ['inbox', 'delivery'] as const) test(`idle ${domain} renewal loss shuts down both directions with no clean-release claim`, { timeout: 10000 }, async t => {
  const f = await fixture(t); const clock = new TestClock(); const auth = await authFixture(t);
  const runtime = await startIngressRuntime(f.config, { ...f.deps, ...auth.dependencies, tableLeaseClock: clock } as IngressRuntimeDependencies);
  t.after(() => runtime.stop().catch(() => {}));
  const old = f.tables[domain].rows.get('M')!.Owner;
  f.tables[domain].controls.hook = e => { if (e.req.method === 'GET') { e.res.writeHead(503); e.res.end(); } else e.reply(); };
  clock.advance(40000); await assert.rejects(runtime.done, { message: 'Ingress storage failed' });
  assert.notEqual(f.tables[domain].rows.get('M')?.Owner, ''); assert.equal(f.tables[domain].rows.get('M')?.Owner, old);
  await assert.rejects(fetch(`http://127.0.0.1:${runtime.port}/healthz`));
  await assert.rejects(fetch(`http://127.0.0.1:${runtime.outboundPort}/healthz`));
});

for (const domain of ['inbox', 'delivery'] as const) test(`runtime ${domain} loss drains a held bot token before closing either store`, { timeout: 10000 }, async t => {
  const token = deferred(); let runtime: Awaited<ReturnType<typeof startIngressRuntime>> | undefined;
  t.after(async () => { token.resolve(); await runtime?.stop().catch(() => {}); });
  const f = await fixture(t); const clock = new TestClock(); const auth = await authFixture(t);
  let saved: { replyTarget: string } | undefined; let waiting = false; let posts = 0;
  const upstream = await httpsFixture(t, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); saved = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(202); res.end('{"status":"accepted","eventId":"held-token-origin","state":"Queued"}');
  });
  const native = https.request;
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: (res: import('node:http').IncomingMessage) => void) =>
    url.hostname === 'orka.example.invalid' ? native(new URL(url.pathname + url.search, upstream.baseUrl), { ...options, ca: upstream.ca, servername: 'localhost' }, callback) : native(url, options, callback));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  f.config.receiver = { ...receiverConfig };
  runtime = await startIngressRuntime(f.config, { ...f.deps, ...auth.dependencies, tableLeaseClock: clock,
    botToken: async () => { waiting = true; await token.promise; return 'synthetic'; },
    providerPost: async () => { posts++; return { status: 201, data: Buffer.from('{"id":"forbidden"}') }; } });
  assert.equal((await post(runtime.port, auth.token())).status, 200); await eventually(() => !!saved);
  const delivering = fetch(`http://127.0.0.1:${runtime.outboundPort}/v1/deliveries`, { method: 'POST', headers: {
    authorization: `Bearer ${f.config.outbound!.bearerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...finalDelivery, originatingEventId: 'held-token-origin', replyTarget: saved!.replyTarget }) }).then(r => r.arrayBuffer(), () => undefined);
  await eventually(() => waiting); let stopped = false; const done = runtime.done.catch(() => { stopped = true; });
  const owners = [f.tables.inbox.rows.get('M')!.Owner, f.tables.delivery.rows.get('M')!.Owner];
  f.tables[domain].controls.hook = e => { if (e.req.method === 'GET') { e.res.writeHead(503); e.res.end(); } else e.reply(); };
  clock.advance(40000);
  // Observe readiness withdrawal while the token is still held.
  const deadline = performance.now() + 5000;
  while (true) {
    const status = await fetch(`http://127.0.0.1:${runtime.outboundPort}/v1/health`, {
      headers: { authorization: `Bearer ${f.config.outbound!.bearerToken}` } }).then(r => r.status, () => 0);
    if (status !== 200) break;
    assert.ok(performance.now() < deadline, 'loss withdraws readiness before token drain');
  }
  assert.equal(stopped, false);
  assert.deepEqual([f.tables.inbox.rows.get('M')!.Owner, f.tables.delivery.rows.get('M')!.Owner], owners);
  token.resolve(); await delivering; await done; assert.equal(posts, 0); assert.equal(stopped, true);
});

test('loss during second-store open prevents both listeners and drains the late open', { timeout: 10000 }, async t => {
  const f = await fixture(t); const clock = new TestClock(); const gate = deferred(); let entered = false; let listens = 0;
  const proto = Object.getPrototypeOf(createTableDeliveryJournalV3({ kind: 'delivery', account: 'example123', table: 'journal', storeId: 'stable', scope: { appId: scope.appId, tenantId: scope.tenantId } }, f.tables.delivery.dependencies));
  const open = proto.open;
  t.mock.method(proto, 'open', async function(this: ReturnType<typeof createTableDeliveryJournalV3>) { entered = true; await gate.promise; return open.call(this); });
  const listen = NativeAdapter.prototype.listen;
  t.mock.method(NativeAdapter.prototype, 'listen', function(this: NativeAdapter, ...args: Parameters<typeof listen>) { listens++; return listen.apply(this, args); });
  const startup = startIngressRuntime(f.config, { ...f.deps, tableLeaseClock: clock } as IngressRuntimeDependencies);
  const failure = assert.rejects(startup, StartupFailure); await eventually(() => entered);
  clock.advance(114000); gate.resolve(); await failure; assert.equal(listens, 0);
  assert.notEqual(f.tables.inbox.rows.get('M')?.Owner, '');
});

test('a late native listener continuation cannot publish readiness after lease loss', { timeout: 10000 }, async t => {
  const f = await fixture(t); const clock = new TestClock(); const gate = deferred(); let entered = false;
  const listen = NativeAdapter.prototype.listen;
  t.mock.method(NativeAdapter.prototype, 'listen', async function(this: NativeAdapter, ...args: Parameters<typeof listen>) {
    await listen.apply(this, args); entered = true; await gate.promise;
  });
  const startup = startIngressRuntime(f.config, { ...f.deps, tableLeaseClock: clock });
  const failure = assert.rejects(startup, StartupFailure); await eventually(() => entered);
  clock.advance(114000); gate.resolve(); await failure;
  assert.notEqual(f.tables.inbox.rows.get('M')?.Owner, ''); assert.notEqual(f.tables.delivery.rows.get('M')?.Owner, '');
});

test('startup cancellation drains a live foreign lease wait without waiting for its expiry', { timeout: 5000 }, async t => {
  let foreign: ReturnType<typeof createTableIngressStoreV3> | undefined;
  t.after(() => foreign?.close());
  const f = await fixture(t); foreign = createTableIngressStoreV3({ kind: 'ingress', account: 'example123', table: 'journal', storeId: 'stable', scope },
    f.tables.inbox.dependencies, { audit: f.config.storage.audit, maxIndexBytes: f.config.storage.maxIndexBytes });
  await foreign.open();
  const abort = new AbortController(); let observed = false;
  f.tables.inbox.controls.hook = e => { if (e.req.method === 'GET') observed = true; e.reply(); };
  const startup = startIngressRuntime(f.config, f.deps, abort.signal);
  const failure = assert.rejects(startup, StartupFailure);
  await eventually(() => observed); abort.abort(); await failure;
});

test('one V3 release commits with lost ACK and unreadable proof: no global clean-stop claim', async t => {
  const f = await fixture(t); const runtime = await startIngressRuntime(f.config, f.deps); let releases = 0;
  f.tables.delivery.controls.hook = e => {
    if (e.actions.some(a => a.entity.Operation === 'release')) { releases++; e.commit(); e.res.destroy(); }
    else if (releases && e.req.method === 'GET') { e.res.writeHead(503); e.res.end(); }
    else e.reply();
  };
  await assert.rejects(runtime.stop(), { message: 'Ingress storage failed' });
  await assert.rejects(runtime.done, { message: 'Ingress storage failed' });
  assert.equal(releases, 1); assert.equal(f.tables.inbox.rows.get('M')?.Owner, '');
  assert.equal(f.tables.delivery.rows.get('M')?.Owner, '', 'the fixture confirms remote commit, not a local success claim');
});

test('missing second V3 domain never serves, closes the healthy first domain', async t => {
  const f = await fixture(t, false);
  await assert.rejects(startIngressRuntime(f.config, f.deps), (e: unknown) => e instanceof StartupFailure && e.reason === 'missing');
  assert.equal(f.tables.inbox.rows.get('M')?.Owner, ''); assert.equal(f.tables.delivery.rows.size, 0);
});
