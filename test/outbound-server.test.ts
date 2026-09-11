import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { createDeliveryDispatcher } from '../src/outbound/dispatcher.js';
import { createProviderSender } from '../src/outbound/sender.js';
import { startOutboundServer } from '../src/outbound/server.js';
import type { DeliveryDispatcher, DeliveryResponse, ProviderSender } from '../src/outbound/types.js';
import { finalDelivery } from './fixtures/outgoing.js';
import { deferred, receiverConfig, scope as ingressScope, serviceUrl } from './support/ingress-auth.js';

const scope = { appId: ingressScope.appId, tenantId: ingressScope.tenantId };
const retryable: DeliveryResponse = { status: 'retryableError', message: 'Delivery is temporarily unavailable.' };
const rejected = { status: 'nonRetryableError', message: 'Delivery cannot be completed safely.' };
async function fixture(t: TestContext, sender?: ProviderSender) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-outbound-api-')); const path = join(directory, 'delivery.sqlite');
  initializeDeliveryJournal(path, scope); const journal = openDeliveryJournal(path, scope); let sends = 0; let ready = true;
  const dispatcher = createDeliveryDispatcher({ journal, scope, getRoute: () => ({ serviceUrl, channelId: 'msteams',
    bot: { id: receiverConfig.recipientIds[0]!, role: 'bot' }, conversation: { id: finalDelivery.contextId, conversationType: 'personal', tenantId: scope.tenantId } }),
    recipientIds: receiverConfig.recipientIds, serviceUrls: receiverConfig.serviceUrls,
    sender: sender ?? { async send() { sends++; return { kind: 'delivered', providerMessageId: 'receipt-api' }; }, async stop() {} } });
  const token = randomUUID(); const server = await startOutboundServer({ host: '127.0.0.1', port: 0, bearerToken: token }, dispatcher, scope, () => ready);
  t.after(async () => { await server.stop(); await dispatcher.stop(); journal.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (body: unknown = finalDelivery, auth = token) => fetch(`http://127.0.0.1:${server.port}/v1/deliveries`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { server, dispatcher, journal, token, call, sends: () => sends, ready: (value: boolean) => { ready = value; } };
}

function raw(port: number, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1'); let result = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('fixture socket deadline')); }, 12000);
    socket.once('connect', () => socket.write(data)); socket.on('data', (chunk) => { result += chunk; });
    socket.once('error', reject); socket.once('close', () => { clearTimeout(timeout); resolve(result); });
  });
}

test('V1 exact authenticated health/capabilities and readiness gate precede claims', async (t) => {
  const f = await fixture(t); const get = (path: string) => fetch(`http://127.0.0.1:${f.server.port}${path}`, { headers: { Authorization: `bEaReR ${f.token}` } });
  assert.deepEqual(await (await get('/v1/health')).json(), { status: 'ok' });
  assert.deepEqual(await (await get('/v1/capabilities')).json(), { protocolVersion: 'orka.gateway.v1', adapterName: 'orka-gateway-teams', adapterVersion: '0.0.0',
    capabilities: { inboundText: true, outboundText: true, threads: false, senderIdentity: true, explicitSessions: false, idempotentDelivery: true } });
  f.ready(false);
  for (const path of ['/v1/health', '/v1/capabilities']) assert.equal((await get(path)).status, 503);
  assert.equal((await f.call()).status, 503); assert.equal(f.sends(), 0);
  f.ready(true); const result = await f.call(); assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: 'delivered', providerMessageId: 'receipt-api' });
  assert.deepEqual(await (await f.call({ ...finalDelivery, deliveryId: 'new-alias' })).json(), { status: 'delivered', providerMessageId: 'receipt-api' });
  assert.equal(f.sends(), 1);
  for (const path of ['/api/messages', '/v1/health/', '/v1/health?x=1', '/v1/deliveries', '/conformance']) assert.equal((await get(path)).status, 404);
});

test('bearer authentication precedes body/readiness; duplicates and malformed/crossed tokens never claim', async (t) => {
  const f = await fixture(t); f.ready(false);
  for (const authorization of ['', 'Bearer', 'Basic invalid', `Bearer ${f.token.toUpperCase()}`, `Bearer ${randomUUID()}`, `Bearer ${f.token},junk`, `Bearer  ${f.token}`]) {
    for (const path of ['/v1/health', '/v1/capabilities', '/v1/deliveries']) {
      const response = await raw(f.server.port, `POST ${path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${authorization}\r\nContent-Encoding: gzip\r\nContent-Length: 999999\r\n\r\n`);
      assert.ok(response.startsWith('HTTP/1.1 401')); assert.ok(!response.includes(f.token));
    }
  }
  const duplicate = await raw(f.server.port, `POST /v1/deliveries HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.token}\r\nAuthorization: Bearer ${f.token}\r\nContent-Length: 999\r\n\r\n`);
  assert.ok(duplicate.startsWith('HTTP/1.1 401')); assert.equal(f.sends(), 0);
});

test('unauthenticated requests cannot consult dispatcher state even during response cleanup', async (t) => {
  let reads = 0;
  const dispatcher: DeliveryDispatcher = { get healthy() { reads++; return false; }, async deliver() { throw new Error('must not call'); }, async stop() {} };
  const server = await startOutboundServer({ host: '127.0.0.1', port: 0, bearerToken: randomUUID() }, dispatcher, scope,
    () => { throw new Error('must not consult readiness'); }); t.after(() => server.stop());
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/health`); assert.equal(response.status, 401);
  await response.text(); assert.equal(reads, 0);
});

test('strict bounded JSON decoder and header limits return only fixed safe V1 errors', async (t) => {
  const f = await fixture(t);
  for (const [body, headers, status] of [
    ['{"private-sentinel', {}, 400], [JSON.stringify({ ...finalDelivery, text: '' }), {}, 400],
    [JSON.stringify({ ...finalDelivery, extra: 'private-sentinel' }), {}, 400],
    [new Uint8Array([0xff]), {}, 400], ['{} {}', {}, 400], ['x'.repeat(256 * 1024 + 1), {}, 413],
    ['{}', { 'Content-Encoding': 'gzip' }, 415], ['{}', { 'Content-Type': 'application/json; charset=latin1' }, 415],
  ] as [string | Uint8Array, Record<string, string>, number][]) {
    const response = await fetch(`http://127.0.0.1:${f.server.port}/v1/deliveries`, { method: 'POST',
      headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : new Uint8Array(body) });
    assert.equal(response.status, status); assert.deepEqual(await response.json(), rejected);
  }
  const body = JSON.stringify(finalDelivery); const padded = body + ' '.repeat(256 * 1024 - Buffer.byteLength(body));
  const accepted = await fetch(`http://127.0.0.1:${f.server.port}/v1/deliveries`, { method: 'POST',
    headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: padded });
  assert.equal(accepted.status, 200); assert.equal(f.sends(), 1);
  const chunk = 'x'.repeat(256 * 1024 + 1);
  const oversized = await raw(f.server.port, `POST /v1/deliveries HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.token}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n0\r\n\r\n`);
  assert.ok(oversized.startsWith('HTTP/1.1 413'));
  assert.ok((await raw(f.server.port, `GET /v1/health HTTP/1.1\r\nHost: localhost\r\nX-Pad: ${'x'.repeat(17 * 1024)}\r\n\r\n`)).startsWith('HTTP/1.1 400'));
});

test('32 active deliveries backpressure before claim; no early ACK or duplicate effect', { timeout: 5000 }, async (t) => {
  const entered = deferred<void>(); const receipt = deferred<{ kind: 'delivered'; providerMessageId: string }>(); let sends = 0;
  const f = await fixture(t, { send() { if (++sends === 32) entered.resolve(); return receipt.promise; }, async stop() {} });
  let responses = 0;
  const pending = Array.from({ length: 32 }, (_, i) => f.call({ ...finalDelivery, idempotencyId: `id-${i}`, deliveryId: `alias-${i}` }).then((r) => { responses++; return r; }));
  await entered.promise;
  assert.deepEqual(await (await f.call({ ...finalDelivery, idempotencyId: 'overflow', deliveryId: 'overflow' })).json(), retryable);
  assert.equal((await f.call(finalDelivery, randomUUID())).status, 401); assert.equal(responses, 0); assert.equal(sends, 32);
  receipt.resolve({ kind: 'delivered', providerMessageId: 'receipt-bound' });
  for (const r of await Promise.all(pending)) assert.deepEqual(await r.json(), { status: 'delivered', providerMessageId: 'receipt-bound' });
  assert.deepEqual(await (await f.call({ ...finalDelivery, idempotencyId: 'overflow', deliveryId: 'overflow' })).json(), { status: 'delivered', providerMessageId: 'receipt-bound' });
  assert.equal(sends, 33);
});

test('SQLite poison flushes a fixed response before fatal shutdown tears down the listener', async (t) => {
  const f = await fixture(t); f.journal.close();
  void f.server.failed.catch(() => f.server.stop());
  const response = await f.call(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), retryable);
  await assert.rejects(f.server.failed, { message: 'Outbound storage failed' }); await f.server.stop();
  assert.equal(f.dispatcher.healthy, false); assert.equal(f.sends(), 0);
});

test('throwing readiness and delivery callbacks never expose private errors', async (t) => {
  for (const readiness of [true, false]) {
    const dispatcher: DeliveryDispatcher = { healthy: true, async deliver() { throw new Error('private-delivery'); }, async stop() {} };
    const token = randomUUID(); const server = await startOutboundServer({ host: '127.0.0.1', port: 0, bearerToken: token }, dispatcher, scope,
      () => { if (!readiness) throw new Error('private-ready'); return true; });
    t.after(() => server.stop());
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/deliveries`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(finalDelivery) });
    assert.deepEqual(await response.json(), retryable);
  }
});

test('connection/body budget is absolute; slow body shortens token time and cannot POST late', { timeout: 16000 }, async (t) => {
  const tokenEntered = deferred<void>(); const token = deferred<string>(); let posts = 0;
  const sender = createProviderSender(() => { tokenEntered.resolve(); return token.promise; }, { post: async () => { posts++; return { status: 201, data: Buffer.from('{"id":"late"}') }; } });
  const f = await fixture(t, sender); const body = JSON.stringify(finalDelivery); const start = performance.now();
  const response = new Promise<number | undefined>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: f.server.port, path: '/v1/deliveries', method: 'POST',
      headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNRESET' ? resolve(undefined) : reject(error));
    req.write(body.slice(0, 1)); void sleep(2200).then(() => req.end(body.slice(1)));
  });
  await tokenEntered.promise;
  assert.ok([200, undefined].includes(await response)); assert.ok(performance.now() - start < 10500);
  let stopped = false; const stopping = f.dispatcher.stop().then(() => { stopped = true; });
  await f.server.stop(); assert.equal(stopped, false); token.resolve(randomUUID()); await stopping; assert.equal(posts, 0);
});

test('absolute header and incomplete body connections are closed within ten seconds', { timeout: 14000 }, async (t) => {
  const f = await fixture(t); const start = performance.now();
  const results = await Promise.all([raw(f.server.port, 'GET /v1/health HTTP/1.1\r\nHost:'),
    raw(f.server.port, `POST /v1/deliveries HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.token}\r\nContent-Type: application/json\r\nContent-Length: 99\r\n\r\n{`)]);
  assert.ok(performance.now() - start >= 9500); assert.ok(performance.now() - start < 12000);
  assert.ok(results.every((value) => !value.includes('delivered'))); assert.equal(f.sends(), 0);
});

test('bind failure releases listener resources without stopping the caller-owned dispatcher', async (t) => {
  const occupied = createServer(); await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve()))); const address = occupied.address(); assert.ok(address && typeof address !== 'string');
  let stops = 0; const dispatcher: DeliveryDispatcher = { healthy: true, async deliver() { return retryable; }, async stop() { stops++; } };
  await assert.rejects(startOutboundServer({ host: '127.0.0.1', port: address.port, bearerToken: randomUUID() }, dispatcher, scope, () => true), { message: 'Outbound startup failed' });
  assert.equal(stops, 0);
});
