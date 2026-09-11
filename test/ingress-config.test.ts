import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigurationError, parseConfig } from '../src/ingress/config.js';
import { receiverConfig, scope } from './support/ingress-auth.js';

export const environment = () => ({ TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId,
  TEAMS_CLIENT_SECRET: randomUUID(), TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds),
  TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls), INGRESS_DB: '/tmp/ingress-test.sqlite',
  ORKA_BASE_URL: scope.orkaBaseUrl, ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName,
  ORKA_BEARER_TOKEN: randomUUID() });

test('init needs only immutable nonsecret scope and serve validates explicit credentials and defaults', () => {
  const env = environment();
  const init = parseConfig({ TEAMS_APP_ID: env.TEAMS_APP_ID, TEAMS_TENANT_ID: env.TEAMS_TENANT_ID,
    ORKA_BASE_URL: 'https://ORKA.example.invalid', ORKA_GATEWAY_NAME: 'teams', ORKA_GATEWAY_NAMESPACE: 'default', INGRESS_DB: env.INGRESS_DB }, 'init');
  assert.deepEqual(init, { dbPath: env.INGRESS_DB, scope });
  const serve = parseConfig(env, 'serve');
  assert.equal(serve.receiver.host, '127.0.0.1'); assert.equal(serve.receiver.port, 3978);
  assert.ok(serve.receiver.clientSecret === env.TEAMS_CLIENT_SECRET);
  assert.deepEqual(serve.policy, { maxPending: 1000, maxRecords: 100000, replayWindowMs: 86400000 });
});

for (const field of Object.keys(environment())) {
  test(`serve refuses missing ${field} with fixed safe failure`, () => {
    const env: NodeJS.ProcessEnv = environment(); delete env[field];
    assert.throws(() => parseConfig(env, 'serve'), { name: 'Error', message: 'Invalid ingress configuration' });
  });
}

test('config rejects unsafe URLs, ambiguous identities, invalid lists, paths and out-of-bounds policy', () => {
  for (const override of [
    { ORKA_BASE_URL: 'http://example.invalid' }, { ORKA_BASE_URL: 'https://user:private@example.invalid/' },
    { ORKA_BASE_URL: 'https://example.invalid/?' }, { ORKA_BASE_URL: 'https://example.invalid/#' },
    { ORKA_BASE_URL: 'https://example.invalid/?token=private' }, { ORKA_BASE_URL: 'https://@example.invalid/' },
    { TEAMS_SERVICE_URLS: '["https://example.invalid:8443/"]' }, { TEAMS_SERVICE_URLS: '[]' },
    { TEAMS_RECIPIENT_IDS: '[" bot"]' }, { TEAMS_RECIPIENT_IDS: '[null]' }, { TEAMS_RECIPIENT_IDS: 'bot' },
    { TEAMS_APP_ID: 'not-a-guid' }, { TEAMS_TENANT_ID: 'common' }, { TEAMS_CLIENT_SECRET: '   ' },
    { INGRESS_DB: 'relative.sqlite' }, { ORKA_CA_FILE: 'relative.pem' },
    { ORKA_BEARER_TOKEN: 'private\nvalue' }, { ORKA_GATEWAY_NAME: '..' },
    { INGRESS_PORT: '0' }, { INGRESS_PORT: '65536' }, { INGRESS_HOST: 'http://localhost' },
    { INGRESS_MAX_PENDING: '100001' }, { INGRESS_MAX_RECORDS: '0' },
    { INGRESS_REPLAY_WINDOW_MS: '604800001' }, { INGRESS_REPLAY_WINDOW_MS: 'NaN' },
    { INGRESS_MAX_PENDING: '100', INGRESS_MAX_RECORDS: '99' },
  ]) assert.throws(() => parseConfig({ ...environment(), ...override }, 'serve'), ConfigurationError);
});

test('valid configured URLs normalize once, retain path case and gain required trailing slashes', () => {
  const config = parseConfig({ ...environment(), ORKA_BASE_URL: 'https://ORKA.example.invalid:8443/Base',
    TEAMS_SERVICE_URLS: '["https://SERVICE.example.invalid/Teams/Path"]', INGRESS_HOST: '::1', INGRESS_PORT: '4444',
    INGRESS_MAX_PENDING: '2', INGRESS_MAX_RECORDS: '3', INGRESS_REPLAY_WINDOW_MS: '10000' }, 'serve');
  assert.equal(config.scope.orkaBaseUrl, 'https://orka.example.invalid:8443/Base/');
  assert.deepEqual(config.receiver.serviceUrls, ['https://service.example.invalid/Teams/Path/']);
  assert.equal(config.receiver.host, '::1'); assert.equal(config.receiver.port, 4444);
  assert.deepEqual(config.policy, { maxPending: 2, maxRecords: 3, replayWindowMs: 10000 });
});
