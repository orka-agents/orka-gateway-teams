import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { parseConfig, validateReceiverConfig } from '../src/ingress/config.js';
import type { ReceiverConfig } from '../src/ingress/config.js';
import { parseSetupConfig, validateSetupConfig } from '../src/setup/config.js';
import { receiverConfig, scope } from './support/ingress-auth.js';

const pair = { credentialMode: 'certificate' as const, certificateFile: '/private/auth/cert.crt', privateKeyFile: '/private/auth/key.pem' };
const env = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, TEAMS_CREDENTIAL_MODE: 'certificate',
  TEAMS_CERTIFICATE_FILE: pair.certificateFile, TEAMS_PRIVATE_KEY_FILE: pair.privateKeyFile };
const runtime = { INGRESS_DB: '/tmp/certificate-config.sqlite', ORKA_BASE_URL: scope.orkaBaseUrl,
  ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName, ORKA_BEARER_TOKEN: 'synthetic',
  TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls) };
const setup = { SETUP_CHALLENGE_FILE: '/private/capture/challenge', SETUP_CAPTURE_FILE: '/private/capture/candidate.json' };
function direct(change: Record<string, unknown>): ReceiverConfig {
  const { clientSecret: _unused, ...receiver } = receiverConfig;
  return { ...receiver, ...pair, ...change } as ReceiverConfig;
}

test('explicit certificate mode parses structurally for both commands without reading absent files', () => {
  const receiver = parseConfig({ ...env, ...runtime }, 'serve').receiver;
  const capture = parseSetupConfig({ ...env, ...setup });
  for (const result of [receiver, capture]) {
    assert.equal(result.credentialMode, 'certificate'); assert.equal(result.certificateFile, pair.certificateFile);
    assert.equal(Object.hasOwn(result, 'clientSecret'), false); assert.equal(Object.isFrozen(result), true);
  }
});

test('legacy direct shape remains identical; explicit secret mode remains explicit', () => {
  assert.ok(isDeepStrictEqual(validateReceiverConfig(receiverConfig), receiverConfig));
  assert.ok(isDeepStrictEqual(validateReceiverConfig({ ...receiverConfig, credentialMode: 'client-secret' } as ReceiverConfig),
    { ...receiverConfig, credentialMode: 'client-secret' }));
});

for (const [name, change] of [
  ['unknown', { TEAMS_CREDENTIAL_MODE: 'managed-identity' }], ['empty mode', { TEAMS_CREDENTIAL_MODE: '' }],
  ['implicit pair', { TEAMS_CREDENTIAL_MODE: undefined }], ['secret with pair', { TEAMS_CLIENT_SECRET: 'synthetic' }],
  ['empty secret with pair', { TEAMS_CLIENT_SECRET: '' }], ['missing certificate', { TEAMS_CERTIFICATE_FILE: undefined }],
  ['missing key', { TEAMS_PRIVATE_KEY_FILE: undefined }], ['empty key', { TEAMS_PRIVATE_KEY_FILE: '' }],
  ['relative path', { TEAMS_PRIVATE_KEY_FILE: 'key.pem' }], ['normalized path', { TEAMS_PRIVATE_KEY_FILE: '/tmp/../key.pem' }],
  ['control path', { TEAMS_CERTIFICATE_FILE: '/tmp/a\n' }], ['invalid app', { TEAMS_APP_ID: 'bad' }],
  ['invalid tenant', { TEAMS_TENANT_ID: 'common' }], ['ambient secret', { CLIENT_SECRET: '' }],
  ['ambient MI', { MANAGED_IDENTITY_CLIENT_ID: 'system' }],
] as const) test(`both commands reject ${name}`, () => {
  assert.throws(() => parseConfig({ ...env, ...runtime, ...change }, 'serve'), { message: 'Invalid ingress configuration' });
  assert.throws(() => parseSetupConfig({ ...env, ...setup, ...change }), { message: 'Invalid setup configuration' });
});

test('direct callers revalidate conflicting fields and actual SDK ambient credentials', (t) => {
  for (const change of [{ clientSecret: '' }, { privateKeyFile: '' }, { certificateFile: '/tmp/\ud800' },
    { privateKeyFile: pair.certificateFile }, { managedIdentityClientId: 'system' }, { token: () => 'synthetic' }]) {
    assert.throws(() => validateReceiverConfig(direct(change)));
    assert.throws(() => validateSetupConfig({ ...direct(change), challengeFile: setup.SETUP_CHALLENGE_FILE,
      captureFile: setup.SETUP_CAPTURE_FILE, timeoutMs: 1000 }));
  }
  const before = process.env.CLIENT_SECRET;
  t.after(() => { if (before === undefined) delete process.env.CLIENT_SECRET; else process.env.CLIENT_SECRET = before; });
  process.env.CLIENT_SECRET = '';
  assert.throws(() => validateReceiverConfig(direct({})));
  // A configured legacy secret still has its original SDK precedence.
  assert.ok(isDeepStrictEqual(validateReceiverConfig(receiverConfig), receiverConfig));
});
