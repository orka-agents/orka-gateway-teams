import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableIngressStore } from '../src/ingress/table-store.js';
import { createTableKernelV2 } from '../src/storage/table/index.js';
import { bindTable } from '../src/storage/table/codec.js';
import { encodeState } from '../src/ingress/table-codec.js';
import { stateDigest } from '../src/ingress/table-result.js';
import { InboxIndex } from '../src/ingress/table-index.js';
import { opened, initialized, options, code, state } from './support/table-ingress-store.js';
import { deferred, eventually, ingressBinding, tableService } from './support/table-service.js';
import { inboxOwned, install, pair } from './support/table-ingress-audit.js';
import { armId, attemptId, sealFixture, stateFixture } from './support/table-ingress.js';

for (const existing of [false, true]) test(`close-before-start is memoized and issues zero I/O; existing partition ${existing}`, async t => {
  const s = existing ? await initialized(t) : await tableService(t, 'ingress', 2); const before = s.stats.requests;
  const j = createTableIngressStore(ingressBinding, s.dependencies, options); const close = j.close(); assert.equal(j.close(), close); await close;
  await assert.rejects(j.open(), code('closed')); await assert.rejects(j.initialize(), code('closed')); assert.equal(s.stats.requests, before);
});

for (const fault of ['missing', 'bare-genesis', 'scope', 'busy'] as const) test(`startup ${fault} is fail-closed without adoption or reset`, async t => {
  const s = fault === 'missing' || fault === 'bare-genesis' ? await tableService(t, 'ingress', 2) : await initialized(t);
  let old: ReturnType<typeof createTableIngressStore> | undefined;
  if (fault === 'bare-genesis') { const k = createTableKernelV2(ingressBinding, s.dependencies); await k.initialize(); await k.close(); }
  if (fault === 'busy') { old = createTableIngressStore(ingressBinding, s.dependencies, options); await old.open(); }
  const binding = fault === 'scope' && ingressBinding.kind === 'ingress' ? { ...ingressBinding, scope: { ...ingressBinding.scope, tenantId: 'other' } } : ingressBinding;
  const j = createTableIngressStore(binding, s.dependencies, options);
  await assert.rejects(j.open(), code(fault === 'missing' ? 'missing' : fault === 'busy' ? 'busy' : fault === 'scope' ? 'corrupt' : 'unresolved'));
  assert.notEqual(j.status().lifecycle, 'ready'); await j.close().catch(() => undefined); await old?.close();
});

test('partial initialization cannot be resumed by initialize or adopted by open', async t => {
  const s = await tableService(t, 'ingress', 2);
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'mutate') { e.res.writeHead(202); e.res.end(); } else e.reply(); };
  const init = createTableIngressStore(ingressBinding, s.dependencies, options); await assert.rejects(init.initialize(), code('not-submitted')); await init.close(); delete s.controls.hook;
  assert.equal(s.rows.size, 1);
  const retry = createTableIngressStore(ingressBinding, s.dependencies, options); await assert.rejects(retry.initialize(), code('exists')); await retry.close();
  const open = createTableIngressStore(ingressBinding, s.dependencies, options); await assert.rejects(open.open(), code('unresolved')); await assert.rejects(open.close(), code('unresolved'));
});

for (const sealed of [false, true]) test(`normal open rejects fully auditable ${sealed ? 'sealed' : 'current'} arm at an older prepared epoch`, async t => {
  const { s, k } = await inboxOwned(t); const p = pair(); Object.assign(p.event, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  const arm = { id: armId, ownerEpoch: 1, generation: 1, order: 1, attemptId };
  const next = stateFixture({ lastNow: sealed ? 150 : 100, currentGeneration: sealed ? null : 1, handoffClockArm: arm });
  await install(k, { pairs: [p], state: next, seals: sealed ? [sealFixture()] : [], result: {
    schema: 1, operation: 'revalidate', epoch: 1, basis: { records: 1, bodies: 1, lastNow: sealed ? 150 : 100, restartEpoch: 1, currentGeneration: 1, arm },
    clock: { time: sealed ? 140 : 100 }, decision: { armId, eligible: !sealed }, postStateDigest: stateDigest(bindTable(ingressBinding), encodeState(next)),
  } });
  await k.close(); const j = createTableIngressStore(ingressBinding, s.dependencies, options); await assert.rejects(j.open(), code('corrupt'));
  await assert.rejects(j.close(), code('unresolved')); assert.notEqual(s.rows.get('M')?.Owner, ''); assert.equal(state(s).handoffClockArm !== null, true);
});

for (const phase of ['initialize', 'acquire', 'audit'] as const) test(`close during ${phase} waits actual startup and cannot publish Ready`, async t => {
  const s = phase === 'initialize' ? await tableService(t, 'ingress', 2) : await initialized(t); const gate = deferred(); let entered = false;
  s.controls.hook = async e => {
    if (!entered && (phase === 'audit' ? e.req.method === 'GET' && !e.path.includes('RowKey=') : e.actions[0]?.entity.Operation === phase)) {
      entered = true; await gate.promise;
    } e.reply();
  };
  const j = createTableIngressStore(ingressBinding, s.dependencies, options);
  const started = (phase === 'initialize' ? j.initialize() : j.open()).then(() => true, () => false);
  await eventually(() => entered); let ended = false; const close = j.close().then(() => { ended = true; }, () => { ended = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(ended, false); gate.resolve(); await close;
  assert.equal(await started, false); assert.equal(j.status().lifecycle, 'closed'); assert.equal(j.status().kernel.pending, 0);
  assert.equal(s.stats.requests, s.stats.socketCloses);
});

test('close during initializer release suppresses public initialization success after private completion', async t => {
  const s = await tableService(t, 'ingress', 2); const gate = deferred(); let entered = false;
  s.controls.hook = async e => { if (e.actions[0]?.entity.Operation === 'release') { entered = true; await gate.promise; } e.reply(); };
  const j = createTableIngressStore(ingressBinding, s.dependencies, options);
  const startup = j.initialize().then(() => true, () => false); await eventually(() => entered);
  const close = j.close(); gate.resolve(); await close;
  assert.equal(await startup, false); assert.equal(s.rows.get('M')?.Owner, ''); assert.equal(j.status().lifecycle, 'closed');
});

test('startup gets a fresh short mutation phase after complete audit exceeds one short budget', async t => {
  const { s, j } = await opened(t); const p = pair(); await j.admit(p.event.body!, p.route.route); await j.close();
  let pages = 0;
  s.controls.hook = async e => { if (e.req.method === 'GET' && !e.path.includes(",RowKey='")) { pages++; await new Promise(resolve => setTimeout(resolve, 400)); } e.reply(); };
  const next = createTableIngressStore(ingressBinding, s.dependencies, { ...options, kernel: { callTimeoutMs: 2000 } });
  await next.open(); assert.equal(pages, 6); assert.equal(next.status().lifecycle, 'ready'); delete s.controls.hook; await next.close();
});

test('historical audit header stays meta-owned while current index mutations advance, until real release drains', async t => {
  const { s, j } = await opened(t); const a = pair(); const b = pair('second', 'second-target', 2);
  await j.admit(a.event.body!, a.route.route); await j.admit(b.event.body!, b.route.route);
  assert.equal(state(s).records, 2); assert.equal(j.status().index?.working.meta, 65536);
  const gate = deferred(); let entered = false; let disposed = false;
  const dispose = InboxIndex.prototype.dispose;
  InboxIndex.prototype.dispose = function () { disposed = true; dispose.call(this); assert.equal(this.diagnostics().chargedBytes, 0); };
  s.controls.hook = async e => { if (e.actions[0]?.entity.Operation === 'release') { entered = true; await gate.promise; } e.reply(); };
  try {
    const closing = j.close(); await eventually(() => entered);
    assert.equal(disposed, false); assert.equal(j.status().index?.working.meta, 65536); gate.resolve(); await closing;
    assert.equal(disposed, true); assert.equal(j.status().index, undefined);
  } finally { gate.resolve(); InboxIndex.prototype.dispose = dispose; delete s.controls.hook; }
});

test('index growth exhaustion remains incomplete, not planner corruption, and no event is submitted', async t => {
  const { j, s } = await opened(t, { maxIndexBytes: 4 * 1024 * 1024 }); const p = pair(); const before = s.stats.writes;
  await assert.rejects(j.admit(p.event.body!, p.route.route), code('incomplete'));
  assert.equal(s.stats.writes, before + 1); // Healthy close only, never admission.
  assert.equal(state(s).records, 0); await j.close();
});

test('attempt overflow is refused before arming or event replacement', async t => {
  const { s, k } = await inboxOwned(t); const p = pair(); Object.assign(p.event, { attempt: Number.MAX_SAFE_INTEGER, attemptId, attemptEpoch: 1 });
  await install(k, { pairs: [p], state: stateFixture() }); await k.close();
  const j = createTableIngressStore(ingressBinding, s.dependencies, options); await j.open(); const before = s.stats.writes;
  await assert.rejects(j.claimForForwarding(), code('corrupt')); assert.equal(s.stats.writes, before); assert.equal(state(s).handoffClockArm, null);
  await assert.rejects(j.close(), code('unresolved'));
});
