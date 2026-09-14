import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingressBinding, tableService } from './support/table-service.js';
import { auditBudget, indexBudget, pair } from './support/table-ingress-audit.js';
import { createTableIngressStore } from '../src/ingress/table-store.js';
import { deferred, eventually } from './support/table-service.js';
import { relayOne } from '../src/ingress/relay.js';
import { payload, rowKey } from './support/table-ingress-store.js';

const options = { audit: auditBudget, maxIndexBytes: indexBudget, now: () => 100 };
async function opened(t: Parameters<typeof tableService>[0], extra = {}) {
  const s = await tableService(t, 'ingress', 2);
  await createTableIngressStore(ingressBinding, s.dependencies, options).initialize();
  const j = createTableIngressStore(ingressBinding, s.dependencies, { ...options, ...extra });
  await j.open(); t.after(() => j.close().catch(() => undefined)); return { s, j };
}
const code = (expected: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === expected && !('cause' in e);

test('real relay arms before grant, retires before POST response, and completes with durable retained route', async t => {
  const { s, j } = await opened(t); const p = pair(); await j.admit(p.event.body!, p.route.route);
  let posts = 0; const gate = deferred(); let entered = false;
  const relayed = relayOne(j, { async post() { posts++; entered = true; await gate.promise;
    return { kind: 'receipt', receipt: { status: 'accepted', eventId: 'receipt', state: 'Queued' } }; } });
  await eventually(() => entered);
  await eventually(() => j.status().pending === 0); // Frame does NOT await the provider.
  assert.equal(posts, 1); gate.resolve(); assert.equal(await relayed, true);
  assert.equal(await j.claimForForwarding(), undefined);
  assert.equal((await j.getRoute(p.target))?.serviceUrl === p.route.route.serviceUrl, true);
  await j.close(); const next = createTableIngressStore(ingressBinding, s.dependencies, options); await next.open();
  assert.equal(await next.claimForForwarding(), undefined); await next.close();
});

test('matching early settlement withdraws a grant and runs after unsampled arm finalization without self-deadlock', async t => {
  const { j } = await opened(t, { maxPending: 1 }); const p = pair(); await j.admit(p.event.body!, p.route.route);
  const grant = await j.claimForForwarding(); assert.ok(grant); assert.equal(await grant.revalidate(), true);
  const done = j.retry(grant.claim, 50); assert.equal(grant.take(), false); grant.retire();
  assert.equal(await done, true); assert.equal(j.status().pending, 0);
  assert.equal(await j.claimForForwarding(), undefined);
});

// Missing implementation is an assertion failure, not an unhandled import error.
test('retained native inbox explicitly initializes, opens once, and drains clean ownership', async t => {
  const module = await import('../src/ingress/table-store.js').catch(() => undefined);
  assert.equal(typeof module?.createTableIngressStore, 'function');
  const create = module!.createTableIngressStore;
  const s = await tableService(t, 'ingress', 2);
  let samples = 0;
  const options = { audit: auditBudget, maxIndexBytes: indexBudget, now: () => { samples++; return 100; } };
  const init = create(ingressBinding, s.dependencies, options);
  assert.equal(s.stats.requests, 0); assert.equal(init.status().lifecycle, 'new');
  await init.initialize(); assert.equal(samples, 0); assert.equal(init.status().lifecycle, 'closed');
  assert.equal(s.rows.size, 1); assert.equal(s.rows.get('M')?.Owner, '');
  const j = create(ingressBinding, s.dependencies, options);
  await j.open(); assert.equal(samples, 1); assert.equal(j.status().lifecycle, 'ready');
  await assert.rejects(j.open()); assert.equal(Object.isFrozen(j.scope), true);
  const closing = j.close(); assert.equal(j.close(), closing); await closing;
  assert.equal(j.status().pending, 0); assert.equal(j.status().kernel.pending, 0);
  assert.equal(s.rows.get('M')?.Owner, ''); assert.equal(s.stats.requests, s.stats.socketCloses);
});

test('terminal body release restores pending capacity but not record capacity, with immutable routes and receipt snapshots', async t => {
  const { s, j } = await opened(t, { policy: { maxRecords: 2, maxPending: 1, replayWindowMs: 1000 } });
  const a = pair(); const b = pair('event-b', 'target-b', 2); const c = pair('event-c', 'target-c', 3);
  assert.equal((await j.admit(a.event.body!, a.route.route)).kind, 'accepted');
  assert.equal((await j.admit({ ...a.event.body!, externalEventId: 'collision' }, a.route.route)).kind, 'conflict');
  const duplicate = await j.admit({ ...a.event.body!, replyTarget: 'unused' }, { ...a.route.route, serviceUrl: 'https://different.example.invalid/' });
  assert.equal(duplicate.kind, 'duplicate'); assert.equal(await j.getRoute('unused'), undefined);
  assert.equal((await j.admit(b.event.body!, b.route.route)).kind, 'full');
  const first = await j.claimForForwarding(); assert.ok(first);
  const receipt = { status: 'accepted' as const, eventId: 'saved', state: 'Queued' };
  const complete = j.complete(first.claim, receipt); receipt.eventId = 'mutated'; assert.equal(await complete, true);
  assert.equal(payload(s.rows.get(rowKey('event', a.id))!).receipt.eventId === 'saved', true);
  assert.equal((await j.admit(b.event.body!, b.route.route)).kind, 'accepted');
  const second = await j.claimForForwarding(); assert.ok(second);
  assert.equal(await j.complete(second.claim, { status: 'accepted', eventId: 'second', state: 'Queued' }), true);
  assert.equal((await j.admit(c.event.body!, c.route.route)).kind, 'full');
  assert.equal((await j.getRoute(a.target))?.serviceUrl === a.route.route.serviceUrl, true);
});

test('admission snapshots queued bytes, retains original route, and clocks duplicate/conflict/full but not routes', async t => {
  let now = 100; let samples = 0;
  const { s, j } = await opened(t, { now: () => { samples++; return now; }, policy: { maxRecords: 2, maxPending: 1, replayWindowMs: 1000 } });
  const p = pair(); const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (!held) { held = true; await gate.promise; } e.reply(); };
  const admitted = j.admit(p.event.body!, p.route.route);
  p.event.body!.text = 'mutated input'; p.route.route.serviceUrl = 'https://changed.example.invalid/';
  await eventually(() => held); assert.equal(j.status().pending, 1); gate.resolve(); await admitted; delete s.controls.hook;
  const fresh = pair();
  assert.equal((await j.admit(fresh.event.body!, fresh.route.route)).kind, 'duplicate');
  assert.equal((await j.admit(p.event.body!, p.route.route)).kind, 'conflict');
  const other = pair('other', 'other-target', 2);
  assert.equal((await j.admit(other.event.body!, other.route.route)).kind, 'full');
  const before = samples; now = 0;
  const route = await j.getRoute(fresh.target); assert.equal(route?.serviceUrl === fresh.route.route.serviceUrl, true);
  route!.serviceUrl = 'https://caller.example.invalid/';
  assert.equal((await j.getRoute(fresh.target))?.serviceUrl === fresh.route.route.serviceUrl, true);
  assert.equal(await j.getRoute('absent'), undefined); assert.equal(samples, before);
  assert.equal((await j.admit(fresh.event.body!, fresh.route.route)).kind, 'duplicate'); assert.equal(samples, before + 1);
  await j.close(); const next = createTableIngressStore(ingressBinding, s.dependencies, options); await next.open(); await next.close();
});
