import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readGroupPolicy, snapshotGroupPolicy } from '../src/policy/config.js';
import { snapshotRegistry } from '../src/registry/config.js';
import { registryFixture, registryInput } from './support/registry.js';

const group = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function input() { return { schemaVersion: 1, graphIdentityClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', policies: [
  { schemaVersion: 1, targetId: 'legacy', frontAgent: 'front', rules: [{ groupId: group, chatKinds: ['personal', 'groupChat'] }] },
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
test('policy file uses bounded operator-owned file reader, not credential permissions', t => {
  const f = registryFixture(t); const file = join(f.directory, 'policy.json');
  writeFileSync(file, JSON.stringify(input()), { mode: 0o644 });
  assert.equal(readGroupPolicy(file, registryInput()).groupIds[0], group);
  chmodSync(file, 0o666); assert.throws(() => readGroupPolicy(file, registryInput()));
  chmodSync(file, 0o600); writeFileSync(file, 'a'.repeat(262145)); assert.throws(() => readGroupPolicy(file, registryInput()));
});
