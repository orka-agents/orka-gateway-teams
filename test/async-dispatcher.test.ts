import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { createDeliveryDispatcher } from '../src/outbound/dispatcher.js';
import { createProviderSender } from '../src/outbound/sender.js';
import { finalDelivery, finalMessage } from './fixtures/outgoing.js';
import { deferred } from './support/ingress-auth.js';

const scope = { appId: 'app-fixture', tenantId: finalDelivery.accountId };
const route = { serviceUrl: 'https://teams-service.example.invalid/', channelId: 'msteams' as const,
  bot: { id: 'bot-fixture', role: 'bot' as const }, conversation: { id: finalDelivery.contextId,
    conversationType: 'personal' as const, tenantId: scope.tenantId } };
const delivered = { kind: 'delivered', providerMessageId: 'async-receipt' } as const;

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-async-dispatch-')); const path = join(directory, 'delivery.sqlite');
  initializeDeliveryJournal(path, scope); const journal = openDeliveryJournal(path, scope);
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  let posts = 0; let body = '';
  const sender = createProviderSender(async () => randomUUID(), { post: async (_url, bytes) => {
    posts++; body = bytes.toString(); return { status: 201, data: Buffer.from('{"id":"async-receipt"}') };
  } });
  return { journal, sender, posts: () => posts, body: () => body, options: { journal, sender, scope,
    getRoute: () => route, serviceUrls: [route.serviceUrl], recipientIds: [route.bot.id] } };
}

for (const boundary of ['begin', 'route', 'settle'] as const) {
  test(`deferred ${boundary} holds response and stop until actual storage completion`, async (t) => {
    const f = fixture(t); const gate = deferred<void>(); const entered = deferred<void>(); let responded = false; let stopped = false;
    const options = { ...f.options, journal: {
      begin: async (request: Parameters<typeof f.journal.begin>[0]) => {
        if (boundary === 'begin') { entered.resolve(); await gate.promise; }
        return f.journal.begin(request);
      },
      settle: async (...args: Parameters<typeof f.journal.settle>) => {
        if (boundary === 'settle') { entered.resolve(); await gate.promise; }
        return f.journal.settle(...args);
      }, close: () => f.journal.close(),
    }, getRoute: async () => { if (boundary === 'route') { entered.resolve(); await gate.promise; } return route; } };
    const dispatcher = createDeliveryDispatcher(options);
    const pending = dispatcher.deliver(finalDelivery).then((value) => { responded = true; return value; });
    try {
      await turn();
      assert.equal(responded, false, 'must not report a result before durable work completes');
      await entered.promise;
      const stopping = dispatcher.stop().then(() => { stopped = true; });
      await turn(); assert.equal(stopped, false, 'stop must own unresolved storage work');
      gate.resolve(); const result = await pending; await stopping;
      assert.equal(result.status, boundary === 'settle' ? 'delivered' : 'retryableError');
      assert.equal(f.posts(), boundary === 'settle' ? 1 : 0);
    } finally { gate.resolve(); await pending; await dispatcher.stop(); }
  });
}

for (const boundary of ['begin', 'route'] as const) for (const loss of ['cancel', 'deadline'] as const) {
  test(`${loss} during async ${boundary} prevents the first provider POST`, async (t) => {
    const f = fixture(t); const gate = deferred<void>(); const entered = deferred<void>(); const abort = new AbortController();
    let now = performance.now(); const deadline = now + 50;
    // Expire at the selected storage barrier, not during unrelated filesystem
    // scheduling under the full suite. No timer turn is needed for enforcement.
    if (loss === 'deadline') t.mock.method(performance, 'now', () => now);
    const dispatcher = createDeliveryDispatcher({ ...f.options, journal: { ...f.journal,
      begin: async (request: Parameters<typeof f.journal.begin>[0]) => {
        if (boundary === 'begin') { entered.resolve(); await gate.promise; } return f.journal.begin(request);
      },
    }, getRoute: async () => { if (boundary === 'route') { entered.resolve(); await gate.promise; } return route; } });
    let responded = false;
    const pending = dispatcher.deliver(finalDelivery, { signal: abort.signal, ...(loss === 'deadline' ? { deadline } : {}) })
      .then((value) => { responded = true; return value; });
    try {
      await turn(); assert.equal(responded, false, 'claim/route must finish before responding');
      assert.equal(dispatcher.healthy, true, 'a pending operation is not storage poison');
      await entered.promise;
      if (loss === 'cancel') abort.abort(); else now = deadline;
      gate.resolve(); assert.equal((await pending).status, 'retryableError'); assert.equal(f.posts(), 0);
      assert.equal(f.journal.begin(finalDelivery).kind, 'claimed');
    } finally { gate.resolve(); await pending; await dispatcher.stop(); }
  });
}

test('snapshot precedes async begin; deferred history replay never consults current route policy', async (t) => {
  const f = fixture(t); const gate = deferred<void>(); let routes = 0;
  const dispatcher = createDeliveryDispatcher({ ...f.options, journal: { ...f.journal,
    begin: async (request: Parameters<typeof f.journal.begin>[0]) => { await gate.promise; return f.journal.begin(request); },
  }, getRoute: async () => { routes++; return route; } });
  const input = structuredClone(finalDelivery); const pending = dispatcher.deliver(input);
  input.text = 'changed'; input.contextId = 'other'; gate.resolve();
  try {
    assert.equal((await pending).status, 'delivered'); assert.equal(f.body(), JSON.stringify(finalMessage));
    assert.deepEqual(f.journal.begin(finalDelivery), delivered);
    assert.equal((await dispatcher.deliver({ ...finalDelivery, deliveryId: 'async-alias' })).status, 'delivered');
    assert.equal(routes, 1); assert.equal(f.posts(), 1);
  } finally { await dispatcher.stop(); }
});

test('uncancelled send permission is retired at journal settlement entry before stop', async (t) => {
  const f = fixture(t); const gate = deferred<void>(); const entry = deferred<boolean>();
  let attemptSignal: AbortSignal | undefined; let responded = false; let stopped = false;
  const dispatcher = createDeliveryDispatcher({ ...f.options, sender: {
    send(saved, message, context) {
      assert.ok(context?.signal); attemptSignal = context.signal;
      assert.equal(attemptSignal.aborted, false, 'the real sender starts with live permission');
      return f.sender.send(saved, message, context);
    }, stop: () => f.sender.stop(),
  }, journal: { ...f.journal,
    settle: async (...args: Parameters<typeof f.journal.settle>) => {
      // Capture at entry, before the storage await or any caller/stop abort can
      // disguise a missing dispatcher retirement fence.
      entry.resolve(attemptSignal?.aborted === true);
      await gate.promise; return f.journal.settle(...args);
    },
  } });
  const pending = dispatcher.deliver(finalDelivery).then((value) => { responded = true; return value; });
  try {
    assert.equal(await entry.promise, true, 'permission must be retired before journal.settle enters');
    assert.equal(f.posts(), 1); assert.equal(f.body(), JSON.stringify(finalMessage));
    assert.equal(f.journal.begin(finalDelivery).kind, 'inFlight');
    await turn(); assert.equal(responded, false);
    const stopping = dispatcher.stop().then(() => { stopped = true; });
    await turn(); assert.equal(stopped, false, 'stop must drain deferred receipt settlement');
    gate.resolve();
    assert.deepEqual(await pending, { status: 'delivered', providerMessageId: 'async-receipt' });
    await stopping; assert.deepEqual(f.journal.begin(finalDelivery), delivered); assert.equal(f.posts(), 1);
  } finally { gate.resolve(); await pending; await dispatcher.stop(); }
});

test('pre-effect cancellation retires send permission before deferred retry settlement and late token', async (t) => {
  const f = fixture(t); const token = deferred<string>(); const acquired = deferred<void>(); const settle = deferred<void>();
  const settling = deferred<void>(); let posts = 0;
  const sender = createProviderSender(() => { acquired.resolve(); return token.promise; }, { post: async () => {
    posts++; return { status: 201, data: Buffer.from('{"id":"late-receipt"}') };
  } });
  const dispatcher = createDeliveryDispatcher({ ...f.options, sender, journal: { ...f.journal,
    settle: async (...args: Parameters<typeof f.journal.settle>) => { settling.resolve(); await settle.promise; return f.journal.settle(...args); },
  } });
  const abort = new AbortController(); let responded = false;
  const pending = dispatcher.deliver(finalDelivery, { signal: abort.signal }).then((value) => { responded = true; return value; });
  try {
    await acquired.promise; abort.abort(); await settling.promise; await turn();
    assert.equal(responded, false);
    token.resolve(randomUUID()); await turn(); assert.equal(posts, 0);
    settle.resolve(); assert.equal((await pending).status, 'retryableError');
    assert.equal(f.journal.begin(finalDelivery).kind, 'claimed');
  } finally { token.resolve(randomUUID()); settle.resolve(); await pending; await dispatcher.stop(); await f.sender.stop(); }
});
