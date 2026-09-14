import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboxOwned, auditBudget, indexBudget, install, pair } from './support/table-ingress-audit.js';
import { ingressBinding } from './support/table-service.js';
import { auditInbox } from '../src/ingress/table-audit.js';
import { stateFixture, sealFixture } from './support/table-ingress.js';

test('native empty inbox completes exactly two passes before returning its charged projection', async t => {
  const { s, k } = await inboxOwned(t);
  const reads = s.stats.reads; const pages = s.stats.pages;
  const result = await auditInbox(k, ingressBinding, auditBudget, indexBudget);
  assert.equal(s.stats.reads - reads, 4); assert.equal(s.stats.pages - pages, 2);
  assert.equal(result.index.state().records, 0);
  assert.equal(result.index.diagnostics().working.meta > 4096, true);
  assert.equal(result.index.diagnostics().working.scratch, 0);
  result.dispose(); assert.equal(result.index.diagnostics().chargedBytes, 0);
  await k.close();
});

for (const sealed of [false, true]) test('native nonempty graph with closed interval: ' + sealed, async t => {
  const { s, k } = await inboxOwned(t); const a = pair(); const b = pair('event-b', 'target-b', 2);
  b.event.received = 160; b.event.nextAttempt = 160; b.event.deadline = 260; b.event.generation = sealed ? 2 : 1;
  await install(k, { state: stateFixture({ records: 2, bodies: 2, lastNow: 160, currentGeneration: sealed ? 2 : 1 }),
    pairs: [a, b], seals: sealed ? [sealFixture()] : [] });
  const reads = s.stats.reads; const pages = s.stats.pages;
  const result = await auditInbox(k, ingressBinding, auditBudget, indexBudget);
  assert.equal(s.stats.reads - reads, 4); assert.equal(s.stats.pages - pages, sealed ? 12 : 10);
  assert.equal(result.index.eventByOrder(2)?.externalEventId === b.id, true);
  assert.equal(result.index.eventLengths(a.id).bodyEncodingBytes > 0, true);
  assert.equal(result.index.diagnostics().events, 2);
  result.dispose(); await k.close();
});
