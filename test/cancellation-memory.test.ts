import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

type Sample = { scenario: 'idle' | 'dispatcher'; warmup: number; iterations: number; heapWarm: number; heapMiddle: number;
  heapTail: number; growth: number; requests?: number; requestCloses?: number; socketCloses?: number; listenerChecks?: number;
  rows?: number; pending?: number; kernelPending?: number; events?: number; routes?: number; seals?: number;
  indexBytes?: number; begins?: number; providerPosts?: number; callerListeners?: number };

async function sample(t: TestContext, scenario: Sample['scenario']): Promise<Sample> {
  const child = fork(new URL('./support/cancellation-memory-worker.ts', import.meta.url), [scenario], {
    execArgv: ['--expose-gc', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    // Hard process bound as well as the test timeout: even a broken drain cannot
    // leave a worker running after the test runner has moved on.
    timeout: 170000, killSignal: 'SIGKILL',
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const result = await new Promise<Sample>((resolve, reject) => {
    child.once('message', value => resolve(value as Sample));
    child.once('error', () => reject(new Error('Cancellation memory worker failed to start')));
    child.once('exit', (code, signal) => reject(new Error(`Cancellation memory worker exited before reporting (${code ?? signal}): ${stderr}`)));
  });
  assert.equal(await exited, 0, stderr);
  assert.equal(result.scenario, scenario); assert.equal(result.warmup, 5000);
  assert.equal(result.iterations, scenario === 'idle' ? 60000 : 20000);
  assert.ok(Number.isFinite(result.heapWarm) && result.heapWarm > 0);
  assert.equal(result.growth, result.heapTail - result.heapWarm);
  return result;
}

function assertPlateau(result: Sample) {
  // A fixed 2 MiB allowance covers late SDK/JIT/module and GC noise after 5,000
  // warm-up calls. It does not scale with calls: the measured tail includes
  // 60,000 idle writes or 20,000 receipt replays, with their sources still live.
  // Both samples are post-GC heapUsed, not RSS or transient pre-GC allocations.
  const budget = 2 * 1024 * 1024;
  assert.ok(result.growth <= budget, `Completed cancellation scopes must plateau within ${budget} bytes: ${JSON.stringify(result)}`);
}

test('empty Table inbox idle-poll writes retain bounded cancellation memory with a live owner', { timeout: 180000 }, async t => {
  const result = await sample(t, 'idle');
  assert.equal(result.pending, 0); assert.equal(result.kernelPending, 0); assert.equal(result.rows, 1);
  assert.equal(result.events, 0); assert.equal(result.routes, 0); assert.equal(result.seals, 0);
  assert.equal(result.requests, result.requestCloses); assert.equal(result.requests, result.socketCloses);
  assert.ok(result.listenerChecks! > 20000);
  assertPlateau(result);
});

test('dispatcher receipt replays retain bounded cancellation memory with one live caller signal', { timeout: 180000 }, async t => {
  const result = await sample(t, 'dispatcher');
  assert.equal(result.begins, 25000); assert.equal(result.providerPosts, 0); assert.equal(result.callerListeners, 0);
  assertPlateau(result);
});
