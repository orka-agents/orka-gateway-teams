import assert from 'node:assert/strict';
import https from 'node:https';
import { describe, test } from 'node:test';
import type { DeliveryOutcome } from '../src/delivery/types.js';
import type { DeliveryRequest } from '../src/protocol/types.js';
import { code, deliveryFormat, payload, replacePayload, request, rowKey } from './support/table-delivery.js';
import { deferred, eventually, syntheticToken, tableBinding } from './support/table-service.js';

for (const format of [1, 2] as const) describe(`V${format} delivery races and budgets`, () => {
const { create: createTableDeliveryJournal, initialized, opened, tableService } = deliveryFormat(format);
const receipt = { kind: 'delivered', providerMessageId: 'saved-receipt' } as const;
const pause = () => new Promise(r => setTimeout(r, 30));
async function claim(j: ReturnType<typeof createTableDeliveryJournal>, r = request) {
  const result = await j.begin(r); assert.equal(result.kind, 'claimed');
  if (result.kind !== 'claimed') throw new Error('Expected fixture claim'); return result.claim;
}
for (const phase of ['begin', 'settle'] as const) test(`lost ${phase} ACK reconciles once without another grant or lost receipt`, async t => {
  const { s, j } = await opened(t); const initial = phase === 'settle' ? await claim(j) : undefined; let lost = 0;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'mutate') { lost++; e.commit(); e.res.destroy(); } else e.reply(); };
  const c = initial ?? await claim(j); if (initial) assert.equal(await j.settle(c, receipt), 'recorded');
  assert.equal(lost, 1); delete s.controls.hook;
  assert.deepEqual(await j.begin(request), initial ? receipt : { kind: 'inFlight' });
  assert.equal(await j.settle(c, receipt), initial ? 'unchanged' : 'recorded');
  await j.close(); const next = createTableDeliveryJournal(tableBinding, s.dependencies); await next.open();
  assert.deepEqual(await next.begin(request), receipt); await next.close();
});
for (const phase of ['begin', 'settle'] as const) for (const order of ['original-first', 'barrier-first'] as const)
  test(`${phase} ${order} exact barrier race with lost ACK fences queued old writer`, async t => {
    const { s, j } = await opened(t); const c = phase === 'settle' ? await claim(j) : undefined;
    let late: (() => boolean) | undefined; let originals = 0; let barriers = 0;
    s.controls.hook = e => {
      if (e.actions[0]?.entity.Operation === 'mutate') { originals++; late = e.commit; e.res.destroy(); }
      else if (e.actions[0]?.entity.Operation === 'barrier') {
        barriers++; if (order === 'original-first') late!(); e.commit();
        if (order === 'barrier-first') assert.equal(late!(), false); e.res.destroy();
      } else e.reply();
    };
    const result = c ? j.settle(c, receipt) : j.begin(request);
    if (order === 'barrier-first') await assert.rejects(result, code('unavailable'));
    else if (c) assert.equal(await result, 'recorded'); else assert.equal((await result as { kind: string }).kind, 'claimed');
    assert.equal(originals, 1); assert.equal(barriers, 1);
    delete s.controls.hook; await j.close();
    const next = createTableDeliveryJournal(tableBinding, s.dependencies); await next.open();
    if (order === 'barrier-first') assert.equal(late!(), false);
    const replay = await next.begin(request);
    assert.equal(replay.kind, c ? order === 'original-first' ? 'delivered' : 'unknown' : order === 'original-first' ? 'unknown' : 'claimed');
    await next.close();
  });

for (const boundary of ['token', 'cleanup', 'native-close'] as const) test(`real caller timer at ${boundary} holds port promise, active budget and shutdown until kernel drain`, async t => {
  const s = await initialized(t); const gate = deferred<string>(); let holdToken = false; let entered = false;
  const j = createTableDeliveryJournal(tableBinding, { ...s.dependencies, token: async (...args) => {
    if (holdToken) { holdToken = false; entered = true; return gate.promise; } return s.dependencies.token(...args);
  } }, { maxPending: 1, kernel: { callTimeoutMs: 1500, cleanupTimeoutMs: 15000 } });
  await j.open(); const c = boundary === 'cleanup' ? await claim(j) : undefined;
  let nativeRelease: (() => void) | undefined;
  if (boundary === 'token') holdToken = true;
  if (boundary === 'cleanup') s.controls.hook = async e => {
    if (e.actions[0]?.entity.Operation === 'mutate') { e.commit(); e.res.destroy(); }
    else if (!entered && s.rows.get('M')?.Operation === 'mutate' && payload(s.rows.get(rowKey('delivery', request.idempotencyId))!).state === 'delivered') {
      entered = true; await gate.promise; e.reply();
    } else e.reply();
  };
  if (boundary === 'native-close') {
    s.controls.hook = () => { entered = true; };
    s.controls.request = ((...args: Parameters<typeof https.request>) => {
      const req = s.request(...args); const destroy = req.destroy.bind(req);
      req.destroy = () => { nativeRelease = () => { destroy(); }; return req; }; return req;
    }) as typeof https.request;
  }
  let finished = false; let stopped = false;
  const operation = c ? j.settle(c, receipt) : j.begin(request);
  const rejected = assert.rejects(operation, code('unavailable')).then(() => { finished = true; });
  await eventually(() => entered); const bytes = j.status().pendingBytes;
  await eventually(() => j.status().lifecycle === 'failed');
  assert.equal(finished, false); assert.equal(j.status().pending, 1); assert.equal(j.status().pendingBytes, bytes);
  assert.equal(j.status().kernel.pending, 1); assert.throws(() => j.begin(request), code('unavailable'));
  const close = j.close().then(() => { stopped = true; }); await pause(); assert.equal(stopped, false); assert.equal(finished, false);
  delete s.controls.hook; delete s.controls.request;
  gate.resolve(syntheticToken); if (boundary === 'native-close') { await eventually(() => !!nativeRelease); nativeRelease!(); }
  await rejected; await close;
  assert.equal(j.status().pending, 0); assert.equal(j.status().pendingBytes, 0); assert.equal(j.status().kernel.pending, 0);
  assert.equal(s.rows.get('M')?.Owner, ''); assert.equal(s.stats.requests, s.stats.socketCloses);
});

test('bounded FIFO snapshots identity and settlement before queue; overload is nonpoisoning and count includes active work', async t => {
  const { s, j } = await opened(t, { maxPending: 2 }); const c = await claim(j);
  const gate = deferred(); let entered = false;
  s.controls.hook = async e => { if (!entered && e.req.method === 'GET') { entered = true; await gate.promise; } e.reply(); };
  const input = { ...request, deliveryId: 'queued-alias' }; const first = j.begin(input); input.text = 'mutated'; input.deliveryId = 'mutated-alias';
  await eventually(() => entered);
  const claimCopy = { ...c }; const outcome: DeliveryOutcome = { ...receipt }; const second = j.settle(claimCopy, outcome);
  claimCopy.attemptId = 'changed'; outcome.providerMessageId = 'changed';
  assert.equal(j.status().pending, 2); await assert.rejects(j.begin(request), code('busy')); assert.equal(j.status().lifecycle, 'ready');
  gate.resolve(); await first; assert.equal(await second, 'recorded'); delete s.controls.hook;
  assert.equal(s.rows.has(rowKey('alias', 'queued-alias')), true); assert.equal(s.rows.has(rowKey('alias', 'mutated-alias')), false);
  assert.deepEqual(await j.begin(request), receipt); assert.equal(j.status().pending, 0);
});

test('byte saturation uses only finite identity snapshots, rejects before queue and permits later healthy work', async t => {
  const { s, j } = await opened(t, { maxPendingBytes: 400 }); const gate = deferred(); let entered = false;
  s.controls.hook = async e => { if (!entered) { entered = true; await gate.promise; } e.reply(); };
  const first = j.begin({ ...request, text: 'x'.repeat(64000) }); await eventually(() => entered);
  assert.ok(j.status().pendingBytes < 400); const before = j.status();
  await assert.rejects(j.begin({ ...request, idempotencyId: 's'.repeat(256), deliveryId: 'd'.repeat(256) }), code('busy'));
  assert.deepEqual(j.status(), before); gate.resolve(); await first; delete s.controls.hook;
  assert.equal(j.status().pendingBytes, 0); assert.equal(j.status().lifecycle, 'ready');
  assert.deepEqual(await j.begin({ ...request, text: 'x'.repeat(64000) }), { kind: 'inFlight' });
});

test('invalid request/claim/outcome/getters reject synchronously without queued work, auth or poison', async t => {
  const { s, j } = await opened(t); let getters = 0; const before = s.stats.requests;
  for (const bad of [{ ...request, text: '\ud800' }, { ...request, accountId: 'wrong' }, { ...request, text: undefined },
    { ...request, extra: true }, { ...request, get text() { getters++; return 'value'; } }])
    assert.throws(() => j.begin(bad as DeliveryRequest), code('invalid-input'));
  for (const c of [{ idempotencyId: '', attemptId: 'a' }, { idempotencyId: 's', attemptId: '\ud800' }])
    assert.throws(() => j.settle(c, { kind: 'unknown' }), code('invalid-input'));
  for (const o of [{ kind: 'delivered', providerMessageId: '' }, { kind: 'unknown', providerMessageId: 'extra' }])
    assert.throws(() => j.settle({ idempotencyId: 's', attemptId: 'opaque' }, o as DeliveryOutcome), code('invalid-input'));
  assert.equal(getters, 0); assert.equal(j.status().pending, 0); assert.equal(s.stats.requests, before); await claim(j);
});

for (const fault of ['target', 'self-alias', 'second-target', 'drift'] as const) test(`dynamic begin validates ${fault} before a would-be conflict and poisons without alias writes`, async t => {
  const { s, j } = await opened(t); await claim(j);
  const other = { ...request, idempotencyId: 'other', deliveryId: 'other-delivery' }; await claim(j, other);
  let reads = 0;
  if (fault === 'target') replacePayload(s, 'delivery', request.idempotencyId, { ...payload(s.rows.get(rowKey('delivery', request.idempotencyId))!), attemptId: 'bad' });
  if (fault === 'self-alias') s.rows.delete(rowKey('alias', request.idempotencyId));
  if (fault === 'second-target') s.rows.delete(rowKey('delivery', other.idempotencyId));
  if (fault === 'drift') s.controls.hook = e => {
    if (e.path.includes(`RowKey='${rowKey('alias', request.deliveryId)}'`) && ++reads === 2)
      replacePayload(s, 'alias', request.deliveryId, { schema: 1, idempotencyId: 'other' });
    e.reply();
  };
  const before = s.stats.writes;
  await assert.rejects(j.begin({ ...request, idempotencyId: request.deliveryId, deliveryId: other.deliveryId }), code('corrupt'));
  assert.equal(s.stats.writes, before); assert.notEqual(s.rows.get('M')?.Owner, '');
  assert.throws(() => j.begin(request), code('unavailable')); await assert.rejects(j.close(), code('unavailable'));
});

// V2 requires rejection/retention here; its held-native/token counterparts live in the startup guard suite.
if (format === 1) for (const phase of ['acquire', 'scan'] as const) test(`close during late ${phase} cannot publish readiness and waits for actual startup`, async t => {
  const s = await initialized(t); const gate = deferred(); let entered = false; let ended = false;
  s.controls.hook = async e => {
    if (!entered && (phase === 'acquire' ? e.actions[0]?.entity.Operation === 'acquire' : e.req.method === 'GET' && !e.path.includes('RowKey='))) {
      entered = true; await gate.promise;
    } e.reply();
  };
  const j = createTableDeliveryJournal(tableBinding, s.dependencies); const opening = j.open(); const rejected = assert.rejects(opening);
  await eventually(() => entered); const close = j.close().then(() => { ended = true; }); await pause(); assert.equal(ended, false);
  gate.resolve(); await rejected; await close; assert.equal(j.status().lifecycle, 'closed'); assert.equal(s.rows.get('M')?.Owner, '');
  assert.throws(() => j.begin(request), code('closed'));
});

test('uncertain startup retains possible ownership, drains locally, and never claims release', async t => {
  const s = await initialized(t); let acquired = false;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'acquire') { acquired = true; e.commit(); e.res.destroy(); }
    else if (acquired) { e.res.writeHead(503); e.res.end(); } else e.reply(); };
  const j = createTableDeliveryJournal(tableBinding, s.dependencies, { kernel: { reconciliationReads: 2 } });
  await assert.rejects(j.open(), code('unavailable')); assert.equal(j.status().kernel.ownership, 'possible');
  await assert.rejects(j.close(), code('unavailable')); assert.notEqual(s.rows.get('M')?.Owner, '');
  assert.equal(s.stats.requests, s.stats.socketCloses);
});

test('standard FIFO admits 96 snapshots, has no hidden waiters, and grants one attempt for identical concurrent begins', async t => {
  const { s, j } = await opened(t); const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (!held) { held = true; await gate.promise; } e.reply(); };
  const pending = Array.from({ length: 96 }, () => j.begin(request));
  assert.equal(j.status().pending, 96); await assert.rejects(j.begin(request), code('busy'));
  gate.resolve(); const results = await Promise.all(pending); delete s.controls.hook;
  assert.equal(results.filter(r => r.kind === 'claimed').length, 1);
  assert.equal(results.filter(r => r.kind === 'inFlight').length, 95);
  assert.equal(j.status().pending, 0); assert.equal(j.status().pendingBytes, 0);
  assert.deepEqual(await j.begin(request), { kind: 'inFlight' });
});

test('failed partial initialization remains present and cannot resume, reset or be adopted', async t => {
  const s = await tableService(t); s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'mutate') { e.res.writeHead(202); e.res.end(); } else e.reply();
  };
  const j = createTableDeliveryJournal(tableBinding, s.dependencies); await assert.rejects(j.initialize(), code('unavailable')); await j.close();
  delete s.controls.hook; assert.equal(s.rows.size, 1);
  const init = createTableDeliveryJournal(tableBinding, s.dependencies); await assert.rejects(init.initialize(), code('exists'));
  if (format === 2) await assert.rejects(init.close(), code('unavailable')); else await init.close();
  const next = createTableDeliveryJournal(tableBinding, s.dependencies); await assert.rejects(next.open(), code('corrupt'));
  await assert.rejects(next.close(), code('unavailable')); assert.notEqual(s.rows.get('M')?.Owner, '');
});
});
