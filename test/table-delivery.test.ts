import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import type { BeginDeliveryResult, DeliveryClaim, DeliveryOutcome } from '../src/delivery/types.js';
import type { DeliveryRequest } from '../src/protocol/types.js';
import { code, deliveryFormat, payload, replacePayload, request, rowKey, scope } from './support/table-delivery.js';
import { ingressBinding, tableBinding, stamp } from './support/table-service.js';

for (const format of [1, 2] as const) describe(`V${format} delivery journal`, () => {
const { create: createTableDeliveryJournal, initialized, opened, replaceControl, tableService, wireM } = deliveryFormat(format);
function claimed(result: BeginDeliveryResult): DeliveryClaim {
  assert.equal(result.kind, 'claimed'); if (result.kind !== 'claimed') throw new Error('Expected claim');
  assert.match(result.claim.attemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u); return result.claim;
}
test('construction rejects non-delivery bindings and invalid budgets without I/O; captures scope immutably', async t => {
  const s = await tableService(t);
  assert.throws(() => createTableDeliveryJournal(ingressBinding, s.dependencies), code('invalid-input'));
  for (const limits of [{ maxPending: 0 }, { maxPendingBytes: Infinity }, { maxPending: 1.5 }, { kernel: { callTimeoutMs: 0 } }])
    assert.throws(() => createTableDeliveryJournal(tableBinding, s.dependencies, limits), code('invalid-input'));
  assert.equal(s.stats.requests, 0);
  const init = createTableDeliveryJournal(tableBinding, s.dependencies); await init.initialize(); await init.close();
  const binding = { ...tableBinding, kind: 'delivery' as const, scope: { ...scope } };
  const j = createTableDeliveryJournal(binding, s.dependencies); binding.scope.tenantId = 'mutated'; binding.scope.appId = 'mutated';
  await j.open(); claimed(await j.begin(request)); await j.close();
});

test('explicit retained handle initializes a domain marker then fresh open claims and releases', async t => {
  const s = await tableService(t); const init = createTableDeliveryJournal(tableBinding, s.dependencies);
  assert.equal(s.stats.requests, 0); await init.initialize();
  assert.equal(s.rows.size, 1); assert.equal(s.rows.get('M')?.Owner, '');
  assert.deepEqual(JSON.parse(Buffer.from(String(s.rows.get('M')?.State), 'base64').toString()), { journal: 'teams-delivery', schema: 1, fingerprint: 1 });
  await assert.rejects(init.open(), code('closed')); await init.close();
  const j = createTableDeliveryJournal(tableBinding, s.dependencies); await j.open();
  assert.equal(j.status().lifecycle, 'ready'); claimed(await j.begin(request));
  assert.equal(s.stats.lastActions, 4); const close = j.close(); assert.equal(j.close(), close); await close;
  assert.equal(s.rows.get('M')?.Owner, ''); assert.equal(s.stats.requests, s.stats.socketCloses);
});

test('public SQLite differential: shared aliases, conflicts, exact attempts, all outcomes and restart', async t => {
  const { s, j } = await opened(t); let table = j;
  const directory = mkdtempSync(join(tmpdir(), 'table-delivery-oracle-')); const file = join(directory, 'journal.sqlite');
  initializeDeliveryJournal(file, scope); let sqlite = openDeliveryJournal(file, scope);
  t.after(async () => { sqlite.close(); await table.close().catch(() => undefined); rmSync(directory, { recursive: true, force: true }); });
  const claims = new Map<string, [DeliveryClaim, DeliveryClaim]>(); let calls = 0;
  const begin = async (key: string, r: DeliveryRequest) => {
    const left = sqlite.begin(r); const right = await table.begin(r); calls++;
    if (left.kind === 'claimed') {
      const actual = claimed(right); assert.equal(actual.idempotencyId, left.claim.idempotencyId);
      for (const old of claims.values()) { assert.notEqual(actual.attemptId, old[1].attemptId); assert.notEqual(left.claim.attemptId, old[0].attemptId); }
      claims.set(key, [left.claim, actual]);
    } else assert.deepEqual(right, left);
    return right;
  };
  const settle = async (key: string, o: DeliveryOutcome, change: Partial<DeliveryClaim> = {}) => {
    const [left, right] = claims.get(key)!;
    assert.equal(await table.settle({ ...right, ...change }, o), sqlite.settle({ ...left, ...change }, o)); calls++;
  };
  const restart = async () => { sqlite.close(); await table.close(); sqlite = openDeliveryJournal(file, scope); table = createTableDeliveryJournal(tableBinding, s.dependencies); await table.open(); };
  await begin('first', request); await begin('', request);
  for (const change of [
    { text: 'changed' }, { text: request.text + ' ' }, { originatingEventId: 'changed' }, { contextId: 'changed' },
    { replyTarget: 'changed' }, { threadId: 'thread' }, { kind: 'error' as const },
    { taskRef: { namespace: 'changed', name: 'task' } }, { sessionRef: { namespace: 'changed', name: 'session' } },
    { metadata: { private: 'changed' } },
  ]) {
    const before = [...s.rows.entries()].filter(([id]) => id !== 'M');
    await begin('', { ...request, ...change, deliveryId: 'not-reserved' });
    assert.deepEqual([...s.rows.entries()].filter(([id]) => id !== 'M'), before);
  }
  const exact = { ...request, idempotencyId: '\ufeffstable-é-🧑🏽‍💻', deliveryId: '\ufffdalias', text: 'é'.repeat(32768), metadata: { z: 'last', a: 'first' } };
  await begin('unicode', exact); await begin('', { ...exact, metadata: { a: 'first', z: 'last' }, threadId: '' });
  await settle('unicode', { kind: 'delivered', providerMessageId: '\ufeff' + 'é'.repeat(125) });
  await begin('', { ...request, deliveryId: 'compatible-alias' });
  const rows = () => [...s.rows.entries()].filter(([key]) => key !== 'M');
  for (const r of [
    { ...request, idempotencyId: 'new-stable' },
    { ...request, idempotencyId: 'compatible-alias', deliveryId: 'unused' },
    { ...request, text: 'changed', deliveryId: 'unused' },
  ]) { const before = rows(); await begin('', r); assert.deepEqual(rows(), before); }
  await begin('second', { ...request, idempotencyId: 'other', deliveryId: 'unused' });
  await begin('', { ...request, deliveryId: 'other' });
  await begin('', { ...request, idempotencyId: 'other', deliveryId: request.deliveryId });
  await begin('same', { ...request, idempotencyId: 'same', deliveryId: 'same' });
  await settle('first', { kind: 'retryable' }); await settle('first', { kind: 'retryable' });
  await restart(); await begin('rotated', { ...request, deliveryId: 'retry-alias' });
  const outcomes: DeliveryOutcome[] = [{ kind: 'retryable' }, { kind: 'unknown' }, { kind: 'rejected' }, { kind: 'delivered', providerMessageId: 'receipt' }];
  for (const o of outcomes) await settle('first', o);
  for (const [i, terminal] of outcomes.entries()) {
    const r = { ...request, idempotencyId: `state-${i}`, deliveryId: `alias-${i}` };
    await begin(`outcome-${i}`, r); await settle(`outcome-${i}`, terminal);
    for (const o of outcomes) await settle(`outcome-${i}`, o);
    await settle(`outcome-${i}`, terminal, { attemptId: 'valid-opaque-non-uuid' });
    await settle(`outcome-${i}`, terminal, { idempotencyId: 'absent' });
    await settle(`outcome-${i}`, { kind: 'delivered', providerMessageId: 'other-receipt' });
    await begin(`replay-${i}`, { ...r, deliveryId: `new-alias-${i}` });
  }
  await restart();
  await begin('', request); await settle('rotated', { kind: 'unknown' });
  await settle('rotated', { kind: 'delivered', providerMessageId: 'late' });
  await settle('second', { kind: 'unknown' }); await begin('', { ...request, idempotencyId: 'other', deliveryId: 'another-alias' });
  for (let i = 1; i < 4; i++) await begin('', { ...request, idempotencyId: `state-${i}`, deliveryId: `restart-alias-${i}` });
  assert.ok(calls >= 60);
  t.diagnostic(`Differential public begin/settle calls per backend: ${calls}`);
});

for (const scenario of ['missing', 'bare-genesis', 'busy', 'wrong-binding'] as const) test(`startup ${scenario} never adopts storage`, async t => {
  const s = scenario === 'busy' || scenario === 'wrong-binding' ? await initialized(t) : await tableService(t);
  if (scenario === 'bare-genesis') s.rows.set('M', stamp(wireM(), 1));
  const first = createTableDeliveryJournal(tableBinding, s.dependencies);
  if (scenario === 'busy') await first.open();
  const next = createTableDeliveryJournal(scenario === 'wrong-binding' ? { ...tableBinding, kind: 'delivery', scope: { ...scope, appId: 'Other' } } : tableBinding, s.dependencies);
  await assert.rejects(next.open(), code(scenario === 'bare-genesis' ? 'corrupt' : scenario === 'wrong-binding' ? 'corrupt' : scenario));
  if (scenario === 'bare-genesis') { assert.notEqual(s.rows.get('M')?.Owner, ''); await assert.rejects(next.close(), code('unavailable')); }
  else if (format === 2) await assert.rejects(next.close(), code('unavailable'));
  else await next.close();
  await first.close();
});

const corruptions: [string, (s: Awaited<ReturnType<typeof tableService>>) => void, string?][] = [
  ['marker extra field', s => replaceControl(s, 'State', { journal: 'teams-delivery', schema: 1, fingerprint: 1, extra: true })],
  ['marker version', s => replaceControl(s, 'State', { journal: 'teams-delivery', schema: 2, fingerprint: 1 }), 'unsupported-schema'],
  ['result private field', s => replaceControl(s, 'Result', { schema: 1, operation: 'initialize', text: 'not permitted' })],
  ['result unsupported schema', s => replaceControl(s, 'Result', { schema: 2, operation: 'initialize' }), 'unsupported-schema'],
  ['result invalid settle outcome', s => replaceControl(s, 'Result', { schema: 1, operation: 'settle', claim: { idempotencyId: 's', attemptId: 'opaque' }, outcome: { kind: 'delivered' }, result: 'recorded' })],
  ['result mismatched claim identity', s => replaceControl(s, 'Result', { schema: 1, operation: 'begin', identity: { deliveryId: 'd', idempotencyId: 's', digest: 'a'.repeat(64) }, result: { kind: 'claimed', claim: { idempotencyId: 'other', attemptId: '11111111-1111-4111-8111-111111111111' } } })],
  ['result bad claim', s => replaceControl(s, 'Result', { schema: 1, operation: 'begin', identity: { deliveryId: 'd', idempotencyId: 's', digest: 'a'.repeat(64) }, result: { kind: 'claimed', claim: { idempotencyId: 's', attemptId: 'not-uuid' } } })],
  ['unrelated orphan', s => replacePayload(s, 'alias', 'unrelated', { schema: 1, idempotencyId: 'absent' })],
  ['unsupported control', s => replacePayload(s, 'control', 'unrelated', { schema: 1 })],
  ['missing self-alias', s => { s.rows.delete(rowKey('alias', request.idempotencyId)); }],
  ['future epoch', s => replacePayload(s, 'delivery', request.idempotencyId, { ...payload(s.rows.get(rowKey('delivery', request.idempotencyId))!), attemptEpoch: 100 })],
  ['bad UUID', s => replacePayload(s, 'delivery', request.idempotencyId, { ...payload(s.rows.get(rowKey('delivery', request.idempotencyId))!), attemptId: 'not-uuid' })],
  ['operation unsupported schema', s => replacePayload(s, 'delivery', request.idempotencyId, { ...payload(s.rows.get(rowKey('delivery', request.idempotencyId))!), schema: 2 }), 'unsupported-schema'],
  ['operation bad fingerprint', s => replacePayload(s, 'delivery', request.idempotencyId, { ...payload(s.rows.get(rowKey('delivery', request.idempotencyId))!), fingerprint: 2 }), 'unsupported-schema'],
  ['unrelated operation invalid', s => replacePayload(s, 'delivery', 'unrelated', { ...payload(s.rows.get(rowKey('delivery', request.idempotencyId))!), digest: 'bad' })],
  ['zero epoch', s => replacePayload(s, 'delivery', request.idempotencyId, { ...payload(s.rows.get(rowKey('delivery', request.idempotencyId))!), attemptEpoch: 0 })],
  ['missing delivered receipt', s => replacePayload(s, 'delivery', request.idempotencyId, { ...payload(s.rows.get(rowKey('delivery', request.idempotencyId))!), state: 'delivered' })],
  ['unpaired receipt', s => replacePayload(s, 'delivery', request.idempotencyId, { ...payload(s.rows.get(rowKey('delivery', request.idempotencyId))!), providerMessageId: 'wrong-state' })],
  ['duplicate decoded keys', s => replacePayload(s, 'alias', 'unrelated', Buffer.from('{"schema":1,"\\u0073chema":1,"idempotencyId":"absent"}'))],
  ['malformed UTF8', s => replacePayload(s, 'alias', 'unrelated', Buffer.from([0xff]))],
  ['noncanonical number', s => replacePayload(s, 'alias', 'unrelated', Buffer.from('{"schema":1.0,"idempotencyId":"absent"}'))],
];
for (const [name, corrupt, error = 'corrupt'] of corruptions) test(`full graph audit rejects ${name} before readiness and never releases`, async t => {
  const { s, j } = await opened(t); claimed(await j.begin(request)); await j.close(); corrupt(s);
  const before = [...s.rows.entries()].filter(([key]) => key !== 'M');
  const next = createTableDeliveryJournal(tableBinding, s.dependencies); await assert.rejects(next.open(), code(error));
  assert.notEqual(next.status().lifecycle, 'ready'); assert.deepEqual([...s.rows.entries()].filter(([key]) => key !== 'M'), before);
  assert.notEqual(s.rows.get('M')?.Owner, ''); await assert.rejects(next.close(), code('unavailable'));
});

test('more than 100 old sends recover logically unknown without any data rewrites', async t => {
  const { s, j } = await opened(t); const claims: DeliveryClaim[] = [];
  for (let i = 0; i < 103; i++) claims.push(claimed(await j.begin({ ...request, deliveryId: `d-${i}`, idempotencyId: `s-${i}` })));
  await j.close(); const before = [...s.rows.entries()].filter(([key]) => key !== 'M'); let dataWrites = 0;
  s.controls.hook = e => { dataWrites += e.actions.filter(a => a.entity.RowKey !== 'M').length; e.reply(); };
  const next = createTableDeliveryJournal(tableBinding, s.dependencies); await next.open();
  assert.equal(dataWrites, 0); assert.deepEqual([...s.rows.entries()].filter(([key]) => key !== 'M'), before);
  assert.deepEqual(await next.begin({ ...request, deliveryId: 'd-102', idempotencyId: 's-102' }), { kind: 'unknown' });
  assert.equal(await next.settle(claims[102]!, { kind: 'unknown' }), 'unchanged');
  assert.equal(await next.settle(claims[102]!, { kind: 'delivered', providerMessageId: 'late' }), 'stale');
  assert.equal(dataWrites, 0); await next.close();
});
});
