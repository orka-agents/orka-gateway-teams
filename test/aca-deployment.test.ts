import assert from 'node:assert/strict';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';
import { parseRuntimeConfig } from '../src/ingress/runtime-config.js';
import { parseSetupConfig } from '../src/setup/config.js';

const assets = new URL('../deploy/aca/', import.meta.url);
const renderer = new URL('render.mjs', assets);
const guid = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const resourceGroup = `/subscriptions/${guid}/resourceGroups/synthetic`;
const identity = `${resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/synthetic`;
const common = { location: 'westus3', environmentId: `${resourceGroup}/providers/Microsoft.App/managedEnvironments/synthetic` };
const main = { ...common, registryServer: 'synthetic.azurecr.io', identityResourceId: identity,
  operatorAksEgressCidr: '192.0.2.1/32', bot: { appId: guid, tenantId: guid, clientId, principalId: guid } };
const image = `synthetic.azurecr.io/gateway@sha256:${'a'.repeat(64)}`;
const profiles = {
  setup: { ...main, image, timeoutMs: 900000 },
  proxy: { ...common },
  runtime: { ...main, image, table: { account: 'synthetic', name: 'Gateway', ingressStoreId: 'synthetic-inbox',
    deliveryStoreId: 'synthetic-delivery', identityResourceId: identity, clientId,
    audit: { maxPages: 100, maxBytes: 1048576, maxDurationMs: 30000, maxTrackingBytes: 1048576, maxIndexBytes: 1048576 } },
    orka: { baseUrl: 'https://orka.invalid/install/', gatewayNamespace: 'synthetic', gatewayName: 'teams' },
    approvedRecipientId: '28:synthetic', approvedServiceUrl: 'https://smba.trafficmanager.net/teams/' },
};

function run(stage: string, profile: object, check: (directory: string, result: ReturnType<typeof spawnSync>) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'aca-render-'));
  try {
    const config = join(directory, 'config.json');
    writeFileSync(config, JSON.stringify(profile), { mode: 0o600 });
    const result = spawnSync(process.execPath, [fileURLToPath(renderer), '--stage', stage, '--config', config, '--out', directory],
      { encoding: 'utf8', env: { PATH: '' } });
    check(directory, result);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function rendered(directory: string, stage: string) {
  const path = join(directory, `${stage}-app.arm.json`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  return JSON.parse(readFileSync(path, 'utf8'));
}
function mainIngress(app: any) {
  const config = app.properties.configuration;
  assert.equal(config.activeRevisionsMode, 'Single');
  assert.deepEqual(app.properties.template.scale, { minReplicas: 1, maxReplicas: 1, rules: [] });
  assert.deepEqual(config.ingress, { external: true, targetPort: 3979, transport: 'http', allowInsecure: false,
    ipSecurityRestrictions: [{ name: 'approved-orka-egress', action: 'Allow', ipAddressRange: '192.0.2.1/32' }],
    additionalPortMappings: [{ external: false, targetPort: 3978, exposedPort: 3978 }] });
}

test('ACA setup renders only bot capture env and all three private HTTP probes without runtime inputs', () => {
  run('setup', profiles.setup, (directory, result) => {
    assert.equal(result.status, 0, 'offline setup rendering failed');
    assert.equal(result.stdout?.length, 0); assert.equal(result.stderr?.length, 0);
    const document = rendered(directory, 'setup'); const app = document.resources[0]; mainIngress(app);
    assert.equal(app.name, 'orka-teams-gateway');
    const container = app.properties.template.containers[0];
    assert.deepEqual(container.env.map((entry: any) => entry.name).sort(), ['SETUP_TIMEOUT_MS', 'TEAMS_APP_ID',
      'TEAMS_CREDENTIAL_MODE', 'TEAMS_MANAGED_IDENTITY_CLIENT_ID', 'TEAMS_MANAGED_IDENTITY_HOST',
      'TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID', 'TEAMS_TENANT_ID']);
    assert.deepEqual(container.command, ['node', '/app/aca-setup-supervisor.mjs']);
    assert.deepEqual(container.probes.map((p: any) => p.type), ['Startup', 'Readiness', 'Liveness']);
    for (const probe of container.probes) assert.deepEqual(probe.httpGet, { path: '/healthz', port: 3980, scheme: 'HTTP' });
    assert.equal(app.properties.template.volumes, undefined); assert.equal(document.parameters, undefined);
  });
});

test('ACA proxy renders public-only Secret config for the chosen gateway without identity or registry credentials', () => {
  run('proxy', { ...profiles.proxy, gatewayAppName: 'chosen-gateway' }, (directory, result) => {
    assert.equal(result.status, 0, 'offline proxy rendering failed');
    const app = rendered(directory, 'proxy').resources[0]; const config = app.properties.configuration;
    assert.deepEqual(app.identity, { type: 'None' }); assert.equal(config.registries, undefined);
    assert.equal(config.identitySettings, undefined);
    assert.deepEqual(config.ingress, { external: true, targetPort: 8080, transport: 'http', allowInsecure: false });
    assert.equal(config.secrets.length, 1);
    const nginx = config.secrets[0].value;
    assert.equal(nginx.includes('proxy_pass http://chosen-gateway:3978;'), true);
    assert.equal(nginx.includes('orka-teams-gateway:3978'), false);
    for (const directive of ['if ($request_uri != /api/messages) { return 404; }',
      'if ($request_method != POST) { return 404; }', 'if ($request !~ "^POST /api/messages HTTP/1[.][01]$") { return 404; }',
      'proxy_request_buffering off;', 'proxy_buffering off;', 'proxy_next_upstream off;',
      'proxy_set_header Host $http_host;', 'proxy_set_header Connection $http_connection;', 'access_log off;', 'error_log /dev/null emerg;']) {
      assert.equal(nginx.includes(directive), true);
    }
    assert.equal(/alias |root |autoindex|candidate|challenge/u.test(nginx), false);
    const container = app.properties.template.containers[0];
    assert.equal(container.image, 'nginxinc/nginx-unprivileged:stable-alpine@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce');
    assert.deepEqual(container.command, ['nginx', '-c', '/etc/nginx/nginx.conf', '-g', 'daemon off;']);
    assert.deepEqual(app.properties.template.volumes, [{ name: 'nginx-config', storageType: 'Secret',
      secrets: [{ secretRef: 'nginx-config', path: 'nginx.conf' }] }]);
    assert.deepEqual(container.probes.map((p: any) => p.type), ['Startup', 'Readiness']);
    for (const probe of container.probes) assert.equal(probe.httpGet.port, 8081);
  });
});

test('ACA runtime emits secure directional parameter refs and literal singleton allowlists accepted by native Table config', () => {
  run('runtime', profiles.runtime, (directory, result) => {
    assert.equal(result.status, 0, 'offline runtime rendering failed');
    const document = rendered(directory, 'runtime'); const app = document.resources[0]; mainIngress(app);
    assert.deepEqual(document.parameters, { orkaBearerToken: { type: 'secureString' },
      orkaOutboundBearerToken: { type: 'secureString' }, orkaPublicCa: { type: 'string' } });
    assert.deepEqual(app.properties.configuration.secrets, [
      { name: 'orka-inbound', value: "[parameters('orkaBearerToken')]" },
      { name: 'orka-outbound', value: "[parameters('orkaOutboundBearerToken')]" },
      { name: 'orka-public-ca', value: "[parameters('orkaPublicCa')]" },
    ]);
    const container = app.properties.template.containers[0];
    assert.deepEqual(container.args, ['serve']);
    assert.deepEqual(container.probes.map((p: any) => [p.type, p.tcpSocket.port]), [['Startup', 3979], ['Readiness', 3979], ['Liveness', 3979]]);
    const environment: NodeJS.ProcessEnv = {};
    for (const entry of container.env) {
      if (entry.secretRef) {
        assert.equal(entry.value, undefined);
        assert.equal(entry.secretRef, entry.name === 'ORKA_BEARER_TOKEN' ? 'orka-inbound' : 'orka-outbound');
        environment[entry.name] = entry.name === 'ORKA_BEARER_TOKEN' ? 'synthetic-inbound' : 'synthetic-outbound';
      } else { environment[entry.name] = entry.value.startsWith('[[') ? entry.value.slice(1) : entry.value; }
    }
    assert.equal(container.env.find((e: any) => e.name === 'TEAMS_RECIPIENT_IDS').value.startsWith('[['), true);
    assert.equal(container.env.find((e: any) => e.name === 'TEAMS_SERVICE_URLS').value.startsWith('[['), true);
    const parsed = parseRuntimeConfig(environment, 'serve');
    assert.equal('storage' in parsed && parsed.storage.backend === 'table-v2', true);
    assert.equal(environment.TABLE_MANAGED_IDENTITY_HOST, 'azure-container-apps');
    assert.equal(environment.TEAMS_MANAGED_IDENTITY_HOST, 'azure-container-apps');
    assert.equal(parsed.receiver.recipientIds.length, 1); assert.equal(parsed.receiver.serviceUrls.length, 1);
    assert.equal(parsed.caFile, '/run/orka-ca/ca.crt');
    assert.deepEqual(app.properties.template.volumes, [{ name: 'orka-ca', storageType: 'Secret',
      secrets: [{ secretRef: 'orka-public-ca', path: 'ca.crt' }] }]);
  });
});

test('documented delivery initialization keeps common Orka scope without ingress audit settings', () => {
  const environment = { GATEWAY_STORAGE_BACKEND: 'table-v2', TABLE_ACCOUNT: 'synthetic', TABLE_NAME: 'Gateway',
    TABLE_DELIVERY_STORE_ID: 'synthetic-delivery', TABLE_MANAGED_IDENTITY_HOST: 'azure-container-apps',
    TABLE_MANAGED_IDENTITY_CLIENT_ID: clientId, TEAMS_APP_ID: guid, TEAMS_TENANT_ID: guid,
    ORKA_BASE_URL: 'https://orka.invalid/install/', ORKA_GATEWAY_NAMESPACE: 'synthetic', ORKA_GATEWAY_NAME: 'teams' };
  const result = parseRuntimeConfig(environment, 'init-delivery');
  assert.equal('kind' in result && result.kind === 'delivery', true);
  for (const key of ['ORKA_BASE_URL', 'ORKA_GATEWAY_NAMESPACE', 'ORKA_GATEWAY_NAME']) {
    const missing: NodeJS.ProcessEnv = { ...environment }; delete missing[key];
    assert.throws(() => parseRuntimeConfig(missing, 'init-delivery'));
  }
});

test('ACA renderer refuses invalid operator boundaries before output, with fixed diagnostics only', () => {
  for (const [stage, config] of [
    ['setup', { ...profiles.setup, image: 'synthetic.azurecr.io/gateway:latest' }],
    ['proxy', { ...profiles.proxy, gatewayAppName: 'bad; injected' }],
    ['setup', { ...profiles.setup, operatorAksEgressCidr: 'not-a-cidr' }],
    ['setup', { ...profiles.setup, bot: { ...profiles.setup.bot, clientId: guid } }],
    ['runtime', { ...profiles.runtime, approvedRecipientId: undefined }],
    ['runtime', { ...profiles.runtime, approvedServiceUrl: 'https://user:private@service.invalid/' }],
    ['runtime', { ...profiles.runtime, bearerToken: 'PRIVATE-INPUT-SENTINEL' }],
    ['init', profiles.setup],
  ] as const) {
    run(stage, config, (directory, result) => {
      assert.equal(result.status, 1); assert.equal(result.stdout?.length, 0);
      assert.equal(result.stderr === 'aca-render: invalid-input\n', true);
      assert.deepEqual(readdirSync(directory), ['config.json']);
    });
  }
  const missingOut = spawnSync(process.execPath, [fileURLToPath(renderer), '--stage', 'setup', '--config', 'unused'], { encoding: 'utf8' });
  assert.equal(missingOut.status, 1); assert.equal(missingOut.stderr === 'aca-render: invalid-input\n', true);
});

// Port of the operator's offline supervisor suite; variable URL avoids a new .mjs declaration/dependency.
const supervisorUrl = new URL('aca-setup-supervisor.mjs', assets).href;
const { paths, preparePrivateCapture, setupEnvironment, superviseSetup, openSupervisorHealth } = await import(supervisorUrl);
const base = { TEAMS_CREDENTIAL_MODE: 'managed-identity-federation', TEAMS_MANAGED_IDENTITY_HOST: 'azure-container-apps' };
test('fixed setup profile refuses Table/normal settings and conflicting paths', () => {
  const environment = setupEnvironment(base);
  assert.equal(environment.SETUP_CHALLENGE_FILE, paths.challenge); assert.equal(environment.SETUP_CAPTURE_FILE, paths.candidate);
  assert.equal(environment.SETUP_HOST, '0.0.0.0'); assert.equal(environment.SETUP_PORT, '3978');
  for (const key of ['TABLE_ACCOUNT', 'GATEWAY_STORAGE_BACKEND', 'ORKA_BASE_URL', 'INGRESS_DB', 'OUTBOUND_ENABLED',
    'DELIVERY_DB', 'TEAMS_RECIPIENT_IDS', 'TEAMS_SERVICE_URLS', 'NODE_OPTIONS', 'SETUP_CAPTURE_FILE', 'SETUP_HOST', 'SETUP_PORT']) {
    assert.throws(() => setupEnvironment({ ...base, [key]: '' }), { message: 'Setup supervisor failed' });
  }
  assert.throws(() => setupEnvironment({}), { message: 'Setup supervisor failed' });
  assert.equal(setupEnvironment({ ...base, SETUP_TIMEOUT_MS: '1000' }).SETUP_TIMEOUT_MS, '1000');
  run('setup', profiles.setup, (directory, result) => {
    assert.equal(result.status, 0);
    const variables = Object.fromEntries(rendered(directory, 'setup').resources[0].properties.template.containers[0].env
      .map((entry: any) => [entry.name, entry.value]));
    assert.equal(parseSetupConfig(setupEnvironment(variables)).port, 3978);
  });
});

function memoryFiles({ uid = 1000, gid = 1000, privateMode = 0o700, tmpMode = 0o1777, tmpUid = 0, symlink = false, exists = false } = {}) {
  const calls: unknown[][] = []; let stored = '';
  return { calls, stored: () => stored, io: {
    lstatSync: (path: string) => ({ uid: path === '/' ? 0 : path === '/tmp' ? tmpUid : uid,
      gid: path === paths.directory ? gid : 0,
      mode: path === '/' ? 0o755 : path === '/tmp' ? tmpMode : privateMode,
      isDirectory: () => !symlink }),
    mkdirSync: (path: string, options: unknown) => { calls.push(['mkdir', path, options]); if (exists) throw new Error('Fixture filesystem refusal'); },
    writeFileSync: (path: string, bytes: string, options: unknown) => { calls.push(['write', path, options]); stored = bytes; },
  } };
}
test('private preparation uses native format, exclusive 0600 file and fresh 0700 directory, entirely in memory', () => {
  const fixture = memoryFiles(); let entropyCalls = 0;
  preparePrivateCapture(fixture.io, (size: number) => { entropyCalls++; assert.equal(size, 16); return Buffer.alloc(16, 0xab); }, 1000, 1000);
  assert.deepEqual(fixture.calls, [['mkdir', paths.directory, { mode: 0o700 }], ['write', paths.challenge, { mode: 0o600, flag: 'wx' }]]);
  assert.equal(/^orka-setup:[0-9a-f]{32}$/u.test(fixture.stored()), true);
  assert.equal(Buffer.byteLength(fixture.stored()), 43); assert.equal(entropyCalls, 1);
});
for (const scenario of [{ uid: 0 }, { gid: 0 }, { privateMode: 0o750 }, { tmpMode: 0o777 }, { tmpUid: 101 }, { symlink: true }, { exists: true }]) {
  test('unsafe/reused private storage fails before entropy or file writes: ' + JSON.stringify(scenario), () => {
    const fixture = memoryFiles(scenario); let entropyCalls = 0;
    assert.throws(() => preparePrivateCapture(fixture.io, () => { entropyCalls++; return Buffer.alloc(16); }, 1000, 1000));
    assert.equal(entropyCalls, 0); assert.equal(fixture.calls.some(([operation]) => operation === 'write'), false);
  });
}
test('runtime UID/GID must be 1000 without repairing permissions', () => {
  const fixture = memoryFiles();
  for (const [uid, gid] of [[0, 1000], [1000, 0], [101, 101]]) assert.throws(() => preparePrivateCapture(fixture.io, () => Buffer.alloc(16), uid, gid));
  assert.equal(fixture.calls.length, 0);
});

async function owned({ prepare = async (): Promise<unknown> => ({}), kill, statusFails = false }:
  { prepare?: () => Promise<unknown>; kill?: (signal?: NodeJS.Signals | number) => boolean; statusFails?: boolean } = {}) {
  const child = new ChildProcess(); const signals = new EventEmitter(); const states: string[] = []; const forwarded: unknown[] = [];
  let healthClosed = false; let finished = false; let launches = 0;
  child.kill = (signal) => { forwarded.push(signal); return kill ? kill(signal) : true; };
  const done: Promise<number> = superviseSetup({ prepare, launch: () => { launches++; return child; }, signals,
    health: async () => ({ close: async () => { healthClosed = true; } }),
    status: (state: string) => { states.push(state); if (statusFails) throw new Error('Synthetic private error'); },
  }).then((code: number) => { finished = true; return code; });
  await tick();
  return { child, signals, states, forwarded, done, finished: () => finished, healthClosed: () => healthClosed, launches: () => launches };
}
for (const code of [0, 1]) {
  test('child close ' + code + ' retains health/artifacts until explicit termination', async () => {
    const fixture = await owned();
    fixture.child.emit('exit', code, null); await tick();
    assert.equal(fixture.states.some((state) => state.startsWith('child-closed')), false);
    fixture.child.emit('close', code, null); await tick();
    assert.equal(fixture.states.includes(code === 0 ? 'child-closed-ok' : 'child-closed-failed'), true);
    assert.equal(fixture.finished(), false); assert.equal(fixture.healthClosed(), false);
    fixture.signals.emit('SIGTERM'); assert.equal(await fixture.done, code);
    assert.equal(fixture.healthClosed(), true); assert.deepEqual(fixture.forwarded, []);
  });
}
test('synthetic private artifact is retrievable after child close while supervisor remains held', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aca-retention-')); const file = join(directory, 'synthetic-evidence');
  const fixture = await owned({ prepare: async () => {
    writeFileSync(file, 'synthetic evidence only', { mode: 0o600, flag: 'wx' }); return {};
  } });
  try {
    fixture.child.emit('close', 0, null); await tick();
    assert.equal(fixture.finished(), false); assert.equal(fixture.healthClosed(), false);
    const stamp = statSync(file);
    assert.equal(stamp.isFile() && stamp.uid === process.getuid?.() && (stamp.mode & 0o7777) === 0o600 && stamp.nlink === 1, true);
    assert.equal(readFileSync(file, 'utf8') === 'synthetic evidence only', true);
    fixture.signals.emit('SIGTERM'); assert.equal(await fixture.done, 0);
  } finally { fixture.signals.emit('SIGTERM'); await fixture.done; rmSync(directory, { recursive: true, force: true }); }
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  test(signal + ' forwards to the child; exit/error cannot fake close', async () => {
    const fixture = await owned(); fixture.signals.emit(signal); fixture.child.emit('error', new Error('Synthetic private error'));
    fixture.child.emit('exit', 0, null); await sleep(25);
    assert.equal(fixture.finished(), false); assert.equal(fixture.healthClosed(), false);
    assert.deepEqual(fixture.forwarded, [signal]);
    fixture.child.emit('close', 0, null); assert.equal(await fixture.done, 1);
    assert.equal(fixture.states.includes('child-closed-ok'), false);
  });
}
for (const kill of [() => false, () => { throw new Error('Synthetic private error'); }]) {
  test('failed signaling does not invent child drain or success', async () => {
    const fixture = await owned({ kill }); fixture.signals.emit('SIGTERM'); await tick();
    assert.equal(fixture.finished(), false); fixture.child.emit('close', 0, null); assert.equal(await fixture.done, 1);
  });
}
test('status I/O failure still forwards termination and awaits child close', async () => {
  const fixture = await owned({ statusFails: true }); fixture.signals.emit('SIGTERM'); await tick();
  assert.equal(fixture.finished(), false); fixture.child.emit('close', 0, null); assert.equal(await fixture.done, 1);
});
test('startup failure is retained without launching a child or automatic retry', async () => {
  const fixture = await owned({ prepare: async () => { throw new Error('Synthetic private error'); } });
  assert.equal(fixture.launches(), 0); assert.equal(fixture.finished(), false);
  assert.equal(fixture.states.includes('supervisor-failed'), true);
  fixture.signals.emit('SIGTERM'); assert.equal(await fixture.done, 1);
});
test('health bind failure exits failed before preparation instead of leaving an unreferenced hold', async () => {
  const signals = new EventEmitter(); let work = 0; const states: string[] = [];
  const code = await superviseSetup({ signals, prepare: async () => { work++; }, launch: () => { work++; },
    health: async () => { throw new Error('Synthetic bind failure'); }, status: (state: string) => states.push(state) });
  assert.equal(code, 1); assert.equal(work, 0); assert.deepEqual(states, ['supervisor-failed']);
  assert.equal(signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT'), 0);
});
test('termination during asynchronous preparation prevents a late child launch', async () => {
  let release!: (value: unknown) => void;
  const ready = new Promise((resolveReady) => { release = resolveReady; });
  const fixture = await owned({ prepare: () => ready }); fixture.signals.emit('SIGTERM'); release({});
  assert.equal(await fixture.done, 1); assert.equal(fixture.launches(), 0);
});
test('actual local child receives SIGTERM and is awaited through its delayed real close', async () => {
  const signals = new EventEmitter(); let closed = false;
  let readyResolve!: (value: unknown) => void; let readyReject!: (error: Error) => void;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const done = superviseSetup({ signals, prepare: async () => ({}), status: () => {},
    health: async () => ({ close: async () => {} }), launch: () => {
      const child = spawn(process.execPath, ['-e', `
        const hold = setInterval(() => {}, 1000);
        process.once('SIGTERM', () => setTimeout(() => { clearInterval(hold); process.disconnect(); }, 80));
        process.send('ready');
      `], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', readyResolve); child.once('error', readyReject);
      child.once('close', () => { closed = true; }); return child;
    } });
  await ready;
  const start = performance.now(); signals.emit('SIGTERM');
  assert.equal(await done, 0); assert.equal(closed, true); assert.equal(performance.now() - start >= 60, true);
});
test('private health reveals only supervisor aliveness, never artifacts or native auth readiness', async () => {
  const health = await openSupervisorHealth(0, '127.0.0.1');
  try {
    for (const [method, path, expected] of [['GET', '/healthz', 200], ['POST', '/healthz', 404],
      ['GET', '/healthz?x', 404], ['GET', '/challenge', 404], ['GET', '/candidate.json', 404], ['GET', '/v1/health', 404]] as const) {
      const response = await new Promise<{ status: number | undefined; body: string }>((resolveResponse, reject) => {
        const req = request({ host: '127.0.0.1', port: health.port, method, path, agent: false }, (res) => {
          let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolveResponse({ status: res.statusCode, body }));
        }); req.on('error', reject); req.end();
      });
      assert.equal(response.status, expected); assert.equal(response.body, expected === 200 ? 'supervisor-alive\n' : '');
    }
  } finally { await health.close(); }
});

test('derivative setup image remains non-root with public readable code and no forced process exit', () => {
  const dockerfile = readFileSync(new URL('Dockerfile.setup', assets), 'utf8');
  assert.equal(dockerfile.includes('ARG GATEWAY_IMAGE\nFROM ${GATEWAY_IMAGE}'), true);
  assert.equal(dockerfile.includes('RUN chmod 0755 /app'), true);
  assert.equal(dockerfile.includes('COPY --chown=0:0 --chmod=0644 aca-setup-supervisor.mjs /app/aca-setup-supervisor.mjs'), true);
  assert.equal(dockerfile.includes('USER 1000:1000'), true);
  assert.equal(dockerfile.includes('ENTRYPOINT ["node", "/app/aca-setup-supervisor.mjs"]\nCMD []'), true);
  const supervisor = readFileSync(new URL(supervisorUrl), 'utf8');
  assert.equal(supervisor.includes("stdio: 'ignore'"), true);
  assert.equal(/Promise\.race|process\.exit\(|SIGKILL/u.test(supervisor), false);
});
