import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startIngressRuntime } from '../src/ingress/main.js';
import { ConfigurationError } from '../src/ingress/config.js';
import type { IngressRuntime } from '../src/ingress/main.js';
import { initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import { httpsFixture } from './support/ingress-https.js';
import { activity, authFixture, deferred, post, receiverConfig, scope } from './support/ingress-auth.js';
import { expectedEvent } from './fixtures/incoming.js';
import type { EventEnvelope } from '../src/protocol/types.js';

function storage(t: TestContext, baseUrl: string, ca: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-runtime-')); let owner: IngressRuntime | undefined;
  t.after(async () => { try { await owner?.stop(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const dbPath = join(directory, 'inbox.sqlite'); const caFile = join(directory, 'ca.pem'); writeFileSync(caFile, ca, { mode: 0o600 });
  const config = { scope: { ...scope, orkaBaseUrl: baseUrl }, dbPath, caFile, receiver: receiverConfig, bearerToken: randomUUID(),
    policy: { maxPending: 1000, maxRecords: 100000, replayWindowMs: 86400000 } };
  initializeIngressStore(dbPath, config.scope); return { config, own(runtime: IngressRuntime) { owner = runtime; return runtime; } };
}

test('invalid custom CA bundles fail configuration before binding', async (t) => {
  const auth = await authFixture(t);
  const upstream = await httpsFixture(t, (_req, res) => { res.end(); });
  const certificate = upstream.ca.toString('utf8');
  const truncated = certificate.replace('-----END CERTIFICATE-----', '');
  for (const [name, value] of [
    ['empty', ''], ['whitespace', '\n \t'], ['non-PEM', 'private-ca-content-sentinel'],
    ['malformed certificate', '-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----\n'],
    ['truncated certificate', truncated], ['valid first then garbage', `${certificate}private-trailing-ca-sentinel`],
    ['valid first then malformed', `${certificate}-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n`],
    ['valid first then truncated', `${certificate}${truncated}`],
  ]) await t.test(name!, async (t) => {
    const { config, own } = storage(t, upstream.baseUrl, Buffer.from(value!));
    await assert.rejects(startIngressRuntime(config, auth.dependencies).then(own), (error: unknown) =>
      error instanceof ConfigurationError && error.message === 'Invalid ingress configuration' && error.cause === undefined);
  });
});

test('invalid custom CA is rejected before opening the inbox', async (t) => {
  const auth = await authFixture(t); const upstream = await httpsFixture(t, (_req, res) => { res.end(); });
  const { config } = storage(t, upstream.baseUrl, Buffer.alloc(0));
  const owner = openIngressStore(config.dbPath, config.scope);
  try { await assert.rejects(startIngressRuntime(config, auth.dependencies), ConfigurationError); }
  finally { owner.close(); }
});

test('valid multi-certificate custom CA bundle retains trust in the second certificate for HTTPS relay', { timeout: 10000 }, async (t) => {
  const auth = await authFixture(t); const arrived = deferred<void>(); let requests = 0;
  const unrelated = await httpsFixture(t, (_req, res) => { res.end(); });
  const upstream = await httpsFixture(t, (req, res) => {
    req.resume(); req.on('end', () => {
      requests++; res.writeHead(202); res.end(JSON.stringify({ status: 'accepted', eventId: 'trusted-orka-event', state: 'Queued' })); arrived.resolve();
    });
  });
  const { config, own } = storage(t, upstream.baseUrl, Buffer.concat([unrelated.ca, Buffer.from('\n'), upstream.ca]));
  const runtime = own(await startIngressRuntime(config, auth.dependencies));
  assert.equal((await post(runtime.port, auth.token())).status, 200);
  await arrived.promise;
  assert.equal(requests, 1);
});

test('verified HTTP -> durable inbox -> native HTTPS Orka202; restart and concurrent replays never relay again', async (t) => {
  const auth = await authFixture(t); const events: EventEnvelope[] = []; const arrived = deferred<void>();
  const upstream = await httpsFixture(t, (req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
      events.push(JSON.parse(body)); res.writeHead(202); res.end(JSON.stringify({ status: 'accepted', eventId: 'orka-event-1', state: 'Queued' })); arrived.resolve();
    });
  });
  const { config, own } = storage(t, upstream.baseUrl, upstream.ca);
  let runtime = own(await startIngressRuntime(config, auth.dependencies));
  assert.equal((await post(runtime.port, auth.token())).status, 200); await arrived.promise;
  // Wait until the receipt transaction finishes rather than treating upstream arrival as persistence.
  await sleep(150); await runtime.stop();
  runtime = own(await startIngressRuntime(config, auth.dependencies));
  const body = activity(); body.from.name = 'Changed after restart';
  const responses = await Promise.all(Array.from({ length: 8 }, () => post(runtime.port, auth.token(), body)));
  assert.ok(responses.every((response) => response.status === 200)); await sleep(200);
  assert.equal(events.length, 1); assert.deepEqual({ ...events[0], replyTarget: expectedEvent.replyTarget }, expectedEvent);
});

test('network-loss cancellation drains before close; restart sends byte-identical original event with original reply key', async (t) => {
  const auth = await authFixture(t); const original = deferred<void>(); const retried = deferred<void>(); const bodies: string[] = [];
  const upstream = await httpsFixture(t, (req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
      bodies.push(body);
      if (bodies.length === 1) { original.resolve(); return; }
      res.writeHead(202); res.end(JSON.stringify({ status: 'duplicate', eventId: 'orka-event-1', state: 'Queued' })); retried.resolve();
    });
  });
  const { config, own } = storage(t, upstream.baseUrl, upstream.ca);
  let runtime = own(await startIngressRuntime(config, auth.dependencies));
  assert.equal((await post(runtime.port, auth.token())).status, 200); await original.promise; await runtime.stop();
  // Opening here proves shutdown released ownership only after relay settlement.
  const store = openIngressStore(config.dbPath, config.scope); assert.equal(store.claim(), undefined); store.close();
  runtime = own(await startIngressRuntime(config, auth.dependencies));
  const body = activity(); body.from.name = 'Replacement label'; assert.equal((await post(runtime.port, auth.token(), body)).status, 200);
  await retried.promise; assert.equal(bodies.length, 2); assert.equal(bodies[1], bodies[0]);
});

test('serial runtime preserves Retry-After through stop/restart instead of using shorter polling or backoff', async (t) => {
  const auth = await authFixture(t); const arrived = deferred<void>(); const retried = deferred<void>(); let requests = 0;
  const upstream = await httpsFixture(t, (req, res) => {
    req.resume(); req.on('end', () => {
      requests++;
      if (requests === 1) { res.writeHead(503, { 'Retry-After': '3' }); res.end(); arrived.resolve(); }
      else { res.writeHead(202); res.end(JSON.stringify({ status: 'accepted', eventId: 'orka-1', state: 'Queued' })); retried.resolve(); }
    });
  });
  const { config, own } = storage(t, upstream.baseUrl, upstream.ca);
  let runtime = own(await startIngressRuntime(config, auth.dependencies));
  assert.equal((await post(runtime.port, auth.token())).status, 200); await arrived.promise; await sleep(100); await runtime.stop();
  runtime = own(await startIngressRuntime(config, auth.dependencies));
  await sleep(1400); assert.equal(requests, 1); await retried.promise; assert.equal(requests, 2);
});

test('fatal store failure stops listener/relay, rejects done and releases ownership only after drain', async (t) => {
  const auth = await authFixture(t); let requests = 0;
  const upstream = await httpsFixture(t, (_req, res) => { requests++; res.end(); });
  const { config } = storage(t, upstream.baseUrl, upstream.ca);
  const runtime = await startIngressRuntime(config, auth.dependencies);
  // Simulate an external storage-permission fault without opening/closing an owned DB descriptor.
  chmodSync(config.dbPath, 0o644);
  await assert.rejects(runtime.done, { message: 'Ingress storage failed' });
  await assert.rejects(runtime.stop(), { message: 'Ingress storage failed' });
  assert.equal(requests, 0);
  chmodSync(config.dbPath, 0o600);
  const reopened = openIngressStore(config.dbPath, config.scope); reopened.close();
});

test('runtime persists no original request extras, JWTs or configured credentials', async (t) => {
  const auth = await authFixture(t); const arrived = deferred<void>();
  const upstream = await httpsFixture(t, (req, _res) => { req.resume(); req.on('end', () => arrived.resolve()); });
  const { config, own } = storage(t, upstream.baseUrl, upstream.ca);
  const runtime = own(await startIngressRuntime(config, auth.dependencies));
  const body = activity(); const rawOnly = randomUUID(); body.unused = { rawOnly };
  const token = auth.token(); assert.equal((await post(runtime.port, token, body)).status, 200);
  await arrived.promise; await runtime.stop();
  // Only after all owned connections close: ordinary file reads would release POSIX locks.
  const stored = readFileSync(config.dbPath);
  for (const value of [rawOnly, token, config.bearerToken, config.receiver.clientSecret]) assert.ok(!stored.includes(value));
});

test('wrong HTTP auth/tenant/recipient/raw channel produce neither persisted event nor Orka attempt', async (t) => {
  const auth = await authFixture(t); let requests = 0;
  const upstream = await httpsFixture(t, (_req, res) => { requests++; res.writeHead(500); res.end(); });
  const { config, own } = storage(t, upstream.baseUrl, upstream.ca);
  const runtime = own(await startIngressRuntime(config, auth.dependencies));
  assert.equal((await post(runtime.port, 'invalid')).status, 401);
  const tenant = activity(); tenant.channelData.tenant.id = 'wrong';
  const recipient = activity(); recipient.recipient.id = 'wrong';
  const channel = activity(); delete channel.channelId;
  for (const body of [tenant, recipient, channel]) assert.equal((await post(runtime.port, auth.token(), body)).status, 403);
  await sleep(200); await runtime.stop(); assert.equal(requests, 0);
  const reopened = openIngressStore(config.dbPath, config.scope); assert.equal(reopened.claim(), undefined); reopened.close();
});
