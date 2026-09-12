import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { parseConfig, validateReceiverConfig } from '../src/ingress/config.js';
import type { ReceiverConfig } from '../src/ingress/config.js';
import { parseSetupConfig, validateSetupConfig } from '../src/setup/config.js';
import { receiverConfig, scope } from './support/ingress-auth.js';

const identity = { credentialMode: 'managed-identity-federation',
  managedIdentityClientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', managedIdentityPrincipalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } as const;
const env = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, TEAMS_CREDENTIAL_MODE: identity.credentialMode,
  TEAMS_MANAGED_IDENTITY_CLIENT_ID: identity.managedIdentityClientId, TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID: identity.managedIdentityPrincipalId };
const runtime = { INGRESS_DB: '/tmp/managed-identity-config.sqlite', ORKA_BASE_URL: scope.orkaBaseUrl,
  ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName, ORKA_BEARER_TOKEN: 'synthetic',
  TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls) };
const setup = { SETUP_CHALLENGE_FILE: '/private/capture/challenge', SETUP_CAPTURE_FILE: '/private/capture/candidate.json' };
function direct(change: Record<string, unknown> = {}): ReceiverConfig {
  const { clientSecret: _unused, ...receiver } = receiverConfig;
  return { ...receiver, ...identity, ...change } as unknown as ReceiverConfig;
}

test('explicit federation parses both commands structurally and freezes canonical MI identities without changing app/tenant', () => {
  for (const result of [parseConfig({ ...env, ...runtime, TEAMS_MANAGED_IDENTITY_CLIENT_ID: identity.managedIdentityClientId.toUpperCase() }, 'serve').receiver,
    parseSetupConfig({ ...env, ...setup, TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID: identity.managedIdentityPrincipalId.toUpperCase() }),
    validateReceiverConfig(direct()), validateSetupConfig({ ...direct(), challengeFile: setup.SETUP_CHALLENGE_FILE,
      captureFile: setup.SETUP_CAPTURE_FILE, timeoutMs: 1000 })]) {
    assert.equal(result.credentialMode, identity.credentialMode);
    assert.equal((result as unknown as typeof identity).managedIdentityClientId, identity.managedIdentityClientId);
    assert.equal((result as unknown as typeof identity).managedIdentityPrincipalId, identity.managedIdentityPrincipalId);
    assert.equal(result.appId, scope.appId); assert.equal(result.tenantId, scope.tenantId);
    assert.equal(Object.hasOwn(result, 'clientSecret'), false); assert.equal(Object.isFrozen(result), true);
  }
});

for (const [name, change] of [
  ['implicit', { TEAMS_CREDENTIAL_MODE: undefined }], ['unknown', { TEAMS_CREDENTIAL_MODE: 'managed-identity' }],
  ['empty mode', { TEAMS_CREDENTIAL_MODE: '' }], ['missing client', { TEAMS_MANAGED_IDENTITY_CLIENT_ID: undefined }],
  ['missing principal', { TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID: undefined }], ['empty client', { TEAMS_MANAGED_IDENTITY_CLIENT_ID: '' }],
  ['empty principal', { TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID: '' }], ['invalid client', { TEAMS_MANAGED_IDENTITY_CLIENT_ID: 'system' }],
  ['invalid principal', { TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID: 'principal' }], ['bot is MI', { TEAMS_APP_ID: identity.managedIdentityClientId.toUpperCase() }],
  ['secret', { TEAMS_CLIENT_SECRET: 'synthetic' }], ['empty secret', { TEAMS_CLIENT_SECRET: '' }],
  ['certificate', { TEAMS_CERTIFICATE_FILE: '/private/certificate.crt' }], ['empty certificate', { TEAMS_CERTIFICATE_FILE: '' }],
  ['key', { TEAMS_PRIVATE_KEY_FILE: '/private/key.pem' }], ['empty key', { TEAMS_PRIVATE_KEY_FILE: '' }],
  ...['CLIENT_SECRET', 'MANAGED_IDENTITY_CLIENT_ID', 'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET', 'AZURE_FEDERATED_TOKEN_FILE']
    .map((name) => [name, { [name]: '' }] as const),
] as const) test(`federation both commands reject ${name}`, () => {
  assert.throws(() => parseConfig({ ...env, ...runtime, ...change }, 'serve'), { message: 'Invalid ingress configuration' });
  assert.throws(() => parseSetupConfig({ ...env, ...setup, ...change }), { message: 'Invalid setup configuration' });
});

for (const mode of [undefined, 'client-secret', 'certificate']) for (const field of ['TEAMS_MANAGED_IDENTITY_CLIENT_ID', 'TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID']) {
  test(`non-MI ${mode ?? 'default'} refuses even empty ${field}`, () => {
    const legacy = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, TEAMS_CREDENTIAL_MODE: mode,
      ...(mode === 'certificate' ? { TEAMS_CERTIFICATE_FILE: '/private/cert.crt', TEAMS_PRIVATE_KEY_FILE: '/private/key.pem' } : { TEAMS_CLIENT_SECRET: 'synthetic' }), [field]: '' };
    assert.throws(() => parseConfig({ ...legacy, ...runtime }, 'serve'));
    assert.throws(() => parseSetupConfig({ ...legacy, ...setup }));
  });
}

test('direct MI callers reject mixed credentials and malformed identity pairs, without affecting legacy shape', () => {
  for (const change of [{ clientSecret: '' }, { certificateFile: '' }, { privateKeyFile: '' }, { token: () => 'synthetic' },
    { clientCertificate: {} }, { managedIdentityType: 'user' }, { managedIdentityClientId: undefined },
    { managedIdentityPrincipalId: undefined }, { managedIdentityPrincipalId: null }, { appId: identity.managedIdentityClientId.toUpperCase() }]) {
    assert.throws(() => validateReceiverConfig(direct(change)));
    assert.throws(() => validateSetupConfig({ ...direct(change), challengeFile: setup.SETUP_CHALLENGE_FILE,
      captureFile: setup.SETUP_CAPTURE_FILE, timeoutMs: 1000 }));
  }
  assert.ok(isDeepStrictEqual(validateReceiverConfig(receiverConfig), receiverConfig));
});

for (const name of ['CLIENT_SECRET', 'MANAGED_IDENTITY_CLIENT_ID', 'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET', 'AZURE_FEDERATED_TOKEN_FILE']) {
  test(`direct MI validates ambient ${name} without parser mutation`, (t) => {
    const before = process.env[name]; t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
    process.env[name] = '';
    assert.throws(() => validateReceiverConfig(direct()));
    assert.equal(process.env[name], '');
    assert.ok(isDeepStrictEqual(validateReceiverConfig(receiverConfig), receiverConfig));
  });
}
