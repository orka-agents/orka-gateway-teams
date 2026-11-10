import assert from 'node:assert/strict';
import test from 'node:test';
import { createTableIngressStore, createTableIngressStoreV3 } from '../src/ingress/table-store.js';
import { createOrkaClient } from '../src/ingress/client.js';
import { relayOne } from '../src/ingress/relay.js';
import { reclaimTableIngressV3 } from '../src/ingress/table-recovery.js';
import { upgradeTableIngressV2 } from '../src/storage/table/upgrade.js';
import { projectEvent } from '../src/ingress/table-state.js';
import { tableService, ingressBinding, deferred } from './support/table-service.js';
import { options, state, rowKey } from './support/table-ingress-store.js';
import { pair, auditBudget, indexBudget } from './support/table-ingress-audit.js';
import { TestClock } from './support/table-v3.js';
import { httpsFixture } from './support/ingress-https.js';

for (const transition of ['expiry', 'manual', 'clean', 'upgrade'] as const) test(`V3 ${transition}: finalized unfinished POST stays uncertain without rewriting history`, async t => {
  const release = deferred(); const handles: { close(): Promise<void> }[] = [];
  t.after(async () => { release.resolve(); await Promise.allSettled(handles.map(h => h.close())); });
  const format = transition === 'upgrade' ? 2 : 3;
  const s = await tableService(t, 'ingress', format); const clock = new TestClock(); const deps = { ...s.dependencies, leaseClock: clock };
  const create = format === 2 ? createTableIngressStore : createTableIngressStoreV3;
  const seedDeps = format === 2 ? s.dependencies : deps;
  const init = create(ingressBinding, seedDeps, options); await init.initialize(); await init.close();
  const j = create(ingressBinding, seedDeps, options); handles.push(j); await j.open(); const p = pair(); await j.admit(p.event.body!, p.route.route);
  const entered = deferred(); let posts = 0;
  const remote = await httpsFixture(t, async (req, res) => {
    posts++; for await (const _ of req) {}
    entered.resolve(); await release.promise;
    res.writeHead(202); res.end('{"status":"accepted","eventId":"remote-receipt","state":"Queued"}');
  });
  const client = createOrkaClient({ ...j.scope, orkaBaseUrl: remote.baseUrl }, { bearerToken: 'synthetic', ca: remote.ca,
    ...(format === 3 ? { authority: j.leaseAuthority() } : {}) });
  let stale = false;
  const old = relayOne(j, client).catch(() => { stale = true; return false; });
  await entered.promise;
  await j.getRoute(p.target); // FIFO barrier: finalize committed, but native POST is still held.
  assert.equal(state(s).handoffClockArm, null); assert.equal(posts, 1);
  const oldRow = structuredClone(s.rows.get(rowKey('event', p.id))!);
  if (transition === 'expiry') clock.advance(125001, false);
  else if (transition === 'manual') {
    const m = s.rows.get('M')!;
    await reclaimTableIngressV3(ingressBinding, deps, { initId: String(m.InitId), initDigest: String(m.InitDigest), owner: String(m.Owner),
      epoch: Number(m.Epoch), mDigest: String(m.Digest), etag: String(m['odata.etag']) }, auditBudget, indexBudget, 'a'.repeat(64));
  } else {
    await j.close();
    if (transition === 'upgrade') {
      s.controls.allowUpgrade = true;
      await upgradeTableIngressV2(ingressBinding, s.dependencies, auditBudget, indexBudget, 'b'.repeat(64));
    }
  }
  const next = createTableIngressStoreV3(ingressBinding, deps, options); handles.push(next); await next.open();
  const replay = await next.claimForForwarding(); replay?.retire();
  release.resolve(); await old; await j.close().catch(() => {});
  assert.equal(replay, undefined, 'an unfinished old POST must never become claimable');
  assert.equal(posts, 1); assert.equal(stale, true, 'old settlement is fenced even after remote completion');
  assert.deepEqual(s.rows.get(rowKey('event', p.id)), oldRow, 'projection never rewrites retained bytes or versions');
  await next.close();
  // Re-audit the empty Result, then a new claimed/completed Result alongside old forwarding history.
  const fresh = createTableIngressStoreV3(ingressBinding, deps, options); handles.push(fresh); await fresh.open();
  const q = pair('fresh-event', 'fresh-target', 2); assert.equal((await fresh.admit(q.event.body!, q.route.route)).kind, 'accepted');
  const grant = await fresh.claimForForwarding(); assert.ok(grant); assert.equal(grant.claim.externalEventId, q.id);
  assert.equal(await grant.revalidate(), true); assert.equal(grant.take(), true);
  assert.equal(await fresh.complete(grant.claim, { status: 'accepted', eventId: 'fresh-receipt', state: 'Queued' }), true);
  await fresh.close();
  const again = createTableIngressStoreV3(ingressBinding, deps, options); handles.push(again); await again.open();
  assert.equal(await again.claimForForwarding(), undefined); await again.close();
  assert.deepEqual(s.rows.get(rowKey('event', p.id)), oldRow); assert.equal(posts, 1);
});

test('V3 projection blocks only old forwarding and keeps deadline/seal precedence; V2 remains pending', () => {
  const p = pair(); const event = { ...p.event, externalEventId: p.id, state: 'forwarding' as const, attempt: 1,
    attemptId: '33333333-3333-4333-8333-333333333333', attemptEpoch: 1 };
  const s = { journal: 'teams-inbox' as const, schema: 1 as const, fingerprintVersion: 1 as const, records: 1, bodies: 1,
    lastNow: event.received, restartEpoch: 2, currentGeneration: 1, handoffClockArm: null };
  assert.equal(projectEvent(event, s).state, 'pending');
  assert.deepEqual(projectEvent(event, s, undefined, true), { state: 'blocked', reason: 'forwarding-uncertain', attemptId: null });
  assert.equal(projectEvent({ ...event, state: 'pending', attemptId: null, attemptEpoch: 0 }, s, undefined, true).state, 'pending');
  assert.equal(projectEvent(event, { ...s, restartEpoch: 1 }, undefined, true).state, 'forwarding');
  assert.equal(projectEvent({ ...event, deadline: s.lastNow }, s, undefined, true).reason, 'deadline');
  const seal = { schema: 1 as const, kind: 'generation-seal' as const, generation: 1, lastOrder: 1, watermark: s.lastNow,
    observation: null, epoch: 1, reason: 'clock-uncertain' as const };
  assert.equal(projectEvent(event, { ...s, currentGeneration: null }, seal, true).reason, 'clock-uncertain');
});
