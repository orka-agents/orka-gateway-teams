import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { initialized, state } from './support/table-ingress-store.js';
import { httpsFixture } from './support/ingress-https.js';
function worker(t: TestContext, config: object) {
  const child = fork(new URL('./support/table-ingress-store-worker.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let ended = false; let bytes = 0; let messages = 0; let notify: (() => void) | undefined;
  const queue: { kind: string; claim?: boolean; code?: string }[] = [];
  const exit = new Promise<void>(resolve => child.once('exit', () => { ended = true; notify?.(); resolve(); }));
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) child.kill('SIGKILL'); });
  child.on('message', raw => {
    if (++messages > 4 || JSON.stringify(raw).length > 1024) { child.kill('SIGKILL'); return; }
    const m = raw as { kind?: unknown; claim?: unknown; code?: unknown };
    queue.push({ kind: m.kind === 'ready' ? 'ready' : m.kind === 'closed' ? 'closed' : 'error', ...(typeof m.claim === 'boolean' ? { claim: m.claim } : {}),
      ...(m.code === 'busy' ? { code: 'busy' } : {}) }); notify?.();
  });
  t.after(async () => { if (!ended) child.kill('SIGKILL'); await exit; assert.equal(bytes, 0); }); child.send(config);
  return { child, exit, async next() {
    while (!queue.length) {
      if (ended) throw new Error('Native child ended before milestone');
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Native child milestone timeout')), 15000);
        notify = () => { clearTimeout(timer); resolve(); }; });
    }
    return queue.shift()!;
  } };
}
for (const mode of ['grant', 'relay'] as const) test(`native process ${mode} handover drains ownership and preserves actual Orka POST count`, { timeout: 30000 }, async t => {
  const s = await initialized(t); let posts = 0;
  const provider = await httpsFixture(t, (req, res) => { posts++; req.resume(); res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"status":"accepted","eventId":"receipt","state":"Queued"}'); });
  const config = { tableUrl: s.fixture.baseUrl, tableCA: s.fixture.ca.toString(), providerUrl: provider.baseUrl, providerCA: provider.ca.toString() };
  const old = worker(t, { ...config, mode }); assert.equal((await old.next()).kind, 'ready');
  const busy = worker(t, { ...config, mode: 'probe' }); assert.equal((await busy.next()).code, 'busy'); await busy.exit;
  old.child.send('close'); assert.equal((await old.next()).kind, 'closed'); await old.exit;
  assert.equal(s.rows.get('M')?.Owner, ''); assert.equal(state(s).handoffClockArm, null); assert.equal(posts, mode === 'relay' ? 1 : 0);
  const next = worker(t, { ...config, mode: 'probe' }); const replay = await next.next();
  assert.equal(replay.kind, 'ready'); assert.equal(replay.claim, mode === 'grant'); next.child.send('close'); await next.next(); await next.exit;
  assert.equal(posts, mode === 'relay' ? 1 : 0);
});

test('armed-crash availability adaptation: actual killed claimant leaves arm/ownership blocked, not SQLite-style automatic restart', { timeout: 30000 }, async t => {
  const s = await initialized(t); const config = { tableUrl: s.fixture.baseUrl, tableCA: s.fixture.ca.toString(), providerUrl: s.fixture.baseUrl, providerCA: s.fixture.ca.toString() };
  const old = worker(t, { ...config, mode: 'grant' }); assert.equal((await old.next()).claim, true);
  old.child.kill('SIGKILL'); await old.exit; assert.equal(state(s).handoffClockArm !== null, true); assert.notEqual(s.rows.get('M')?.Owner, '');
  const next = worker(t, { ...config, mode: 'probe' }); assert.equal((await next.next()).code, 'busy'); await next.exit;
  assert.equal(state(s).handoffClockArm !== null, true); // No recovery/takeover writer is exercised or supplied.
});
