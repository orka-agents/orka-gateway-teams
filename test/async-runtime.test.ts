import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { App } from '@microsoft/teams.apps';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { createIngressPort, initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import type { IngressPort } from '../src/ingress/types.js';
import { startIngressRuntime as start } from '../src/ingress/main.js';
import type { IngressRuntime } from '../src/ingress/main.js';
import { NativeAdapter } from '../src/ingress/http-adapter.js';
import type { ServeConfig } from '../src/ingress/config.js';
import { activity, authFixture, deferred, receiverConfig, scope, serviceUrl } from './support/ingress-auth.js';
import { finalDelivery } from './fixtures/outgoing.js';
import { expectedEvent } from './fixtures/incoming.js';

const journalScope = { appId: scope.appId, tenantId: scope.tenantId };
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-async-runtime-'));
  const config: ServeConfig = { scope, dbPath: join(directory, 'inbox.sqlite'), receiver: receiverConfig,
    bearerToken: randomUUID(), policy: { maxPending: 100, maxRecords: 100, replayWindowMs: 86400000 },
    outbound: { dbPath: join(directory, 'delivery.sqlite'), bearerToken: randomUUID(), host: '127.0.0.1', port: 0 } };
  initializeIngressStore(config.dbPath, scope); initializeDeliveryJournal(config.outbound!.dbPath, journalScope);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { config, seed() {
    const store = openIngressStore(config.dbPath, scope);
    store.admit(expectedEvent, { serviceUrl, channelId: 'msteams', bot: { id: receiverConfig.recipientIds[0]!, role: 'bot' },
      conversation: { id: expectedEvent.contextId, conversationType: 'personal', tenantId: scope.tenantId } });
    const claim = store.claim(); assert.ok(claim);
    store.complete(claim, { status: 'accepted', eventId: 'seed-route', state: 'Queued' }); store.close();
  } };
}

for (const boundary of ['inbox', 'journal'] as const) test(`startup abort waits late ${boundary} opening, then closes ownership without listening`, async (t) => {
  const f = fixture(t); const gate = deferred<void>(); const entered = deferred<void>(); const closeGate = deferred<void>();
  let opens = 0; let closes = 0; let listens = 0; let finished = false; let runtime: IngressRuntime | undefined;
  const listen = NativeAdapter.prototype.listen;
  t.mock.method(NativeAdapter.prototype, 'listen', function(this: NativeAdapter, ...args: Parameters<typeof listen>) { listens++; return listen.apply(this, args); });
  const abort = new AbortController();
  const starting = start(f.config, {
    openIngressStore: async (...args) => {
      opens++; const port = createIngressPort(openIngressStore(...args));
      if (boundary === 'inbox') { entered.resolve(); await gate.promise; }
      return { ...port, close: async () => { closes++; await closeGate.promise; port.close(); } };
    },
    openDeliveryJournal: async (...args) => {
      opens++; const journal = openDeliveryJournal(...args); entered.resolve(); await gate.promise;
      return { ...journal, close: async () => { closes++; await closeGate.promise; journal.close(); } };
    },
  }, abort.signal).then((value) => { runtime = value; return value; }).finally(() => { finished = true; });
  void starting.catch(() => {});
  try {
    await Promise.race([entered.promise, starting]); assert.equal(opens, boundary === 'inbox' ? 1 : 2, 'trusted async opening must be awaited');
    abort.abort(); await turn(); assert.equal(finished, false); assert.equal(closes, 0); assert.equal(listens, 0);
    gate.resolve(); await turn(); assert.equal(finished, false, 'startup unwind must await actual closes');
    closeGate.resolve(); await assert.rejects(starting, { message: 'Ingress startup failed' });
    assert.equal(closes, boundary === 'inbox' ? 1 : 2); assert.equal(listens, 0);
    const reopened = openIngressStore(f.config.dbPath, scope); reopened.close();
    const journal = openDeliveryJournal(f.config.outbound!.dbPath, journalScope); journal.close();
  } finally { gate.resolve(); closeGate.resolve(); await starting.catch(() => {}); await runtime?.stop(); }
});

test('second-store opening failure waits first-store async close and reports fixed startup failure', async (t) => {
  const f = fixture(t); const closing = deferred<void>(); const closeGate = deferred<void>(); let finished = false; let runtime: IngressRuntime | undefined;
  const starting = start(f.config, {
    openIngressStore: (...args) => { const store = createIngressPort(openIngressStore(...args)); return { ...store, close: async () => {
      closing.resolve(); await closeGate.promise; store.close(); throw new Error('private-close-failure');
    } }; },
    openDeliveryJournal: async () => { throw new Error('private-open-failure'); },
  }).then((value) => { runtime = value; return value; }).finally(() => { finished = true; }); void starting.catch(() => {});
  try {
    await Promise.race([closing.promise, starting]); await turn(); assert.equal(finished, false);
    closeGate.resolve(); await assert.rejects(starting, { message: 'Ingress startup failed' });
    const store = openIngressStore(f.config.dbPath, scope); store.close();
  } finally { closeGate.resolve(); await starting.catch(() => {}); await runtime?.stop(); }
});

for (const failure of ['abort', 'initialize'] as const) test(`${failure} during receiver initialization drains it before both stores close`, async (t) => {
  const f = fixture(t); const gate = deferred<void>(); const entered = deferred<void>(); const closing = deferred<void>();
  const closeGate = deferred<void>(); const abort = new AbortController(); let closes = 0; let listens = 0; let finished = false; let runtime: IngressRuntime | undefined;
  const initialize = App.prototype.initialize; const listen = NativeAdapter.prototype.listen;
  t.mock.method(App.prototype, 'initialize', async function(this: App) { entered.resolve(); await gate.promise;
    if (failure === 'initialize') throw new Error('private-initialize-failure'); await initialize.call(this);
  });
  t.mock.method(NativeAdapter.prototype, 'listen', function(this: NativeAdapter, ...args: Parameters<typeof listen>) { listens++; return listen.apply(this, args); });
  const starting = start(f.config, {
    openIngressStore: (...args) => { const port = createIngressPort(openIngressStore(...args)); return { ...port, close: async () => {
      closes++; closing.resolve(); await closeGate.promise; port.close();
    } }; },
    openDeliveryJournal: (...args) => { const journal = openDeliveryJournal(...args); return { ...journal, close: async () => {
      closes++; closing.resolve(); await closeGate.promise; journal.close(); throw new Error('private-close-failure');
    } }; },
  }, abort.signal).then((value) => { runtime = value; return value; }).finally(() => { finished = true; }); void starting.catch(() => {});
  try {
    await entered.promise; if (failure === 'abort') abort.abort(); await turn(); assert.equal(closes, 0); assert.equal(finished, false);
    gate.resolve(); await Promise.race([closing.promise, starting.catch(() => {})]); await turn();
    assert.equal(listens, 0); assert.equal(finished, false); assert.equal(closes, 2, 'one close failure must not skip the other');
    closeGate.resolve(); await assert.rejects(starting, { message: 'Ingress startup failed' });
  } finally { gate.resolve(); closeGate.resolve(); await starting.catch(() => {}); await runtime?.stop(); }
});

test('signal during first relay claim drives shutdown even before start returns the runtime', async (t) => {
  const f = fixture(t); const abort = new AbortController(); let closes = 0;
  const runtime = await start(f.config, { openIngressStore: (...args) => {
    const store = createIngressPort(openIngressStore(...args)); return { ...store,
      claimForForwarding() { abort.abort(); return store.claimForForwarding(); },
      close: async () => { closes++; await store.close(); },
    };
  } }, abort.signal);
  let finished = false; void runtime.done.then(() => { finished = true; });
  try { await turn(); assert.equal(finished, true, 'an early signal must not leave done pending'); assert.equal(closes, 1); }
  finally { await runtime.stop(); }
});

for (const boundary of ['admit', 'begin', 'route', 'settle'] as const) test(`runtime drains disconnected async ${boundary} before closing either store`, async (t) => {
  const f = fixture(t); f.seed(); const auth = await authFixture(t); const gate = deferred<void>(); const entered = deferred<void>();
  const closeGate = deferred<void>(); let closes = 0; let posts = 0; let stopped = false; let hooked = false;
  const runtime = await start(f.config, { ...auth.dependencies, botToken: () => randomUUID(), providerPost: async () => {
    posts++; return { status: 201, data: Buffer.from('{"id":"runtime-async-receipt"}') };
  }, openIngressStore: (...args) => {
    hooked = true; const store = createIngressPort(openIngressStore(...args)); return { ...store,
      admit: async (...input: Parameters<IngressPort['admit']>) => { if (boundary === 'admit') { entered.resolve(); await gate.promise; } return store.admit(...input); },
      getRoute: async (key) => { if (boundary === 'route') { entered.resolve(); await gate.promise; } return store.getRoute(key); },
      close: async () => { closes++; await closeGate.promise; await store.close(); },
    };
  }, openDeliveryJournal: (...args) => {
    const journal = openDeliveryJournal(...args); return { ...journal,
      begin: async (input) => { if (boundary === 'begin') { entered.resolve(); await gate.promise; } return journal.begin(input); },
      settle: async (...input) => { if (boundary === 'settle') { entered.resolve(); await gate.promise; } return journal.settle(...input); },
      close: async () => { closes++; await closeGate.promise; journal.close(); throw new Error('private-close-failure'); },
    };
  } });
  let req: ReturnType<typeof request> | undefined;
  try {
    assert.equal(hooked, true, 'runtime must use the trusted owned-storage port');
    req = request({ host: '127.0.0.1', port: boundary === 'admit' ? runtime.port : runtime.outboundPort!, method: 'POST',
      path: boundary === 'admit' ? '/api/messages' : '/v1/deliveries', headers: { 'Content-Type': 'application/json',
        Authorization: `Bearer ${boundary === 'admit' ? auth.token() : f.config.outbound!.bearerToken}` } }, (res) => res.resume());
    req.on('error', () => {}); req.end(JSON.stringify(boundary === 'admit' ? activity() : finalDelivery));
    await entered.promise; req.destroy(); const stopping = runtime.stop().finally(() => { stopped = true; }); void stopping.catch(() => {});
    await turn(); assert.equal(closes, 0); assert.equal(stopped, false);
    gate.resolve(); await turn(); await turn(); assert.equal(stopped, false);
    closeGate.resolve(); await assert.rejects(stopping, { message: 'Ingress storage failed' });
    await assert.rejects(runtime.done, { message: 'Ingress storage failed' }); assert.equal(closes, 2);
    assert.equal(posts, boundary === 'settle' ? 1 : 0);
    const store = openIngressStore(f.config.dbPath, scope); store.close();
    const journal = openDeliveryJournal(f.config.outbound!.dbPath, journalScope);
    if (boundary === 'settle') assert.deepEqual(journal.begin(finalDelivery), { kind: 'delivered', providerMessageId: 'runtime-async-receipt' });
    journal.close();
  } finally { req?.destroy(); gate.resolve(); closeGate.resolve(); await runtime.stop().catch(() => {}); }
});
