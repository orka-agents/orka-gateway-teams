import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import { createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import { initializeSessionCorrelation, openSessionCorrelation } from '../src/delivery/sqlite-session-correlation.js';
import type { SessionCorrelationPort } from '../src/delivery/session-correlation.js';
import type { DeliveryJournalPort } from '../src/delivery/types.js';
import type { ReplyRoute } from '../src/ingress/types.js';
import { createDeliveryDispatcher } from '../src/outbound/dispatcher.js';
import type { DispatcherOptions } from '../src/outbound/types.js';
import type { OutgoingTeamsMessage } from '../src/teams/format.js';
import { finalDelivery } from './fixtures/outgoing.js';
import { deferred } from './support/ingress-auth.js';
import { tableBinding, tableService } from './support/table-service.js';

const scope = { appId: 'shared-app', tenantId: finalDelivery.accountId };
const route: ReplyRoute = { serviceUrl: 'https://smba.trafficmanager.net/teams/', channelId: 'msteams', bot: { id: 'bot', role: 'bot' },
  conversation: { id: '19:room;messageid=root', conversationType: 'channel', tenantId: scope.tenantId }, threadId: 'root',
  requester: { id: 'synthetic-aad', displayName: '[Alice]*' } };
const first = { ...finalDelivery, contextId: route.conversation.id, threadId: 'root', originatingEventId: 'origin-first' };
const success = { status: 'delivered', providerMessageId: 'receipt' };
function another(n: string, origin = n) { return { ...first, idempotencyId: `op-${n}`, deliveryId: `delivery-${n}`, originatingEventId: origin }; }
function text(message: OutgoingTeamsMessage) { return JSON.stringify(message); }

async function fixture(t: test.TestContext, backend: 'sqlite' | 'table') {
  const dir = mkdtempSync(join(tmpdir(), 'shared-dispatch-'));
  let journal: DeliveryJournalPort; let correlation: SessionCorrelationPort & { close(): void | Promise<void> };
  const messages: OutgoingTeamsMessage[] = []; const dispatchers: ReturnType<typeof createDeliveryDispatcher>[] = [];
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
  const service = backend === 'table' ? await tableService(t, 'delivery', 2, scope) : undefined;
  const path = join(dir, 'journal.sqlite'); const sidecar = join(dir, 'correlation.sqlite');
  if (backend === 'sqlite') { initializeDeliveryJournal(path, scope); initializeSessionCorrelation(sidecar, scope); }
  else { const init = createTableDeliveryJournalV2({ ...tableBinding, kind: 'delivery', scope }, service!.dependencies, { maxSessions: 2 }); await init.initialize(); await init.close(); }
  async function open() {
    if (backend === 'sqlite') { journal = openDeliveryJournal(path, scope); correlation = openSessionCorrelation(sidecar, scope, { maxSessions: 2 }); }
    else { const handle = createTableDeliveryJournalV2({ ...tableBinding, kind: 'delivery', scope }, service!.dependencies, { maxSessions: 2 }); journal = correlation = handle; await handle.open(); }
  }
  async function close() { for (const d of dispatchers) await d.stop(); await journal.close(); await correlation.close(); }
  await open();
  return { messages, get journal() { return journal; }, get correlation() { return correlation; },
    async restart() { await close(); await open(); },
    create(overrides: Partial<Omit<DispatcherOptions, 'correlation'>> & { correlation?: SessionCorrelationPort | undefined } = {}) {
      const { correlation: supplied, ...rest } = overrides;
      const selected = Object.hasOwn(overrides, 'correlation') ? supplied : correlation;
      const d = createDeliveryDispatcher({ journal, ...(selected === undefined ? {} : { correlation: selected }), scope, getRoute: () => structuredClone(route),
        serviceUrls: [route.serviceUrl], recipientIds: ['bot'], sender: { send: async (_route, message) => { messages.push(message); return { kind: 'delivered', providerMessageId: 'receipt' }; }, stop: async () => {} }, ...rest });
      dispatchers.push(d); return d;
    } };
}

for (const backend of ['sqlite', 'table'] as const) {
  test(`${backend}: durable origin evidence, concurrent senders, alias/restart replay and first-origin stability`, async (t) => {
    const f = await fixture(t, backend);
    const dispatcher = f.create({ getRoute: key => ({ ...route, requester: key === 'route-second' ? { id: 'synthetic-aad-bob', displayName: 'Bob' } :
      key === 'route-third' ? { id: 'synthetic-aad-charlie', displayName: 'Charlie' } : { ...route.requester! } }) });
    assert.deepEqual(await dispatcher.deliver(first), success);
    assert.ok(text(f.messages[0]!).includes('Asked by \\\\[Alice\\\\]\\\\*'));
    assert.ok(!text(f.messages[0]!).includes('synthetic-aad')); assert.equal(f.messages[0]!.replyToId, 'root');
    assert.ok(!text(f.messages[0]!).includes('Continuing'));
    const results = await Promise.all([dispatcher.deliver({ ...another('second'), replyTarget: 'route-second' }), dispatcher.deliver({ ...another('third'), replyTarget: 'route-third' })]);
    for (const result of results) assert.deepEqual(result, success);
    for (const message of f.messages.slice(1)) assert.ok(text(message).includes("Continuing the room's conversation"));
    assert.ok(f.messages.slice(1).some(message => text(message).includes('Asked by Bob')));
    assert.ok(f.messages.slice(1).some(message => text(message).includes('Asked by Charlie')));
    assert.deepEqual(await dispatcher.deliver(another('first-again', 'origin-first')), success);
    assert.ok(!text(f.messages.at(-1)!).includes('Continuing'));
    await f.restart(); const replay = f.create({ getRoute: () => { throw new Error('receipt must precede route'); }, correlation: { observeSession() { throw new Error('receipt must precede observation'); } } });
    assert.deepEqual(await replay.deliver({ ...first, deliveryId: 'restart-alias' }), success); assert.equal(replay.healthy, true);
    const next = f.create(); assert.deepEqual(await next.deliver(another('after-restart')), success);
    assert.ok(text(f.messages.at(-1)!).includes("Continuing the room's conversation"));
  });

  test(`${backend}: exact room and thread identities cannot borrow another Session's continuation`, async (t) => {
    const f = await fixture(t, backend);
    const baseRoute: ReplyRoute = { ...route, conversation: { ...route.conversation, id: '19:shared-channel' } };
    assert.deepEqual(await f.create({ getRoute: () => baseRoute }).deliver({ ...first, contextId: baseRoute.conversation.id }), success);
    const otherThread: ReplyRoute = { ...baseRoute, threadId: 'different-root' };
    assert.deepEqual(await f.create({ getRoute: () => otherThread }).deliver({ ...another('other-thread'), contextId: baseRoute.conversation.id, threadId: 'different-root' }), success);
    assert.ok(!text(f.messages[1]!).includes('Continuing'));
    const otherRoom: ReplyRoute = { ...route, conversation: { ...route.conversation, id: '19:another-room;messageid=root' } };
    assert.equal((await f.create({ getRoute: () => otherRoom }).deliver({ ...another('other-room'), contextId: otherRoom.conversation.id })).status, 'retryableError');
    assert.equal(f.messages.length, 2);
  });

  test(`${backend}: room/thread/namespace isolation and capacity backpressure leave health and receipt replay usable`, async (t) => {
    const f = await fixture(t, backend); const d = f.create();
    assert.deepEqual(await d.deliver(first), success);
    assert.deepEqual(await d.deliver({ ...another('namespace'), sessionRef: { namespace: 'different', name: first.sessionRef!.name } }), success);
    assert.ok(!text(f.messages[1]!).includes('Continuing'));
    const newSession = { ...another('full'), sessionRef: { namespace: 'different', name: 'third' } };
    assert.equal((await d.deliver(newSession)).status, 'retryableError'); assert.equal(f.messages.length, 2); assert.equal(d.healthy, true);
    assert.deepEqual(await d.deliver({ ...first, deliveryId: 'alias-at-cap' }), success);
    assert.deepEqual(await d.deliver(another('existing-at-cap')), success); assert.equal(f.messages.length, 3);
    assert.ok(text(f.messages[2]!).includes('Continuing'));
  });
}

test('missing evidence and sessionRef never invent continuation; group/personal reject threads and channel requires exact saved root', async (t) => {
  const f = await fixture(t, 'sqlite');
  const absent = f.create({ correlation: undefined }); assert.deepEqual(await absent.deliver(first), success);
  assert.ok(!text(f.messages[0]!).includes('Continuing'));
  const { sessionRef: _session, ...noSession } = another('no-session'); assert.deepEqual(await f.create().deliver(noSession), success);
  assert.ok(!text(f.messages[1]!).includes('Continuing'));
  for (const threadId of ['', 'different']) assert.equal((await f.create().deliver({ ...another(`bad-${threadId}`), threadId })).status, 'nonRetryableError');
  const group: ReplyRoute = { ...route, conversation: { ...route.conversation, conversationType: 'groupChat' }, threadId: undefined } as unknown as ReplyRoute;
  delete group.threadId;
  assert.equal((await f.create({ getRoute: () => group }).deliver(another('group-bad'))).status, 'nonRetryableError');
  const { threadId: _thread, ...groupRequest } = another('group-ok');
  assert.deepEqual(await f.create({ getRoute: () => group }).deliver(groupRequest), success);
  assert.equal(f.messages.at(-1)!.replyToId, undefined);
  assert.ok(!text(f.messages.at(-1)!).includes('Continuing'));
});

test('closed real correlation poisons dispatcher with no provider effect; stop drains pending observations', async (t) => {
  const f = await fixture(t, 'sqlite'); await f.correlation.close(); const d = f.create();
  assert.equal((await d.deliver(first)).status, 'retryableError'); assert.equal(d.healthy, false); assert.equal(f.messages.length, 0);
  await f.restart(); const entered = deferred<void>(); const release = deferred<void>();
  const waiting = f.create({ correlation: { async observeSession(input) { entered.resolve(); await release.promise; return f.correlation.observeSession(input); } } });
  const pending = waiting.deliver(another('waiting')); await entered.promise;
  let stopped = false; const stopping = waiting.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false);
  release.resolve(); assert.equal((await pending).status, 'retryableError'); await stopping; assert.equal(f.messages.length, 0);
  // A cancelled local observation still establishes immutable first-origin evidence by design.
  assert.deepEqual(await f.create().deliver(another('later')), success); assert.ok(text(f.messages[0]!).includes('Continuing'));
});
