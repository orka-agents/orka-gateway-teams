import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { createTableDeliveryJournal } from '../src/delivery/table-journal.js';
import { createDeliveryDispatcher } from '../src/outbound/dispatcher.js';
import { fixtureProviderSender, providerServiceUrl } from './support/table-delivery-provider.js';
import { opened, request, scope } from './support/table-delivery.js';
import { deferred, eventually, tableBinding } from './support/table-service.js';
import { httpsFixture } from './support/ingress-https.js';

for (const scenario of ['receipt', 'late-token', 'late-receipt'] as const) test(`real SDK provider ${scenario}: retirement precedes queued Table finalization, no late duplicate POST`, { timeout: 20000 }, async t => {
  const { s, j } = await opened(t); const token = deferred<string>(); const tokenEntered = deferred();
  const blockerGate = deferred(); const blockerEntered = deferred(); const providerGate = deferred(); const providerEntered = deferred();
  let posts = 0; let finalizing = false; let permission: AbortSignal | undefined; let retiredAtEntry = false;
  let responseFinished = false; let shutdownFinished = false; let held = false;
  const tls = await httpsFixture(t, async (req, res) => {
    posts++; for await (const _chunk of req) { /* Consume private bytes without retaining/logging them. */ }
    providerEntered.resolve(); if (scenario === 'late-receipt') await providerGate.promise;
    res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"id":"real-provider-receipt"}');
  });
  const sender = fixtureProviderSender(tls.baseUrl, tls.ca, () => { tokenEntered.resolve(); return token.promise; });
  const route = { serviceUrl: providerServiceUrl, channelId: 'msteams' as const, bot: { id: 'bot-fixture', role: 'bot' as const },
    conversation: { id: request.contextId, tenantId: scope.tenantId, conversationType: 'personal' as const } };
  const dispatcher = createDeliveryDispatcher({ scope, getRoute: () => route, serviceUrls: [providerServiceUrl], recipientIds: [route.bot.id],
    sender: { send(saved, message, context) { permission = context?.signal; return sender.send(saved, message, context); }, stop: () => sender.stop() },
    journal: {
      begin: r => j.begin(r), close: () => j.close(),
      settle(c, o) { retiredAtEntry = permission?.aborted === true; finalizing = true; return j.settle(c, o); },
    },
  });
  const abort = new AbortController();
  const delivering = dispatcher.deliver(request, { signal: abort.signal }).then(r => { responseFinished = true; return r; });
  await tokenEntered.promise;
  s.controls.hook = async e => { if (!held && e.req.method === 'GET') { held = true; blockerEntered.resolve(); await blockerGate.promise; } e.reply(); };
  // A real preceding journal operation owns the FIFO. No mock begin/settle result.
  const blocker = j.begin({ ...request, idempotencyId: 'unrelated', deliveryId: 'unrelated' }); await blockerEntered.promise;
  if (scenario === 'late-token') abort.abort();
  else { token.resolve('synthetic.provider.token'); await providerEntered.promise; if (scenario === 'late-receipt') abort.abort(); }
  await eventually(() => finalizing);
  assert.equal(retiredAtEntry, true); assert.equal(responseFinished, false); assert.equal(j.status().pending, 2);
  assert.equal(posts, scenario === 'late-token' ? 0 : 1);
  if (scenario === 'late-token') { token.resolve('synthetic.provider.token'); await turn(); assert.equal(posts, 0); }
  if (scenario === 'late-receipt') { providerGate.resolve(); await turn(); assert.equal(posts, 1); }
  const stop = dispatcher.stop().then(() => { shutdownFinished = true; }); await turn(); assert.equal(shutdownFinished, false);
  blockerGate.resolve(); await blocker; delete s.controls.hook;
  const result = await delivering; await stop;
  assert.equal(result.status, scenario === 'receipt' ? 'delivered' : scenario === 'late-token' ? 'retryableError' : 'nonRetryableError');
  assert.equal(posts, scenario === 'late-token' ? 0 : 1);
  await j.close(); const next = createTableDeliveryJournal(tableBinding, s.dependencies); await next.open();
  const replay = await next.begin(request);
  assert.equal(replay.kind, scenario === 'receipt' ? 'delivered' : scenario === 'late-token' ? 'claimed' : 'unknown');
  await next.close();
});

test('real sender cannot POST after a begin caller timer; dispatcher stop owns actual Table drain', { timeout: 20000 }, async t => {
  const { s, j: initializedJournal } = await opened(t); await initializedJournal.close();
  const gate = deferred<string>(); let hold = false; let tokenStarted = false;
  const j = createTableDeliveryJournal(tableBinding, { ...s.dependencies, token: async (...args) => {
    if (hold) { hold = false; tokenStarted = true; return gate.promise; } return s.dependencies.token(...args);
  } }, { kernel: { callTimeoutMs: 1500, cleanupTimeoutMs: 15000 } }); await j.open();
  let posts = 0; const tls = await httpsFixture(t, (req, res) => { posts++; req.resume(); res.end('{"id":"impossible"}'); });
  const sender = fixtureProviderSender(tls.baseUrl, tls.ca, async () => 'synthetic.provider.token');
  const route = { serviceUrl: providerServiceUrl, channelId: 'msteams' as const, bot: { id: 'bot-fixture', role: 'bot' as const },
    conversation: { id: request.contextId, tenantId: scope.tenantId, conversationType: 'personal' as const } };
  const dispatcher = createDeliveryDispatcher({ journal: j, sender, scope, getRoute: () => route, serviceUrls: [providerServiceUrl], recipientIds: [route.bot.id] });
  hold = true; let responded = false; let stopped = false;
  const delivery = dispatcher.deliver(request).then(r => { responded = true; return r; });
  await eventually(() => tokenStarted); await eventually(() => j.status().lifecycle === 'failed');
  const stop = dispatcher.stop().then(() => { stopped = true; }); await turn();
  assert.equal(responded, false); assert.equal(stopped, false); assert.equal(posts, 0);
  gate.resolve('synthetic.private.table.canary'); await delivery; await stop; await j.close(); assert.equal(posts, 0);
});
