import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type https from 'node:https';
import { setImmediate } from 'node:timers/promises';
import { createTableIngressStore } from '../../src/ingress/table-store.js';
import { createDeliveryDispatcher } from '../../src/outbound/dispatcher.js';
import { createProviderSender } from '../../src/outbound/sender.js';
import type { TableDependencies } from '../../src/storage/table/types.js';
import { finalDelivery } from '../fixtures/outgoing.js';
import { hash, ingressBinding, stamp, syntheticToken } from './table-service.js';

const warmup = 5000;
const iterations = process.argv[2] === 'idle' ? 60000 : 20000;
assert.ok(globalThis.gc, 'The memory worker requires --expose-gc');

async function retainedHeap() {
  // Cross two event-loop turns: completed promise stacks unwind and weakly
  // reachable signals can die before the second collection. RSS is not a leak
  // oracle (allocator high-water marks need not return to the OS).
  await setImmediate(); globalThis.gc!();
  await setImmediate(); globalThis.gc!();
  return process.memoryUsage().heapUsed;
}

async function repeat(count: number, operation: () => Promise<void>) {
  for (let i = 0; i < count; i++) {
    await operation();
    if ((i + 1) % 500 === 0) await setImmediate();
  }
}

async function samples(operation: () => Promise<void>) {
  await repeat(warmup, operation);
  const heapWarm = await retainedHeap();
  await repeat(iterations / 2, operation);
  const heapMiddle = await retainedHeap();
  await repeat(iterations / 2, operation);
  const heapTail = await retainedHeap();
  return { warmup, iterations, heapWarm, heapMiddle, heapTail, growth: heapTail - heapWarm };
}

/** Only the native I/O boundary is replaced. SDK serialization, metadata
 * encoding/decoding, ETag reconciliation, owner FIFO and inbox index stay real.
 * This service intentionally accepts only the one-row empty-inbox workload. */
function memoryTable() {
  let metadata: Record<string, unknown> | undefined;
  let version = 0; let lastSignal: AbortSignal | undefined; let fault: unknown;
  const stats = { requests: 0, writes: 0, requestCloses: 0, socketCloses: 0, listenerChecks: 0 };
  const partition = 'v1_ingress_c3RhYmxl';
  const binding = Buffer.from(JSON.stringify(['orka-table-v1', 'example123', 'journal', 'ingress', 'stable',
    ['App', 'Tenant', 'https://orka.example.invalid/', 'gateway', 'teams']])).toString('base64');
  const checkListeners = () => {
    if (lastSignal) {
      assert.equal(getEventListeners(lastSignal, 'abort').length, 0, 'Completed native request retained an abort listener');
      stats.listenerChecks++;
    }
  };
  function respond(url: URL, method: string, body: string) {
    const path = decodeURIComponent(url.pathname);
    if (method === 'POST') {
      const batch = path === '/$batch';
      assert.equal(path, batch ? '/$batch' : '/journal');
      let entity: Record<string, unknown>;
      if (batch) {
        const sections = body.split(/content-type: application\/http/iu).slice(1);
        assert.equal(sections.length, 1, 'Idle polls must write metadata only');
        const match = /\r\nPUT ([^\r\n]+) HTTP\/1\.1\r\n([\s\S]*?)\r\n\r\n(?:\r\n)*([^\r\n]+)/iu.exec(sections[0]!);
        assert.ok(match); assert.ok(metadata);
        assert.equal(/^if-match: (.+)$/imu.exec(match[2]!)?.[1]?.trim(), metadata['odata.etag']);
        entity = JSON.parse(match[3]!);
      } else {
        assert.equal(metadata, undefined); entity = JSON.parse(body);
      }
      assert.equal(entity.RowKey, 'M'); assert.equal(entity.PartitionKey, partition);
      assert.equal(entity.V, 2); assert.equal(entity.Binding, binding);
      assert.equal(entity.Digest, hash(['orka-m-v2', entity.Binding, entity.InitId, entity.InitDigest, entity.Owner,
        Number(entity.Epoch), entity.Invocation, entity.Operation, entity.Plan, entity.State, entity.Result, entity.Exit]));
      metadata = stamp(entity, ++version); stats.writes++;
      return { statusCode: batch ? 202 : 204, headers: {}, body: '' };
    }
    assert.equal(method, 'GET'); assert.equal(body, '');
    const headers: IncomingMessage['headers'] = { 'content-type': 'application/json;odata=fullmetadata' };
    if (path === `/journal(PartitionKey='${partition}',RowKey='M')`) {
      assert.ok(metadata); headers.etag = String(metadata['odata.etag']);
      return { statusCode: 200, headers, body: JSON.stringify(metadata) };
    }
    assert.equal(path, '/journal()');
    assert.equal(url.searchParams.get('$filter'), `PartitionKey eq '${partition}'`);
    assert.equal(url.searchParams.get('$top'), '1');
    assert.equal([...url.searchParams].length, 2);
    return { statusCode: 200, headers, body: JSON.stringify({ value: metadata ? [metadata] : [] }) };
  }
  const request = ((url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
    assert.equal(url.origin, 'https://example123.table.core.windows.net');
    assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
    assert.equal((options.headers as Record<string, string>).authorization, `Bearer ${syntheticToken}`);
    stats.requests++;
    const req = new EventEmitter(); const socket = new EventEmitter();
    let closed = false; let response: (EventEmitter & { complete: boolean; destroy(): void }) | undefined;
    const close = () => {
      if (closed) return; closed = true;
      stats.requestCloses++; req.emit('close');
      // The production promise must also wait for socket drain, not only end.
      queueMicrotask(() => { stats.socketCloses++; socket.emit('close'); });
    };
    return Object.assign(req, {
      end(body: string) {
        queueMicrotask(() => {
          req.emit('socket', socket);
          try {
            const reply = respond(url, String(options.method), body);
            response = Object.assign(new EventEmitter(), { ...reply,
              rawHeaders: Object.entries(reply.headers).flatMap(([key, value]) => [key, String(value)]),
              complete: false, destroy() { close(); } });
            callback(response as unknown as IncomingMessage);
            if (reply.body) response.emit('data', Buffer.from(reply.body));
            response.complete = true; response.emit('end'); close();
          } catch (error) { fault ??= error; req.emit('error', error); close(); }
        });
      },
      destroy() { response?.destroy(); close(); },
    });
  }) as NonNullable<TableDependencies['request']>;
  const dependencies: TableDependencies = { request, async token(scope, context) {
    checkListeners(); lastSignal = context.signal;
    assert.equal(scope, 'https://storage.azure.com/.default');
    assert.equal(context.signal.aborted, false); assert.ok(context.deadline > performance.now());
    return syntheticToken;
  } };
  return { dependencies, stats, check() {
    if (fault) throw fault;
    checkListeners(); assert.equal(stats.requests, stats.requestCloses); assert.equal(stats.requests, stats.socketCloses);
    assert.ok(stats.listenerChecks > 0); assert.ok(metadata);
    return { ...stats, rows: 1 };
  } };
}

async function idlePolls() {
  const table = memoryTable();
  const options = { audit: { maxPages: 64, maxPageBytes: 8 * 1024 * 1024, maxDurationMs: 30000, maxTrackingBytes: 1024 * 1024 },
    maxIndexBytes: 8 * 1024 * 1024, now: () => 100 };
  const store = createTableIngressStore(ingressBinding, table.dependencies, options);
  try {
    await createTableIngressStore(ingressBinding, table.dependencies, options).initialize();
    await store.open();
    const before = store.status(); const writesBefore = table.stats.writes;
    const sample = await samples(async () => { assert.equal(await store.claimForForwarding(), undefined); });
    const after = store.status();
    assert.equal(after.lifecycle, 'ready'); assert.equal(after.kernel.lifecycle, 'envelope-audited');
    assert.equal(after.pending, 0); assert.equal(after.pendingBytes, 0);
    assert.equal(after.kernel.pending, 0); assert.equal(after.kernel.pendingBytes, 0);
    assert.ok(after.index); assert.equal(after.index.events, 0); assert.equal(after.index.routes, 0); assert.equal(after.index.seals, 0);
    assert.equal(after.index.chargedBytes, before.index!.chargedBytes);
    assert.deepEqual(after.index.working, before.index!.working);
    assert.equal(table.stats.writes - writesBefore, warmup + iterations);
    // Sample while the same owner and its write permission remain alive; closing
    // first would hide the long-lived-parent cancellation bookkeeping leak.
    return { scenario: 'idle', ...sample, ...table.check(), pending: after.pending, kernelPending: after.kernel.pending,
      events: after.index.events, routes: after.index.routes, seals: after.index.seals, indexBytes: after.index.chargedBytes };
  } finally { await store.close(); table.check(); }
}

async function replayDeliveries() {
  const caller = new AbortController(); let begins = 0; let providerPosts = 0;
  const delivered = { kind: 'delivered', providerMessageId: 'synthetic-receipt' } as const;
  const sender = createProviderSender(async () => { throw new Error('Replay must not acquire provider credentials'); },
    { post: async () => { providerPosts++; throw new Error('Replay must not POST'); } });
  const dispatcher = createDeliveryDispatcher({ scope: { appId: 'synthetic-app', tenantId: finalDelivery.accountId },
    // A fixed durable receipt: no alias collection, queued work or growing test
    // history. Snapshot validation and the actual dispatcher still run each time.
    journal: { begin(request) { assert.deepEqual(request, finalDelivery); begins++; return delivered; },
      settle() { throw new Error('Replay must not settle a fresh claim'); }, close() {} },
    sender, getRoute() { throw new Error('Replay must not resolve a route'); }, serviceUrls: [], recipientIds: [] });
  try {
    const sample = await samples(async () => {
      assert.deepEqual(await dispatcher.deliver(finalDelivery, { signal: caller.signal }),
        { status: 'delivered', providerMessageId: 'synthetic-receipt' });
    });
    assert.equal(dispatcher.healthy, true); assert.equal(begins, warmup + iterations);
    assert.equal(providerPosts, 0); assert.equal(caller.signal.aborted, false);
    const callerListeners = getEventListeners(caller.signal, 'abort').length;
    assert.equal(callerListeners, 0, 'Completed replay retained a caller abort listener');
    return { scenario: 'dispatcher', ...sample, begins, providerPosts, callerListeners };
  } finally { await dispatcher.stop(); }
}

try {
  const mode = process.argv[2]; assert.ok(mode === 'idle' || mode === 'dispatcher');
  const result = await (mode === 'idle' ? idlePolls() : replayDeliveries());
  await new Promise<void>((resolve, reject) => process.send!(result, (error: Error | null) => error ? reject(error) : resolve()));
} finally { process.disconnect(); }
