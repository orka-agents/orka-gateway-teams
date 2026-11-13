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
  for (const target of value.targets) target.config.receiver = { ...miConfig };
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
