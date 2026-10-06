import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigurationError, parseConfig, parseCorrelationConfig, validateOutboundConfig } from '../src/ingress/config.js';
import { receiverConfig, scope } from './support/ingress-auth.js';

function environment() {
  return { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, TEAMS_CLIENT_SECRET: randomUUID(),
    TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls),
    INGRESS_DB: '/tmp/teams-config-ingress.sqlite', DELIVERY_DB: '/tmp/teams-config-delivery.sqlite', OUTBOUND_ENABLED: 'true',
    ORKA_BASE_URL: scope.orkaBaseUrl, ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName,
    ORKA_BEARER_TOKEN: randomUUID(), ORKA_OUTBOUND_BEARER_TOKEN: randomUUID() };
}

test('outbound is explicit, complete and independent; absent/false preserves ingress-only shape', () => {
  const env = environment(); const full = parseConfig(env, 'serve');
  assert.ok(full.outbound?.bearerToken === env.ORKA_OUTBOUND_BEARER_TOKEN);
  assert.equal(full.outbound?.dbPath, env.DELIVERY_DB); assert.equal(full.outbound?.host, '127.0.0.1'); assert.equal(full.outbound?.port, 3979);
  const only: NodeJS.ProcessEnv = { ...env }; delete only.DELIVERY_DB; delete only.ORKA_OUTBOUND_BEARER_TOKEN; delete only.OUTBOUND_ENABLED;
  assert.equal(Object.hasOwn(parseConfig(only, 'serve'), 'outbound'), false);
  assert.equal(Object.hasOwn(parseConfig({ ...only, OUTBOUND_ENABLED: 'false' }, 'serve'), 'outbound'), false);
  const custom = parseConfig({ ...env, OUTBOUND_HOST: '::1', OUTBOUND_PORT: '4567' }, 'serve');
  assert.equal(custom.outbound?.host, '::1'); assert.equal(custom.outbound?.port, 4567);
});

for (const override of [
  { OUTBOUND_ENABLED: undefined }, { OUTBOUND_ENABLED: 'false' }, { OUTBOUND_ENABLED: 'TRUE' }, { OUTBOUND_ENABLED: '' },
  { DELIVERY_DB: undefined }, { ORKA_OUTBOUND_BEARER_TOKEN: undefined }, { DELIVERY_DB: 'relative.sqlite' },
  { ORKA_OUTBOUND_BEARER_TOKEN: 'bad token' }, { ORKA_OUTBOUND_BEARER_TOKEN: '' }, { ORKA_OUTBOUND_BEARER_TOKEN: 'x'.repeat(8193) },
  { OUTBOUND_HOST: 'localhost' }, { OUTBOUND_PORT: '0' }, { OUTBOUND_PORT: '65536' }, { OUTBOUND_PORT: '1.5' },
  { OUTBOUND_PORT: '3978' }, { DELIVERY_DB: '/tmp/teams-config-ingress.sqlite' },
  { DELIVERY_DB: '/tmp/teams-config', INGRESS_DB: '/tmp/teams-config.owner.sqlite' },
]) test('partial, ambiguous or unsafe outbound configuration fails with a fixed error', () => {
  assert.throws(() => parseConfig({ ...environment(), ...override }, 'serve'), ConfigurationError);
});

test('crossed directional bearer credentials are refused', () => {
  const env = environment(); env.ORKA_OUTBOUND_BEARER_TOKEN = env.ORKA_BEARER_TOKEN;
  assert.throws(() => parseConfig(env, 'serve'), ConfigurationError);
});

test('distinct-storage preflight catches canonical parent aliases, final symlinks and hardlink aliases', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-config-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'actual')); symlinkSync(join(directory, 'actual'), join(directory, 'alias'));
  const file = join(directory, 'actual', 'store.sqlite'); writeFileSync(file, 'not a database', { mode: 0o600 });
  const alias = join(directory, 'linked.sqlite'); symlinkSync(file, alias);
  const hard = join(directory, 'hard.sqlite'); linkSync(file, hard);
  for (const delivery of [join(directory, 'alias', 'store.sqlite'), alias, hard]) {
    assert.throws(() => parseConfig({ ...environment(), INGRESS_DB: file, DELIVERY_DB: delivery }, 'serve'), ConfigurationError);
  }
});

test('both provisioning commands reject overlapping configured storage paths before creating files', () => {
  const env = environment();
  for (const mode of ['init', 'init-delivery'] as const) {
    assert.throws(() => parseConfig({ ...env, DELIVERY_DB: env.INGRESS_DB }, mode), ConfigurationError);
    assert.throws(() => parseConfig({ ...env, INGRESS_DB: `${env.DELIVERY_DB}.owner.sqlite` }, mode), ConfigurationError);
  }
});

test('optional correlation configuration is full SQLite only and aliases include every sidecar', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-correlation-config-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...environment(), INGRESS_DB: join(directory, 'inbox.sqlite'), DELIVERY_DB: join(directory, 'journal.sqlite') };
  const correlation = join(directory, 'correlation.sqlite');
  assert.equal(parseConfig({ ...env, CORRELATION_DB: correlation }, 'serve').outbound?.correlationDbPath, correlation);
  for (const path of [env.INGRESS_DB, env.DELIVERY_DB, `${env.DELIVERY_DB}.owner.sqlite`, `${env.INGRESS_DB}-wal`, `${env.DELIVERY_DB}-journal`, 'relative.sqlite']) {
    assert.throws(() => parseConfig({ ...env, CORRELATION_DB: path }, 'serve'), ConfigurationError);
  }
  const file = env.INGRESS_DB; writeFileSync(file, 'synthetic', { mode: 0o600 });
  for (const name of ['hard', 'symlink']) {
    const alias = join(directory, name); if (name === 'hard') linkSync(file, alias); else symlinkSync(file, alias);
    assert.throws(() => parseConfig({ ...env, CORRELATION_DB: alias }, 'serve'), ConfigurationError);
  }
  assert.throws(() => parseConfig({ ...env, OUTBOUND_ENABLED: 'false', CORRELATION_DB: correlation }, 'serve'), ConfigurationError);
});

test('optional correlation path snapshots an accessor-backed environment value exactly once', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-correlation-snapshot-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const correlation = join(directory, 'correlation.sqlite'); const changed = join(directory, 'changed.sqlite');
  for (const [initial, subsequent] of [[correlation, changed], [correlation, undefined], [undefined, changed]]) {
    let reads = 0;
    const env: NodeJS.ProcessEnv = { ...environment(), INGRESS_DB: join(directory, 'inbox.sqlite'), DELIVERY_DB: join(directory, 'journal.sqlite'),
      get CORRELATION_DB() { return ++reads === 1 ? initial : subsequent; } };
    assert.equal(parseConfig(env, 'serve').outbound?.correlationDbPath, initial);
    assert.equal(reads, 1);
  }
});

test('correlation provisioning checks all supplied optional storage footprints, including absent files', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-correlation-init-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ingress = join(directory, 'inbox.sqlite'); const delivery = join(directory, 'journal.sqlite'); const correlation = join(directory, 'correlation.sqlite');
  const base = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, CORRELATION_DB: correlation };
  const sidecars = ['', '-journal', '-wal', '-shm'];
  for (const optional of [{ INGRESS_DB: ingress }, { DELIVERY_DB: delivery }, { INGRESS_DB: ingress, DELIVERY_DB: delivery }]) {
    const mains = [...(optional.INGRESS_DB === undefined ? [] : [ingress]),
      ...(optional.DELIVERY_DB === undefined ? [] : [delivery, `${delivery}.owner.sqlite`])];
    for (const main of mains) for (const suffix of sidecars) {
      assert.throws(() => parseCorrelationConfig({ ...base, ...optional, CORRELATION_DB: `${main}${suffix}` }), ConfigurationError);
    }
  }
  for (const main of [correlation, `${correlation}.owner.sqlite`]) for (const suffix of sidecars) {
    for (const knob of ['INGRESS_DB', 'DELIVERY_DB']) {
      assert.throws(() => parseCorrelationConfig({ ...base, [knob]: `${main}${suffix}` }), ConfigurationError);
    }
  }
  assert.throws(() => parseCorrelationConfig({ ...base, INGRESS_DB: `${delivery}.owner.sqlite-shm`, DELIVERY_DB: delivery }), ConfigurationError);
});

test('correlation provisioning rejects canonical parent, final symlink and hardlink aliases by metadata', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-correlation-init-alias-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'actual')); symlinkSync(join(directory, 'actual'), join(directory, 'alias'));
  const ingress = join(directory, 'actual', 'inbox.sqlite'); const delivery = join(directory, 'actual', 'journal.sqlite');
  const base = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId };
  assert.throws(() => parseCorrelationConfig({ ...base, INGRESS_DB: ingress, CORRELATION_DB: join(directory, 'alias', 'inbox.sqlite-wal') }), ConfigurationError);
  for (const [knob, path] of [['INGRESS_DB', ingress], ['DELIVERY_DB', delivery]] as const) {
    for (const reserved of [path, `${path}-wal`, ...(knob === 'DELIVERY_DB' ? [`${path}.owner.sqlite-shm`] : [])]) {
      writeFileSync(reserved, 'synthetic reserved inode', { mode: 0o600 });
      for (const aliasKind of ['symlink', 'hardlink']) for (const suffix of ['', '.owner.sqlite-journal']) {
        const correlation = join(directory, `${knob}-${aliasKind}-${suffix || 'main'}.sqlite`);
        const alias = `${correlation}${suffix}`;
        if (aliasKind === 'symlink') symlinkSync(reserved, alias); else linkSync(reserved, alias);
        try { assert.throws(() => parseCorrelationConfig({ ...base, [knob]: path, CORRELATION_DB: correlation }), ConfigurationError); }
        finally { rmSync(alias); }
      }
    }
  }
});

test('correlation provisioning captures every supplied storage knob once, including optional absence', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-correlation-init-snapshot-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const correlation = join(directory, 'correlation.sqlite'); const ingress = join(directory, 'inbox.sqlite'); const delivery = join(directory, 'delivery.sqlite');
  for (const initial of [{ INGRESS_DB: ingress, DELIVERY_DB: undefined }, { INGRESS_DB: undefined, DELIVERY_DB: delivery },
    { INGRESS_DB: ingress, DELIVERY_DB: delivery }, { INGRESS_DB: undefined, DELIVERY_DB: undefined }]) {
    const reads = { CORRELATION_DB: 0, INGRESS_DB: 0, DELIVERY_DB: 0 };
    const env: NodeJS.ProcessEnv = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId,
      get CORRELATION_DB() { return ++reads.CORRELATION_DB === 1 ? correlation : undefined; },
      get INGRESS_DB() { return ++reads.INGRESS_DB === 1 ? initial.INGRESS_DB : correlation; },
      get DELIVERY_DB() { return ++reads.DELIVERY_DB === 1 ? initial.DELIVERY_DB : correlation; } };
    assert.deepEqual(parseCorrelationConfig(env), { dbPath: correlation, scope: { appId: scope.appId, tenantId: scope.tenantId } });
    assert.deepEqual(reads, { CORRELATION_DB: 1, INGRESS_DB: 1, DELIVERY_DB: 1 });
  }
});

test('correlation provisioning validates supplied optional paths without requiring them or Orka scope', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-correlation-init-paths-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const correlation = join(directory, 'correlation.sqlite');
  const env = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, CORRELATION_DB: correlation };
  assert.deepEqual(parseCorrelationConfig(env), { dbPath: correlation, scope: { appId: scope.appId, tenantId: scope.tenantId } });
  for (const knob of ['INGRESS_DB', 'DELIVERY_DB']) for (const path of ['', 'relative.sqlite', join(directory, 'missing-parent', 'store.sqlite')]) {
    assert.throws(() => parseCorrelationConfig({ ...env, [knob]: path }), ConfigurationError);
  }
});

test('optional correlation provisioning does not relax required ingress paths for outbound library validation', () => {
  const outbound = { dbPath: '/tmp/teams-config-delivery.sqlite', bearerToken: 'synthetic-outbound-token', host: '127.0.0.1', port: 3979 };
  assert.throws(() => validateOutboundConfig(outbound, undefined as unknown as string, 'synthetic-ingress-token', receiverConfig), ConfigurationError);
});

test('init-delivery requires only nonsecret scope and delivery path, not serve credentials or an inbox', () => {
  const env = environment();
  assert.deepEqual(parseConfig({ TEAMS_APP_ID: env.TEAMS_APP_ID, TEAMS_TENANT_ID: env.TEAMS_TENANT_ID,
    ORKA_BASE_URL: env.ORKA_BASE_URL, ORKA_GATEWAY_NAMESPACE: env.ORKA_GATEWAY_NAMESPACE, ORKA_GATEWAY_NAME: env.ORKA_GATEWAY_NAME,
    DELIVERY_DB: env.DELIVERY_DB }, 'init-delivery'), { dbPath: env.DELIVERY_DB, scope });
});
