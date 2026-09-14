import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIngressPort, initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import { createTableIngressStore } from '../src/ingress/table-store.js';
import type { IngressClaim, IngressPort, IngressScope } from '../src/ingress/types.js';
import { initialized, options, state } from './support/table-ingress-store.js';
import { ingressBinding } from './support/table-service.js';
import { pair, inboxOwned, install, auditBudget, indexBudget } from './support/table-ingress-audit.js';
import { stateFixture, attemptId } from './support/table-ingress.js';

// PUBLIC adapter only: no second connection is opened on an owned SQLite inode.
for (const scenario of ['ordinary', 'regression', 'deadline', 'restart', 'clamp'] as const)
  test(`SQLite PUBLIC differential ${scenario}; claim/retire adapter excludes armed-crash semantics`, async t => {
    const s = await initialized(t); const directory = mkdtempSync(join(tmpdir(), 'inbox-table-diff-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'inbox.sqlite'); const scope = ingressBinding.scope as IngressScope;
    initializeIngressStore(path, scope); let now = 100;
    const policy = { maxRecords: 4, maxPending: 3, replayWindowMs: 1000 };
    let table = createTableIngressStore(ingressBinding, s.dependencies, { ...options, now: () => now, policy }); await table.open();
    let sqlite = createIngressPort(openIngressStore(path, scope, { now: () => now, policy }));
    t.after(async () => { sqlite.close(); await table.close().catch(() => undefined); });
    const a = pair(); const b = pair('event-b', 'target-b', 2); const c = pair('event-c', 'target-c', 3);
    for (const p of [a, b, c, a]) assert.equal(JSON.stringify(await table.admit(p.event.body!, p.route.route)) === JSON.stringify(await sqlite.admit(p.event.body!, p.route.route)), true);
    const claim = async (port: IngressPort) => { const grant = await port.claimForForwarding(); grant?.retire(); return grant?.claim; };
    const equal = (x: Readonly<IngressClaim> | undefined, y: Readonly<IngressClaim> | undefined) => {
      assert.equal(!!x, !!y); if (!x || !y) return;
      assert.equal(x.externalEventId === y.externalEventId && x.attempt === y.attempt && JSON.stringify(x.event) === JSON.stringify(y.event), true);
    };
    const x = await claim(table); const y = await claim(sqlite); equal(x, y);
    assert.equal(await table.retry(x!, scenario === 'clamp' ? Number.MAX_SAFE_INTEGER : 10), await sqlite.retry(y!, scenario === 'clamp' ? Number.MAX_SAFE_INTEGER : 10));
    const nextX = await claim(table); const nextY = await claim(sqlite); equal(nextX, nextY);
    if (scenario === 'regression') now = 99;
    if (scenario === 'deadline') now = 1100;
    if (scenario === 'restart') {
      await table.close(); sqlite.close();
      table = createTableIngressStore(ingressBinding, s.dependencies, { ...options, now: () => now, policy }); await table.open();
      sqlite = createIngressPort(openIngressStore(path, scope, { now: () => now, policy }));
    }
    const receipt = { status: 'accepted' as const, eventId: 'receipt', state: 'Queued' };
    assert.equal(await table.complete(nextX!, receipt), await sqlite.complete(nextY!, receipt));
    assert.equal(await table.block(x!, 'redirect'), await sqlite.block(y!, 'redirect'));
    const z = await claim(table); const w = await claim(sqlite); equal(z, w);
    if (z && w) assert.equal(await table.block(z, 'invalid-event'), await sqlite.block(w, 'invalid-event'));
    for (const p of [a, b, c]) assert.equal(JSON.stringify(await table.getRoute(p.target)) === JSON.stringify(await sqlite.getRoute(p.target)), true);
    await table.close(); sqlite.close();
  });

test('native restart projects old physical forwarding to pending without rewriting historical attempt evidence', async t => {
  const { s, k } = await inboxOwned(t); const p = pair();
  Object.assign(p.event, { state: 'forwarding', attempt: 1, attemptId, attemptEpoch: 1 });
  await install(k, { pairs: [p], state: stateFixture() }); await k.close();
  const j = createTableIngressStore(ingressBinding, s.dependencies, options); await j.open();
  const grant = await j.claimForForwarding(); assert.ok(grant); assert.equal(grant.claim.attempt, 2);
  assert.equal(grant.claim.attemptId !== attemptId, true); grant.retire(); await j.close();
});

test('native more than 100 retained rows quarantine logically without dropping bodies or changing physical event rows', async t => {
  const s = await initialized(t); let now = 100;
  const j = createTableIngressStore(ingressBinding, s.dependencies, { ...options, audit: { ...auditBudget, maxPages: 1024 },
    now: () => now, policy: { maxPending: 101, maxRecords: 102, replayWindowMs: 10000 } }); await j.open();
  t.after(() => j.close().catch(() => undefined));
  for (let i = 0; i < 101; i++) { const p = pair('event-' + i, 'target-' + i, i + 1); assert.equal((await j.admit(p.event.body!, p.route.route)).kind, 'accepted'); }
  now = 99; assert.equal(await j.claimForForwarding(), undefined);
  assert.equal(state(s).records, 101); assert.equal(state(s).bodies, 101); assert.equal(j.status().index?.seals, 1);
  const p = pair('overflow', 'overflow-target', 102); now = 100;
  assert.equal((await j.admit(p.event.body!, p.route.route)).kind, 'full'); await j.close();
  const next = createTableIngressStore(ingressBinding, s.dependencies, { ...options, maxIndexBytes: indexBudget,
    audit: { ...auditBudget, maxPages: 1024 }, policy: { maxPending: 1, maxRecords: 1, replayWindowMs: 10000 } });
  await next.open(); assert.equal(next.status().index?.events, 101); assert.equal(await next.claimForForwarding(), undefined); await next.close();
});
