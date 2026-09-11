import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { captureForwardOutput, captureLogFollower, checkDeploymentScope, finishLogFollowers, type LogFollower } from './support/deployment-smoke.js';

async function failure(action: Promise<void>): Promise<unknown> {
  let rejected = false; let error: unknown;
  try { await action; } catch (caught) { rejected = true; error = caught; }
  assert.equal(rejected, true);
  return error;
}

// Replace only the external command boundary: no wrapper, kubectl or cluster is run.
for (const scenario of ['missing', 'empty', 'relative', 'nonexistent', 'directory', 'not executable'] as const) {
  test(`deployment preflight rejects ${scenario} KINDCTL before any command`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'teams-kindctl-check-'));
    try {
      const file = join(directory, 'not-executable'); writeFileSync(file, 'fixture', { mode: 0o600 });
      const values = { missing: undefined, empty: '', relative: './kindctl', nonexistent: join(directory, 'absent'),
        directory, 'not executable': file };
      const env: NodeJS.ProcessEnv = { KUBECONFIG: '/synthetic/scoped.kubeconfig' };
      if (values[scenario] !== undefined) env.KINDCTL = values[scenario];
      let commands = 0;
      const result = checkDeploymentScope(env, async (_binary, args) => {
        commands++; return { code: 0, stdout: args[0] === 'path' ? env.KUBECONFIG! : 'kind-owned-deployment', stderr: '' };
      });
      let rejected = false; try { await result; } catch { rejected = true; }
      assert.equal(commands, 0);
      assert.equal(rejected, true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const scenario of ['matching', 'wrong kubeconfig', 'wrong context', 'wrapper failure'] as const) {
  test(`configured KINDCTL retains scoped path/context validation: ${scenario}`, async () => {
    const calls: [string, string[]][] = [];
    // An existing absolute executable stands in for the operator's wrapper; it is not executed.
    const env = { KINDCTL: process.execPath, KUBECONFIG: '/synthetic/scoped.kubeconfig' };
    let rejected = false;
    try {
      await checkDeploymentScope(env, async (binary, args) => {
        calls.push([binary, args]);
        if (args[0] === 'path') return { code: scenario === 'wrapper failure' ? 1 : 0,
          stdout: scenario === 'wrong kubeconfig' ? '/synthetic/other.kubeconfig' : env.KUBECONFIG, stderr: '' };
        return { code: 0, stdout: scenario === 'wrong context' && binary === 'kubectl' ? 'kind-other' : 'kind-owned-deployment', stderr: '' };
      });
    } catch { rejected = true; }
    assert.equal(rejected, scenario !== 'matching');
    assert.deepEqual(calls[0], [process.execPath, ['path', '--tag', 'deployment']]);
    if (scenario === 'matching') assert.deepEqual(calls.slice(1), [
      ['kubectl', ['config', 'current-context']],
      [process.execPath, ['kubectl', '--tag', 'deployment', 'config', 'current-context']],
    ]);
    if (scenario === 'wrong kubeconfig' || scenario === 'wrapper failure') assert.equal(calls.length, 1);
  });
}

test('offline scope checks do not inherit the deployment smoke runtime pin', async () => {
  const version = Object.getOwnPropertyDescriptor(process, 'version')!;
  const env = { KINDCTL: process.execPath, KUBECONFIG: '/synthetic/scoped.kubeconfig' };
  try {
    // Simulate the version boundary only; this does not test another installed runtime.
    Object.defineProperty(process, 'version', { value: 'v24.3.0', configurable: true });
    await checkDeploymentScope(env, async (_binary, args) => ({ code: 0,
      stdout: args[0] === 'path' ? env.KUBECONFIG : 'kind-owned-deployment', stderr: '' }));
  } finally { Object.defineProperty(process, 'version', version); }
});

// Owned process event/stdio boundary. No uncontrolled daemon or Kubernetes failure injection.
function ownedProcess(stop: 'close' | 'hang' | 'throw' = 'close') {
  const child = new ChildProcess(); const stdout = new PassThrough(); const stderr = new PassThrough();
  child.stdout = stdout; child.stderr = stderr;
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  const privateDiagnostic = randomUUID();
  const close = (code = 0) => { Object.defineProperty(child, 'exitCode', { value: code }); child.emit('close', code, null); };
  child.kill = (signal) => {
    signals.push(signal);
    if (stop === 'throw') throw new Error(privateDiagnostic);
    if (stop === 'close') close();
    return true;
  };
  const follower = captureLogFollower(child);
  return { child, stdout, stderr, signals, close, follower, privateDiagnostic };
}

test('abort signals later followers even when the first never closes; unconfirmed ownership survives retry', async () => {
  const first = ownedProcess('hang'); const later = ownedProcess();
  const followers = [first.follower, later.follower]; const scanned: string[] = [];
  later.stdout.write('later final output');
  const started = performance.now();
  await failure(finishLogFollowers(followers, true, (text) => { scanned.push(text); }, 20));
  assert.equal(performance.now() - started < 1000, true);
  assert.equal(first.signals.includes('SIGTERM') && later.signals.includes('SIGTERM'), true);
  assert.deepEqual(scanned, ['later final output']);
  assert.equal(followers.length === 1 && followers[0] === first.follower, true);
  first.close(); await finishLogFollowers(followers, true, () => {}, 20);
  assert.equal(followers.length, 0);
});

test('normal drain timeout signals every remaining follower before rejecting', async () => {
  const first = ownedProcess('hang'); const later = ownedProcess('hang');
  const followers = [first.follower, later.follower];
  await failure(finishLogFollowers(followers, false, () => {}, 20));
  assert.equal(first.signals.includes('SIGTERM') && later.signals.includes('SIGTERM'), true);
  assert.equal(followers.length, 2);
  first.close(); later.close(); await finishLogFollowers(followers, true, () => {}, 20);
});

for (const scenario of ['stop throws', 'completion rejects', 'scan throws', 'nonzero close'] as const) {
  test(`all followers get cleanup despite first follower failure: ${scenario}`, async () => {
    const first = ownedProcess(scenario === 'stop throws' ? 'throw' : 'close'); const later = ownedProcess();
    if (scenario === 'completion rejects') first.follower.done = Promise.reject(new Error(first.privateDiagnostic));
    if (scenario === 'scan throws' || scenario === 'nonzero close') first.close(scenario === 'nonzero close' ? 1 : 0);
    const followers = [first.follower, later.follower]; let scans = 0;
    const error = await failure(finishLogFollowers(followers, scenario === 'stop throws', () => {
      scans++; if (scenario === 'scan throws' && scans === 1) throw new Error(first.privateDiagnostic);
    }, 20));
    assert.equal(later.signals.includes('SIGTERM'), true);
    assert.equal(String(error).includes(first.privateDiagnostic), false);
    assert.equal(scans >= 1, true);
    const unconfirmed = scenario === 'stop throws' || scenario === 'completion rejects';
    assert.equal(followers.length, unconfirmed ? 1 : 0);
    if (unconfirmed) assert.equal(followers[0] === first.follower, true);
  });
}

test('normal completion waits for close, includes final stdio, scans all followers without signaling', async () => {
  const first = ownedProcess(); const later = ownedProcess();
  const followers = [first.follower, later.follower]; const scanned: string[] = [];
  let finished = false;
  const pending = finishLogFollowers(followers, false, (text) => { scanned.push(text); }, 1000).then(() => { finished = true; });
  first.stdout.write('before exit;'); first.child.emit('exit', 0, null);
  await Promise.resolve(); assert.equal(finished, false);
  first.stdout.write('after exit;'); first.stderr.write('stderr'); first.close();
  later.stdout.write('later'); later.close();
  await pending;
  assert.deepEqual(scanned.sort(), ['before exit;after exit;stderr', 'later']);
  assert.equal(first.signals.length + later.signals.length, 0);
  assert.equal(followers.length, 0);
});

test('child error does not stand in for confirmed close or drop final stdio', async () => {
  const owned = ownedProcess(); let settled = false;
  const done = owned.follower.done.then((result) => { settled = true; return result; });
  owned.child.emit('error', new Error(owned.privateDiagnostic));
  await Promise.resolve(); assert.equal(settled, false);
  owned.stderr.write('final stderr'); owned.close();
  const result = await done;
  assert.equal(result.code, -1); assert.equal(result.stderr, 'final stderr');
});

test('port-forward capture remains bounded across both streams after overflow until the child stops', () => {
  const child = new ChildProcess(); const stdout = new PassThrough(); const stderr = new PassThrough();
  child.stdout = stdout; child.stderr = stderr;
  const output = captureForwardOutput(child);
  stdout.write('Forwarding from 127.0.0.1:12345 -> 8443\n');
  assert.equal(output.text, 'Forwarding from 127.0.0.1:12345 -> 8443\n');
  assert.equal(output.overflow, false);
  stderr.write(Buffer.alloc(65536, 'x'));
  for (let i = 0; i < 4; i++) { stdout.write(Buffer.alloc(65536, 'y')); stderr.write(Buffer.alloc(65536, 'z')); }
  assert.equal(Buffer.byteLength(output.text) <= 65536, true);
  assert.equal(output.overflow, true);
});

for (const stream of ['stdout', 'stderr'] as const) {
  test(`${stream} capture stops growing after overflow while termination remains unconfirmed`, async () => {
    const owned = ownedProcess('hang'); const limit = stream === 'stdout' ? 1024 * 1024 : 65536;
    owned[stream].write(Buffer.alloc(limit, 'x'));
    for (let i = 0; i < 4; i++) owned[stream].write(Buffer.alloc(limit, 'y'));
    const followers: LogFollower[] = [owned.follower];
    await failure(finishLogFollowers(followers, true, () => {}, 20));
    assert.equal(followers.length, 1);
    assert.equal(owned.signals.includes('SIGTERM'), true);
    owned.close(); const result = await owned.follower.done;
    assert.equal(Buffer.byteLength(result[stream]) <= limit, true);
    assert.equal(result.code, -1);
    await finishLogFollowers(followers, true, () => {}, 20);
    assert.equal(followers.length, 0);
  });
}
