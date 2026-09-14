import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableIngressStore } from '../src/ingress/table-store.js';
import { relayOne } from '../src/ingress/relay.js';
import { TableError } from '../src/storage/table/types.js';
import { granted, opened, options, state, result, rowKey, payload, code } from './support/table-ingress-store.js';
import { deferred, eventually, ingressBinding } from './support/table-service.js';
import { pair } from './support/table-ingress-audit.js';

for (const disposition of ['retire', 'take', 'expire', 'regress', 'throw', 'invalid'] as const)
  test(`grant ${disposition}: one use, exact clock debt and safe release disposition`, async t => {
    let now = 100; let samples = 0; let fault = false;
    const { s, j, g } = await granted(t, { now() { samples++; if (fault && disposition === 'throw') throw new Error('private'); return fault ? NaN : now; },
      policy: { maxPending: 10, maxRecords: 10, replayWindowMs: 100 } });
    assert.equal(state(s).handoffClockArm !== null, true); assert.equal(await g.revalidate(), true);
    const before = samples;
    if (disposition === 'expire') now = 200;
    if (disposition === 'regress') now = 99;
    if (disposition === 'throw' || disposition === 'invalid') fault = true;
    if (disposition === 'retire') g.retire();
    else if (fault) {
      assert.throws(() => g.take(), code(disposition === 'throw' ? 'unavailable' : 'invalid-input'));
      assert.notEqual(j.status().lifecycle, 'ready');
      assert.throws(() => j.getRoute('absent'), code('unready'));
    }
    else assert.equal(g.take(), disposition === 'take');
    assert.equal(g.take(), false); g.retire(); g.retire();
    if (fault) await assert.rejects(j.close(), code('unresolved')); else await j.close();
    assert.equal(samples, before + (disposition === 'retire' ? 0 : 1));
    assert.equal(state(s).handoffClockArm === null, !fault);
    assert.equal(s.rows.get('M')?.Owner === '', !fault);
    if (!fault) {
      assert.equal(result(s).operation, 'handoff-finalize'); assert.equal(result(s).decision.sampling, disposition === 'retire' ? 'none' : 'captured');
      const next = createTableIngressStore(ingressBinding, s.dependencies, { ...options, now: () => 200 }); await next.open(); await next.close();
    }
    assert.equal(j.status().pending, 0); assert.equal(s.stats.requests, s.stats.socketCloses);
  });

test('sampling exceptions are discarded without reading caller error properties or retaining their context', async t => {
  let fault = false; let inspected = 0;
  const thrown = new TableError('invalid-input');
  Object.defineProperty(thrown, 'code', { get() { inspected++; return 'untrusted-code'; } });
  const { j, g } = await granted(t, { now: () => { if (fault) throw thrown; return 100; } });
  assert.equal(await g.revalidate(), true); fault = true;
  let safe = false; try { g.take(); } catch (error) { safe = code('unavailable')(error); }
  assert.equal(safe, true); assert.equal(inspected, 0); await assert.rejects(j.close(), code('unresolved'));
});

test('untrusted validation exceptions cannot supply error codes or withdraw grant permission', async t => {
  const { j, g } = await granted(t); assert.equal(await g.revalidate(), true); let inspected = 0;
  const thrown = new TableError('invalid-input'); Object.defineProperty(thrown, 'code', { get() { inspected++; return 'untrusted-code'; } });
  const claim = new Proxy(g.claim, { getOwnPropertyDescriptor() { throw thrown; } });
  let safe = false; try { j.retry(claim, 0); } catch (error) { safe = code('unavailable')(error); }
  assert.equal(safe, true); assert.equal(inspected, 0); assert.equal(g.take(), true); await j.close();
});

test('repeated synchronous retirement schedules only one owned finalizer callback', async t => {
  const { j, g } = await granted(t); const enqueue = globalThis.queueMicrotask; let scheduled = 0;
  globalThis.queueMicrotask = callback => { scheduled++; enqueue(callback); };
  try { for (let i = 0; i < 1000; i++) g.retire(); } finally { globalThis.queueMicrotask = enqueue; }
  assert.equal(scheduled, 1); await j.close();
});

test('take without completed revalidation consumes permission without sampling', async t => {
  let samples = 0; const { j, g } = await granted(t, { now: () => { samples++; return 100; } }); const before = samples;
  assert.equal(g.take(), false); assert.equal(await g.revalidate(), false); await j.close(); assert.equal(samples, before);
});

test('concurrent revalidation is refused and retirement cannot revive while a real read is held', async t => {
  const { s, j, g } = await granted(t); const gate = deferred(); let entered = false;
  s.controls.hook = async e => { if (!entered) { entered = true; await gate.promise; } e.reply(); };
  const first = g.revalidate(); await eventually(() => entered);
  await assert.rejects(Promise.resolve(g.revalidate()), code('not-submitted'));
  g.retire(); gate.resolve(); assert.equal(await first, false); delete s.controls.hook;
  await j.close(); assert.equal(state(s).handoffClockArm, null);
});

test('exactly one matching continuation uses reserved frame space; a second needs ordinary capacity', async t => {
  const { s, j, g } = await granted(t, { maxPending: 1 }); assert.equal(await g.revalidate(), true);
  const gate = deferred(); let entered = false;
  s.controls.hook = async e => { if (!entered) { entered = true; await gate.promise; } e.reply(); };
  const first = j.retry(g.claim, 10); assert.equal(g.take(), false); await eventually(() => entered);
  assert.throws(() => j.complete(g.claim, { status: 'accepted', eventId: 'receipt', state: 'Queued' }), code('not-submitted'));
  assert.equal(j.status().pending, 1); assert.equal(j.status().pendingBytes, 8192); assert.equal(j.status().index?.working.frame, 1048576);
  gate.resolve(); assert.equal(await first, true); delete s.controls.hook;
  assert.equal(j.status().pending, 0); assert.equal(j.status().index?.working.frame, 0);
});

test('matching continuation ignores caller event and follows captured clock before its own observation', async t => {
  let now = 100;
  const { s, j, g } = await granted(t, { now: () => now }); assert.equal(await g.revalidate(), true);
  now = 101; assert.equal(g.take(), true); now = 102;
  const claim = { externalEventId: g.claim.externalEventId, attemptId: g.claim.attemptId, attempt: g.claim.attempt,
    get event(): never { throw new Error('must not read body'); } };
  assert.equal(await j.complete(claim, { status: 'accepted', eventId: 'receipt', state: 'Queued' }), true);
  assert.equal(state(s).lastNow, 102); assert.equal(state(s).bodies, 0); assert.equal(state(s).handoffClockArm, null);
  const row = payload(s.rows.get(rowKey('event', claim.externalEventId))!);
  assert.equal(row.body, null); assert.equal(row.receipt.eventId === 'receipt', true);
  assert.equal(await j.retry(claim, 0), false);
});

for (const during of ['claim-refresh', 'revalidate', 'finalizer', 'continuation'] as const)
  test(`close during ${during} allows private confirmed publication, no grant/success, and clean arm flush`, async t => {
    const { s, j } = await opened(t); const p = pair(); await j.admit(p.event.body!, p.route.route);
    let g = during === 'claim-refresh' ? undefined : await j.claimForForwarding();
    if (g && during === 'finalizer') assert.equal(await g.revalidate(), true);
    const gate = deferred(); let entered = false;
    s.controls.hook = async e => {
      const retained = result(s).operation;
      if (!entered && (during === 'claim-refresh' ? e.req.method === 'GET' && e.path.includes("RowKey='event_") && retained === 'claim' :
        during === 'revalidate' ? e.req.method === 'GET' :
          during === 'continuation' ? e.actions.length > 0 && e.actions[0]?.entity.Operation === 'mutate' && retained === 'handoff-finalize' : e.req.method === 'GET')) {
        entered = true; await gate.promise;
      }
      e.reply();
    };
    let work: Promise<unknown> | undefined;
    if (during === 'claim-refresh') work = j.claimForForwarding();
    if (during === 'revalidate') work = Promise.resolve(g!.revalidate());
    if (during === 'finalizer') { assert.equal(g!.take(), true); g!.retire(); }
    if (during === 'continuation') work = j.retry(g!.claim, 10);
    const observed = work?.then(() => 'fulfilled', () => 'rejected');
    await eventually(() => entered); let closed = false; const close = j.close().then(() => { closed = true; });
    assert.equal(g?.take() ?? false, false); assert.equal(j.status().lifecycle, 'closing');
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(closed, false);
    gate.resolve(); delete s.controls.hook; await close;
    if (during === 'claim-refresh' || during === 'continuation') assert.equal(await observed, 'rejected'); else await observed;
    assert.equal(state(s).handoffClockArm, null); assert.equal(s.rows.get('M')?.Owner, ''); assert.equal(j.status().pending, 0);
  });

test('close synchronously rejects ordinary queued work and drains only its existing frame', async t => {
  let samples = 0; const { j, g } = await granted(t, { now: () => { samples++; return 100; } });
  const p = pair('queued', 'queued-target', 2); const queued = j.admit(p.event.body!, p.route.route);
  const rejected = assert.rejects(queued, code('closed')); const before = samples;
  const closing = j.close(); assert.equal(j.status().pending, 1); assert.equal(g.take(), false);
  await rejected; await closing; assert.equal(samples, before); assert.equal(j.status().pending, 0);
});

test('ordinary FIFO waits behind idle frame without sampling; a refused admission changes no grant', async t => {
  let samples = 0; const { s, j, g } = await granted(t, { maxPending: 2, now: () => { samples++; return 100; } });
  assert.equal(await g.revalidate(), true); const before = samples; const p = pair('second', 'second-target', 2);
  const waiting = j.admit(p.event.body!, p.route.route); assert.equal(j.status().pending, 2);
  assert.throws(() => j.getRoute('absent'), code('not-submitted')); assert.equal(samples, before);
  assert.equal(g.take(), true); g.retire(); assert.equal((await waiting).kind, 'accepted'); assert.equal(state(s).handoffClockArm, null);
});

test('invalid matching settlement and reentrant sampling cannot revive or spend a grant twice', async t => {
  let reenter: (() => void) | undefined;
  const { j, g } = await granted(t, { now: () => { const action = reenter; reenter = undefined; action?.(); return 100; } });
  assert.equal(await g.revalidate(), true);
  assert.throws(() => j.retry(g.claim, -1), code('invalid-input'));
  reenter = () => { assert.equal(g.take(), false); g.retire(); };
  assert.equal(g.take(), false); assert.equal(g.take(), false); await j.close();
});

test('asynchronous clock-durability adaptation: captured regression finalizes before later queued clock', async t => {
  let now = 100; const { s, j, g } = await granted(t, { now: () => now }); assert.equal(await g.revalidate(), true);
  now = 99; assert.equal(g.take(), false);
  // Unlike SQLite take, the sample is not yet durable here. The durable arm is
  // what makes a crash fail closed during this explicitly approved interval.
  assert.equal(state(s).lastNow, 100); assert.equal(state(s).currentGeneration, 1); assert.equal(state(s).handoffClockArm !== null, true);
  now = 300; const p = pair('new', 'new-target', 2); assert.equal((await j.admit(p.event.body!, p.route.route)).kind, 'accepted');
  assert.equal(state(s).lastNow, 300); assert.equal(state(s).currentGeneration, 2); assert.equal(state(s).handoffClockArm, null);
  const seal = payload(s.rows.get(rowKey('control', 'generation:1'))!); assert.equal(seal.watermark, 100); assert.equal(seal.observation, 99);
});

test('clock reversal during final synchronous relay take produces zero POSTs', async t => {
  let samples = 0; const { j } = await opened(t, { now: () => ++samples === 5 ? 99 : 100 }); const p = pair(); await j.admit(p.event.body!, p.route.route);
  let posts = 0; assert.equal(await relayOne(j, { async post() { posts++; return { kind: 'retry' }; } }), false);
  await j.close(); assert.equal(posts, 0);
});
