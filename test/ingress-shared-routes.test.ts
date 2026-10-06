import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { encode, fingerprint, matchRoute, validateEvent, validateRoute } from '../src/ingress/codec.js';
import { IngressStoreError, initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import type { ReplyRoute } from '../src/ingress/types.js';
import { expectedEvent } from './fixtures/incoming.js';

const scope = { appId: 'app-fixture', tenantId: expectedEvent.accountId, orkaBaseUrl: 'https://orka.example.invalid/', gatewayNamespace: 'default', gatewayName: 'teams' };
const personal: ReplyRoute = { serviceUrl: 'https://teams-service.example.invalid/', channelId: 'msteams', bot: { id: '28:fixture-app', role: 'bot' },
  conversation: { id: expectedEvent.contextId, conversationType: 'personal', tenantId: scope.tenantId } };
const legacyBytes = '{"serviceUrl":"https://teams-service.example.invalid/","channelId":"msteams","bot":{"id":"28:fixture-app","role":"bot"},"conversation":{"id":"19:fixture-personal","conversationType":"personal","tenantId":"11111111-1111-4111-8111-111111111111"}}';
const invalid = (error: unknown) => error instanceof IngressStoreError && error.code === 'invalid-input';
function shared(kind: 'groupChat' | 'channel') {
  const event = { ...expectedEvent, contextId: '19:room', sender: { id: 'aad-requester', displayName: 'Original Profile' }, ...(kind === 'channel' ? { threadId: 'root' } : {}) };
  const route = { ...personal, conversation: { ...personal.conversation, id: event.contextId, conversationType: kind },
    requester: { ...event.sender }, ...(kind === 'channel' ? { threadId: 'root' } : {}) } as ReplyRoute;
  return { event, route };
}
function database(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-shared-routes-')); const path = join(directory, 'inbox.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true })); initializeIngressStore(path, scope); return path;
}

test('golden personal route bytes and fingerprint remain readable across actual SQLite restart', t => {
  assert.equal(encode(validateRoute(personal)).toString(), legacyBytes);
  assert.equal(fingerprint(expectedEvent, personal, scope), '91c8ddc4a169726530b91fd831273da93d87d4196d79272f0dc8e424c2d469c0');
  const path = database(t); const store = openIngressStore(path, scope); store.admit(expectedEvent, personal); store.close();
  const raw = new DatabaseSync(path);
  try {
    assert.equal(Buffer.from(raw.prepare('SELECT body FROM routes').get()!.body as Uint8Array).toString(), legacyBytes);
    assert.equal(raw.prepare('SELECT fingerprint FROM inbox').get()!.fingerprint, '91c8ddc4a169726530b91fd831273da93d87d4196d79272f0dc8e424c2d469c0');
  } finally { raw.close(); }
  const reopened = openIngressStore(path, scope);
  try { assert.deepEqual(reopened.claim()?.event, expectedEvent); assert.equal(encode(reopened.getRoute(expectedEvent.replyTarget)).toString(), legacyBytes); }
  finally { reopened.close(); }
});

for (const kind of ['groupChat', 'channel'] as const) {
  test(`${kind} route is closed, validates normalized requester/thread and snapshots its winning profile`, t => {
    const { event, route } = shared(kind);
    assert.deepEqual(validateRoute(route), route); assert.deepEqual(validateEvent(event), event); matchRoute(event, route, scope);
    const path = database(t); const store = openIngressStore(path, scope);
    try {
      assert.equal(store.admit(event, route).kind, 'accepted');
      const duplicate = { ...event, replyTarget: 'loser-key', sender: { ...event.sender, displayName: 'New Profile' } };
      const candidate = { ...route, requester: { ...duplicate.sender }, serviceUrl: 'https://other.example.invalid/' } as ReplyRoute;
      assert.deepEqual(store.admit(duplicate, candidate), { kind: 'duplicate', replyTarget: event.replyTarget });
      assert.deepEqual(store.getRoute(event.replyTarget), route); assert.equal(store.getRoute('loser-key'), undefined);
      const claim = store.claim()!; assert.deepEqual(claim.event, event);
      assert.equal(store.complete(claim, { status: 'accepted', eventId: 'receipt', state: 'Queued' }), true);
      assert.equal(store.admit(duplicate, candidate).kind, 'duplicate');
      assert.equal(store.admit({ ...event, text: 'different' }, route).kind, 'conflict');
      const other = { ...event, sender: { id: 'aad-other' } };
      assert.equal(store.admit(other, { ...route, requester: other.sender } as ReplyRoute).kind, 'conflict');
    } finally { store.close(); }
    const raw = new DatabaseSync(path); try { assert.equal(raw.prepare('SELECT body FROM inbox').get()?.body, null); } finally { raw.close(); }
    const reopened = openIngressStore(path, scope);
    try { assert.deepEqual(reopened.getRoute(event.replyTarget), route); assert.equal(reopened.admit(event, route).kind, 'duplicate'); }
    finally { reopened.close(); }
  });

  test(`${kind} shared duplicate fingerprint excludes profile/service/reply key but includes kind/requester/thread`, () => {
    const { event, route } = shared(kind);
    const original = fingerprint(event, route, scope);
    assert.equal(original, kind === 'groupChat' ? '0f53d9c2553ef659f5ac7e4947207092e8bb8a44a2a470978b3ce815e05e3ea7' : 'c7a6876b3b7d9b06d8cf17a08653fe140ff7247a1068719e215816aabe0ee34d');
    const candidate = { ...route, serviceUrl: 'https://other.example.invalid/', requester: { id: event.sender.id, displayName: 'Changed' } } as ReplyRoute;
    assert.equal(fingerprint({ ...event, replyTarget: 'new-key', sender: { ...event.sender, displayName: 'Changed' } }, candidate, scope), original);
    const { threadId: _thread, ...unthreaded } = event;
    assert.notEqual(original, fingerprint(unthreaded, personal, scope));
    assert.notEqual(original, fingerprint({ ...event, sender: { id: 'other' } }, { ...route, requester: { id: 'other' } } as ReplyRoute, scope));
    if (kind === 'channel') assert.notEqual(original, fingerprint({ ...event, threadId: 'other' }, { ...route, threadId: 'other' } as ReplyRoute, scope));
  });
}

test('shared AAD requester is not compared to a Teams bot account ID; personal self-routing remains refused', t => {
  const p = shared('groupChat'); p.event.sender.id = personal.bot.id;
  p.route = { ...p.route, requester: { ...p.event.sender } } as ReplyRoute;
  const path = database(t); const store = openIngressStore(path, scope);
  try {
    assert.throws(() => store.admit({ ...expectedEvent, sender: { id: personal.bot.id } }, personal), invalid);
    assert.equal(store.admit(p.event, p.route).kind, 'accepted');
  } finally { store.close(); }
});

for (const patch of [
  { requester: undefined }, { requester: { id: '' } }, { requester: { id: 'aad-requester', extra: 'no' } },
  { requester: { id: 'aad-requester', displayName: 'x'.repeat(257) } }, { threadId: '' }, { threadId: undefined }, { threadId: 'x'.repeat(257) }, { extra: 'no' },
]) test('channel route refuses malformed or open-ended shared evidence', () => {
  assert.throws(() => validateRoute({ ...shared('channel').route, ...patch }), invalid);
});
for (const kind of ['personal', 'groupChat'] as const) test(`${kind} forbids thread identity and personal forbids requester`, () => {
  const route = kind === 'personal' ? personal : shared(kind).route;
  assert.throws(() => validateRoute({ ...route, threadId: 'root' }), invalid);
  if (kind === 'personal') assert.throws(() => validateRoute({ ...route, requester: { id: expectedEvent.sender.id } }), invalid);
});
for (const threadId of ['', null, 1, ' root', 'x'.repeat(257), '\ud800']) test('event thread must be a bounded exact identity', () => {
  assert.throws(() => validateEvent({ ...expectedEvent, threadId }), invalid);
});
for (const kind of ['personal', 'groupChat', 'channel'] as const) test(`${kind} mismatched requester/thread cannot be admitted or poison the store`, t => {
  const { event, route } = kind === 'personal' ? { event: expectedEvent, route: personal } : shared(kind);
  const path = database(t); const store = openIngressStore(path, scope);
  try {
    assert.throws(() => store.admit({ ...event, threadId: 'other-thread' }, route), invalid);
    if (kind !== 'personal') assert.throws(() => store.admit(event, { ...route, requester: { id: 'other' } } as ReplyRoute), invalid);
    assert.equal(store.admit(event, route).kind, 'accepted');
  } finally { store.close(); }
});

for (const field of ['requester', 'threadId'] as const) test(`SQLite startup refuses digest-valid ${field} mismatch before recovery`, t => {
  const { event, route } = shared('channel'); const path = database(t); const store = openIngressStore(path, scope);
  store.admit(event, route); store.claim(); store.close();
  const altered = { ...route, ...(field === 'requester' ? { requester: { id: 'other' } } : { threadId: 'other' }) };
  const raw = new DatabaseSync(path);
  try {
    // Deliberately valid local route digest: cross-row evidence must still refuse it.
    const bytes = encode(altered);
    raw.prepare('UPDATE routes SET body=?, digest=?').run(bytes, createHash('sha256').update(bytes).digest('hex'));
  } finally { raw.close(); }
  assert.throws(() => openIngressStore(path, scope), e => e instanceof IngressStoreError && e.code === 'corrupt');
});
