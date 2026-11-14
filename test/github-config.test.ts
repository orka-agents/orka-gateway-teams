import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseRegistryConfig, snapshotRegistry } from '../src/registry/config.js';
import { startRegistryRuntime } from '../src/registry/runtime.js';
import { registryFixture, registryInput } from './support/registry.js';
import { miConfig } from './support/managed-identity.js';
const github = { clientId: 'Iv1.synthetic', clientSecretFile: '/private/github-secret' };
function input() {
  const value = registryInput();
  for (const target of value.targets) { target.config.receiver = { ...miConfig }; Object.assign(target, { taskPassToken: `controller-${target.id}` }); }
  return { ...value, groupPolicyFile: '/private/policy', sso: { accountTable: 'Accounts', keyFile: '/private/account-key', apiUri: 'api://gateway', connectionName: 'workiq', publicOrigin: 'https://signin.example.invalid' }, github };
}
test('GitHub is optional, nonsecret, atomic and requires Microsoft browser sign-in', () => {
  assert.equal(snapshotRegistry(registryInput()).github, undefined);
  assert.deepEqual(snapshotRegistry(input()).github, github);
  for (const bad of [{ clientId: '' }, { clientId: 'bad space' }, { clientSecretFile: 'relative' }, { clientSecret: 'PRIVATE' }, { clientSecretFile: '/private/account-key' }])
    assert.throws(() => snapshotRegistry({ ...input(), github: { ...github, ...bad } } as never));
  assert.throws(() => snapshotRegistry({ ...input(), sso: undefined } as never));
  assert.throws(() => snapshotRegistry({ ...input(), sso: { ...input().sso, publicOrigin: undefined } } as never));
});
test('GitHub env settings preserve only file path/client ID; partial and raw-secret configuration fail closed', t => {
  const f = registryFixture(t);
  for (const target of f.manifest.targets) {
    const path = join(f.directory, `${target.id}-controller`); writeFileSync(path, `controller-${target.id}`, { mode: 0o600 }); Object.assign(target, { taskPassTokenFile: path });
  }
  f.save();
  const env = { ...f.env, TEAMS_CLIENT_SECRET: undefined, TEAMS_CREDENTIAL_MODE: miConfig.credentialMode,
    TEAMS_MANAGED_IDENTITY_CLIENT_ID: miConfig.managedIdentityClientId, TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID: miConfig.managedIdentityPrincipalId,
    SSO_ACCOUNT_TABLE: 'Accounts', SSO_KEY_FILE: '/private/key', SSO_API_URI: 'api://gateway', SSO_CONNECTION_NAME: 'workiq', SSO_PUBLIC_ORIGIN: 'https://signin.example.invalid',
    GITHUB_CLIENT_ID: github.clientId, GITHUB_CLIENT_SECRET_FILE: github.clientSecretFile };
  assert.deepEqual(parseRegistryConfig(env).github, github);
  for (const change of [{ GITHUB_CLIENT_ID: undefined }, { GITHUB_CLIENT_SECRET_FILE: undefined }, { GITHUB_CLIENT_SECRET: 'PRIVATE' }])
    assert.throws(() => parseRegistryConfig({ ...env, ...change }));
});
test('GitHub secret is checked before any ownership and cannot overlap directional/controller/encryption credentials', async t => {
  const f = registryFixture(t); const path = join(f.directory, 'github-secret'); const keyFile = join(f.directory, 'account-key');
  writeFileSync(keyFile, 'ab'.repeat(32), { mode: 0o600 }); let calls = 0;
  const config = { ...input(), sso: { ...input().sso, keyFile }, github: { ...github, clientSecretFile: path } };
  const deps = { tableRequest: (() => { calls++; throw new Error('No network'); }) as never };
  await assert.rejects(startRegistryRuntime(config, deps), { message: 'Invalid ingress configuration' }); assert.equal(calls, 0);
  for (const token of ['bad\nprivate', 'ingress-primary', 'callback-primary', 'controller-primary', 'ab'.repeat(32)]) {
    writeFileSync(path, token, { mode: 0o600 });
    await assert.rejects(startRegistryRuntime(config, deps)); assert.equal(calls, 0);
  }
  writeFileSync(path, 'synthetic-private'); chmodSync(path, 0o644);
  await assert.rejects(startRegistryRuntime(config, deps)); assert.equal(calls, 0);
});
