import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import * as logger from '../src/ingress/logger.js';

const sample = { rss: 101, heapTotal: 202, heapUsed: 303, external: 404, arrayBuffers: 505 };

test('process memory diagnostics emit only five numeric fields once per minute and stop immediately', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let captured = ''; let extraReads = 0;
  const output = () => captured;
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { captured += chunk.toString(); return true; });
  t.mock.method(process, 'memoryUsage', () => ({ ...sample,
    get text() { extraReads++; return 'private-message-sentinel'; },
    token: 'private-token-sentinel', error: new Error('private-error-sentinel'), futureMemoryCounter: 606,
  }));
  assert.equal(typeof logger.startProcessMemoryDiagnostics, 'function');
  const stop = logger.startProcessMemoryDiagnostics();
  assert.equal(output(), '');
  t.mock.timers.tick(59999); assert.equal(output(), '');
  t.mock.timers.tick(1);
  assert.equal(output(), 'teams-ingress: process-memory {"rss":101,"heapTotal":202,"heapUsed":303,"external":404,"arrayBuffers":505}\n');
  t.mock.timers.tick(59999); assert.equal(output().split('\n').filter(Boolean).length, 1);
  t.mock.timers.tick(1);
  const records = output().trim().split('\n').map(line => JSON.parse(line.slice('teams-ingress: process-memory '.length)));
  assert.deepEqual(records, [sample, sample]);
  assert.equal(extraReads, 0);
  assert.ok(!output().includes('private'));
  stop(); stop();
  const stopped = output();
  t.mock.timers.tick(120000); assert.equal(output(), stopped);
});

test('the memory diagnostics timer alone does not keep a Node process alive', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import { startProcessMemoryDiagnostics } from './src/ingress/logger.ts'; startProcessMemoryDiagnostics();"],
  { cwd: new URL('..', import.meta.url), stdio: 'pipe', timeout: 5000 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0);
  assert.equal(child.stdout.toString(), ''); assert.equal(child.stderr.toString(), '');
});

test('SDK logger and nested children still discard arbitrary arguments under debug logging', t => {
  let output = ''; let reads = 0;
  for (const stream of [process.stdout, process.stderr]) t.mock.method(stream, 'write', (chunk: string | Uint8Array) => {
    output += chunk.toString(); return true;
  });
  const priorLevel = process.env.LOG_LEVEL; process.env.LOG_LEVEL = 'debug';
  t.after(() => { if (priorLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = priorLevel; });
  const data = { text: 'private-message-sentinel', token: 'private-token-sentinel', ...sample,
    toJSON() { reads++; return 'private-json-sentinel'; }, toString() { reads++; return 'private-string-sentinel'; } };
  const child = logger.safeSdkLogger.child('private-child-sentinel', { level: 'trace' });
  for (const sdk of [logger.safeSdkLogger, child, child.child('private-grandchild-sentinel')]) {
    for (const level of ['debug', 'info', 'warn', 'error', 'trace'] as const) {
      sdk[level](data, new Error('private-error-sentinel'), 'private-text-sentinel');
      sdk.log(level, data, 'private-token-sentinel');
    }
  }
  assert.equal(output, ''); assert.equal(reads, 0);
});
