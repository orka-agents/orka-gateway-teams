import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDeliveryJournal } from '../src/delivery/journal.js';
import { openIngressStore } from '../src/ingress/store.js';
import { receiverConfig, scope } from './support/ingress-auth.js';

function cli(t: TestContext, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/ingress/main.ts', ...args], {
    cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const finished = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 12000); timeout.unref();
  t.after(async () => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); await finished; });
  return { child, finished, output: () => output };
}
function environment(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-outbound-cli-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, ORKA_BASE_URL: scope.orkaBaseUrl,
    ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName,
    INGRESS_DB: join(directory, 'inbox.sqlite'), DELIVERY_DB: join(directory, 'delivery.sqlite') };
}
async function port(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
function credentials() { return { TEAMS_CLIENT_SECRET: randomUUID(), ORKA_BEARER_TOKEN: randomUUID(), ORKA_OUTBOUND_BEARER_TOKEN: randomUUID(),
  TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls), OUTBOUND_ENABLED: 'true' }; }

test('init-delivery explicitly provisions unchanged app/tenant journal with no secrets, listener or inbox; repeat refuses adoption', async (t) => {
  const env = environment(t); const { INGRESS_DB: _inbox, ...onlyDelivery } = env;
  const run = cli(t, ['init-delivery'], onlyDelivery); assert.equal(await run.finished, 0); assert.ok(run.output().includes('teams-ingress: initialized'));
  assert.equal(existsSync(env.INGRESS_DB), false); assert.equal(existsSync(`${env.DELIVERY_DB}.owner.sqlite`), true);
  const journal = openDeliveryJournal(env.DELIVERY_DB, { appId: scope.appId, tenantId: scope.tenantId }); journal.close();
  const repeat = cli(t, ['init-delivery'], onlyDelivery); assert.equal(await repeat.finished, 1); assert.ok(!repeat.output().includes('listening'));
});

test('full CLI refuses partial config and missing delivery storage without auto-initializing either database', async (t) => {
  const env = { ...environment(t), ...credentials(), INGRESS_PORT: String(await port()), OUTBOUND_PORT: String(await port()) };
  assert.equal(await cli(t, ['init'], env).finished, 0);
  for (const override of [{}, { OUTBOUND_ENABLED: 'false' }, { ORKA_OUTBOUND_BEARER_TOKEN: undefined }, { ORKA_OUTBOUND_BEARER_TOKEN: env.ORKA_BEARER_TOKEN }]) {
    const run = cli(t, ['serve'], { ...env, ...override }); assert.equal(await run.finished, 1); assert.ok(!run.output().includes('listening'));
    for (const value of [env.TEAMS_CLIENT_SECRET, env.ORKA_BEARER_TOKEN, env.ORKA_OUTBOUND_BEARER_TOKEN]) assert.ok(!run.output().includes(value));
  }
  assert.equal(existsSync(env.DELIVERY_DB), false); assert.equal(existsSync(`${env.DELIVERY_DB}.owner.sqlite`), false);
  const inbox = openIngressStore(env.INGRESS_DB, scope); inbox.close();
});

test('full CLI uses independent authenticated listener, leaves SDK-only routes intact and SIGTERM releases both stores', { timeout: 12000 }, async (t) => {
  const env = { ...environment(t), ...credentials(), INGRESS_PORT: String(await port()), OUTBOUND_PORT: String(await port()),
    DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS: 'true', CLOUD: 'private-cloud-sentinel', BOT_TOKEN: randomUUID(), LOG_LEVEL: 'debug' };
  assert.equal(await cli(t, ['init'], env).finished, 0); assert.equal(await cli(t, ['init-delivery'], env).finished, 0);
  const run = cli(t, ['serve'], env); const deadline = performance.now() + 5000;
  while (!run.output().includes('teams-ingress: listening') && run.child.exitCode === null && performance.now() < deadline) await sleep(10);
  assert.ok(run.output().includes('teams-ingress: listening'));
  for (const path of ['/v1/health', '/v1/capabilities']) {
    for (const token of [undefined, env.ORKA_BEARER_TOKEN, env.BOT_TOKEN, env.ORKA_OUTBOUND_BEARER_TOKEN]) {
      const response = await fetch(`http://127.0.0.1:${env.OUTBOUND_PORT}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      assert.equal(response.status, token === env.ORKA_OUTBOUND_BEARER_TOKEN ? 200 : 401);
    }
    assert.equal((await fetch(`http://127.0.0.1:${env.INGRESS_PORT}${path}`)).status, 404);
  }
  const input = await fetch(`http://127.0.0.1:${env.INGRESS_PORT}/api/messages`, { method: 'POST',
    headers: { Authorization: `Bearer ${env.ORKA_OUTBOUND_BEARER_TOKEN}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(input.status, 401); run.child.kill('SIGTERM'); assert.equal(await run.finished, 0);
  for (const value of [env.TEAMS_CLIENT_SECRET, env.ORKA_BEARER_TOKEN, env.ORKA_OUTBOUND_BEARER_TOKEN, env.BOT_TOKEN, 'private-cloud-sentinel']) assert.ok(!run.output().includes(value));
  const inbox = openIngressStore(env.INGRESS_DB, scope); const journal = openDeliveryJournal(env.DELIVERY_DB, { appId: scope.appId, tenantId: scope.tenantId });
  inbox.close(); journal.close();
});
