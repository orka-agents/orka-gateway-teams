import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { code, dataEntity, deliveryFormat, payload, request, rowKey } from './support/table-delivery.js';
import { deferred, eventually, syntheticToken, tableBinding } from './support/table-service.js';
import { reclaimTableDeliveryOperatorV2 } from '../src/delivery/table-recovery.js';
import { budget } from './support/owned-audit.js';

const first = { sessionDigest: 'a'.repeat(64), originDigest: 'b'.repeat(64) };
const later = { ...first, originDigest: 'c'.repeat(64) };
const second = { ...first, sessionDigest: 'd'.repeat(64) };
const third = { ...first, sessionDigest: 'e'.repeat(64) };
const observed = (continuation: boolean) => ({ kind: 'observed', continuation });
const sessionId = (digest: string) => `control_session:${digest}`;

for (const format of [1, 2] as const) describe(`V${format} session correlation`, () => {
  const { create, opened, replaceControl } = deliveryFormat(format);
  test('factory rejects raised or invalid session bounds before any native IO', async t => {
    const { tableService } = deliveryFormat(format); const s = await tableService(t);
    for (const maxSessions of [0, -1, 2.5, 100001, Infinity])
      assert.throws(() => create(tableBinding, s.dependencies, { maxSessions }), code('invalid-input'));
    assert.equal(s.stats.requests, 0);
  });
  test('immutable first origin survives other origins, full capacity and restart without row rewrites', async t => {
    const { s, j } = await opened(t, { maxSessions: 2 });
    assert.equal(typeof j.observeSession, 'function');
    assert.deepEqual(await j.observeSession(first), observed(false));
    const original = structuredClone(s.rows.get(rowKey('control', sessionId(first.sessionDigest))));
    assert.deepEqual(payload(original!), { schema: 1, kind: 'session-observation', sessionDigest: first.sessionDigest, firstOriginDigest: first.originDigest });
    const beforeReplayWrites = s.stats.writes; const beforeReplayM = structuredClone(s.rows.get('M'));
    assert.deepEqual(await j.observeSession(first), observed(false));
    assert.deepEqual(await j.observeSession(later), observed(true));
    assert.deepEqual(await j.observeSession(first), observed(false));
    assert.equal(s.stats.writes, beforeReplayWrites); assert.deepEqual(s.rows.get('M'), beforeReplayM);
    assert.deepEqual(await j.observeSession(second), observed(false));
    const beforeFullWrites = s.stats.writes;
    assert.deepEqual(await j.observeSession(first), observed(false)); assert.deepEqual(await j.observeSession(later), observed(true));
    assert.deepEqual(await j.observeSession(third), { kind: 'full' });
    assert.equal(s.stats.writes, beforeFullWrites);
    assert.deepEqual(s.rows.get(rowKey('control', sessionId(first.sessionDigest))), original);
    assert.equal([...s.rows.values()].filter(r => r.T === 'control').length, 2);
    assert.equal(s.rows.has(rowKey('control', sessionId(third.sessionDigest))), false);
    assert.equal(s.rows.get('M')!.State, Buffer.from('{"journal":"teams-delivery","schema":1,"fingerprint":1}').toString('base64'));
    await j.close();
    const next = create(tableBinding, s.dependencies, { maxSessions: 2 }); await next.open();
    const restartWrites = s.stats.writes; const restartM = structuredClone(s.rows.get('M'));
    assert.deepEqual(await next.observeSession(first), observed(false));
    assert.deepEqual(await next.observeSession(later), observed(true));
    assert.deepEqual(await next.observeSession(third), { kind: 'full' });
    assert.equal(s.stats.writes, restartWrites); assert.deepEqual(s.rows.get('M'), restartM);
    assert.deepEqual(s.rows.get(rowKey('control', sessionId(first.sessionDigest))), original);
    await next.close();
  });
  test('observations and delivery share the same bounded FIFO and snapshot input before suspension', async t => {
    const { s, j } = await opened(t, { maxSessions: 2, maxPending: 3 });
    const gate = deferred(); let held = false;
    s.controls.hook = async e => { if (!held) { held = true; await gate.promise; } e.reply(); };
    const input = { ...first }; const one = j.observeSession(input); input.originDigest = later.originDigest;
    await eventually(() => held);
    const two = j.observeSession(later); const delivery = j.begin(request);
    await assert.rejects(j.observeSession(second), code('busy'));
    assert.equal(j.status().pending, 3);
    gate.resolve(); assert.deepEqual(await one, observed(false)); assert.deepEqual(await two, observed(true));
    assert.equal((await delivery).kind, 'claimed'); delete s.controls.hook;
    assert.equal(j.status().pendingBytes, 0); assert.equal(j.status().pending, 0);
    assert.equal(payload(s.rows.get(rowKey('control', sessionId(first.sessionDigest)))!).firstOriginDigest, first.originDigest);
  });
  test('concurrent first observations commit exactly one CREATE and retained observations make zero writes', async t => {
    const { s, j } = await opened(t); let creates = 0;
    s.controls.hook = e => { creates += e.actions.filter(a => a.entity.T === 'control').length; e.reply(); };
    assert.deepEqual(await Promise.all([j.observeSession(first), j.observeSession(first), j.observeSession(later)]), [observed(false), observed(false), observed(true)]);
    delete s.controls.hook; assert.equal(creates, 1);
    const writes = s.stats.writes; const m = structuredClone(s.rows.get('M'));
    assert.deepEqual(await Promise.all([j.observeSession(first), j.observeSession(later)]), [observed(false), observed(true)]);
    assert.equal(s.stats.writes, writes); assert.deepEqual(s.rows.get('M'), m);
  });
  test('lost observation ACK reconciles one CREATE and increments capacity only once', async t => {
    const { s, j } = await opened(t, { maxSessions: 2 }); let creates = 0;
    s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'mutate') {
      creates += e.actions.filter(a => a.entity.T === 'control').length; e.commit(); e.res.destroy();
    } else e.reply(); };
    assert.deepEqual(await j.observeSession(first), observed(false)); delete s.controls.hook;
    assert.equal(creates, 1); assert.deepEqual(await j.observeSession(first), observed(false));
    assert.deepEqual(await j.observeSession(second), observed(false)); assert.deepEqual(await j.observeSession(third), { kind: 'full' });
    assert.equal([...s.rows.values()].filter(r => r.T === 'control').length, 2);
  });
  for (const order of ['original-first', 'barrier-first'] as const) test(`observation ${order} exact-M lost-ACK race cannot leak capacity or retry old CREATE`, async t => {
    const { s, j } = await opened(t, { maxSessions: 2 });
    let late: (() => boolean) | undefined; let originals = 0; let barriers = 0;
    s.controls.hook = e => {
      if (e.actions[0]?.entity.Operation === 'mutate') { originals++; late = e.commit; e.res.destroy(); }
      else if (e.actions[0]?.entity.Operation === 'barrier') {
        barriers++; if (order === 'original-first') assert.equal(late!(), true);
        e.commit(); if (order === 'barrier-first') assert.equal(late!(), false); e.res.destroy();
      } else e.reply();
    };
    if (order === 'original-first') assert.deepEqual(await j.observeSession(first), observed(false));
    else await assert.rejects(j.observeSession(first), code('unavailable'));
    assert.equal(originals, 1); assert.equal(barriers, 1); delete s.controls.hook; await j.close();
    const next = create(tableBinding, s.dependencies, { maxSessions: 2 }); await next.open();
    assert.deepEqual(await next.observeSession(first), observed(false));
    assert.deepEqual(await next.observeSession(second), observed(false));
    assert.deepEqual(await next.observeSession(third), { kind: 'full' });
    assert.equal([...s.rows.values()].filter(r => r.T === 'control').length, 2); await next.close();
  });
  test('SDK ACK without an actual session commit cannot publish observation or consume capacity', async t => {
    const { s, j } = await opened(t, { maxSessions: 2 });
    s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'mutate') { e.res.writeHead(202); e.res.end(); } else e.reply(); };
    await assert.rejects(j.observeSession(first), code('unavailable')); delete s.controls.hook;
    assert.equal(s.rows.has(rowKey('control', sessionId(first.sessionDigest))), false);
    assert.throws(() => j.observeSession(first), code('unavailable')); await j.close();
    const next = create(tableBinding, s.dependencies, { maxSessions: 2 }); await next.open();
    assert.deepEqual(await next.observeSession(first), observed(false)); assert.deepEqual(await next.observeSession(second), observed(false)); await next.close();
  });
  test('normal observation reads refuse malformed retained session rows instead of returning false', async t => {
    const { s, j } = await opened(t); await j.observeSession(first); const id = sessionId(first.sessionDigest);
    s.rows.set(rowKey('control', id), dataEntity('control', id, { schema: 1, kind: 'session-observation', sessionDigest: first.sessionDigest, firstOriginDigest: 'bad' }));
    const writes = s.stats.writes; await assert.rejects(j.observeSession(first), code('corrupt')); assert.equal(s.stats.writes, writes);
    assert.throws(() => j.observeSession(first), code('unavailable'));
  });
  test('startup counts sessions even when the latest result is an old-shape delivery operation', async t => {
    const { s, j } = await opened(t, { maxSessions: 2 }); await j.observeSession(first); await j.observeSession(second); await j.begin(request); await j.close();
    const next = create(tableBinding, s.dependencies, { maxSessions: 1 }); await assert.rejects(next.open(), code('corrupt')); await next.close().catch(() => undefined);
    assert.equal([...s.rows.values()].filter(r => r.T === 'control').length, 2);
  });
  test('session snapshots share pending-byte backpressure without poison or retained raw frames', async t => {
    const { s, j } = await opened(t, { maxPendingBytes: 350 }); const gate = deferred(); let entered = false;
    s.controls.hook = async e => { if (!entered) { entered = true; await gate.promise; } e.reply(); };
    const active = j.observeSession(first); await eventually(() => entered);
    const bytes = j.status().pendingBytes; assert.ok(bytes > 128 && bytes < 350);
    await assert.rejects(j.observeSession(second), code('busy')); assert.equal(j.status().pendingBytes, bytes);
    gate.resolve(); assert.deepEqual(await active, observed(false)); delete s.controls.hook;
    assert.deepEqual(await j.observeSession(second), observed(false)); assert.equal(j.status().pendingBytes, 0);
  });
  test('delivery receipt replay never observes a session itself', async t => {
    const { s, j } = await opened(t);
    for (const kind of ['final', 'error'] as const) {
      const r = { ...request, kind, deliveryId: kind, idempotencyId: kind };
      const begun = await j.begin(r); assert.equal(begun.kind, 'claimed'); if (begun.kind !== 'claimed') throw new Error('Fixture claim missing');
      const receipt = { kind: 'delivered', providerMessageId: `receipt-${kind}` } as const;
      await j.settle(begun.claim, receipt); await j.observeSession(first);
      assert.deepEqual(await j.begin({ ...r, deliveryId: `${kind}-alias` }), receipt);
    }
    assert.equal([...s.rows.values()].filter(r => r.T === 'control').length, 1);
    await j.close(); const next = create(tableBinding, s.dependencies); await next.open();
    assert.equal((await next.begin({ ...request, deliveryId: 'final', idempotencyId: 'final' })).kind, 'delivered'); await next.close();
  });
  test('invalid observations reject synchronously before IO without executing getters or poisoning', async t => {
    const { s, j } = await opened(t); const requests = s.stats.requests; let reads = 0;
    for (const value of [{ ...first, originDigest: 'B'.repeat(64) }, { ...first, sessionDigest: 'a'.repeat(65) },
      { ...first, extra: true }, { sessionDigest: first.sessionDigest },
      { ...first, get originDigest() { reads++; return first.originDigest; } }]) {
      assert.throws(() => j.observeSession(value as typeof first), code('invalid-input'));
    }
    assert.equal(reads, 0); assert.equal(s.stats.requests, requests); assert.equal(j.status().pending, 0);
    assert.deepEqual(await j.observeSession(first), observed(false));
  });
  for (const damage of ['unknown', 'extra', 'wrong-id', 'invalid-digest', 'missing-field', 'malformed-bytes'] as const)
    test(`startup rejects ${damage} session controls with ownership retained`, async t => {
      const { s, j } = await opened(t); await j.observeSession(first); await j.close();
      const id = sessionId(first.sessionDigest);
      const row = { schema: 1, kind: 'session-observation', sessionDigest: first.sessionDigest, firstOriginDigest: first.originDigest };
      const value = damage === 'unknown' ? { ...row, kind: 'unknown' } : damage === 'extra' ? { ...row, extra: true } :
        damage === 'invalid-digest' ? { ...row, firstOriginDigest: 'bad' } : damage === 'missing-field' ? { schema: 1, kind: row.kind } :
        damage === 'malformed-bytes' ? Buffer.from([0x80]) : row;
      s.rows.set(rowKey('control', id), dataEntity('control', id, value));
      if (damage === 'wrong-id') {
        s.rows.delete(rowKey('control', id)); s.rows.set(rowKey('control', 'control_unknown'), dataEntity('control', 'control_unknown', value));
      }
      const next = create(tableBinding, s.dependencies); await assert.rejects(next.open(), code('corrupt'));
      await next.close().catch(() => undefined); assert.notEqual(s.rows.get('M')!.Owner, '');
    });
  for (const damage of ['continuation', 'created', 'count', 'full'] as const)
    test(`startup crosschecks latest observation ${damage} against retained rows`, async t => {
      const { s, j } = await opened(t, { maxSessions: 2 }); await j.observeSession(first); await j.close();
      const m = s.rows.get('M')!; const saved = JSON.parse(Buffer.from(String(m.Result), 'base64').toString());
      if (damage === 'continuation') saved.result.continuation = true;
      if (damage === 'created') { saved.created = true; saved.observation.originDigest = later.originDigest; }
      if (damage === 'count') saved.sessionCount++;
      if (damage === 'full') { saved.result = { kind: 'full' }; saved.created = false; }
      replaceControl(s, 'Result', saved);
      const next = create(tableBinding, s.dependencies, { maxSessions: 2 }); await assert.rejects(next.open(), code('corrupt')); await next.close().catch(() => undefined);
    });
});

test('V2 uncertain committed observation poisons, drains, then recovery restarts with audited count', async t => {
  const { create, opened } = deliveryFormat(2); const { s, j } = await opened(t, { maxSessions: 2, kernel: { reconciliationReads: 2 } });
  let committed = false;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'mutate') { committed = e.commit(); e.res.destroy(); }
    else if (committed) { e.res.writeHead(503); e.res.end(); } else e.reply(); };
  await assert.rejects(j.observeSession(first), code('unavailable')); assert.throws(() => j.observeSession(second), code('unavailable'));
  await j.close().catch(() => undefined); delete s.controls.hook;
  assert.equal(s.stats.requests, s.stats.socketCloses);
  const m = s.rows.get('M')!;
  const fence = { initId: String(m.InitId), initDigest: String(m.InitDigest), owner: String(m.Owner), epoch: Number(m.Epoch), mDigest: String(m.Digest), etag: String(m['odata.etag']) };
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, fence, budget(), 'f'.repeat(64));
  const next = create(tableBinding, s.dependencies, { maxSessions: 2 }); await next.open();
  assert.deepEqual(await next.observeSession(first), observed(false)); assert.deepEqual(await next.observeSession(second), observed(false));
  assert.deepEqual(await next.observeSession(third), { kind: 'full' }); await next.close();
});

test('V2 observation timeout and close retain active budget until actual token work drains', async t => {
  const { create, initialized } = deliveryFormat(2); const s = await initialized(t); const gate = deferred<string>(); let hold = false; let entered = false;
  const j = create(tableBinding, { ...s.dependencies, token: async (...args) => {
    if (hold) { hold = false; entered = true; return gate.promise; } return s.dependencies.token(...args);
  } }, { kernel: { callTimeoutMs: 1500, cleanupTimeoutMs: 15000 } }); await j.open(); hold = true;
  let finished = false; let stopped = false;
  const rejected = assert.rejects(j.observeSession(first), code('unavailable')).then(() => { finished = true; });
  await eventually(() => entered); const bytes = j.status().pendingBytes;
  await eventually(() => j.status().lifecycle === 'failed');
  assert.equal(finished, false); assert.equal(j.status().pending, 1); assert.equal(j.status().pendingBytes, bytes);
  const close = j.close().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(stopped, false);
  gate.resolve(syntheticToken); await rejected; await close;
  assert.equal(j.status().pending, 0); assert.equal(j.status().pendingBytes, 0); assert.equal(s.stats.requests, s.stats.socketCloses);
});

test('V2 foreign/recovery audits retain sessions, count them on restart and reject foreign unknown controls before writes', async t => {
  const { create, opened } = deliveryFormat(2); const { s, j } = await opened(t, { maxSessions: 2 });
  await j.observeSession(first); await j.observeSession(second); await j.observeSession(third);
  const m = s.rows.get('M')!;
  const fence = { initId: String(m.InitId), initDigest: String(m.InitDigest), owner: String(m.Owner), epoch: Number(m.Epoch), mDigest: String(m.Digest), etag: String(m['odata.etag']) };
  const badId = 'control_unknown'; s.rows.set(rowKey('control', badId), dataEntity('control', badId, { schema: 1, kind: 'unknown' }));
  const writes = s.stats.writes;
  await assert.rejects(reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, fence, budget(), 'f'.repeat(64)));
  assert.equal(s.stats.writes, writes); s.rows.delete(rowKey('control', badId));
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, fence, budget(), 'f'.repeat(64));
  const next = create(tableBinding, s.dependencies, { maxSessions: 2 }); await next.open();
  assert.deepEqual(await next.observeSession(first), observed(false)); assert.deepEqual(await next.observeSession(third), { kind: 'full' });
  await next.close(); await j.close().catch(() => undefined);
});
