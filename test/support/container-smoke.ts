// Explicit opt-in Docker acceptance, deliberately outside test/*.test.ts.
// The same file is transpiled into a private fixture mount, never into the image.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as plaintextRequest } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DeliveryRequest } from '../../src/protocol/types.js';

const image = 'orka-gateway-teams:local';
const nginxImage = 'nginxinc/nginx-unprivileged:stable-alpine@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce';
const serverName = 'teams-adapter.orka-system.svc';
let stage = 'preflight';
let smokeHost = '127.0.0.1';
interface FixtureSettings { env: Record<string, string>; delivery: DeliveryRequest; receipt: string }
interface Result { code: number; stdout: string; stderr: string }
function command(binary: string, args: string[], env: NodeJS.ProcessEnv = {}, timeout = 60000): Promise<Result> {
  return new Promise((resolve) => {
    execFile(binary, args, { env: { ...process.env, ...env }, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr });
    });
  });
}
const docker = (args: string[], env: NodeJS.ProcessEnv = {}, timeout?: number) => command('docker', args, env, timeout);
function ok(result: Result): string { assert.equal(result.code, 0); return result.stdout.trim(); }
function privateOutput(result: Result, secrets: string[]): void {
  assert.equal(secrets.some((value) => (result.stdout + result.stderr).includes(value)), false);
}
function files(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    return entry.isDirectory() ? files(join(directory, entry.name), relative + '/') : [relative];
  });
}

// Fixture modes execute only as explicit, file-based helpers in isolated containers.
async function fixture(mode: string): Promise<void> {
  if (mode === 'fixture-inspect') {
    assert.equal(process.getuid?.(), 1000); assert.equal(process.getgid?.(), 1000);
    assert.equal(process.cwd(), '/app'); assert.equal(process.version, 'v24.2.0');
    assert.deepEqual(readdirSync('/app').sort(), ['dist', 'node_modules', 'package-lock.json', 'package.json']);
    assert.equal(files('/app/dist').some((name) => name.endsWith('.map') || name.endsWith('.ts') && !name.endsWith('.d.ts')), false);
    stage = 'image excludes dependency source maps';
    assert.equal(files('/app/node_modules').some((name) => name.endsWith('.map')), false);
    assert.equal(existsSync('/app/dist/deployment/probe.js'), true);
    assert.equal(existsSync('/app/dist/setup/main.js'), true);
    const lock = JSON.parse(readFileSync('/app/package-lock.json', 'utf8')) as { packages: Record<string, { dev?: boolean; optional?: boolean }> };
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path) continue;
      if (entry.dev) assert.equal(existsSync(join('/app', path)), false);
      else if (!entry.optional) assert.equal(existsSync(join('/app', path)), true);
    }
    let readOnly = false;
    try { writeFileSync('/app/must-not-write', 'x'); } catch { readOnly = true; }
    assert.equal(readOnly, true); writeFileSync('/tmp/writable', 'x');
    // Import must not execute the CLI (no POD_NAMESPACE/CA available here).
    const modulePath = '/app/dist/deployment/probe.js'; await import(modulePath);
    assert.equal(process.exitCode === undefined || process.exitCode === 0, true);
    return;
  }
  if (mode === 'fixture-network') { setInterval(() => {}, 1000); return; }
  const settings = JSON.parse(readFileSync('/fixture/settings.json', 'utf8')) as FixtureSettings;
  if (mode === 'fixture-seed') {
    const modulePath = '/app/dist/delivery/journal.js';
    const { openDeliveryJournal } = await import(modulePath) as typeof import('../../src/delivery/journal.js');
    const journal = openDeliveryJournal('/data/delivery.sqlite', { appId: settings.env.TEAMS_APP_ID!, tenantId: settings.env.TEAMS_TENANT_ID! });
    try {
      const begun = journal.begin(settings.delivery); assert.equal(begun.kind, 'claimed');
      if (begun.kind === 'claimed') assert.equal(journal.settle(begun.claim, { kind: 'delivered', providerMessageId: settings.receipt }), 'recorded');
    } finally { journal.close(); }
    return;
  }
  if (mode === 'fixture-upstream') {
    // Transport-only synthetic upstream: real adapter auth/deadlines are tested separately.
    let calls = 0;
    for (const port of [3978, 3979]) {
      const server = createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.url === '/count') { res.end(JSON.stringify({ calls })); return; }
        if (req.url?.startsWith('/fail')) { calls++; req.socket.destroy(); return; }
        if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:3979/unchanged' }); res.end(); return; }
        if (req.url === '/stream-response') {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.write('first'); const timer = setTimeout(() => res.end('last'), 3000);
          res.once('close', () => clearTimeout(timer)); return;
        }
        if (req.url === '/stream-request') { req.once('data', () => res.end('{"streamed":true}')); return; }
        req.resume(); req.once('end', () => res.end(JSON.stringify({ path: req.url,
          authorizationMatches: req.headersDistinct.authorization?.length === 1 && req.headersDistinct.authorization[0] === `Bearer ${settings.env.ORKA_OUTBOUND_BEARER_TOKEN}`,
          connection: req.headers.connection, version: req.httpVersion })));
      });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    }
    return;
  }
  throw new Error('Unknown fixture mode');
}

async function plaintextStatus(port: number): Promise<number> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { req.destroy(); resolve(0); }, 1000);
    const req = plaintextRequest({ host: smokeHost, port, path: '/v1/health', agent: false }, (res) => {
      clearTimeout(timer); res.destroy(); resolve(res.statusCode ?? 0);
    });
    req.on('error', () => { clearTimeout(timer); resolve(0); }); req.end();
  });
}

interface HttpResult { status: number; body: string; location?: string; firstByteMs: number;
  isJSON?: boolean; isPlainText?: boolean; noSniff?: boolean }
function https(ca: Buffer, port: number, path: string, options: {
  method?: string; headers?: OutgoingHttpHeaders; body?: string; slow?: boolean; partial?: boolean;
} = {}): Promise<HttpResult> {
  return new Promise((resolve) => {
    const started = performance.now(); let bytes = 0; let body = ''; let firstByteMs = Infinity;
    let drip: ReturnType<typeof setInterval> | undefined;
    const done = (result: HttpResult) => { clearTimeout(timer); clearInterval(drip); req.destroy(); resolve(result); };
    const timer = setTimeout(() => done({ status: 0, body: '', firstByteMs }), options.slow ? 13000 : 5000);
    const req = request({ host: smokeHost, port, servername: serverName, ca, rejectUnauthorized: true, agent: false,
      method: options.method ?? 'GET', path, headers: { Connection: 'close', ...options.headers } }, (res) => {
      res.on('error', () => done({ status: 0, body: '', firstByteMs }));
      res.on('data', (chunk: Buffer) => {
        firstByteMs = Math.min(firstByteMs, performance.now() - started); bytes += chunk.length;
        if (bytes > 4096) done({ status: 0, body: '', firstByteMs }); else body += chunk.toString();
      });
      res.on('end', () => done({ status: res.statusCode ?? 0, body, firstByteMs,
        isJSON: res.headers['content-type'] === 'application/json; charset=utf-8',
        isPlainText: res.headers['content-type'] === 'text/plain; charset=utf-8',
        noSniff: res.headers['x-content-type-options'] === 'nosniff',
        ...(res.headers.location === undefined ? {} : { location: res.headers.location }) }));
    });
    req.on('error', () => done({ status: 0, body: '', firstByteMs }));
    if (options.slow) { req.write('{'); drip = setInterval(() => req.write(' '), 100); }
    else if (options.partial) req.write('first');
    else req.end(options.body);
  });
}

export async function checkMissingOwner(directory: string, containerName: string,
  launch: () => Promise<Result>, execute: (args: string[]) => Promise<Result>): Promise<void> {
  const stopped = async (expectedExit: boolean): Promise<boolean> => {
    try {
      const result = await execute(['inspect', '--format',
        '{{.State.Status}} {{.State.Running}} {{.State.Restarting}} {{.State.ExitCode}}', containerName]);
      const state = result.stdout.trim();
      return result.code === 0 && (expectedExit ? state === 'exited false false 1' : /^exited false false \d+$/u.test(state));
    } catch { return false; }
  };
  renameSync(join(directory, 'delivery.sqlite.owner.sqlite'), join(directory, 'owner.held'));
  let safeToRestore = false;
  try {
    const result = await launch();
    safeToRestore = result.code === 1 && await stopped(true);
    assert.equal(safeToRestore, true);
  } finally {
    if (!safeToRestore) {
      // A client exit (including 1) is not a container exit. Only this owned
      // fixture may be stopped, and a stop acknowledgment alone is not proof.
      try { await execute(['stop', '--time', '15', containerName]); } catch { /* Inspect still decides whether restoration is safe. */ }
      safeToRestore = await stopped(false);
    }
    if (safeToRestore) renameSync(join(directory, 'owner.held'), join(directory, 'delivery.sqlite.owner.sqlite'));
  }
}

async function smoke(): Promise<void> {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  process.chdir(root);
  stage = 'missing packaging artifact: Dockerfile'; assert.equal(existsSync('Dockerfile'), true);
  stage = 'missing packaging artifact: .dockerignore'; assert.equal(existsSync('.dockerignore'), true);
  stage = 'missing packaging artifact: deploy/nginx.conf'; assert.equal(existsSync('deploy/nginx.conf'), true);
  const directory = mkdtempSync(join(tmpdir(), 'teams-container-'));
  const owned = `teams-smoke-${randomUUID()}`; const containers: string[] = []; let network = false;
  const fixtureDir = join(directory, 'fixture'); const data = join(directory, 'data'); const tls = join(directory, 'tls');
  // Exercise the existing configuration's inclusive 8192-character bearer limit.
  const secrets = [randomUUID(), randomUUID(), randomUUID().repeat(228).slice(0, 8192), randomUUID()];
  const env: Record<string, string> = { TEAMS_APP_ID: randomUUID(), TEAMS_TENANT_ID: randomUUID(), ORKA_BASE_URL: 'https://orka.example.invalid/',
    ORKA_GATEWAY_NAMESPACE: 'orka-system', ORKA_GATEWAY_NAME: 'teams', INGRESS_DB: '/data/ingress.sqlite', DELIVERY_DB: '/data/delivery.sqlite',
    TEAMS_CLIENT_SECRET: secrets[0]!, ORKA_BEARER_TOKEN: secrets[1]!, ORKA_OUTBOUND_BEARER_TOKEN: secrets[2]!, OUTBOUND_ENABLED: 'true',
    TEAMS_RECIPIENT_IDS: '["synthetic-bot"]', TEAMS_SERVICE_URLS: '["https://teams.example.invalid/"]', POD_NAMESPACE: 'orka-system' };
  const delivery: DeliveryRequest = { protocolVersion: 'orka.gateway.v1', deliveryId: 'synthetic-delivery', idempotencyId: 'synthetic-idempotency',
    originatingEventId: 'synthetic-event', kind: 'final', accountId: env.TEAMS_TENANT_ID!, contextId: 'synthetic-personal',
    replyTarget: 'synthetic-reply', text: secrets[3]! };
  const receipt = randomUUID(); secrets.push(receipt);
  const security = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m'];
  const mount = (source: string, target: string, readonly = true) => ['--mount', `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`];
  const storage = () => mount(data, '/data', false);
  const helper = () => mount(fixtureDir, '/fixture');
  const credentials = Object.keys(env).flatMap((key) => ['-e', key]);
  const initKeys = ['TEAMS_APP_ID', 'TEAMS_TENANT_ID', 'ORKA_BASE_URL', 'ORKA_GATEWAY_NAMESPACE', 'ORKA_GATEWAY_NAME', 'INGRESS_DB', 'DELIVERY_DB'];
  async function run(args: string[], settings: NodeJS.ProcessEnv = {}, timeout?: number): Promise<Result> {
    if (args[0] === 'run' && args[1] === '--rm') {
      // Track foreground containers too: killing a timed-out Docker client does
      // not prove its container stopped. Retain it until our owned cleanup.
      const name = `${owned}-once-${containers.length}`; containers.push(name);
      args = ['run', '--name', name, ...args.slice(2)];
    }
    const result = await docker(args, settings, timeout); privateOutput(result, secrets); return result;
  }
  async function start(name: string, args: string[], settings: NodeJS.ProcessEnv = {}): Promise<void> {
    containers.push(name); ok(await run(['run', '-d', '--name', name, ...args], settings));
  }
  async function stop(name: string): Promise<void> {
    ok(await run(['stop', '--time', '15', name], {}, 25000));
    assert.equal(ok(await run(['inspect', '--format', '{{.State.ExitCode}}', name])), '0');
  }
  async function logsSafe(): Promise<void> {
    for (const name of containers) {
      const result = await run(['logs', name]); ok(result);
      if (name.endsWith('-proxy')) assert.equal((result.stdout + result.stderr).length, 0);
    }
  }
  try {
    stage = 'private fixture preparation'; assert.equal(process.getuid?.(), 1000);
    mkdirSync(fixtureDir, { mode: 0o755 }); mkdirSync(data, { mode: 0o700 }); mkdirSync(tls, { mode: 0o755 });
    const ts = await import('typescript');
    const compiled = ts.transpileModule(readFileSync(fileURLToPath(import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext }, fileName: 'container-smoke.ts',
    }).outputText;
    writeFileSync(join(fixtureDir, 'container-smoke.mjs'), compiled, { mode: 0o444 });
    writeFileSync(join(fixtureDir, 'settings.json'), JSON.stringify({ env, delivery, receipt } satisfies FixtureSettings), { mode: 0o444 });
    ok(await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tls, 'tls.key'),
      '-out', join(tls, 'tls.crt'), '-days', '1', '-subj', `/CN=${serverName}`, '-addext', `subjectAltName=DNS:${serverName}`]));
    chmodSync(join(tls, 'tls.key'), 0o444); chmodSync(join(tls, 'tls.crt'), 0o444);
    const ca = readFileSync(join(tls, 'tls.crt'));
    const caMount = () => mount(join(tls, 'tls.crt'), '/etc/adapter-ca/ca.crt');

    stage = 'allowlisted Docker context export';
    writeFileSync(join(directory, 'context.Dockerfile'), 'FROM scratch\nCOPY . /\n', { mode: 0o600 });
    ok(await run(['build', '-f', join(directory, 'context.Dockerfile'), '--output', `type=local,dest=${join(directory, 'context')}`, '.'], {}, 120000));
    const contextFiles = files(join(directory, 'context')).sort();
    const expected = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', ...files('src').filter((name) => name.endsWith('.ts')).map((name) => `src/${name}`)].sort();
    assert.deepEqual(contextFiles, expected);
    console.log('PASS actual build-context allowlist (no repository/test/credential/local DB/host dependency artifacts)');

    stage = 'locked production image build';
    const imageId = ok(await run(['build', '--quiet', '--tag', image, '.'], {}, 600000));
    assert.equal(/^sha256:[a-f0-9]{64}$/u.test(imageId), true); console.log(`IMAGE ${imageId}`);
    stage = 'image argv and filesystem acceptance';
    const config = JSON.parse(ok(await run(['image', 'inspect', '--format', '{{json .Config}}', image]))) as {
      User: string; WorkingDir: string; Entrypoint: string[]; Cmd: string[]; Volumes?: unknown;
    };
    assert.equal(config.User, '1000:1000'); assert.equal(config.WorkingDir, '/app');
    assert.deepEqual(config.Entrypoint, ['node', '/app/dist/ingress/main.js']); assert.deepEqual(config.Cmd, ['serve']);
    assert.equal(config.Volumes == null, true);
    ok(await run(['run', '--rm', '--network', 'none', ...security, ...helper(), '--entrypoint', 'node', image, '/fixture/container-smoke.mjs', 'fixture-inspect']));
    console.log('PASS Node 24.2.0, UID/GID 1000, direct argv, production-only app payload, read-only root and writable tmpfs');

    stage = 'standalone compiled capture with private host mount, no runtime volume and safe expiry';
    const setupDirectory = join(directory, 'capture'); mkdirSync(setupDirectory, { mode: 0o700 });
    const challenge = 'orka-setup:' + randomBytes(16).toString('hex'); secrets.push(challenge);
    writeFileSync(join(setupDirectory, 'challenge'), challenge, { mode: 0o600, flag: 'wx' });
    const setupEnv = { TEAMS_APP_ID: env.TEAMS_APP_ID!, TEAMS_TENANT_ID: env.TEAMS_TENANT_ID!, TEAMS_CLIENT_SECRET: env.TEAMS_CLIENT_SECRET!,
      SETUP_CHALLENGE_FILE: '/capture/challenge', SETUP_CAPTURE_FILE: '/capture/candidate.json', SETUP_TIMEOUT_MS: '1000', SETUP_HOST: '0.0.0.0' };
    const setupArgs = [...security, ...mount(setupDirectory, '/capture', false), ...Object.keys(setupEnv).flatMap((key) => ['-e', key]),
      '--entrypoint', 'node', image, '/app/dist/setup/main.js'];
    const expiredSetup = await run(['run', '--rm', '--network', 'none', ...setupArgs], setupEnv);
    assert.equal(expiredSetup.code, 1); assert.equal(expiredSetup.stdout.length, 0);
    assert.equal(expiredSetup.stderr === 'teams-setup: listening\nteams-setup: failed\n', true);
    assert.deepEqual(readdirSync(setupDirectory), ['challenge']); assert.deepEqual(readdirSync(data), []);
    console.log('PASS compiled setup entrypoint, private host-only mount, no runtime database, fixed-safe expiry');

    stage = 'independent synthetic app certificate with app-only private read-only mount';
    const appAuth = join(directory, 'app-auth'); mkdirSync(appAuth, { mode: 0o700 });
    ok(await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(appAuth, 'private-key.pem'),
      '-out', join(appAuth, 'certificate.crt'), '-days', '1', '-subj', '/CN=synthetic-app-auth.invalid']));
    chmodSync(join(appAuth, 'private-key.pem'), 0o600); chmodSync(join(appAuth, 'certificate.crt'), 0o600);
    secrets.push(readFileSync(join(appAuth, 'private-key.pem'), 'utf8'));
    const certEnv = { TEAMS_CREDENTIAL_MODE: 'certificate', TEAMS_CERTIFICATE_FILE: '/credentials/certificate.crt',
      TEAMS_PRIVATE_KEY_FILE: '/credentials/private-key.pem' };
    const { TEAMS_CLIENT_SECRET: _setupSecret, ...setupWithoutSecret } = setupEnv;
    const certSetupEnv = { ...setupWithoutSecret, ...certEnv };
    const certSetupArgs = [...security, ...mount(appAuth, '/credentials'), ...mount(setupDirectory, '/capture', false),
      ...Object.keys(certSetupEnv).flatMap((key) => ['-e', key]), '--entrypoint', 'node', image, '/app/dist/setup/main.js'];
    const certificateSetup = await run(['run', '--rm', '--network', 'none', ...certSetupArgs], certSetupEnv);
    assert.equal(certificateSetup.code, 1); assert.equal(certificateSetup.stdout.length, 0);
    assert.equal(certificateSetup.stderr === 'teams-setup: listening\nteams-setup: failed\n', true);
    assert.deepEqual(readdirSync(setupDirectory), ['challenge']); assert.deepEqual(readdirSync(data), []);
    const mixedSetup = await run(['run', '--rm', '--network', 'none', '-e', 'TEAMS_CLIENT_SECRET', ...certSetupArgs],
      { ...certSetupEnv, TEAMS_CLIENT_SECRET: '' });
    assert.equal(mixedSetup.code, 1); assert.equal(mixedSetup.stderr === 'teams-setup: failed\n', true);
    const { TEAMS_CLIENT_SECRET: _runtimeSecret, ...runtimeWithoutSecret } = env;
    const certRuntimeEnv = { ...runtimeWithoutSecret, ...certEnv };
    const certRuntimeArgs = [...security, ...mount(appAuth, '/credentials'), ...storage(),
      ...Object.keys(certRuntimeEnv).flatMap((key) => ['-e', key]), image];
    chmodSync(join(appAuth, 'private-key.pem'), 0o644);
    const invalidCertificateSetup = await run(['run', '--rm', '--network', 'none', ...certSetupArgs], certSetupEnv);
    assert.equal(invalidCertificateSetup.code, 1); assert.equal(invalidCertificateSetup.stderr === 'teams-setup: failed\n', true);
    const invalidCertificateRuntime = await run(['run', '--rm', '--network', 'none', ...certRuntimeArgs], certRuntimeEnv);
    assert.equal(invalidCertificateRuntime.code, 1); assert.equal(invalidCertificateRuntime.stderr.includes('listening'), false);
    assert.deepEqual(readdirSync(setupDirectory), ['challenge']); assert.deepEqual(readdirSync(data), []);
    chmodSync(join(appAuth, 'private-key.pem'), 0o600);
    console.log('PASS actual certificate setup, UID1000 private read-only pair, no-network expiry, mixed/invalid credential refusal before artifacts/stores');

    stage = 'compiled managed-identity setup without credential mount or token acquisition';
    const miEnv = { IDENTITY_HEADER: 'synthetic-unused-aci-header', TEAMS_CREDENTIAL_MODE: 'managed-identity-federation',
      TEAMS_MANAGED_IDENTITY_CLIENT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const miSetupEnv = { ...setupWithoutSecret, ...miEnv };
    const miSetupArgs = [...security, ...mount(setupDirectory, '/capture', false),
      ...Object.keys(miSetupEnv).flatMap((key) => ['-e', key]), '--entrypoint', 'node', image, '/app/dist/setup/main.js'];
    const miSetup = await run(['run', '--rm', '--network', 'none', ...miSetupArgs], miSetupEnv);
    assert.equal(miSetup.code, 1); assert.equal(miSetup.stdout.length, 0);
    assert.equal(miSetup.stderr === 'teams-setup: listening\nteams-setup: failed\n', true);
    const miRuntimeEnv = { ...runtimeWithoutSecret, ...miEnv };
    const miRuntimeArgs = [...security, ...storage(), ...Object.keys(miRuntimeEnv).flatMap((key) => ['-e', key]), image];
    for (const extra of [{ TEAMS_CLIENT_SECRET: '' }, { TEAMS_CERTIFICATE_FILE: '' }, { IDENTITY_ENDPOINT: '' },
      { TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID: '' }]) {
      const extraArgs = Object.keys(extra).flatMap((key) => ['-e', key]);
      const invalidSetup = await run(['run', '--rm', '--network', 'none', ...extraArgs, ...miSetupArgs], { ...miSetupEnv, ...extra });
      assert.equal(invalidSetup.code, 1); assert.equal(invalidSetup.stderr === 'teams-setup: failed\n', true);
      const invalidRuntime = await run(['run', '--rm', '--network', 'none', ...extraArgs, ...miRuntimeArgs], { ...miRuntimeEnv, ...extra });
      assert.equal(invalidRuntime.code, 1); assert.equal(invalidRuntime.stderr.includes('configuration-failed'), true);
      assert.deepEqual(readdirSync(setupDirectory), ['challenge']); assert.deepEqual(readdirSync(data), []);
    }
    console.log('PASS actual managed-identity setup without network/credential mounts, mixed/invalid mode refusal before artifacts/stores');

    stage = 'explicit image initialization and refused reinitialization';
    for (const mode of ['init', 'init-delivery']) {
      const args = ['run', '--rm', '--network', 'none', ...security, ...storage(), ...initKeys.flatMap((key) => ['-e', key]), image, mode];
      ok(await run(args, env)); assert.equal((await run(args, env)).code, 1);
    }
    const storageFiles = ['ingress.sqlite', 'delivery.sqlite', 'delivery.sqlite.owner.sqlite'];
    const modes = () => { for (const name of storageFiles) assert.equal(statSync(join(data, name)).mode & 0o777, 0o600); };
    modes();
    stage = 'stopped-owner public journal API receipt seed';
    ok(await run(['run', '--rm', '--network', 'none', ...security, ...storage(), ...helper(), '--entrypoint', 'node', image, '/fixture/container-smoke.mjs', 'fixture-seed']));

    stage = 'isolated pod-like network and pinned TLS proxy';
    ok(await run(['network', 'create', '--internal', owned])); network = true;
    const anchor = `${owned}-network`; const app = `${owned}-app`; const proxy = `${owned}-proxy`;
    stage = 'isolated network anchor startup';
    await start(anchor, ['--network', owned, ...security, ...helper(),
      '--entrypoint', 'node', image, '/fixture/container-smoke.mjs', 'fixture-network']);
    const podNetwork = ['--network', `container:${anchor}`];
    // Local Docker host reaches the internal bridge directly; no published ports
    // or default-route egress are needed for this synthetic fixture.
    stage = 'isolated network local bridge address';
    smokeHost = ok(await run(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', anchor]));
    assert.equal(isIP(smokeHost), 4);
    stage = 'actual setup entrypoint auth refusal, no V1 or outbound listener';
    const captureDirectory = join(directory, 'capture-network'); mkdirSync(captureDirectory, { mode: 0o700 });
    const freshChallenge = 'orka-setup:' + randomBytes(16).toString('hex'); secrets.push(freshChallenge);
    writeFileSync(join(captureDirectory, 'challenge'), freshChallenge, { mode: 0o600, flag: 'wx' });
    const captureName = `${owned}-setup`;
    await start(captureName, [...podNetwork, ...security, ...mount(captureDirectory, '/capture', false),
      ...Object.keys(setupEnv).flatMap((key) => ['-e', key]), '--entrypoint', 'node', image, '/app/dist/setup/main.js'],
    { ...setupEnv, SETUP_TIMEOUT_MS: '5000' });
    const captureDeadline = performance.now() + 4000;
    while (await plaintextStatus(3978) !== 404) { assert.equal(performance.now() < captureDeadline, true); await sleep(50); }
    assert.equal(await plaintextStatus(3979), 0);
    const denied = await fetch(`http://${smokeHost}:3978/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'message', text: freshChallenge, serviceUrl: 'https://teams.example.invalid/' }) });
    assert.equal(denied.status, 401); assert.deepEqual(await denied.json(), { error: 'Request rejected' });
    assert.equal(ok(await run(['wait', captureName])), '1');
    const captureLogs = await run(['logs', captureName]); ok(captureLogs);
    assert.equal(captureLogs.stdout.length, 0); assert.equal(captureLogs.stderr === 'teams-setup: listening\nteams-setup: failed\n', true);
    assert.deepEqual(readdirSync(captureDirectory), ['challenge']);
    console.log('PASS actual setup image auth denial, no candidate/V1/outbound listener, private challenge absent from logs');

    const publicPort = 8443; const privatePort = 8444;
    const appArgs = [...podNetwork, ...security, ...storage(), ...caMount(), ...credentials, image];
    stage = 'real image default serve startup';
    await start(app, appArgs, env);
    stage = 'pinned NGINX static configuration syntax';
    const syntax = await run(['run', '--rm', '--network', 'none', ...security, ...mount(tls, '/etc/adapter-tls'),
      ...mount(join(root, 'deploy/nginx.conf'), '/etc/nginx/nginx.conf'), '--entrypoint', 'nginx', nginxImage, '-t', '-c', '/etc/nginx/nginx.conf']);
    ok(syntax);
    stage = 'pinned NGINX startup and nonroot identity';
    await start(proxy, [...podNetwork, ...security, ...mount(tls, '/etc/adapter-tls'),
      ...mount(join(root, 'deploy/nginx.conf'), '/etc/nginx/nginx.conf'), '--entrypoint', 'nginx', nginxImage,
      '-c', '/etc/nginx/nginx.conf', '-g', 'daemon off;']);
    assert.equal(ok(await run(['exec', proxy, 'id', '-u'])), '101'); assert.equal(ok(await run(['exec', proxy, 'id', '-g'])), '101');
    const auth = { Authorization: `Bearer ${env.ORKA_OUTBOUND_BEARER_TOKEN}` };
    stage = 'TLS health preserves the existing 8192-character bearer contract';
    const deadline = performance.now() + 15000;
    while ((await https(ca, privatePort, '/v1/health', { headers: auth })).status !== 200) {
      assert.equal(performance.now() < deadline, true); await sleep(100);
    }
    stage = 'actual Node PID1 argv and no plaintext/raw-port exposure';
    const argv = await run(['exec', app, 'cat', '/proc/1/cmdline']); ok(argv);
    assert.equal(argv.stdout === 'node\0/app/dist/ingress/main.js\0serve\0', true);
    for (const port of [publicPort, privatePort]) assert.equal(await plaintextStatus(port), 400);
    for (const port of [3978, 3979]) assert.equal(await plaintextStatus(port), 0);
    stage = 'silent compiled image probe through TLS';
    const probe = await run(['exec', app, 'node', '/app/dist/deployment/probe.js']); ok(probe);
    assert.equal((probe.stdout + probe.stderr).length, 0);
    const wrongProbe = await run(['exec', '-e', 'ORKA_OUTBOUND_BEARER_TOKEN', app, 'node', '/app/dist/deployment/probe.js'],
      { ORKA_OUTBOUND_BEARER_TOKEN: secrets[1] });
    assert.equal(wrongProbe.code, 1); assert.equal((wrongProbe.stdout + wrongProbe.stderr).length, 0);
    console.log('PASS pinned NGINX UID/GID 101, static trusted TLS, compiled exit-code-only readiness');

    stage = 'private native auth, unknown routes, public exposure and header limits';
    for (const path of ['/v1/health', '/v1/capabilities', '/unknown']) {
      for (const token of [undefined, secrets[0], secrets[1], randomUUID()]) {
        assert.equal((await https(ca, privatePort, path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).status, 401);
      }
      assert.equal((await https(ca, privatePort, path, { headers: auth })).status, path === '/unknown' ? 404 : 200);
      const duplicate = await https(ca, privatePort, path, { headers: { Authorization: [auth.Authorization, auth.Authorization] } });
      assert.equal([400, 401].includes(duplicate.status), true);
      assert.equal((await https(ca, publicPort, path, { headers: auth })).status, 404);
    }
    for (const path of ['/', '/api/messages/']) assert.equal((await https(ca, publicPort, path)).status, 404);
    assert.equal((await https(ca, publicPort, '/api/messages')).status, 404);
    assert.equal((await https(ca, publicPort, '/api/messages', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await https(ca, privatePort, '/v1/health', { headers: { ...auth, 'X-Large': 'x'.repeat(20000) } })).status, 400);

    stage = 'body limits and real application absolute slow-body deadline';
    for (const [port, path] of [[publicPort, '/api/messages'], [privatePort, '/v1/deliveries']] as const) {
      const headers = { ...auth, 'Content-Type': 'application/json' };
      assert.equal((await https(ca, port, path, { method: 'POST', headers, body: 'x'.repeat(256 * 1024 + 1) })).status, 413);
      assert.equal((await https(ca, port, path, { method: 'POST', headers, body: '{}' + ' '.repeat(256 * 1024 - 2) })).status,
        port === publicPort ? 401 : 400);
    }
    const started = performance.now();
    const slow = await https(ca, privatePort, '/v1/deliveries', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': 100000 }, slow: true });
    assert.equal([408, 502].includes(slow.status), true);
    assert.equal(performance.now() - started >= 9000 && performance.now() - started < 12000, true);
    console.log('PASS real adapter auth separation/duplicates/unknown paths, public V1 denial, bounded headers/body and absolute slow-body abort');

    stage = 'exclusive live owner and saved receipt replay';
    assert.equal((await run(['run', '--rm', ...appArgs], env)).code, 1);
    const replay = async () => {
      const response = await https(ca, privatePort, '/v1/deliveries', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(delivery) });
      assert.equal(response.status, 200);
      const body = JSON.parse(response.body) as { status?: string; providerMessageId?: string };
      assert.equal(body.status === 'delivered' && body.providerMessageId === receipt, true);
    };
    await replay(); await stop(app); modes();
    stage = 'missing permanent owner refuses image startup';
    const missingOwner = `${owned}-missing-owner`; containers.push(missingOwner);
    await checkMissingOwner(data, missingOwner, () => run(['run', '--name', missingOwner, ...appArgs], env), (args) => run(args));
    stage = 'receipt and 0600 persistence across restart/remount';
    const restarted = `${owned}-restarted`; await start(restarted, appArgs, env);
    const restartDeadline = performance.now() + 15000;
    while ((await https(ca, privatePort, '/v1/health', { headers: auth })).status !== 200) {
      assert.equal(performance.now() < restartDeadline, true); await sleep(100);
    }
    await replay(); await stop(restarted); modes();
    console.log('PASS explicit init/refused reinit, stopped-only public API seed, exclusive/missing owner refusal, durable receipt and 0600 remount');

    stage = 'actual default serve entrypoint with certificate mode and no token effect on receipt replay';
    const certApp = `${owned}-certificate`; await start(certApp, [...podNetwork, ...certRuntimeArgs], certRuntimeEnv);
    const certDeadline = performance.now() + 15000;
    while ((await https(ca, privatePort, '/v1/health', { headers: auth })).status !== 200) {
      assert.equal(performance.now() < certDeadline, true); await sleep(100);
    }
    await replay(); await stop(certApp); modes();
    console.log('PASS actual certificate normal entrypoint/readiness, separate mounted credentials/stores, preserved durable receipt without token request');

    stage = 'actual managed-identity normal entrypoint/readiness and receipt replay without acquisition';
    const miApp = `${owned}-managed-identity`; await start(miApp, [...podNetwork, ...miRuntimeArgs], miRuntimeEnv);
    const miDeadline = performance.now() + 15000;
    while ((await https(ca, privatePort, '/v1/health', { headers: auth })).status !== 200) {
      assert.equal(performance.now() < miDeadline, true); await sleep(100);
    }
    await replay(); await stop(miApp); modes();
    console.log('PASS actual managed-identity normal entrypoint/readiness and durable receipt replay; no live Azure qualification');

    stage = 'proxy transport fixture startup';
    const upstream = `${owned}-upstream`;
    await start(upstream, [...podNetwork, ...security, ...helper(), '--entrypoint', 'node', image, '/fixture/container-smoke.mjs', 'fixture-upstream']);
    const upstreamDeadline = performance.now() + 10000;
    while ((await https(ca, privatePort, '/count')).status !== 200) {
      assert.equal(performance.now() < upstreamDeadline, true); await sleep(100);
    }
    stage = 'unchanged private URI/auth and no redirect rewriting';
    const path = `/echo?synthetic=${secrets[3]}`;
    const echoed = await https(ca, privatePort, path, { headers: auth });
    assert.equal(echoed.isJSON && echoed.noSniff, true);
    const echo = JSON.parse(echoed.body) as { path: string; authorizationMatches: boolean; connection: string; version: string };
    assert.equal(echo.path === path && echo.authorizationMatches, true);
    assert.equal(echo.connection, 'close'); assert.equal(echo.version, '1.1');
    const redirect = await https(ca, privatePort, '/redirect'); assert.equal(redirect.status, 302);
    assert.equal(redirect.location, 'http://127.0.0.1:3979/unchanged');
    stage = 'no request/response buffering or transparent upstream retry';
    const streaming = await https(ca, privatePort, '/stream-response'); assert.equal(streaming.body, 'firstlast'); assert.equal(streaming.firstByteMs < 1500, true);
    assert.equal(streaming.isPlainText && streaming.noSniff, true);
    const partial = await https(ca, privatePort, '/stream-request', { method: 'POST', headers: { 'Content-Length': 100000 }, partial: true });
    assert.equal(partial.status, 200); assert.equal(partial.firstByteMs < 1500, true);
    assert.equal((await https(ca, privatePort, `/fail?synthetic=${secrets[3]}`, { method: 'POST', headers: auth, body: secrets[3]! })).status, 502);
    assert.equal((JSON.parse((await https(ca, privatePort, '/count')).body) as { calls: number }).calls, 1);
    stage = 'request-bearing access/error output suppression'; await logsSafe();
    console.log('PASS real proxy unchanged URI/auth, HTTP/1.1 close, redirect preservation, streaming, one upstream attempt and zero proxy logs');
  } finally {
    let cleaned = true;
    for (const name of containers.reverse()) if ((await docker(['rm', '-f', name])).code !== 0) cleaned = false;
    if (network && (await docker(['network', 'rm', owned])).code !== 0) cleaned = false;
    const heldOwner = existsSync(join(data, 'owner.held'));
    if (cleaned && !heldOwner) rmSync(directory, { recursive: true, force: true });
    else {
      stage = heldOwner ? 'held owner and private fixtures retained: termination was not confirmed' : 'owned fixture cleanup incomplete';
      throw new Error('Cleanup failed');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2];
    if (mode?.startsWith('fixture-')) await fixture(mode);
    else { assert.equal(mode, undefined); await smoke(); }
  } catch {
    // Never print Error objects, child stderr, HTTP payloads, settings, keys or assertions' actual/expected values.
    console.error(`Container smoke failed at: ${stage}`); process.exitCode = 1;
  }
}
