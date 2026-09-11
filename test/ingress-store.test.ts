import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { IngressStoreError, initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import type { IngressClaim, IngressScope, ReplyRoute } from '../src/ingress/types.js';
import { expectedEvent } from './fixtures/incoming.js';

const scope: IngressScope = { appId: 'app-fixture', tenantId: expectedEvent.accountId, orkaBaseUrl: 'https://orka.example.invalid/', gatewayNamespace: 'default', gatewayName: 'teams' };
const route: ReplyRoute = { serviceUrl: 'https://teams-service.example.invalid/', channelId: 'msteams', bot: { id: '28:fixture-app', role: 'bot' }, conversation: { id: expectedEvent.contextId, conversationType: 'personal', tenantId: scope.tenantId } };
const receipt = { status: 'accepted', eventId: 'gev-fixture', state: 'Accepted' } as const;
const policy = { maxPending: 2, maxRecords: 3, replayWindowMs: 10000 };
function code(want: string) { return (error: unknown) => error instanceof IngressStoreError && error.code === want; }
function fixture(t: test.TestContext, initialize = true) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-ingress-'));
  const path = join(directory, 'inbox.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (initialize) initializeIngressStore(path, scope);
  return { path, directory };
}
type Message = { kind: string; code?: string; claim?: IngressClaim };
function worker(t: test.TestContext, path: string, mode = 'probe', inputScope = scope) {
  const child = fork(new URL('./support/ingress-store-worker.ts', import.meta.url), [mode, path, JSON.stringify(inputScope)], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const queue: Message[] = []; let notify: (() => void) | undefined; let ended = false;
  const exit = new Promise<void>((resolve) => child.once('exit', () => { ended = true; notify?.(); resolve(); }));
  child.on('message', (message) => { queue.push(message as Message); notify?.(); });
  const stop = async () => { if (!ended) child.kill('SIGKILL'); await exit; };
  t.after(stop);
  return { child, exit, stop, async next(): Promise<Message> {
    while (!queue.length) {
      assert.equal(ended, false, 'worker must reach milestone');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker timeout')), 5000);
        notify = () => { clearTimeout(timer); resolve(); };
      });
    }
    return queue.shift()!;
  } };
}

test('native SQLite EXCLUSIVE retains locks after COMMIT, even after failed same-process contender closes', async (t) => {
  const { path } = fixture(t, false); const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; CREATE TABLE proof (id INTEGER); PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
    assert.equal(db.prepare('PRAGMA locking_mode').get()?.locking_mode, 'exclusive');
    assert.equal(db.prepare('PRAGMA synchronous').get()?.synchronous, 3);
    for (let i = 0; i < 3; i++) {
      const contender = new DatabaseSync(path);
      try { assert.throws(() => contender.exec('BEGIN EXCLUSIVE')); } finally { contender.close(); }
    }
    const blocked = worker(t, path, 'sqlite-probe');
    assert.deepEqual(await blocked.next(), { kind: 'error', code: 'busy' }); await blocked.exit;
    db.exec('BEGIN IMMEDIATE; INSERT INTO proof VALUES (1); COMMIT');
    const blockedAgain = worker(t, path, 'sqlite-probe');
    assert.deepEqual(await blockedAgain.next(), { kind: 'error', code: 'busy' }); await blockedAgain.exit;
  } finally { db.close(); }
  const released = worker(t, path, 'sqlite-probe'); assert.deepEqual(await released.next(), { kind: 'opened' }); await released.exit;
});

test('missing open does not provision; explicit initialize never overwrites or adopts', (t) => {
  const { path } = fixture(t, false);
  assert.throws(() => openIngressStore(path, scope), code('missing'));
  assert.equal(existsSync(path), false);
  initializeIngressStore(path, scope);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => initializeIngressStore(path, scope), code('exists'));
  const store = openIngressStore(path, scope); store.close(); store.close();
  assert.throws(() => store.claim(), code('closed'));
});

test('store ownership survives failed local contenders and excludes native processes until close', async (t) => {
  const { path } = fixture(t); const store = openIngressStore(path, scope);
  try {
    for (let i = 0; i < 3; i++) assert.throws(() => openIngressStore(path, scope), code('busy'));
    const blocked = worker(t, path); assert.deepEqual(await blocked.next(), { kind: 'error', code: 'busy' }); await blocked.exit;
    assert.equal(store.claim(), undefined);
  } finally { store.close(); }
  const released = worker(t, path); assert.deepEqual(await released.next(), { kind: 'opened' }); await released.exit;
});

test('scope and brand are checked without adopting other stores', (t) => {
  const { path } = fixture(t);
  for (const key of Object.keys(scope) as (keyof IngressScope)[]) {
    const value = key === 'orkaBaseUrl' ? 'https://other.example.invalid/' : 'other';
    assert.throws(() => openIngressStore(path, { ...scope, [key]: value }), code('scope-mismatch'));
  }
  const raw = new DatabaseSync(path); raw.exec('PRAGMA user_version=99'); raw.close();
  assert.throws(() => openIngressStore(path, scope), code('unsupported-schema'));
});

test('unsafe paths, links and replacement fail closed without reconnecting', (t) => {
  const { path, directory } = fixture(t);
  const symbolic = join(directory, 'symbolic'); symlinkSync(path, symbolic);
  assert.throws(() => openIngressStore(symbolic, scope), code('invalid-input'));
  const hard = join(directory, 'hard'); linkSync(path, hard);
  assert.throws(() => openIngressStore(path, scope), code('invalid-input')); rmSync(hard);
  chmodSync(path, 0o644); assert.throws(() => openIngressStore(path, scope), code('invalid-input')); chmodSync(path, 0o600);
  const store = openIngressStore(path, scope);
  try {
    renameSync(path, `${path}.moved`); writeFileSync(path, '', { mode: 0o600 });
    assert.throws(() => store.claim(), code('unavailable'));
    renameSync(`${path}.moved`, path);
    assert.throws(() => store.claim(), code('unavailable'));
  } finally { store.close(); }
});

test('atomic admission keeps original bytes, profile and route on duplicate, rejecting core conflicts', (t) => {
  const { path } = fixture(t); const store = openIngressStore(path, scope);
  const event = structuredClone(expectedEvent); const candidateRoute = structuredClone(route);
  try {
    assert.deepEqual(store.admit(event, candidateRoute), { kind: 'accepted', replyTarget: expectedEvent.replyTarget });
    event.text = 'mutated'; candidateRoute.bot.id = 'mutated';
    assert.deepEqual(store.admit({ ...expectedEvent, replyTarget: 'loser-route', sender: { ...expectedEvent.sender, displayName: 'new label' } }, route), { kind: 'duplicate', replyTarget: expectedEvent.replyTarget });
    assert.equal(store.getRoute('loser-route'), undefined);
    assert.deepEqual(store.getRoute(expectedEvent.replyTarget), route);
    const returned = store.getRoute(expectedEvent.replyTarget)!; returned.bot.id = 'mutated';
    assert.deepEqual(store.getRoute(expectedEvent.replyTarget), route);
    for (const changed of [{ text: 'changed' }, { sender: { id: '29:other' } }]) {
      assert.deepEqual(store.admit({ ...expectedEvent, ...changed }, route), { kind: 'conflict' });
    }
    assert.deepEqual(store.admit(expectedEvent, { ...route, bot: { id: '28:other', role: 'bot' } }), { kind: 'conflict' });
    assert.deepEqual(store.admit({ ...expectedEvent, externalEventId: 'other-event' }, route), { kind: 'conflict' });
    const claim = store.claim(); assert.ok(claim); assert.deepEqual(claim.event, expectedEvent);
    assert.equal(claim.attempt, 1); assert.equal(store.claim(), undefined);
    store.close();
    const raw = new DatabaseSync(path);
    try {
      assert.equal(raw.prepare('SELECT count(*) AS n FROM inbox').get()?.n, 1);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM routes').get()?.n, 1);
      assert.deepEqual(Buffer.from(raw.prepare('SELECT body FROM inbox').get()!.body as Uint8Array), Buffer.from(JSON.stringify(expectedEvent)));
    } finally { raw.close(); }
  } finally { store.close(); }
});

test('invalid or raw activity/credential shapes never enter storage or poison a valid handle', (t) => {
  const { path } = fixture(t); const store = openIngressStore(path, scope);
  try {
    const invalidEvents = [
      { ...expectedEvent, authorization: 'synthetic-not-a-credential' },
      { ...expectedEvent, sender: { ...expectedEvent.sender, token: 'synthetic' } },
      { ...expectedEvent, text: '\ud800' }, { ...expectedEvent, text: 'x'.repeat(65537) },
      { ...expectedEvent, text: '\u0000' }, { ...expectedEvent, replyTarget: '' },
      { ...expectedEvent, accountId: 'other' }, { ...expectedEvent, contextId: 'other' },
      { ...expectedEvent, receivedAt: new Date().toISOString() },
    ];
    for (const event of invalidEvents) assert.throws(() => store.admit(event, route), code('invalid-input'));
    for (const serviceUrl of ['http://example.invalid/', 'https://example.invalid/?q=x', 'https://example.invalid:444/', 'https://user@example.invalid/']) {
      assert.throws(() => store.admit(expectedEvent, { ...route, serviceUrl }), code('invalid-input'));
    }
    assert.equal(store.claim(), undefined);
    assert.equal(store.admit(expectedEvent, route).kind, 'accepted');
  } finally { store.close(); }
});

test('Unicode including BOM and replacement character survives exact BLOB restart', (t) => {
  const { path } = fixture(t); const event = { ...expectedEvent, text: '\ufeff\ufffd日本語 🧑🏽‍💻\r\n' };
  const store = openIngressStore(path, scope); store.admit(event, route); store.close();
  const reopened = openIngressStore(path, scope);
  try { assert.deepEqual(reopened.claim()?.event, event); } finally { reopened.close(); }
});

test('pending capacity counts forwarding and blocked; terminal tombstones and routes count forever', (t) => {
  const { path } = fixture(t); const store = openIngressStore(path, scope, { policy });
  const event2 = { ...expectedEvent, externalEventId: 'two', replyTarget: 'rt-two' };
  const event3 = { ...expectedEvent, externalEventId: 'three', replyTarget: 'rt-three' };
  try {
    store.admit(expectedEvent, route); const first = store.claim()!;
    store.admit(event2, route); const second = store.claim()!; store.block(second, 'conflict');
    assert.deepEqual(store.admit(event3, route), { kind: 'full' });
    assert.equal(store.getRoute('rt-three'), undefined);
    assert.equal(store.complete(first, receipt), true);
    assert.equal(store.admit(event3, route).kind, 'accepted');
    const third = store.claim()!; store.complete(third, receipt);
    assert.deepEqual(store.admit({ ...event3, externalEventId: 'four', replyTarget: 'rt-four' }, route), { kind: 'full' });
    assert.equal(store.admit(expectedEvent, route).kind, 'duplicate');
    assert.deepEqual(store.getRoute(expectedEvent.replyTarget), route);
  } finally { store.close(); }
});

test('attempt fences reject stale completion/retry/block and valid receipt logically removes body only', (t) => {
  const { path } = fixture(t); let now = 1000;
  const store = openIngressStore(path, scope, { policy, now: () => now });
  try {
    store.admit(expectedEvent, route); const first = store.claim()!;
    assert.equal(store.retry(first, 2000), true); assert.equal(store.claim(), undefined);
    now = 2999; assert.equal(store.claim(), undefined); now = 3000;
    const second = store.claim()!; assert.equal(second.attempt, 2); assert.notEqual(second.attemptId, first.attemptId);
    assert.deepEqual(second.event, expectedEvent);
    assert.equal(store.complete(first, receipt), false); assert.equal(store.retry(first, 0), false); assert.equal(store.block(first, 'conflict'), false);
    assert.throws(() => store.complete(second, { ...receipt, state: '' }), code('invalid-input'));
    assert.throws(() => store.complete(second, { ...receipt, state: 'Rejected' }), code('invalid-input'));
    assert.equal(store.complete(second, receipt), true); assert.equal(store.complete(second, receipt), false);
    assert.equal(store.claim(), undefined);
  } finally { store.close(); }
  const raw = new DatabaseSync(path);
  try { assert.equal(raw.prepare('SELECT body FROM inbox').get()?.body, null); }
  finally { raw.close(); }
  const reopened = openIngressStore(path, scope, { now: () => now });
  try { assert.equal(reopened.claim(), undefined); assert.deepEqual(reopened.getRoute(expectedEvent.replyTarget), route); assert.equal(reopened.admit(expectedEvent, route).kind, 'duplicate'); }
  finally { reopened.close(); }
});

for (const mode of ['SIGKILL', 'exit-without-close', 'completed']) {
  test(`native ${mode} preserves committed event/route and fences the abandoned attempt`, async (t) => {
    const { path } = fixture(t); const store = openIngressStore(path, scope); store.admit(expectedEvent, route); store.close();
    const child = worker(t, path, 'claim'); const started = await child.next(); assert.ok(started.claim);
    if (mode === 'completed') { child.child.send('complete'); assert.deepEqual(await child.next(), { kind: 'completed' }); }
    if (mode === 'exit-without-close') { child.child.send(mode); await child.exit; } else await child.stop();
    const wrong = worker(t, path, 'probe', { ...scope, appId: 'wrong' });
    assert.deepEqual(await wrong.next(), { kind: 'error', code: 'scope-mismatch' }); await wrong.exit;
    const raw = new DatabaseSync(path);
    try { assert.equal(raw.prepare('SELECT state FROM inbox').get()?.state, mode === 'completed' ? 'terminal' : 'forwarding'); } finally { raw.close(); }
    const reopened = openIngressStore(path, scope);
    try {
      assert.equal(reopened.complete(started.claim, receipt), false);
      const next = reopened.claim();
      if (mode === 'completed') assert.equal(next, undefined);
      else { assert.ok(next); assert.deepEqual(next.event, expectedEvent); assert.equal(next.attempt, 2); assert.notEqual(next.attemptId, started.claim.attemptId); }
      assert.deepEqual(reopened.getRoute(expectedEvent.replyTarget), route);
    } finally { reopened.close(); }
  });
}

for (const regression of [false, true]) {
  test(`${regression ? 'clock regression' : 'captured replay deadline'} quarantines acknowledged work across restarts`, (t) => {
    const { path } = fixture(t); let now = 1000;
    const store = openIngressStore(path, scope, { policy, now: () => now }); store.admit(expectedEvent, route);
    now = 5000; assert.ok(store.claim()); store.close();
    now = regression ? 4999 : 11000;
    const reopened = openIngressStore(path, scope, { policy: { ...policy, replayWindowMs: 600000 }, now: () => now });
    try { assert.equal(reopened.claim(), undefined); now = 6000; assert.equal(reopened.claim(), undefined); }
    finally { reopened.close(); }
    const raw = new DatabaseSync(path);
    try { const row = raw.prepare('SELECT state, body, deadline FROM inbox').get()!; assert.equal(row.state, 'blocked'); assert.ok(row.body); assert.equal(row.deadline, 11000); }
    finally { raw.close(); }
  });
}

test('corrupt UTF8, changed body digest, invalid route bytes and schema are refused before recovery', (t) => {
  for (const sql of [
    "UPDATE inbox SET body=x'ff'", "UPDATE inbox SET body=CAST('{}' AS BLOB)",
    "UPDATE routes SET body=x'ff'", 'CREATE TABLE unexpected (id INTEGER)',
  ]) {
    const { path } = fixture(t); const store = openIngressStore(path, scope); store.admit(expectedEvent, route); store.claim(); store.close();
    const raw = new DatabaseSync(path); raw.exec(sql); raw.close();
    assert.throws(() => openIngressStore(path, scope), code('corrupt'));
  }
});

test('policy and scheduling reject unsafe arithmetic without changing persisted attempts', (t) => {
  const { path } = fixture(t);
  for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => openIngressStore(path, scope, { policy: { ...policy, replayWindowMs: bad } }), code('invalid-input'));
  }
  const store = openIngressStore(path, scope, { policy, now: () => 1000 });
  try {
    store.admit(expectedEvent, route); const claim = store.claim()!;
    for (const delay of [-1, NaN, Infinity, 1.5]) assert.throws(() => store.retry(claim, delay), code('invalid-input'));
    assert.equal(store.retry(claim, Number.MAX_SAFE_INTEGER), true);
    assert.equal(store.claim(), undefined);
  } finally { store.close(); }
});
