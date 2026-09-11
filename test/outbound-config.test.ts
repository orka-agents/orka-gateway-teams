import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigurationError, parseConfig } from '../src/ingress/config.js';
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

test('init-delivery requires only nonsecret scope and delivery path, not serve credentials or an inbox', () => {
  const env = environment();
  assert.deepEqual(parseConfig({ TEAMS_APP_ID: env.TEAMS_APP_ID, TEAMS_TENANT_ID: env.TEAMS_TENANT_ID,
    ORKA_BASE_URL: env.ORKA_BASE_URL, ORKA_GATEWAY_NAMESPACE: env.ORKA_GATEWAY_NAMESPACE, ORKA_GATEWAY_NAME: env.ORKA_GATEWAY_NAME,
    DELIVERY_DB: env.DELIVERY_DB }, 'init-delivery'), { dbPath: env.DELIVERY_DB, scope });
});
