import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readGroupPolicy, snapshotGroupPolicy } from '../src/policy/config.js';
import { snapshotRegistry } from '../src/registry/config.js';
import { registryFixture, registryInput } from './support/registry.js';

const group = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function input() { return { schemaVersion: 1, graphIdentityClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', policies: [
  { schemaVersion: 1, targetId: 'primary', frontAgent: 'front', rules: [{ groupId: group, chatKinds: ['personal', 'groupChat'] }] },
] }; }
test('closed policy freezes additive rules and canonical UUIDs without changing registry identity', () => {
  const registry = registryInput(); const before = snapshotRegistry(registry).targets[0]!.identityDigest;
  const raw = input(); raw.policies[0]!.rules.push({ groupId: group.toUpperCase(), chatKinds: ['personal'] });
  const policy = snapshotGroupPolicy(raw, registry); raw.policies[0]!.rules[0]!.chatKinds.length = 0;
  assert.deepEqual(policy.groupIds, [group]); assert.deepEqual(policy.targets[0]!.rules[0]!.chatKinds, ['groupChat', 'personal']);
  assert.equal(policy.tenantId, registry.targets[0]!.config.scope.tenantId);
  assert.equal(Object.isFrozen(policy.targets[0]!.rules[0]!.chatKinds), true);
  assert.equal(snapshotRegistry(registry).targets[0]!.identityDigest, before);
  assert.equal(policy.targets[1]!.rules.length, 0);
});
test('policy digest ignores labels/credentials and rule order but changes for access decisions', () => {
  const registry = registryInput(); const raw = input(); const original = snapshotGroupPolicy(raw, registry);
  registry.targets[0]!.label = 'Changed'; registry.targets[0]!.config.bearerToken = 'changed';
  raw.policies[0]!.rules[0]!.chatKinds.reverse();
  assert.equal(snapshotGroupPolicy(raw, registry).digest, original.digest);
  raw.policies[0]!.rules[0]!.chatKinds = ['personal'];
  assert.notEqual(snapshotGroupPolicy(raw, registry).digest, original.digest);
  assert.equal(snapshotGroupPolicy({ ...input(), policies: [] }, registry).groupIds.length, 0);
});
for (const [name, change] of Object.entries({
  version: (p: any) => { p.schemaVersion = 2; }, agents: (p: any) => { p.policies[0].agents = ['front']; },
  ruleAgents: (p: any) => { p.policies[0].rules[0].agents = ['front']; }, wildcard: (p: any) => { p.policies[0].rules[0].groupId = '*'; },
  missingClient: (p: any) => { delete p.graphIdentityClientId; },
  badClient: (p: any) => { p.graphIdentityClientId = 'auto'; }, unknownTarget: (p: any) => { p.policies[0].targetId = 'absent'; },
  front: (p: any) => { p.policies[0].frontAgent = 'other'; }, duplicate: (p: any) => { p.policies.push(p.policies[0]); },
  channel: (p: any) => { p.policies[0].rules[0].chatKinds = ['channel']; }, emptyKinds: (p: any) => { p.policies[0].rules[0].chatKinds = []; },
  duplicateKinds: (p: any) => { p.policies[0].rules[0].chatKinds = ['personal', 'personal']; },
  badGroup: (p: any) => { p.policies[0].rules[0].groupId = '../users'; },
  policiesBound: (p: any) => { p.policies = Array(33).fill(p.policies[0]); },
  rulesBound: (p: any) => { p.policies[0].rules = Array(257).fill(p.policies[0].rules[0]); },
  targetVersion: (p: any) => { p.policies[0].schemaVersion = 2; },
})) test(`closed policy rejects ${name}`, () => {
  const raw = input(); change(raw); assert.throws(() => snapshotGroupPolicy(raw, registryInput()), { message: 'Invalid ingress configuration' });
});
test('user-only policy needs no Graph identity and keeps canonical digest and registry identity', () => {
  const registry = registryInput(); const before = snapshotRegistry(registry).targets[0]!.identityDigest;
  const raw = { schemaVersion: 1, policies: [{ schemaVersion: 1, targetId: 'primary', frontAgent: 'front', rules: [
    { userObjectId: group.toUpperCase(), chatKinds: ['personal', 'groupChat'] },
    { userObjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', chatKinds: ['personal'] },
  ] }] };
  const policy = snapshotGroupPolicy(raw, registry);
  assert.equal(policy.graphIdentityClientId, undefined); assert.deepEqual(policy.groupIds, []);
  assert.equal(Object.isFrozen(policy.targets[0]!.rules[0]), true);
  raw.policies[0]!.rules.reverse(); raw.policies[0]!.rules[1]!.chatKinds.reverse();
  raw.policies[0]!.rules[1]!.userObjectId = group;
  assert.equal(snapshotGroupPolicy(raw, registry).digest, policy.digest);
  raw.policies[0]!.rules[1]!.userObjectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  assert.notEqual(snapshotGroupPolicy(raw, registry).digest, policy.digest);
  assert.equal(snapshotRegistry(registry).targets[0]!.identityDigest, before);
  assert.equal(snapshotGroupPolicy(input(), registry).digest, '7e7552fedb17fc6cdceff9f8720d44ba5d54aaf186a07e0c463baf0d6c04b63a');
});
for (const [name, rule] of Object.entries({
  both: { groupId: group, userObjectId: group, chatKinds: ['personal'] }, neither: { chatKinds: ['personal'] },
  unknown: { userObjectId: group, email: 'person@example.invalid', chatKinds: ['personal'] },
  malformed: { userObjectId: '../users', chatKinds: ['personal'] }, wildcard: { userObjectId: '*', chatKinds: ['personal'] },
  empty: { userObjectId: '', chatKinds: ['personal'] }, channel: { userObjectId: group, chatKinds: ['channel'] },
})) test(`user rule rejects ${name}`, () => {
  assert.throws(() => snapshotGroupPolicy({ schemaVersion: 1, policies: [
    { schemaVersion: 1, targetId: 'primary', frontAgent: 'front', rules: [rule] },
  ] }, registryInput()));
});
test('user and group rules share the 256-rule limit and mixed files require Graph identity', () => {
  const raw = input(); const rules: unknown[] = Array.from({ length: 255 }, () => ({ userObjectId: group, chatKinds: ['personal'] }));
  rules.push(raw.policies[0]!.rules[0]);
  const mixed = { ...raw, policies: [{ ...raw.policies[0]!, rules }] };
  assert.deepEqual(snapshotGroupPolicy(mixed, registryInput()).groupIds, [group]);
  assert.throws(() => snapshotGroupPolicy({ ...mixed, graphIdentityClientId: undefined }, registryInput()));
  rules.push({ userObjectId: group, chatKinds: ['personal'] });
  assert.throws(() => snapshotGroupPolicy(mixed, registryInput()));
});
test('policy file uses bounded operator-owned file reader, not credential permissions', t => {
  const f = registryFixture(t); const file = join(f.directory, 'policy.json');
  writeFileSync(file, JSON.stringify(input()), { mode: 0o644 });
  assert.equal(readGroupPolicy(file, registryInput()).groupIds[0], group);
  chmodSync(file, 0o666); assert.throws(() => readGroupPolicy(file, registryInput()));
  chmodSync(file, 0o600); writeFileSync(file, 'a'.repeat(262145)); assert.throws(() => readGroupPolicy(file, registryInput()));
});
