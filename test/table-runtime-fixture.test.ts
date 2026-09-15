import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { cleanupTableCliRuns, hasTableCanary, runTableContainerStage } from './support/table-runtime-cli.js';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syntheticToken } from './support/table-service.js';

for (const mode of ['fetch', 'http-get', 'https-get']) test(`native preload preserves ${mode} refusal without an unmapped call`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-preload-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyFileSync(new URL('./support/table-runtime-cli-preload.mjs', import.meta.url), join(directory, 'preload.mjs'));
  writeFileSync(join(directory, 'native-settings.json'), JSON.stringify({ identity: 'http://127.0.0.1:1/msi/token' }));
  // An unmapped get is a local sentinel, not a real outbound network attempt.
  writeFileSync(join(directory, 'check.mjs'), `
import assert from 'node:assert/strict';
import http, { get as httpGet } from 'node:http';
import https, { get as httpsGet } from 'node:https';
let bypass = 0;
http.get = https.get = () => { bypass++; throw new Error('Unmapped get'); };
await import('./preload.mjs');
const expected = { message: 'Unexpected fixture destination' };
if (process.argv[2] === 'fetch') {
  const pending = fetch('https://127.0.0.1:1/denied');
  assert.equal(pending instanceof Promise, true);
  await assert.rejects(pending, expected);
} else {
  assert.throws(() => process.argv[2] === 'http-get' ? httpGet('http://127.0.0.1:1/denied') : httpsGet('https://127.0.0.1:1/denied'), expected);
}
assert.equal(bypass, 0);
`);
  const passed = await new Promise<boolean>(resolve => execFile(process.execPath, [join(directory, 'check.mjs'), mode],
    { timeout: 10000, maxBuffer: 65536 }, error => resolve(error === null)));
  assert.equal(passed, true, 'preload refusal contract');
});

const closed = { exitCode: 0, signalCode: null, kill: () => true };
const run = (name: string, done: Promise<unknown> = Promise.resolve()) => ({ name, child: closed, done });

test('Table fixture cleanup attempts every owned run after the first removal fails', async () => {
  const removed: string[] = []; const waited: string[] = [];
  const observedRun = (name: string) => ({ name, child: closed, get done() { waited.push(name); return Promise.resolve(); } });
  const result = await cleanupTableCliRuns([observedRun('owned-first'), observedRun('owned-serving')],
    async name => { removed.push(name); return { code: name === 'owned-first' ? 1 : 0 }; }, 20).then(() => false, () => true);
  assert.equal(result, true); assert.equal(removed.includes('owned-serving'), true);
  assert.equal(waited.length, 2); assert.equal(removed.length, 2);
});

test('Table fixture cleanup contains private removal errors and still attempts the next owner', async () => {
  let later = false;
  const error = await cleanupTableCliRuns([run('owned-first'), run('owned-next')], async name => {
    if (name === 'owned-first') throw new Error(syntheticToken);
    later = true; return { code: 0 };
  }, 20).then(() => undefined, error => error);
  assert.equal(later, true); assert.equal(error instanceof Error, true);
  assert.equal(error?.message === 'Table CLI fixture cleanup failed' && error.cause === undefined, true);
});

for (const held of ['remove', 'wait'] as const) test(`Table fixture cleanup bounds a held ${held}, attempts peers and reports failure rather than drain`, async () => {
  let later = false; let actualFinished = false;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = () => { actualFinished = true; resolve(); }; });
  const cleanup = cleanupTableCliRuns([run('owned-held', held === 'wait' ? pending : Promise.resolve()), run('owned-next')],
    async name => { if (name === 'owned-held' && held === 'remove') await pending; if (name === 'owned-next') later = true; return { code: 0 }; }, 10);
  try {
    const result = await Promise.race([cleanup.then(() => 'success', () => 'failure'), sleep(200).then(() => 'still-held')]);
    assert.equal(later, true); assert.equal(result === 'failure', true); assert.equal(actualFinished, false);
  } finally { finish(); await cleanup.catch(() => {}); }
});

test('Table fixture cleanup attempts local child termination independently of a failed peer', async () => {
  let killed = false;
  const error = await cleanupTableCliRuns([run('owned-first'), { child: { exitCode: null, signalCode: null,
    kill: () => { killed = true; return true; } }, done: Promise.resolve() }], async () => ({ code: 1 }), 20).then(() => false, () => true);
  assert.equal(error, true); assert.equal(killed, true);
});

test('outer Table image stage cleans exact owned artifacts when qualification fails before running its after hooks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-table-outer-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifact = join(directory, 'private-fixture'); let removedOwned = false;
  const error = await runTableContainerStage('unused-image', async hooks => {
    // The outer stage receives cleanup intent before the resource is created.
    hooks.after(() => { rmSync(artifact); removedOwned = true; });
    writeFileSync(artifact, syntheticToken, { mode: 0o600 });
    throw new Error(syntheticToken);
  }, 20).then(() => undefined, error => error);
  assert.equal(removedOwned, true); assert.equal(existsSync(artifact), false);
  assert.equal(error?.message === 'Table container fixture failed' && error.cause === undefined, true);
});

test('outer Table image stage attempts later owned cleanup after a rejection and a held cleanup', async () => {
  let later = false; let actualFinished = false; let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = () => { actualFinished = true; resolve(); }; });
  try {
    const error = await runTableContainerStage('unused-image', async hooks => {
      hooks.after(() => { throw new Error(syntheticToken); });
      hooks.after(() => pending);
      hooks.after(() => { later = true; });
      throw new Error(syntheticToken);
    }, 10).then(() => undefined, error => error);
    assert.equal(later, true); assert.equal(actualFinished, false);
    assert.equal(error?.message === 'Table container fixture failed' && error.cause === undefined, true);
  } finally { finish(); await pending; }
});

for (const held of [false, true]) test(`outer Table image stage rejects cleanup-only failure (held=${held}) after successful qualification`, async () => {
  let later = false; let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  try {
    const failed = await runTableContainerStage('unused-image', async hooks => {
      hooks.after(() => { if (held) return pending; throw new Error(syntheticToken); });
      hooks.after(() => { later = true; });
    }, 10).then(() => false, () => true);
    assert.equal(failed, true); assert.equal(later, true);
  } finally { finish(); await pending; }
});

test('persisted canary positive control detects raw fields', () => {
  assert.equal(hasTableCanary([{ Private: syntheticToken }], [syntheticToken]), true);
  assert.equal(hasTableCanary([{ Private: 'harmless' }], [syntheticToken]), false);
});

for (const field of ['Binding', 'State', 'Result', 'Exit', 'B0']) test(`persisted canary positive control decodes ${field} containing JSON-aligned private bytes`, () => {
  const encoded = Buffer.from(JSON.stringify({ canary: syntheticToken })).toString('base64');
  // This is the exact old scanner's false-negative precondition, without printing either value.
  assert.equal(encoded.includes(Buffer.from(syntheticToken).toString('base64')) || encoded.includes(syntheticToken), false);
  assert.equal(hasTableCanary([{ [field]: encoded, [`${field}@odata.type`]: 'Edm.Binary' }], [syntheticToken]), true);
});

test('persisted canary positive control reassembles a secret across separately encoded chunks', () => {
  const bytes = Buffer.from(JSON.stringify({ canary: syntheticToken }));
  const split = bytes.indexOf(syntheticToken) + 7;
  const row = { Count: 2, B0: bytes.subarray(0, split).toString('base64'), 'B0@odata.type': 'Edm.Binary',
    B1: bytes.subarray(split).toString('base64'), 'B1@odata.type': 'Edm.Binary' };
  assert.equal(JSON.stringify(row).includes(Buffer.from(syntheticToken).toString('base64')), false);
  assert.equal(hasTableCanary([row], [syntheticToken]), true);
});
