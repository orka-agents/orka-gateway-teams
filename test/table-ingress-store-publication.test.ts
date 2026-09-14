import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableIngressStore } from '../src/ingress/table-store.js';
import { opened, options, result, state, rowKey, code } from './support/table-ingress-store.js';
import { deferred, eventually, ingressBinding } from './support/table-service.js';
import { pair, wireData } from './support/table-ingress-audit.js';
import { InboxIndex } from '../src/ingress/table-index.js';

for (const order of ['original-first', 'barrier-first'] as const)
  test(`claim ${order} cancellation proof distinguishes possible arming from a positively cancelled plan`, async t => {
    const { s, j } = await opened(t); const p = pair(); await j.admit(p.event.body!, p.route.route);
    let late: (() => boolean) | undefined; let originals = 0; let barriers = 0;
    s.controls.hook = e => {
      if (e.actions[0]?.entity.Operation === 'mutate') { originals++; late = e.commit; e.res.destroy(); }
      else if (e.actions[0]?.entity.Operation === 'barrier') {
        barriers++; if (order === 'original-first') late!(); e.commit();
        if (order === 'barrier-first') assert.equal(late!(), false); e.res.destroy();
      } else e.reply();
    };
    const claimed = j.claimForForwarding();
    if (order === 'barrier-first') await assert.rejects(claimed, code('not-submitted'));
    else { const grant = await claimed; assert.ok(grant); delete s.controls.hook; grant.retire(); }
    assert.equal(originals, 1); assert.equal(barriers, 1); delete s.controls.hook;
    await j.close(); assert.equal(state(s).handoffClockArm, null); assert.equal(s.rows.get('M')?.Owner, '');
  });

for (const fault of ['transport', 'absent', 'drift'] as const)
  test(`second refresh ${fault} cannot publish the first row or replay confirmed admission`, async t => {
    const { s, j } = await opened(t); const p = pair(); let eventRefreshes = 0; let writes = 0;
    s.controls.hook = e => {
      if (e.actions[0]?.entity.Operation === 'mutate') writes++;
      if (result(s).operation === 'admit' && e.req.method === 'GET') {
        if (e.path.includes("RowKey='event_")) eventRefreshes++;
        if (e.path.includes("RowKey='route_")) {
          if (fault === 'transport') { e.res.writeHead(503); e.res.end(); return; }
          if (fault === 'absent') s.rows.delete(rowKey('route', p.target));
          else s.rows.get(rowKey('route', p.target))!['odata.etag'] = 'W/"external"';
        }
      }
      e.reply();
    };
    // ETag adoption is allowed ONLY for manifested own bytes, including a fresh
    // ETag supplied by the service; an ETag-only change here is not a digest fault.
    if (fault === 'drift') assert.equal((await j.admit(p.event.body!, p.route.route)).kind, 'accepted');
    else await assert.rejects(j.admit(p.event.body!, p.route.route));
    assert.equal(writes, 1); assert.equal(eventRefreshes, 1);
    if (fault !== 'drift') { assert.notEqual(j.status().lifecycle, 'ready'); assert.equal(j.status().index?.events, 0); }
    delete s.controls.hook;
    if (fault === 'absent') { await assert.rejects(j.close(), code('unresolved')); assert.notEqual(s.rows.get('M')?.Owner, ''); }
    else {
      await j.close(); const next = createTableIngressStore(ingressBinding, s.dependencies, options); await next.open();
      assert.equal((await next.admit(p.event.body!, p.route.route)).kind, 'duplicate'); await next.close();
    }
  });

test('admission publication refreshes each manifested row through exactly one healthy M/row/M read', async t => {
  const { s, j } = await opened(t); const p = pair(); const before = s.stats.reads;
  assert.equal((await j.admit(p.event.body!, p.route.route)).kind, 'accepted');
  // Planner: M + two absent keys; reconciliation: M; two refreshes: 3 each.
  assert.equal(s.stats.reads - before, 10); const reads = s.stats.reads;
  await j.getRoute(p.target); assert.equal(s.stats.reads - reads, 3);
});

test('confirmed arm clear survives lost finalizer ACK and permits exactly one clean release', async t => {
  const { s, j } = await opened(t); const p = pair(); await j.admit(p.event.body!, p.route.route);
  const g = await j.claimForForwarding(); assert.ok(g); assert.equal(await g.revalidate(), true);
  let finalizers = 0; let releases = 0;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'mutate') { finalizers++; e.commit(); e.res.destroy(); }
    else { if (e.actions[0]?.entity.Operation === 'release') releases++; e.reply(); }
  };
  assert.equal(g.take(), true); g.retire(); await j.close();
  assert.equal(finalizers, 1); assert.equal(releases, 1); assert.equal(state(s).handoffClockArm, null);
});

test('healthy M-only empty polls commit a clock/result with zero Data point reads', async t => {
  const { s, j } = await opened(t); let dataReads = 0; let mutations = 0;
  s.controls.hook = e => { if (e.req.method === 'GET' && /RowKey='(?:event|route|control)_/u.test(e.path)) dataReads++;
    if (e.actions[0]?.entity.Operation === 'mutate') mutations++; e.reply(); };
  assert.equal(await j.claimForForwarding(), undefined); assert.equal(await j.claimForForwarding(), undefined);
  assert.equal(dataReads, 0); assert.equal(mutations, 2); assert.equal(result(s).operation, 'claim');
});

test('oversized selected companion is rejected before body decoding can overlap it', async t => {
  const { s, j } = await opened(t); const p = pair(); p.event.body!.text = 'x'.repeat(65536); await j.admit(p.event.body!, p.route.route);
  const route = wireData(s, 'route', p.target, Buffer.alloc(16385, 32)); s.rows.set(rowKey('route', p.target), route);
  const lengths = InboxIndex.prototype.eventLengths; let bodyChecks = 0;
  InboxIndex.prototype.eventLengths = function (...args) { bodyChecks++; return lengths.apply(this, args); };
  try { await assert.rejects(j.admit(p.event.body!, p.route.route), code('corrupt')); assert.equal(bodyChecks, 0); }
  finally { InboxIndex.prototype.eventLengths = lengths; }
  await assert.rejects(j.close(), code('unresolved'));
});

test('current M authority contradiction during refresh cannot publish or be healed by a later healthy diagnostic state', async t => {
  const { s, j } = await opened(t); const p = pair(); let original: unknown; let writes = 0;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'mutate') writes++;
    e.reply();
    if (result(s).operation === 'admit' && e.path.includes("RowKey='event_")) {
      const m = s.rows.get('M')!; original = m['odata.etag']; m['odata.etag'] = 'W/"other-authority"';
    }
  };
  await assert.rejects(j.admit(p.event.body!, p.route.route), code('unresolved'));
  assert.equal(j.status().index?.events, 0); assert.equal(writes, 1); delete s.controls.hook;
  s.rows.get('M')!['odata.etag'] = original;
  assert.throws(() => j.getRoute(p.target), code('unready')); await assert.rejects(j.close(), code('unresolved'));
  assert.notEqual(s.rows.get('M')?.Owner, '');
});

test('duplicate detection requires a fresh unchanged event version, not only the old fingerprint index', async t => {
  const { s, j } = await opened(t); const p = pair(); await j.admit(p.event.body!, p.route.route);
  s.rows.get(rowKey('event', p.id))!['odata.etag'] = 'W/"external"'; const writes = s.stats.writes;
  await assert.rejects(j.admit(p.event.body!, p.route.route), code('corrupt'));
  assert.equal(s.stats.writes, writes); await assert.rejects(j.close(), code('unresolved'));
});

test('planner preparation crossing its phase deadline is incomplete before possible arming', async t => {
  const { s, j } = await opened(t, { kernel: { callTimeoutMs: 1500 } }); const p = pair(); await j.admit(p.event.body!, p.route.route);
  const prepare = InboxIndex.prototype.prepare; const before = s.stats.writes;
  InboxIndex.prototype.prepare = function (...args) {
    const token = prepare.apply(this, args);
    if (args[0].state.handoffClockArm) { const until = performance.now() + 1600; while (performance.now() < until) { /* controlled planner hold */ } }
    return token;
  };
  try { await assert.rejects(j.claimForForwarding(), code('incomplete')); }
  finally { InboxIndex.prototype.prepare = prepare; }
  await j.close(); assert.equal(state(s).handoffClockArm, null); assert.equal(s.stats.writes, before + 1); assert.equal(s.rows.get('M')?.Owner, '');
});

test('same phase deadline includes held event refresh and forbids resetting the route refresh budget', async t => {
  const { s, j } = await opened(t, { kernel: { callTimeoutMs: 1000, cleanupTimeoutMs: 5000 } }); const p = pair();
  const gate = deferred(); let entered = false; let routeReads = 0;
  s.controls.hook = async e => {
    if (result(s).operation === 'admit' && e.path.includes("RowKey='event_")) { entered = true; await gate.promise; }
    if (result(s).operation === 'admit' && e.path.includes("RowKey='route_")) routeReads++;
    e.reply();
  };
  const work = assert.rejects(j.admit(p.event.body!, p.route.route)); await eventually(() => entered);
  await new Promise(resolve => setTimeout(resolve, 1100)); gate.resolve(); await work; delete s.controls.hook;
  assert.equal(routeReads, 0); assert.notEqual(j.status().lifecycle, 'ready'); await j.close();
});
