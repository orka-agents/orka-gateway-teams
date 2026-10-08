import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type https from 'node:https';
import { setImmediate } from 'node:timers/promises';
import { OwnedTableClient } from '../../src/storage/table/client.js';
import { bindTable } from '../../src/storage/table/codec.js';
import type { TableDependencies } from '../../src/storage/table/types.js';
import { syntheticToken, tableBinding } from './table-service.js';

assert.ok(globalThis.gc, 'The retention worker requires --expose-gc');
let requestRef: WeakRef<ClientRequest> | undefined; let signalRef: WeakRef<AbortSignal> | undefined;
let requests = 0; let requestCloses = 0; let socketCloses = 0;
// Only native I/O is replaced. The socket stays strongly reachable and idle
// while public read, SDK serialization, fencing and OData error parsing run.
const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() {
  if (!this.destroyed) { this.destroyed = true; socketCloses++; socket.emit('close'); }
  return this;
} });
const request = ((url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
  assert.equal(url.origin, 'https://example123.table.core.windows.net');
  assert.equal(decodeURIComponent(url.pathname), "/journal(PartitionKey='v1_delivery_c3RhYmxl',RowKey='delivery_YWJzZW50')");
  assert.equal(url.search, ''); assert.equal(options.method, 'GET');
  assert.equal((options.headers as Record<string, string>).accept, 'application/json;odata=fullmetadata');
  requests++;
  let closed = false;
  const req = Object.assign(new EventEmitter(), {
    end(body: string) {
      assert.equal(body, '');
      queueMicrotask(() => {
        req.emit('socket', socket);
        const res = Object.assign(new EventEmitter(), {
          statusCode: 404, headers: { 'content-type': 'application/json;odata=fullmetadata', 'x-ms-error-code': 'EntityNotFound' },
          rawHeaders: ['content-type', 'application/json;odata=fullmetadata', 'x-ms-error-code', 'EntityNotFound'],
          complete: false, destroy() { req.destroy(); },
        });
        callback(res as unknown as IncomingMessage);
        res.emit('data', Buffer.from(JSON.stringify({ 'odata.error': {
          code: 'EntityNotFound', message: { lang: 'en-US', value: 'synthetic absent entity' },
        } })));
        res.complete = true; res.emit('end');
        if (!closed) { closed = true; requestCloses++; req.emit('close'); }
      });
    },
    destroy() {
      socket.destroy();
      if (!closed) { closed = true; requestCloses++; req.emit('close'); }
      return this;
    },
  });
  requestRef = new WeakRef(req as unknown as ClientRequest);
  return req;
}) as NonNullable<TableDependencies['request']>;
const client = new OwnedTableClient(bindTable(tableBinding), { request, async token(scope, context) {
  assert.equal(scope, 'https://storage.azure.com/.default');
  assert.equal(context.signal.aborted, false);
  // This is the actual signal forwarded to native(), not the caller's signal.
  signalRef = new WeakRef(context.signal);
  return syntheticToken;
} });
async function completedRead() {
  assert.equal(await client.read('delivery_YWJzZW50', {
    signal: new AbortController().signal, deadline: performance.now() + 10000,
  }), undefined);
}
try {
  await completedRead();
  assert.ok(requestRef); assert.ok(signalRef);
  assert.equal(requests, 1); assert.equal(requestCloses, 1);
  // Never dereference within the loop: WeakRef.deref keeps its target alive
  // for the rest of the current job, invalidating the next collection.
  for (let i = 0; i < 16; i++) { await setImmediate(); globalThis.gc!(); }
  assert.equal(socket.destroyed, false); assert.equal(socketCloses, 0);
  const sample = { requestReleased: requestRef.deref() === undefined, signalReleased: signalRef.deref() === undefined,
    requests, requestCloses, socketCloses };
  process.stdout.write(`${JSON.stringify(sample)}\n`);
} finally {
  // This event-only fixture is not registered with the real HTTPS Agent.
  // Explicit fixture cleanup is not evidence of Agent.destroy or TLS drain.
  socket.destroy(); await client.close();
}
