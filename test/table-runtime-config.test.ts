import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationError, parseConfig } from '../src/ingress/config.js';
import { parseRuntimeConfig, snapshotTableInitConfig, snapshotTableServeConfig } from '../src/ingress/runtime-config.js';
import { receiverConfig, scope } from './support/ingress-auth.js';

function environment(): NodeJS.ProcessEnv {
  return { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId,
    ORKA_BASE_URL: scope.orkaBaseUrl, ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName,
    GATEWAY_STORAGE_BACKEND: 'table-v2', TABLE_ACCOUNT: 'Example123', TABLE_NAME: 'Journal',
    TABLE_INGRESS_STORE_ID: 'stable', TABLE_DELIVERY_STORE_ID: 'stable',
    TABLE_MANAGED_IDENTITY_HOST: 'imds', TABLE_MANAGED_IDENTITY_CLIENT_ID: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    TABLE_AUDIT_MAX_PAGES: '100', TABLE_AUDIT_MAX_BYTES: '10485760', TABLE_AUDIT_MAX_DURATION_MS: '30000',
    TABLE_AUDIT_MAX_TRACKING_BYTES: '1048576', TABLE_MAX_INDEX_BYTES: '16777216',
    TEAMS_CLIENT_SECRET: 'synthetic-bot-secret', TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds),
    TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls), ORKA_BEARER_TOKEN: 'synthetic-ingress-bearer',
    OUTBOUND_ENABLED: 'true', ORKA_OUTBOUND_BEARER_TOKEN: 'synthetic-outbound-bearer' };
}
const tableKeys = ['TABLE_ACCOUNT', 'TABLE_NAME', 'TABLE_INGRESS_STORE_ID', 'TABLE_DELIVERY_STORE_ID',
  'TABLE_MANAGED_IDENTITY_HOST', 'TABLE_MANAGED_IDENTITY_CLIENT_ID', 'TABLE_AUDIT_MAX_PAGES', 'TABLE_AUDIT_MAX_BYTES',
  'TABLE_AUDIT_MAX_DURATION_MS', 'TABLE_AUDIT_MAX_TRACKING_BYTES', 'TABLE_MAX_INDEX_BYTES'];

for (const selector of [undefined, 'sqlite']) test(`SQLite ${selector ?? 'default'} parser shape and defaults are unchanged`, () => {
  const env = environment(); for (const key of tableKeys) delete env[key];
  env.GATEWAY_STORAGE_BACKEND = selector; env.INGRESS_DB = '/tmp/table-runtime-inbox.sqlite'; env.DELIVERY_DB = '/tmp/table-runtime-delivery.sqlite';
  for (const mode of ['init', 'init-delivery'] as const) assert.deepEqual(parseRuntimeConfig(env, mode), parseConfig(env, mode));
  const result = parseRuntimeConfig(env, 'serve'); assert.deepEqual(result, parseConfig(env, 'serve'));
  assert.equal('storage' in result, false); assert.equal(result.receiver.port, 3978); assert.equal(result.outbound?.port, 3979);
});

test('Table selection has full scope, explicit identities and budgets but no SQLite paths', () => {
  const result = parseRuntimeConfig(environment(), 'serve'); assert.ok('storage' in result);
  assert.equal(result.storage.backend, 'table-v2'); assert.equal('dbPath' in result, false); assert.equal('dbPath' in result.outbound!, false);
  assert.deepEqual(result.scope, scope); assert.deepEqual(result.storage, {
    backend: 'table-v2', account: 'example123', table: 'journal', ingressStoreId: 'stable', deliveryStoreId: 'stable',
    identity: { host: 'imds', clientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    audit: { maxPages: 100, maxPageBytes: 10485760, maxDurationMs: 30000, maxTrackingBytes: 1048576 }, maxIndexBytes: 16777216,
  });
  assert.equal(result.receiver.port, 3978); assert.equal(result.outbound?.port, 3979);
});

for (const mode of ['init', 'init-delivery'] as const) test(`${mode} needs only the selected partition and no bot or directional credentials`, () => {
  const env = environment();
  for (const key of ['TEAMS_CLIENT_SECRET', 'TEAMS_RECIPIENT_IDS', 'TEAMS_SERVICE_URLS', 'ORKA_BEARER_TOKEN', 'ORKA_OUTBOUND_BEARER_TOKEN']) delete env[key];
  const unused = mode === 'init' ? ['TABLE_DELIVERY_STORE_ID'] : ['TABLE_INGRESS_STORE_ID', ...tableKeys.filter(k => k.startsWith('TABLE_AUDIT_') || k === 'TABLE_MAX_INDEX_BYTES')];
  for (const key of unused) env[key] = 'unused-invalid';
  const result = parseRuntimeConfig(env, mode); assert.ok('storage' in result);
  assert.deepEqual(result.scope, scope); assert.equal(result.kind, mode === 'init' ? 'ingress' : 'delivery');
  assert.equal(result.storage.storeId, 'stable'); assert.equal('receiver' in result, false); assert.equal('outbound' in result, false);
  assert.equal('audit' in result, mode === 'init'); assert.equal('maxIndexBytes' in result, mode === 'init');
  for (const key of unused) delete env[key];
  assert.deepEqual(parseRuntimeConfig(env, mode), result);
});

for (const key of ['TABLE_ACCOUNT', 'TABLE_NAME', 'TABLE_INGRESS_STORE_ID', 'TABLE_DELIVERY_STORE_ID',
  'TABLE_MANAGED_IDENTITY_HOST', 'TABLE_MANAGED_IDENTITY_CLIENT_ID', 'TABLE_AUDIT_MAX_PAGES', 'TABLE_AUDIT_MAX_BYTES',
  'TABLE_AUDIT_MAX_DURATION_MS', 'TABLE_AUDIT_MAX_TRACKING_BYTES', 'TABLE_MAX_INDEX_BYTES', 'TEAMS_APP_ID', 'TEAMS_TENANT_ID',
  'ORKA_BASE_URL', 'ORKA_GATEWAY_NAMESPACE', 'ORKA_GATEWAY_NAME', 'ORKA_BEARER_TOKEN', 'ORKA_OUTBOUND_BEARER_TOKEN']) {
  test(`Table serve refuses missing ${key} without defaults or inherited identities`, () => {
    const env = environment(); delete env[key]; assert.throws(() => parseRuntimeConfig(env, 'serve'), ConfigurationError);
  });
}
for (const selector of ['', 'table', 'azure-table', 'SQLITE']) test('unsupported backend selectors fail rather than selecting SQLite', () => {
  const env = { ...environment(), GATEWAY_STORAGE_BACKEND: selector };
  assert.throws(() => parseRuntimeConfig(env, 'serve'), ConfigurationError); assert.throws(() => parseConfig(env, 'serve'), ConfigurationError);
});
for (const key of tableKeys) test(`SQLite selection rejects stray ${key}, even empty`, () => {
  const env = environment(); for (const name of tableKeys) delete env[name];
  delete env.GATEWAY_STORAGE_BACKEND; env.INGRESS_DB = '/tmp/table-config.sqlite'; env[key] = '';
  for (const mode of ['init', 'init-delivery'] as const) {
    assert.throws(() => parseRuntimeConfig(env, mode), ConfigurationError); assert.throws(() => parseConfig(env, mode), ConfigurationError);
  }
  assert.throws(() => parseRuntimeConfig(env, 'serve'), ConfigurationError); assert.throws(() => parseConfig(env, 'serve'), ConfigurationError);
});
for (const key of ['INGRESS_DB', 'DELIVERY_DB']) test(`Table rejects contradictory ${key} on every command`, () => {
  const env = { ...environment(), [key]: '' };
  for (const mode of ['init', 'init-delivery'] as const) assert.throws(() => parseRuntimeConfig(env, mode), ConfigurationError);
  assert.throws(() => parseRuntimeConfig(env, 'serve'), ConfigurationError);
});

test('legacy parseConfig refuses explicit Table selection even with valid SQLite paths', () => {
  const env = { ...environment(), INGRESS_DB: '/tmp/table-runtime-inbox.sqlite', DELIVERY_DB: '/tmp/table-runtime-delivery.sqlite' };
  for (const mode of ['init', 'init-delivery'] as const) assert.throws(() => parseConfig(env, mode), ConfigurationError);
  assert.throws(() => parseConfig(env, 'serve'), ConfigurationError);
});
for (const [key, values] of Object.entries({ TABLE_ACCOUNT: ['', 'bad-account', 'ab'], TABLE_NAME: ['', '1bad', 'ab'], TABLE_INGRESS_STORE_ID: ['', ' x'],
  TABLE_MANAGED_IDENTITY_HOST: ['', 'unsupported'], TABLE_MANAGED_IDENTITY_CLIENT_ID: ['', 'not-a-guid'],
  TABLE_AUDIT_MAX_PAGES: ['0', '-1', '1.5', 'Infinity', '9007199254740992'], TABLE_AUDIT_MAX_BYTES: ['0', 'NaN'],
  TABLE_AUDIT_MAX_DURATION_MS: ['0', '2147483648'], TABLE_AUDIT_MAX_TRACKING_BYTES: ['0', '268435457'], TABLE_MAX_INDEX_BYTES: ['0', '1073741825'],
  OUTBOUND_ENABLED: ['', 'TRUE'], OUTBOUND_PORT: ['0', '3978'], ORKA_OUTBOUND_BEARER_TOKEN: ['synthetic-ingress-bearer', 'bad token'],
  INGRESS_MAX_PENDING: ['100001'], ORKA_CA_FILE: ['relative.pem'],
})) for (const value of values) test(`invalid ${key} is refused safely`, () => {
  assert.throws(() => parseRuntimeConfig({ ...environment(), [key]: value }, 'serve'), { message: 'Invalid ingress configuration' });
});

test('Table ingress-only preserves disabled outbound rules and omits delivery identity', () => {
  const env = environment(); for (const key of ['TABLE_DELIVERY_STORE_ID', 'ORKA_OUTBOUND_BEARER_TOKEN', 'OUTBOUND_ENABLED']) delete env[key];
  for (const flag of [undefined, 'false']) {
    env.OUTBOUND_ENABLED = flag; const result = parseRuntimeConfig(env, 'serve'); assert.ok('storage' in result);
    assert.equal('deliveryStoreId' in result.storage, false); assert.equal('outbound' in result, false);
    for (const [key, value] of Object.entries({ TABLE_DELIVERY_STORE_ID: 'stable', ORKA_OUTBOUND_BEARER_TOKEN: 'other', OUTBOUND_PORT: '4000', OUTBOUND_HOST: '127.0.0.1' })) {
      assert.throws(() => parseRuntimeConfig({ ...env, [key]: value }, 'serve'), ConfigurationError);
    }
  }
});

test('legacy parser keeps new selector getter failures private', () => {
  const env = environment();
  Object.defineProperty(env, 'GATEWAY_STORAGE_BACKEND', { get() { throw new Error('synthetic-private-selector'); } });
  let safe = false;
  try { parseConfig(env, 'serve'); } catch (error) { safe = error instanceof ConfigurationError && error.cause === undefined; }
  assert.equal(safe, true);
});

for (const mode of ['init', 'init-delivery'] as const) test(`direct ${mode} validates the same full scope as its environment parser`, () => {
  const value = parseRuntimeConfig(environment(), mode); assert.ok('storage' in value);
  for (const invalid of [{ appId: 'not-a-guid' }, { gatewayNamespace: '..' }, { gatewayName: '.' }]) {
    assert.throws(() => snapshotTableInitConfig({ ...value, scope: { ...value.scope, ...invalid } }), ConfigurationError);
  }
});

test('direct Table shape refuses SQLite paths, duplicate bindings, scope mismatch and accessor-backed storage identity', () => {
  const value = parseRuntimeConfig(environment(), 'serve'); assert.ok('storage' in value);
  for (const invalid of [
    { ...value, dbPath: '/tmp/unwanted.sqlite' },
    { ...value, outbound: { ...value.outbound!, dbPath: '/tmp/unwanted.sqlite' } },
    { ...value, storage: { ...value.storage, scope: value.scope } },
    { ...value, receiver: { ...value.receiver, appId: '99999999-9999-4999-8999-999999999999' } },
    { ...value, storage: { ...value.storage, deliveryStoreId: undefined } },
    { ...value, storage: { ...value.storage, audit: { ...value.storage.audit, maxDurationMs: 0 } } },
  ]) assert.throws(() => snapshotTableServeConfig(invalid as typeof value), ConfigurationError);
  let reads = 0;
  const identity = { clientId: value.storage.identity.clientId, get host() { reads++; return reads === 1 ? 'unsupported' : 'imds'; } };
  assert.throws(() => snapshotTableServeConfig({ ...value, storage: { ...value.storage, identity } } as typeof value), ConfigurationError);
  assert.equal(reads, 0, 'closed Table inputs reject accessors rather than falling back after a reread');
});

test('backend and storage host selectors are captured once, not reread into a different selection', () => {
  const env = environment(); let backends = 0; let hosts = 0;
  Object.defineProperty(env, 'GATEWAY_STORAGE_BACKEND', { get: () => (++backends === 1 ? 'table-v2' : 'sqlite') });
  Object.defineProperty(env, 'TABLE_MANAGED_IDENTITY_HOST', { get: () => (++hosts === 1 ? 'unsupported' : 'imds') });
  assert.throws(() => parseRuntimeConfig(env, 'serve'), ConfigurationError); assert.equal(backends, 1); assert.equal(hosts, 1);
});
