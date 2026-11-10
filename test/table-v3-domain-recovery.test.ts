import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindTable, data } from '../src/storage/table/codec.js';
import { encodeExpiryAudit, expiryAuditId, metadataV3 } from '../src/storage/table/codec-v3.js';
import { LeaseTransitionTableClient, OwnedTableClient } from '../src/storage/table/client.js';
import { createTableKernelV3, TableError } from '../src/storage/table/index.js';
import { createTableOperatorReclaimerV3 } from '../src/storage/table/recovery.js';
import { budget } from './support/owned-audit.js';
import { tableBinding, tableService } from './support/table-service.js';
import { TestClock } from './support/table-v3.js';

const code = (want: string) => (e: unknown) => e instanceof TableError && e.code === want;
const invocation = '33333333-3333-4333-8333-333333333333';
async function setup(t: Parameters<typeof tableService>[0]) {
  const s = await tableService(t, 'delivery', 3); const clock = new TestClock(); const deps = { ...s.dependencies, leaseClock: clock };
  const k = createTableKernelV3(tableBinding, deps); t.after(() => k.close().catch(() => {})); await k.initialize(); await k.acquire();
  const original = await k.read('M'); assert.ok(original?.value.kind === 'metadata');
  const bound = bindTable(tableBinding); return { s, k, deps, clock, original: original as typeof original & { value: Exclude<typeof original.value, { kind: 'data' }> }, bound };
}

test('ordinary_v3_writer_cannot_forge_transition: every reserved metadata shape and audit prefix refuses before token', async t => {
  const { s, deps, original, bound } = await setup(t); const client = new OwnedTableClient(bound, deps, 3);
  const before = s.stats.tokens; const context = { signal: new AbortController().signal, deadline: performance.now() + 30000 };
  for (const operation of ['recover', 'lease-expiry', 'format-upgrade']) {
    const m = metadataV3(bound, { ...original.value, operation: operation as any });
    await assert.rejects(client.write(m, original.etag, [], context), code('invalid-input'));
  }
  for (const prefix of ['control_recovery:', 'control_lease_expiry:', 'control_format_upgrade:']) {
    await assert.rejects(client.write(original.value, original.etag, [{ kind: 'create', key: { type: 'control', id: prefix + invocation }, payload: Buffer.from('{}') }], context), code('invalid-input'));
  }
  assert.equal(s.stats.tokens, before); await client.close();
});

test('checked expiry rejects wrong original digest, malformed ETag/Exit/audit and unsupported seal before token acquisition', async t => {
  const { s, deps, original, bound } = await setup(t); const old = original.value;
  const audit = data(bound, { type: 'control', id: expiryAuditId(invocation) }, encodeExpiryAudit({ schema: 1, kind: 'lease-expiry-audit',
    invocation, oldOwner: old.owner, oldEpoch: old.epoch, originalMDigest: old.digest, dispositionDigest: 'b'.repeat(64), lease: old.lease!, observedAt: 1125001 }));
  const m = metadataV3(bound, { ...old, owner: '', lease: undefined, operation: 'lease-expiry', invocation,
    exit: { kind: 'lease-expiry', oldOwner: old.owner, oldEpoch: old.epoch, invocation, originalMDigest: old.digest, planDigest: old.plan,
      domainDispositionDigest: 'c'.repeat(64), auditId: invocation, auditDigest: audit.digest, lease: old.lease!, observedAt: 1125001 } });
  const client = new LeaseTransitionTableClient(bound, deps); const before = s.stats.tokens;
  const context = { signal: new AbortController().signal, deadline: performance.now() + 30000 };
  for (const args of [
    [{ ...original, value: { ...old, digest: '0'.repeat(64) } }, m, audit, undefined],
    [{ ...original, etag: '*' }, m, audit, undefined],
    [original, { ...m, exit: { ...m.exit, extra: true } }, audit, undefined],
    [original, m, { ...audit, payload: Buffer.from('{}') }, undefined],
    [original, m, audit, { kind: 'replace', key: { type: 'control', id: 'generation:1' }, payload: Buffer.from('{}'), etag: original.etag }],
  ] as const) await assert.rejects(client.writeRecover(args[0] as any, args[1] as any, args[2], args[3] as any, context), code('invalid-input'));
  assert.equal(s.stats.tokens, before); await client.close();
});

test('V3 manual recovery requires real attestation even when the foreign lease is live', async t => {
  const { s, deps, original } = await setup(t); const m = original.value;
  const fence = { initId: m.initId, initDigest: m.initDigest, owner: m.owner, epoch: m.epoch, mDigest: m.digest, etag: original.etag };
  const visitor = { passes: 2 as const, record(): undefined {}, endPass(): undefined {}, finalize(): undefined {} };
  const disposition = { state: Buffer.alloc(0), dispositionDigest: 'b'.repeat(64), complete: () => ({ result: Buffer.alloc(0), domainDispositionDigest: 'c'.repeat(64) }) };
  const bad = createTableOperatorReclaimerV3(tableBinding, deps, fence); const before = s.stats.tokens;
  await assert.rejects(bad.reclaim(visitor, budget(), disposition), code('invalid-input')); await bad.close(); assert.equal(s.stats.tokens, before);
  const r = createTableOperatorReclaimerV3(tableBinding, deps, fence);
  await r.reclaim(visitor, budget(), { ...disposition, operatorAttestationDigest: 'd'.repeat(64) }); await r.close();
  assert.equal(s.rows.get('M')!.Owner, ''); assert.equal(s.rows.get('M')!.Operation, 'recover');
  const x = JSON.parse(Buffer.from(String(s.rows.get('M')!.Exit), 'base64').toString());
  assert.equal(x.kind, 'operator-recovery'); assert.equal(x.operatorAttestationDigest, 'd'.repeat(64));
});
