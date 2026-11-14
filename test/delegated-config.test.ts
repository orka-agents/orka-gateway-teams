import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { snapshotRegistry, parseRegistryConfig } from '../src/registry/config.js';
import { startRegistryRuntime } from '../src/registry/runtime.js';
import { registryFixture, registryInput } from './support/registry.js';
import { miConfig } from './support/managed-identity.js';

const sso = { accountTable: 'Accounts', keyFile: '/private/account-key', apiUri: 'api://gateway', connectionName: 'workiq' };
function input() {
  const value = registryInput();
  for (const target of value.targets) { target.config.receiver = { ...miConfig }; Object.assign(target, { taskPassToken: `controller-${target.id}` }); }
  return { ...value, groupPolicyFile: '/private/policy', sso };
}
test('delegated registry config is atomic, opt-in, MI-only and account table is physically separate', t => {
  assert.equal(snapshotRegistry(registryInput()).sso, undefined);
  assert.deepEqual(snapshotRegistry(input()).sso, sso);
  for (const change of [{ accountTable: 'Directory' }, { accountTable: 'JOURNAL' }, { accountTable: 'ab' },
    { keyFile: 'relative' }, { apiUri: 'https://other.example/' }, { apiUri: 'api://gateway?token=bad' },
    { connectionName: '' }, { connectionName: 'bad space' }, { keyFile: undefined }]) {
    assert.throws(() => snapshotRegistry({ ...input(), sso: { ...sso, ...change } } as never));
  }
  assert.throws(() => snapshotRegistry({ ...registryInput(), sso }));
  const f = registryFixture(t);
  for (const key of ['SSO_ACCOUNT_TABLE', 'SSO_KEY_FILE', 'SSO_API_URI', 'SSO_CONNECTION_NAME']) {
    assert.throws(() => parseRegistryConfig({ ...f.env, [key]: 'partial' }));
  }
});
test('dedicated task-pass credentials cover every SSO target, use bearer grammar and never overlap directional credentials', () => {
  const valid = input(); assert.equal((snapshotRegistry(valid).targets[0] as any).taskPassToken, 'controller-primary');
  for (const bad of [undefined, '', 'spaces forbidden', 'bad\\\"quote', 'x'.repeat(4097), 'ingress-primary', 'callback-primary', 'ingress-tools', 'callback-tools', 'controller-tools']) {
    const value = input(); Object.assign(value.targets[0]!, { taskPassToken: bad }); assert.throws(() => snapshotRegistry(value));
  }
  const ordinary = registryInput(); Object.assign(ordinary.targets[0]!, { taskPassToken: 'controller-primary' }); assert.throws(() => snapshotRegistry(ordinary));
});
test('controller credential files are snapshotted privately once, before ownership; nonSSO and incomplete coverage refuse', t => {
  const f = registryFixture(t);
  for (const target of f.manifest.targets) {
    const path = join(f.directory, `${target.id}-controller`); writeFileSync(path, `controller-${target.id}\n`, { mode: 0o600 }); Object.assign(target, { taskPassTokenFile: path });
  }
  f.save();
  const env = { ...f.env, TEAMS_CLIENT_SECRET: undefined, TEAMS_CREDENTIAL_MODE: miConfig.credentialMode,
    TEAMS_MANAGED_IDENTITY_CLIENT_ID: miConfig.managedIdentityClientId, TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID: miConfig.managedIdentityPrincipalId,
    SSO_ACCOUNT_TABLE: 'Accounts', SSO_KEY_FILE: '/private/key', SSO_API_URI: 'api://gateway', SSO_CONNECTION_NAME: 'workiq' };
  const captured = parseRegistryConfig(env); assert.deepEqual(captured.targets.map(t => t.taskPassToken), ['controller-primary', 'controller-tools']);
  const path = join(f.directory, 'primary-controller'); writeFileSync(path, 'rotated'); assert.equal(snapshotRegistry(captured).targets[0]!.taskPassToken, 'controller-primary');
  chmodSync(path, 0o644); assert.throws(() => parseRegistryConfig(env)); chmodSync(path, 0o600);
  assert.throws(() => parseRegistryConfig(f.env));
  delete (f.manifest.targets[1] as any).taskPassTokenFile; f.save(); assert.throws(() => parseRegistryConfig(env));
});
test('browser origin is opt-in and permits only a canonical configured HTTPS destination', () => {
  const publicOrigin = 'https://signin.example.invalid';
  assert.equal(snapshotRegistry({ ...input(), sso: { ...sso, publicOrigin } }).sso?.publicOrigin, publicOrigin);
  for (const bad of ['http://signin.example.invalid', publicOrigin + '/', publicOrigin + '/other', publicOrigin + '?redirect=x',
    publicOrigin + '#fragment', 'https://user@signin.example.invalid', 'https://signin.example.invalid:444', 'https://SIGNIN.example.invalid',
    'https://signin.example.invalid:443', 'https://signin.example.invalid\\\\evil']) {
    assert.throws(() => snapshotRegistry({ ...input(), sso: { ...sso, publicOrigin: bad } }));
  }
});

test('private operator key is read/validated before any store ownership or network', async t => {
  const f = registryFixture(t); const path = join(f.directory, 'account-key'); let calls = 0;
  const config = { ...input(), sso: { ...sso, keyFile: path } };
  const deps = { tableRequest: (() => { calls++; throw new Error('No network'); }) as never };
  await assert.rejects(startRegistryRuntime(config, deps)); assert.equal(calls, 0);
  writeFileSync(path, 'not-a-key', { mode: 0o600 });
  await assert.rejects(startRegistryRuntime(config, deps)); assert.equal(calls, 0);
  writeFileSync(path, 'ab'.repeat(32)); chmodSync(path, 0o644);
  await assert.rejects(startRegistryRuntime(config, deps)); assert.equal(calls, 0);
});
