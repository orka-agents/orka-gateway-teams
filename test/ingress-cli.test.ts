import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { receiverConfig, scope } from './support/ingress-auth.js';
import { initializeSessionCorrelation, openSessionCorrelation } from '../src/delivery/sqlite-session-correlation.js';
import { ConfigurationError, parseCorrelationConfig } from '../src/ingress/config.js';
import { openIngressStore } from '../src/ingress/store.js';

function cli(t: TestContext, args: string[], env: NodeJS.ProcessEnv, early = false, diagnostics?: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', ...(early ? ['--import', './test/support/setup-early-signal.ts'] : []),
    ...(diagnostics ? ['--import', './test/support/ingress-memory-preload.ts'] : []), 'src/ingress/main.ts', ...args], {
    cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, ...env,
      ...(diagnostics ? { MEMORY_DIAGNOSTICS_TEST: diagnostics } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('CLI explicitly initializes correlation with only app/tenant/path and refuses Table or reinitialization', async (t) => {
  const fixture = envFixture(t); const path = join(dirname(fixture.INGRESS_DB), 'correlation.sqlite');
  const env = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, CORRELATION_DB: path };
  assert.equal(await cli(t, ['init-correlation'], env).finished, 0);
  const handle = openSessionCorrelation(path, { appId: scope.appId, tenantId: scope.tenantId }); handle.close();
  assert.equal(existsSync(fixture.INGRESS_DB), false);
  assert.equal(await cli(t, ['init-correlation'], env).finished, 1);
  const other = `${path}.other`;
  assert.equal(await cli(t, ['init-correlation'], { ...env, CORRELATION_DB: other, GATEWAY_STORAGE_BACKEND: 'table-v2' }).finished, 1);
  assert.equal(existsSync(other), false);
});

test('CLI correlation provisioning refuses optional storage collisions before creating its main or owner', async (t) => {
  for (const kind of ['ingress-wal', 'delivery-owner', 'both', 'parent-alias', 'hardlink'] as const) {
    const fixture = envFixture(t); const directory = dirname(fixture.INGRESS_DB);
    const delivery = join(directory, 'delivery.sqlite'); const correlation = join(directory, 'correlation.sqlite');
    const env: NodeJS.ProcessEnv = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, CORRELATION_DB: correlation };
    if (kind === 'ingress-wal') { env.INGRESS_DB = fixture.INGRESS_DB; env.CORRELATION_DB = `${fixture.INGRESS_DB}-wal`; }
    if (kind === 'delivery-owner') { env.DELIVERY_DB = delivery; env.CORRELATION_DB = `${delivery}.owner.sqlite-wal`; }
    if (kind === 'both') { env.INGRESS_DB = `${correlation}.owner.sqlite-journal`; env.DELIVERY_DB = delivery; }
    if (kind === 'parent-alias') {
      mkdirSync(join(directory, 'actual')); symlinkSync(join(directory, 'actual'), join(directory, 'alias'));
      env.INGRESS_DB = join(directory, 'actual', 'inbox.sqlite'); env.CORRELATION_DB = join(directory, 'alias', 'inbox.sqlite-wal');
    }
    if (kind === 'hardlink') {
      writeFileSync(`${delivery}-shm`, 'synthetic reserved inode', { mode: 0o600 });
      linkSync(`${delivery}-shm`, `${correlation}.owner.sqlite-wal`); env.DELIVERY_DB = delivery;
    }
    const run = cli(t, ['init-correlation'], env); await run.finished;
    assert.equal(existsSync(env.CORRELATION_DB!), false, `${kind}: correlation main must remain absent`);
    assert.equal(existsSync(`${env.CORRELATION_DB}.owner.sqlite`), false, `${kind}: correlation owner must remain absent`);
    assert.equal(run.child.exitCode, 1, kind);
    assert.ok(run.output().includes('teams-ingress: configuration-failed'), kind);
    assert.ok(!run.output().includes('initialized'), kind);
    assert.ok(!run.output().includes(directory), kind);
  }
});

test('CLI correlation provisioning accepts unrelated optional stores without Orka scope or creating them', async (t) => {
  for (const knobs of [[], ['INGRESS_DB'], ['DELIVERY_DB'], ['INGRESS_DB', 'DELIVERY_DB']]) {
    const fixture = envFixture(t); const directory = dirname(fixture.INGRESS_DB); const path = join(directory, 'correlation.sqlite');
    const env: NodeJS.ProcessEnv = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, CORRELATION_DB: path };
    for (const knob of knobs) env[knob] = join(directory, `${knob}.sqlite`);
    assert.equal(await cli(t, ['init-correlation'], env).finished, 0);
    const handle = openSessionCorrelation(path, { appId: scope.appId, tenantId: scope.tenantId }); handle.close();
    for (const knob of knobs) {
      assert.equal(existsSync(env[knob]!), false); assert.equal(existsSync(`${env[knob]}.owner.sqlite`), false);
    }
  }
});

test('correlation provisioning preflight preserves a live SQLite owner\'s child-process exclusion', (t) => {
  const fixture = envFixture(t); const path = join(dirname(fixture.INGRESS_DB), 'live-correlation.sqlite');
  const target = { appId: scope.appId, tenantId: scope.tenantId };
  initializeSessionCorrelation(path, target); const owner = openSessionCorrelation(path, target);
  const probe = () => {
    const source = `import { openSessionCorrelation } from './src/delivery/sqlite-session-correlation.ts';
      try { const handle = openSessionCorrelation(process.argv[1], JSON.parse(process.argv[2])); handle.close(); process.exit(3); }
      catch (error) { process.exit(error.code === 'busy' ? 0 : 4); }`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, path, JSON.stringify(target)],
      { cwd: new URL('..', import.meta.url), stdio: 'pipe', timeout: 10000 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); return child.status;
  };
  try {
    assert.equal(probe(), 0);
    const base = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, DELIVERY_DB: path };
    assert.equal(parseCorrelationConfig({ ...base, CORRELATION_DB: `${path}.other` }).dbPath, `${path}.other`);
    assert.equal(probe(), 0, 'unrelated provisioning preflight must not release the live owner');
    assert.throws(() => parseCorrelationConfig({ ...base, CORRELATION_DB: `${path}.owner.sqlite` }), ConfigurationError);
    assert.equal(probe(), 0, 'rejected provisioning preflight must not release the live owner');
  } finally { owner.close(); }
  assert.equal(probe(), 3, 'a fresh child may open only after the original owner closes');
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
  assert.ok(run.output().includes('teams-ingress: listener-failed: ingress')); assert.ok(!run.output().includes('listening'));
  assert.ok(!run.output().includes(env.TEAMS_CLIENT_SECRET)); assert.ok(!run.output().includes(env.ORKA_BEARER_TOKEN));
});

test('CLI startup SIGTERM suppresses listening announcement and releases the initialized inbox', async (t) => {
  const env = { ...envFixture(t), TEAMS_CLIENT_SECRET: randomUUID(), ORKA_BEARER_TOKEN: randomUUID(),
    TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls) };
  assert.equal(await cli(t, ['init'], env).finished, 0);
  const run = cli(t, ['serve'], env, true);
  assert.equal(await run.finished, 1); assert.ok(!run.output().includes('listening'));
  assert.ok(run.output().includes('teams-ingress: startup-failed: cancelled'));
  for (const secret of [env.TEAMS_CLIENT_SECRET, env.ORKA_BEARER_TOKEN]) assert.ok(!run.output().includes(secret));
  const store = openIngressStore(env.INGRESS_DB, scope); store.close();
});

for (const mode of ['SIGTERM', 'SIGINT', 'natural-failure']) test(`CLI memory diagnostics start after listening and clean up on ${mode}`, async t => {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const env = { ...envFixture(t), TEAMS_CLIENT_SECRET: randomUUID(), ORKA_BEARER_TOKEN: randomUUID(),
    TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls),
    INGRESS_PORT: String(address.port) };
  assert.equal(await cli(t, ['init'], env).finished, 0);
  const run = cli(t, ['serve'], env, false, mode);
  assert.equal(await run.finished, mode === 'natural-failure' ? 1 : 0);
  const output = run.output();
  assert.ok(output.includes('teams-ingress: listening'));
  assert.ok(output.includes(mode === 'natural-failure' ? 'teams-ingress: storage-failed: runtime-failure' : 'teams-ingress: stopped'));
  const records = output.split('\n').filter(line => line.startsWith('teams-ingress: process-memory '));
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(line => JSON.parse(line.slice('teams-ingress: process-memory '.length))),
    [{ rss: 101, heapTotal: 202, heapUsed: 303, external: 404, arrayBuffers: 505 },
      { rss: 101, heapTotal: 202, heapUsed: 303, external: 404, arrayBuffers: 505 }]);
  assert.ok(!output.slice(0, output.indexOf('diagnostics-test: before-first-minute')).includes('process-memory'));
  assert.ok(!output.slice(output.indexOf('diagnostics-test: two-minutes')).includes('process-memory'));
  if (mode !== 'natural-failure') assert.ok(output.includes('diagnostics-test: signal-draining'));
  assert.ok(output.includes('diagnostics-test: after-runtime'));
  for (const sentinel of ['private', env.TEAMS_CLIENT_SECRET, env.ORKA_BEARER_TOKEN]) assert.ok(!output.includes(sentinel));
  if (mode === 'natural-failure') chmodSync(env.INGRESS_DB, 0o600);
  const store = openIngressStore(env.INGRESS_DB, scope); store.close();
});

test('CLI memory diagnostics never start for initialization commands', async t => {
  const env = envFixture(t);
  for (const [command, variables] of [
    ['init', env], ['init-delivery', { ...env, DELIVERY_DB: `${env.INGRESS_DB}.delivery` }],
    ['init-correlation', { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, CORRELATION_DB: `${env.INGRESS_DB}.correlation` }],
  ] as [string, NodeJS.ProcessEnv][]) {
    const run = cli(t, [command], variables, false, 'clock-only');
    assert.equal(await run.finished, 0); assert.ok(run.output().includes('teams-ingress: initialized'));
    assert.ok(run.output().includes('diagnostics-test: without-listening'));
    assert.ok(!run.output().includes('process-memory'));
  }
});

for (const command of ['recover-ingress', 'recover-delivery']) test(`CLI memory diagnostics never start for ${command}`, async t => {
  const env = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, ORKA_BASE_URL: scope.orkaBaseUrl,
    ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName,
    GATEWAY_STORAGE_BACKEND: 'table-v2', TABLE_ACCOUNT: 'example123', TABLE_NAME: 'journal',
    TABLE_INGRESS_STORE_ID: 'stable', TABLE_DELIVERY_STORE_ID: 'stable',
    TABLE_MANAGED_IDENTITY_HOST: 'imds', TABLE_MANAGED_IDENTITY_CLIENT_ID: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    TABLE_AUDIT_MAX_PAGES: '100', TABLE_AUDIT_MAX_BYTES: '10485760', TABLE_AUDIT_MAX_DURATION_MS: '30000',
    TABLE_AUDIT_MAX_TRACKING_BYTES: '1048576', TABLE_MAX_INDEX_BYTES: '16777216',
    TABLE_RECOVERY_EXPECTED_OWNER: '22222222-2222-4222-8222-222222222222', TABLE_RECOVERY_EXPECTED_EPOCH: '1',
    TABLE_RECOVERY_ATTESTATION_DIGEST: 'b'.repeat(64) };
  const run = cli(t, [command], env, false, 'early-signal');
  assert.equal(await run.finished, 1);
  assert.ok(run.output().includes('teams-ingress: operator-recovery-failed: cancelled'));
  assert.ok(run.output().includes('diagnostics-test: starting'));
  assert.ok(run.output().includes('diagnostics-test: without-listening'));
  assert.ok(!run.output().includes('process-memory'));
});

test('CLI memory diagnostics never start for invalid configuration, failed binding or startup cancellation', async t => {
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  const address = occupied.address(); assert.ok(address && typeof address !== 'string');
  const env = { ...envFixture(t), TEAMS_CLIENT_SECRET: randomUUID(), ORKA_BEARER_TOKEN: randomUUID(),
    TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls),
    INGRESS_PORT: String(address.port) };
  assert.equal(await cli(t, ['init'], env).finished, 0);
  for (const [variables, mode, category] of [
    [{}, 'clock-only', 'configuration-failed'],
    [{ ...env, INGRESS_DB: `${env.INGRESS_DB}.missing` }, 'clock-only', 'store-open-failed'],
    [env, 'clock-only', 'listener-failed'], [env, 'early-signal', 'startup-failed: cancelled'],
  ] as [NodeJS.ProcessEnv, string, string][]) {
    const run = cli(t, ['serve'], variables, false, mode);
    assert.equal(await run.finished, 1); assert.ok(run.output().includes(`teams-ingress: ${category}`));
    assert.ok(run.output().includes('diagnostics-test: without-listening'));
    assert.ok(!run.output().includes('teams-ingress: listening')); assert.ok(!run.output().includes('process-memory'));
    for (const sentinel of ['private', env.TEAMS_CLIENT_SECRET, env.ORKA_BEARER_TOKEN]) assert.ok(!run.output().includes(sentinel));
  }
  const store = openIngressStore(env.INGRESS_DB, scope); store.close();
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
  for (let i = 0; i < 400 && !run.output().includes('teams-ingress: listening') && run.child.exitCode === null; i++) await sleep(25);
  assert.ok(run.output().includes('teams-ingress: listening'));
  const response = await fetch(`http://127.0.0.1:${port}/api/messages`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private-token-sentinel' },
    body: JSON.stringify({ text: 'private-raw-body-sentinel', serviceUrl: receiverConfig.serviceUrls[0] }) });
  assert.equal(response.status, 401);
  for (const path of ['/v1/health', '/v1/capabilities', '/v1/deliveries']) assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 404);
  run.child.kill('SIGTERM'); assert.equal(await run.finished, 0);
  assert.ok(!run.output().includes('private')); assert.ok(!run.output().includes(env.TEAMS_CLIENT_SECRET));
});
