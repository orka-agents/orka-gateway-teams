import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSetupConfig, validateSetupConfig } from '../src/setup/config.js';
import { setupEnv, setupFiles } from './support/setup.js';

test('setup parses only its credentials/private paths and bounded listener/window defaults', (t) => {
  const { config } = setupFiles(t); const parsed = parseSetupConfig(setupEnv(config));
  assert.equal(parsed.appId === config.appId && parsed.tenantId === config.tenantId && parsed.clientSecret === config.clientSecret, true);
  assert.equal(parsed.captureFile === config.captureFile && parsed.challengeFile === config.challengeFile, true);
  assert.equal(parsed.host, '127.0.0.1'); assert.equal(parsed.port, 3978); assert.equal(parsed.timeoutMs, 600000);
  assert.equal(validateSetupConfig({ ...config, timeoutMs: 1 }).timeoutMs, 1);
  assert.equal(parseSetupConfig({ ...setupEnv(config), SETUP_HOST: '::1', SETUP_PORT: '65535', SETUP_TIMEOUT_MS: '900000' }).port, 65535);
});

for (const key of ['TEAMS_APP_ID', 'TEAMS_TENANT_ID', 'TEAMS_CLIENT_SECRET', 'SETUP_CHALLENGE_FILE', 'SETUP_CAPTURE_FILE']) {
  test(`setup refuses missing ${key}`, (t) => {
    const env = setupEnv(setupFiles(t).config); delete env[key];
    assert.throws(() => parseSetupConfig(env), { message: 'Invalid setup configuration' });
  });
}
for (const [key, value] of [
  ['TEAMS_APP_ID', 'bad'], ['TEAMS_TENANT_ID', 'common'], ['TEAMS_CLIENT_SECRET', ' '],
  ['TEAMS_CLIENT_SECRET', 'a\nb'], ['TEAMS_CLIENT_SECRET', 'a'.repeat(8193)],
  ['SETUP_HOST', 'localhost'], ['SETUP_PORT', '0'], ['SETUP_PORT', '65536'], ['SETUP_PORT', '1.2'],
  ['SETUP_TIMEOUT_MS', '999'], ['SETUP_TIMEOUT_MS', '900001'], ['SETUP_TIMEOUT_MS', 'Infinity'],
  ['SETUP_CAPTURE_FILE', 'relative'], ['SETUP_CAPTURE_FILE', '/tmp/a\nb'], ['SETUP_CAPTURE_FILE', '/tmp/../a'],
  ['SETUP_CHALLENGE_FILE', '/tmp/a/'], ['SETUP_CHALLENGE_FILE', '/tmp/\ud800'], ['SETUP_CAPTURE_FILE', '/' + 'x'.repeat(4096)],
  ['ORKA_BASE_URL', ''], ['INGRESS_DB', ''], ['OUTBOUND_ENABLED', 'false'], ['DELIVERY_DB', ''],
  ['TEAMS_RECIPIENT_IDS', '[]'], ['TEAMS_SERVICE_URLS', '[]'], ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
] as const) {
  test(`setup rejects invalid/mixed environment ${key} variant ${value.length}`, (t) => {
    assert.throws(() => parseSetupConfig({ ...setupEnv(setupFiles(t).config), [key]: value }), { message: 'Invalid setup configuration' });
  });
}

test('setup never repairs trailing line terminators on credentials or numeric settings', (t) => {
  const { config } = setupFiles(t); const env = setupEnv(config);
  for (const ending of ['\n', '\r', '\r\n']) {
    for (const [key, value] of [['TEAMS_APP_ID', config.appId], ['TEAMS_TENANT_ID', config.tenantId], ['SETUP_PORT', '3978'], ['SETUP_TIMEOUT_MS', '1000']]) {
      assert.throws(() => parseSetupConfig({ ...env, [key!]: value + ending }), { message: 'Invalid setup configuration' });
    }
  }
});

test('library validates again, snapshots config, and refuses process-wide TLS bypass', (t) => {
  const { config } = setupFiles(t);
  for (const change of [{ port: -1 }, { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: 900001 }, { host: 'localhost' }, { appId: '' }]) {
    assert.throws(() => validateSetupConfig({ ...config, ...change }), { message: 'Invalid setup configuration' });
  }
  const copy = validateSetupConfig(config); config.port = 10; assert.equal(copy.port, 0); assert.equal(Object.isFrozen(copy), true);
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; assert.throws(() => validateSetupConfig(config), { message: 'Invalid setup configuration' }); }
  finally { if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before; }
});
