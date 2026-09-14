import assert from 'node:assert/strict';
import https from 'node:https';
import { test } from 'node:test';
import { createTableDeliveryJournal, createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import { code, initialized, request } from './support/table-delivery.js';
import { deleteFirstGraph, recoveryHistory } from './support/table-delivery-v2.js';
import { deferred, eventually, syntheticToken, tableBinding, tableService } from './support/table-service.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 30));
for (const budget of ['pages', 'time', 'bytes'] as const) test(`V2 ${budget}-incomplete coherent-deletion audit cannot launder unchecked recovery via early release`, async t => {
  const { s, exit } = await recoveryHistory(t, true); deleteFirstGraph(s);
  const frozen = [...s.rows.entries()].map(([key, value]) => [key, structuredClone(value)] as const);
  const gate = deferred(); let entered = false; let releases = 0;
  s.controls.hook = async e => {
    if (e.actions[0]?.entity.Operation === 'release') releases++;
    if (budget === 'time' && e.req.method === 'GET' && !e.path.includes('RowKey=')) { entered = true; await gate.promise; }
    e.reply();
  };
  const j = createTableDeliveryJournalV2(tableBinding, s.dependencies, { kernel: {
    scanPages: budget === 'pages' ? 1 : 10000, scanBytes: budget === 'bytes' ? 1 : 64 * 1024 * 1024,
    callTimeoutMs: budget === 'time' ? 1000 : 30000,
  } });
  let done = false; const opening = assert.rejects(j.open(), code('unavailable')).then(() => { done = true; });
  if (budget === 'time') {
    await eventually(() => entered); await eventually(() => j.status().lifecycle === 'failed');
    // Legacy native HTTP deadlines drain before the held service handler replies.
    gate.resolve();
  }
  await opening; assert.equal(done, true);
  let rejected = false; try { await j.close(); } catch (error) { rejected = code('unavailable')(error); }
  assert.equal(s.rows.get('M')!.Exit === exit, true); assert.equal(releases, 0);
  assert.equal(s.rows.get('M')!.Owner !== '', true); assert.equal(rejected, true);
  assert.throws(() => j.begin(request), code('closed'));
  delete s.controls.hook;
  const next = createTableDeliveryJournalV2(tableBinding, s.dependencies);
  await assert.rejects(next.open(), code('busy')); await next.close().catch(() => undefined);
  assert.equal(s.rows.get('M')!.Exit === exit, true);
  // Exact same owner-empty tampered bytes in a separate reader oracle: a complete
  // scan must fail corrupt, rather than the first incomplete audit hiding damage.
  const complete = await tableService(t, 'delivery', 2);
  for (const [key, value] of frozen) complete.rows.set(key, value);
  const full = createTableDeliveryJournalV2(tableBinding, complete.dependencies);
  await assert.rejects(full.open(), code('corrupt')); await assert.rejects(full.close(), code('unavailable'));
  assert.equal(complete.rows.get('M')!.Exit === exit, true);
});

for (const phase of ['acquire-post', 'acquire-confirmation', 'scan-page', 'scan-final-authority', 'acquire-token'] as const)
  for (const recovered of [false, true]) test(`V2 close at held ${phase}, recovery necessity ${recovered ? 'present' : 'unknown/clean'}, invalidates before release and retains actual drain`, async t => {
    const s = recovered ? (await recoveryHistory(t)).s : await tableService(t, 'delivery', 2);
    if (!recovered) { const init = createTableDeliveryJournalV2(tableBinding, s.dependencies); await init.initialize(); }
    const exit = s.rows.get('M')!.Exit; const writes = s.stats.writes;
    const gate = deferred(); const tokenGate = deferred<string>(); let entered = false; let acquired = false; let pages = 0; let releases = 0; let tokenCalls = 0;
    let nativeRelease: (() => void) | undefined;
    if (phase === 'acquire-post') s.controls.request = ((...args: Parameters<typeof https.request>) => {
      const req = s.request(...args);
      if (req.method === 'POST') { const destroy = req.destroy.bind(req); nativeRelease = () => { destroy(); }; req.destroy = () => req; }
      return req;
    }) as typeof https.request;
    s.controls.hook = async e => {
      const operation = e.actions[0]?.entity.Operation;
      if (operation === 'release') releases++;
      if (operation === 'acquire') { acquired = true; if (phase === 'acquire-confirmation') { e.commit(); e.res.destroy(); return; } }
      const page = e.req.method === 'GET' && !e.path.includes("RowKey='");
      if (page) pages++;
      const hold = phase === 'acquire-post' ? operation === 'acquire' : phase === 'acquire-confirmation' ? acquired && e.req.method === 'GET' :
        phase === 'scan-page' ? page : phase === 'scan-final-authority' ? pages === s.rows.size && e.path.includes("RowKey='M'") : false;
      if (!entered && hold) { if (phase === 'acquire-post') e.commit(); entered = true; await gate.promise; }
      e.reply();
    };
    const j = createTableDeliveryJournalV2(tableBinding, { ...s.dependencies, token: async (...args) => {
      if (++tokenCalls === 2 && phase === 'acquire-token') { entered = true; return tokenGate.promise; } return s.dependencies.token(...args);
    } });
    let opened = false; const opening = j.open().then(() => { opened = true; }, () => undefined);
    await eventually(() => entered); let ended = false; let rejected = false;
    const close = j.close().then(() => { ended = true; }, error => { ended = true; rejected = code('unavailable')(error); });
    assert.equal(j.status().lifecycle, 'closing'); assert.equal(j.close() === j.close(), true);
    await pause(); assert.equal(ended, false); assert.equal(j.status().kernel.pending, 1); assert.equal(opened, false);
    assert.throws(() => j.begin(request), code('closed')); assert.equal(releases, 0);
    gate.resolve(); tokenGate.resolve(syntheticToken);
    if (phase === 'acquire-post') nativeRelease!();
    await opening; await close;
    assert.equal(s.rows.get('M')!.Exit === exit, true); assert.equal(releases, 0);
    assert.equal(s.stats.writes - writes, phase === 'acquire-token' ? 0 : 1);
    assert.equal(rejected, true); assert.equal(opened, false);
    assert.equal(s.rows.get('M')!.Owner !== '', phase !== 'acquire-token');
    assert.equal(j.status().lifecycle, 'closed'); assert.equal(j.status().kernel.pending, 0);
    assert.equal(s.stats.requests, s.stats.socketCloses);
  });

for (const boundary of ['token', 'native-close'] as const) test(`V2 incomplete scan at ${boundary} holds real work credits and shutdown after caller expiry`, async t => {
  const { s, exit } = await recoveryHistory(t); let scanning = false; let entered = false; let releases = 0;
  const gate = deferred<string>(); let nativeRelease: (() => void) | undefined;
  const j = createTableDeliveryJournalV2(tableBinding, { ...s.dependencies, token: async (...args) => {
    // Acquisition confirmation is followed by scan's first authority read.
    if (scanning && boundary === 'token' && !entered) { entered = true; return gate.promise; } return s.dependencies.token(...args);
  } }, { kernel: { callTimeoutMs: 1000, cleanupTimeoutMs: 15000 } });
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'release') releases++;
    if (s.rows.get('M')!.Operation === 'acquire' && e.req.method === 'GET') {
      if (scanning && boundary === 'native-close') { entered = true; return; }
      scanning = true;
    }
    e.reply();
  };
  if (boundary === 'native-close') s.controls.request = ((...args: Parameters<typeof https.request>) => {
    const req = s.request(...args);
    if (scanning) { const destroy = req.destroy.bind(req); req.destroy = () => { nativeRelease = () => { destroy(); }; return req; }; }
    return req;
  }) as typeof https.request;
  let done = false; const opening = j.open().then(() => { done = true; }, () => { done = true; });
  await eventually(() => entered); await eventually(() => j.status().lifecycle === 'failed');
  assert.equal(done, false); assert.equal(j.status().kernel.pending, 1);
  let ended = false; let rejected = false;
  const close = j.close().then(() => { ended = true; }, error => { ended = true; rejected = code('unavailable')(error); });
  await pause(); assert.equal(ended, false); assert.equal(releases, 0);
  delete s.controls.hook; delete s.controls.request; gate.resolve(syntheticToken);
  if (boundary === 'native-close') { await eventually(() => !!nativeRelease); nativeRelease!(); }
  await opening; await close;
  assert.equal(s.rows.get('M')!.Exit === exit, true); assert.equal(releases, 0); assert.equal(rejected, true);
  assert.equal(s.rows.get('M')!.Owner !== '', true); assert.equal(j.status().kernel.pending, 0);
  assert.equal(s.stats.requests, s.stats.socketCloses);
});

for (const mode of ['incomplete', 'close-scan'] as const) test(`V1 ${mode} paired control retains healthy startup release behavior`, async t => {
  const s = await initialized(t); const gate = deferred(); let entered = false; let releases = 0;
  s.controls.hook = async e => {
    if (e.actions[0]?.entity.Operation === 'release') releases++;
    if (mode === 'close-scan' && e.req.method === 'GET' && !e.path.includes('RowKey=')) { entered = true; await gate.promise; }
    e.reply();
  };
  const j = createTableDeliveryJournal(tableBinding, s.dependencies, { kernel: { scanBytes: mode === 'incomplete' ? 1 : 64 * 1024 * 1024 } });
  const opening = assert.rejects(j.open());
  if (mode === 'close-scan') { await eventually(() => entered); const close = j.close(); gate.resolve(); await close; }
  await opening; await j.close(); assert.equal(releases, 1); assert.equal(s.rows.get('M')!.Owner === '', true);
});
