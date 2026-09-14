import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import { code, dataEntity, payload, request, rowKey } from './support/table-delivery.js';
import { deleteFirstGraph, disposition, installRecovery, recoveryHistory } from './support/table-delivery-v2.js';
import { stamp, tableBinding, tableService } from './support/table-service.js';
import { changedM2, wireM2 } from './support/table-v2.js';

for (const damage of ['state-padding', 'result-padding', 'coherent-deletion', 'count', 'order', 'row-tag', 'end-tag', 'domain-tag', 'payload-hash', 'binding'] as const)
  test(`V2 immediate recovery audit refuses ${damage} without erasing Exit`, async t => {
    const { s, exit } = await recoveryHistory(t, true);
    if (damage === 'coherent-deletion') deleteFirstGraph(s);
    else if (damage === 'state-padding' || damage === 'result-padding') {
      const m = s.rows.get('M')!; const field = damage === 'state-padding' ? 'State' : 'Result';
      s.rows.set('M', changedM2(m, { [field]: Buffer.concat([Buffer.from(' '), Buffer.from(String(m[field]), 'base64'), Buffer.from('\n')]).toString('base64') }, 92000));
    } else installRecovery(s, disposition(s, damage));
    const retained = s.rows.get('M')!.Exit;
    const before = s.stats.writes;
    const j = createTableDeliveryJournalV2(tableBinding, s.dependencies);
    const opening = j.open();
    // Boolean capture also makes missing semantic validation safe to diagnose on RED.
    let corrupt = false; try { await opening; } catch (error) { corrupt = code('corrupt')(error); }
    const ready = j.status().lifecycle === 'ready';
    await j.close().catch(() => undefined);
    assert.equal(corrupt, true); assert.equal(ready, false);
    assert.equal(s.stats.writes - before, 1); assert.equal(s.rows.get('M')!.Exit === retained, true);
    assert.equal(s.rows.get('M')!.Owner !== '', true);
    if (damage === 'coherent-deletion') assert.equal(retained === exit, true);
    const next = createTableDeliveryJournalV2(tableBinding, s.dependencies);
    await assert.rejects(next.open(), code('busy')); await next.close().catch(() => undefined);
  });

test('V2 coherent deletion remains an ordinary valid graph: only original recovery commitment rejects it', async t => {
  const { s, secondRequest } = await recoveryHistory(t, true); deleteFirstGraph(s);
  // A newly computed reader fixture proves the remaining graph/latest receipt is valid.
  installRecovery(s); const j = createTableDeliveryJournalV2(tableBinding, s.dependencies); await j.open();
  assert.equal((await j.begin(secondRequest)).kind, 'delivered'); await j.close();
});

for (const barrier of [false, true]) test(`validated recovery${barrier ? ' behind an unowned barrier' : ''} allows later begin/settle and clean reopen, not a stale-Exit comparison`, async t => {
  const { s, exit, claim } = await recoveryHistory(t);
  if (barrier) s.rows.set('M', changedM2(s.rows.get('M')!, { Operation: 'barrier', Invocation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', Plan: 'e'.repeat(64) }, 92000));
  const j = createTableDeliveryJournalV2(tableBinding, s.dependencies); const data = JSON.stringify([...s.rows.entries()].filter(([key]) => key !== 'M'));
  await j.open(); assert.equal(JSON.stringify([...s.rows.entries()].filter(([key]) => key !== 'M')) === data, true);
  assert.equal((await j.begin({ ...request, deliveryId: 'recovery-alias' })).kind, 'unknown');
  assert.equal(await j.settle(claim, { kind: 'unknown' }), 'unchanged');
  assert.equal(await j.settle(claim, { kind: 'delivered', providerMessageId: 'late' }), 'stale');
  assert.equal(payload(s.rows.get(rowKey('delivery', request.idempotencyId))!).state === 'sending', true);
  const fresh = { ...request, idempotencyId: 'fresh', deliveryId: 'fresh-alias' };
  const begin = await j.begin(fresh); assert.equal(begin.kind, 'claimed'); if (begin.kind !== 'claimed') throw new Error('Fixture claim missing');
  assert.equal(await j.settle(begin.claim, { kind: 'delivered', providerMessageId: 'immutable' }), 'recorded');
  assert.equal(await j.settle(begin.claim, { kind: 'delivered', providerMessageId: 'late-other' }), 'stale');
  assert.equal(s.rows.get('M')!.Exit === exit, true); assert.equal(disposition(s) === JSON.parse(Buffer.from(exit, 'base64').toString()).domainDispositionDigest, false);
  await j.close(); assert.equal(JSON.parse(Buffer.from(String(s.rows.get('M')!.Exit), 'base64').toString()).kind === 'clean-release', true);
  const next = createTableDeliveryJournalV2(tableBinding, s.dependencies); await next.open();
  const replay = await next.begin(fresh); assert.equal(replay.kind === 'delivered' && replay.providerMessageId === 'immutable', true); await next.close();
});

// Independently calculated with Python hashlib/json/base64, not a production or
// test TS digest helper. The populated vector commits all three physical rows.
for (const populated of [false, true]) test(`V2 literal ${populated ? 'populated' : 'empty'} recovery golden vector is accepted over native HTTPS`, async t => {
  const s = await tableService(t, 'delivery', 2);
  const digest = 'a5d1a332c21eb2c2ce840b52f1ef6ab5304b97070107f3008dcc540be19b382a';
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const state = '{"journal":"teams-delivery","schema":1,"fingerprint":1}';
  const result = populated ? JSON.stringify({ schema: 1, operation: 'begin', identity: { deliveryId: 'd', idempotencyId: 's', digest },
    result: { kind: 'claimed', claim: { idempotencyId: 's', attemptId } } }) : '{"schema":1,"operation":"initialize"}';
  s.rows.set('M', changedM2(wireM2('', 1, 'operator-recovery'), { State: Buffer.from(state).toString('base64'), Result: Buffer.from(result).toString('base64') }));
  if (populated) {
    // Deliberately insert out of physical order; the oracle pages in row-key order.
    for (const entity of [dataEntity('delivery', 's', { schema: 1, fingerprint: 1, digest, attemptId, attemptEpoch: 1, state: 'sending', providerMessageId: null }),
      dataEntity('alias', 's', { schema: 1, idempotencyId: 's' }), dataEntity('alias', 'd', { schema: 1, idempotencyId: 's' })]) s.rows.set(String(entity.RowKey), entity);
  }
  const golden = populated ? '6a6b1bc6618c3ff996050dc074eaabd2a3294e2e7913361855bc9f80a2e83676' :
    '040bb99339b94007c4f3b92020f01d004022e629c95ae5873de2a569790e160b';
  assert.equal(disposition(s) === golden, true); installRecovery(s, golden);
  const j = createTableDeliveryJournalV2(tableBinding, s.dependencies); await j.open();
  assert.equal(s.rows.get('M')!.State === Buffer.from(state).toString('base64'), true);
  assert.equal(s.rows.get('M')!.Result === Buffer.from(result).toString('base64'), true);
  if (populated) assert.equal((await j.begin({ protocolVersion: 'orka.gateway.v1', deliveryId: 'd', idempotencyId: 's', originatingEventId: 'event',
    kind: 'final', accountId: 'Tenant', contextId: 'context', replyTarget: 'reply', text: 'text' })).kind, 'unknown');
  await j.close();
});

for (const field of ['State', 'Result'] as const) test(`V2 accepts committed exact ${field} padding without canonicalizing retained bytes`, async t => {
  const { s } = await recoveryHistory(t, true); const m = s.rows.get('M')!;
  const exact = Buffer.concat([Buffer.from(' \n'), Buffer.from(String(m[field]), 'base64'), Buffer.from('\t ')]).toString('base64');
  s.rows.set('M', changedM2(m, { [field]: exact }, 96000)); installRecovery(s);
  const j = createTableDeliveryJournalV2(tableBinding, s.dependencies); await j.open();
  assert.equal(s.rows.get('M')![field] === exact, true); await j.close();
});

test('V2 recovery commitment excludes service timestamps and ETags, not envelope digests', async t => {
  const { s } = await recoveryHistory(t, true);
  for (const [key, row] of s.rows) s.rows.set(key, { ...stamp(row, 97000), Timestamp: '2026-02-03T04:05:06.7654321Z' });
  const j = createTableDeliveryJournalV2(tableBinding, s.dependencies); await j.open(); await j.close();
});
