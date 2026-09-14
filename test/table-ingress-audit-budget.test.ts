import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditInbox } from '../src/ingress/table-audit.js';
import type { TableBinding } from '../src/storage/table/types.js';
import { InboxIndex } from '../src/ingress/table-index.js';
import { code } from './support/owned-audit.js';
import { deferred, eventually, ingressBinding, tableBinding } from './support/table-service.js';
import { inboxOwned, auditBudget, indexBudget, install, pair } from './support/table-ingress-audit.js';
import { stateFixture } from './support/table-ingress.js';

for (const kind of ['pages', 'bytes', 'tracking', 'index'] as const) test('native ' + kind + ' shortage is incomplete, releases the projection, and permits a later full audit', async t => {
  const { k } = await inboxOwned(t); await install(k, { state: stateFixture(), pairs: [pair()] });
  const budget = { ...auditBudget, ...(kind === 'pages' ? { maxPages: 3 } : kind === 'bytes' ? { maxPageBytes: 1 } :
    kind === 'tracking' ? { maxTrackingBytes: 1 } : {}) };
  let disposed = 0; const original = InboxIndex.prototype.dispose;
  InboxIndex.prototype.dispose = function () { original.call(this); disposed++; assert.equal(this.diagnostics().chargedBytes, 0); };
  try { await assert.rejects(auditInbox(k, ingressBinding, budget, kind === 'index' ? 4194304 : indexBudget), code('incomplete')); }
  finally { InboxIndex.prototype.dispose = original; }
  assert.equal(disposed, 1); assert.equal(k.status().lifecycle, 'owned-unready');
  const result = await auditInbox(k, ingressBinding, auditBudget, indexBudget); result.dispose(); await k.close();
});

test('boundary inputs are snapshotted and invalid inputs never admit native work', async t => {
  const { s, k } = await inboxOwned(t); const before = s.stats.requests; let getters = 0;
  for (const binding of [tableBinding, { ...ingressBinding, scope: { ...ingressBinding.scope, get tenantId() { getters++; return 'Tenant'; } } }])
    await assert.rejects(auditInbox(k, binding as TableBinding, auditBudget, indexBudget), code('invalid-input'));
  await assert.rejects(auditInbox(k, ingressBinding, { ...auditBudget, get maxPages() { getters++; return 20; } }, indexBudget), code('invalid-input'));
  await assert.rejects(auditInbox(k, ingressBinding, auditBudget, 0), code('invalid-input'));
  await assert.rejects(auditInbox(k, ingressBinding, auditBudget, indexBudget, { signal: Object.create(AbortSignal.prototype) }), code('invalid-input'));
  assert.equal(getters, 0); assert.equal(s.stats.requests, before);
  const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (!held) { held = true; await gate.promise; } e.reply(); };
  const active = k.read('M'); await eventually(() => held);
  const binding = structuredClone(ingressBinding); const budget = { ...auditBudget }; const options = { requestTimeoutMs: 30000 };
  let begins = 0; const begin = InboxIndex.prototype.begin;
  InboxIndex.prototype.begin = function () { begins++; begin.call(this); };
  try {
    const audit = auditInbox(k, binding, budget, indexBudget, options); assert.equal(begins, 0);
    (binding.scope as { tenantId: string }).tenantId = 'changed'; budget.maxPages = 1; options.requestTimeoutMs = 0;
    gate.resolve(); await active; const result = await audit; assert.equal(begins, 1); result.dispose();
  } finally { InboxIndex.prototype.begin = begin; delete s.controls.hook; }
  await k.close();
});

test('different but valid binding cannot validate metadata from the private kernel', async t => {
  const { k } = await inboxOwned(t);
  await assert.rejects(auditInbox(k, { ...ingressBinding, storeId: 'different' }, auditBudget, indexBudget), code('unresolved'));
  await assert.rejects(k.close(), code('unresolved'));
});

test('post-await cancellation uses native signal state and never reads overridden accessors', async t => {
  const { k } = await inboxOwned(t); const abort = new AbortController(); let overrides = 0;
  for (const key of ['aborted', 'addEventListener', 'removeEventListener']) Object.defineProperty(abort.signal, key, {
    get() { overrides++; throw new Error('forbidden signal override'); },
  });
  const result = await auditInbox(k, ingressBinding, auditBudget, indexBudget, { signal: abort.signal });
  assert.equal(overrides, 0); result.dispose(); await k.close();
});

test('expired completion reaction cannot publish after the audit duration', async t => {
  const { k } = await inboxOwned(t); const owned = k.auditOwned.bind(k); let completed = false;
  k.auditOwned = (...args) => owned(...args).then(async () => { completed = true; await new Promise(r => setTimeout(r, 600)); });
  await assert.rejects(auditInbox(k, ingressBinding, { ...auditBudget, maxDurationMs: 500 }, indexBudget), code('incomplete'));
  assert.equal(completed, true); await k.close();
});

for (const stop of ['cancel', 'invalidate', 'close'] as const) test('post-kernel completion ' + stop + ' prevents outer projection publication', async t => {
  const { k } = await inboxOwned(t); const abort = new AbortController(); const owned = k.auditOwned.bind(k);
  let closing: Promise<void> | undefined;
  k.auditOwned = (...args) => owned(...args).then(() => {
    if (stop === 'cancel') abort.abort();
    if (stop === 'invalidate') k.invalidate();
    if (stop === 'close') closing = k.close();
  });
  await assert.rejects(auditInbox(k, ingressBinding, auditBudget, indexBudget, { signal: abort.signal }), code(stop === 'invalidate' ? 'unresolved' : 'incomplete'));
  if (stop === 'invalidate') await assert.rejects(k.close(), code('unresolved')); else await (closing ?? k.close());
});
