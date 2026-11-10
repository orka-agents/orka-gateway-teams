import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindTable, data, decodeObjectV2, metadataV2 } from '../src/storage/table/codec.js';
import { metadataV3 } from '../src/storage/table/codec-v3.js';
import { OwnedTableClient, UpgradeTableClient } from '../src/storage/table/client.js';
import { encodeUpgradeAudit, upgradeAuditId, upgradeExit, upgradePlan } from '../src/storage/table/upgrade-codec.js';
import * as library from '../src/storage/table/upgrade.js';
import { reclaimTableIngress, reclaimTableIngressV3 } from '../src/ingress/table-recovery.js';
import { createTableDeliveryJournalV2, createTableDeliveryJournalV3 } from '../src/delivery/table-journal.js';
import { reclaimTableDeliveryOperatorV2, reclaimTableDeliveryOperatorV3 } from '../src/delivery/table-recovery.js';
import { createTableIngressStore, createTableIngressStoreV3 } from '../src/ingress/table-store.js';
import { createTableKernelV2, createTableKernelV3, TableError } from '../src/storage/table/index.js';
import { budget } from './support/owned-audit.js';
import { request } from './support/table-delivery.js';
import { options } from './support/table-ingress-store.js';
import { pair, wireData } from './support/table-ingress-audit.js';
import { ingressBinding, tableBinding, tableService, deferred } from './support/table-service.js';

const attestation = 'a'.repeat(64);
const code = (want: string) => (e: unknown) => e instanceof TableError && e.code === want;
async function api() { return library; }
const fence = (m: Record<string, unknown>) => ({ initId: String(m.InitId), initDigest: String(m.InitDigest),
  owner: String(m.Owner), epoch: Number(m.Epoch), mDigest: String(m.Digest), etag: String(m['odata.etag']) });

for (const kind of ['delivery', 'ingress'] as const) test(`empty_owner_v2_upgrade_preserves_all_history: ${kind} clean release`, async t => {
  const s = await tableService(t, kind, 2); s.controls.allowUpgrade = true;
  const binding = kind === 'delivery' ? tableBinding : ingressBinding;
  const old = kind === 'delivery' ? createTableDeliveryJournalV2(binding, s.dependencies) : createTableIngressStore(binding, s.dependencies, options);
  await old.initialize();
  const prior = structuredClone(s.rows.get('M')!); const before = new Map(structuredClone([...s.rows]));
  const lib = await api();
  if (kind === 'delivery') await lib.upgradeTableDeliveryV2(binding, s.dependencies, budget(), attestation);
  else await lib.upgradeTableIngressV2(binding, s.dependencies, budget(), options.maxIndexBytes, attestation);
  const m = s.rows.get('M')!;
  assert.equal(m.V, 3); assert.equal(m.Owner, ''); assert.equal(m.Epoch, prior.Epoch); assert.equal(m.Lease, '');
  for (const field of ['Binding', 'InitId', 'InitDigest', 'State', 'Result']) assert.equal(m[field], prior[field]);
  for (const [key, row] of before) if (key !== 'M') assert.deepEqual(s.rows.get(key), row);
  assert.equal(s.rows.size, before.size + 1);
  const exit = JSON.parse(Buffer.from(String(m.Exit), 'base64').toString());
  assert.equal(exit.kind, 'format-upgrade'); assert.equal(exit.previousExit, prior.Exit);
  const audit = [...s.rows.values()].find(r => String(r.Id).startsWith('control_format_upgrade:'))!;
  const evidence = JSON.parse(Buffer.from(String(audit.B0), 'base64').toString());
  assert.equal(evidence.kind, 'format-upgrade-audit'); assert.equal(evidence.originalMDigest, prior.Digest);
  const next = kind === 'delivery' ? createTableDeliveryJournalV3(binding, s.dependencies) : createTableIngressStoreV3(binding, s.dependencies, options);
  await next.open(); await next.close();
});

test('empty_owner_v2_upgrade_preserves_all_history: recovered sending remains unknown and the old operator commitment survives', async t => {
  const s = await tableService(t, 'delivery', 2); s.controls.allowUpgrade = true;
  const init = createTableDeliveryJournalV2(tableBinding, s.dependencies); await init.initialize();
  const zombie = createTableDeliveryJournalV2(tableBinding, s.dependencies); await zombie.open();
  const delivered = { ...request, idempotencyId: 'delivered', deliveryId: 'delivered-alias' };
  const claim = await zombie.begin(delivered); assert.equal(claim.kind, 'claimed'); if (claim.kind !== 'claimed') return;
  await zombie.settle(claim.claim, { kind: 'delivered', providerMessageId: 'retained-receipt' });
  const observation = { sessionDigest: 'c'.repeat(64), originDigest: 'd'.repeat(64) }; await zombie.observeSession(observation);
  assert.equal((await zombie.begin(request)).kind, 'claimed');
  await reclaimTableDeliveryOperatorV2(tableBinding, s.dependencies, fence(s.rows.get('M')!), budget(), 'b'.repeat(64));
  const before = new Map(structuredClone([...s.rows]));
  await (await api()).upgradeTableDeliveryV2(tableBinding, s.dependencies, budget(), attestation);
  for (const [key, row] of before) if (key !== 'M') assert.deepEqual(s.rows.get(key), row);
  const next = createTableDeliveryJournalV3(tableBinding, s.dependencies); await next.open();
  assert.equal((await next.begin(request)).kind, 'unknown');
  assert.deepEqual(await next.begin({ ...delivered, deliveryId: 'new-delivery-alias' }), { kind: 'delivered', providerMessageId: 'retained-receipt' });
  assert.deepEqual(await next.observeSession({ ...observation, originDigest: 'e'.repeat(64) }), { kind: 'observed', continuation: true });
  await next.close();
  await assert.rejects(zombie.close());
});

for (const kind of ['delivery', 'ingress'] as const) test(`new_init_is_not_upgrade: ${kind} absent refuses; epoch zero converts without acquiring`, async t => {
  const s = await tableService(t, kind, 2); s.controls.allowUpgrade = true; const lib = await api();
  const binding = kind === 'delivery' ? tableBinding : ingressBinding;
  const upgrade = () => kind === 'delivery' ? lib.upgradeTableDeliveryV2(binding, s.dependencies, budget(), attestation) :
    lib.upgradeTableIngressV2(binding, s.dependencies, budget(), options.maxIndexBytes, attestation);
  await assert.rejects(upgrade(), code('missing')); assert.equal(s.stats.writes, 0);
  const k = createTableKernelV2(binding, s.dependencies); await k.initialize(); await k.close();
  await upgrade(); assert.equal(s.rows.get('M')!.Epoch, '0'); assert.equal(s.rows.get('M')!.Owner, '');
  const old = createTableKernelV2(binding, s.dependencies);
  await assert.rejects(old.acquire(), code('corrupt')); await old.close().catch(() => {});
  const next = createTableKernelV3(binding, s.dependencies); await next.acquire(); await next.close();
});

test('occupied_v2_requires_existing_reclaim: even an upgrade attestation grants no ownership or writes', async t => {
  const s = await tableService(t, 'delivery', 2); const old = createTableDeliveryJournalV2(tableBinding, s.dependencies); await old.initialize();
  const owner = createTableDeliveryJournalV2(tableBinding, s.dependencies); await owner.open(); const writes = s.stats.writes;
  await assert.rejects((await api()).upgradeTableDeliveryV2(tableBinding, s.dependencies, budget(), attestation), code('busy'));
  assert.equal(s.stats.writes, writes); await owner.close();
});

test('old_acquire_vs_upgrade_cas: old V2 acquisition wins the pinned fence, never overwritten by upgrade', async t => {
  const s = await tableService(t, 'delivery', 2); s.controls.allowUpgrade = true;
  const init = createTableDeliveryJournalV2(tableBinding, s.dependencies); await init.initialize();
  const arrived = deferred(); const release = deferred();
  s.controls.hook = async e => { if (e.actions[0]?.entity.Operation === 'format-upgrade') { arrived.resolve(); await release.promise; } e.reply(); };
  const upgrading = (await api()).upgradeTableDeliveryV2(tableBinding, s.dependencies, budget(), attestation);
  await arrived.promise;
  const winner = createTableDeliveryJournalV2(tableBinding, s.dependencies); await winner.open();
  release.resolve(); await assert.rejects(upgrading, code('unresolved'));
  assert.equal(s.rows.get('M')!.V, 2); assert.notEqual(s.rows.get('M')!.Owner, ''); assert.equal(s.rows.size, 1);
  delete s.controls.hook; await winner.close();
});

test('lost_upgrade_ack_requires_inspection: a committed batch is confirmed from exact M plus audit, never retried', async t => {
  const s = await tableService(t, 'delivery', 2); s.controls.allowUpgrade = true;
  const init = createTableDeliveryJournalV2(tableBinding, s.dependencies); await init.initialize();
  let submissions = 0;
  s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'format-upgrade') { submissions++; assert.equal(e.commit(), true); e.res.destroy(); } else e.reply(); };
  await (await api()).upgradeTableDeliveryV2(tableBinding, s.dependencies, budget(), attestation);
  assert.equal(submissions, 1); assert.equal(s.rows.get('M')!.V, 3); assert.equal(s.rows.size, 2);
});

test('lost_upgrade_ack_requires_inspection: unchanged GET needs a V2 cancellation barrier to defeat a delayed submitted upgrade', async t => {
  const s = await tableService(t, 'delivery', 2); s.controls.allowUpgrade = true;
  const init = createTableDeliveryJournalV2(tableBinding, s.dependencies); await init.initialize();
  let delayed: (() => boolean) | undefined; let barriers = 0;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'format-upgrade') { delayed = e.commit; e.res.destroy(); }
    else if (e.actions[0]?.entity.Operation === 'barrier') { barriers++; assert.equal(e.actions[0]!.entity.V, 2); e.commit(); e.res.destroy(); }
    else e.reply();
  };
  await assert.rejects((await api()).upgradeTableDeliveryV2(tableBinding, s.dependencies, budget(), attestation), code('not-submitted'));
  assert.equal(barriers, 1); assert.equal(delayed!(), false); assert.equal(s.rows.get('M')!.V, 2); assert.equal(s.rows.size, 1);
});

test('upgrade commits before the cancellation barrier and its lost ACK is confirmed without retry', async t => {
  const s = await tableService(t, 'delivery', 2); s.controls.allowUpgrade = true;
  await createTableDeliveryJournalV2(tableBinding, s.dependencies).initialize();
  let delayed: (() => boolean) | undefined; let upgrades = 0;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'format-upgrade') { upgrades++; delayed = e.commit; e.res.destroy(); }
    else if (e.actions[0]?.entity.Operation === 'barrier') { assert.equal(delayed!(), true); e.reply(); }
    else e.reply();
  };
  await library.upgradeTableDeliveryV2(tableBinding, s.dependencies, budget(), attestation);
  assert.equal(upgrades, 1); assert.equal(s.rows.get('M')!.V, 3);
});

for (const kind of ['delivery', 'ingress'] as const) test(`later V3 recovery includes the upgrade audit in its new commitment: ${kind}`, async t => {
  const s = await tableService(t, kind, 2); s.controls.allowUpgrade = true;
  const binding = kind === 'delivery' ? tableBinding : ingressBinding;
  await (kind === 'delivery' ? createTableDeliveryJournalV2(binding, s.dependencies) : createTableIngressStore(binding, s.dependencies, options)).initialize();
  if (kind === 'delivery') await library.upgradeTableDeliveryV2(binding, s.dependencies, budget(), attestation);
  else await library.upgradeTableIngressV2(binding, s.dependencies, budget(), options.maxIndexBytes, attestation);
  const middle = kind === 'delivery' ? createTableDeliveryJournalV3(binding, s.dependencies) : createTableIngressStoreV3(binding, s.dependencies, options);
  await middle.open();
  const expected = fence(s.rows.get('M')!);
  if (kind === 'delivery') await reclaimTableDeliveryOperatorV3(binding, s.dependencies, expected, budget(), 'b'.repeat(64));
  else await reclaimTableIngressV3(binding, s.dependencies, expected, budget(), options.maxIndexBytes, 'b'.repeat(64));
  const next = kind === 'delivery' ? createTableDeliveryJournalV3(binding, s.dependencies) : createTableIngressStoreV3(binding, s.dependencies, options);
  await next.open(); await next.close(); await assert.rejects(middle.close());
  assert.equal([...s.rows.values()].filter(r => String(r.Id).startsWith('control_format_upgrade:')).length, 1);
});

test('upgrade_checks_v2_etag_and_encodes_v3: closed cross-format validation precedes token work; stale exact ETag never overwrites', async t => {
  const s = await tableService(t, 'delivery', 2); s.controls.allowUpgrade = true;
  await createTableDeliveryJournalV2(tableBinding, s.dependencies).initialize();
  const bound = bindTable(tableBinding); const prior = decodeObjectV2(bound, s.rows.get('M'));
  assert.ok(prior.value.kind === 'metadata'); const p = prior.value;
  const invocation = '33333333-3333-4333-8333-333333333333';
  const a = { schema: 1 as const, kind: 'format-upgrade-audit' as const, invocation, epoch: p.epoch, originalMDigest: p.digest,
    previousInvocation: p.invocation, previousOperation: p.operation, previousPlan: p.plan,
    dataDigest: 'a'.repeat(64), dataRowCount: 0, upgradeAttestationDigest: attestation };
  const audit = data(bound, { type: 'control', id: upgradeAuditId(invocation) }, encodeUpgradeAudit(a));
  const m = metadataV3(bound, { ...p, lease: undefined, operation: 'format-upgrade', invocation, plan: upgradePlan(a, audit.digest), exit: upgradeExit(p, a, audit.digest) });
  const client = new UpgradeTableClient(bound, s.dependencies); const normal = new OwnedTableClient(bound, s.dependencies, 3);
  const context = () => ({ signal: new AbortController().signal, deadline: performance.now() + 30000 });
  const tokens = s.stats.tokens;
  for (const [original, next, row] of [
    [{ ...prior, etag: '*' }, m, audit],
    [{ ...prior, value: { ...p, digest: '0'.repeat(64) } }, m, audit],
    [prior, metadataV3(bound, { ...m, state: Buffer.from('different') }), audit],
    [prior, m, { ...audit, payload: Buffer.from('{}') }],
    [prior, metadataV3(bound, { ...m, exit: undefined }), audit],
  ] as const) await assert.rejects(client.writeUpgrade(original, next, row, context()), code('invalid-input'));
  await assert.rejects(normal.write(m, prior.etag, [], context()), code('invalid-input'));
  await assert.rejects(normal.write(metadataV3(bound, { ...p, lease: undefined }), prior.etag,
    [{ kind: 'create', key: { type: 'control', id: audit.id }, payload: audit.payload }], context()), code('invalid-input'));
  assert.equal(s.stats.tokens, tokens);
  // Syntactically valid but stale fences reach CAS and fail there, not a local guess.
  await assert.rejects(client.writeUpgrade({ ...prior, etag: 'W/"stale"' }, m, audit, context()), code('unavailable'));
  assert.equal(s.rows.get('M')!.Digest, p.digest); assert.equal(s.rows.size, 1);
  await client.close(); await normal.close();
});

test('checked upgrade refuses a digest-valid but impossible owner-empty V2 layout before tokens', async t => {
  const s = await tableService(t, 'delivery', 2); s.controls.allowUpgrade = true;
  await createTableDeliveryJournalV2(tableBinding, s.dependencies).initialize();
  const bound = bindTable(tableBinding); const prior = decodeObjectV2(bound, s.rows.get('M')!);
  assert.ok(prior.value.kind === 'metadata');
  const p = metadataV2(bound, { ...prior.value, operation: 'initialize' }); // An exited positive epoch cannot be initialization.
  const invocation = '33333333-3333-4333-8333-333333333333';
  const a = { schema: 1 as const, kind: 'format-upgrade-audit' as const, invocation, epoch: p.epoch, originalMDigest: p.digest,
    previousInvocation: p.invocation, previousOperation: p.operation, previousPlan: p.plan,
    dataDigest: 'a'.repeat(64), dataRowCount: 0, upgradeAttestationDigest: attestation };
  const audit = data(bound, { type: 'control', id: upgradeAuditId(invocation) }, encodeUpgradeAudit(a));
  const m = metadataV3(bound, { ...p, lease: undefined, operation: 'format-upgrade', invocation, plan: upgradePlan(a, audit.digest), exit: upgradeExit(p, a, audit.digest) });
  const client = new UpgradeTableClient(bound, s.dependencies); const tokens = s.stats.tokens;
  await assert.rejects(client.writeUpgrade({ ...prior, value: p }, m, audit,
    { signal: new AbortController().signal, deadline: performance.now() + 30000 }), code('invalid-input'));
  assert.equal(s.stats.tokens, tokens); await client.close();
});

test('empty_owner_v2_upgrade_preserves_all_history: ingress recovered uncertain interval stays blocked', async t => {
  const s = await tableService(t, 'ingress', 2); s.controls.allowUpgrade = true;
  await createTableIngressStore(ingressBinding, s.dependencies, options).initialize();
  const zombie = createTableIngressStore(ingressBinding, s.dependencies, options); await zombie.open();
  const p = pair(); await zombie.admit(p.event.body!, p.route.route); assert.ok(await zombie.claimForForwarding());
  await reclaimTableIngress(ingressBinding, s.dependencies, fence(s.rows.get('M')!), budget(), options.maxIndexBytes, 'b'.repeat(64));
  const prior = new Map(structuredClone([...s.rows]));
  await library.upgradeTableIngressV2(ingressBinding, s.dependencies, budget(), options.maxIndexBytes, attestation);
  for (const [key, row] of prior) if (key !== 'M') assert.deepEqual(s.rows.get(key), row);
  const next = createTableIngressStoreV3(ingressBinding, s.dependencies, options); await next.open();
  assert.equal(await next.claimForForwarding(), undefined); await next.close(); await assert.rejects(zombie.close());
});

for (const kind of ['delivery', 'ingress'] as const) test(`upgrade refuses cross-pass M version drift and insufficient budget: ${kind}`, async t => {
  const s = await tableService(t, kind, 2); s.controls.allowUpgrade = true;
  const binding = kind === 'delivery' ? tableBinding : ingressBinding;
  await (kind === 'delivery' ? createTableDeliveryJournalV2(binding, s.dependencies) : createTableIngressStore(binding, s.dependencies, options)).initialize();
  const before = structuredClone(s.rows.get('M')!); const writes = s.stats.writes;
  const upgrade = () => kind === 'delivery' ? library.upgradeTableDeliveryV2(binding, s.dependencies, budget(), attestation) :
    library.upgradeTableIngressV2(binding, s.dependencies, budget(), options.maxIndexBytes, attestation);
  let pages = 0;
  s.controls.hook = e => { if (e.req.method === 'GET' && e.path.includes('$filter') && ++pages === 2)
    s.rows.set('M', { ...s.rows.get('M')!, 'odata.etag': 'W/"changed"' }); e.reply(); };
  await assert.rejects(upgrade(), code('unresolved')); assert.equal(s.stats.writes, writes); assert.equal(s.rows.get('M')!.V, 2);
  delete s.controls.hook; s.rows.set('M', before);
  await assert.rejects(kind === 'delivery' ? library.upgradeTableDeliveryV2(binding, s.dependencies, { ...budget(), maxPages: 1 }, attestation) :
    library.upgradeTableIngressV2(binding, s.dependencies, { ...budget(), maxPages: 1 }, options.maxIndexBytes, attestation), code('incomplete'));
  assert.equal(s.stats.writes, writes);
});

test('upgrade cancellation readback disambiguates generic ResourceNotFound with the exact V2 point query', async t => {
  const s = await tableService(t, 'delivery', 2); s.controls.allowUpgrade = true;
  await createTableDeliveryJournalV2(tableBinding, s.dependencies).initialize();
  let submitted = false; let injected = false; let barriers = 0;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'format-upgrade') { submitted = true; e.res.destroy(); }
    else if (submitted && e.req.method === 'GET' && e.path.includes("RowKey='M'")) {
      injected = true; e.res.writeHead(404, { 'content-type': 'application/json', 'x-ms-error-code': 'ResourceNotFound' });
      e.res.end(JSON.stringify({ 'odata.error': { code: 'ResourceNotFound', message: { lang: 'en-US', value: 'synthetic service error' } } }));
    } else { if (e.actions[0]?.entity.Operation === 'barrier') barriers++; e.reply(); }
  };
  await assert.rejects(library.upgradeTableDeliveryV2(tableBinding, s.dependencies, budget(), attestation), code('not-submitted'));
  assert.equal(injected, true); assert.equal(barriers, 1); assert.equal(s.rows.get('M')!.V, 2);
});

test('cancelled upgrade cannot hand off after a held token even when another signal listener stops propagation', async t => {
  const s = await tableService(t, 'delivery', 2); s.controls.allowUpgrade = true;
  await createTableDeliveryJournalV2(tableBinding, s.dependencies).initialize();
  const arrived = deferred(); const release = deferred(); let held = false;
  const signal = new AbortController(); signal.signal.addEventListener('abort', e => e.stopImmediatePropagation());
  const dependencies = { ...s.dependencies, token: async (...args: Parameters<typeof s.dependencies.token>) => {
    if (s.stats.pages >= 2 && !held) { held = true; arrived.resolve(); await release.promise; }
    return s.dependencies.token(...args);
  } };
  const writes = s.stats.writes;
  const running = library.upgradeTableDeliveryV2(tableBinding, dependencies, budget(), attestation, { signal: signal.signal });
  await arrived.promise; signal.abort(); release.resolve();
  await assert.rejects(running, code('incomplete')); assert.equal(s.stats.writes, writes); assert.equal(s.rows.get('M')!.V, 2);
});

for (const kind of ['delivery', 'ingress'] as const) for (const defect of ['missing', 'deleted-during-acquire', 'rewritten-attestation'] as const)
  test(`V3 startup must retain the pre-acquire upgrade audit reference: ${kind} ${defect}`, async t => {
    const s = await tableService(t, kind, 2); s.controls.allowUpgrade = true;
    const binding = kind === 'delivery' ? tableBinding : ingressBinding;
    await (kind === 'delivery' ? createTableDeliveryJournalV2(binding, s.dependencies) : createTableIngressStore(binding, s.dependencies, options)).initialize();
    if (kind === 'delivery') await library.upgradeTableDeliveryV2(binding, s.dependencies, budget(), attestation);
    else await library.upgradeTableIngressV2(binding, s.dependencies, budget(), options.maxIndexBytes, attestation);
    const [key, audit] = [...s.rows].find(([, r]) => String(r.Id).startsWith('control_format_upgrade:'))!;
    if (defect === 'missing') s.rows.delete(key);
    else if (defect === 'rewritten-attestation') {
      const a = JSON.parse(Buffer.from(String(audit.B0), 'base64').toString());
      s.rows.set(key, wireData(s, 'control', String(audit.Id), Buffer.from(JSON.stringify({ ...a, upgradeAttestationDigest: 'f'.repeat(64) }))));
    } else s.controls.hook = e => { if (e.actions[0]?.entity.Operation === 'acquire') s.rows.delete(key); e.reply(); };
    const next = kind === 'delivery' ? createTableDeliveryJournalV3(binding, s.dependencies) : createTableIngressStoreV3(binding, s.dependencies, options);
    await assert.rejects(next.open(), e => e instanceof Error && 'code' in e && ['corrupt', 'unresolved'].includes(String(e.code)));
    assert.notEqual(s.rows.get('M')!.Owner, '', 'failed startup must not claim a clean release');
    assert.notEqual(s.rows.get('M')!.Operation, 'release');
    await next.close().catch(() => undefined);
    // A restart/recovery must not forget the required audit after the failed acquire.
    const writes = s.stats.writes; const expected = fence(s.rows.get('M')!);
    await assert.rejects(kind === 'delivery' ? reclaimTableDeliveryOperatorV3(binding, s.dependencies, expected, budget(), 'b'.repeat(64)) :
      reclaimTableIngressV3(binding, s.dependencies, expected, budget(), options.maxIndexBytes, 'b'.repeat(64)), code('unresolved'));
    assert.equal(s.stats.writes, writes); assert.equal(s.rows.get('M')!.Digest, expected.mDigest);
  });

test('upgrade snapshots reject hostile binding reflection and invalid attestation with fixed safe errors before token work', async t => {
  const s = await tableService(t, 'delivery', 2); const tokens = s.stats.tokens;
  const bad = new Proxy(tableBinding, { ownKeys() { throw new Error('private reflection diagnostic'); } });
  await assert.rejects(library.upgradeTableDeliveryV2(bad, s.dependencies, budget(), attestation), e =>
    e instanceof TableError && e.code === 'invalid-input' && e.message === 'Table storage: invalid-input' && !('cause' in e));
  await assert.rejects(library.upgradeTableDeliveryV2(tableBinding, s.dependencies, budget(), 'not-a-digest'), code('invalid-input'));
  assert.equal(s.stats.tokens, tokens); assert.equal(s.stats.writes, 0);
});

test('lost upgrade response with unavailable inspection remains uncertain; no blind upgrade retry or reset', async t => {
  const s = await tableService(t, 'delivery', 2); s.controls.allowUpgrade = true;
  await createTableDeliveryJournalV2(tableBinding, s.dependencies).initialize();
  let submitted = false; let upgrades = 0;
  s.controls.hook = e => {
    if (e.actions[0]?.entity.Operation === 'format-upgrade') { submitted = true; upgrades++; e.commit(); e.res.destroy(); }
    else if (submitted) e.res.destroy(); else e.reply();
  };
  await assert.rejects(library.upgradeTableDeliveryV2(tableBinding, s.dependencies, budget(), attestation), code('unresolved'));
  assert.equal(upgrades, 1); assert.equal(s.rows.get('M')!.V, 3); assert.equal(s.rows.size, 2);
});
