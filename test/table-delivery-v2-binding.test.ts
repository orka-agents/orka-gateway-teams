import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableDeliveryJournal, createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import type { TableDeliveryJournalLimits } from '../src/delivery/table-journal.js';
import { code, initialized, request } from './support/table-delivery.js';
import { disposition, installRecovery, recoveryHistory } from './support/table-delivery-v2.js';
import { tableBinding, tableService } from './support/table-service.js';

const mutableBinding = (appId: string) => ({ ...tableBinding, kind: 'delivery' as const, scope: { appId, tenantId: 'Tenant' } });
function mutatingLimits(path: 'ownKeys' | 'descriptor', mutate: () => void): TableDeliveryJournalLimits {
  return path === 'ownKeys' ? new Proxy({}, { ownKeys() { mutate(); return []; } }) :
    new Proxy({ maxPending: 96 }, { getOwnPropertyDescriptor(target, key) { mutate(); return Reflect.getOwnPropertyDescriptor(target, key); } });
}

for (const path of ['ownKeys', 'descriptor'] as const) for (const initial of ['App', 'Other'] as const)
  test(`V2 snapshots binding before limits ${path}: initially ${initial === 'App' ? 'matching' : 'different'} recovery binding`, async t => {
    const { s } = await recoveryHistory(t); const binding = mutableBinding(initial); let reflected = 0;
    const limits = mutatingLimits(path, () => { reflected++; binding.scope.appId = initial === 'App' ? 'Other' : 'App'; });
    const writes = s.stats.writes; const tokens = s.stats.tokens; const requests = s.stats.requests; const original = JSON.stringify(s.rows.get('M'));
    const j = createTableDeliveryJournalV2(binding, s.dependencies, limits);
    assert.equal(reflected > 0, true); assert.equal(s.stats.tokens, tokens); assert.equal(s.stats.requests, requests);
    let opened = false; let corrupt = false;
    try { await j.open(); opened = true; } catch (error) { corrupt = code('corrupt')(error); }
    if (initial === 'App') {
      let unknown = false;
      if (opened) unknown = (await j.begin(request)).kind === 'unknown';
      await j.close().catch(() => undefined);
      assert.equal(opened, true); assert.equal(unknown, true); assert.equal(corrupt, false);
    } else {
      const beforeCloseWrites = s.stats.writes; const unchanged = JSON.stringify(s.rows.get('M')) === original;
      await j.close().catch(() => undefined);
      assert.equal(beforeCloseWrites, writes); assert.equal(s.stats.writes, writes);
      assert.equal(unchanged, true); assert.equal(opened, false); assert.equal(corrupt, true);
    }
  });

for (const path of ['ownKeys', 'descriptor'] as const) test(`V2 cannot accept an Other-binding recovery recipe over App envelopes after limits ${path} mutates caller binding`, async t => {
  const { s } = await recoveryHistory(t);
  const otherBytes = Buffer.from('["orka-table-v1","example123","journal","delivery","stable",["Other","Tenant"]]');
  const wrong = disposition(s, undefined, otherBytes); assert.equal(wrong === disposition(s), false);
  installRecovery(s, wrong);
  const binding = mutableBinding('Other'); let reflected = 0;
  const limits = mutatingLimits(path, () => { reflected++; binding.scope.appId = 'App'; });
  const original = JSON.stringify(s.rows.get('M')); const writes = s.stats.writes;
  const j = createTableDeliveryJournalV2(binding, s.dependencies, limits);
  let opened = false; let corrupt = false;
  try { await j.open(); opened = true; } catch (error) { corrupt = code('corrupt')(error); }
  const beforeCloseWrites = s.stats.writes; const unchanged = JSON.stringify(s.rows.get('M')) === original;
  await j.close().catch(() => undefined);
  assert.equal(reflected > 0, true); assert.equal(opened, false); assert.equal(corrupt, true);
  assert.equal(beforeCloseWrites, writes); assert.equal(s.stats.writes, writes); assert.equal(unchanged, true);
});

for (const path of ['ownKeys', 'descriptor'] as const) test(`V1 limits ${path} binding reflection keeps legacy construction behavior`, async t => {
  const s = await initialized(t); const binding = mutableBinding('Other'); let reflected = 0;
  const j = createTableDeliveryJournal(binding, s.dependencies, mutatingLimits(path, () => { reflected++; binding.scope.appId = 'App'; }));
  await j.open(); const begin = await j.begin(request);
  assert.equal(reflected > 0, true); assert.equal(begin.kind, 'claimed'); await j.close();
  assert.equal(s.rows.get('M')!.Owner === '', true);
});

for (const create of [createTableDeliveryJournal, createTableDeliveryJournalV2])
  for (const location of ['binding', 'scope'] as const)
    for (const shape of ['extra', 'accessor', 'nonenumerable', 'symbol', 'prototype'] as const)
      test(`${create === createTableDeliveryJournalV2 ? 'V2' : 'V1'} binding snapshot never drops invalid ${location} ${shape}`, async t => {
        const s = await tableService(t, 'delivery', create === createTableDeliveryJournalV2 ? 2 : 1);
        const binding = mutableBinding('App'); let getterReads = 0; let limitsReads = 0;
        const target = location === 'binding' ? binding : binding.scope;
        const key = location === 'binding' ? 'account' : 'appId';
        if (shape === 'extra') Object.defineProperty(target, 'extra', { value: true, enumerable: true });
        if (shape === 'accessor') Object.defineProperty(target, key, { get() { getterReads++; return 'App'; }, enumerable: true });
        if (shape === 'nonenumerable') Object.defineProperty(target, key, { enumerable: false });
        if (shape === 'symbol') Object.defineProperty(target, Symbol('extra'), { value: true, enumerable: true });
        if (shape === 'prototype') Object.setPrototypeOf(target, { extra: true });
        const limits = new Proxy({}, { ownKeys() { limitsReads++; return []; } });
        assert.throws(() => create(binding, s.dependencies, limits), code('invalid-input'));
        assert.equal(getterReads, 0); assert.equal(limitsReads, 0); assert.equal(s.stats.tokens, 0); assert.equal(s.stats.requests, 0); assert.equal(s.stats.writes, 0);
      });
