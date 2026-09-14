import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditInbox } from '../src/ingress/table-audit.js';
import { digest, encode, fingerprint } from '../src/ingress/codec.js';
import { encodeState } from '../src/ingress/table-codec.js';
import { encodeResult, stateDigest } from '../src/ingress/table-result.js';
import { bindTable } from '../src/storage/table/codec.js';
import { createTableKernelV2 } from '../src/storage/table/index.js';
import { code } from './support/owned-audit.js';
import { ingressBinding, tableService } from './support/table-service.js';
import { inboxOwned, auditBudget, indexBudget, install, ordinary, pair } from './support/table-ingress-audit.js';
import { armId, attemptId, stateFixture, sealFixture } from './support/table-ingress.js';

for (const fault of ['fingerprint', 'account', 'sender', 'conversation', 'tenant'] as const)
  test('native full graph refuses locally canonical ' + fault + ' contradiction', async t => {
    const { k } = await inboxOwned(t); const p = pair();
    if (fault === 'fingerprint') p.event.fingerprint = 'b'.repeat(64);
    else if (fault === 'tenant') {
      p.route.route.conversation.tenantId = 'different'; p.route.routeDigest = digest(encode(p.route.route));
    } else {
      if (fault === 'account') p.event.body!.accountId = 'different';
      if (fault === 'sender') p.event.body!.sender.id = p.route.route.bot.id;
      if (fault === 'conversation') p.event.body!.contextId = 'different';
      p.event.bodyDigest = digest(encode(p.event.body));
      p.event.fingerprint = fingerprint(p.event.body!, p.route.route, ingressBinding.scope as never);
    }
    await install(k, { state: stateFixture(), pairs: [p] });
    await assert.rejects(auditInbox(k, ingressBinding, auditBudget, indexBudget), code('unresolved'));
    assert.equal(k.status().lifecycle, 'poisoned'); await assert.rejects(k.close(), code('unresolved'));
  });
for (const fault of ['empty', 'state-digest', 'decision', 'prepared-epoch'] as const)
  test('native retained result refuses ' + fault, async t => {
    const { k } = await inboxOwned(t); const state = stateFixture({ records: 0, bodies: 0, currentGeneration: null, lastNow: 0,
      restartEpoch: fault === 'prepared-epoch' ? 2 : 1 });
    const result = ordinary(state);
    if (fault === 'state-digest') result.postStateDigest = 'f'.repeat(64);
    if (fault === 'decision' && result.operation === 'complete') result.decision.applied = true;
    await k.mutate({ input: Buffer.alloc(0), keys: [] }, () => ({ state: encodeState(state),
      result: fault === 'empty' ? Buffer.alloc(0) : encodeResult(result), actions: [] }));
    await assert.rejects(auditInbox(k, ingressBinding, auditBudget, indexBudget), code('unresolved'));
    await assert.rejects(k.close(), code('unresolved'));
  });
test('bare acquired genesis is never domain initialization authority', async t => {
  const s = await tableService(t, 'ingress', 2); const k = createTableKernelV2(ingressBinding, s.dependencies);
  await k.initialize(); await k.acquire();
  await assert.rejects(auditInbox(k, ingressBinding, auditBudget, indexBudget), code('unresolved'));
  await assert.rejects(k.close(), code('unresolved'));
});
for (const later of [false, true]) test('ordinary earlier seal must fit prepared domain epoch, later acquisition: ' + later, async t => {
  const { s, k } = await inboxOwned(t); const state = stateFixture({ lastNow: 150, currentGeneration: null });
  await install(k, { state, pairs: [pair()], seals: [sealFixture({ epoch: 2 })] });
  let current = k;
  if (later) { await k.close(); current = createTableKernelV2(ingressBinding, s.dependencies); await current.acquire(); }
  await assert.rejects(auditInbox(current, ingressBinding, auditBudget, indexBudget), code('unresolved'));
  await assert.rejects(current.close(), code('unresolved'));
});
for (const later of [false, true]) test('a revalidated sealed arm remains audit evidence at a later kernel epoch: ' + later, async t => {
  const { s, k } = await inboxOwned(t); const p = pair(); Object.assign(p.event, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  const arm = { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId };
  const state = stateFixture({ lastNow: 150, currentGeneration: null, handoffClockArm: arm });
  await install(k, { state, pairs: [p], seals: [sealFixture()], result: {
    schema: 1, operation: 'revalidate', epoch: 1,
    basis: { records: 1, bodies: 1, lastNow: 150, restartEpoch: 1, currentGeneration: 1, arm }, clock: { time: 140 },
    decision: { armId, eligible: false }, postStateDigest: stateDigest(bindTable(ingressBinding), encodeState(state)),
  } });
  let current = k;
  if (later) { await k.close(); current = createTableKernelV2(ingressBinding, s.dependencies); await current.acquire(); }
  const audited = await auditInbox(current, ingressBinding, auditBudget, indexBudget);
  assert.equal(audited.header.state.handoffClockArm?.ownerEpoch, 1); assert.equal(audited.header.metadata.epoch, later ? 2 : 1);
  assert.equal(audited.index.sealByGeneration(1)?.reason, 'clock-regression'); audited.dispose(); await current.close();
});

for (const fault of ['none', 'owner', 'order', 'generation', 'attempt', 'not-forwarding'] as const)
  test('arm binds physical attempt without becoming normal-open permission: ' + fault, async t => {
    const { k } = await inboxOwned(t); const p = pair(); Object.assign(p.event, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
    const arm = { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId };
    if (fault === 'owner') arm.ownerEpoch = 2;
    if (fault === 'order') arm.order = 2;
    if (fault === 'generation') arm.generation = 2;
    if (fault === 'attempt') arm.attemptId = '33333333-3333-4333-8333-333333333333';
    if (fault === 'not-forwarding') p.event.state = 'pending';
    // Legal structural order/generation faults use two physical rows.
    const second = pair('event-b', 'target-b', 2);
    const state = stateFixture({ records: 2, bodies: 2, handoffClockArm: arm });
    if (fault === 'generation') arm.order = 2;
    const result = { schema: 1 as const, operation: 'claim' as const, epoch: 1,
      basis: { records: 2, bodies: 2, lastNow: 100, restartEpoch: 1, currentGeneration: 1, arm: null }, clock: { time: 100 },
      decision: { kind: 'claimed' as const, eventId: p.id, attemptId, attempt: 1 }, postStateDigest: stateDigest(bindTable(ingressBinding), encodeState(state)) };
    await install(k, { state, pairs: [p, second], result });
    if (fault === 'none') {
      const audited = await auditInbox(k, ingressBinding, auditBudget, indexBudget);
      assert.equal(audited.header.state.handoffClockArm?.id === armId, true); audited.dispose(); await k.close();
    } else {
      await assert.rejects(auditInbox(k, ingressBinding, auditBudget, indexBudget), code('unresolved'));
      await assert.rejects(k.close(), code('unresolved'));
    }
  });
