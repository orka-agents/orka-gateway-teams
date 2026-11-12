import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigurationError } from '../src/ingress/config.js';
import { parseRegistryConfig, snapshotRegistry } from '../src/registry/config.js';
import { registryFixture, registryInput } from './support/registry.js';

test('registry requires a distinct valid directory table before runtime ownership', t => {
  const f = registryFixture(t);
  for (const name of [undefined, '', 'ab', '1table', 'bad-name', 'a'.repeat(64), 'JOURNAL', 'Kab', 'ſab', 'abK']) {
    assert.throws(() => parseRegistryConfig({ ...f.env, TABLE_DIRECTORY_TABLE: name }), ConfigurationError);
    if (name !== undefined) assert.throws(() => snapshotRegistry({ ...registryInput(), directoryTable: name }), ConfigurationError);
  }
  const input = { ...registryInput(), directoryTable: 'Directory' }; const snapshot = snapshotRegistry(input);
  input.directoryTable = 'Changed'; assert.equal(snapshot.directoryTable, 'Directory');
  assert.equal(parseRegistryConfig({ ...f.env, TABLE_DIRECTORY_TABLE: 'Directory' }).directoryTable, 'Directory');
});

test('registry preserves target scope/store bindings, freezes snapshots and never reads Kubernetes token at startup', t => {
  const f = registryFixture(t); const c = parseRegistryConfig(f.env);
  assert.equal('legacyTargetId' in c, false); assert.equal(c.targets.length, 2);
  assert.equal(c.targets[0]!.config.scope.orkaBaseUrl, 'https://orka.example.invalid/');
  assert.equal(c.targets[0]!.config.storage.ingressStoreId, 'primary-inbox');
  assert.equal(c.targets[0]!.config.storage.deliveryStoreId, 'primary-delivery');
  assert.equal(Object.isFrozen(c.targets[0]!.config.storage), true);
  assert.equal(Object.isFrozen(c.targets), true);
  const expected = createHash('sha256').update(JSON.stringify(['teams-target-v1',
    '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'primary',
    'https://orka.example.invalid/', 'https://kubernetes.example.invalid/', 'default', 'teams', 'gateway-uid', 'default', 'front'])).digest('hex');
  assert.equal(c.targets[0]!.identityDigest, expected);
});

for (const [name, change] of Object.entries({
  'unknown root key': (m: any) => { m.policy = {}; },
  'unsupported agents policy': (m: any) => { m.targets[0].agents = ['front']; },
  'unknown target field': (m: any) => { m.targets[0].secret = 'not-allowed'; },
  'duplicate id': (m: any) => { m.targets[1].id = 'primary'; },
  'duplicate inbox id': (m: any) => { m.targets[1].ingressStoreId = m.targets[0].ingressStoreId; },
  'duplicate delivery id': (m: any) => { m.targets[1].deliveryStoreId = m.targets[0].deliveryStoreId; },
  'removed legacy target field': (m: any) => { m.legacyTargetId = 'primary'; },
  'noncanonical Orka URL': (m: any) => { m.targets[0].orkaBaseUrl = 'https://orka.example.invalid'; },
  'insecure Kubernetes URL': (m: any) => { m.targets[0].kubernetesBaseUrl = 'http://kubernetes.example.invalid/'; },
  'cross namespace front': (m: any) => { m.targets[0].frontAgent.namespace = 'other'; },
  'invalid id': (m: any) => { m.targets[0].id = 'UPPER'; },
  'too many slots': (m: any) => { m.targets = Array(33).fill(m.targets[0]); },
})) test(`registry rejects ${name}`, t => {
  const f = registryFixture(t); change(f.manifest); f.save(); assert.throws(() => parseRegistryConfig(f.env), ConfigurationError);
});

for (const key of ['ORKA_BASE_URL', 'ORKA_GATEWAY_NAMESPACE', 'ORKA_GATEWAY_NAME', 'ORKA_BEARER_TOKEN', 'ORKA_OUTBOUND_BEARER_TOKEN', 'ORKA_CA_FILE', 'TABLE_INGRESS_STORE_ID', 'TABLE_DELIVERY_STORE_ID'])
  test(`registry rejects ambiguous per-target environment ${key}`, t => {
    const f = registryFixture(t); assert.throws(() => parseRegistryConfig({ ...f.env, [key]: 'ambiguous' }), ConfigurationError);
  });
for (const env of [{ GATEWAY_STORAGE_BACKEND: 'table-v2' }, { OUTBOUND_ENABLED: 'false' }]) test(`registry requires full V3 ${JSON.stringify(env)}`, t => {
  const f = registryFixture(t); assert.throws(() => parseRegistryConfig({ ...f.env, ...env }), ConfigurationError);
});

for (const kind of ['manifest', 'parent'] as const) test(`registry refuses untrusted writable ${kind} while allowing an owned public-readable manifest`, t => {
  const f = registryFixture(t); chmodSync(f.env.ORKA_REGISTRY_FILE, 0o644); assert.equal(parseRegistryConfig(f.env).targets.length, 2);
  if (kind === 'manifest') chmodSync(f.env.ORKA_REGISTRY_FILE, 0o666);
  else {
    const directory = join(f.directory, 'manifest-dir'); mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, 'registry.json'); writeFileSync(path, JSON.stringify(f.manifest)); f.env.ORKA_REGISTRY_FILE = path;
    chmodSync(directory, 0o777);
  }
  assert.throws(() => parseRegistryConfig(f.env), ConfigurationError);
});

test('registry rejects credential reuse across slots and directions without printing it', t => {
  const f = registryFixture(t); writeFileSync(f.manifest.targets[1]!.callbackTokenFile, 'ingress-primary', { mode: 0o600 });
  assert.throws(() => parseRegistryConfig(f.env), ConfigurationError);
});
test('digest excludes mutable labels/files/credentials but includes each routing field', () => {
  const original = registryInput(); const digest = snapshotRegistry(original).targets[0]!.identityDigest;
  const mutable = structuredClone(original); mutable.targets[0]!.label = 'Changed'; mutable.targets[0]!.kubernetesTokenFile = '/not/read.json';
  mutable.targets[0]!.config.bearerToken = 'rotated-ingress';
  assert.equal(snapshotRegistry(mutable).targets[0]!.identityDigest, digest);
  for (const change of [
    (v: any) => { v.id = 'replacement'; }, (v: any) => { v.gatewayUid = 'replacement'; },
    (v: any) => { v.kubernetesBaseUrl = 'https://other.invalid/'; },
    (v: any) => { v.frontAgent.name = 'other'; },
    (v: any) => { v.config.scope.orkaBaseUrl = 'https://other.invalid/'; },
    (v: any) => { v.config.scope.gatewayName = 'other'; },
    (v: any) => { v.config.scope.gatewayNamespace = 'other'; v.frontAgent.namespace = 'other'; },
  ]) { const input = structuredClone(original); change(input.targets[0]);
    assert.notEqual(snapshotRegistry(input).targets[0]!.identityDigest, digest); }
});
test('registry labels share the directory UTF-8 byte limit before serving', () => {
  const input = registryInput(); input.targets[0]!.label = '界'.repeat(100);
  assert.throws(() => snapshotRegistry(input), ConfigurationError);
  input.targets[0]!.label = '界'.repeat(85) + 'a';
  assert.equal(snapshotRegistry(input).targets[0]!.label, input.targets[0]!.label);
  input.targets[0]!.label += 'b'; assert.throws(() => snapshotRegistry(input), ConfigurationError);
});

test('registry CLI requires an explicit absolute policy file reference', t => {
  const f = registryFixture(t);
  for (const value of [undefined, '', 'relative.json']) assert.throws(() => parseRegistryConfig({ ...f.env, ORKA_GROUP_POLICY_FILE: value }), ConfigurationError);
});

test('library snapshot rejects mismatched shared bot, listener, policy and storage identities', () => {
  for (const change of [
    (v: any) => { v.receiver.clientSecret = 'other'; }, (v: any) => { v.receiver.port = 4000; },
    (v: any) => { v.storage.account = 'other123'; }, (v: any) => { v.storage.identity.clientId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; },
    (v: any) => { v.policy.maxPending++; }, (v: any) => { v.outbound.port = 4001; },
    (v: any) => { v.outbound = undefined; },
  ]) { const input = registryInput(); change(input.targets[1]!.config); assert.throws(() => snapshotRegistry(input), ConfigurationError); }
});

for (const kind of ['symlink', 'hardlink', 'public', 'oversized'] as const) test(`registry refuses ${kind} credential files`, t => {
  const f = registryFixture(t); const file = f.manifest.targets[0]!.ingressTokenFile;
  if (kind === 'public') chmodSync(file, 0o644);
  if (kind === 'oversized') writeFileSync(file, 'a'.repeat(16385));
  if (kind === 'symlink' || kind === 'hardlink') {
    const other = join(f.directory, 'other'); writeFileSync(other, 'synthetic', { mode: 0o600 }); rmSync(file);
    if (kind === 'symlink') symlinkSync(other, file); else linkSync(other, file);
  }
  assert.throws(() => parseRegistryConfig(f.env), ConfigurationError);
});
