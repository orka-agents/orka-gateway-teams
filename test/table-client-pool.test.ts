import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import https from 'node:https';
import type { ClientRequest, RequestListener } from 'node:http';
import type { Socket } from 'node:net';
import { after, test } from 'node:test';
import { OwnedTableClient } from '../src/storage/table/client.js';
import { bindTable } from '../src/storage/table/codec.js';
import { createTableKernelV2 } from '../src/storage/table/owner.js';
import { TableError } from '../src/storage/table/types.js';
import type { FixtureHooks } from './support/ingress-https.js';
import { context, deferred, eventually, stamp, syntheticToken, tableBinding, tableService, wireM } from './support/table-service.js';

let tlsMaterial: { key: Buffer; ca: Buffer } | undefined;
after(() => { tlsMaterial?.key.fill(0); tlsMaterial?.ca.fill(0); tlsMaterial = undefined; });
async function memoryTlsFixture(t: FixtureHooks, listener: RequestListener) {
  if (!tlsMaterial) {
    let key: Buffer | undefined;
    let generated: ReturnType<typeof spawnSync> | undefined;
    try {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      key = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      // OpenSSL can reopen the anonymous OS pipe, unlike Node's stdio socket.
      generated = spawnSync('bash', ['-o', 'pipefail', '-c',
        'openssl pkey | openssl req -x509 -key /dev/stdin -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 -addext basicConstraints=critical,CA:TRUE'],
      { input: key, maxBuffer: 16384, timeout: 30000 });
      if (generated.status !== 0 || !Buffer.isBuffer(generated.stdout)) throw new Error();
      const certificate = new X509Certificate(generated.stdout);
      if (!certificate.ca || certificate.checkHost('localhost') !== 'localhost' || certificate.checkIP('127.0.0.1') !== '127.0.0.1' ||
          !certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(pair.publicKey.export({ type: 'spki', format: 'der' }))) throw new Error();
      tlsMaterial = { key, ca: Buffer.from(generated.stdout) };
    } catch { throw new Error('RAM-only TLS fixture generation failed'); }
    finally {
      if (Buffer.isBuffer(generated?.stdout)) generated.stdout.fill(0);
      if (Buffer.isBuffer(generated?.stderr)) generated.stderr.fill(0);
      if (!tlsMaterial) key?.fill(0);
    }
  }
  const { key, ca } = tlsMaterial;
  const server = https.createServer({ key, cert: ca }, listener);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing RAM-only TLS listener');
  return { ca: Buffer.from(ca), baseUrl: `https://localhost:${address.port}/`, server };
}
function service(t: FixtureHooks, format: 1 | 2 = 1) {
  return tableService(t, 'delivery', format, undefined, memoryTlsFixture);
}
function tableCode(code: 'unavailable' | 'unresolved') {
  return (error: unknown) => error instanceof TableError && error.code === code && !('cause' in error);
}
async function turn() { await new Promise<void>(resolve => setImmediate(resolve)); }
function observeNative(s: Awaited<ReturnType<typeof service>>) {
  const requests: { req: ClientRequest; socket?: Socket; closed: boolean }[] = [];
  const sockets = new Set<Socket>();
  const closedSockets = new Set<Socket>();
  let agent: https.Agent | undefined;
  s.controls.request = ((...args: Parameters<typeof https.request>) => {
    const options = args[1] as https.RequestOptions;
    if (options.agent instanceof https.Agent) agent = options.agent;
    const req = s.request(...args);
    const entry: (typeof requests)[number] = { req, closed: false };
    requests.push(entry);
    req.once('close', () => { entry.closed = true; });
    req.once('socket', socket => {
      entry.socket = socket;
      if (!sockets.has(socket)) { sockets.add(socket); socket.once('close', () => closedSockets.add(socket)); }
    });
    return req;
  }) as typeof https.request;
  return { requests, sockets, closedSockets, agent: () => agent,
    queued: () => Object.values(agent?.requests ?? {}).reduce((sum, queue) => sum + (queue?.length ?? 0), 0) };
}

test('Table client reuses one SDK pipeline and physical TLS socket across 130 requests, then closes all resources', async t => {
  const s = await service(t); s.rows.set('M', stamp(wireM(), 1));
  const native = observeNative(s);
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies); t.after(() => c.close());
  assert.equal((await c.read('M', context()))?.row, 'M');
  const cached = (c as unknown as { cachedSdk?: { pipeline: unknown } }).cachedSdk;
  for (let i = 1; i < 130; i++) assert.equal((await c.read('M', context()))?.row, 'M');
  assert.equal(native.sockets.size, 1); assert.equal(native.requests.length, 130); assert.equal(native.closedSockets.size, 0);
  assert.ok(cached); assert.equal((c as unknown as { cachedSdk?: unknown }).cachedSdk === cached, true);
  assert.equal((c as unknown as { cachedSdk?: { pipeline: unknown } }).cachedSdk?.pipeline === cached.pipeline, true);
  await c.close(); assert.equal(native.closedSockets.size, 1); assert.equal(s.stats.requestCloses, 130);
});
test('Table client overlapping consumers and iterators retain their own context', async t => {
  const s = await service(t); s.rows.set('M', stamp(wireM(), 1)); const gate = deferred(); let first = true;
  s.controls.hook = async e => { if (first) { first = false; await gate.promise; } e.reply(); };
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies); t.after(() => c.close());
  const present = c.read('M', context()); await eventually(() => s.stats.requests === 1);
  try {
    assert.equal(await c.read('delivery_YWJzZW50', context()), undefined);
    const page = await c.page(context()); assert.equal(page.records[0]?.row, 'M');
  } finally { gate.resolve(); }
  assert.equal((await present)?.row, 'M'); await c.close();
});

test('Table client invalidation revokes a held mutation WRITE token and close awaits its actual return', async t => {
  const s = await service(t, 2); const native = observeNative(s);
  const gate = deferred<string>(); const entered = deferred<AbortSignal>();
  let holdNextToken = false; let returned = 0; let operationDone = false; let closeDone = false;
  const k = createTableKernelV2(tableBinding, { ...s.dependencies, token: async (...args) => {
    if (holdNextToken) {
      holdNextToken = false; entered.resolve(args[1].signal);
      const token = await gate.promise; returned++; return token;
    }
    return s.dependencies.token(...args);
  } });
  await k.initialize(); await k.acquire(); await k.scan();
  const before = structuredClone(s.rows.get('M')); const writes = s.stats.writes;
  const rejected = assert.rejects(k.mutate({ input: Buffer.alloc(0), keys: [] }, () => {
    holdNextToken = true;
    return { state: Buffer.from('state'), result: Buffer.from('result'),
      actions: [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload: Buffer.from('payload') }] };
  }), tableCode('unresolved')).then(() => { operationDone = true; });
  const heldSignal = await entered.promise;
  k.invalidate();
  const close = assert.rejects(k.close(), tableCode('unresolved')).then(() => { closeDone = true; });
  try {
    assert.equal(heldSignal.aborted, true);
    await turn();
    assert.equal(returned, 0); assert.equal(operationDone, false); assert.equal(closeDone, false);
    assert.equal(k.status().pending, 1); assert.equal(s.stats.writes, writes);
  } finally { gate.resolve(syntheticToken); }
  await rejected; await close;
  assert.equal(returned, 1); assert.equal(k.status().pending, 0); assert.equal(k.status().lifecycle, 'closed');
  assert.equal(s.stats.writes, writes); assert.deepEqual(s.rows.get('M'), before); assert.equal(s.rows.has('delivery_aXRlbQ'), false);
  assert.equal(native.requests.every(entry => entry.closed), true); assert.equal(native.closedSockets.size, native.sockets.size);
});

test('Table client queued WRITE abort submits no POST and leaves both busy requests intact', async t => {
  const s = await service(t, 2);
  const initializer = createTableKernelV2(tableBinding, s.dependencies); await initializer.initialize(); await initializer.close();
  const c = new OwnedTableClient<2>(bindTable(tableBinding), s.dependencies, 2); t.after(() => c.close());
  const metadata = await c.read('M', context()); assert.ok(metadata?.value.kind === 'metadata');
  const native = observeNative(s); const writes = s.stats.writes;
  const events: Parameters<NonNullable<typeof s.controls.hook>>[0][] = [];
  s.controls.hook = e => { events.push(e); };
  const first = c.read('M', context()); const second = c.read('delivery_YWJzZW50', context());
  await eventually(() => events.length === 2);
  const abort = new AbortController(); let rejected: Promise<void> | undefined;
  try {
    assert.equal(native.sockets.size, 2);
    assert.ok(native.requests[0]?.socket); assert.ok(native.requests[1]?.socket);
    assert.equal(native.requests[0].socket !== native.requests[1].socket, true);
    assert.equal(native.agent()?.maxSockets, 2);
    rejected = assert.rejects(c.write(metadata.value, metadata.etag,
      [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload: Buffer.from('payload') }],
      { signal: abort.signal, deadline: performance.now() + 30000 }), tableCode('unavailable'));
    await eventually(() => native.requests.length === 3 && native.queued() === 1);
    assert.equal(native.requests[2]!.req.method, 'POST'); assert.equal(native.requests[2]!.socket, undefined);
    abort.abort(); await turn();
    assert.equal(native.requests[2]!.socket, undefined); assert.equal(s.stats.writes, writes); assert.equal(events.length, 2);
    assert.equal(native.requests[0]!.socket!.destroyed, false); assert.equal(native.requests[1]!.socket!.destroyed, false);
  } finally { abort.abort(); delete s.controls.hook; for (const event of events) event.reply(); await Promise.all([first, second, rejected]); }
  assert.equal((await first)?.row, 'M'); assert.equal(await second, undefined);
  await eventually(() => native.queued() === 0);
  assert.equal(s.stats.writes, writes); assert.equal(s.rows.has('delivery_aXRlbQ'), false);
  await c.close(); assert.equal(native.requests.every(entry => entry.closed), true);
  assert.equal(native.closedSockets.size, native.sockets.size);
});

test('Table client abort closes only the tainted active socket while its concurrent peer succeeds', async t => {
  const s = await service(t); s.rows.set('M', stamp(wireM(), 1)); const native = observeNative(s);
  const events: Parameters<NonNullable<typeof s.controls.hook>>[0][] = [];
  s.controls.hook = e => { events.push(e); };
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies); t.after(() => c.close()); const abort = new AbortController();
  const rejected = assert.rejects(c.read('M', { signal: abort.signal, deadline: performance.now() + 30000 }), tableCode('unavailable'));
  const peer = c.read('delivery_YWJzZW50', context());
  await eventually(() => events.length === 2);
  const tainted = native.requests[0]!.socket; const survivor = native.requests[1]!.socket;
  assert.ok(tainted); assert.ok(survivor); assert.equal(tainted !== survivor, true);
  try {
    abort.abort(); await rejected;
    assert.equal(native.closedSockets.has(tainted), true); assert.equal(tainted.destroyed, true);
    assert.equal(survivor.destroyed, false); assert.equal(native.closedSockets.has(survivor), false);
  } finally { abort.abort(); events.find(event => event.path.includes("RowKey='delivery_YWJzZW50'"))!.reply(); }
  assert.equal(await peer, undefined); delete s.controls.hook;
  assert.equal((await c.read('M', context()))?.row, 'M');
  assert.equal(native.requests[2]!.socket !== tainted, true); assert.equal(native.requests[2]!.socket === survivor, true);
  assert.equal(native.sockets.size, 2);
  await c.close(); assert.equal(native.requests.every(entry => entry.closed), true); assert.equal(native.closedSockets.size, 2);
});

test('Table client close waits for the actual idle socket close, not merely Agent.destroy', async t => {
  const s = await service(t); s.rows.set('M', stamp(wireM(), 1)); const native = observeNative(s);
  const c = new OwnedTableClient(bindTable(tableBinding), s.dependencies); t.after(() => c.close());
  assert.equal((await c.read('M', context()))?.row, 'M'); assert.ok(native.agent());
  await eventually(() => Object.values(native.agent()!.freeSockets).some(sockets => sockets?.includes(native.requests[0]!.socket!)));
  const socket = native.requests[0]!.socket!; const destroy = socket.destroy.bind(socket);
  const destruction = deferred(); let destroyCalls = 0; let done = false;
  // Hold this one real instance; release invokes its original bound destroy and lets Node emit close.
  socket.destroy = () => { destroyCalls++; destruction.resolve(); return socket; };
  const close = c.close().then(() => { done = true; });
  try {
    await destruction.promise; await turn();
    assert.ok(destroyCalls > 0); assert.equal(done, false); assert.equal(socket.destroyed, false);
    assert.equal(native.closedSockets.size, 0); assert.equal(native.requests[0]!.closed, true);
  } finally { socket.destroy = destroy; destroy(); }
  await close;
  assert.equal(done, true); assert.equal(socket.destroyed, true); assert.equal(native.closedSockets.has(socket), true);
  assert.equal(native.requests.length, 1); assert.equal(native.sockets.size, 1); assert.equal(native.closedSockets.size, 1);
});
