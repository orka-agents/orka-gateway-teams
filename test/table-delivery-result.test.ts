import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { DeliveryOutcome } from '../src/delivery/types.js';
import { code, deliveryFormat, payload, replacePayload, request, rowKey } from './support/table-delivery.js';
import { tableBinding, tableService } from './support/table-service.js';

for (const format of [1, 2] as const) describe(`V${format} delivery retained results`, () => {
const { create: createTableDeliveryJournal, opened, replaceControl } = deliveryFormat(format);
type Service = Awaited<ReturnType<typeof tableService>>;
type History = 'initialize' | 'claimed' | 'inFlight' | 'delivered' | 'rejected' | 'unknown' |
  'recorded' | 'unchanged' | 'ready' | 'old sending' | 'old unknown' | 'opaque stale' | 'missing stale' |
  'digest conflict' | 'stable conflict' | 'delivery conflict';
const receipt = { kind: 'delivered', providerMessageId: 'retained-receipt' } as const;
const outcomes = [{ kind: 'retryable' }, { kind: 'rejected' }, { kind: 'unknown' }, receipt] as const;
const otherAttempt = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function history(t: TestContext, kind: History) {
  const { s, j } = await opened(t);
  if (kind === 'initialize') { await j.close(); return s; }
  const first = await j.begin(request); assert.equal(first.kind, 'claimed');
  if (first.kind !== 'claimed') throw new Error('Expected fixture claim');
  if (kind === 'inFlight') assert.deepEqual(await j.begin(request), { kind: 'inFlight' });
  if (['delivered', 'rejected', 'unknown', 'recorded', 'unchanged', 'ready'].includes(kind)) {
    const outcome: DeliveryOutcome = kind === 'rejected' ? { kind: 'rejected' } : kind === 'unknown' ? { kind: 'unknown' } : kind === 'ready' ? { kind: 'retryable' } : receipt;
    assert.equal(await j.settle(first.claim, outcome), 'recorded');
    if (kind === 'unchanged') assert.equal(await j.settle(first.claim, outcome), 'unchanged');
    if (['delivered', 'rejected', 'unknown'].includes(kind)) assert.deepEqual(await j.begin(request), outcome);
  }
  if (kind === 'opaque stale') assert.equal(await j.settle({ ...first.claim, attemptId: 'opaque' }, receipt), 'stale');
  if (kind === 'missing stale') assert.equal(await j.settle({ ...first.claim, idempotencyId: 'absent' }, receipt), 'stale');
  if (kind === 'digest conflict') assert.deepEqual(await j.begin({ ...request, text: 'different' }), { kind: 'conflict' });
  if (kind === 'stable conflict') assert.deepEqual(await j.begin({ ...request, idempotencyId: request.deliveryId, deliveryId: 'fresh' }), { kind: 'conflict' });
  if (kind === 'delivery conflict') assert.deepEqual(await j.begin({ ...request, idempotencyId: 'fresh' }), { kind: 'conflict' });
  await j.close();
  if (kind === 'old sending' || kind === 'old unknown') {
    const next = createTableDeliveryJournal(tableBinding, s.dependencies); await next.open();
    if (kind === 'old sending') assert.equal(await next.settle(first.claim, { kind: 'unknown' }), 'unchanged');
    else assert.deepEqual(await next.begin(request), { kind: 'unknown' });
    await next.close();
    assert.equal(payload(s.rows.get(rowKey('delivery', request.idempotencyId))!).state, 'sending');
  }
  return s;
}
function changeOperation(s: Service, change: Record<string, unknown>) {
  replacePayload(s, 'delivery', request.idempotencyId, { ...payload(s.rows.get(rowKey('delivery', request.idempotencyId))!), ...change });
}
function result(s: Service): Record<string, unknown> {
  return JSON.parse(Buffer.from(String(s.rows.get('M')!.Result), 'base64').toString()) as Record<string, unknown>;
}
function loseGraph(s: Service) {
  for (const key of [...s.rows.keys()]) if (key !== 'M') s.rows.delete(key);
}
async function refuses(t: TestContext, s: Service) {
  const next = createTableDeliveryJournal(tableBinding, s.dependencies);
  t.after(async () => { await next.close().catch(() => undefined); });
  const before = s.stats.writes; const rows = [...s.rows.entries()].filter(([key]) => key !== 'M');
  await assert.rejects(next.open(), code('corrupt'));
  assert.notEqual(next.status().lifecycle, 'ready');
  assert.throws(() => next.begin(request), code('unavailable'));
  await assert.rejects(next.close(), code('unavailable'));
  assert.notEqual(s.rows.get('M')?.Owner, ''); assert.equal(s.stats.writes - before, 1); // acquisition only
  assert.deepEqual([...s.rows.entries()].filter(([key]) => key !== 'M'), rows);
  assert.equal(s.stats.requests, s.stats.socketCloses);
}

for (const kind of ['claimed', 'inFlight', 'delivered', 'rejected', 'unknown', 'recorded', 'unchanged'] as const) {
  test(`retained ${kind} result forbids readiness, new claim and release after coherent graph deletion`, async t => {
    const s = await history(t, kind); const m = structuredClone(s.rows.get('M'));
    loseGraph(s); assert.equal(s.rows.size, 1); assert.deepEqual(s.rows.get('M'), m);
    // In particular recorded is actual begin -> delivered settlement -> close;
    // only the operation and all aliases are deleted, not the retained receipt.
    await refuses(t, s);
    assert.equal(s.rows.get('M')?.Result, m?.Result);
  });
}

const corruptions: [string, History, (s: Service) => void][] = [
  ['initialize result with data', 'claimed', s => replaceControl(s, 'Result', { schema: 1, operation: 'initialize' })],
  ['missing delivery alias', 'claimed', s => { s.rows.delete(rowKey('alias', request.deliveryId)); }],
  ['begin digest mismatch', 'claimed', s => changeOperation(s, { digest: 'a'.repeat(64) })],
  ['claimed attempt mismatch', 'claimed', s => changeOperation(s, { attemptId: otherAttempt })],
  ['claimed ready state', 'claimed', s => changeOperation(s, { state: 'ready' })],
  ['inFlight ready state', 'inFlight', s => changeOperation(s, { state: 'ready' })],
  ['delivered rejected state', 'delivered', s => changeOperation(s, { state: 'rejected', providerMessageId: null })],
  ['delivered receipt mismatch', 'delivered', s => changeOperation(s, { providerMessageId: 'different' })],
  ['rejected unknown state', 'rejected', s => changeOperation(s, { state: 'unknown' })],
  ['unknown ready state', 'unknown', s => changeOperation(s, { state: 'ready' })],
  ['conflict without retained reason', 'claimed', s => replaceControl(s, 'Result', { ...result(s), result: { kind: 'conflict' } })],
  ['conflict after graph deletion', 'digest conflict', loseGraph],
  ['recorded unknown with only physical sending', 'old sending', s => replaceControl(s, 'Result', { ...result(s), result: 'recorded' })],
  ['unchanged retryable with physical sending', 'old sending', s => replaceControl(s, 'Result', { ...result(s), outcome: { kind: 'retryable' } })],
  ['recorded retryable with rejected state', 'ready', s => changeOperation(s, { state: 'rejected' })],
];
for (const kind of ['recorded', 'unchanged'] as const) {
  corruptions.push(
    [`${kind} opaque attempt`, kind, s => replaceControl(s, 'Result', { ...result(s), claim: { idempotencyId: request.idempotencyId, attemptId: 'opaque' } })],
    [`${kind} different UUID attempt`, kind, s => changeOperation(s, { attemptId: otherAttempt })],
    [`${kind} receipt mismatch`, kind, s => changeOperation(s, { providerMessageId: 'different' })],
    [`${kind} outcome mismatch`, kind, s => changeOperation(s, { state: 'unknown', providerMessageId: null })],
  );
}
for (const [name, kind, damage] of corruptions) test(`retained result graph audit rejects ${name}`, async t => {
  const s = await history(t, kind); damage(s); await refuses(t, s);
});

for (const kind of ['initialize', 'claimed', 'inFlight', 'delivered', 'rejected', 'unknown', 'recorded', 'unchanged', 'ready',
  'old sending', 'old unknown', 'opaque stale', 'missing stale', 'digest conflict', 'stable conflict', 'delivery conflict'] as const) {
  test(`reachable ${kind} result survives owned reopen without rewriting history`, async t => {
    const s = await history(t, kind); const before = [...s.rows.entries()].filter(([key]) => key !== 'M');
    const next = createTableDeliveryJournal(tableBinding, s.dependencies); await next.open();
    assert.equal(next.status().lifecycle, 'ready'); assert.deepEqual([...s.rows.entries()].filter(([key]) => key !== 'M'), before);
    await next.close(); assert.equal(s.rows.get('M')?.Owner, '');
  });
}

for (const outcome of [{ kind: 'retryable' }, { kind: 'rejected' }, { kind: 'unknown' }, receipt] as const) {
  test(`both recorded and unchanged ${outcome.kind} results retain their exact attempt through reopen`, async t => {
    const { s, j } = await opened(t); const first = await j.begin(request);
    assert.equal(first.kind, 'claimed'); if (first.kind !== 'claimed') throw new Error('Expected fixture claim');
    assert.equal(await j.settle(first.claim, outcome), 'recorded'); await j.close();
    const next = createTableDeliveryJournal(tableBinding, s.dependencies); await next.open();
    assert.equal(await next.settle(first.claim, outcome), 'unchanged'); await next.close();
    const last = createTableDeliveryJournal(tableBinding, s.dependencies); await last.open(); await last.close();
    assert.equal(payload(s.rows.get(rowKey('delivery', request.idempotencyId))!).attemptId, first.claim.attemptId);
  });
}

for (const previous of ['recorded', 'unchanged'] as const) for (const outcome of outcomes) {
  test(`retained stale cannot replace matching ${previous}/${outcome.kind} history`, async t => {
    const { s, j } = await opened(t); const first = await j.begin(request);
    assert.equal(first.kind, 'claimed'); if (first.kind !== 'claimed') throw new Error('Expected fixture claim');
    assert.equal(await j.settle(first.claim, outcome), 'recorded');
    if (previous === 'unchanged') assert.equal(await j.settle(first.claim, outcome), 'unchanged');
    await j.close(); replaceControl(s, 'Result', { ...result(s), result: 'stale' });
    await refuses(t, s);
  });
}
for (const outcome of outcomes) test(`retained stale cannot match current-epoch sending/${outcome.kind}`, async t => {
  const { s, j } = await opened(t); const first = await j.begin(request);
  assert.equal(first.kind, 'claimed'); if (first.kind !== 'claimed') throw new Error('Expected fixture claim');
  await j.close();
  // The next acquisition advances M. Forge a digest-valid operation at that epoch
  // so the audit must reject stale for effective sending, not for a future epoch.
  changeOperation(s, { attemptEpoch: Number(s.rows.get('M')!.Epoch) + 1 });
  replaceControl(s, 'Result', { schema: 1, operation: 'settle', claim: first.claim, outcome, result: 'stale' });
  await refuses(t, s);
});
test('retained stale cannot replace old-sending unknown unchanged history', async t => {
  const s = await history(t, 'old sending');
  replaceControl(s, 'Result', { ...result(s), result: 'stale' }); await refuses(t, s);
});

for (const settled of outcomes) for (const attempted of outcomes) {
  if (settled.kind === attempted.kind) continue;
  test(`reachable stale ${settled.kind}/${attempted.kind} survives owned reopen`, async t => {
    const { s, j } = await opened(t); const first = await j.begin(request);
    assert.equal(first.kind, 'claimed'); if (first.kind !== 'claimed') throw new Error('Expected fixture claim');
    assert.equal(await j.settle(first.claim, settled), 'recorded');
    assert.equal(await j.settle(first.claim, attempted), 'stale'); await j.close();
    const before = [...s.rows.entries()].filter(([key]) => key !== 'M'); const saved = s.rows.get('M')!.Result;
    const next = createTableDeliveryJournal(tableBinding, s.dependencies); await next.open();
    assert.equal(next.status().lifecycle, 'ready'); assert.equal(s.rows.get('M')!.Result, saved);
    assert.deepEqual([...s.rows.entries()].filter(([key]) => key !== 'M'), before);
    await next.close(); assert.equal(s.rows.get('M')!.Owner, '');
  });
}
test('reachable stale for a different delivered receipt survives owned reopen', async t => {
  const { s, j } = await opened(t); const first = await j.begin(request);
  assert.equal(first.kind, 'claimed'); if (first.kind !== 'claimed') throw new Error('Expected fixture claim');
  assert.equal(await j.settle(first.claim, receipt), 'recorded');
  assert.equal(await j.settle(first.claim, { kind: 'delivered', providerMessageId: 'different-receipt' }), 'stale'); await j.close();
  const next = createTableDeliveryJournal(tableBinding, s.dependencies); await next.open();
  assert.deepEqual(await next.begin(request), receipt); await next.close();
});
for (const outcome of [{ kind: 'retryable' }, { kind: 'rejected' }, receipt] as const) {
  test(`reachable old-sending stale/${outcome.kind} remains valid across another epoch`, async t => {
    const { s, j } = await opened(t); const first = await j.begin(request);
    assert.equal(first.kind, 'claimed'); if (first.kind !== 'claimed') throw new Error('Expected fixture claim');
    await j.close(); const next = createTableDeliveryJournal(tableBinding, s.dependencies); await next.open();
    assert.equal(await next.settle(first.claim, outcome), 'stale'); await next.close();
    const before = [...s.rows.entries()].filter(([key]) => key !== 'M'); const saved = s.rows.get('M')!.Result;
    const last = createTableDeliveryJournal(tableBinding, s.dependencies); await last.open();
    assert.equal(s.rows.get('M')!.Result, saved); assert.deepEqual([...s.rows.entries()].filter(([key]) => key !== 'M'), before);
    assert.deepEqual(await last.begin(request), { kind: 'unknown' }); await last.close();
  });
}
test('reachable stale for a rotated UUID attempt survives while the new attempt is sending', async t => {
  const { s, j } = await opened(t); const first = await j.begin(request);
  assert.equal(first.kind, 'claimed'); if (first.kind !== 'claimed') throw new Error('Expected fixture claim');
  assert.equal(await j.settle(first.claim, { kind: 'retryable' }), 'recorded'); const current = await j.begin(request);
  assert.equal(current.kind, 'claimed'); if (current.kind !== 'claimed') throw new Error('Expected fixture claim');
  assert.notEqual(current.claim.attemptId, first.claim.attemptId);
  assert.equal(await j.settle(first.claim, receipt), 'stale'); await j.close();
  const next = createTableDeliveryJournal(tableBinding, s.dependencies); await next.open();
  assert.deepEqual(await next.begin(request), { kind: 'unknown' }); await next.close();
});
});
