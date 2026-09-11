import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { receiverConfig, scope } from './support/ingress-auth.js';

function cli(t: TestContext, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/ingress/main.ts', ...args], {
    cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const finished = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000); timeout.unref();
  t.after(async () => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); await finished; });
  return { child, finished, output: () => stdout + stderr };
}
function envFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-cli-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId,
    ORKA_BASE_URL: scope.orkaBaseUrl, ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName,
    INGRESS_DB: join(directory, 'inbox.sqlite') };
}

test('CLI init provisions only explicit nonsecret scope and refuses existing storage', async (t) => {
  const env = envFixture(t); const init = cli(t, ['init'], env);
  assert.equal(await init.finished, 0); assert.equal(existsSync(env.INGRESS_DB), true);
  assert.ok(init.output().includes('teams-ingress: initialized'));
  const again = cli(t, ['init'], env); assert.equal(await again.finished, 1);
});

test('CLI unknown command, missing/malformed config and missing DB fail safely before listening', async (t) => {
  const env = { ...envFixture(t), TEAMS_CLIENT_SECRET: randomUUID(), ORKA_BEARER_TOKEN: randomUUID(),
    TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls) };
  for (const [args, variables] of [
    [['unknown-private-sentinel'], env], [['serve'], {}], [['serve'], { ...env, ORKA_BASE_URL: 'https://private:credential@example.invalid' }],
    [['serve'], env], [['serve', 'extra-private-sentinel'], env],
  ] as [string[], NodeJS.ProcessEnv][]) {
    const run = cli(t, args, variables); assert.equal(await run.finished, 1);
    assert.ok(!run.output().includes('listening')); assert.ok(!run.output().includes('private'));
    assert.ok(!run.output().includes(env.TEAMS_CLIENT_SECRET)); assert.ok(!run.output().includes(env.ORKA_BEARER_TOKEN));
  }
  assert.equal(existsSync(env.INGRESS_DB), false);
});

test('CLI rejects TLS bypass and invalid CA files before listening without exposing configuration', async (t) => {
  const env = { ...envFixture(t), TEAMS_CLIENT_SECRET: randomUUID(), ORKA_BEARER_TOKEN: randomUUID(),
    TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls) };
  const init = cli(t, ['init'], env); assert.equal(await init.finished, 0);
  const caFile = join(dirname(env.INGRESS_DB), 'private-ca-path-sentinel.pem');
  const bypass = cli(t, ['serve'], { ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  assert.equal(await bypass.finished, 1); assert.ok(bypass.output().includes('teams-ingress: configuration-failed'));
  assert.ok(!bypass.output().includes('listening'));
  for (const content of ['', 'private-ca-content-sentinel']) {
    writeFileSync(caFile, content, { mode: 0o600 });
    const run = cli(t, ['serve'], { ...env, ORKA_CA_FILE: caFile }); assert.equal(await run.finished, 1);
    assert.ok(run.output().includes('teams-ingress: configuration-failed')); assert.ok(!run.output().includes('listening'));
    for (const value of [caFile, 'private-ca-content-sentinel', env.TEAMS_CLIENT_SECRET, env.ORKA_BEARER_TOKEN]) assert.ok(!run.output().includes(value));
  }
});

test('CLI bind failure is nonzero and sanitized rather than swallowed by App.start', async (t) => {
  const occupied = createServer(); await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  const address = occupied.address(); assert.ok(address && typeof address !== 'string');
  const env = { ...envFixture(t), TEAMS_CLIENT_SECRET: randomUUID(), ORKA_BEARER_TOKEN: randomUUID(),
    TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls),
    INGRESS_PORT: String(address.port) };
  const init = cli(t, ['init'], env); assert.equal(await init.finished, 0);
  const run = cli(t, ['serve'], env); assert.equal(await run.finished, 1);
  assert.ok(run.output().includes('teams-ingress: startup-failed')); assert.ok(!run.output().includes('listening'));
  assert.ok(!run.output().includes(env.TEAMS_CLIENT_SECRET)); assert.ok(!run.output().includes(env.ORKA_BEARER_TOKEN));
});

test('CLI always uses fixed public auth despite SDK bypass/cloud/log env; SIGTERM closes cleanly', async (t) => {
  const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const env = { ...envFixture(t), TEAMS_CLIENT_SECRET: randomUUID(), ORKA_BEARER_TOKEN: randomUUID(),
    TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls),
    INGRESS_PORT: String(port), DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS: 'true', CLOUD: 'invalid-private-cloud', LOG_LEVEL: 'debug' };
  const init = cli(t, ['init'], env); assert.equal(await init.finished, 0);
  const run = cli(t, ['serve'], env);
  for (let i = 0; i < 100 && !run.output().includes('teams-ingress: listening') && run.child.exitCode === null; i++) await sleep(25);
  assert.ok(run.output().includes('teams-ingress: listening'));
  const response = await fetch(`http://127.0.0.1:${port}/api/messages`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private-token-sentinel' },
    body: JSON.stringify({ text: 'private-raw-body-sentinel', serviceUrl: receiverConfig.serviceUrls[0] }) });
  assert.equal(response.status, 401);
  for (const path of ['/v1/health', '/v1/capabilities', '/v1/deliveries']) assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 404);
  run.child.kill('SIGTERM'); assert.equal(await run.finished, 0);
  assert.ok(!run.output().includes('private')); assert.ok(!run.output().includes(env.TEAMS_CLIENT_SECRET));
});
