import assert from 'node:assert/strict';
import https from 'node:https';
import { test } from 'node:test';
import { createTableIngressStore } from '../src/ingress/table-store.js';
import { InboxIndex } from '../src/ingress/table-index.js';
import { TableError } from '../src/storage/table/types.js';
import { opened, initialized, granted, options, code, result, state } from './support/table-ingress-store.js';
import { deferred, eventually, ingressBinding, syntheticToken } from './support/table-service.js';
import { pair } from './support/table-ingress-audit.js';
import { relayOne } from '../src/ingress/relay.js';

for (const field of ['audit', 'maxIndexBytes'] as const) test(`factory requires explicit ${field} and performs zero native I/O`, async t => {
  const s = await initialized(t); const input = { ...options }; delete (input as Partial<typeof options>)[field]; const before = s.stats.requests;
  assert.throws(() => createTableIngressStore(ingressBinding, s.dependencies, input as typeof options), code('invalid-input'));
  assert.equal(s.stats.requests, before);
});

for (const mode of ['throwing', 'revoked'] as const) test(`factory contains ${mode} exception Proxy without I/O`, () => {
  let io = 0;
  const raw = new Error('synthetic exception context', { cause: { synthetic: true } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const exception = mode === 'revoked' ? revoked.proxy : new Proxy({}, { getPrototypeOf() { throw raw; } });
  const binding = new Proxy(ingressBinding, { getPrototypeOf() { throw exception; } });
  const dependencies = { token: async () => { io++; return syntheticToken; },
    request: (() => { io++; throw new Error('Unexpected native request'); }) as typeof https.request };
  let failure: unknown;
  try { createTableIngressStore(binding, dependencies, options); } catch (error) { failure = error; }
  assert.equal(failure === raw, false);
  assert.ok(failure instanceof TableError);
  assert.equal(failure.code, 'invalid-input'); assert.equal(failure.cause, undefined);
  assert.equal(failure === exception, false); assert.equal(io, 0);
});

test('factory rejects descriptors without reading getters and retains only frozen private scope/config snapshots', async t => {
  const s = await initialized(t); let getters = 0;
  assert.throws(() => createTableIngressStore(ingressBinding, s.dependencies, { ...options, get audit(): never { getters++; throw new Error('private'); } }), code('invalid-input'));
  if (ingressBinding.kind !== 'ingress') throw new Error('Expected fixture binding');
  const binding = { ...ingressBinding, scope: { ...ingressBinding.scope } }; const config = { ...options, audit: { ...options.audit } };
  const j = createTableIngressStore(binding, s.dependencies, config);
  binding.scope.tenantId = 'changed'; config.audit.maxPages = 1;
  assert.equal(getters, 0); assert.equal(j.scope.tenantId === 'Tenant', true);
  assert.equal(Reflect.set(j, 'scope', Object.freeze({ ...j.scope, tenantId: 'other' })), false);
  await j.open(); await j.close();
});

test('descriptor snapshots preserve forbidden prototype-named fields for closed-shape rejection', async t => {
  const { s, j } = await opened(t); const p = pair();
  const event = { ...p.event.body! }; Object.defineProperty(event, '__proto__', { value: null, enumerable: true });
  let refused = false; try { await j.admit(event, p.route.route); } catch (error) { refused = code('invalid-input')(error); }
  assert.equal(refused, true);
  if (ingressBinding.kind !== 'ingress') throw new Error('Expected fixture binding');
  const scope = { ...ingressBinding.scope }; Object.defineProperty(scope, '__proto__', { value: null, enumerable: true });
  assert.throws(() => createTableIngressStore({ ...ingressBinding, scope }, s.dependencies, options), code('invalid-input'));
});

test('input sizing rejects non-string leaves without traversing caller object graphs', async t => {
  const { j } = await opened(t); const p = pair(); let inspected = 0;
  const text = new Proxy({}, { ownKeys() { inspected++; throw new Error('unexpected traversal'); } });
  assert.throws(() => j.admit({ ...p.event.body!, text } as never, p.route.route), code('invalid-input'));
  assert.equal(inspected, 0); assert.equal(j.status().pending, 0);
});

test('descriptor-triggered close while snapshotting cannot admit unreachable queued work', async t => {
  const { j } = await opened(t); const p = pair(); let closed = false; let close: Promise<void> | undefined;
  const input = new Proxy(p.event.body!, { getOwnPropertyDescriptor(target, key) {
    if (!closed && key === 'text') { closed = true; close = j.close(); }
    return Reflect.getOwnPropertyDescriptor(target, key);
  } });
  let rejected = false;
  try { void j.admit(input, p.route.route).catch(() => { rejected = true; }); } catch (e) { rejected = code('closed')(e); }
  assert.equal(closed, true); await close;
  assert.equal(j.status().pending, 0); assert.equal(j.status().pendingBytes, 0); assert.equal(rejected, true);
});

test('input Proxy get traps and ignored settlement body are not invoked', async t => {
  const { j, g } = await granted(t); const p = pair('other', 'other-target', 2); let gets = 0;
  const input = new Proxy(p.event.body!, { get() { gets++; throw new Error('private'); } });
  const queued = j.admit(input, p.route.route); g.retire(); assert.equal((await queued).kind, 'accepted'); assert.equal(gets, 0);
});

test('reservation and queued bytes use one descriptor snapshot even if caller descriptors later grow', async t => {
  const { j } = await opened(t, { maxPendingBytes: 2400 }); const p = pair(); p.event.body!.text = 'original';
  const input = new Proxy(p.event.body!, { getOwnPropertyDescriptor(target, key) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    return key === 'text' && j.status().pending > 0 ? { ...descriptor, value: 'x'.repeat(65536) } : descriptor;
  } });
  const admitted = j.admit(input, p.route.route); const settled = admitted.catch(() => undefined);
  try { assert.equal(j.status().pendingBytes <= 2400, true); await admitted; }
  finally { await settled; }
  // Larger future inputs remain refused; this accepted input was captured once.
  assert.throws(() => j.admit({ ...p.event.body!, text: 'x'.repeat(65536) }, p.route.route), code('not-submitted'));
});

test('route-read derived keys remain charged through native work and are released after completion', async t => {
  const { s, j } = await opened(t); const p = pair(); await j.admit(p.event.body!, p.route.route);
  const gate = deferred(); let entered = false;
  s.controls.hook = async e => { if (!entered) { entered = true; await gate.promise; } e.reply(); };
  const reading = j.getRoute(p.target); await eventually(() => entered);
  try { assert.equal(j.status().index?.working.derivedKeys, 65536); assert.equal(j.status().index?.working.scratch, 0); }
  finally { gate.resolve(); await reading; delete s.controls.hook; }
  assert.equal(j.status().index?.working.derivedKeys, 0);
});

test('maximum legal escaping input uses separate actual queue, planner/delta, refresh and frame credits', async t => {
  const { s, j } = await opened(t); const p = pair('\\'.repeat(256), '"'.repeat(256));
  const prefix = 'https://synthetic.example.invalid/';
  p.route.route.serviceUrl = prefix + 'x'.repeat(2048 - prefix.length - 1) + '/';
  p.route.route.bot.id = '"'.repeat(256); p.route.route.conversation.id = '\\'.repeat(256);
  Object.assign(p.event.body!, { contextId: p.route.route.conversation.id, sender: { id: '\\'.repeat(256), displayName: '"'.repeat(256) },
    text: '"'.repeat(65536), occurredAt: '2025-01-01T00:00:00.123456789+00:00' });
  let prepares = 0; let refreshes = 0; let eventBytes = 0; let bodyBytes = 0; let routeBytes = 0; let deltaPeak = 0;
  let queuedBytes = 0; let kernelBytes = 0;
  const prepare = InboxIndex.prototype.prepare; const refresh = InboxIndex.prototype.refresh;
  InboxIndex.prototype.prepare = function (...args) {
    const before = this.diagnostics(); assert.equal(before.working.scratch, 2240 * 1024); assert.equal(before.working.delta, 480 * 1024);
    const token = prepare.apply(this, args); deltaPeak = Math.max(deltaPeak, this.diagnostics().working.delta);
    eventBytes = Math.max(eventBytes, args[0].event?.payloadBytes ?? 0); bodyBytes = Math.max(bodyBytes, args[0].event?.bodyEncodingBytes ?? 0);
    routeBytes = Math.max(routeBytes, args[0].route?.payloadBytes ?? 0);
    assert.equal(deltaPeak <= 512 * 1024, true); prepares++; return token;
  };
  InboxIndex.prototype.refresh = function (...args) {
    assert.equal(this.diagnostics().working.scratch, 2240 * 1024); refreshes++; return refresh.apply(this, args);
  };
  try {
    const gate = deferred(); let entered = false;
    s.controls.hook = async e => { if (!entered) { entered = true; await gate.promise; } e.reply(); };
    const accepted = j.admit(p.event.body!, p.route.route); await eventually(() => entered);
    const status = j.status(); queuedBytes = status.pendingBytes; kernelBytes = status.kernel.pendingBytes;
    assert.equal(status.pendingBytes > 131072, true); assert.equal(status.kernel.pendingBytes > 131072, true);
    assert.equal(status.index?.working.scratch, 0); assert.equal(status.index?.working.delta, 480 * 1024);
    gate.resolve(); delete s.controls.hook; await accepted;
    const grant = await j.claimForForwarding(); assert.ok(grant);
    assert.equal(j.status().index?.working.frame, 1024 * 1024); assert.equal(j.status().pendingBytes, 8192);
    assert.equal(grant.claim.event.text.length, 65536); assert.equal(await grant.revalidate(), true); assert.equal(grant.take(), true);
    assert.equal(await j.complete(grant.claim, { status: 'duplicate', eventId: '\\'.repeat(256), state: 'Completed' }), true);
    assert.equal(state(s).bodies, 0); assert.equal(prepares, 5); assert.equal(refreshes, 4);
    assert.equal(j.status().index?.working.frame, 0); assert.equal(j.status().index?.working.delta, 0);
    t.diagnostic(`represented bytes only: queue=${queuedBytes}, kernelQueue=${kernelBytes}, body=${bodyBytes}, event=${eventBytes}, route=${routeBytes}, deltaPeak=${deltaPeak}`);
  } finally { InboxIndex.prototype.prepare = prepare; InboxIndex.prototype.refresh = refresh; }
});

test('domain bytes saturate before copying another input and recover after real completion', async t => {
  const { s, j } = await opened(t, { maxPending: 3, maxPendingBytes: 2400 }); const p = pair(); p.event.body!.text = 'x'.repeat(1024);
  const gate = deferred(); let entered = false;
  s.controls.hook = async e => { if (!entered) { entered = true; await gate.promise; } e.reply(); };
  const first = j.admit(p.event.body!, p.route.route); await eventually(() => entered); const before = j.status();
  assert.throws(() => j.admit(p.event.body!, p.route.route), code('not-submitted'));
  assert.equal(j.status().pendingBytes, before.pendingBytes); assert.equal(j.status().pending, 1); assert.equal(j.status().index?.working.scratch, 0);
  gate.resolve(); await first; delete s.controls.hook; assert.equal(j.status().pendingBytes, 0);
  assert.equal((await j.admit(p.event.body!, p.route.route)).kind, 'duplicate');
});

test('default domain queue retains exactly 96 jobs with no hidden waiters', async t => {
  const { s, j } = await opened(t); const p = pair(); const gate = deferred(); let entered = false;
  s.controls.hook = async e => { if (!entered) { entered = true; await gate.promise; } e.reply(); };
  const jobs = Array.from({ length: 96 }, () => j.admit(p.event.body!, p.route.route));
  assert.equal(j.status().pending, 96); assert.throws(() => j.admit(p.event.body!, p.route.route), code('not-submitted'));
  gate.resolve(); const outcomes = await Promise.all(jobs); delete s.controls.hook;
  assert.equal(outcomes.filter(o => o.kind === 'accepted').length, 1); assert.equal(outcomes.filter(o => o.kind === 'duplicate').length, 95);
  assert.equal(j.status().pendingBytes, 0);
});

test('ordinary deadline includes idle-frame queue wait and expired jobs do not sample time', async t => {
  let samples = 0; const { j, g } = await granted(t, { now: () => { samples++; return 100; }, kernel: { callTimeoutMs: 1500 } });
  const p = pair('other', 'other-target', 2); const pending = j.admit(p.event.body!, p.route.route); const rejected = assert.rejects(pending, code('incomplete'));
  const before = samples; await new Promise(resolve => setTimeout(resolve, 1600)); assert.equal(j.status().pending, 2); assert.equal(samples, before);
  g.retire(); await rejected; assert.equal(samples, before); await j.close();
});

for (const armed of [false, true]) test(`native request/socket destruction remains actually owned through close; armed ${armed}`, async t => {
  const { s, j } = await opened(t, { kernel: { callTimeoutMs: 1500, cleanupTimeoutMs: 5000 } }); const p = pair(); await j.admit(p.event.body!, p.route.route);
  const g = armed ? await j.claimForForwarding() : undefined;
  let entered = false; let release: (() => void) | undefined;
  s.controls.hook = () => { entered = true; };
  s.controls.request = ((...args: Parameters<typeof https.request>) => {
    const req = s.request(...args); const destroy = req.destroy.bind(req);
    req.destroy = () => { release = () => { destroy(); }; return req; }; return req;
  }) as typeof https.request;
  const work = armed ? (g!.retire(), Promise.resolve()) : j.admit(p.event.body!, p.route.route);
  const observed = work.catch(() => undefined); await eventually(() => entered); await eventually(() => !!release);
  assert.equal(j.status().pending, 1); assert.equal(j.status().kernel.pending, 1);
  let done = false; const close = j.close().then(() => { done = true; return true; }, () => { done = true; return false; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(done, false);
  delete s.controls.hook; delete s.controls.request; release!(); await observed;
  assert.equal(await close, !armed); assert.equal(s.stats.requests, s.stats.socketCloses); assert.equal(j.status().pending, 0);
});

for (const stage of ['claim-reconciliation', 'claim-refresh'] as const)
  test(`possible or confirmed arm at ${stage} invalidates before actual token drain, never grants or releases`, async t => {
    const s = await initialized(t); const gate = deferred<string>(); let hold = false; let entered = false;
    const j = createTableIngressStore(ingressBinding, { ...s.dependencies, token: async (...args) => {
      if (hold) { hold = false; entered = true; return gate.promise; } return s.dependencies.token(...args);
    } }, { ...options, kernel: { callTimeoutMs: 1500, cleanupTimeoutMs: 5000 } });
    await j.open(); const p = pair(); await j.admit(p.event.body!, p.route.route); let committed = false; let refreshHeld = false; let writes = 0; let posts = 0;
    s.controls.hook = e => {
      if (e.actions[0]?.entity.Operation === 'mutate') {
        writes++; e.commit(); committed = true; if (stage === 'claim-reconciliation') hold = true; e.res.destroy(); return;
      }
      e.reply();
      if (committed && stage === 'claim-refresh' && !refreshHeld && e.path.includes(",RowKey='M'")) { refreshHeld = true; hold = true; }
    };
    const work = relayOne(j, { async post() { posts++; return { kind: 'retry' }; } });
    let finished = false; const observed = work.then(() => { finished = true; return false; }, error => { finished = true; return code('unavailable')(error) || code('unresolved')(error); });
    await eventually(() => entered); await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(finished, false); assert.equal(j.status().pending, 1); assert.equal(j.status().kernel.pending, 1);
    assert.equal(j.status().index?.working.frame, 1048576); assert.equal(j.status().index?.working.meta, 65536); assert.equal(j.status().index?.working.delta! > 0, true);
    assert.equal(state(s).handoffClockArm !== null, true); assert.equal(result(s).operation, 'claim');
    let ended = false; const closing = j.close(); assert.equal(j.close(), closing);
    const close = closing.then(() => { ended = true; return false; }, error => { ended = true; return code('unresolved')(error); });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(ended, false);
    delete s.controls.hook; gate.resolve(syntheticToken); assert.equal(await observed, true); assert.equal(await close, true);
    assert.equal(posts, 0); assert.equal(writes, 1); assert.notEqual(s.rows.get('M')?.Owner, '');
    assert.equal(j.status().pending, 0); assert.equal(j.status().kernel.pending, 0); assert.equal(s.stats.requests, s.stats.socketCloses);
  });

for (const stage of ['open-before-arm-knowledge', 'ordinary', 'armed-finalizer'] as const)
  test(`held real token at ${stage} keeps actual domain/kernel work and close pending until release`, async t => {
    const s = await initialized(t); const gate = deferred<string>(); let hold = stage === 'open-before-arm-knowledge'; let entered = false;
    const j = createTableIngressStore(ingressBinding, { ...s.dependencies, token: async (...args) => {
      if (hold) { hold = false; entered = true; return gate.promise; } return s.dependencies.token(...args);
    } }, { ...options, kernel: { callTimeoutMs: 1500, cleanupTimeoutMs: 5000 } });
    const p = pair(); let work: Promise<unknown>;
    if (stage === 'open-before-arm-knowledge') work = j.open();
    else {
      await j.open(); await j.admit(p.event.body!, p.route.route);
      if (stage === 'ordinary') { hold = true; work = j.admit(p.event.body!, p.route.route); }
      else { const grant = await j.claimForForwarding(); assert.ok(grant); hold = true; grant.retire(); work = Promise.resolve(); }
    }
    let finished = stage === 'armed-finalizer'; const observed = work.then(() => { finished = true; }, () => { finished = true; });
    await eventually(() => entered); await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(stage === 'armed-finalizer' || !finished, true); assert.equal(j.status().kernel.pending, 1);
    if (stage !== 'open-before-arm-knowledge') assert.equal(j.status().pending, 1);
    let ended = false; const close = j.close().then(() => { ended = true; return true; }, () => { ended = true; return false; });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(ended, false);
    gate.resolve(syntheticToken); await observed; const clean = await close;
    assert.equal(clean, stage === 'ordinary'); assert.equal(s.rows.get('M')?.Owner === '', stage !== 'armed-finalizer');
    // The pre-acquire token never wrote an owner; its pre-existing clean M is
    // not evidence that this interrupted, invalidated handle released authority.
    assert.equal(j.status().pending, 0); assert.equal(j.status().kernel.pending, 0);
    assert.equal(s.stats.requests, s.stats.socketCloses);
  });
