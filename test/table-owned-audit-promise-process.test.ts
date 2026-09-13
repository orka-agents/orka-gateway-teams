import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { PromiseCase } from './support/table-owned-audit-promise-worker.js';
import { tableService } from './support/table-service.js';

async function characterize(t: TestContext, config: PromiseCase & { tableUrl: string; tableCA: string }) {
  const child = fork(new URL('./support/table-owned-audit-promise-worker.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx', '--unhandled-rejections=throw'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let closed = false; let failure = false; let timedOut = false; let stdoutBytes = 0; let stderrBytes = 0; let ipcBytes = 0; let messages = 0;
  let checks: Record<string, boolean> | undefined;
  const completion = new Promise<number | null>(resolve => { child.once('close', code => { closed = true; resolve(code); }); });
  const stop = () => { failure = true; if (!closed) child.kill('SIGKILL'); };
  child.on('error', () => stop());
  // Count/discard private output; never retain or print raw buffers or child errors,
  // including assertion failures. Kill on bounded-channel overflow, not on a reason.
  child.stdout!.on('data', (part: Buffer) => { stdoutBytes = Math.min(4097, stdoutBytes + part.length); if (stdoutBytes > 4096) stop(); });
  child.stderr!.on('data', (part: Buffer) => { stderrBytes = Math.min(4097, stderrBytes + part.length); if (stderrBytes > 4096) stop(); });
  child.on('message', message => {
    ipcBytes = Math.min(4097, ipcBytes + Buffer.byteLength(JSON.stringify(message))); messages++;
    if (ipcBytes > 4096 || messages > 1) { stop(); return; }
    if (!message || typeof message !== 'object') { stop(); return; }
    const result = message as Record<string, unknown>;
    // Project only comparisons with fixed expected codes/counts/booleans. Raw IPC
    // values cannot become assertion actual/expected diagnostics.
    checks = {
      result: result.kind === 'result', auditUnresolved: result.audit === 'unresolved', poisoned: result.poisoned === true,
      noReady: result.ready === false, mutationUnresolved: result.mutation === 'unresolved', laterAuditUnresolved: result.laterAudit === 'unresolved',
      closeUnresolved: result.close === 'unresolved', closed: result.closed === true, pendingZero: result.pending === 0,
      callbacks: result.callbacks === (config.callback === 'record' ? 1 : config.callback === 'endPass' ? 2 : 5),
      noLaterCallbacks: result.laterCallbacks === 0, constructorReads: result.constructorReads === (config.malformed ? 1 : 0),
      unhandled: result.unhandled === (config.malformed ? 1 : 0), callbackRejections: result.callbackRejections === (config.malformed ? 1 : 0),
      nativeDrained: typeof result.requests === 'number' && result.requests > 0 && result.requests === result.requestCloses && result.requests === result.socketCloses,
    };
  });
  const timer = setTimeout(() => { timedOut = true; stop(); }, 15000);
  t.after(async () => { clearTimeout(timer); if (!closed) child.kill('SIGKILL'); await completion; });
  child.send(config, error => { if (error) stop(); });
  const exit = await completion; clearTimeout(timer);
  assert.equal(timedOut, false, 'child timeout is failure, not drain');
  assert.equal(failure, false, 'child transport/channel failure'); assert.equal(exit, 0, 'child exit');
  assert.equal(stdoutBytes, 0, 'child stdout byte count'); assert.equal(stderrBytes, 0, 'child stderr byte count');
  assert.equal(messages, 1, 'child IPC count'); assert.ok(checks, 'child result missing');
  for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, 'child check: ' + name);
}

for (const format of [1, 2] as const) for (const callback of ['record', 'endPass', 'finalize'] as const)
  for (const disposition of ['returned', 'thrown'] as const) for (const malformed of [false, true])
    test(`V${format} ${callback} ${disposition} rejected Promise: ${malformed ? 'immutable constructor leaves an unhandled rejection despite audit poison (characterization)' : 'ordinary control is handled and audit poisons'}`,
      { timeout: 30000 }, async t => {
        // Parent owns the existing ephemeral verified-TLS fixture and its teardown;
        // child owns the real kernel/SDK/native resources and explicitly closes them.
        const service = await tableService(t, 'delivery', format);
        await characterize(t, { format, callback, disposition, malformed, tableUrl: service.fixture.baseUrl, tableCA: service.fixture.ca.toString() });
        assert.equal(service.stats.writes, 2, 'only initialize/acquire writes; no audit/mutation/clean-release writes');
        assert.equal(service.rows.get('M')?.Operation === 'acquire', true, 'metadata still acquired');
        assert.equal(typeof service.rows.get('M')?.Owner === 'string' && service.rows.get('M')?.Owner !== '', true, 'owner remains installed');
        assert.equal(service.stats.violation, false, 'verified fixture boundary');
      });
