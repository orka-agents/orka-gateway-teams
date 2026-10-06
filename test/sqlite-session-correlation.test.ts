import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DeliveryJournalError } from '../src/delivery/types.js';
import { initializeDeliveryJournal } from '../src/delivery/journal.js';
import { initializeSessionCorrelation, openSessionCorrelation } from '../src/delivery/sqlite-session-correlation.js';
import { createSessionObservation, MAX_SESSION_CORRELATIONS } from '../src/delivery/session-correlation.js';
import { finalDelivery } from './fixtures/outgoing.js';

const scope = { appId: 'synthetic-correlation-app', tenantId: finalDelivery.accountId };
const first = { sessionDigest: 'a'.repeat(64), originDigest: 'b'.repeat(64) };
const later = { ...first, originDigest: 'c'.repeat(64) };
const second = { ...first, sessionDigest: 'd'.repeat(64) };
const third = { ...first, sessionDigest: 'e'.repeat(64) };
const code = (want: string) => (error: unknown) => error instanceof DeliveryJournalError && error.code === want;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-correlation-')); const path = join(directory, 'sessions.sqlite');
  const handles: ReturnType<typeof openSessionCorrelation>[] = [];
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, directory, initialize: () => initializeSessionCorrelation(path, scope),
    open: (maxSessions = 2) => { const handle = openSessionCorrelation(path, scope, { maxSessions }); handles.push(handle); return handle; } };
}
function raw(path: string, action: (db: DatabaseSync) => void) { const db = new DatabaseSync(path); try { action(db); } finally { db.close(); } }

test('SQLite immutable first origin survives different origins, full cap replay and restart', t => {
  const s = fixture(t); s.initialize(); let port = s.open();
  assert.deepEqual(port.observeSession(first), { kind: 'observed', continuation: false });
  assert.deepEqual(port.observeSession(first), { kind: 'observed', continuation: false });
  assert.deepEqual(port.observeSession(later), { kind: 'observed', continuation: true });
  assert.deepEqual(port.observeSession(first), { kind: 'observed', continuation: false });
  assert.deepEqual(port.observeSession(second), { kind: 'observed', continuation: false });
  assert.deepEqual(port.observeSession(third), { kind: 'full' }); port.close();
  raw(s.path, db => { assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 2); });
  port = s.open(); assert.deepEqual(port.observeSession(first), { kind: 'observed', continuation: false });
  assert.deepEqual(port.observeSession(later), { kind: 'observed', continuation: true });
  assert.deepEqual(port.observeSession(third), { kind: 'full' });
});
test('SQLite explicit provisioning only, permanent private ownership and idempotent close', t => {
  const s = fixture(t); assert.throws(() => s.open(), code('missing'));
  assert.equal(existsSync(s.path), false); assert.equal(existsSync(`${s.path}.owner.sqlite`), false);
  s.initialize(); assert.equal(statSync(s.path).mode & 0o777, 0o600);
  const inode = statSync(`${s.path}.owner.sqlite`).ino;
  const port = s.open(); assert.throws(s.initialize, code('exists')); port.close(); port.close();
  assert.throws(() => port.observeSession(first), code('closed')); s.open().close();
  assert.equal(statSync(`${s.path}.owner.sqlite`).ino, inode);
});
test('SQLite competing same-process open does not release ownership to a child process', t => {
  const s = fixture(t); s.initialize(); const owner = s.open();
  assert.throws(() => s.open(), code('busy'));
  const source = `import { openSessionCorrelation } from './src/delivery/sqlite-session-correlation.ts';
    try { const p = openSessionCorrelation(process.argv[1], JSON.parse(process.argv[2])); p.close(); process.exit(3); }
    catch(e) { process.exit(e.code === 'busy' ? 0 : 4); }`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, s.path, JSON.stringify(scope)], { cwd: process.cwd(), stdio: 'pipe', timeout: 10000 });
  assert.equal(child.status, 0); owner.close(); s.open().close();
});
test('SQLite invalid inputs are closed digest snapshots and do not poison a healthy port', t => {
  const s = fixture(t); s.initialize(); const port = s.open(); let reads = 0;
  for (const value of [{ ...first, extra: true }, { ...first, sessionDigest: 'a'.repeat(65) }, { ...first, originDigest: 'B'.repeat(64) },
    { ...first, originDigest: null }, { sessionDigest: first.sessionDigest },
    { ...first, get originDigest() { reads++; return first.originDigest; } }]) assert.throws(() => port.observeSession(value as typeof first), code('invalid-input'));
  assert.equal(reads, 0); assert.deepEqual(port.observeSession(first), { kind: 'observed', continuation: false });
});
for (const maxSessions of [0, -1, 2.5, MAX_SESSION_CORRELATIONS + 1, Infinity]) test('SQLite rejects invalid or raised session bounds', t => {
  const s = fixture(t); s.initialize(); assert.throws(() => s.open(maxSessions), code('invalid-input')); s.open().close();
});
test('SQLite malformed limits fail with safe invalid-input before acquiring ownership', t => {
  const s = fixture(t); s.initialize(); let reads = 0;
  for (const limits of [null, [], { extra: true }, { get maxSessions() { reads++; return 2; } }])
    assert.throws(() => openSessionCorrelation(s.path, scope, limits as { maxSessions?: number }), code('invalid-input'));
  assert.equal(reads, 0); s.open().close();
});
test('SQLite SIGKILL after committed observation preserves first origin without reset', t => {
  const s = fixture(t); s.initialize();
  const source = `import { openSessionCorrelation } from './src/delivery/sqlite-session-correlation.ts';
    const p = openSessionCorrelation(process.argv[1], JSON.parse(process.argv[2]));
    p.observeSession(JSON.parse(process.argv[3])); process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, s.path, JSON.stringify(scope), JSON.stringify(first)],
    { cwd: process.cwd(), stdio: 'pipe', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL'); const next = s.open();
  assert.deepEqual(next.observeSession(first), { kind: 'observed', continuation: false });
  assert.deepEqual(next.observeSession(later), { kind: 'observed', continuation: true });
});
test('SQLite scope digests reject wrong scope and existing delivery schemas without repairs', t => {
  const s = fixture(t); s.initialize(); assert.throws(() => openSessionCorrelation(s.path, { ...scope, appId: 'other' }), code('scope-mismatch'));
  s.open().close(); const foreign = join(s.directory, 'foreign.sqlite'); initializeDeliveryJournal(foreign, scope);
  const bytes = readFileSync(foreign); assert.throws(() => openSessionCorrelation(foreign, scope), code('unsupported-schema'));
  assert.equal(bytes.equals(readFileSync(foreign)), true);
});
for (const damage of ['empty', 'bytes', 'brand', 'schema', 'bad-digest', 'bad-utf8'] as const) test(`SQLite refuses ${damage} without repairs`, t => {
  const s = fixture(t); s.initialize(); const port = s.open(); port.observeSession(first); port.close();
  if (damage === 'empty') writeFileSync(s.path, '');
  else if (damage === 'bytes') writeFileSync(s.path, 'not sqlite');
  else raw(s.path, db => {
    if (damage === 'brand') db.exec('PRAGMA application_id=1');
    else if (damage === 'schema') db.exec('CREATE TABLE extra (value TEXT)');
    else {
      db.exec('PRAGMA ignore_check_constraints=ON');
      const trigger = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='sessions_no_update'").get()!.sql);
      db.exec('DROP TRIGGER sessions_no_update');
      db.prepare('UPDATE sessions SET first_origin_digest=CAST(? AS TEXT)').run(damage === 'bad-utf8' ? Buffer.from([0x80]) : Buffer.from('bad'));
      db.exec(trigger);
    }
  });
  const before = readFileSync(s.path); assert.throws(() => s.open(), code(damage === 'brand' ? 'unsupported-schema' : 'corrupt'));
  assert.equal(before.equals(readFileSync(s.path)), true);
});
test('SQLite too-small reopen cap fails closed rather than deleting retained keys', t => {
  const s = fixture(t); s.initialize(); const port = s.open(); port.observeSession(first); port.observeSession(second); port.close();
  assert.throws(() => s.open(1), code('corrupt')); const reopened = s.open();
  assert.deepEqual(reopened.observeSession(first), { kind: 'observed', continuation: false });
});
test('SQLite transaction lock cannot leak an observation or leave a reusable uncertain handle', t => {
  const s = fixture(t); s.initialize(); const port = s.open(); const blocker = new DatabaseSync(s.path);
  try {
    blocker.exec('BEGIN; SELECT * FROM sessions');
    assert.throws(() => port.observeSession(first), code('unavailable')); blocker.exec('ROLLBACK');
    assert.equal(blocker.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 0);
    assert.throws(() => port.observeSession(first), code('unavailable'));
  } finally { blocker.close(); port.close(); }
  assert.deepEqual(s.open().observeSession(first), { kind: 'observed', continuation: false });
});
test('SQLite schema prevents replacement and pruning of immutable first origins and scope', t => {
  const s = fixture(t); s.initialize(); const port = s.open(); port.observeSession(first); port.close();
  raw(s.path, db => {
    assert.throws(() => db.prepare('UPDATE sessions SET first_origin_digest=?').run(later.originDigest));
    assert.throws(() => db.exec('DELETE FROM sessions'));
    assert.throws(() => db.prepare('UPDATE scope SET digest=?').run(later.originDigest));
    assert.throws(() => db.exec('DELETE FROM scope'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 1);
  });
  assert.deepEqual(s.open().observeSession(first), { kind: 'observed', continuation: false });
});
test('correlation canonical tagged tuples match independent SHA256 vectors', () => {
  const result = createSessionObservation({ appId: 'App', tenantId: 'Tenant' }, { ...finalDelivery, accountId: 'Tenant', contextId: 'Room',
    threadId: 'Thread', sessionRef: { namespace: 'Namespace', name: 'Session' }, originatingEventId: 'Origin' });
  assert.deepEqual(result, { sessionDigest: '66f4c3cb9171c7c6ce691b8e334f2e7896b50c00bb09cc53c0251409c90b58f3',
    originDigest: '96a2f2b97912cbd2b98b6d90a4e0ebe3b613698ca1d53de4c90f575aeb607b2f' });
});
test('SQLite replaced inode poisons without following a replacement', t => {
  const s = fixture(t); s.initialize(); const replacement = join(s.directory, 'replacement.sqlite'); initializeSessionCorrelation(replacement, scope);
  const port = s.open(); renameSync(s.path, `${s.path}.retired`); renameSync(replacement, s.path);
  assert.throws(() => port.observeSession(first), code('unavailable')); assert.throws(() => port.observeSession(first), code('unavailable'));
});
test('correlation consumes identifiers only, isolates scoped sessions and never retains private plaintext bytes', t => {
  const s = fixture(t); s.initialize(); const port = s.open();
  const observation = createSessionObservation(scope, finalDelivery)!;
  assert.match(observation.sessionDigest, /^[0-9a-f]{64}$/u); assert.match(observation.originDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(createSessionObservation(scope, { ...finalDelivery, text: 'different', taskRef: { namespace: 'different', name: 'different' }, deliveryId: 'different', replyTarget: 'different' }), observation);
  assert.deepEqual(createSessionObservation(scope, { ...finalDelivery, threadId: '' }), observation);
  for (const change of [{ contextId: 'other' }, { threadId: 'other' }, { sessionRef: { ...finalDelivery.sessionRef, namespace: 'other' } }, { sessionRef: { ...finalDelivery.sessionRef, name: 'other' } }])
    assert.notEqual(createSessionObservation(scope, { ...finalDelivery, ...change })!.sessionDigest, observation.sessionDigest);
  assert.notEqual(createSessionObservation({ ...scope, appId: 'other' }, finalDelivery)!.sessionDigest, observation.sessionDigest);
  const differentOrigin = createSessionObservation(scope, { ...finalDelivery, originatingEventId: 'other' })!;
  assert.equal(differentOrigin.sessionDigest, observation.sessionDigest); assert.notEqual(differentOrigin.originDigest, observation.originDigest);
  const absent = { ...finalDelivery }; delete (absent as Partial<typeof finalDelivery>).sessionRef;
  assert.equal(createSessionObservation(scope, absent), undefined);
  port.observeSession(observation); port.close();
  for (const path of [s.path, `${s.path}.owner.sqlite`]) {
    const bytes = readFileSync(path);
    for (const hidden of [scope.appId, scope.tenantId, finalDelivery.contextId, finalDelivery.originatingEventId,
      finalDelivery.sessionRef.name, finalDelivery.sessionRef.namespace, finalDelivery.text]) assert.equal(bytes.includes(Buffer.from(hidden)), false);
  }
});
test('correlation rejects malformed consumed known identifiers and accessor refs without inspecting body getters', () => {
  let reads = 0;
  for (const change of [{ contextId: '' }, { originatingEventId: ' x' }, { threadId: null }, { accountId: 'other' },
    { sessionRef: { namespace: 'n' } }, { sessionRef: { namespace: 'n', name: 'm', extra: true } },
    { sessionRef: { namespace: 'n', get name() { reads++; return 'm'; } } }])
    assert.throws(() => createSessionObservation(scope, { ...finalDelivery, ...change } as typeof finalDelivery), code('invalid-input'));
  assert.equal(reads, 0);
  const input = { ...finalDelivery, get text(): string { reads++; throw new Error('not consumed'); } };
  assert.ok(createSessionObservation(scope, input)); assert.equal(reads, 0);
});
