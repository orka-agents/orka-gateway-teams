import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOrkaClient } from '../src/ingress/client.js';
import { relayOne } from '../src/ingress/relay.js';
import { initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import type { ReplyRoute } from '../src/ingress/types.js';
import { expectedEvent } from './fixtures/incoming.js';
import { httpsFixture } from './support/ingress-https.js';

const scope = { appId: 'app-fixture', tenantId: expectedEvent.accountId, orkaBaseUrl: 'https://orka.example.invalid/', gatewayNamespace: 'default', gatewayName: 'teams' };
const route: ReplyRoute = { serviceUrl: 'https://teams-service.example.invalid/', channelId: 'msteams', bot: { id: '28:fixture-app', role: 'bot' }, conversation: { id: expectedEvent.contextId, conversationType: 'personal', tenantId: scope.tenantId } };
const receipt = { status: 'accepted', eventId: 'gev-fixture', state: 'Queued' };
function fixture(t: test.TestContext, orkaBaseUrl: string, replayWindowMs = 86400000) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-relay-')); const path = join(directory, 'inbox.sqlite');
  const target = { ...scope, orkaBaseUrl }; let now = 1000;
  initializeIngressStore(path, target);
  const options = { now: () => now, policy: { maxPending: 1000, maxRecords: 100000, replayWindowMs } };
  const store = openIngressStore(path, target, options);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path, target, options, advance(ms: number) { now += ms; } };
}

test('one relay call sends one claimed event; only validated 202 settles and retained route survives restart', async (t) => {
  const received: Buffer[] = [];
  const { ca, baseUrl } = await httpsFixture(t, (request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => { received.push(Buffer.concat(chunks)); response.writeHead(202); response.end(JSON.stringify(receipt)); });
  });
  const { store, path, target, options } = fixture(t, baseUrl);
  const client = createOrkaClient(target, { bearerToken: randomBytes(32).toString('hex'), ca });
  assert.equal(await relayOne(store, client), false); assert.equal(received.length, 0);
  store.admit(expectedEvent, route); store.admit({ ...expectedEvent, externalEventId: 'second', replyTarget: 'second-route' }, route);
  assert.equal(await relayOne(store, client), true); assert.equal(received.length, 1);
  assert.deepEqual(received[0], Buffer.from(JSON.stringify(expectedEvent)));
  assert.deepEqual(store.getRoute(expectedEvent.replyTarget), route);
  store.close();
  const reopened = openIngressStore(path, target, options);
  try { assert.equal(await relayOne(reopened, client), true); assert.equal(await relayOne(reopened, client), false); assert.equal(received.length, 2); }
  finally { reopened.close(); }
});

test('ambiguous responses retry byte-identical envelope with exponential delay capped at 60 seconds', async (t) => {
  let status = 500; let responseBody = ''; const bodies: Buffer[] = [];
  const { ca, baseUrl } = await httpsFixture(t, (request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => { bodies.push(Buffer.concat(chunks)); response.writeHead(status); response.end(responseBody); });
  });
  const { store, target, advance } = fixture(t, baseUrl);
  const client = createOrkaClient(target, { bearerToken: randomBytes(32).toString('hex'), ca });
  store.admit(expectedEvent, route);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    assert.equal(await relayOne(store, client), true); advance(delay - 1);
    const count = bodies.length; assert.equal(await relayOne(store, client), false); assert.equal(bodies.length, count); advance(1);
    status = 202; responseBody = JSON.stringify({ ...receipt, state: 'Rejected' });
  }
  responseBody = JSON.stringify({ ...receipt, status: 'duplicate', state: 'Completed' });
  assert.equal(await relayOne(store, client), true); assert.equal(await relayOne(store, client), false);
  assert.equal(bodies.length, 9);
  for (const body of bodies) assert.deepEqual(body, Buffer.from(JSON.stringify(expectedEvent)));
});

test('server retry hint cannot be shortened by backoff cap; captured deadline prevents late sends', async (t) => {
  let hits = 0;
  const { ca, baseUrl } = await httpsFixture(t, (_request, response) => { hits++; response.writeHead(503, { 'retry-after': '120' }); response.end(); });
  const { store, target, advance } = fixture(t, baseUrl, 120000);
  const client = createOrkaClient(target, { bearerToken: randomBytes(32).toString('hex'), ca }); store.admit(expectedEvent, route);
  assert.equal(await relayOne(store, client), true); advance(60000);
  assert.equal(await relayOne(store, client), false); advance(60000);
  assert.equal(await relayOne(store, client), false); assert.equal(hits, 1);
  assert.deepEqual(store.getRoute(expectedEvent.replyTarget), route);
});

for (const status of [409, 400, 413, 415, 302]) {
  test(`HTTP ${status} quarantines without replacing IDs or retrying`, async (t) => {
    let hits = 0;
    const { ca, baseUrl } = await httpsFixture(t, (_request, response) => { hits++; response.writeHead(status, { location: '/other' }); response.end(); });
    const { store, target, advance } = fixture(t, baseUrl);
    const client = createOrkaClient(target, { bearerToken: randomBytes(32).toString('hex'), ca }); store.admit(expectedEvent, route);
    assert.equal(await relayOne(store, client), true); advance(60000); assert.equal(await relayOne(store, client), false);
    assert.equal(hits, 1); assert.deepEqual(store.admit(expectedEvent, route), { kind: 'duplicate', replyTarget: expectedEvent.replyTarget });
  });
}

test('abort before claim does no work; in-flight abort settles a retry and restart sends original IDs', async (t) => {
  let hang = true; let notify: (() => void) | undefined; const events: unknown[] = [];
  const { ca, baseUrl } = await httpsFixture(t, (request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      events.push(JSON.parse(Buffer.concat(chunks).toString())); notify?.();
      if (!hang) { response.writeHead(202); response.end(JSON.stringify(receipt)); }
    });
  });
  const { store, path, target, options, advance } = fixture(t, baseUrl);
  const client = createOrkaClient(target, { bearerToken: randomBytes(32).toString('hex'), ca }); store.admit(expectedEvent, route);
  const already = AbortSignal.abort(); assert.equal(await relayOne(store, client, already), false); assert.equal(events.length, 0);
  const abort = new AbortController(); const arrived = new Promise<void>((resolve) => { notify = resolve; });
  const relaying = relayOne(store, client, abort.signal); await arrived; abort.abort();
  assert.equal(await relaying, true); assert.equal(store.claim(), undefined); store.close();
  hang = false; advance(1000); const reopened = openIngressStore(path, target, options);
  try { assert.equal(await relayOne(reopened, client), true); assert.equal(await relayOne(reopened, client), false); }
  finally { reopened.close(); }
  assert.deepEqual(events, [expectedEvent, expectedEvent]);
});

test('shutdown does not shorten a Retry-After already received from Orka', async (t) => {
  const { ca, baseUrl } = await httpsFixture(t, (_request, response) => { response.writeHead(503, { 'retry-after': '120' }); response.end(); });
  const { store, target, advance } = fixture(t, baseUrl);
  const client = createOrkaClient(target, { bearerToken: randomBytes(32).toString('hex'), ca });
  const abort = new AbortController(); store.admit(expectedEvent, route);
  assert.equal(await relayOne(store, { async post(event, signal) {
    const result = await client.post(event, signal); abort.abort(); return result;
  } }, abort.signal), true);
  advance(1000); assert.equal(store.claim(), undefined);
  advance(118999); assert.equal(store.claim(), undefined);
  advance(1); assert.deepEqual(store.claim()?.event, expectedEvent);
});

for (const outcome of ['receipt', 'retry', 'blocked'] as const) {
  test(`legacy relay returns true after one POST even when ${outcome} settlement is stale`, async (t) => {
    let posts = 0;
    const { ca, baseUrl } = await httpsFixture(t, (request, response) => {
      request.resume(); request.on('end', () => {
        posts++;
        // Persist expiry while the real POST is in flight. Every settlement
        // below must now see a quarantined record, not current forwarding state.
        advance(100); store.claim();
        response.writeHead(outcome === 'receipt' ? 202 : outcome === 'retry' ? 503 : 409);
        response.end(outcome === 'receipt' ? JSON.stringify(receipt) : '');
      });
    });
    const { store, target, advance } = fixture(t, baseUrl, 100);
    const client = createOrkaClient(target, { bearerToken: randomBytes(32).toString('hex'), ca });
    store.admit(expectedEvent, route);
    assert.equal(await relayOne(store, client), true);
    assert.equal(posts, 1);
    assert.equal(store.claim(), undefined);
    assert.deepEqual(store.admit(expectedEvent, route), { kind: 'duplicate', replyTarget: expectedEvent.replyTarget });
    assert.equal(await relayOne(store, client), false); assert.equal(posts, 1);
  });
}

test('a throwing client leaves original event retryable, never a fabricated success', async (t) => {
  const { store, advance } = fixture(t, scope.orkaBaseUrl); store.admit(expectedEvent, route);
  assert.equal(await relayOne(store, { async post() { throw new Error('synthetic transport failure'); } }), true);
  advance(1000); const claim = store.claim(); assert.ok(claim); assert.equal(claim.attempt, 2); assert.deepEqual(claim.event, expectedEvent);
});
