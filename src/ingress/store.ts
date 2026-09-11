import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decode, digest, encode, fingerprint, identity, integer, invalid, matchRoute, MAX_REPLAY_WINDOW_MS, validateEvent, validatePolicy, validateReceipt, validateRoute, validateScope } from './codec.js';
import { IngressStoreError } from './types.js';
import type { IngressClaim, IngressScope, IngressStore, StoreOptions } from './types.js';
export { IngressStoreError } from './types.js';
export type * from './types.js';

const APPLICATION_ID = 0x4f54494e; // OTIN: separate from the delivery journal.
const schema = [
  `CREATE TABLE scope (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), value BLOB NOT NULL, last_now INTEGER NOT NULL) STRICT`,
  `CREATE TABLE routes (reply_target BLOB PRIMARY KEY NOT NULL, body BLOB NOT NULL, digest TEXT NOT NULL) STRICT`,
  `CREATE TABLE inbox (
    external_event_id BLOB PRIMARY KEY NOT NULL, reply_target BLOB NOT NULL UNIQUE REFERENCES routes(reply_target),
    fingerprint TEXT NOT NULL, body_digest TEXT NOT NULL, body BLOB,
    state TEXT NOT NULL CHECK (state IN ('pending', 'forwarding', 'blocked', 'terminal')),
    received INTEGER NOT NULL, deadline INTEGER NOT NULL, next_attempt INTEGER NOT NULL,
    attempt INTEGER NOT NULL, attempt_id TEXT, receipt BLOB, reason TEXT,
    CHECK ((state = 'terminal' AND body IS NULL AND receipt IS NOT NULL) OR (state != 'terminal' AND body IS NOT NULL AND receipt IS NULL))
  ) STRICT`,
  `CREATE INDEX inbox_due ON inbox (state, next_attempt, received)`,
  `CREATE TRIGGER scope_no_update BEFORE UPDATE OF value ON scope BEGIN SELECT RAISE(ABORT, 'immutable scope'); END`,
  `CREATE TRIGGER scope_no_delete BEFORE DELETE ON scope BEGIN SELECT RAISE(ABORT, 'immutable scope'); END`,
];

export function initializeIngressStore(inputPath: string, inputScope: Readonly<IngressScope>): void {
  const scope = validateScope(inputScope); let db: DatabaseSync | undefined;
  try {
    const path = canonicalPath(inputPath);
    // Only a newly created file may be opened with an ordinary fd. Closing an
    // ordinary fd on an owned SQLite inode can release process-wide POSIX locks.
    const fd = openSync(path, 'wx', 0o600);
    let stamp: Stats;
    try { fsyncSync(fd); stamp = fstatSync(fd); } finally { closeSync(fd); }
    db = connect(path, stamp);
    transaction(db, () => {
      db!.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1`);
      for (const sql of schema) db!.exec(sql);
      db!.prepare('INSERT INTO scope VALUES (1, ?, 0)').run(encode(scope));
    });
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) { throw storageError(error); }
  finally { db?.close(); } // Failed provisioning remains; never reset/adopt it.
}

export function openIngressStore(inputPath: string, inputScope: Readonly<IngressScope>, options: StoreOptions = {}): IngressStore {
  const scope = validateScope(inputScope); const policy = validatePolicy(options.policy);
  const now = options.now ?? Date.now; let db: DatabaseSync | undefined;
  try {
    const path = canonicalPath(inputPath); const stamp = regularFile(path);
    if (!stamp.size) throw new IngressStoreError('corrupt');
    db = connect(path, stamp);
    validateStore(db, scope);
    // Orka may already have committed a lost response. Replay is safe ONLY with
    // stable target/backend/GatewayUID/ledger and retention exceeding our window.
    transaction(db, () => {
      advanceClock(db!, now());
      db!.exec("UPDATE inbox SET state='pending', attempt_id=NULL WHERE state='forwarding'");
    });
    const main = db; let closed = false; let failed = false;
    const run = <T>(action: () => T): T => {
      if (closed) throw new IngressStoreError('closed');
      if (failed) throw new IngressStoreError('unavailable');
      try { sameFile(path, stamp); return transaction(main, action); }
      catch (error) { failed = true; throw storageError(error); }
    };
    return {
      scope,
      admit(inputEvent, inputRoute) {
        const event = validateEvent(inputEvent); const route = validateRoute(inputRoute); matchRoute(event, route, scope);
        const key = Buffer.from(event.externalEventId); const replyTarget = Buffer.from(event.replyTarget);
        const hash = fingerprint(event, route, scope); const body = encode(event); const routeBody = encode(route);
        return run(() => {
          const clock = advanceClock(main, now());
          const existing = main.prepare('SELECT fingerprint, reply_target FROM inbox WHERE external_event_id=?').get(key);
          if (existing) return existing.fingerprint === hash ? { kind: 'duplicate', replyTarget: storedIdentity(existing.reply_target) } : { kind: 'conflict' };
          if (main.prepare('SELECT 1 FROM routes WHERE reply_target=?').get(replyTarget)) return { kind: 'conflict' };
          const counts = main.prepare("SELECT count(*) AS records, count(body) AS pending FROM inbox").get()!;
          if (clock.regressed || Number(counts.records) >= policy.maxRecords || Number(counts.pending) >= policy.maxPending) return { kind: 'full' };
          main.prepare('INSERT INTO routes VALUES (?, ?, ?)').run(replyTarget, routeBody, digest(routeBody));
          main.prepare(`INSERT INTO inbox VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, NULL, NULL, NULL)`)
            .run(key, replyTarget, hash, digest(body), body, clock.time, clock.time + policy.replayWindowMs, clock.time);
          return { kind: 'accepted', replyTarget: event.replyTarget };
        });
      },
      claim() {
        return run(() => {
          const clock = advanceClock(main, now());
          const row = main.prepare("SELECT * FROM inbox WHERE state='pending' AND next_attempt<=? ORDER BY received, rowid LIMIT 1").get(clock.time);
          if (!row) return undefined;
          const externalEventId = storedIdentity(row.external_event_id); const attemptId = randomUUID();
          const attempt = integer(row.attempt, 0, Number.MAX_SAFE_INTEGER - 1) + 1;
          const event = validateEvent(decode(row.body));
          main.prepare("UPDATE inbox SET state='forwarding', attempt_id=?, attempt=? WHERE external_event_id=?")
            .run(attemptId, attempt, Buffer.from(externalEventId));
          return { externalEventId, attemptId, attempt, event };
        });
      },
      complete(inputClaim, inputReceipt) {
        const claim = validateClaim(inputClaim); const receipt = validateReceipt(inputReceipt);
        return run(() => {
          advanceClock(main, now());
          return main.prepare("UPDATE inbox SET state='terminal', body=NULL, receipt=? WHERE external_event_id=? AND attempt_id=? AND attempt=? AND state='forwarding'")
            .run(encode(receipt), Buffer.from(claim.externalEventId), claim.attemptId, claim.attempt).changes === 1;
        });
      },
      retry(inputClaim, delayMs) {
        const claim = validateClaim(inputClaim); integer(delayMs);
        return run(() => {
          const clock = advanceClock(main, now());
          const next = Math.min(Number.MAX_SAFE_INTEGER, clock.time + delayMs);
          return main.prepare("UPDATE inbox SET state='pending', next_attempt=? WHERE external_event_id=? AND attempt_id=? AND attempt=? AND state='forwarding'")
            .run(next, Buffer.from(claim.externalEventId), claim.attemptId, claim.attempt).changes === 1;
        });
      },
      block(inputClaim, reason) {
        const claim = validateClaim(inputClaim);
        if (!['conflict', 'invalid-event', 'redirect'].includes(reason)) invalid();
        return run(() => {
          advanceClock(main, now());
          return main.prepare("UPDATE inbox SET state='blocked', reason=? WHERE external_event_id=? AND attempt_id=? AND attempt=? AND state='forwarding'")
            .run(reason, Buffer.from(claim.externalEventId), claim.attemptId, claim.attempt).changes === 1;
        });
      },
      getRoute(replyTarget) {
        const key = Buffer.from(identity(replyTarget));
        return run(() => {
          const row = main.prepare('SELECT body FROM routes WHERE reply_target=?').get(key);
          return row ? validateRoute(decode(row.body)) : undefined;
        });
      },
      close() { if (!closed) { closed = true; main.close(); } },
    };
  } catch (error) { db?.close(); throw storageError(error); }
}

function canonicalPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || /\0|[\uD800-\uDFFF]/u.test(path) || path.endsWith('/')) {
    throw new IngressStoreError('invalid-input');
  }
  return join(realpathSync(dirname(path)), basename(path));
}
function regularFile(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new IngressStoreError('invalid-input');
  return stat;
}
function sameFile(path: string, expected: Stats): void {
  try {
    const actual = regularFile(path);
    if (actual.dev === expected.dev && actual.ino === expected.ino) return;
  } catch { /* A replaced, linked or missing file revokes this handle. */ }
  throw new IngressStoreError('unavailable');
}
function connect(path: string, stamp: Stats): DatabaseSync {
  const db = new DatabaseSync(path, { allowExtension: false });
  try {
    sameFile(path, stamp);
    // SQLite: https://sqlite.org/pragma.html#pragma_locking_mode. BEGIN EXCLUSIVE
    // obtains ownership; EXCLUSIVE locking_mode retains it across every COMMIT.
    // Refuse WAL rather than converting an unknown store on this SQLite version.
    if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw new IngressStoreError('unavailable');
    db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; BEGIN EXCLUSIVE; COMMIT');
    if (db.prepare('PRAGMA locking_mode').get()?.locking_mode !== 'exclusive' ||
        db.prepare('PRAGMA synchronous').get()?.synchronous !== 3 ||
        db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new IngressStoreError('unavailable');
    sameFile(path, stamp); return db;
  } catch (error) { db.close(); throw error; }
}
function validateStore(db: DatabaseSync, scope: Readonly<IngressScope>): void {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
      db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
      db.prepare('PRAGMA encoding').get()?.encoding !== 'UTF-8') throw new IngressStoreError('unsupported-schema');
  const actual = db.prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL').all().map((row) => row.sql);
  if (actual.length !== schema.length || schema.some((sql) => !actual.includes(sql))) throw new IngressStoreError('corrupt');
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new IngressStoreError('corrupt');
  const rows = db.prepare('SELECT * FROM scope').all();
  if (rows.length !== 1 || rows[0]?.singleton !== 1) throw new IngressStoreError('corrupt');
  let actualScope: Readonly<IngressScope>;
  try { actualScope = validateScope(decode(rows[0].value)); } catch { throw new IngressStoreError('corrupt'); }
  if (!encode(actualScope).equals(encode(scope))) throw new IngressStoreError('scope-mismatch');
  try {
    integer(rows[0].last_now, 0, Number.MAX_SAFE_INTEGER - MAX_REPLAY_WINDOW_MS);
    for (const row of db.prepare('SELECT * FROM routes').iterate()) {
      storedIdentity(row.reply_target); validateRoute(decode(row.body));
      if (digest(row.body as Uint8Array) !== row.digest ||
          !db.prepare('SELECT 1 FROM inbox WHERE reply_target=?').get(row.reply_target as Uint8Array)) throw new Error();
    }
    for (const row of db.prepare('SELECT * FROM inbox').iterate()) {
      const key = storedIdentity(row.external_event_id); const replyTarget = storedIdentity(row.reply_target);
      integer(row.received, 0, Number.MAX_SAFE_INTEGER - MAX_REPLAY_WINDOW_MS);
      integer(row.deadline, Number(row.received) + 1, Number(row.received) + MAX_REPLAY_WINDOW_MS);
      integer(row.next_attempt); integer(row.attempt);
      if (![row.fingerprint, row.body_digest].every((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/u.test(hash)) ||
          (row.attempt_id !== null && (typeof row.attempt_id !== 'string' || !uuid.test(row.attempt_id))) ||
          (row.state === 'forwarding' && (!row.attempt_id || row.attempt === 0)) ||
          (row.state === 'blocked' ? !['conflict', 'invalid-event', 'redirect', 'deadline', 'clock-regression'].includes(row.reason as string) : row.reason !== null)) throw new Error();
      if (row.state === 'terminal') validateReceipt(decode(row.receipt));
      else {
        const event = validateEvent(decode(row.body));
        const route = validateRoute(decode(db.prepare('SELECT body FROM routes WHERE reply_target=?').get(row.reply_target as Uint8Array)?.body));
        matchRoute(event, route, scope);
        if (event.externalEventId !== key || event.replyTarget !== replyTarget ||
            digest(row.body as Uint8Array) !== row.body_digest || fingerprint(event, route, scope) !== row.fingerprint) throw new Error();
      }
    }
  } catch { throw new IngressStoreError('corrupt'); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function validateClaim(claim: Readonly<IngressClaim>): Readonly<IngressClaim> {
  identity(claim.externalEventId); identity(claim.attemptId); integer(claim.attempt, 1);
  if (!uuid.test(claim.attemptId)) invalid();
  return { ...claim };
}
function storedIdentity(bytes: unknown): string {
  if (!(bytes instanceof Uint8Array)) throw new IngressStoreError('corrupt');
  const value = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(value).equals(bytes)) throw new IngressStoreError('corrupt');
  return identity(value);
}
function advanceClock(db: DatabaseSync, value: number): { time: number; regressed: boolean } {
  const time = integer(value, 0, Number.MAX_SAFE_INTEGER - MAX_REPLAY_WINDOW_MS);
  const previous = Number(db.prepare('SELECT last_now FROM scope').get()!.last_now);
  const regressed = time < previous;
  if (regressed) db.exec("UPDATE inbox SET state='blocked', reason='clock-regression' WHERE state IN ('pending', 'forwarding')");
  else db.prepare('UPDATE scope SET last_now=?').run(time);
  db.prepare("UPDATE inbox SET state='blocked', reason='deadline' WHERE state IN ('pending', 'forwarding') AND deadline<=?").run(time);
  return { time, regressed };
}
function transaction<T>(db: DatabaseSync, action: () => T): T {
  try { db.exec('BEGIN IMMEDIATE'); const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
function storageError(error: unknown): IngressStoreError {
  if (error instanceof IngressStoreError) return error;
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  const sqlite = error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' ? error.errcode & 0xff : 0;
  return new IngressStoreError(code === 'ENOENT' ? 'missing' : code === 'EEXIST' ? 'exists' :
    [5, 6].includes(sqlite) ? 'busy' : [11, 26].includes(sqlite) ? 'corrupt' : 'unavailable');
}
