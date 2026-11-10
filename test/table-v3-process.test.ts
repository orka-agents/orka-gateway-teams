import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createTableIngressStoreV3 } from '../src/ingress/table-store.js';
import { createTableDeliveryJournalV3 } from '../src/delivery/table-journal.js';
import { deferred, eventually, ingressBinding, tableBinding, tableService } from './support/table-service.js';
import { options } from './support/table-ingress-store.js';
import { httpsFixture } from './support/ingress-https.js';

function worker(t: TestContext, domain: 'ingress' | 'delivery', config: object) {
  const child = fork(new URL(`./support/table-${domain === 'ingress' ? 'ingress-store' : 'delivery'}-worker.ts`, import.meta.url), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages: any[] = []; let ended = false; let bytes = 0;
  const exit = new Promise<void>(resolve => child.once('exit', () => { ended = true; resolve(); }));
  child.on('message', raw => { assert.ok(messages.length < 16 && JSON.stringify(raw).length < 4096); messages.push(raw); });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (b: Buffer) => { bytes += b.length; if (bytes > 4096) child.kill('SIGKILL'); });
  t.after(async () => { if (!ended) { child.kill('SIGCONT'); child.kill('SIGKILL'); } await exit; assert.equal(bytes, 0); });
  child.send(config);
  return { child, exit, async next() { await eventually(() => messages.length > 0 || ended); assert.ok(messages.length, 'worker reached persisted/native barrier'); return messages.shift(); },
    async pause() { assert.equal(child.kill('SIGSTOP'), true); await eventually(() => /^State:\s+T/mu.test(readFileSync(`/proc/${child.pid}/status`, 'utf8'))); } };
}
function payloads(rows: Map<string, Record<string, unknown>>, type: string) {
  return [...rows.values()].filter(r => r.T === type).map(r => JSON.parse(Buffer.concat(
    Array.from({ length: Number(r.Count) }, (_, i) => Buffer.from(String(r[`B${i}`]), 'base64'))).toString()));
}
for (const domain of ['ingress', 'delivery'] as const) for (const phase of ['claimed', 'posting', 'persisted'] as const) {
  test(`V3 real ${domain} worker paused/killed at ${phase}: one successor, retained old outcome, no replay`, { timeout: 30000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'table-v3-process-')); const clockFile = join(directory, 'clock'); writeFileSync(clockFile, '0');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const s = await tableService(t, domain, 3);
    const initial = domain === 'ingress' ? createTableIngressStoreV3(ingressBinding, s.dependencies, options) : createTableDeliveryJournalV3(tableBinding, s.dependencies);
    await initial.initialize(); await initial.close();
    let posts = 0; const posted = deferred(); const release = deferred();
    t.after(() => release.resolve());
    const remote = await httpsFixture(t, async (req, res) => {
      posts++; for await (const _ of req) {}
      posted.resolve(); if (phase === 'posting' && posts === 1) await release.promise;
      if (domain === 'ingress') { res.writeHead(202); res.end('{"status":"accepted","eventId":"process-receipt","state":"Queued"}'); }
      else res.end('{"id":"process-receipt"}');
    });
    const config = { format: 3, clockFile, tableUrl: s.fixture.baseUrl, tableCA: s.fixture.ca.toString(), providerUrl: remote.baseUrl, providerCA: remote.ca.toString() };
    const old = worker(t, domain, { ...config, pauseAtPost: phase === 'posting', mode: phase === 'claimed' ? domain === 'ingress' ? 'held-relay' : 'held-deliver' : domain === 'ingress' ? 'relay' : 'deliver' });
    if (phase === 'posting') await posted.promise;
    else assert.equal((await old.next()).kind, phase === 'claimed' ? domain === 'ingress' ? 'armed' : 'claimed' : domain === 'ingress' ? 'ready' : 'result');
    const oldOwner = s.rows.get('M')!.Owner;
    if (phase === 'persisted') { assert.equal(old.child.kill('SIGKILL'), true); await old.exit; }
    else await old.pause();
    writeFileSync(clockFile, '125001');
    const next = worker(t, domain, { ...config, mode: domain === 'ingress' ? 'probe' : 'replay' });
    const replay = await next.next(); assert.equal(replay.kind, domain === 'ingress' ? 'ready' : 'result');
    assert.notEqual(s.rows.get('M')!.Owner, oldOwner); const successor = JSON.stringify([...s.rows]);
    assert.equal(posts, phase === 'claimed' ? 0 : 1, 'successor never resends an old uncertain attempt');
    if (domain === 'ingress') assert.equal(replay.claim, false);
    else assert.equal(replay.result.status, phase === 'persisted' ? 'delivered' : 'nonRetryableError');
    if (phase !== 'persisted') {
      release.resolve(); assert.equal(old.child.kill('SIGCONT'), true);
      if (phase === 'claimed') old.child.send('continue');
      const stale = await old.next();
      if (stale.kind !== 'error') { old.child.send('close'); assert.equal((await old.next()).kind, 'error'); }
      await old.exit; assert.equal(JSON.stringify([...s.rows]), successor, 'resumed old writer cannot settle, mutate or claim clean release');
      assert.equal(posts, phase === 'claimed' ? 0 : 1, 'late token/receipt cannot revive send authority');
    }
    const records = payloads(s.rows, domain === 'ingress' ? 'event' : 'delivery');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, phase === 'persisted' ? domain === 'ingress' ? 'terminal' : 'delivered' : domain === 'ingress' ? 'forwarding' : 'sending');
    next.child.send('close'); assert.equal((await next.next()).kind, 'closed'); await next.exit;
    const fresh = worker(t, domain, { ...config, fresh: true, mode: domain === 'ingress' ? 'relay' : 'deliver' });
    const sent = await fresh.next(); assert.equal(sent.kind, domain === 'ingress' ? 'ready' : 'result');
    assert.equal(posts, phase === 'claimed' ? 1 : 2, 'new work proceeds without replaying retained work');
    fresh.child.send('close'); assert.equal((await fresh.next()).kind, 'closed'); await fresh.exit;
    assert.equal(s.stats.violation, false);
  });
}
