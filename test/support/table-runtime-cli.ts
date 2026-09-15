import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FixtureHooks } from './ingress-https.js';
import type { EventEnvelope } from '../../src/protocol/types.js';
import { activity, authFixture, post, recipientId, scope, serviceUrl } from './ingress-auth.js';
import { httpsFixture } from './ingress-https.js';
import { runtimeIdentity, runtimeTableService, storageClientId } from './table-runtime.js';
import { acaHeader } from './aca-identity.js';
import { entraEndpoint, miConfig } from './managed-identity.js';
import { syntheticAccessToken } from './certificate.js';
import { syntheticToken } from './table-service.js';
import { finalDelivery, finalMessage } from '../fixtures/outgoing.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const marker = 'table-cli-native: ';
interface Result { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface ProcessRun { child: ChildProcess; done: Promise<Result>; output(): string; name?: string }
function execute(binary: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => execFile(binary, args, { cwd: root, ...(env === undefined ? {} : { env }),
    timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve({ code: error ? 1 : 0, stdout })));
}
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = performance.now() + 20000;
  while (!await check()) { assert.equal(performance.now() < deadline, true, label); await sleep(20); }
}
async function unusedPort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
function observe(server: Server) {
  const stats = { requests: 0, closes: 0, sockets: 0, socketCloses: 0 };
  server.on('request', req => { stats.requests++; req.once('close', () => stats.closes++); });
  server.on('connection', socket => { stats.sockets++; socket.once('close', () => stats.socketCloses++); });
  return { stats, drained: () => stats.requests === stats.closes && stats.sockets === stats.socketCloses };
}
function payloads(rows: Map<string, Record<string, unknown>>, kind: string): Record<string, any>[] {
  return [...rows.values()].filter(row => row.T === kind).map(row => JSON.parse(Buffer.concat(
    Array.from({ length: Number(row.Count) }, (_, i) => Buffer.from(String(row[`B${i}`]), 'base64'))).toString()));
}

interface CleanupRun { child: Pick<ChildProcess, 'exitCode' | 'signalCode' | 'kill'>; done: Promise<unknown>; name?: string }
interface CliFixtureHooks extends FixtureHooks { diagnostic(message: string): void }

// A timeout is a FAILED observation, never proof that the underlying work ended.
async function attemptedCleanup(action: () => unknown, waitMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action).then(() => true, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), waitMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
export async function cleanupTableCliRuns(runs: readonly CleanupRun[],
  remove: (name: string) => Promise<{ code: number }> = name => execute('docker', ['rm', '-f', name]), waitMs = 20000): Promise<void> {
  const results = await Promise.all(runs.map(async run => {
    const removed = await attemptedCleanup(async () => {
      if (run.name) {
        if ((await remove(run.name)).code !== 0) throw new Error('Removal not confirmed');
      } else if (run.child.exitCode === null && run.child.signalCode === null && !run.child.kill('SIGKILL')) {
        throw new Error('Termination not confirmed');
      }
    }, waitMs);
    // Even failed removal must not skip this run's wait, or another owner's work.
    const waited = await attemptedCleanup(() => run.done, waitMs);
    return removed && waited;
  }));
  if (results.some(result => !result)) throw new Error('Table CLI fixture cleanup failed');
}

/** In-process image stage: no nested node --test wrapper/descendants can escape
 * its cleanup boundary. The outer finally owns every registered fixture hook. */
export async function runTableContainerStage(image: string, qualify = qualifyTableCli, waitMs = 60000): Promise<void> {
  const cleanups: (() => void | Promise<void>)[] = []; let failed = false;
  const hooks: CliFixtureHooks = { after(cleanup) { cleanups.push(cleanup); }, diagnostic() {} };
  try { await qualify(hooks, image); } catch { failed = true; }
  finally {
    // Preserve registration order (run shutdown before server force-close), while
    // independently attempting every hook even after rejection or a held wait.
    for (const cleanup of cleanups) if (!await attemptedCleanup(cleanup, waitMs)) failed = true;
  }
  if (failed) throw new Error('Table container fixture failed');
}

export function hasTableCanary(rows: readonly Record<string, unknown>[], canaries: readonly string[]): boolean {
  try {
    const stored = JSON.stringify(rows); const needles = canaries.map(value => Buffer.from(value));
    if (canaries.some(value => stored.includes(value) || stored.includes(Buffer.from(value).toString('base64')))) return true;
    const contains = (bytes: Buffer) => needles.some(needle => bytes.includes(needle));
    for (const row of rows) {
      const chunks: [number, Buffer][] = [];
      for (const [key, value] of Object.entries(row)) {
        const chunk = /^B(\d+)$/u.exec(key);
        if (!chunk && row[`${key}@odata.type`] !== 'Edm.Binary') continue;
        if (typeof value !== 'string') return true;
        const decoded = Buffer.from(value, 'base64');
        if (contains(decoded)) return true;
        if (chunk) chunks.push([Number(chunk[1]), decoded]);
      }
      // A canary can straddle two independently base64-encoded data chunks.
      if (contains(Buffer.concat(chunks.sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes)))) return true;
    }
    return false;
  } catch { return true; } // Fail closed without exposing malformed/private data.
}

/** Same qualification for a private fresh tsc output and the actual compiled image.
 * Docker is selected only by the explicit support-file runner, never npm test. */
export async function qualifyTableCli(t: CliFixtureHooks, image?: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'teams-table-cli-'));
  const fixtureDir = join(directory, 'fixture'); const work = join(directory, 'work');
  const runs: ProcessRun[] = [];
  t.after(async () => {
    // Failure cleanup runs before fixture servers close. It is NOT drain evidence.
    await cleanupTableCliRuns(runs);
    // Retain private fixtures if a container removal or actual child exit is unknown.
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(fixtureDir); mkdirSync(work);
  const tables = await runtimeTableService(t, scope); const identity = await runtimeIdentity(t, 30);
  const auth = await authFixture(t); const otherAuth = await authFixture(t); const incomingToken = auth.token();
  const finalToken = syntheticAccessToken(); const receipt = 'compiled-table-provider-receipt'; const orkaReceipt = 'compiled-table-orka-event';
  let sdkWrongKey = true; let saved: EventEnvelope | undefined;
  const effects = { orka: 0, provider: 0, entra: 0, strictKeys: 0, sdkKeys: 0, contract: true };
  const services = await httpsFixture(t, async (req, res) => {
    try {
      res.setHeader('Connection', 'close'); res.setHeader('Content-Type', 'application/json');
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString(); const host = req.headers.host;
      effects.contract &&= !JSON.stringify(req.headers).includes(acaHeader) && !text.includes(acaHeader) &&
        !JSON.stringify(req.headers).includes(syntheticToken) && !text.includes(syntheticToken);
      if (host === 'login.botframework.com' && req.url === '/v1/.well-known/keys') {
        const strict = req.headers['x-fixture-verifier'] === 'strictKeys';
        if (strict) effects.strictKeys++; else effects.sdkKeys++;
        effects.contract &&= req.method === 'GET' && req.headers.authorization === undefined;
        res.end(JSON.stringify({ keys: [!strict && sdkWrongKey ? { ...otherAuth.key, kid: auth.key.kid } : auth.key] }));
      } else if (host === 'login.microsoftonline.com') {
        effects.entra++; const form = new URLSearchParams(text);
        effects.contract &&= req.method === 'POST' && req.url === new URL(entraEndpoint).pathname &&
          form.get('scope') === 'https://api.botframework.com/.default' && form.get('client_id') === scope.appId &&
          form.has('client_assertion') && !form.has('client_secret') && req.headers.authorization === undefined;
        res.end(JSON.stringify({ access_token: finalToken, token_type: 'Bearer', expires_in: 3600 }));
      } else if (host === 'orka.example.invalid') {
        effects.orka++; saved = JSON.parse(text);
        effects.contract &&= req.method === 'POST' && req.headers.authorization === 'Bearer synthetic-ingress-bearer' &&
          req.url === '/api/v1/gateways/default/teams/events';
        res.writeHead(202); res.end(JSON.stringify({ status: 'accepted', eventId: orkaReceipt, state: 'Queued' }));
      } else if (host === 'teams-service.example.invalid') {
        effects.provider++;
        effects.contract &&= req.method === 'POST' && req.url === '/v3/conversations/19%3Afixture-personal/activities' &&
          req.headers.authorization === `Bearer ${finalToken}` && text === JSON.stringify(finalMessage);
        res.writeHead(201); res.end(JSON.stringify({ id: receipt }));
      } else { effects.contract = false; res.writeHead(400); res.end(); }
    } catch { effects.contract = false; res.destroy(); }
  });
  const observers = [tables.fixture.server, tables.inbox.fixture.server, tables.delivery.fixture.server, identity.server, services.server].map(observe);
  tables.fixture.server.on('request', req => {
    effects.contract &&= req.headers['x-identity-header'] === undefined && req.headers.authorization === `Bearer ${syntheticToken}`;
  });
  const ingressPort = await unusedPort(); let outboundPort = await unusedPort();
  while (outboundPort === ingressPort) outboundPort = await unusedPort();
  const common = { GATEWAY_STORAGE_BACKEND: 'table-v2', TABLE_ACCOUNT: 'example123', TABLE_NAME: 'journal',
    TABLE_INGRESS_STORE_ID: 'stable', TABLE_DELIVERY_STORE_ID: 'stable', TABLE_MANAGED_IDENTITY_CLIENT_ID: storageClientId,
    TABLE_MANAGED_IDENTITY_HOST: 'azure-container-apps', TABLE_AUDIT_MAX_PAGES: '100', TABLE_AUDIT_MAX_BYTES: '10485760',
    TABLE_AUDIT_MAX_DURATION_MS: '30000', TABLE_AUDIT_MAX_TRACKING_BYTES: '1048576', TABLE_MAX_INDEX_BYTES: '16777216',
    TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, ORKA_BASE_URL: scope.orkaBaseUrl,
    ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName,
    IDENTITY_ENDPOINT: new URL('msi/token', identity.baseUrl).href, IDENTITY_HEADER: acaHeader };
  const serving = { ...common, TEAMS_CREDENTIAL_MODE: 'managed-identity-federation', TEAMS_MANAGED_IDENTITY_HOST: 'azure-container-apps',
    TEAMS_MANAGED_IDENTITY_CLIENT_ID: miConfig.managedIdentityClientId, TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID: miConfig.managedIdentityPrincipalId,
    TEAMS_RECIPIENT_IDS: JSON.stringify([recipientId]), TEAMS_SERVICE_URLS: JSON.stringify([serviceUrl]),
    ORKA_BEARER_TOKEN: 'synthetic-ingress-bearer', ORKA_OUTBOUND_BEARER_TOKEN: 'synthetic-outbound-bearer', OUTBOUND_ENABLED: 'true',
    INGRESS_HOST: '127.0.0.1', INGRESS_PORT: String(ingressPort), OUTBOUND_HOST: '127.0.0.1', OUTBOUND_PORT: String(outboundPort),
    INGRESS_MAX_PENDING: '100', INGRESS_MAX_RECORDS: '100' };
  copyFileSync(join(root, 'test/support/table-runtime-cli-preload.mjs'), join(fixtureDir, 'preload.mjs'));
  writeFileSync(join(fixtureDir, 'native-settings.json'), JSON.stringify({ entraEndpoint, identity: common.IDENTITY_ENDPOINT,
    table: { baseUrl: tables.fixture.baseUrl, ca: tables.fixture.ca.toString() },
    services: { baseUrl: services.baseUrl, ca: services.ca.toString() } }));
  let entrypoint = '/app/dist/ingress/main.js';
  if (!image) {
    // npm run check builds AFTER tests. Compile src into this test's isolated output,
    // and resolve the unchanged installed dependencies without touching repo dist.
    const build = await execute(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json',
      '--outDir', join(directory, 'dist'), '--declaration', 'false']);
    assert.equal(build.code, 0, 'private compiled CLI build');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    entrypoint = join(directory, 'dist/ingress/main.js');
  } else {
    // Test-only public TLS/settings/preload mount; no fixture is copied into /app.
    chmodSync(directory, 0o755); chmodSync(fixtureDir, 0o755);
    for (const name of readdirSync(fixtureDir)) chmodSync(join(fixtureDir, name), 0o444);
  }
  function launch(mode: string, settings: Record<string, string>): ProcessRun {
    const name = image ? `teams-table-cli-${directory.split('/').pop()!}-${runs.length}` : undefined;
    const env = { PATH: process.env.PATH, HOME: directory, ...settings,
      ...(image ? { NODE_OPTIONS: '--import=/fixture/preload.mjs' } : {}) };
    const args = image ? ['run', '--name', name!, '--network', 'host', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--mount', `type=bind,src=${fixtureDir},dst=/fixture,readonly`,
      ...Object.keys(settings).concat('NODE_OPTIONS').flatMap(key => ['-e', key]), image, mode] :
      ['--import', join(fixtureDir, 'preload.mjs'), entrypoint, mode];
    const child = spawn(image ? 'docker' : process.execPath, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const append = (value: Buffer, stream: 'stdout' | 'stderr') => {
      if (stream === 'stdout') stdout += value.toString(); else stderr += value.toString();
      if (stdout.length + stderr.length > 65536) child.kill('SIGKILL');
    };
    child.stdout!.on('data', value => append(value, 'stdout')); child.stderr!.on('data', value => append(value, 'stderr'));
    const done = new Promise<Result>(resolve => {
      child.once('error', () => resolve({ code: -1, signal: null, stdout, stderr }));
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const run = { child, done, output: () => stderr, ...(name === undefined ? {} : { name }) }; runs.push(run); return run;
  }
  async function finished(run: ProcessRun, code: number, event: string, native = true) {
    await until(() => run.child.exitCode !== null || run.child.signalCode !== null, 'CLI exited without forced fixture cleanup');
    const result = await run.done;
    assert.equal(result.code, code, 'CLI exit code'); assert.equal(result.signal, null, 'natural CLI exit');
    assert.equal(result.stdout.length, 0); assert.equal(result.stderr.includes(`teams-ingress: ${event}\n`), true, 'fixed CLI lifecycle');
    const privateValues = [acaHeader, syntheticToken, finalToken, receipt, orkaReceipt, incomingToken, finalDelivery.text,
      serving.ORKA_BEARER_TOKEN, serving.ORKA_OUTBOUND_BEARER_TOKEN, common.IDENTITY_ENDPOINT];
    assert.equal(privateValues.some(value => result.stderr.includes(value)), false, 'private values absent from CLI output');
    const lines = result.stderr.split('\n').filter(line => line.startsWith(marker)); assert.equal(lines.length, 1);
    const counts = JSON.parse(lines[0]!.slice(marker.length)) as Record<string, number>;
    assert.equal(counts.unexpected, 0); assert.equal(counts.requests, counts.requestCloses); assert.equal(counts.sockets, counts.socketCloses);
    assert.equal(counts.requests, counts.sockets); if (native) assert.ok(counts.table! > 0 && counts.identity! > 0);
    if (run.name) {
      const state = await execute('docker', ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}}', run.name]);
      assert.equal(state.code, 0); assert.equal(state.stdout.trim(), `exited ${code} 1000:1000 true`);
    }
    await until(() => observers.every(observer => observer.drained()), 'native server request/socket drain BEFORE force-close');
    tables.drained(); identity.drained(); assert.equal(effects.contract, true, 'native fixed-purpose wire contract');
    assert.deepEqual(readdirSync(work), [], 'no SQLite or other CLI artifacts'); return counts;
  }
  async function start() {
    const run = launch('serve', serving);
    await until(() => run.output().includes('teams-ingress: listening\n') || run.child.exitCode !== null, 'compiled CLI listening');
    assert.equal(run.output().includes('teams-ingress: listening\n'), true, 'compiled CLI readiness');
    return run;
  }
  async function stop(run: ProcessRun) {
    const before = identity.calls.storage;
    if (run.name) assert.equal((await execute('docker', ['kill', '--signal=SIGTERM', run.name])).code, 0);
    else assert.equal(run.child.kill('SIGTERM'), true);
    const counts = await finished(run, 0, 'stopped');
    assert.ok(identity.calls.storage > before, 'fresh storage tokens remain available during release');
    for (const service of [tables.inbox, tables.delivery]) {
      const m = service.rows.get('M')!; assert.equal(m.Owner === '', true);
      assert.equal(JSON.parse(Buffer.from(String(m.Exit), 'base64').toString()).kind, 'clean-release');
    }
    return counts;
  }

  // A real CLI refuses contradictory SQLite paths before touching Table or disk.
  await finished(launch('init', { ...common, INGRESS_DB: join(work, 'must-not-exist.sqlite') }), 1, 'configuration-failed', false);
  await finished(launch('init', common), 0, 'initialized');
  assert.equal(tables.delivery.rows.size, 0, 'init touches only ingress'); assert.equal(identity.calls.bot, 0);
  const initializedInbox = JSON.stringify([...tables.inbox.rows]);
  await finished(launch('init-delivery', common), 0, 'initialized');
  assert.equal(JSON.stringify([...tables.inbox.rows]) === initializedInbox, true, 'delivery init does not rewrite ingress');
  for (const mode of ['init', 'init-delivery']) {
    const before = JSON.stringify([[...tables.inbox.rows], [...tables.delivery.rows]]);
    await finished(launch(mode, common), 1, 'startup-failed');
    assert.equal(JSON.stringify([[...tables.inbox.rows], [...tables.delivery.rows]]) === before, true, 'existing data not adopted/reset');
  }
  assert.equal(identity.calls.bot, 0); assert.equal(effects.entra, 0);
  // Strict verification accepts the real signature, but the default SDK fetches
  // an independent wrong RSA key and MUST refuse. Fresh process clears its cache.
  const denied = await start(); assert.equal((await post(ingressPort, incomingToken)).status, 401);
  assert.equal(effects.strictKeys, 1); assert.equal(effects.sdkKeys, 1); assert.equal(effects.orka, 0);
  assert.equal(payloads(tables.inbox.rows, 'event').length, 0); await stop(denied); sdkWrongKey = false;

  const running = await start(); assert.equal(identity.calls.bot, 0);
  const occupied = launch('serve', serving); await finished(occupied, 1, 'startup-failed');
  assert.equal(occupied.output().includes('teams-ingress: listening'), false, 'occupied writer cannot listen');
  assert.equal((await post(ingressPort, auth.token({ aud: 'wrong-audience' }))).status, 401);
  assert.equal((await post(ingressPort, incomingToken)).status, 200);
  await until(() => !!saved && payloads(tables.inbox.rows, 'event').some(row => row.state === 'terminal' && row.receipt?.eventId === orkaReceipt), 'persisted Orka receipt');
  assert.equal(saved?.text === activity().text && saved?.contextId === finalDelivery.contextId, true);
  assert.equal(payloads(tables.inbox.rows, 'route').length, 1);
  const body = { ...finalDelivery, originatingEventId: orkaReceipt, replyTarget: saved!.replyTarget };
  const deliver = async () => {
    const response = await fetch(`http://127.0.0.1:${outboundPort}/v1/deliveries`, { method: 'POST', headers: {
      Authorization: `Bearer ${serving.ORKA_OUTBOUND_BEARER_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); const result = await response.json() as Record<string, unknown>;
    assert.equal(result.status === 'delivered' && result.providerMessageId === receipt, true, 'native provider receipt');
  };
  await deliver();
  assert.equal(payloads(tables.delivery.rows, 'delivery').some(row => row.state === 'delivered' && row.providerMessageId === receipt), true);
  assert.equal((await post(ingressPort, incomingToken)).status, 200); await deliver();
  assert.equal(effects.orka, 1); assert.equal(effects.provider, 1); assert.equal(effects.entra, 1); assert.equal(identity.calls.bot, 1);
  const firstCounts = await stop(running); assert.equal(firstCounts.provider, 1); assert.equal(firstCounts.entra, 1);
  assert.equal(firstCounts.strictKeys, 1); assert.equal(firstCounts.sdkKeys, 1);
  const initIds = [tables.inbox.rows.get('M')!.InitId, tables.delivery.rows.get('M')!.InitId];
  const restarted = await start();
  assert.equal((await post(ingressPort, incomingToken)).status, 200); await deliver();
  const replayCounts = await stop(restarted);
  assert.equal(replayCounts.provider, 0); assert.equal(replayCounts.entra, 0);
  assert.equal(replayCounts.strictKeys, 1); assert.equal(replayCounts.sdkKeys, 1);
  assert.equal(effects.orka, 1); assert.equal(effects.provider, 1); assert.equal(effects.entra, 1); assert.equal(identity.calls.bot, 1);
  assert.equal(JSON.stringify(initIds) === JSON.stringify([tables.inbox.rows.get('M')!.InitId, tables.delivery.rows.get('M')!.InitId]), true);
  assert.equal(payloads(tables.inbox.rows, 'event').length, 1); assert.equal(payloads(tables.delivery.rows, 'delivery').length, 1);
  assert.equal(effects.contract && identity.calls.contract, true);
  assert.equal(hasTableCanary([...tables.inbox.rows.values(), ...tables.delivery.rows.values()],
    [acaHeader, syntheticToken, finalToken, incomingToken, serving.ORKA_BEARER_TOKEN, serving.ORKA_OUTBOUND_BEARER_TOKEN]),
  false, 'credentials absent from persisted rows');
  t.diagnostic(`natural-exit native counters first=${JSON.stringify(firstCounts)} replay=${JSON.stringify(replayCounts)}`);
  t.diagnostic(image ? 'actual image CLI, UID/GID1000/read-only, native Table/ACA/FIC/MSAL/JWKS/provider and SIGTERM replay passed' :
    'private fresh tsc CLI, native Table/ACA/FIC/MSAL/JWKS/provider and SIGTERM replay passed');
}
