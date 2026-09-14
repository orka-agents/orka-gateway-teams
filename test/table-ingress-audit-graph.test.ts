import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditInbox } from '../src/ingress/table-audit.js';
import { digest, encode } from '../src/ingress/codec.js';
import { code } from './support/owned-audit.js';
import { ingressBinding } from './support/table-service.js';
import { auditBudget, inboxOwned, indexBudget, install, ordinary, pair, wireData } from './support/table-ingress-audit.js';
import { attemptId, sealFixture, stateFixture } from './support/table-ingress.js';

for (const fault of ['event-missing', 'route-missing', 'orphan-route', 'reverse-link', 'target-link', 'body-digest', 'route-digest',
  'unsupported-control', 'unsupported-type', 'records', 'bodies', 'ordinal', 'received-order', 'generation', 'current-generation',
  'missing-seal', 'unused-seal', 'attempt-epoch', 'seal-attempt', 'noncanonical', 'channel', 'role', 'personal'] as const)
  test('native physical graph rejects ' + fault, async t => {
    const { s, k } = await inboxOwned(t); const a = pair(); const b = pair('event-b', 'target-b', 2);
    const state = stateFixture({ records: 2, bodies: 2 }); const seals = [];
    if (fault === 'reverse-link') a.route.externalEventId = b.id;
    if (fault === 'target-link') a.target = 'different';
    if (fault === 'body-digest') a.event.bodyDigest = 'e'.repeat(64);
    if (fault === 'route-digest') a.route.routeDigest = 'e'.repeat(64);
    if (fault === 'records') state.records = 3;
    if (fault === 'bodies') state.bodies = 1;
    if (fault === 'ordinal') b.event.order = 1;
    if (fault === 'received-order') { b.event.received = 99; b.event.nextAttempt = 99; }
    if (fault === 'generation') b.event.generation = 2;
    if (fault === 'current-generation') state.currentGeneration = 2;
    if (fault === 'missing-seal') state.currentGeneration = null;
    if (fault === 'unused-seal') seals.push(sealFixture({ generation: 2, lastOrder: 2, watermark: 100, observation: 90 }));
    if (fault === 'attempt-epoch') Object.assign(a.event, { attempt: 1, attemptId, attemptEpoch: 2 });
    if (fault === 'seal-attempt') {
      Object.assign(a.event, { attempt: 1, attemptId, attemptEpoch: 2 }); state.restartEpoch = 2;
      state.currentGeneration = null; state.lastNow = 150; seals.push(sealFixture({ lastOrder: 2 }));
    }
    if (fault === 'channel') a.route.route.channelId = 'other' as never;
    if (fault === 'role') a.route.route.bot.role = 'user' as never;
    if (fault === 'personal') a.route.route.conversation.conversationType = 'group' as never;
    if (['channel', 'role', 'personal'].includes(fault)) a.route.routeDigest = digest(encode(a.route.route));
    await install(k, { state, pairs: [a, b], seals });
    if (fault === 'event-missing' || fault === 'route-missing') {
      const prefix = fault === 'event-missing' ? 'event_' : 'route_'; s.rows.delete([...s.rows.keys()].find(row => row.startsWith(prefix))!);
    }
    if (fault === 'orphan-route' || fault === 'unsupported-control' || fault === 'unsupported-type') {
      const type = fault === 'orphan-route' ? 'route' : fault === 'unsupported-type' ? 'delivery' : 'control';
      const row = wireData(s, type, 'unsupported', encode(a.route)); s.rows.set(String(row.RowKey), row);
    }
    if (fault === 'noncanonical') {
      const row = wireData(s, 'event', a.id, Buffer.from(' ' + encode(a.event).toString())); s.rows.set(String(row.RowKey), row);
    }
    await assert.rejects(auditInbox(k, ingressBinding, auditBudget, indexBudget), code('unresolved'));
    assert.equal(k.status().lifecycle, 'poisoned'); await assert.rejects(k.close(), code('unresolved'));
  });

for (const fault of ['substitution', 'etag', 'digest', 'timestamp', 'removal'] as const)
  test('pass2 refuses same-count substitution or physical version drift: ' + fault, async t => {
    const { s, k } = await inboxOwned(t); const a = pair(); await install(k, { state: stateFixture(), pairs: [a] });
    let reads = 0;
    s.controls.hook = e => {
      if (e.path.includes(",RowKey='M'") && ++reads === 3) {
        const key = [...s.rows.keys()].find(row => row.startsWith('event_'))!; const row = s.rows.get(key)!;
        if (fault === 'substitution') {
          const other = pair('event-substitution'); const newRow = wireData(s, 'event', other.id, encode(other.event));
          s.rows.delete(key); s.rows.set(String(newRow.RowKey), newRow);
        } else if (fault === 'etag') row['odata.etag'] = 'W/"replacement"';
        else if (fault === 'timestamp') row.Timestamp = '2026-01-02T03:04:06.1234567Z';
        else if (fault === 'removal') s.rows.delete(key);
        else { a.event.nextAttempt++; const replacement = wireData(s, 'event', a.id, encode(a.event));
          replacement['odata.etag'] = row['odata.etag']; s.rows.set(key, replacement); }
      }
      e.reply();
    };
    await assert.rejects(auditInbox(k, ingressBinding, auditBudget, indexBudget), code('unresolved'));
    delete s.controls.hook; assert.equal(reads, 3); await assert.rejects(k.close(), code('unresolved'));
  });

test('reduced captured policy preserves all retained rows and terminal historical boundary', async t => {
  const { k } = await inboxOwned(t); const a = pair(); const b = pair('event-b', 'target-b', 2);
  Object.assign(a.event, { state: 'terminal', body: null, fingerprint: 'b'.repeat(64), bodyDigest: 'c'.repeat(64),
    receipt: { status: 'duplicate', eventId: '\\'.repeat(256), state: 'Completed' } });
  const state = stateFixture({ records: 2, bodies: 1 }); const base = ordinary(state);
  const result = { ...base, operation: 'admit' as const, basis: base.operation === 'complete' ? base.basis : null!, clock: { time: 100 },
    decision: { eventId: 'absent-event', replyTarget: 'absent-target', fingerprint: 'd'.repeat(64),
      policy: { maxRecords: 1, maxPending: 1, replayWindowMs: 100 }, outcome: { kind: 'full' as const } } };
  await install(k, { state, pairs: [a, b], result }); const audited = await auditInbox(k, ingressBinding, auditBudget, indexBudget);
  assert.equal(audited.index.diagnostics().events, 2); assert.equal(audited.index.eventLengths(a.id).bodyEncodingBytes, 0);
  assert.equal(audited.index.eventById(a.id)?.receipt?.eventId.length, 256); audited.dispose(); await k.close();
});
