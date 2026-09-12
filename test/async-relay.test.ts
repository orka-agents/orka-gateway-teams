import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import * as stores from '../src/ingress/store.js';
import type { IngressForwardingGrant, IngressPort, IngressStore, ReplyRoute } from '../src/ingress/types.js';
import { relayOne } from '../src/ingress/relay.js';
import { createOrkaClient } from '../src/ingress/client.js';
import { expectedEvent } from './fixtures/incoming.js';
import { deferred, scope } from './support/ingress-auth.js';
import { httpsFixture } from './support/ingress-https.js';

const route: ReplyRoute = { serviceUrl: 'https://teams-service.example.invalid/', channelId: 'msteams',
  bot: { id: '28:fixture-app', role: 'bot' }, conversation: { id: expectedEvent.contextId, conversationType: 'personal', tenantId: scope.tenantId } };

async function fixture(t: test.TestContext) {
  let posts = 0;
  const tls = await httpsFixture(t, (req, res) => { req.resume(); req.on('end', () => {
    posts++; res.writeHead(202); res.end('{"status":"accepted","eventId":"orka-async","state":"Queued"}');
  }); });
  const directory = mkdtempSync(join(tmpdir(), 'teams-async-relay-')); const path = join(directory, 'inbox.sqlite');
  const target = { ...scope, orkaBaseUrl: tls.baseUrl }; let now = 1000;
  stores.initializeIngressStore(path, target);
  const store = stores.openIngressStore(path, target, { now: () => now, policy: { maxPending: 10, maxRecords: 100, replayWindowMs: 100 } });
  const port = stores.createIngressPort(store);
  store.admit(expectedEvent, route);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, port, path, target, now(value: number) { now = value; }, posts: () => posts,
    client: createOrkaClient(target, { ca: tls.ca, bearerToken: randomUUID() }) };
}

for (const boundary of ['claim', 'revalidation'] as const) for (const loss of ['deadline', 'regression', 'cancel', 'readiness', 'attempt', 'owner'] as const) {
  test(`${loss} during deferred inbox ${boundary} prevents Orka handoff`, async (t) => {
    const f = await fixture(t); const gate = deferred<void>(); const entered = deferred<void>();
    const abort = new AbortController(); let ready = true; let current: IngressForwardingGrant | undefined;
    const port: IngressPort = { ...f.port, claimForForwarding: async () => {
      current = await f.port.claimForForwarding();
      if (!current) return undefined;
      if (boundary === 'claim') { entered.resolve(); await gate.promise; return current; }
      const grant = current;
      return { ...grant, revalidate: async () => {
        const eligible = await grant.revalidate(); entered.resolve(); await gate.promise; return eligible;
      } };
    } };
    let finished = false;
    const pending = relayOne(port, f.client, abort.signal, () => ready).then((value) => { finished = true; return value; });
    try {
      // The real HTTPS request must not escape while storage is unresolved.
      await turn(); await turn();
      assert.equal(f.posts(), 0, 'a claim ACK is not unconditional forwarding permission');
      assert.equal(finished, false); await entered.promise;
      if (loss === 'deadline') f.now(1100);
      if (loss === 'regression') f.now(999);
      if (loss === 'cancel') abort.abort();
      if (loss === 'readiness') ready = false;
      if (loss === 'attempt') { assert.ok(current); f.store.retry(current.claim, 0); f.store.claim(); }
      if (loss === 'owner') f.store.close();
      gate.resolve(); assert.equal(await pending, false); assert.equal(f.posts(), 0);
      assert.equal(current!.take(), false, 'invalidated grant cannot be reused');
      if (loss === 'deadline' || loss === 'regression') { f.now(1200); assert.equal(f.store.claim(), undefined); }
    } finally { gate.resolve(); await pending.catch(() => {}); }
  });
}

test('readiness loss during final synchronous owner check still prevents Orka handoff', async (t) => {
  const f = await fixture(t); let ready = true;
  const port: IngressPort = { ...f.port, claimForForwarding: async () => {
    const grant = await f.port.claimForForwarding(); assert.ok(grant);
    return { ...grant, take() { const eligible = grant.take(); ready = false; return eligible; } };
  } };
  assert.equal(await relayOne(port, f.client, undefined, () => ready), false);
  assert.equal(f.posts(), 0);
});

test('SQLite grant is one-use and foreign store adaptation cannot supply unconditional permission', async (t) => {
  const f = await fixture(t); const grant = await f.port.claimForForwarding(); assert.ok(grant);
  assert.equal(await grant.revalidate(), true); assert.equal(grant.take(), true);
  assert.equal(grant.take(), false); assert.equal(await grant.revalidate(), false);
  assert.throws(() => stores.createIngressPort({ ...f.store }));
});

test('stale async settlement yields idle rather than a busy relay loop or another mutation', async (t) => {
  const f = await fixture(t);
  const port: IngressPort = { ...f.port, complete: async (claim, receipt) => {
    f.store.block(claim, 'conflict'); return f.store.complete(claim, receipt);
  } };
  assert.equal(await relayOne(port, f.client), false); assert.equal(f.posts(), 1);
  assert.equal(f.store.claim(), undefined); assert.equal(await relayOne(port, f.client), false);
});

for (const outcome of ['receipt', 'retry', 'blocked'] as const) test(`relay awaits deferred ${outcome} settlement`, async (t) => {
  const f = await fixture(t); const gate = deferred<void>(); const entered = deferred<void>(); let finished = false;
  const port: IngressPort = { ...f.port,
    complete: async (...args: Parameters<IngressStore['complete']>) => { entered.resolve(); await gate.promise; return f.store.complete(...args); },
    retry: async (...args: Parameters<IngressStore['retry']>) => { entered.resolve(); await gate.promise; return f.store.retry(...args); },
    block: async (...args: Parameters<IngressStore['block']>) => { entered.resolve(); await gate.promise; return f.store.block(...args); },
  };
  const pending = relayOne(port, { post: async () => outcome === 'receipt' ?
    { kind: 'receipt', receipt: { status: 'accepted', eventId: 'orka-async', state: 'Queued' } } : outcome === 'retry' ?
      { kind: 'retry' } : { kind: 'blocked', reason: 'conflict' } }).then((value) => { finished = true; return value; });
  try { await entered.promise; await turn(); assert.equal(finished, false); gate.resolve(); assert.equal(await pending, true); }
  finally { gate.resolve(); await pending; }
});
