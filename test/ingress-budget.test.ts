import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { ClientRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { NativeAdapter } from '../src/ingress/http-adapter.js';
import { startReceiver } from '../src/ingress/server.js';
import { startSetupCapture } from '../src/setup/server.js';
import { activity, authFixture, deferred, post, receiverConfig, scope } from './support/ingress-auth.js';
import { setupFiles } from './support/setup.js';

async function until(predicate: () => boolean, timeout = 4000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) { assert.ok(performance.now() < deadline, 'boundary was not reached'); await sleep(5); }
}
function issue(port: number, token: string, body?: unknown): ClientRequest {
  const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/messages', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(body === undefined ? { 'Content-Length': 100 } : {}),
  } }, (res) => res.resume());
  req.on('error', () => {});
  if (body === undefined) req.flushHeaders(); else req.end(JSON.stringify(body));
  return req;
}
async function boundedPost(port: number, token: string, body = activity()): Promise<Response | undefined> {
  return fetch(`http://127.0.0.1:${port}/api/messages`, { method: 'POST', signal: AbortSignal.timeout(1500),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).catch(() => undefined);
}

for (const loss of ['disconnect', 'timeout'] as const) test(`32 SDK admissions retain capacity after HTTP ${loss} until actual completion`, { timeout: 20000 }, async (t) => {
  const auth = await authFixture(t); const gate = deferred<void>(); let submitted = 0; let completed = 0;
  const receiver = await startReceiver(receiverConfig, { scope, admit: async (event) => {
    submitted++; await gate.promise; completed++; return { kind: 'accepted', replyTarget: event.replyTarget! };
  } }, auth.dependencies);
  const requests: ClientRequest[] = [];
  try {
    // Warm both independent auth caches through the actual registered SDK route.
    assert.equal((await post(receiver.port, auth.token(), { ...activity(), type: 'typing' })).status, 200);
    for (let i = 0; i < 32; i++) requests.push(issue(receiver.port, auth.token(), { ...activity(), id: `pending-${i}` }));
    await until(() => submitted === 32);
    assert.equal((await boundedPost(receiver.port, auth.token()))?.status, 503, 'full must be immediate transient backpressure');
    assert.equal(submitted, 32); assert.equal(completed, 0);
    if (loss === 'disconnect') { for (const req of requests) { req.destroy(); req.destroy(); } await sleep(40); }
    else await sleep(10200);
    assert.equal((await boundedPost(receiver.port, auth.token()))?.status, 503, 'response end does not release uncertain work');
    assert.equal(submitted, 32);
    let stopped = false; const stopping = receiver.stop().then(() => { stopped = true; });
    await sleep(30); assert.equal(stopped, false); gate.resolve(); await stopping;
    assert.equal(completed, 32);
  } finally { gate.resolve(); for (const req of requests) req.destroy(); await receiver.stop(); }
});

test('one completed admission releases exactly one slot; overload does not poison authenticated ingress', async (t) => {
  const auth = await authFixture(t); const gates = Array.from({ length: 33 }, () => deferred<void>()); let submitted = 0;
  const receiver = await startReceiver(receiverConfig, { scope, admit: async (event) => {
    const index = submitted++; await gates[index]?.promise; return { kind: 'accepted', replyTarget: event.replyTarget! };
  } }, auth.dependencies);
  const requests: ClientRequest[] = [];
  try {
    for (let i = 0; i < 32; i++) requests.push(issue(receiver.port, auth.token(), { ...activity(), id: `slot-${i}` }));
    await until(() => submitted === 32);
    assert.equal((await boundedPost(receiver.port, auth.token()))?.status, 503);
    requests[0]!.destroy(); gates[0]!.resolve(); await sleep(40);
    requests.push(issue(receiver.port, auth.token(), { ...activity(), id: 'replacement' }));
    await until(() => submitted === 33);
    assert.equal((await boundedPost(receiver.port, auth.token()))?.status, 503);
    assert.equal(submitted, 33);
    for (const gate of gates) gate.resolve(); await sleep(40);
    assert.equal((await post(receiver.port, auth.token())).status, 200);
    assert.equal(submitted, 34);
  } finally { for (const gate of gates) gate.resolve(); for (const req of requests) req.destroy(); await receiver.stop(); }
});

test('handler capacity is reserved before body retention, not only before store.admit', async () => {
  let verified = 0;
  const adapter = new NativeAdapter(async () => { verified++; return false; });
  adapter.registerRoute('POST', '/api/messages', async () => ({ status: 200 }));
  const port = await adapter.listen('127.0.0.1', 0); const requests: ClientRequest[] = [];
  try {
    for (let i = 0; i < 32; i++) requests.push(issue(port, 'unused'));
    await until(() => requests.every((req) => (req.socket?.bytesWritten ?? 0) > 0)); await sleep(40);
    assert.equal((await boundedPost(port, 'unused'))?.status, 503); assert.equal(verified, 0);
    for (const req of requests) req.destroy(); await sleep(40);
    assert.equal((await boundedPost(port, 'unused'))?.status, 401); assert.equal(verified, 1);
  } finally { for (const req of requests) req.destroy(); await adapter.stop(); }
});

test('shared setup adapter bounds stalled SDK work without bypassing auth or one-shot publication', { timeout: 10000 }, async (t) => {
  const files = setupFiles(t); const auth = await authFixture(t); const gate = deferred<void>(); auth.delaySdk(gate.promise);
  const capture = await startSetupCapture(files.config, auth.dependencies); const requests: ClientRequest[] = [];
  const body = activity(); body.text = files.challenge;
  try {
    for (let i = 0; i < 32; i++) requests.push(issue(capture.port, auth.token(), body));
    await until(() => auth.requests() >= 2); await sleep(60);
    assert.equal((await boundedPost(capture.port, auth.token(), body))?.status, 503);
    assert.equal(existsSync(files.config.captureFile), false);
    for (const req of requests) req.destroy(); await sleep(40);
    assert.equal((await boundedPost(capture.port, auth.token(), body))?.status, 503);
    gate.resolve(); await sleep(100);
    assert.equal(existsSync(files.config.captureFile), false);
    assert.equal((await post(capture.port, 'invalid', body)).status, 401);
    assert.equal(existsSync(files.config.captureFile), false);
    assert.equal((await post(capture.port, auth.token(), body)).status, 200); await capture.done;
    const saved = JSON.parse(readFileSync(files.config.captureFile, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['appId', 'conversationId', 'recipientId', 'senderId', 'serviceUrl', 'tenantId']);
    assert.ok(saved.senderId === body.from.id); assert.equal(auth.strictRequests(), 1); assert.ok(auth.requests() >= 2);
    await assert.rejects(post(capture.port, auth.token(), body));
  } finally { gate.resolve(); for (const req of requests) req.destroy(); await capture.stop(); }
});
