import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableDeliveryJournal, createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import type { DeliveryJournalPort } from '../src/delivery/types.js';
import { code, dataEntity, request, rowKey } from './support/table-delivery.js';
import { tableBinding, tableService, stamp, wireM } from './support/table-service.js';
import { wireM2 } from './support/table-v2.js';

// Both public factories retain the same port and arguments; no public format switch.
const factories = [createTableDeliveryJournal, createTableDeliveryJournalV2] as const satisfies
  readonly ((...args: Parameters<typeof createTableDeliveryJournal>) => DeliveryJournalPort)[];

test('V2 factory initializes M2 with exact V1 domain bytes and claims V1 data envelopes', async t => {
  const s = await tableService(t, 'delivery', 2);
  const init = createTableDeliveryJournalV2(tableBinding, s.dependencies);
  assert.equal(s.stats.requests, 0); await init.initialize(); await init.close();
  const m = s.rows.get('M')!;
  assert.equal(m.V, 2); assert.equal('Release' in m, false); assert.equal(m.Owner === '', true);
  assert.equal(m.State === Buffer.from('{"journal":"teams-delivery","schema":1,"fingerprint":1}').toString('base64'), true);
  assert.equal(m.Result === Buffer.from('{"schema":1,"operation":"initialize"}').toString('base64'), true);
  const next = createTableDeliveryJournalV2(tableBinding, s.dependencies); await next.open();
  const begin = await next.begin(request); assert.equal(begin.kind, 'claimed');
  assert.equal([...s.rows.values()].filter(r => r.RowKey !== 'M').every(r => r.V === 1), true);
  const alias = [...s.rows.values()].find(r => r.T === 'alias')!;
  assert.equal(alias.B0 === Buffer.from(JSON.stringify({ schema: 1, idempotencyId: request.idempotencyId })).toString('base64'), true);
  await next.close(); assert.equal(s.stats.requests, s.stats.socketCloses);
});

for (const stored of [1, 2] as const) test(`opposite factory refuses M${stored} before acquisition writes`, async t => {
  const s = await tableService(t, 'delivery', stored);
  const init = factories[stored - 1]!(tableBinding, s.dependencies); await init.initialize(); await init.close();
  const before = s.stats.writes; const m = JSON.stringify(s.rows.get('M'));
  const wrong = factories[2 - stored]!(tableBinding, s.dependencies);
  await assert.rejects(wrong.open(), code('corrupt')); await wrong.close().catch(() => undefined);
  assert.equal(s.stats.writes, before); assert.equal(JSON.stringify(s.rows.get('M')) === m, true);
});

for (const shape of ['existing', 'orphan', 'bare'] as const) test(`V2 initialization never adopts ${shape}`, async t => {
  const s = await tableService(t, 'delivery', 2);
  if (shape === 'existing') { const init = createTableDeliveryJournalV2(tableBinding, s.dependencies); await init.initialize(); }
  else if (shape === 'orphan') s.rows.set('alias_cw', dataEntity('alias', 's', { schema: 1, idempotencyId: 's' }));
  else s.rows.set('M', stamp(wireM2(), 1));
  const before = s.stats.writes;
  const init = createTableDeliveryJournalV2(tableBinding, s.dependencies);
  await assert.rejects(init.initialize(), code('exists')); await init.close().catch(() => undefined);
  assert.equal(s.stats.writes, before);
  if (shape === 'bare') {
    const next = createTableDeliveryJournalV2(tableBinding, s.dependencies);
    await assert.rejects(next.open(), code('corrupt')); await assert.rejects(next.close(), code('unavailable'));
  }
});

for (const format of [1, 2] as const) test(`V${format} exact domain operation/result bytes remain schema-one`, async t => {
  const s = await tableService(t, 'delivery', format); const create = factories[format - 1]!;
  const init = create(tableBinding, s.dependencies); await init.initialize();
  const j = create(tableBinding, s.dependencies); await j.open();
  const r = { protocolVersion: 'orka.gateway.v1', deliveryId: 'd', idempotencyId: 's', originatingEventId: 'event', kind: 'final',
    accountId: 'Tenant', contextId: 'context', replyTarget: 'reply', text: 'text' } as const;
  const digest = 'a5d1a332c21eb2c2ce840b52f1ef6ab5304b97070107f3008dcc540be19b382a';
  const begun = await j.begin(r); assert.equal(begun.kind, 'claimed'); if (begun.kind !== 'claimed') throw new Error('Fixture claim missing');
  const expected = { schema: 1, fingerprint: 1, digest, attemptId: begun.claim.attemptId, attemptEpoch: 2, state: 'sending', providerMessageId: null };
  const operation = s.rows.get(rowKey('delivery', 's'))!;
  assert.equal(operation.B0 === Buffer.from(JSON.stringify(expected)).toString('base64'), true);
  assert.equal(operation.Digest === dataEntity('delivery', 's', expected).Digest, true);
  assert.equal(s.rows.get('M')!.Result === Buffer.from(JSON.stringify({ schema: 1, operation: 'begin', identity: { deliveryId: 'd', idempotencyId: 's', digest }, result: begun })).toString('base64'), true);
  const outcome = { kind: 'delivered', providerMessageId: 'immutable' } as const;
  assert.equal(await j.settle(begun.claim, outcome), 'recorded');
  assert.equal(s.rows.get('M')!.Result === Buffer.from(JSON.stringify({ schema: 1, operation: 'settle', claim: begun.claim, outcome, result: 'recorded' })).toString('base64'), true);
  await j.close();
});

for (const format of [1, 2] as const) test(`V${format} never-started close is harmless and memoized`, async t => {
  const s = await tableService(t, 'delivery', format);
  s.rows.set('M', stamp(format === 1 ? wireM() : wireM2(), 1));
  const j = factories[format - 1]!(tableBinding, s.dependencies); const close = j.close();
  assert.equal(j.close() === close, true); await close; assert.equal(s.stats.requests, 0);
});
