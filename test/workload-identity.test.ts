import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { PUBLIC } from '@microsoft/teams.api';
import { parseBotCredential, validateBotCredential } from '../src/auth/credentials.js';
import { prepareWorkloadIdentity } from '../src/auth/workload-identity.js';
import { parseConfig } from '../src/ingress/config.js';
import { parseSetupConfig } from '../src/setup/config.js';
import { entraEndpoint, entraNetwork } from './support/managed-identity.js';
import { syntheticAccessToken } from './support/certificate.js';
import { scope } from './support/ingress-auth.js';
import { workloadConfig, workloadFiles } from './support/workload-identity.js';

const failure = { message: 'Workload identity token unavailable' };
const env = { TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, TEAMS_CREDENTIAL_MODE: 'workload-identity',
  AZURE_FEDERATED_TOKEN_FILE: workloadConfig.workloadIdentityTokenFile, TEAMS_WORKLOAD_IDENTITY_ISSUER: workloadConfig.workloadIdentityIssuer,
  TEAMS_WORKLOAD_IDENTITY_SUBJECT: workloadConfig.workloadIdentitySubject };
const runtime = { INGRESS_DB: '/private/data/inbox.sqlite', ORKA_BASE_URL: scope.orkaBaseUrl,
  ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName, ORKA_BEARER_TOKEN: 'synthetic',
  TEAMS_RECIPIENT_IDS: JSON.stringify(workloadConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(workloadConfig.serviceUrls) };
const setup = { SETUP_CHALLENGE_FILE: '/private/capture/challenge', SETUP_CAPTURE_FILE: '/private/capture/candidate.json' };
function environment(t: TestContext, name: string, value: string) {
  const before = process.env[name]; process.env[name] = value;
  t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
}

test('explicit workload identity parses serve and setup with matching Azure webhook variables', () => {
  for (const result of [parseConfig({ ...env, ...runtime, AZURE_CLIENT_ID: scope.appId, AZURE_TENANT_ID: scope.tenantId,
    AZURE_AUTHORITY_HOST: 'https://login.microsoftonline.com/' }, 'serve').receiver, parseSetupConfig({ ...env, ...setup })]) {
    assert.equal(result.credentialMode, 'workload-identity'); assert.equal(Object.isFrozen(result), true);
    assert.equal(result.workloadIdentityIssuer, workloadConfig.workloadIdentityIssuer);
    assert.equal(result.workloadIdentitySubject, workloadConfig.workloadIdentitySubject);
    assert.equal(result.workloadIdentityTokenFile, workloadConfig.workloadIdentityTokenFile);
    assert.equal(Object.hasOwn(result, 'clientSecret'), false);
  }
});

for (const [name, change] of [
  ['implicit mode', { TEAMS_CREDENTIAL_MODE: undefined }], ['missing file', { AZURE_FEDERATED_TOKEN_FILE: undefined }],
  ['relative file', { AZURE_FEDERATED_TOKEN_FILE: 'token' }], ['noncanonical file', { AZURE_FEDERATED_TOKEN_FILE: '/private/../token' }],
  ['missing issuer', { TEAMS_WORKLOAD_IDENTITY_ISSUER: undefined }], ['non-AKS issuer', { TEAMS_WORKLOAD_IDENTITY_ISSUER: 'https://example.invalid/' }],
  ['other tenant issuer', { TEAMS_WORKLOAD_IDENTITY_ISSUER: workloadConfig.workloadIdentityIssuer.replace(scope.tenantId, scope.appId) }],
  ['issuer query', { TEAMS_WORKLOAD_IDENTITY_ISSUER: workloadConfig.workloadIdentityIssuer + '?x=1' }],
  ['missing subject', { TEAMS_WORKLOAD_IDENTITY_SUBJECT: undefined }], ['non-service-account subject', { TEAMS_WORKLOAD_IDENTITY_SUBJECT: scope.appId }],
  ['wildcard subject', { TEAMS_WORKLOAD_IDENTITY_SUBJECT: 'system:serviceaccount:orka-system:*' }],
  ['wrong webhook client', { AZURE_CLIENT_ID: scope.tenantId }], ['wrong webhook tenant', { AZURE_TENANT_ID: scope.appId }],
  ['other authority', { AZURE_AUTHORITY_HOST: 'https://example.invalid/' }],
  ...['TEAMS_CLIENT_SECRET', 'TEAMS_CERTIFICATE_FILE', 'TEAMS_PRIVATE_KEY_FILE', 'TEAMS_MANAGED_IDENTITY_CLIENT_ID',
    'TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID', 'TEAMS_MANAGED_IDENTITY_HOST', 'CLIENT_SECRET', 'MANAGED_IDENTITY_CLIENT_ID',
    'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET', 'AZURE_CLIENT_SECRET', 'AZURE_CLIENT_CERTIFICATE_PATH']
    .map((key) => [key, { [key]: '' }] as const),
] as const) test(`workload identity refuses ${name} in both commands`, () => {
  assert.throws(() => parseConfig({ ...env, ...runtime, ...change }, 'serve'), { message: 'Invalid ingress configuration' });
  assert.throws(() => parseSetupConfig({ ...env, ...setup, ...change }), { message: 'Invalid setup configuration' });
});

test('other modes refuse workload fields and direct callers cannot mix credentials', () => {
  for (const key of ['AZURE_FEDERATED_TOKEN_FILE', 'TEAMS_WORKLOAD_IDENTITY_ISSUER', 'TEAMS_WORKLOAD_IDENTITY_SUBJECT']) {
    assert.throws(() => parseBotCredential({ TEAMS_CLIENT_SECRET: 'synthetic', [key]: '' }));
  }
  for (const change of [{ clientSecret: 'synthetic' }, { token: () => 'synthetic' }, { clientCertificate: {} },
    { managedIdentityType: 'user' }, { managedIdentityClientId: scope.appId }, { workloadIdentityTokenFile: undefined }]) {
    assert.throws(() => validateBotCredential({ ...workloadConfig, ...change }));
  }
});

test('real CCA exchanges only for the configured bot and reloads atomic projections even on final-token cache hits', async (t) => {
  const files = workloadFiles(t); let exchanges = 0; let opens = 0;
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => { opens++; return open(...args); });
  const config = { ...files.config }; const prepared = prepareWorkloadIdentity(config);
  config.appId = scope.tenantId;
  assert.equal(JSON.stringify(prepared), '{}'); assert.equal(opens, 0);
  const token = prepared.createToken(entraNetwork(async (url, options) => {
    exchanges++; const body = new URLSearchParams(options?.body);
    assert.equal(url, entraEndpoint); assert.equal(body.get('client_id'), scope.appId);
    assert.equal(body.get('scope'), PUBLIC.botScope); assert.equal(body.get('grant_type'), 'client_credentials');
    assert.equal(body.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    assert.equal(body.get('client_assertion') === files.initial.token, true); assert.equal(body.has('client_secret'), false);
    return { status: 200, headers: {}, body: { access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 } };
  }));
  assert.equal(opens, 0);
  assert.equal(typeof await token(PUBLIC.botScope), 'string'); assert.equal(opens, 1);
  assert.equal(typeof await token([PUBLIC.botScope], scope.tenantId), 'string'); assert.equal(opens, 2); assert.equal(exchanges, 1);
  files.rotate({ sub: 'system:serviceaccount:other:identity' }); const before = opens;
  await assert.rejects(async () => token(PUBLIC.botScope), failure); assert.equal(opens, before + 1); assert.equal(exchanges, 1);
  files.rotate(); assert.equal(typeof await token(PUBLIC.botScope), 'string'); assert.equal(exchanges, 1);
  for (const [requestedScope, tenant] of [[PUBLIC.graphScope, undefined], [[PUBLIC.botScope, PUBLIC.botScope], undefined],
    [PUBLIC.botScope, 'common']] as [string | string[], string | undefined][]) {
    await assert.rejects(async () => token(requestedScope, tenant), failure);
  }
  assert.throws(() => prepared.createToken());
});

for (const [name, claims] of [
  ['wrong issuer', { iss: 'https://example.invalid/' }], ['wrong subject', { sub: 'system:serviceaccount:orka-system:other' }],
  ['missing issuer', { iss: undefined }], ['missing subject', { sub: undefined }],
  ['wrong audience', { aud: PUBLIC.botScope }], ['extra audience', { aud: ['api://AzureADTokenExchange', PUBLIC.botScope] }],
  ['missing audience', { aud: undefined }], ['expired assertion', { exp: 1 }], ['near expiry', { exp: Date.now() / 1000 + 5 }],
  ['string expiry', { exp: '9999999999' }], ['missing expiry', { exp: undefined }], ['nonfinite expiry', { exp: Infinity }],
  ['future not-before', { nbf: Date.now() / 1000 + 3600 }], ['string not-before', { nbf: '1' }],
] as const) test(`projected ${name} fails before Entra`, async (t) => {
  const files = workloadFiles(t); files.rotate(claims); let exchanges = 0;
  const token = prepareWorkloadIdentity(files.config).createToken(entraNetwork(async () => { exchanges++; throw new Error('No exchange'); }));
  await assert.rejects(async () => token(PUBLIC.botScope), failure); assert.equal(exchanges, 0);
});

for (const variant of ['public mode', 'writable directory', 'hard link', 'escaping symlink', 'directory', 'oversized', 'invalid JWT']) {
  test(`unsafe projected ${variant} is refused before Entra`, async (t) => {
    const files = workloadFiles(t); let exchanges = 0;
    if (variant === 'public mode') fs.chmodSync(files.initial.resolved, 0o644);
    if (variant === 'writable directory') fs.chmodSync(dirname(files.initial.resolved), 0o777);
    if (variant === 'hard link') fs.linkSync(files.initial.resolved, join(files.directory, 'extra'));
    if (variant === 'escaping symlink') {
      const other = workloadFiles(t); fs.unlinkSync(files.tokenFile); fs.symlinkSync(other.initial.resolved, files.tokenFile);
    }
    if (variant === 'directory') { fs.unlinkSync(files.tokenFile); fs.mkdirSync(files.tokenFile); }
    if (variant === 'oversized') fs.writeFileSync(files.initial.resolved, 'x'.repeat(8193));
    if (variant === 'invalid JWT') fs.writeFileSync(files.initial.resolved, 'synthetic-private-invalid-assertion');
    const token = prepareWorkloadIdentity(files.config).createToken(entraNetwork(async () => { exchanges++; throw new Error('No exchange'); }));
    await assert.rejects(async () => token(PUBLIC.botScope), failure); assert.equal(exchanges, 0);
  });
}

test('projection removed between resolve and open gets one bounded fresh resolution', async (t) => {
  const files = workloadFiles(t); const open = fs.openSync; let attempts = 0;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (++attempts === 1) throw Object.assign(new Error('synthetic rotation'), { code: 'ENOENT' });
    return open(...args);
  });
  const token = prepareWorkloadIdentity(files.config).createToken(entraNetwork());
  assert.equal(typeof await token(PUBLIC.botScope), 'string'); assert.equal(attempts, 2);
});

for (const [name, value] of [['CLIENT_SECRET', ''], ['AZURE_FEDERATED_TOKEN_FILE', '/private/other-token'],
  ['AZURE_CLIENT_ID', scope.tenantId], ['NODE_TLS_REJECT_UNAUTHORIZED', '0']] as const) {
  test(`ambient ${name} changes fail before cached acquisition`, async (t) => {
    const files = workloadFiles(t); let exchanges = 0;
    const token = prepareWorkloadIdentity(files.config).createToken(entraNetwork(async () => {
      exchanges++; return { status: 200, headers: {}, body: { access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 } };
    }));
    await token(PUBLIC.botScope); environment(t, name, value);
    await assert.rejects(async () => token(PUBLIC.botScope), failure); assert.equal(exchanges, 1);
  });
}
