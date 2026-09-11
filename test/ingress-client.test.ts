import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as createTCPServer } from 'node:net';
import type { Socket } from 'node:net';
import test from 'node:test';
import { createOrkaClient } from '../src/ingress/client.js';
import { expectedEvent } from './fixtures/incoming.js';
import { httpsFixture } from './support/ingress-https.js';

const scope = { appId: 'app-fixture', tenantId: expectedEvent.accountId, orkaBaseUrl: 'https://orka.example.invalid/', gatewayNamespace: 'default', gatewayName: 'teams' };
const receipt = { status: 'accepted', eventId: 'gev-fixture', state: 'Accepted' } as const;

test('native HTTPS posts exact event bytes to encoded gateway path with separate bearer and trusted CA', async (t) => {
  const bearerToken = randomBytes(32).toString('base64url');
  const requests: { method?: string; path?: string; authenticated: boolean; body: Buffer; contentType?: string }[] = [];
  const { ca, baseUrl } = await httpsFixture(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ method: request.method!, path: request.url!, authenticated: request.headers.authorization === `Bearer ${bearerToken}`, body: Buffer.concat(chunks), contentType: request.headers['content-type']! });
      response.writeHead(202, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ...receipt, message: 'ignored upstream detail' }));
    });
  });
  const client = createOrkaClient({ ...scope, orkaBaseUrl: `${baseUrl}prefix/`, gatewayNamespace: 'space/name', gatewayName: 'teams?#' }, { bearerToken, ca });
  assert.deepEqual(await client.post(expectedEvent), { kind: 'receipt', receipt });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, 'POST'); assert.equal(requests[0]?.path, '/prefix/api/v1/gateways/space%2Fname/teams%3F%23/events');
  assert.equal(requests[0]?.authenticated, true); assert.equal(requests[0]?.contentType, 'application/json');
  assert.deepEqual(requests[0]?.body, Buffer.from(JSON.stringify(expectedEvent)));
});

test('only a valid 202 is durable proof; conflicts, invalid events and redirects block without following', async (t) => {
  let status = 202; let body: string | Buffer = JSON.stringify(receipt); let hits = 0;
  const { ca, baseUrl } = await httpsFixture(t, (_request, response) => {
    hits++; response.writeHead(status, { 'content-type': 'application/json', location: '/redirected' }); response.end(body);
  });
  const client = createOrkaClient({ ...scope, orkaBaseUrl: baseUrl }, { bearerToken: randomBytes(32).toString('hex'), ca });
  for (const [accepted, state] of [['accepted', 'Queued'], ['duplicate', 'Completed'], ['rejected', 'Rejected'], ['deadLettered', 'DeadLettered']]) {
    body = JSON.stringify({ ...receipt, status: accepted, state });
    assert.deepEqual(await client.post(expectedEvent), { kind: 'receipt', receipt: { ...receipt, status: accepted, state } });
  }
  const cases = [
    [409, 'conflict'], [400, 'invalid-event'], [413, 'invalid-event'], [415, 'invalid-event'],
    [301, 'redirect'], [302, 'redirect'], [307, 'redirect'], [308, 'redirect'],
    [200, undefined], [401, undefined], [403, undefined], [404, undefined], [429, undefined], [500, undefined], [503, undefined],
  ] as const;
  for (const [code, reason] of cases) {
    status = code; const before = hits;
    assert.deepEqual(await client.post(expectedEvent), reason ? { kind: 'blocked', reason } : { kind: 'retry' });
    assert.equal(hits, before + 1);
  }
  status = 202;
  for (const [contradictory, state] of [['accepted', 'Rejected'], ['accepted', 'Completed'], ['rejected', 'Queued'], ['deadLettered', 'Accepted']]) {
    body = JSON.stringify({ ...receipt, status: contradictory, state });
    assert.deepEqual(await client.post(expectedEvent), { kind: 'retry' });
  }
  for (const invalid of ['{}', 'null', '[]', '{', JSON.stringify({ ...receipt, status: 'ok' }), JSON.stringify({ ...receipt, eventId: '' }), JSON.stringify({ ...receipt, state: 'unknown' }), Buffer.from([0xff])]) {
    body = invalid; assert.deepEqual(await client.post(expectedEvent), { kind: 'retry' });
  }
});

test('429/503 Retry-After delta/date honors long hints and saturates rather than scheduling early', async (t) => {
  let hint = '120'; let status = 429;
  const { ca, baseUrl } = await httpsFixture(t, (_request, response) => { response.writeHead(status, { 'retry-after': hint }); response.end(); });
  const client = createOrkaClient({ ...scope, orkaBaseUrl: baseUrl }, { bearerToken: randomBytes(32).toString('hex'), ca });
  assert.deepEqual(await client.post(expectedEvent), { kind: 'retry', retryAfterMs: 120000 });
  status = 503; hint = '99999999999999999999999999999999999';
  assert.deepEqual(await client.post(expectedEvent), { kind: 'retry', retryAfterMs: Number.MAX_SAFE_INTEGER });
  hint = new Date(Date.now() + 180000).toUTCString(); const before = Date.now();
  const result = await client.post(expectedEvent); const after = Date.now();
  assert.equal(result.kind, 'retry'); if (result.kind !== 'retry') throw new Error('expected retry');
  assert.ok(result.retryAfterMs! >= Date.parse(hint) - after); assert.ok(result.retryAfterMs! <= Date.parse(hint) - before);
  for (const invalid of ['-1', '1.5', 'not a date']) { hint = invalid; assert.deepEqual(await client.post(expectedEvent), { kind: 'retry' }); }
});

test('TLS trust and hostname verification remain enabled; no requests reach untrusted endpoints', async (t) => {
  let hits = 0;
  const { ca, baseUrl } = await httpsFixture(t, (_request, response) => { hits++; response.writeHead(202); response.end(JSON.stringify(receipt)); });
  const bearerToken = randomBytes(32).toString('hex');
  assert.deepEqual(await createOrkaClient({ ...scope, orkaBaseUrl: baseUrl }, { bearerToken }).post(expectedEvent), { kind: 'retry' });
  assert.deepEqual(await createOrkaClient({ ...scope, orkaBaseUrl: baseUrl.replace('localhost', '127.0.0.1') }, { bearerToken, ca }).post(expectedEvent), { kind: 'retry' });
  assert.equal(hits, 0);
});

test('response byte bound, truncated responses, timeout and cancellation never manufacture receipts or internal retries', async (t) => {
  let mode = 'oversize'; let hits = 0; let notify: (() => void) | undefined;
  const { ca, baseUrl } = await httpsFixture(t, (_request, response) => {
    hits++; notify?.();
    if (mode === 'oversize') { response.writeHead(202); response.end(JSON.stringify({ ...receipt, message: 'x'.repeat(65536) })); }
    else if (mode === 'truncated') { response.writeHead(202, { 'content-length': '1000' }); response.end(JSON.stringify(receipt)); }
    else if (mode === 'reset') response.destroy();
  });
  const client = createOrkaClient({ ...scope, orkaBaseUrl: baseUrl }, { bearerToken: randomBytes(32).toString('hex'), ca, timeoutMs: 100 });
  for (mode of ['oversize', 'truncated', 'reset', 'hang']) {
    const before = hits; assert.deepEqual(await client.post(expectedEvent), { kind: 'retry' }); assert.equal(hits, before + 1);
  }
  const abort = new AbortController(); const arrived = new Promise<void>((resolve) => { notify = resolve; });
  const posting = client.post(expectedEvent, abort.signal); await arrived; abort.abort(); assert.deepEqual(await posting, { kind: 'retry' });
  const before = hits; assert.deepEqual(await client.post(expectedEvent, abort.signal), { kind: 'retry' }); assert.equal(hits, before);
});

test('whole-request deadline stops continuously dripping response bytes rather than resetting on activity', { timeout: 5000 }, async (t) => {
  let hits = 0; let finished: (() => void) | undefined;
  const { ca, baseUrl } = await httpsFixture(t, (_request, response) => {
    hits++; response.writeHead(202); response.write('{');
    const interval = setInterval(() => response.write(' '), 10);
    response.once('close', () => { clearInterval(interval); finished?.(); });
  });
  const client = createOrkaClient({ ...scope, orkaBaseUrl: baseUrl }, { bearerToken: randomBytes(32).toString('hex'), ca, timeoutMs: 150 });
  const closed = new Promise<void>((resolve) => { finished = resolve; });
  const start = performance.now(); assert.deepEqual(await client.post(expectedEvent), { kind: 'retry' });
  assert.ok(performance.now() - start < 1500); assert.equal(hits, 1); await closed;
});

test('default five-second absolute deadline includes a stalled TLS handshake', { timeout: 10000 }, async (t) => {
  const sockets = new Set<Socket>();
  const server = createTCPServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = createOrkaClient({ ...scope, orkaBaseUrl: `https://localhost:${address.port}/` }, { bearerToken: randomBytes(32).toString('hex') });
  const start = performance.now(); assert.deepEqual(await client.post(expectedEvent), { kind: 'retry' });
  const elapsed = performance.now() - start; assert.ok(elapsed >= 4500 && elapsed < 8500);
});

test('the 64 KiB response limit is byte-exact, including multibyte optional message content', async (t) => {
  let body = JSON.stringify(receipt); const prefixBytes = Buffer.byteLength(JSON.stringify({ ...receipt, message: '' }));
  const { ca, baseUrl } = await httpsFixture(t, (_request, response) => { response.writeHead(202); response.end(body); });
  const client = createOrkaClient({ ...scope, orkaBaseUrl: baseUrl }, { bearerToken: randomBytes(32).toString('hex'), ca });
  body = JSON.stringify({ ...receipt, message: 'é' + 'x'.repeat(65536 - prefixBytes - 2) });
  assert.equal(Buffer.byteLength(body), 65536); assert.deepEqual(await client.post(expectedEvent), { kind: 'receipt', receipt });
  body += ' '; assert.deepEqual(await client.post(expectedEvent), { kind: 'retry' });
});

test('client rejects insecure targets, unsafe headers/timeouts and oversized or raw events before I/O', async (t) => {
  let hits = 0; const { ca, baseUrl } = await httpsFixture(t, (_request, response) => { hits++; response.end(); });
  const bearerToken = randomBytes(32).toString('hex');
  for (const orkaBaseUrl of ['http://localhost/', 'https://user@localhost/', 'https://localhost/?x=1', 'https://localhost/#x']) {
    assert.throws(() => createOrkaClient({ ...scope, orkaBaseUrl }, { bearerToken }));
  }
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2147483648]) assert.throws(() => createOrkaClient(scope, { bearerToken, timeoutMs }));
  assert.throws(() => createOrkaClient(scope, { bearerToken: 'invalid\r\nheader' }));
  const client = createOrkaClient({ ...scope, orkaBaseUrl: baseUrl }, { bearerToken, ca });
  assert.deepEqual(await client.post({ ...expectedEvent, text: 'x'.repeat(262145) }), { kind: 'blocked', reason: 'invalid-event' });
  assert.equal(hits, 0);
});
