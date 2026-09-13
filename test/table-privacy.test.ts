import assert from 'node:assert/strict';
import https from 'node:https';
import { test } from 'node:test';
import { TableClient } from '@azure/data-tables';
import { createHttpHeaders } from '@azure/core-rest-pipeline';
import { createTracingClient, useInstrumenter } from '@azure/core-tracing';
import type { Instrumenter, TracingContext } from '@azure/core-tracing';
import { AzureLogger, getLogLevel, setLogLevel } from '@azure/logger';
import { createTableKernel } from '../src/storage/table/owner.js';
import { createTableDeliveryJournal } from '../src/delivery/table-journal.js';
import { finalDelivery } from './fixtures/outgoing.js';
import { OwnedTableClient } from '../src/storage/table/client.js';
import { bindTable } from '../src/storage/table/codec.js';
import { context, tableBinding, tableService, syntheticToken } from './support/table-service.js';

class Context implements TracingContext {
  constructor(readonly values = new Map<symbol, unknown>()) {}
  getValue(key: symbol) { return this.values.get(key); }
  setValue(key: symbol, value: unknown) { return new Context(new Map([...this.values, [key, value]])); }
  deleteValue(key: symbol) { const result = new Map(this.values); result.delete(key); return new Context(result); }
}
test('active recording instrumentation and verbose logs contain no private raw, encoded or hidden error content', async t => {
  const marker = 'private-table-payload-canary/+'; const secrets = [marker, syntheticToken];
  const needles = secrets.flatMap(v => [v, Buffer.from(v).toString('base64'), Buffer.from(v).toString('base64url'), encodeURIComponent(v)]);
  let hits = 0; let spans = 0; let ended = 0; let logs = 0; let errors = 0; let encodedSpanHits = 0;
  function inspect(value: unknown, seen = new Set<unknown>(), depth = 0): void {
    if (typeof value === 'string') {
      if (needles.some(s => value.includes(s))) hits++;
      try { if (needles.some(s => decodeURIComponent(value).includes(s))) hits++; } catch { /* Not a URI. */ }
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 15) return; seen.add(value);
    if (value instanceof Error) { errors++; for (const key of ['message', 'stack', 'cause', 'request', 'response']) {
      try { inspect(Reflect.get(value, key), seen, depth + 1); } catch { /* A hostile diagnostic accessor is not invoked further. */ }
    } }
    if (value instanceof Map) for (const [key, entry] of value) { inspect(key, seen, depth + 1); inspect(entry, seen, depth + 1); }
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key)!; inspect(key, seen, depth + 1); if ('value' in d) inspect(d.value, seen, depth + 1);
    }
  }
  const instrumenter: Instrumenter = {
    startSpan(name, options) {
      spans++; inspect(name); inspect(options);
      return { tracingContext: new Context(), span: { isRecording: () => true, end: () => { ended++; },
        setAttribute: (key, value) => {
          inspect(key); inspect(value);
          if (key === 'continuationToken' && typeof value === 'string') {
            const decoded = Buffer.from(value, 'base64').toString(); if (decoded.includes(marker)) encodedSpanHits++; inspect(decoded);
          }
        }, setStatus: inspect, recordException: inspect } };
    },
    withContext(ctx, callback, ...args) { inspect(ctx); inspect(args); return callback(...args); },
    parseTraceparentHeader: () => undefined, createRequestHeaders: () => ({}),
  };
  const previousLog = AzureLogger.log; const previousLevel = getLogLevel();
  AzureLogger.log = (...args) => { logs++; inspect(args); }; setLogLevel('verbose'); useInstrumenter(instrumenter);
  // Node's test runner isolates this file in its own process; production never changes instrumentation.
  t.after(() => { AzureLogger.log = previousLog; setLogLevel(previousLevel); });
  const raw = new TableClient('https://example123.table.core.windows.net', 'journal', {
    retryOptions: { maxRetries: 0 }, httpClient: { sendRequest: async request => ({ request, status: 400,
      headers: createHttpHeaders({ 'content-type': 'application/json' }), bodyAsText: JSON.stringify({ 'odata.error': { code: 'BadRequest', message: { value: marker } } }) }) },
  });
  await raw.submitTransaction([['create', { partitionKey: 'control', rowKey: 'control', secret: marker }]]).catch(() => {});
  assert.equal(hits > 0 && errors > 0 && spans > 0 && logs > 0, true);
  hits = 0;
  const tracing = createTracingClient({ namespace: 'control', packageName: 'control' });
  const hidden = new Error('fixed'); Object.defineProperty(hidden, 'cause', { value: { nested: encodeURIComponent(marker) }, enumerable: false });
  await tracing.withSpan('control', {}, async () => { throw hidden; }).catch(() => {}); assert.equal(hits > 0, true);
  hits = 0;
  // Raw SDK's second page adds its encoded continuation to a recording span.
  let rawPages = 0;
  const rawPageClient = new TableClient('https://example123.table.core.windows.net', 'journal', {
    httpClient: { sendRequest: async request => { rawPages++; return { request, status: 200, bodyAsText: '{"value":[]}',
      headers: createHttpHeaders({ 'content-type': 'application/json', ...(rawPages === 1 ? { 'x-ms-continuation-nextpartitionkey': marker } : {}) }) }; } },
  });
  const pages = rawPageClient.listEntities().byPage({ maxPageSize: 1 }); await pages.next(); await pages.next(); await pages.return?.();
  assert.equal(hits > 0 && encodedSpanHits > 0, true); hits = 0; encodedSpanHits = 0; const startSpans = spans; const startLogs = logs;
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies);
  await k.initialize(); await k.acquire(); await k.scan();
  await k.mutate({ input: Buffer.from(marker), keys: [] }, () => ({ state: Buffer.from(marker), result: Buffer.from(marker),
    actions: [{ kind: 'create', key: { type: 'delivery', id: marker }, payload: Buffer.from(marker) }] }));
  await k.scan(); await k.read({ type: 'delivery', id: marker }); await k.close();
  // Repeat the active instrumentation exercise through the production delivery
  // journal. Private request fields must not reach any wire entity or M result.
  const delivery = await tableService(t); let checkedActions = 0;
  delivery.controls.hook = e => {
    for (const action of e.actions) {
      checkedActions++;
      for (const field of ['State', 'Result', 'B0', 'B1', 'B2', 'B3']) {
        const encoded = action.entity[field];
        if (typeof encoded === 'string') assert.equal(Buffer.from(encoded, 'base64').includes(Buffer.from(marker)), false);
      }
      assert.equal(JSON.stringify(action.entity).includes(marker), false);
    }
    e.reply();
  };
  const init = createTableDeliveryJournal(tableBinding, delivery.dependencies); await init.initialize(); await init.close();
  const journal = createTableDeliveryJournal(tableBinding, delivery.dependencies); await journal.open();
  const request = { ...finalDelivery, accountId: 'Tenant', text: marker, metadata: { private: marker }, replyTarget: marker,
    originatingEventId: marker, contextId: marker, taskRef: { namespace: marker, name: marker }, sessionRef: { namespace: marker, name: marker } };
  const begin = await journal.begin(request); assert.equal(begin.kind, 'claimed');
  if (begin.kind !== 'claimed') throw new Error('Expected fixture claim');
  await journal.settle(begin.claim, { kind: 'delivered', providerMessageId: 'privacy-receipt' });
  await journal.begin({ ...request, deliveryId: 'privacy-alias' }); inspect(journal.status()); await journal.close();
  assert.ok(checkedActions >= 10);
  const client = new OwnedTableClient(bindTable(tableBinding), s.dependencies);
  s.controls.hook = e => { e.res.writeHead(200, { 'content-type': 'application/json' }); e.res.end(JSON.stringify({ unknown: marker })); };
  await client.read('M', context()).catch(inspect);
  s.controls.request = (() => { throw hidden; }) as typeof https.request;
  await client.read('M', context()).catch(inspect); await client.close();
  assert.equal(hits, 0); assert.equal(encodedSpanHits, 0); assert.equal(spans > startSpans, true); assert.equal(ended, spans);
  assert.equal(logs > startLogs, true); assert.equal(getLogLevel(), 'verbose');
});
