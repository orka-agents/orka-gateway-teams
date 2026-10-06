import assert from 'node:assert/strict';
import test from 'node:test';
import { encode, digest, fingerprint, validateEvent, validateRoute } from '../src/ingress/codec.js';
import { InboxIndex } from '../src/ingress/table-index.js';
import { validateRouteInput, writeRoute, readRoute, E } from '../src/ingress/table-index-slots.js';
import { auditInbox } from '../src/ingress/table-audit.js';
import { encodeRoute } from '../src/ingress/table-codec.js';
import { createTableIngressStore } from '../src/ingress/table-store.js';
import { reclaimTableIngress } from '../src/ingress/table-recovery.js';
import type { ReplyRoute } from '../src/ingress/types.js';
import { admissionSources, admissionBound, admission } from '../src/ingress/table-input.js';
import { pair, inboxOwned, install, auditBudget, indexBudget, wireData } from './support/table-ingress-audit.js';
import { ingressBinding } from './support/table-service.js';
import { stateFixture } from './support/table-ingress.js';
import { opened, options, code, payload, rowKey } from './support/table-ingress-store.js';

function shared(kind: 'groupChat' | 'channel', id = 'event-a', target = 'target-a', order = 1) {
  const p = pair(id, target, order);
  p.event.body = { ...p.event.body!, sender: { id: 'aad-requester', displayName: 'Winner' }, ...(kind === 'channel' ? { threadId: 'root' } : {}) };
  p.route.route = { ...p.route.route, conversation: { ...p.route.route.conversation, conversationType: kind },
    requester: { ...p.event.body.sender }, ...(kind === 'channel' ? { threadId: 'root' } : {}) } as ReplyRoute;
  p.event.bodyDigest = digest(encode(p.event.body)); p.event.fingerprint = fingerprint(p.event.body, p.route.route, ingressBinding.scope as never);
  p.route.routeDigest = digest(encode(p.route.route)); return p;
}
const version = { etag: '"v1"', digest: 'ab'.repeat(32), timestamp: '2025-01-02T03:04:05Z' };

for (const kind of ['groupChat', 'channel'] as const) {
  test(`${kind} Table boundary snapshots requester and channel thread within the charged admission bound`, () => {
    const p = shared(kind); const source = admissionSources(p.event.body!, p.route.route);
    assert.ok(admissionBound(source) >= encode({ event: p.event.body, route: p.route.route }).length);
    const command = admission(source, ingressBinding.scope as never);
    assert.equal(command.operation, 'admit');
    if (command.operation !== 'admit') throw new Error('Expected admission');
    assert.deepEqual(command.route, p.route.route);
    (p.route.route as typeof p.route.route & { requester: { id: string } }).requester.id = 'mutated';
    assert.equal((command.route as typeof command.route & { requester: { id: string } }).requester.id, 'aad-requester');
  });

  test(`${kind} native Table admission preserves winning label/key across duplicates, concurrent senders and completed restart`, async t => {
    const { s, j } = await opened(t); const p = shared(kind);
    assert.equal((await j.admit(p.event.body!, p.route.route)).kind, 'accepted');
    const duplicate = { ...p.event.body!, replyTarget: 'loser', sender: { id: 'aad-requester', displayName: 'Later' } };
    const candidate = { ...p.route.route, requester: duplicate.sender, serviceUrl: 'https://later.example.invalid/' } as ReplyRoute;
    assert.equal((await j.admit(duplicate, candidate)).kind, 'duplicate'); assert.equal(await j.getRoute('loser'), undefined);
    const inputs = ['sender-b', 'sender-c'].map((id, n) => shared(kind, id, 'target-' + id, n + 2));
    inputs.forEach((v, n) => {
      v.event.body!.sender = { id: 'aad-' + n, displayName: 'Person ' + n };
      v.route.route = { ...v.route.route, requester: { ...v.event.body!.sender } } as ReplyRoute;
    });
    const results = await Promise.all(inputs.map(v => j.admit(v.event.body!, v.route.route)));
    assert.ok(results.every(r => r.kind === 'accepted'));
    assert.deepEqual(await j.getRoute(p.target), p.route.route);
    for (const v of inputs) assert.deepEqual(await j.getRoute(v.target), v.route.route);
    const g = await j.claimForForwarding(); assert.ok(g); assert.deepEqual(g.claim.event, p.event.body);
    assert.equal(await j.complete(g.claim, { status: 'accepted', eventId: 'receipt', state: 'Queued' }), true);
    assert.equal(payload(s.rows.get(rowKey('event', p.id))!).body, null);
    assert.equal((await j.admit(duplicate, candidate)).kind, 'duplicate');
    const other = { ...p.event.body!, sender: { id: 'other' } };
    assert.equal((await j.admit(other, { ...p.route.route, requester: other.sender } as ReplyRoute)).kind, 'conflict');
    await j.close(); const next = createTableIngressStore(ingressBinding, s.dependencies, options);
    await next.open(); t.after(() => next.close().catch(() => undefined));
    assert.deepEqual(await next.getRoute(p.target), p.route.route);
    assert.equal((await next.admit(duplicate, candidate)).kind, 'duplicate');
  });

  test(`${kind} full two-pass native audit reconstructs only bounded shared identity evidence`, async t => {
    const { k } = await inboxOwned(t); const p = shared(kind);
    await install(k, { state: stateFixture(), pairs: [p] });
    const result = await auditInbox(k, ingressBinding, auditBudget, indexBudget);
    try {
      const r = result.index.routeByTarget(p.target)!;
      assert.equal(r.conversationType, kind); assert.equal(r.requesterId, 'aad-requester');
      assert.equal(r.threadId, kind === 'channel' ? 'root' : undefined);
      for (const key of ['body', 'route', 'serviceUrl', 'displayName', 'requester']) assert.equal(key in r, false);
    } finally { result.dispose(); await k.close(); }
  });
}

test('maximum UTF8 shared identity summary fits one unchanged 4096 slot and preserves all old evidence', () => {
  const p = shared('channel'); const id = 'é'.repeat(128), target = '界'.repeat(85) + 'x';
  const e = { ...p.event, externalEventId: id, replyTarget: target }; const { body: _body, ...event } = e;
  const input = { externalEventId: id, replyTarget: target, botId: 'b'.repeat(256), conversationId: 'c'.repeat(256),
    conversationType: 'channel' as const, threadId: '界'.repeat(85) + 't', requesterId: 'é'.repeat(128),
    routeDigest: 'ef'.repeat(32), routeEncodingBytes: 16384, payloadBytes: 16384 };
  const index = new InboxIndex(indexBudget); index.begin();
  try {
    index.addEvent({ event, version, bodyEncodingBytes: 1000, payloadBytes: 1500 });
    index.addRoute({ ...input, version }); assert.deepEqual(index.routeByTarget(target), input);
    assert.equal(index.eventById(id)!.fingerprint, event.fingerprint);
    assert.equal(index.eventById(id)!.bodyDigest, event.bodyDigest);
    assert.equal(index.diagnostics().chargedBytes, 4194304 + 4132);
    const b = Buffer.alloc(4096); writeRoute(b, input);
    // Legacy IDs are written by event enrollment, not by route enrollment.
    assert.equal(b.readUInt32LE(E.routeLength), 16384); assert.equal(readRoute(b, 0).requesterId, input.requesterId);
  } finally { index.dispose(); }
});

test('maximum escaped shared channel input retains exact identities/profile through native admission and restart under existing caps', async t => {
  const { s, j } = await opened(t); const p = shared('channel', 'event-max', 'target-max');
  const prefix = 'https://synthetic.example.invalid/';
  const event = validateEvent({ ...p.event.body!, contextId: '\\'.repeat(256), threadId: '"'.repeat(256),
    sender: { id: '"'.repeat(256), displayName: '\\'.repeat(256) }, text: '"'.repeat(65536) });
  const route = validateRoute({ ...p.route.route, serviceUrl: prefix + 'x'.repeat(2048 - prefix.length - 1) + '/',
    bot: { id: 'b'.repeat(256), role: 'bot' }, conversation: { id: event.contextId, conversationType: 'channel', tenantId: event.accountId },
    requester: { ...event.sender }, threadId: event.threadId });
  assert.equal((await j.admit(event, route)).kind, 'accepted');
  assert.deepEqual(await j.getRoute(event.replyTarget), route);
  const g = await j.claimForForwarding(); assert.ok(g); assert.deepEqual(g.claim.event, event);
  assert.equal(await j.retry(g.claim, 0), true); await j.close();
  const next = createTableIngressStore(ingressBinding, s.dependencies, options); await next.open();
  try { assert.deepEqual(await next.getRoute(event.replyTarget), route); }
  finally { await next.close(); }
});

test('Table route encoder rejects accessor-backed shared requester without executing it', () => {
  const p = shared('groupChat'); let reads = 0;
  Object.defineProperty(p.route.route.requester!, 'id', { enumerable: true, get() { reads++; return 'aad-requester'; } });
  assert.throws(() => encodeRoute({ type: 'route', id: p.target }, p.route), code('invalid-input'));
  assert.equal(reads, 0);
});

for (const fault of ['kind', 'thread-length', 'requester-length', 'missing-requester', 'missing-thread'] as const) {
  test(`packed route read refuses corrupt ${fault} evidence rather than treating it as personal`, () => {
    const b = Buffer.alloc(4096);
    writeRoute(b, { externalEventId: 'event', replyTarget: 'target', botId: 'bot', conversationId: 'chat', conversationType: 'channel',
      requesterId: 'person', threadId: 'root', routeDigest: 'ef'.repeat(32), routeEncodingBytes: 500, payloadBytes: 700 });
    if (fault === 'kind') b[E.conversationType] = 255;
    else b.writeUInt16LE(fault.startsWith('missing') ? 0 : 257,
      fault.includes('requester') ? E.requesterLength : E.threadLength);
    assert.throws(() => readRoute(b, 0));
  });
}

test('null summary kind cannot default to historical personal', () => {
  assert.throws(() => validateRouteInput({ externalEventId: 'event', replyTarget: 'target', botId: 'bot', conversationId: 'chat',
    conversationType: null, routeDigest: 'ef'.repeat(32), routeEncodingBytes: 500, payloadBytes: 700 } as never));
});

for (const patch of [
  { conversationType: null }, { conversationType: 'unknown' }, { conversationType: 'groupChat', threadId: 'root' },
  { conversationType: 'personal', requesterId: 'person', threadId: undefined }, { requesterId: undefined },
  { requesterId: '' }, { requesterId: 'é'.repeat(129) }, { threadId: undefined }, { threadId: 'x'.repeat(257) },
]) test('packed shared route summary refuses invalid kind/thread/requester before write', () => {
  const p = shared('channel');
  const input = { externalEventId: p.id, replyTarget: p.target, botId: 'bot', conversationId: 'chat', conversationType: 'channel',
    requesterId: 'person', threadId: 'root', routeDigest: 'ef'.repeat(32), routeEncodingBytes: 500, payloadBytes: 700, ...patch };
  assert.throws(() => validateRouteInput(input as never));
});
for (const field of ['requester', 'threadId'] as const) test(`native audit refuses digest-valid route ${field} mismatch`, async t => {
  const { k } = await inboxOwned(t); const p = shared('channel');
  p.route.route = { ...p.route.route, ...(field === 'requester' ? { requester: { id: 'other' } } : { threadId: 'other' }) } as ReplyRoute;
  p.route.routeDigest = digest(encode(p.route.route)); await install(k, { state: stateFixture(), pairs: [p] });
  await assert.rejects(auditInbox(k, ingressBinding, auditBudget, indexBudget)); await assert.rejects(k.close(), code('unresolved'));
});
for (const kind of ['groupChat', 'channel'] as const) test(`foreign/recovery ${kind} audits preserve the winning shared route`, async t => {
  const { s, k } = await inboxOwned(t); const p = shared(kind);
  await install(k, { state: stateFixture(), pairs: [p] }); const m = await k.read('M'); assert.ok(m);
  if (m.value.kind !== 'metadata') throw new Error('Expected metadata');
  const fence = { initId: m.value.initId, initDigest: m.value.initDigest, owner: m.value.owner, epoch: m.value.epoch, mDigest: m.value.digest, etag: m.etag };
  const before = payload(s.rows.get(rowKey('route', p.target))!);
  await reclaimTableIngress(ingressBinding, s.dependencies, fence, auditBudget, indexBudget, 'd'.repeat(64));
  assert.deepEqual(payload(s.rows.get(rowKey('route', p.target))!), before);
  const next = createTableIngressStore(ingressBinding, s.dependencies, options); await next.open();
  try { assert.deepEqual(await next.getRoute(p.target), p.route.route); }
  finally { await next.close(); await assert.rejects(k.close(), code('unresolved')); }
});

for (const field of ['requesterId', 'threadId'] as const) test(`fresh Table planner refuses corrupted ${field} summary even with unchanged payload/version`, async t => {
  const { s, j } = await opened(t); const p = shared('channel'); await j.admit(p.event.body!, p.route.route);
  const lookup = InboxIndex.prototype.routeByTarget; const writes = s.stats.writes;
  t.mock.method(InboxIndex.prototype, 'routeByTarget', function (this: InboxIndex, target: string) {
    const route = lookup.call(this, target); return route ? { ...route, [field]: 'corrupted' } : route;
  });
  await assert.rejects(j.getRoute(p.target), code('corrupt')); assert.equal(s.stats.writes, writes);
  await assert.rejects(j.close(), code('unresolved'));
});

for (const field of ['requester', 'threadId'] as const) test(`confirmed shared ${field} byte drift refuses publication rather than adopting a changed route`, async t => {
  const { s, j } = await opened(t); const p = shared('channel'); let changed = false;
  s.controls.hook = e => {
    if (!changed && s.rows.has(rowKey('route', p.target)) && e.path.includes("RowKey='route_")) {
      changed = true;
      const altered = { ...p.route, route: { ...p.route.route, ...(field === 'requester' ? { requester: { id: 'other' } } : { threadId: 'other' }) } };
      altered.routeDigest = digest(encode(altered.route));
      s.rows.set(rowKey('route', p.target), wireData(s, 'route', p.target, encode(altered)));
    }
    e.reply();
  };
  await assert.rejects(j.admit(p.event.body!, p.route.route)); delete s.controls.hook;
  assert.equal(changed, true); assert.notEqual(j.status().lifecycle, 'ready'); assert.equal(j.status().index?.events, 0);
  await assert.rejects(j.close(), code('unresolved'));
});
