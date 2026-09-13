import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { BeginDeliveryResult } from '../src/delivery/types.js';
import { createTableDeliveryJournal } from '../src/delivery/table-journal.js';
import { initialized, request } from './support/table-delivery.js';
import { tableBinding } from './support/table-service.js';
import { httpsFixture } from './support/ingress-https.js';

type Message = { kind: 'result'; result: BeginDeliveryResult | { status: string; providerMessageId?: string } } | { kind: 'error'; code: string } | { kind: 'closed' };
function worker(t: TestContext, config: object) {
  const child = fork(new URL('./support/table-delivery-worker.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const messages: Message[] = []; let notify: (() => void) | undefined; let ended = false;
  const exit = new Promise<number | null>(resolve => { child.once('exit', code => { ended = true; notify?.(); resolve(code); }); });
  child.on('message', message => { messages.push(message as Message); notify?.(); });
  t.after(async () => { if (!ended) child.kill('SIGKILL'); await exit; });
  child.send(config);
  return {
    child, exit,
    async next(): Promise<Message> {
      while (!messages.length) {
        if (ended) throw new Error('Controlled child exited before milestone');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Controlled child milestone timeout')), 15000);
          notify = () => { clearTimeout(timer); resolve(); };
        });
      }
      return messages.shift()!;
    },
  };
}
for (const mode of ['claim', 'deliver'] as const) test(`controlled process handover after ${mode} preserves history and provider count`, { timeout: 30000 }, async t => {
  const s = await initialized(t); let posts = 0;
  const provider = await httpsFixture(t, (req, res) => { posts++; req.resume(); res.end('{"id":"process-receipt"}'); });
  const config = { tableUrl: s.fixture.baseUrl, tableCA: s.fixture.ca.toString(), providerUrl: provider.baseUrl, providerCA: provider.ca.toString() };
  const old = worker(t, { ...config, mode }); const first = await old.next(); assert.equal(first.kind, 'result');
  const contender = worker(t, { ...config, mode: 'replay' }); assert.deepEqual(await contender.next(), { kind: 'error', code: 'busy' }); assert.equal(await contender.exit, 0);
  assert.notEqual(s.rows.get('M')?.Owner, ''); assert.equal(posts, mode === 'deliver' ? 1 : 0);
  old.child.send('close'); assert.deepEqual(await old.next(), { kind: 'closed' }); assert.equal(await old.exit, 0);
  assert.equal(s.rows.get('M')?.Owner, '');
  const next = worker(t, { ...config, mode: 'replay' });
  const result = await next.next(); assert.deepEqual(result, { kind: 'result', result: mode === 'deliver' ?
    { status: 'delivered', providerMessageId: 'process-receipt' } : { status: 'nonRetryableError', message: 'Delivery cannot be completed safely.' } });
  assert.equal(posts, mode === 'deliver' ? 1 : 0); next.child.send('close'); assert.deepEqual(await next.next(), { kind: 'closed' }); assert.equal(await next.exit, 0);
  const j = createTableDeliveryJournal(tableBinding, s.dependencies); await j.open();
  if (first.kind === 'result' && 'kind' in first.result && first.result.kind === 'claimed') {
    assert.equal(await j.settle(first.result.claim, { kind: 'unknown' }), 'unchanged');
    assert.equal(await j.settle(first.result.claim, { kind: 'delivered', providerMessageId: 'late-process' }), 'stale');
  }
  assert.equal((await j.begin(request)).kind, mode === 'deliver' ? 'delivered' : 'unknown'); await j.close();
});
