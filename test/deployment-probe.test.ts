import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import test from 'node:test';
import { checkHealth } from '../src/deployment/probe.js';
import { httpsFixture } from './support/ingress-https.js';

const serverName = 'localhost';
function port(baseUrl: string): number { return Number(new URL(baseUrl).port); }

test('probe verifies trusted SAN, exact GET path and outbound bearer before accepting health', async (t) => {
  const bearerToken = randomUUID(); let matched = false;
  const fixture = await httpsFixture(t, (req, res) => {
    matched = req.method === 'GET' && req.url === '/v1/health' && req.headers.authorization === `Bearer ${bearerToken}`;
    res.writeHead(matched ? 200 : 401); res.end('{"status":"ok"}');
  });
  assert.equal(await checkHealth({ ca: fixture.ca, serverName, bearerToken, port: port(fixture.baseUrl) }), true);
  assert.equal(matched, true);
});

test('probe rejects missing, crossed and header-invalid bearer without exposing their values', async (t) => {
  const bearerToken = randomUUID();
  const fixture = await httpsFixture(t, (req, res) => {
    res.writeHead(req.headers.authorization === `Bearer ${bearerToken}` ? 200 : 401); res.end('{"status":"ok"}');
  });
  for (const token of ['', randomUUID(), `${bearerToken}\n`]) {
    assert.equal(await checkHealth({ ca: fixture.ca, serverName, bearerToken: token, port: port(fixture.baseUrl) }), false);
  }
});

test('probe rejects untrusted CA and wrong SAN before sending authorization', async (t) => {
  let calls = 0;
  const fixture = await httpsFixture(t, (_req, res) => { calls++; res.end('{"status":"ok"}'); });
  const other = await httpsFixture(t, (_req, res) => res.end());
  for (const options of [{ ca: other.ca, serverName }, { ca: fixture.ca, serverName: 'wrong.example.invalid' }]) {
    assert.equal(await checkHealth({ ...options, bearerToken: randomUUID(), port: port(fixture.baseUrl) }), false);
  }
  assert.equal(calls, 0);
});

for (const [name, status, body] of [
  ['non-200', 503, '{"status":"ok"}'], ['redirect', 302, '{"status":"ok"}'],
  ['malformed', 200, '{'], ['null', 200, 'null'], ['array', 200, '[]'],
  ['wrong status', 200, '{"status":"starting"}'], ['missing status', 200, '{}'],
  ['over 1024 bytes', 200, '{"status":"ok"}' + ' '.repeat(1010)],
] as const) test(`probe rejects ${name} response`, async (t) => {
  const fixture = await httpsFixture(t, (_req, res) => { res.writeHead(status); res.end(body); });
  assert.equal(await checkHealth({ ca: fixture.ca, serverName, bearerToken: randomUUID(), port: port(fixture.baseUrl) }), false);
});

test('probe accepts the inclusive 1024-byte limit', async (t) => {
  const fixture = await httpsFixture(t, (_req, res) => res.end('{"status":"ok"}' + ' '.repeat(1009)));
  assert.equal(await checkHealth({ ca: fixture.ca, serverName, bearerToken: randomUUID(), port: port(fixture.baseUrl) }), true);
});

for (const drip of [false, true]) test(`probe enforces absolute two-second deadline with ${drip ? 'continuous body activity' : 'no response'}`, { timeout: 5000 }, async (t) => {
  const fixture = await httpsFixture(t, (_req, res) => {
    if (drip) {
      res.writeHead(200); res.write('{');
      const timer = setInterval(() => res.write(' '), 50); res.once('close', () => clearInterval(timer));
    }
  });
  const start = performance.now();
  assert.equal(await checkHealth({ ca: fixture.ca, serverName, bearerToken: randomUUID(), port: port(fixture.baseUrl) }), false);
  // Scheduling tolerance only; the implementation's absolute budget is 2000ms.
  assert.equal(performance.now() - start < 2500, true);
});

test('probe deadline also bounds an unfinished TLS handshake', { timeout: 4000 }, async (t) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address(); assert.equal(address !== null && typeof address !== 'string', true);
  if (!address || typeof address === 'string') return;
  const started = performance.now();
  assert.equal(await checkHealth({ ca: Buffer.alloc(0), serverName, bearerToken: randomUUID(), port: address.port }), false);
  assert.equal(performance.now() - started < 2500, true);
});

test('probe rejects truncated responses and counts streamed bytes, not content-length alone', async (t) => {
  for (const truncated of [false, true]) {
    const fixture = await httpsFixture(t, (_req, res) => {
      res.writeHead(200, truncated ? { 'Content-Length': 100 } : {});
      res.write('{"status":"ok"}');
      if (truncated) res.destroy(); else { res.write(' '.repeat(1010)); res.end(); }
    });
    assert.equal(await checkHealth({ ca: fixture.ca, serverName, bearerToken: randomUUID(), port: port(fixture.baseUrl) }), false);
  }
});

test('probe CLI configuration/read failures exit one with no stdout or stderr, including synthetic secrets', async () => {
  const token = randomUUID();
  for (const env of [{}, { POD_NAMESPACE: 'orka-system', ORKA_OUTBOUND_BEARER_TOKEN: token },
    { POD_NAMESPACE: token + '\n', ORKA_OUTBOUND_BEARER_TOKEN: token }]) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/deployment/probe.ts'], {
      cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', (chunk: Buffer) => { output += chunk; }); child.stderr.on('data', (chunk: Buffer) => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    const code = await new Promise<number | null>((resolve) => { child.once('error', () => resolve(null)); child.once('close', resolve); });
    clearTimeout(timer);
    assert.equal(code, 1); assert.equal(output.includes(token), false); assert.equal(output.length, 0);
  }
});
