import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DeliveryJournalError } from './types.js';
import type { JournalScope } from './types.js';
import { sessionCorrelationLimit, sessionScopeDigest, validateSessionObservation } from './session-correlation.js';
import type { SessionCorrelationPort, SessionObservation, SessionObservationResult } from './session-correlation.js';

const APPLICATION_ID = 0x4f545343; // OTSC: separate Orka Teams session correlation store
const schema = [
  `CREATE TABLE scope (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*')
  ) STRICT`,
  // A hidden rowid would let REPLACE conflict with a retained row while bypassing the digest-keyed INSERT guard.
  `CREATE TABLE sessions (
    session_digest TEXT PRIMARY KEY NOT NULL CHECK (length(session_digest) = 64 AND session_digest NOT GLOB '*[^0-9a-f]*'),
    first_origin_digest TEXT NOT NULL CHECK (length(first_origin_digest) = 64 AND first_origin_digest NOT GLOB '*[^0-9a-f]*')
  ) STRICT, WITHOUT ROWID`,
  // REPLACE bypasses delete triggers when recursive_triggers is off; guard existing keys before insertion.
  `CREATE TRIGGER scope_no_replace BEFORE INSERT ON scope WHEN EXISTS (SELECT 1 FROM scope WHERE singleton = NEW.singleton)
    BEGIN SELECT RAISE(ABORT, 'immutable scope'); END`,
  `CREATE TRIGGER sessions_no_replace BEFORE INSERT ON sessions WHEN EXISTS (SELECT 1 FROM sessions WHERE session_digest = NEW.session_digest)
    BEGIN SELECT RAISE(ABORT, 'immutable session'); END`,
  `CREATE TRIGGER scope_no_update BEFORE UPDATE ON scope BEGIN SELECT RAISE(ABORT, 'immutable scope'); END`,
  `CREATE TRIGGER scope_no_delete BEFORE DELETE ON scope BEGIN SELECT RAISE(ABORT, 'immutable scope'); END`,
  `CREATE TRIGGER sessions_no_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'immutable session'); END`,
  `CREATE TRIGGER sessions_no_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'immutable session'); END`,
];
const sessionQuery = `SELECT *, CAST(session_digest AS BLOB) AS session_bytes,
  CAST(first_origin_digest AS BLOB) AS origin_bytes FROM sessions`;
interface Ownership { db: DatabaseSync; stamp: Stats }
export interface SQLiteSessionCorrelation extends SessionCorrelationPort {
  observeSession(input: Readonly<SessionObservation>): SessionObservationResult;
  close(): void;
}

export function initializeSessionCorrelation(path: string, scope: Readonly<JournalScope>): void {
  const scopeDigest = sessionScopeDigest(scope);
  let guard: Ownership | undefined; let db: DatabaseSync | undefined;
  try {
    path = canonicalPath(path);
    if (lstatSync(path, { throwIfNoEntry: false })) throw new DeliveryJournalError('exists');
    guard = acquireGuard(path, true);
    const stamp = createFile(path); db = new DatabaseSync(path, { allowExtension: false });
    sameFile(path, stamp); configure(db);
    transaction(db, () => {
      db!.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1`);
      for (const sql of schema) db!.exec(sql);
      db!.prepare('INSERT INTO scope VALUES (1, ?)').run(scopeDigest);
    });
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) { throw storageError(error); }
  finally { try { db?.close(); } finally { guard?.db.close(); } }
}

export function openSessionCorrelation(path: string, scope: Readonly<JournalScope>, limits: { maxSessions?: number } = {}): SQLiteSessionCorrelation {
  const scopeDigest = sessionScopeDigest(scope);
  if (!limits || typeof limits !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(limits)) ||
      Reflect.ownKeys(limits).some(key => key !== 'maxSessions')) throw new DeliveryJournalError('invalid-input');
  const descriptor = Object.getOwnPropertyDescriptor(limits, 'maxSessions');
  if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) throw new DeliveryJournalError('invalid-input');
  const maxSessions = sessionCorrelationLimit(descriptor ? descriptor.value : undefined);
  let guard: Ownership | undefined; let db: DatabaseSync | undefined;
  try {
    path = canonicalPath(path); const stamp = regularFile(path);
    guard = acquireGuard(path, false); sameFile(path, stamp);
    if (!stamp.size) throw new DeliveryJournalError('corrupt');
    db = new DatabaseSync(path, { allowExtension: false }); sameFile(path, stamp); configure(db);
    transaction(db, () => validateStore(db!, scopeDigest, maxSessions));
    const main = db; const owner = guard; let closed = false; let failed = false;
    return {
      observeSession(input) {
        if (closed) throw new DeliveryJournalError('closed');
        if (failed) throw new DeliveryJournalError('unavailable');
        const observation = validateSessionObservation(input);
        try {
          sameFile(path, stamp); sameFile(`${path}.owner.sqlite`, owner.stamp);
          return transaction(main, (): SessionObservationResult => {
            const existing = main.prepare(`${sessionQuery} WHERE session_digest = ?`).get(observation.sessionDigest);
            if (existing) return { kind: 'observed', continuation: decodeSession(existing).originDigest !== observation.originDigest };
            const count = main.prepare('SELECT count(*) AS n FROM sessions').get()?.n;
            if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > maxSessions) throw new DeliveryJournalError('corrupt');
            if (count === maxSessions) return { kind: 'full' };
            main.prepare('INSERT INTO sessions VALUES (?, ?)').run(observation.sessionDigest, observation.originDigest);
            return { kind: 'observed', continuation: false };
          });
        } catch (error) { failed = true; throw storageError(error); }
      },
      close() { if (closed) return; closed = true; try { main.close(); } finally { owner.db.close(); } },
    };
  } catch (error) {
    try { db?.close(); } finally { guard?.db.close(); }
    throw storageError(error);
  }
}
function storedDigest(value: unknown, bytes: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value) || !(bytes instanceof Uint8Array) ||
      !Buffer.from(value).equals(bytes)) throw new DeliveryJournalError('corrupt');
  return value;
}
function decodeSession(row: Record<string, unknown>): SessionObservation {
  return { sessionDigest: storedDigest(row.session_digest, row.session_bytes), originDigest: storedDigest(row.first_origin_digest, row.origin_bytes) };
}
function validateStore(db: DatabaseSync, expected: string, maxSessions: number): void {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
      db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
      db.prepare('PRAGMA encoding').get()?.encoding !== 'UTF-8') throw new DeliveryJournalError('unsupported-schema');
  const actual = db.prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL').all().map(row => row.sql);
  if (actual.length !== schema.length || schema.some(sql => !actual.includes(sql))) throw new DeliveryJournalError('corrupt');
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new DeliveryJournalError('corrupt');
  const rows = db.prepare('SELECT *, CAST(digest AS BLOB) AS digest_bytes FROM scope').all();
  if (rows.length !== 1 || rows[0]?.singleton !== 1) throw new DeliveryJournalError('corrupt');
  if (storedDigest(rows[0].digest, rows[0].digest_bytes) !== expected) throw new DeliveryJournalError('scope-mismatch');
  let count = 0;
  for (const row of db.prepare(sessionQuery).iterate()) {
    decodeSession(row); if (++count > maxSessions) throw new DeliveryJournalError('corrupt');
  }
}
function canonicalPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || /[\uD800-\uDFFF]/u.test(path) || path.endsWith('/'))
    throw new DeliveryJournalError('invalid-input');
  return join(realpathSync(dirname(path)), basename(path));
}
function createFile(path: string): Stats {
  // Only exclusive new files may use ordinary FDs: closing an existing inode can drop POSIX locks.
  const fd = openSync(path, 'wx', 0o600);
  try { fsyncSync(fd); return fstatSync(fd); } finally { closeSync(fd); }
}
function regularFile(path: string): Stats {
  const stamp = lstatSync(path);
  if (!stamp.isFile() || stamp.nlink !== 1) throw new DeliveryJournalError('invalid-input');
  return stamp;
}
function sameFile(path: string, expected: Stats): void {
  let actual: Stats;
  try { actual = regularFile(path); } catch (error) { throw new DeliveryJournalError('unavailable', { cause: error }); }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new DeliveryJournalError('unavailable');
}
function acquireGuard(path: string, initialize: boolean): Ownership {
  const ownerPath = `${path}.owner.sqlite`;
  if (initialize && !lstatSync(ownerPath, { throwIfNoEntry: false })) {
    try { createFile(ownerPath); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  const stamp = regularFile(ownerPath); const guard = new DatabaseSync(ownerPath, { allowExtension: false });
  try {
    sameFile(ownerPath, stamp); configure(guard); guard.exec('BEGIN EXCLUSIVE'); sameFile(ownerPath, stamp);
    return { db: guard, stamp };
  } catch (error) {
    guard.close();
    if ([5, 6].includes(sqliteCode(error) ?? 0)) throw new DeliveryJournalError('busy', { cause: error });
    throw error;
  }
}
function configure(db: DatabaseSync): void {
  if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw new DeliveryJournalError('unavailable');
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0; PRAGMA trusted_schema = OFF');
  if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete' || db.prepare('PRAGMA synchronous').get()?.synchronous !== 3 ||
      db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 || db.prepare('PRAGMA busy_timeout').get()?.timeout !== 0) throw new DeliveryJournalError('unavailable');
}
function transaction<T>(db: DatabaseSync, action: () => T): T {
  try { db.exec('BEGIN IMMEDIATE'); const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
function sqliteCode(error: unknown): number | undefined {
  return error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' ? error.errcode & 0xff : undefined;
}
function storageError(error: unknown): DeliveryJournalError {
  if (error instanceof DeliveryJournalError) return error;
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return new DeliveryJournalError(code === 'ENOENT' ? 'missing' : code === 'EEXIST' ? 'exists' :
    [11, 26].includes(sqliteCode(error) ?? 0) ? 'corrupt' : 'unavailable', { cause: error });
}
