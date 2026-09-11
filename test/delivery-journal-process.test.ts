import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DeliveryJournalError, initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import type { DeliveryClaim, TerminalOutcome } from '../src/delivery/journal.js';
import { finalDelivery } from './fixtures/outgoing.js';

type WorkerMessage =
  | { kind: 'claimed'; claim: DeliveryClaim }
  | { kind: 'receipt'; receipt: TerminalOutcome }
  | { kind: 'opened' }
  | { kind: 'error'; code: string };

const scope = { appId: 'app-fixture', tenantId: finalDelivery.accountId };
const receipt = { kind: 'delivered', providerMessageId: 'provider-child-fixture' } as const;

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-journal-process-'));
  const path = join(directory, 'delivery.sqlite');
  initializeDeliveryJournal(path, scope);
  const children: ReturnType<typeof startWorker>[] = [];
  t.after(async () => {
    for (const child of children) await child.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    worker(mode = 'claim') {
      const child = startWorker(path, mode); children.push(child); return child;
    },
  };
}

function startWorker(path: string, mode: string) {
  const child = fork(new URL('./support/delivery-journal-worker.ts', import.meta.url), [mode, path], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const messages: WorkerMessage[] = [];
  let notify: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => { ended = true; notify?.(); resolve(); });
    child.once('error', (error) => { failure = error; ended = true; notify?.(); resolve(); });
  });
  child.on('message', (message) => { messages.push(message as WorkerMessage); notify?.(); });
  return {
    child, exit,
    async next(): Promise<WorkerMessage> {
      while (!messages.length) {
        if (ended) throw failure ?? new Error('worker exited before its milestone');
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('worker milestone timeout')), 5000);
          notify = () => { clearTimeout(timeout); resolve(); };
        });
      }
      return messages.shift()!;
    },
    async stop() { if (!ended) child.kill('SIGKILL'); await exit; },
  };
}

test('live child ownership blocks competing recovery and child still records its valid receipt', { timeout: 10000 }, async (t) => {
  const { path, worker } = fixture(t); const child = worker();
  assert.equal((await child.next()).kind, 'claimed');
  assert.throws(() => openDeliveryJournal(path, scope), (error: unknown) => error instanceof DeliveryJournalError && error.code === 'busy');
  child.child.send('settle');
  assert.deepEqual(await child.next(), { kind: 'receipt', receipt });
  child.child.send('exit'); await child.exit;
  const journal = openDeliveryJournal(path, scope);
  try { assert.deepEqual(journal.begin(finalDelivery), receipt); } finally { journal.close(); }
});

test('SIGKILL after a committed claim recovers unknown, never fresh send permission', { timeout: 10000 }, async (t) => {
  const { path, worker } = fixture(t); const child = worker();
  const started = await child.next(); assert.equal(started.kind, 'claimed');
  if (started.kind !== 'claimed') throw new Error('expected fixture claim');
  await child.stop();
  const journal = openDeliveryJournal(path, scope);
  try {
    assert.deepEqual(journal.begin(finalDelivery), { kind: 'unknown' });
    assert.deepEqual(journal.begin({ ...finalDelivery, deliveryId: 'post-crash-alias' }), { kind: 'unknown' });
    assert.equal(journal.settle(started.claim, { kind: 'delivered', providerMessageId: 'late-fixture' }), 'stale');
    assert.equal(journal.settle(started.claim, { kind: 'retryable' }), 'stale');
    assert.equal(journal.settle(started.claim, { kind: 'unknown' }), 'unchanged');
  } finally { journal.close(); }
});

test('SIGKILL after committed receipt replays the original provider ID', { timeout: 10000 }, async (t) => {
  const { path, worker } = fixture(t); const child = worker('receipt');
  assert.deepEqual(await child.next(), { kind: 'receipt', receipt });
  await child.stop();
  const journal = openDeliveryJournal(path, scope);
  try { assert.deepEqual(journal.begin(finalDelivery), receipt); } finally { journal.close(); }
});

test('process exit without explicit close releases ownership but not abandoned sending permission', { timeout: 10000 }, async (t) => {
  const { path, worker } = fixture(t); const child = worker();
  assert.equal((await child.next()).kind, 'claimed');
  child.child.send('exit-without-close'); await child.exit;
  const journal = openDeliveryJournal(path, scope);
  try { assert.deepEqual(journal.begin(finalDelivery), { kind: 'unknown' }); } finally { journal.close(); }
});

test('failed wrong-scope startup releases guard and never performs recovery', { timeout: 10000 }, async (t) => {
  const { path, worker } = fixture(t); const owner = worker();
  assert.equal((await owner.next()).kind, 'claimed'); await owner.stop();
  const wrong = worker('wrong-scope');
  assert.deepEqual(await wrong.next(), { kind: 'error', code: 'scope-mismatch' }); await wrong.exit;
  const raw = new DatabaseSync(path);
  try { assert.equal(raw.prepare('SELECT state FROM operations').get()?.state, 'sending'); } finally { raw.close(); }
  const journal = openDeliveryJournal(path, scope);
  try { assert.deepEqual(journal.begin(finalDelivery), { kind: 'unknown' }); } finally { journal.close(); }
});

test('failed same-process competing open cannot release ownership to a separate process', { timeout: 10000 }, async (t) => {
  const { path, worker } = fixture(t); const journal = openDeliveryJournal(path, scope);
  try {
    const result = journal.begin(finalDelivery); assert.equal(result.kind, 'claimed');
    for (let i = 0; i < 3; i++) {
      assert.throws(() => openDeliveryJournal(path, scope), (error: unknown) => error instanceof DeliveryJournalError && error.code === 'busy');
    }
    const child = worker('probe');
    assert.deepEqual(await child.next(), { kind: 'error', code: 'busy' }); await child.exit;
    if (result.kind !== 'claimed') throw new Error('expected fixture claim');
    assert.equal(journal.settle(result.claim, receipt), 'recorded');
  } finally { journal.close(); }
  const after = worker('probe');
  assert.deepEqual(await after.next(), { kind: 'opened' }); await after.exit;
});
