import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateDirectoryImport, importDirectory } from '../src/directory/import.js';
import { openDirectory } from '../src/directory/store.js';
import { snapshotRegistry } from '../src/registry/config.js';
import { memoryDirectoryTable } from './support/directory-memory.js';
import { registryInput } from './support/registry.js';

const registry = snapshotRegistry(registryInput());
const target = registry.targets[0]!;
const ctx = () => ({ signal: new AbortController().signal, deadline: performance.now() + 10000 });
function document() {
  return { schemaVersion: 1, connections: [{ appId: target.config.scope.appId, tenantId: target.config.scope.tenantId,
    conversationId: '19:existing;messageid=kept', chatKind: 'personal', targetId: target.id, identityDigest: target.identityDigest,
    importId: 'operator-export-a', binding: { namespace: target.config.scope.gatewayNamespace, name: 'existing-binding', uid: 'existing-uid', generation: 7,
      spec: { gatewayRef: { name: target.config.scope.gatewayName }, agentRef: { name: target.frontAgent.name },
        match: { accountId: target.config.scope.tenantId, contextId: '19:existing;messageid=kept', senderId: '29:original-sender' },
        senderPolicy: { mode: 'allowlist', allowedSenderIds: ['29:original-sender'] }, priority: -30,
        session: { mode: 'context-sender' }, taskDefaults: { retryPolicy: { backoffMultiplier: 1.5 } } } } }] };
}

// A defaults-rewriting migration would silently change existing access/session routing.
test('offline import preserves entire existing spec and distinct lineage, and reruns idempotently', async () => {
  const input = document(); const rows = validateDirectoryImport(input, registry);
  assert.equal(rows[0]?.lineage.kind, 'imported'); assert.equal(rows[0]?.state, 'provisioned');
  assert.deepEqual(rows[0]?.binding?.spec, input.connections[0]!.binding.spec);
  assert.equal(rows[0]?.binding?.generation, 7); assert.equal(rows[0]?.bindingName, 'existing-binding');
  const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, ctx());
  await importDirectory(rows, directory, ctx()); await importDirectory(rows, directory, ctx());
  assert.equal(f.writes(), 1); assert.equal((await directory.getConnection('19:existing;messageid=kept', ctx()))?.targetId, 'legacy');
  await directory.close();
});

test('document duplicates and mismatched account/context/Gateway/Agent/target never import', () => {
  const mutations: ((d: ReturnType<typeof document>) => void)[] = [
    d => d.connections.push(structuredClone(d.connections[0]!)),
    d => { d.connections[0]!.binding.spec.match.accountId = 'another-tenant'; },
    d => { d.connections[0]!.binding.spec.match.contextId = 'another-context'; },
    d => { d.connections[0]!.binding.spec.gatewayRef.name = 'another-gateway'; },
    d => { d.connections[0]!.binding.spec.agentRef.name = 'another-agent'; },
    d => { d.connections[0]!.binding.namespace = 'another-namespace'; },
    d => { d.connections[0]!.identityDigest = 'f'.repeat(64); },
    d => { d.connections[0]!.chatKind = 'channel'; },
    d => { d.connections[0]!.appId = 'another-app'; },
  ];
  for (const mutate of mutations) { const input = document(); mutate(input); assert.throws(() => validateDirectoryImport(input, registry), { code: 'invalid-input' }); }
});

test('existing conflict on a later row prevents all import inserts', async () => {
  const input = document(); const second = structuredClone(input.connections[0]!); second.conversationId = 'chat-b'; second.binding.spec.match.contextId = 'chat-b';
  input.connections.push(second); const rows = validateDirectoryImport(input, registry);
  const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, ctx());
  await directory.reserveConnection({ ...rows[1]!, lineage: { kind: 'imported', importId: 'other-export' } }, ctx());
  const before = f.writes(); await assert.rejects(importDirectory(rows, directory, ctx()), { code: 'conflict' });
  assert.equal(f.writes(), before); assert.equal(await directory.getConnection(input.connections[0]!.conversationId, ctx()), undefined);
  await directory.close();
});

test('canonical import ignores object key ordering, not sender/session/priority differences', async () => {
  const input = document(); const rows = validateDirectoryImport(input, registry); const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, ctx());
  await importDirectory(rows, directory, ctx()); const reordered = structuredClone(input);
  const spec = reordered.connections[0]!.binding.spec; reordered.connections[0]!.binding.spec = Object.fromEntries(Object.entries(spec).reverse()) as typeof spec;
  await importDirectory(validateDirectoryImport(reordered, registry), directory, ctx());
  reordered.connections[0]!.binding.spec.priority = -29;
  await assert.rejects(importDirectory(validateDirectoryImport(reordered, registry), directory, ctx()), { code: 'conflict' }); assert.equal(f.writes(), 1); await directory.close();
});

test('partial import rerun preserves the first row and inserts only the missing suffix', async () => {
  const input = document(); const second = structuredClone(input.connections[0]!);
  second.conversationId = 'chat-b'; second.binding.spec.match.contextId = 'chat-b'; input.connections.push(second);
  const rows = validateDirectoryImport(input, registry); const f = memoryDirectoryTable(); const directory = await openDirectory(f.table, ctx());
  const insert = f.table.insert;
  f.table.insert = async (...args) => { if (args[0].conversationId === 'chat-b') throw new Error('synthetic unavailable'); return insert(...args); };
  await assert.rejects(importDirectory(rows, directory, ctx()), /synthetic unavailable/u);
  assert.equal(f.rows.size, 1); const first = structuredClone([...f.rows.values()][0]);
  f.table.insert = insert; await importDirectory(rows, directory, ctx());
  assert.equal(f.rows.size, 2); assert.deepEqual([...f.rows.values()][0], first); assert.equal(f.writes(), 2);
  await directory.close();
});

test('import CLI help and invalid invocations never reach identity or storage', () => {
  for (const [args, status] of [[['--help'], 0], [[], 1], [['import'], 1], [['--unknown'], 1], [['import', 'relative.json'], 1]] as const) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/directory/main.ts', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, status, result.stderr); assert.doesNotMatch(result.stdout + result.stderr, /Error:|stack|token|Bearer/u);
    if (!status) assert.match(result.stdout, /import <absolute-export-file>/u); else assert.match(result.stderr, /Directory import failed/u);
  }
});
