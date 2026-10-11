import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setupEnv, setupFiles } from './support/setup.js';

function cli(t: TestContext, env: NodeJS.ProcessEnv, args: string[] = [], early = false, entry = 'src/setup/main.ts') {
  const child = spawn(process.execPath, ['--import', 'tsx', ...(early ? ['--import', './test/support/setup-early-signal.ts'] : []),
    entry, ...args], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); }); child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const done = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  t.after(async () => { child.kill('SIGTERM'); await done; });
  return { child, done, stdout: () => stdout, stderr: () => stderr };
}

async function port(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}

for (const mode of ['invalid credentials', 'runtime environment', 'extra arguments', 'missing input', 'existing output'] as const) {
  test(`standalone capture CLI safely refuses ${mode} without listening or touching existing bytes`, async (t) => {
    const { config, directory, challenge } = setupFiles(t); const env = setupEnv(config);
    if (mode === 'invalid credentials') env.TEAMS_APP_ID = 'bad';
    if (mode === 'runtime environment') env.ORKA_BEARER_TOKEN = config.clientSecret;
    if (mode === 'missing input') delete env.SETUP_CHALLENGE_FILE;
    if (mode === 'existing output') writeFileSync(config.captureFile, challenge, { mode: 0o600 });
    const process = cli(t, env, mode === 'extra arguments' ? ['serve'] : []); const result = await process.done;
    assert.equal(result.code, 1); assert.equal(result.signal, null);
    assert.equal(process.stdout().length, 0); assert.equal(process.stderr() === 'teams-setup: failed\n', true);
    assert.equal(existsSync(config.captureFile), mode === 'existing output');
    assert.equal(readdirSync(directory).length, mode === 'existing output' ? 2 : 1);
  });
}

test('standalone CLI expires nonzero without any runtime store, provider credential use or artifact', async (t) => {
  const { config, directory } = setupFiles(t);
  const process = cli(t, { ...setupEnv(config), SETUP_PORT: String(await port()), SETUP_TIMEOUT_MS: '1000' });
  const result = await process.done; assert.equal(result.code, 1); assert.equal(result.signal, null);
  assert.equal(process.stdout().length, 0); assert.equal(process.stderr() === 'teams-setup: listening\nteams-setup: failed\n', true);
  assert.deepEqual(readdirSync(directory), ['challenge']);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`standalone CLI ${signal} drains and exits nonzero before capture`, async (t) => {
    const { config, directory } = setupFiles(t); const process = cli(t, { ...setupEnv(config), SETUP_PORT: String(await port()) });
    const deadline = performance.now() + 10000;
    while (!process.stderr().includes('teams-setup: listening\n')) {
      assert.ok(process.child.exitCode === null && process.child.signalCode === null,
        `setup CLI exited before listening (code=${process.child.exitCode}, signal=${process.child.signalCode}): ${process.stderr()}`);
      assert.equal(performance.now() < deadline, true); await sleep(10);
    }
    process.child.kill(signal);
    const result = await process.done; assert.equal(result.code, 1); assert.equal(result.signal, null);
    assert.equal(process.stdout().length, 0); assert.equal(process.stderr() === 'teams-setup: listening\nteams-setup: failed\n', true);
    assert.deepEqual(readdirSync(directory), ['challenge']);
  });
}

test('real SDK capture and independent denial keep all private values out of process output', async (t) => {
  const process = cli(t, {}, [], false, 'test/support/setup-output.ts'); const result = await process.done;
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.equal(process.stdout().includes('setup-output-verified'), true); assert.equal(process.stderr().length, 0);
});

test('CLI installs signal handlers before startup and cannot announce listening after early cancellation', async (t) => {
  const { config, directory } = setupFiles(t); const process = cli(t, setupEnv(config), [], true);
  const result = await process.done; assert.equal(result.code, 1); assert.equal(result.signal, null);
  assert.equal(process.stdout().length, 0); assert.equal(process.stderr() === 'teams-setup: failed\n', true);
  assert.deepEqual(readdirSync(directory), ['challenge']);
});
