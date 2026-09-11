import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { identity, requestIdentity, validateClaim, validateOutcome, validateScope } from './identity.js';
import type { RequestIdentity } from './identity.js';
import { DeliveryJournalError } from './types.js';
import type { BeginDeliveryResult, DeliveryClaim, DeliveryJournal, DeliveryOutcome, JournalScope, SettlementResult } from './types.js';
export { DeliveryJournalError } from './types.js';
export type * from './types.js';

const APPLICATION_ID = 0x4f54444a; // OTDJ: Orka Teams delivery journal
const SCHEMA_VERSION = 1;
const schema = [
  `CREATE TABLE scope (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    app_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
    fingerprint_version INTEGER NOT NULL CHECK (fingerprint_version = 1)
  ) STRICT`,
  `CREATE TABLE operations (
    idempotency_id TEXT PRIMARY KEY NOT NULL,
    fingerprint_version INTEGER NOT NULL CHECK (fingerprint_version = 1),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    attempt_id TEXT NOT NULL CHECK (length(attempt_id) > 0),
    state TEXT NOT NULL CHECK (state IN ('ready', 'sending', 'delivered', 'rejected', 'unknown')),
    provider_message_id TEXT,
    CHECK ((state = 'delivered' AND provider_message_id IS NOT NULL AND length(provider_message_id) > 0)
      OR (state != 'delivered' AND provider_message_id IS NULL))
  ) STRICT`,
  `CREATE TABLE aliases (
    identifier TEXT PRIMARY KEY NOT NULL,
    idempotency_id TEXT NOT NULL REFERENCES operations(idempotency_id)
  ) STRICT`,
  `CREATE TRIGGER scope_no_update BEFORE UPDATE ON scope BEGIN
    SELECT RAISE(ABORT, 'immutable scope'); END`,
  `CREATE TRIGGER scope_no_delete BEFORE DELETE ON scope BEGIN
    SELECT RAISE(ABORT, 'immutable scope'); END`,
];
const operationQuery = `SELECT *, CAST(idempotency_id AS BLOB) AS idempotency_id_bytes,
  CAST(provider_message_id AS BLOB) AS provider_message_id_bytes FROM operations`;
const aliasQuery = `SELECT *, CAST(identifier AS BLOB) AS identifier_bytes,
  CAST(idempotency_id AS BLOB) AS idempotency_id_bytes FROM aliases`;

export function initializeDeliveryJournal(path: string, inputScope: Readonly<JournalScope>): void {
  const scope = validateScope(inputScope);
  let guard: Ownership | undefined;
  let db: DatabaseSync | undefined;
  try {
    path = canonicalPath(path);
    if (lstatSync(path, { throwIfNoEntry: false })) throw new DeliveryJournalError('exists');
    guard = acquireGuard(path, true);
    const stamp = createFile(path);
    db = new DatabaseSync(path, { allowExtension: false });
    sameFile(path, stamp);
    configure(db);
    transaction(db, () => {
      db!.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`);
      for (const sql of schema) db!.exec(sql);
      db!.prepare('INSERT INTO scope VALUES (1, ?, ?, 1)').run(scope.appId, scope.tenantId);
    });
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    throw storageError(error);
  } finally {
    // Failed provisioning remains present and must never be silently reset.
    try { db?.close(); } finally { guard?.db.close(); }
  }
}

export function openDeliveryJournal(path: string, inputScope: Readonly<JournalScope>): DeliveryJournal {
  const scope = validateScope(inputScope);
  let guard: Ownership | undefined;
  let db: DatabaseSync | undefined;
  try {
    path = canonicalPath(path);
    const stamp = regularFile(path);
    guard = acquireGuard(path, false);
    const guardStamp = guard.stamp;
    sameFile(path, stamp);
    if (stamp.size === 0) throw new DeliveryJournalError('corrupt');
    db = new DatabaseSync(path, { allowExtension: false });
    sameFile(path, stamp);
    configure(db);
    transaction(db, () => {
      validateStore(db!, scope);
      db!.exec("UPDATE operations SET state = 'unknown' WHERE state = 'sending'");
    });
    const main = db;
    const owner = guard.db;
    let closed = false;
    let failed = false;
    const check = () => {
      if (closed) throw new DeliveryJournalError('closed');
      if (failed) throw new DeliveryJournalError('unavailable');
    };
    const run = <T>(action: () => T): T => {
      try {
        sameFile(path, stamp);
        sameFile(`${path}.owner.sqlite`, guardStamp);
        return transaction(main, action);
      } catch (error) {
        // Never reconnect or grant permission after a failed/uncertain DB write.
        failed = true;
        throw storageError(error);
      }
    };
    return {
      begin(request) {
        check();
        const key = requestIdentity(request, scope);
        return run(() => begin(main, key));
      },
      settle(inputClaim, inputOutcome) {
        check();
        const claim = validateClaim(inputClaim);
        const outcome = validateOutcome(inputOutcome);
        return run(() => settle(main, claim, outcome));
      },
      close() {
        if (closed) return;
        closed = true;
        try { main.close(); } finally { owner.close(); }
      },
    };
  } catch (error) {
    try { db?.close(); } finally { guard?.db.close(); }
    throw storageError(error);
  }
}

interface Operation {
  idempotencyId: string;
  digest: string;
  attemptId: string;
  state: 'ready' | 'sending' | 'delivered' | 'rejected' | 'unknown';
  providerMessageId: string | null;
}

function begin(db: DatabaseSync, key: RequestIdentity): BeginDeliveryResult {
  const stable = resolveAlias(db, key.idempotencyId);
  const delivery = resolveAlias(db, key.deliveryId);
  if ((stable && stable !== key.idempotencyId) || (delivery && delivery !== key.idempotencyId)) return { kind: 'conflict' };
  const existing = readOperation(db, key.idempotencyId);
  if (existing && (!stable || existing.digest !== key.digest)) {
    if (!stable) throw new DeliveryJournalError('corrupt');
    return { kind: 'conflict' };
  }
  if (!existing && (stable || delivery)) throw new DeliveryJournalError('corrupt');
  let attemptId = existing?.attemptId;
  if (!existing) {
    attemptId = randomUUID();
    db.prepare(`INSERT INTO operations (idempotency_id, fingerprint_version, digest, attempt_id, state)
      VALUES (?, 1, ?, ?, 'sending')`).run(key.idempotencyId, key.digest, attemptId);
  }
  for (const alias of new Set([key.idempotencyId, key.deliveryId])) {
    if (!resolveAlias(db, alias)) db.prepare('INSERT INTO aliases VALUES (?, ?)').run(alias, key.idempotencyId);
  }
  if (existing?.state === 'ready') {
    attemptId = randomUUID();
    db.prepare("UPDATE operations SET state = 'sending', attempt_id = ? WHERE idempotency_id = ?").run(attemptId, key.idempotencyId);
  } else if (existing) {
    if (existing.state === 'sending') return { kind: 'inFlight' };
    if (existing.state === 'delivered') return { kind: 'delivered', providerMessageId: existing.providerMessageId! };
    return { kind: existing.state };
  }
  return { kind: 'claimed', claim: { idempotencyId: key.idempotencyId, attemptId: attemptId! } };
}

function settle(db: DatabaseSync, claim: DeliveryClaim, outcome: DeliveryOutcome): SettlementResult {
  const operation = readOperation(db, claim.idempotencyId);
  if (!operation || operation.attemptId !== claim.attemptId) return 'stale';
  const state = outcome.kind === 'retryable' ? 'ready' : outcome.kind;
  const receipt = outcome.kind === 'delivered' ? outcome.providerMessageId : null;
  if (operation.state !== 'sending') {
    return operation.state === state && operation.providerMessageId === receipt ? 'unchanged' : 'stale';
  }
  db.prepare('UPDATE operations SET state = ?, provider_message_id = ? WHERE idempotency_id = ?')
    .run(state, receipt, claim.idempotencyId);
  return 'recorded';
}

function resolveAlias(db: DatabaseSync, identifier: string): string | undefined {
  const target = readAlias(db, identifier);
  if (target && !readOperation(db, target)) throw new DeliveryJournalError('corrupt');
  return target;
}

function readAlias(db: DatabaseSync, identifier: string): string | undefined {
  const row = db.prepare(`${aliasQuery} WHERE identifier = ?`).get(identifier);
  return row ? decodeAlias(row) : undefined;
}

function decodeAlias(row: Record<string, unknown>): string {
  storedIdentity(row.identifier, row.identifier_bytes);
  return storedIdentity(row.idempotency_id, row.idempotency_id_bytes);
}

function readOperation(db: DatabaseSync, key: string): Operation | undefined {
  const row = db.prepare(`${operationQuery} WHERE idempotency_id = ?`).get(key);
  if (!row) return undefined;
  if (readAlias(db, key) !== key) throw new DeliveryJournalError('corrupt');
  return decodeOperation(row);
}

function storedIdentity(value: unknown, bytes: unknown): string {
  try {
    const decoded = identity(value);
    // SQLite TEXT decoding can replace malformed bytes. Require an exact UTF-8
    // roundtrip, preserving legitimate U+FFFD and leading BOM characters.
    if (!(bytes instanceof Uint8Array) || !Buffer.from(decoded, 'utf8').equals(bytes)) throw new DeliveryJournalError('corrupt');
    return decoded;
  } catch { throw new DeliveryJournalError('corrupt'); }
}

function decodeOperation(row: Record<string, unknown>): Operation {
  try {
    const idempotencyId = storedIdentity(row.idempotency_id, row.idempotency_id_bytes);
    const attemptId = identity(row.attempt_id);
    if (row.fingerprint_version !== 1 || typeof row.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.digest) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(attemptId) ||
        !['ready', 'sending', 'delivered', 'rejected', 'unknown'].includes(row.state as string)) throw new DeliveryJournalError('corrupt');
    const state = row.state as Operation['state'];
    const providerMessageId = state === 'delivered' ? storedIdentity(row.provider_message_id, row.provider_message_id_bytes) : null;
    if (state !== 'delivered' && row.provider_message_id !== null) throw new DeliveryJournalError('corrupt');
    return { idempotencyId, digest: row.digest, attemptId, state, providerMessageId };
  } catch { throw new DeliveryJournalError('corrupt'); }
}

function canonicalPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') ||
      /[\uD800-\uDFFF]/u.test(path) || path.endsWith('/')) throw new DeliveryJournalError('invalid-input');
  return join(realpathSync(dirname(path)), basename(path));
}

function createFile(path: string): Stats {
  // Never open/close an ordinary fd on an existing SQLite file: a close can
  // release another connection's POSIX locks in this process.
  const fd = openSync(path, 'wx', 0o600);
  try { fsyncSync(fd); return fstatSync(fd); } finally { closeSync(fd); }
}

function regularFile(path: string): Stats {
  const stamp = lstatSync(path);
  if (!stamp.isFile() || stamp.nlink !== 1) throw new DeliveryJournalError('invalid-input');
  return stamp;
}

function sameFile(path: string, expected: Stats): void {
  const actual = regularFile(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new DeliveryJournalError('unavailable');
}

interface Ownership { db: DatabaseSync; stamp: Stats }

function acquireGuard(path: string, initialize: boolean): Ownership {
  const ownerPath = `${path}.owner.sqlite`;
  if (initialize && !lstatSync(ownerPath, { throwIfNoEntry: false })) {
    try { createFile(ownerPath); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  const stamp = regularFile(ownerPath);
  const guard = new DatabaseSync(ownerPath, { allowExtension: false });
  try {
    sameFile(ownerPath, stamp);
    configure(guard);
    guard.exec('BEGIN EXCLUSIVE');
    sameFile(ownerPath, stamp);
    return { db: guard, stamp };
  } catch (error) {
    guard.close();
    if (sqliteCode(error) === 5 || sqliteCode(error) === 6) throw new DeliveryJournalError('busy', { cause: error });
    throw error;
  }
}

function configure(db: DatabaseSync): void {
  // Refuse WAL stores instead of converting them on this vulnerable SQLite version.
  if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw new DeliveryJournalError('unavailable');
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0; PRAGMA trusted_schema = OFF');
  if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete' ||
      db.prepare('PRAGMA synchronous').get()?.synchronous !== 3 ||
      db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
      db.prepare('PRAGMA busy_timeout').get()?.timeout !== 0) throw new DeliveryJournalError('unavailable');
}

function validateStore(db: DatabaseSync, expected: JournalScope): void {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
      db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION ||
      // CAST(TEXT AS BLOB) uses the store's encoding; initialized journals are UTF-8.
      db.prepare('PRAGMA encoding').get()?.encoding !== 'UTF-8') throw new DeliveryJournalError('unsupported-schema');
  const storedSchema = db.prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL').all().map((row) => row.sql);
  if (storedSchema.length !== schema.length || schema.some((sql) => !storedSchema.includes(sql))) throw new DeliveryJournalError('corrupt');
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new DeliveryJournalError('corrupt');
  const rows = db.prepare(`SELECT *, CAST(app_id AS BLOB) AS app_id_bytes,
    CAST(tenant_id AS BLOB) AS tenant_id_bytes FROM scope`).all();
  const row = rows[0];
  if (rows.length !== 1 || !row || row.singleton !== 1 || row.fingerprint_version !== 1) throw new DeliveryJournalError('corrupt');
  const actual = {
    appId: storedIdentity(row.app_id, row.app_id_bytes),
    tenantId: storedIdentity(row.tenant_id, row.tenant_id_bytes),
  };
  if (actual.appId !== expected.appId || actual.tenantId !== expected.tenantId) throw new DeliveryJournalError('scope-mismatch');
  for (const operation of db.prepare(operationQuery).iterate()) {
    const decoded = decodeOperation(operation);
    if (readAlias(db, decoded.idempotencyId) !== decoded.idempotencyId) throw new DeliveryJournalError('corrupt');
  }
  for (const alias of db.prepare(aliasQuery).iterate()) decodeAlias(alias);
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  try {
    db.exec('BEGIN IMMEDIATE');
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
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
