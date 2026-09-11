import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DeliveryJournalError, initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import type { DeliveryClaim, DeliveryJournal, DeliveryOutcome } from '../src/delivery/journal.js';
import type { DeliveryRequest } from '../src/protocol/types.js';
import { errorDelivery, finalDelivery } from './fixtures/outgoing.js';

const scope = { appId: 'app-fixture', tenantId: finalDelivery.accountId };
const errorCode = (code: string) => (error: unknown) => error instanceof DeliveryJournalError && error.code === code;

function store(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-journal-'));
  const path = join(directory, 'delivery.sqlite');
  const journals: DeliveryJournal[] = [];
  t.after(() => {
    for (const journal of journals) journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, path,
    initialize: () => initializeDeliveryJournal(path, scope),
    open: () => { const journal = openDeliveryJournal(path, scope); journals.push(journal); return journal; },
  };
}

function raw(path: string, action: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path);
  try { action(db); } finally { db.close(); }
}

test('normal open refuses a missing journal without creating any file', (t) => {
  const { path } = store(t);
  assert.throws(() => openDeliveryJournal(path, scope), errorCode('missing'));
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.owner.sqlite`), false);
});

test('explicit initialization creates private files and leaves a stable ownership sidecar', (t) => {
  const s = store(t);
  s.initialize();
  const owner = `${s.path}.owner.sqlite`;
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
  assert.equal(statSync(owner).mode & 0o777, 0o600);
  const inode = statSync(owner).ino;
  s.open().close();
  s.open().close();
  assert.equal(statSync(owner).ino, inode);
  raw(s.path, (db) => {
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  });
});

test('initialization refuses every existing file without changing it', (t) => {
  const s = store(t);
  for (const contents of ['', 'synthetic-unbranded-content']) {
    writeFileSync(s.path, contents, { mode: 0o600 });
    assert.throws(s.initialize, errorCode('exists'));
    assert.equal(readFileSync(s.path, 'utf8'), contents);
  }
  rmSync(s.path);
  s.initialize();
  const before = readFileSync(s.path);
  assert.throws(s.initialize, errorCode('exists'));
  assert.deepEqual(readFileSync(s.path), before);
});

test('live ownership excludes a second open including canonical parent aliases', (t) => {
  const s = store(t);
  s.initialize();
  const journal = s.open();
  const alias = join(s.directory, 'parent-alias');
  symlinkSync(s.directory, alias);
  assert.throws(s.open, errorCode('busy'));
  assert.throws(() => openDeliveryJournal(join(alias, 'delivery.sqlite'), scope), errorCode('busy'));
  journal.close();
  s.open().close();
});

test('wrong scope refuses the store and releases ownership for correct startup', (t) => {
  const s = store(t);
  s.initialize();
  for (const other of [{ ...scope, appId: 'other-app' }, { ...scope, tenantId: 'other-tenant' }]) {
    assert.throws(() => openDeliveryJournal(s.path, other), errorCode('scope-mismatch'));
  }
  s.open().close();
});

function claim(journal: DeliveryJournal, request: DeliveryRequest = finalDelivery): DeliveryClaim {
  const result = journal.begin(request);
  assert.equal(result.kind, 'claimed');
  if (result.kind !== 'claimed') throw new Error('expected synthetic claim');
  assert.equal(result.claim.idempotencyId, request.idempotencyId);
  assert.match(result.claim.attemptId, /^[0-9a-f-]{36}$/u);
  return result.claim;
}

test('saved receipt replays across restart and fresh aliases without new send permission', (t) => {
  const s = store(t); s.initialize();
  let journal = s.open();
  const started = claim(journal);
  assert.deepEqual(journal.begin(finalDelivery), { kind: 'inFlight' });
  const receipt = { kind: 'delivered', providerMessageId: 'provider-fixture-1' } as const;
  assert.equal(journal.settle(started, receipt), 'recorded');
  assert.equal(journal.settle(started, receipt), 'unchanged');
  journal.close();
  journal = s.open();
  for (const deliveryId of [finalDelivery.deliveryId, 'alias-2', finalDelivery.idempotencyId]) {
    assert.deepEqual(journal.begin({ ...finalDelivery, deliveryId }), receipt);
  }
});

test('aliases share one namespace and changed stable IDs cannot reuse an old delivery alias', (t) => {
  const s = store(t); s.initialize(); const journal = s.open();
  const started = claim(journal);
  assert.deepEqual(journal.begin({ ...finalDelivery, deliveryId: 'compatible-alias' }), { kind: 'inFlight' });
  assert.deepEqual(journal.begin({ ...finalDelivery, idempotencyId: 'new-stable' }), { kind: 'conflict' });
  assert.deepEqual(journal.begin({ ...finalDelivery, idempotencyId: 'compatible-alias', deliveryId: 'fresh' }), { kind: 'conflict' });
  claim(journal, errorDelivery);
  assert.deepEqual(journal.begin({ ...finalDelivery, deliveryId: errorDelivery.idempotencyId }), { kind: 'conflict' });
  assert.deepEqual(journal.begin({ ...errorDelivery, deliveryId: finalDelivery.deliveryId }), { kind: 'conflict' });
  assert.equal(journal.settle(started, { kind: 'rejected' }), 'recorded');
  assert.deepEqual(journal.begin({ ...finalDelivery, deliveryId: 'compatible-alias' }), { kind: 'rejected' });
});

test('metadata ordering and empty optional values are equivalent without mutating input', (t) => {
  const s = store(t); s.initialize(); const journal = s.open();
  const request = Object.freeze({ ...finalDelivery, metadata: Object.freeze({ z: 'last', a: 'first' }), taskRef: Object.freeze({ ...finalDelivery.taskRef }) });
  const before = JSON.stringify(request);
  const started = claim(journal, request);
  assert.deepEqual(journal.begin({ ...request, metadata: { a: 'first', z: 'last' }, threadId: '' }), { kind: 'inFlight' });
  assert.equal(JSON.stringify(request), before);
  assert.equal(journal.settle(started, { kind: 'unknown' }), 'recorded');
  const second = claim(journal, errorDelivery);
  assert.deepEqual(journal.begin({ ...errorDelivery, metadata: {}, threadId: '' }), { kind: 'inFlight' });
  assert.notEqual(second.attemptId, started.attemptId);
});

const immutableChanges: [string, Partial<DeliveryRequest>][] = [
  ['origin', { originatingEventId: 'different-event' }],
  ['context', { contextId: 'different-context' }],
  ['reply key', { replyTarget: 'different-reply' }],
  ['thread', { threadId: 'different-thread' }],
  ['kind', { kind: 'error' }],
  ['text', { text: 'different-text' }],
  ['text whitespace', { text: `${finalDelivery.text} ` }],
  ['task namespace', { taskRef: { namespace: 'other', name: finalDelivery.taskRef.name } }],
  ['task name', { taskRef: { ...finalDelivery.taskRef, name: 'other' } }],
  ['session namespace', { sessionRef: { namespace: 'other', name: finalDelivery.sessionRef.name } }],
  ['session name', { sessionRef: { ...finalDelivery.sessionRef, name: 'other' } }],
  ['metadata', { metadata: { key: 'value' } }],
];
for (const [name, change] of immutableChanges) {
  test(`changed ${name} cannot disclose a receipt or admit an alias`, (t) => {
    const s = store(t); s.initialize(); const journal = s.open();
    journal.settle(claim(journal), { kind: 'delivered', providerMessageId: 'saved-fixture' });
    assert.deepEqual(journal.begin({ ...finalDelivery, ...change, deliveryId: 'conflicting-alias' }), { kind: 'conflict' });
    // The failed begin must not reserve its new alias.
    claim(journal, { ...errorDelivery, deliveryId: 'conflicting-alias' });
  });
}

for (const ref of ['taskRef', 'sessionRef'] as const) {
  test(`removing ${ref} is an immutable payload conflict`, (t) => {
    const s = store(t); s.initialize(); const journal = s.open(); claim(journal);
    const request: DeliveryRequest = { ...finalDelivery }; delete request[ref];
    assert.deepEqual(journal.begin(request), { kind: 'conflict' });
  });
}

test('metadata values, exact Unicode and identity case remain significant', (t) => {
  const s = store(t); s.initialize(); const journal = s.open();
  const request = { ...finalDelivery, text: 'é', metadata: { key: 'one' } };
  claim(journal, request);
  for (const change of [{ text: 'e\u0301' }, { metadata: { key: 'two' } }, { contextId: request.contextId.toUpperCase() }]) {
    assert.deepEqual(journal.begin({ ...request, ...change }), { kind: 'conflict' });
  }
});

test('only proven retryable settlement rotates attempts and fences old results', (t) => {
  const s = store(t); s.initialize(); const journal = s.open();
  const first = claim(journal);
  assert.equal(journal.settle(first, { kind: 'retryable' }), 'recorded');
  assert.equal(journal.settle(first, { kind: 'retryable' }), 'unchanged');
  assert.equal(journal.settle(first, { kind: 'delivered', providerMessageId: 'late-fixture' }), 'stale');
  const second = claim(journal, { ...finalDelivery, deliveryId: 'retry-alias' });
  assert.notEqual(first.attemptId, second.attemptId);
  for (const outcome of [{ kind: 'retryable' }, { kind: 'unknown' }, { kind: 'delivered', providerMessageId: 'late-fixture' }] as const) {
    assert.equal(journal.settle(first, outcome), 'stale');
  }
  assert.deepEqual(journal.begin(finalDelivery), { kind: 'inFlight' });
  assert.equal(journal.settle(second, { kind: 'delivered', providerMessageId: 'current-fixture' }), 'recorded');
  assert.equal(journal.settle(second, { kind: 'delivered', providerMessageId: 'different-fixture' }), 'stale');
});

for (const terminal of [{ kind: 'unknown' }, { kind: 'rejected' }, { kind: 'delivered', providerMessageId: 'saved-fixture' }] as const) {
  test(`${terminal.kind} is permanent across close, aliases, and manual same-ID redrive`, (t) => {
    const s = store(t); s.initialize(); let journal = s.open();
    const started = claim(journal);
    assert.equal(journal.settle(started, terminal), 'recorded');
    assert.equal(journal.settle(started, terminal), 'unchanged');
    for (const outcome of [{ kind: 'retryable' }, { kind: 'unknown' }, { kind: 'rejected' }, { kind: 'delivered', providerMessageId: 'changed-fixture' }] as const) {
      assert.equal(journal.settle(started, outcome), outcome.kind === terminal.kind && terminal.kind !== 'delivered' ? 'unchanged' : 'stale');
    }
    journal.close(); journal = s.open();
    assert.deepEqual(journal.begin({ ...finalDelivery, deliveryId: 'manual-redrive' }), terminal);
    assert.deepEqual(journal.begin(finalDelivery), terminal);
    assert.equal(journal.settle({ ...started, attemptId: 'stale-attempt' }, { kind: 'retryable' }), 'stale');
    assert.equal(journal.settle({ ...started, idempotencyId: 'nonexistent' }, terminal), 'stale');
  });
}

const invalidRequests: [string, Record<string, unknown>][] = [
  ['protocol version', { protocolVersion: 'orka.gateway.v2' }], ['kind', { kind: 'progress' }],
  ['wrong tenant', { accountId: 'wrong-account' }], ['missing text', { text: undefined }],
  ['null text', { text: null }], ['nonstring text', { text: 12 }],
  ['oversized text', { text: 'é'.repeat(32769) }], ['lone surrogate', { text: '\ud800' }],
  ['text control', { text: 'a\u0000b' }], ['text C1', { text: 'a\u0085b' }],
  ['null thread', { threadId: null }], ['undefined thread', { threadId: undefined }],
  ['partial task', { taskRef: { namespace: 'fixture' } }], ['empty session', { sessionRef: {} }],
  ['extra ref key', { taskRef: { ...finalDelivery.taskRef, url: 'synthetic-private-value' } }],
  ['null metadata', { metadata: null }], ['array metadata', { metadata: [] }],
  ['nonstring metadata', { metadata: { key: 7 } }], ['empty metadata key', { metadata: { '': 'value' } }],
  ['oversized metadata key', { metadata: { ['k'.repeat(257)]: 'value' } }],
  ['oversized metadata value', { metadata: { k: 'é'.repeat(129) } }],
  ['metadata control', { metadata: { k: 'a\nb' } }], ['metadata surrogate', { metadata: { k: '\udc00' } }],
  ['too many metadata', { metadata: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v'])) }],
  ['extra request field', { token: 'synthetic-private-value' }],
];
for (const field of ['deliveryId', 'idempotencyId', 'originatingEventId', 'accountId', 'contextId', 'replyTarget']) {
  for (const [label, value] of [['empty', ''], ['null', null], ['number', 1], ['whitespace', ' x'], ['unicode whitespace', 'x\u0085'], ['control', 'a\tb'], ['surrogate', '\ud800'], ['byte bound', 'é'.repeat(129)]] as const) {
    invalidRequests.push([`${field} ${label}`, { [field]: value }]);
  }
}
for (const [name, change] of invalidRequests) {
  test(`invalid ${name} is refused safely before admission`, (t) => {
    const s = store(t); s.initialize(); const journal = s.open();
    assert.throws(() => journal.begin({ ...finalDelivery, ...change } as DeliveryRequest), errorCode('invalid-input'));
    claim(journal);
  });
}

test('valid Unicode, exact byte bounds, blank text and metadata are accepted', (t) => {
  const s = store(t); s.initialize(); const journal = s.open();
  claim(journal, { ...finalDelivery, text: 'é'.repeat(32768), deliveryId: 'é'.repeat(128), contextId: '\ufeffcontext\ufeff', threadId: '🧑🏽‍💻', metadata: { ['k'.repeat(256)]: 'é'.repeat(128), empty: '', whitespace: ' ' } });
  claim(journal, { ...errorDelivery, text: '\t\r\n' });
  claim(journal, { ...errorDelivery, deliveryId: 'empty', idempotencyId: 'empty', text: '' });
});

test('non-data properties are rejected rather than executed or silently dropped', (t) => {
  const s = store(t); s.initialize(); const journal = s.open();
  let read = false;
  const getter = { ...finalDelivery, get text() { read = true; return 'getter text'; } };
  assert.throws(() => journal.begin(getter), errorCode('invalid-input'));
  assert.equal(read, false);
  for (const request of [Object.assign(Object.create({ extra: 'value' }), finalDelivery), { ...finalDelivery, [Symbol('extra')]: true }, Object.defineProperty({ ...finalDelivery }, 'extra', { value: true })]) {
    assert.throws(() => journal.begin(request), errorCode('invalid-input'));
  }
  claim(journal);
});

for (const receipt of ['', ' ', '\ud800', 'a\nb', 'é'.repeat(129), null, 7]) {
  test(`invalid provider receipt ${JSON.stringify(receipt)} cannot settle a claim`, (t) => {
    const s = store(t); s.initialize(); const journal = s.open(); const started = claim(journal);
    assert.throws(() => journal.settle(started, { kind: 'delivered', providerMessageId: receipt } as DeliveryOutcome), errorCode('invalid-input'));
    assert.deepEqual(journal.begin(finalDelivery), { kind: 'inFlight' });
    assert.equal(journal.settle(started, { kind: 'unknown' }), 'recorded');
  });
}

test('malformed outcomes and claims never change durable state', (t) => {
  const s = store(t); s.initialize(); const journal = s.open(); const started = claim(journal);
  for (const outcome of [{ kind: 'delivered' }, { kind: 'sent' }, { kind: 'unknown', providerMessageId: 'extra' }, { kind: 'retryable', proof: 'extra' }, null]) {
    assert.throws(() => journal.settle(started, outcome as DeliveryOutcome), errorCode('invalid-input'));
  }
  for (const broken of [{ ...started, attemptId: '' }, { ...started, idempotencyId: null }, { ...started, token: 'extra' }, null]) {
    assert.throws(() => journal.settle(broken as DeliveryClaim, { kind: 'unknown' }), errorCode('invalid-input'));
  }
  assert.deepEqual(journal.begin(finalDelivery), { kind: 'inFlight' });
});

for (const value of ['', '\u0085', '\ud800', ' x', 'x ', 'é'.repeat(129), null, 7]) {
  test(`invalid scope ${JSON.stringify(value)} cannot provision storage`, (t) => {
    const s = store(t);
    assert.throws(() => initializeDeliveryJournal(s.path, { ...scope, appId: value } as typeof scope), errorCode('invalid-input'));
    assert.equal(existsSync(s.path), false);
  });
}

for (const value of ['', ':memory:', 'relative.sqlite', 'file:/tmp/journal.sqlite']) {
  test(`rejects non-absolute or special path ${JSON.stringify(value)}`, () => {
    assert.throws(() => initializeDeliveryJournal(value, scope), errorCode('invalid-input'));
    assert.throws(() => openDeliveryJournal(value, scope), errorCode('invalid-input'));
  });
}

test('parent must exist and final symlinks, directories and hard links are refused', (t) => {
  const s = store(t);
  const absent = join(s.directory, 'absent', 'journal.sqlite');
  assert.throws(() => initializeDeliveryJournal(absent, scope), errorCode('missing'));
  assert.equal(existsSync(join(s.directory, 'absent')), false);
  s.initialize();
  const alias = join(s.directory, 'alias.sqlite');
  symlinkSync(s.path, alias);
  assert.throws(() => openDeliveryJournal(alias, scope), errorCode('invalid-input'));
  rmSync(alias);
  linkSync(s.path, alias);
  assert.throws(s.open, errorCode('invalid-input'));
  rmSync(alias);
  const directory = join(s.directory, 'directory.sqlite');
  mkdirSync(directory);
  assert.throws(() => openDeliveryJournal(directory, scope), errorCode('invalid-input'));
});

for (const mode of ['empty', 'unbranded', 'bytes', 'version', 'brand', 'schema'] as const) {
  test(`refuses ${mode} stores without replacing or repairing their contents`, (t) => {
    const s = store(t);
    s.initialize();
    if (mode === 'empty') writeFileSync(s.path, '');
    if (mode === 'bytes') writeFileSync(s.path, 'not-a-sqlite-database');
    if (mode === 'unbranded') {
      rmSync(s.path);
      raw(s.path, (db) => db.exec('CREATE TABLE unrelated (value TEXT)'));
    }
    if (mode === 'version') raw(s.path, (db) => db.exec('PRAGMA user_version=99'));
    if (mode === 'brand') raw(s.path, (db) => db.exec('PRAGMA application_id=99'));
    if (mode === 'schema') raw(s.path, (db) => db.exec('DROP TABLE aliases'));
    const before = readFileSync(s.path);
    assert.throws(s.open, errorCode(['empty', 'bytes', 'schema'].includes(mode) ? 'corrupt' : 'unsupported-schema'));
    assert.deepEqual(readFileSync(s.path), before);
    // Failed startup must not leave a live guard lock behind.
    raw(`${s.path}.owner.sqlite`, (db) => db.exec('BEGIN EXCLUSIVE; ROLLBACK'));
  });
}

for (const phase of ['BEGIN', 'COMMIT'] as const) {
  test(`${phase} lock failure leaks no claim, partial operation or alias and poisons the handle`, (t) => {
    const s = store(t); s.initialize(); const journal = s.open();
    const blocker = new DatabaseSync(s.path);
    try {
      blocker.exec(phase === 'BEGIN' ? 'BEGIN IMMEDIATE' : 'BEGIN; SELECT * FROM operations');
      assert.throws(() => journal.begin(finalDelivery), (error: unknown) => {
        assert.ok(error instanceof DeliveryJournalError);
        assert.equal(error.code, 'unavailable');
        assert.ok(error.cause instanceof Error && 'errcode' in error.cause && error.cause.errcode === 5);
        return true;
      });
      blocker.exec('ROLLBACK');
      assert.equal(blocker.prepare('SELECT count(*) AS n FROM operations').get()?.n, 0);
      assert.equal(blocker.prepare('SELECT count(*) AS n FROM aliases').get()?.n, 0);
      assert.throws(() => journal.begin(finalDelivery), errorCode('unavailable'));
    } finally { blocker.close(); journal.close(); }
    claim(s.open());
  });
}

test('COMMIT failure cannot persist a new alias or rewrite a saved receipt', (t) => {
  const s = store(t); s.initialize(); const journal = s.open();
  const receipt = { kind: 'delivered', providerMessageId: 'provider-before-lock' } as const;
  journal.settle(claim(journal), receipt);
  const blocker = new DatabaseSync(s.path);
  try {
    blocker.exec('BEGIN; SELECT * FROM operations');
    assert.throws(() => journal.begin({ ...finalDelivery, deliveryId: 'failed-alias' }), errorCode('unavailable'));
    blocker.exec('ROLLBACK');
    assert.equal(blocker.prepare('SELECT count(*) AS n FROM aliases WHERE identifier = ?').get('failed-alias')?.n, 0);
  } finally { blocker.close(); journal.close(); }
  const next = s.open();
  assert.deepEqual(next.begin(finalDelivery), receipt);
  claim(next, { ...errorDelivery, deliveryId: 'failed-alias' });
});

test('failed receipt COMMIT stays blocked and recovers unknown rather than granting a retry', (t) => {
  const s = store(t); s.initialize(); const journal = s.open(); const started = claim(journal);
  const blocker = new DatabaseSync(s.path);
  try {
    blocker.exec('BEGIN; SELECT * FROM operations');
    assert.throws(() => journal.settle(started, { kind: 'delivered', providerMessageId: 'unrecorded-fixture' }), errorCode('unavailable'));
    blocker.exec('ROLLBACK');
    assert.equal(blocker.prepare('SELECT state FROM operations').get()?.state, 'sending');
    assert.throws(() => journal.settle(started, { kind: 'retryable' }), errorCode('unavailable'));
  } finally { blocker.close(); journal.close(); }
  assert.deepEqual(s.open().begin(finalDelivery), { kind: 'unknown' });
});

const corruptions: [string, (db: DatabaseSync) => void][] = [
  ['invalid state', (db) => db.exec("PRAGMA ignore_check_constraints=ON; UPDATE operations SET state='lost'")],
  ['invalid fingerprint version', (db) => db.exec('PRAGMA ignore_check_constraints=ON; UPDATE operations SET fingerprint_version=2')],
  ['invalid digest', (db) => db.exec("PRAGMA ignore_check_constraints=ON; UPDATE operations SET digest='bad'")],
  ['invalid attempt', (db) => db.exec("UPDATE operations SET attempt_id='not-an-attempt'")],
  ['missing receipt', (db) => db.exec("PRAGMA ignore_check_constraints=ON; UPDATE operations SET state='delivered'")],
  ['malformed receipt', (db) => db.exec("UPDATE operations SET state='delivered', provider_message_id=' malformed '")],
  ['oversized receipt', (db) => db.prepare("UPDATE operations SET state='delivered', provider_message_id=?").run('x'.repeat(257))],
  ['orphan alias', (db) => db.exec("PRAGMA foreign_keys=OFF; INSERT INTO aliases VALUES ('orphan', 'absent')")],
  ['missing self alias', (db) => db.prepare('DELETE FROM aliases WHERE identifier=?').run(finalDelivery.idempotencyId)],
  ['invalid alias', (db) => db.prepare('INSERT INTO aliases VALUES (?, ?)').run(' bad ', finalDelivery.idempotencyId)],
];
for (const [name, corrupt] of corruptions) {
  test(`${name} refuses startup before any abandoned-send recovery`, (t) => {
    const s = store(t); s.initialize(); const journal = s.open(); claim(journal); journal.close();
    raw(s.path, corrupt);
    const before = readFileSync(s.path);
    assert.throws(s.open, errorCode('corrupt'));
    assert.deepEqual(readFileSync(s.path), before);
  });
}

test('corruption encountered by a live handle cannot return a cached receipt or later claim', (t) => {
  const s = store(t); s.initialize(); const journal = s.open(); claim(journal);
  raw(s.path, (db) => db.exec("UPDATE operations SET state='delivered', provider_message_id=' malformed '"));
  assert.throws(() => journal.begin(finalDelivery), errorCode('corrupt'));
  assert.throws(() => journal.begin(errorDelivery), errorCode('unavailable'));
});

test('schema enforces immutable scope, alias uniqueness, foreign keys and receipt/state pairing', (t) => {
  const s = store(t); s.initialize(); const journal = s.open(); claim(journal); journal.close();
  raw(s.path, (db) => {
    assert.throws(() => db.exec("UPDATE scope SET app_id='changed'"));
    assert.throws(() => db.exec('DELETE FROM scope'));
    assert.throws(() => db.exec("INSERT INTO scope VALUES (2, 'app', 'tenant', 1)"));
    assert.throws(() => db.prepare('INSERT INTO aliases VALUES (?, ?)').run(finalDelivery.deliveryId, finalDelivery.idempotencyId));
    assert.throws(() => db.exec("INSERT INTO aliases VALUES ('orphan', 'missing')"));
    assert.throws(() => db.exec("UPDATE operations SET state='delivered'"));
    assert.throws(() => db.exec("UPDATE operations SET provider_message_id='unexpected'"));
  });
});

test('only digest, scope, opaque IDs, attempt and receipt are persisted, never request text or metadata', (t) => {
  const s = store(t); s.initialize(); const journal = s.open();
  const marker = 'SYNTHETIC-PRIVATE-TEXT-e6ee0a';
  const metadataMarker = 'SYNTHETIC-PRIVATE-METADATA-456';
  const request = { ...finalDelivery, text: marker, metadata: { private: metadataMarker }, replyTarget: 'synthetic-routing-marker' };
  journal.settle(claim(journal, request), { kind: 'delivered', providerMessageId: 'confirmed-synthetic-provider' });
  journal.close(); // Ordinary fd close can disrupt SQLite POSIX locks: never read live DB bytes.
  const bytes = readFileSync(s.path);
  for (const hidden of [marker, metadataMarker, request.replyTarget, request.originatingEventId, request.contextId, request.taskRef.name]) {
    assert.equal(bytes.includes(Buffer.from(hidden)), false);
  }
  raw(s.path, (db) => {
    const row = db.prepare('SELECT * FROM operations').get()!;
    assert.deepEqual(Object.keys(row).sort(), ['attempt_id', 'digest', 'fingerprint_version', 'idempotency_id', 'provider_message_id', 'state']);
    assert.match(String(row.digest), /^[0-9a-f]{64}$/u);
    assert.equal(row.fingerprint_version, 1);
    assert.equal(row.provider_message_id, 'confirmed-synthetic-provider');
  });
  assert.equal(existsSync(`${s.path}-wal`), false);
  assert.equal(existsSync(`${s.path}-journal`), false);
});

test('fingerprint v1 remains compatible with a hand-encoded synthetic fixture', (t) => {
  const s = store(t); s.initialize(); const journal = s.open(); claim(journal); journal.close();
  raw(s.path, (db) => {
    const row = db.prepare('SELECT digest, fingerprint_version FROM operations').get()!;
    assert.equal(row.fingerprint_version, 1);
    // SHA-256 of an independently hand-encoded v1 tuple, not the production helper.
    assert.equal(row.digest, 'f3b26cfc732067e842fd1a07aadff5e457cc38db118d1a7f8134137fad884ee1');
  });
});

test('public validation errors never include private request values or attach the request as cause', (t) => {
  const s = store(t); s.initialize(); const journal = s.open();
  const marker = 'SYNTHETIC-PRIVATE-ERROR-MARKER';
  assert.throws(() => journal.begin({ ...finalDelivery, text: marker, credential: marker } as DeliveryRequest), (error: unknown) => {
    assert.ok(error instanceof DeliveryJournalError);
    assert.equal(error.code, 'invalid-input');
    assert.equal(String(error).includes(marker), false);
    assert.equal(JSON.stringify(error).includes(marker), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  claim(journal);
});

test('ready survives restart but rotates the old attempt before another claim', (t) => {
  const s = store(t); s.initialize(); const journal = s.open(); const first = claim(journal);
  journal.settle(first, { kind: 'retryable' }); journal.close();
  const next = s.open(); const second = claim(next);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(next.settle(first, { kind: 'retryable' }), 'stale');
});

test('scope is captured immutably rather than retaining mutable caller configuration', (t) => {
  const s = store(t); s.initialize();
  const input = { ...scope }; const journal = openDeliveryJournal(s.path, input);
  try {
    input.appId = 'changed-app'; input.tenantId = 'changed-tenant';
    claim(journal);
  } finally { journal.close(); }
});

test('opaque IDs and receipts retain exact Unicode, case and SQL-looking content', (t) => {
  const s = store(t); s.initialize(); const journal = s.open();
  const request = { ...finalDelivery, idempotencyId: "Case-é-'; DROP TABLE operations; --", deliveryId: 'same-🧑🏽‍💻' };
  const receipt = { kind: 'delivered', providerMessageId: `CASE-${'é'.repeat(125)}x` } as const;
  assert.equal(Buffer.byteLength(receipt.providerMessageId), 256);
  journal.settle(claim(journal, request), receipt); journal.close();
  assert.deepEqual(s.open().begin(request), receipt);
});

test('WAL storage is refused without conversion or abandoned-send recovery', (t) => {
  const s = store(t); s.initialize(); const journal = s.open(); claim(journal); journal.close();
  raw(s.path, (db) => db.exec('PRAGMA journal_mode=WAL'));
  const before = readFileSync(s.path);
  assert.throws(s.open, errorCode('unavailable'));
  assert.deepEqual(readFileSync(s.path), before);
  raw(s.path, (db) => {
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(db.prepare('SELECT state FROM operations').get()?.state, 'sending');
  });
});

for (const replace of ['main', 'owner'] as const) {
  test(`a live handle refuses a replaced ${replace} inode instead of following fresh storage`, (t) => {
    const s = store(t); s.initialize();
    const replacement = join(s.directory, 'replacement.sqlite');
    initializeDeliveryJournal(replacement, scope);
    const journal = s.open(); claim(journal);
    const target = replace === 'main' ? s.path : `${s.path}.owner.sqlite`;
    renameSync(target, `${target}.retired`);
    renameSync(replace === 'main' ? replacement : `${replacement}.owner.sqlite`, target);
    assert.throws(() => journal.begin(errorDelivery), errorCode('unavailable'));
    assert.throws(() => journal.begin(errorDelivery), errorCode('unavailable'));
  });
}

test('a missing ownership file is never silently recreated by normal open', (t) => {
  const s = store(t); s.initialize();
  rmSync(`${s.path}.owner.sqlite`);
  assert.throws(s.open, errorCode('missing'));
  assert.equal(existsSync(`${s.path}.owner.sqlite`), false);
});

test('close is idempotent and closed objects cannot reopen', (t) => {
  const s = store(t);
  s.initialize();
  const journal = s.open();
  journal.close();
  journal.close();
  assert.throws(() => journal.begin(finalDelivery), errorCode('closed'));
  assert.throws(() => journal.settle({ idempotencyId: 'id', attemptId: 'attempt' }, { kind: 'unknown' }), errorCode('closed'));
  s.open().close();
});
