import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditInbox } from '../src/ingress/table-audit.js';
import { InboxIndex } from '../src/ingress/table-index.js';
import { digest, encode, fingerprint, validateEvent, validateRoute } from '../src/ingress/codec.js';
import { MAX_INBOX_TIME } from '../src/ingress/table-types.js';
import { auditBudget, inboxOwned, indexBudget, install, pair } from './support/table-ingress-audit.js';
import { ingressBinding } from './support/table-service.js';
import { attemptId, stateFixture } from './support/table-ingress.js';

/** Synchronous test-only observation: inspect capacities/lengths, never content.
 * WeakSet avoids extending backing lifetimes. These are cumulative allocations,
 * NOT a live-memory/GC/RSS measurement; the phase proof is in the task report. */
function observe(work: () => void) {
  const from = Buffer.from; const alloc = Buffer.alloc; const concat = Buffer.concat;
  const stringify = JSON.stringify; const decode = TextDecoder.prototype.decode;
  const seen = new WeakSet<ArrayBufferLike>(); let backing = 0; let json = 0; let utf16 = 0;
  const note = (b: Buffer) => { if (!seen.has(b.buffer)) { seen.add(b.buffer); backing += b.buffer.byteLength; } return b; };
  Buffer.from = ((...args: Parameters<typeof Buffer.from>) => note(Reflect.apply(from, Buffer, args))) as typeof Buffer.from;
  Buffer.alloc = ((...args: Parameters<typeof Buffer.alloc>) => note(Reflect.apply(alloc, Buffer, args))) as typeof Buffer.alloc;
  Buffer.concat = ((...args: Parameters<typeof Buffer.concat>) => note(Reflect.apply(concat, Buffer, args))) as typeof Buffer.concat;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const s = Reflect.apply(stringify, JSON, args); if (s !== undefined) json += s.length * 2; return s;
  }) as typeof JSON.stringify;
  TextDecoder.prototype.decode = function (...args) { const s = decode.apply(this, args); utf16 += s.length * 2; return s; };
  try { work(); return { backing, json, utf16 }; }
  finally { Buffer.from = from; Buffer.alloc = alloc; Buffer.concat = concat; JSON.stringify = stringify; TextDecoder.prototype.decode = decode; }
}

test('maximum escaping text, IDs, URL and retained receipt traverse native SDK callbacks under real credits', async t => {
  const control = observe(() => { Buffer.alloc(65537); Buffer.from('control'); JSON.stringify({ n: 1 }); new TextDecoder().decode(new Uint8Array(10)); });
  assert.equal(control.backing >= 65537 + 8192, true); assert.equal(control.json, 14); assert.equal(control.utf16, 20);
  const { s, k } = await inboxOwned(t); const a = pair('\\'.repeat(256), '"'.repeat(256)); const b = pair('z'.repeat(256), 'y'.repeat(256), 2);
  const prefix = 'https://synthetic.example.invalid/';
  a.route.route = validateRoute({ serviceUrl: prefix + 'x'.repeat(2048 - prefix.length - 1) + '/', channelId: 'msteams',
    bot: { id: '"'.repeat(256), role: 'bot' }, conversation: { id: '\\'.repeat(256), conversationType: 'personal', tenantId: 'Tenant' } });
  a.route.routeDigest = digest(encode(a.route.route));
  a.event.body = validateEvent({ protocolVersion: 'orka.gateway.v1', externalEventId: a.id, eventType: 'text', accountId: 'Tenant',
    contextId: a.route.route.conversation.id, sender: { id: '\\'.repeat(256), displayName: '"'.repeat(256) },
    text: '"'.repeat(65536), replyTarget: a.target, occurredAt: '2025-01-01T00:00:00.123456789+00:00' });
  a.event.bodyDigest = digest(encode(a.event.body)); a.event.fingerprint = fingerprint(a.event.body, a.route.route, ingressBinding.scope as never);
  Object.assign(a.event, { received: MAX_INBOX_TIME, deadline: Number.MAX_SAFE_INTEGER, nextAttempt: Number.MAX_SAFE_INTEGER,
    state: 'blocked', reason: 'invalid-event', attempt: Number.MAX_SAFE_INTEGER, attemptId, attemptEpoch: 1 });
  Object.assign(b.event, { received: MAX_INBOX_TIME, deadline: Number.MAX_SAFE_INTEGER, state: 'terminal', body: null,
    receipt: { status: 'duplicate', eventId: '\\'.repeat(256), state: 'Completed' } });
  const bodyBytes = encode(a.event.body).length; const payloadBytes = encode(a.event).length; const routeBytes = encode(a.route).length;
  await install(k, { state: stateFixture({ records: 2, bodies: 1, lastNow: MAX_INBOX_TIME }), pairs: [a, b] });
  let callbackMaxBacking = 0; let callbackMaxJSON = 0; let callbackMaxUTF16 = 0; let callbacks = 0; let checked = 0;
  const add = InboxIndex.prototype.addEvent; const finish = InboxIndex.prototype.finishBuild;
  InboxIndex.prototype.addEvent = function (...args) {
    assert.equal(this.diagnostics().working.scratch, 2240 * 1024);
    assert.equal(Object.hasOwn(args[0].event, 'body'), false); checked++; add.apply(this, args);
  };
  InboxIndex.prototype.finishBuild = function (...args) {
    // Exercises actual nested graph calls while the external reservation is held.
    assert.equal(this.diagnostics().working.scratch, 2240 * 1024); checked++; finish.apply(this, args);
  };
  const owned = k.auditOwned.bind(k);
  k.auditOwned = (visitor, budget, options) => owned({ ...visitor, record(pass, record) {
    const counts = observe(() => { visitor.record(pass, record); }); callbacks++;
    callbackMaxBacking = Math.max(callbackMaxBacking, counts.backing); callbackMaxJSON = Math.max(callbackMaxJSON, counts.json);
    callbackMaxUTF16 = Math.max(callbackMaxUTF16, counts.utf16);
  } }, budget, options);
  const before = { reads: s.stats.reads, pages: s.stats.pages }; let collectionBytes = 0;
  s.controls.hook = e => {
    if (!e.path.includes(",RowKey='M'")) {
      const end = e.res.end.bind(e.res);
      e.res.end = ((chunk: string, ...rest: unknown[]) => { collectionBytes += Buffer.byteLength(chunk); return Reflect.apply(end, e.res, [chunk, ...rest]); }) as typeof e.res.end;
    }
    e.reply();
  };
  try {
    const result = await auditInbox(k, ingressBinding, auditBudget, indexBudget);
    assert.equal(callbacks, 10); assert.equal(checked, 3); assert.equal(s.stats.reads - before.reads, 4); assert.equal(s.stats.pages - before.pages, 10);
    assert.equal(result.index.eventLengths(a.id).bodyEncodingBytes, bodyBytes);
    assert.equal(result.index.eventLengths(a.id).payloadBytes, payloadBytes);
    assert.equal(result.header.metadata.state.buffer.byteLength, result.header.metadata.state.length);
    assert.equal(result.header.metadata.result.buffer.byteLength, result.header.metadata.result.length);
    assert.equal(result.index.diagnostics().working.meta, 65536); assert.equal(result.index.diagnostics().working.scratch, 0);
    assert.equal(callbackMaxBacking > 3 * 65536, true); assert.equal(callbackMaxJSON > 2 * 65536, true); assert.equal(callbackMaxUTF16 > 2 * 65536, true);
    const charge = result.index.reserveWorking('scratch', 2240 * 1024);
    assert.equal(result.index.firstDue(MAX_INBOX_TIME), undefined); result.index.releaseWorking(charge);
    result.dispose(); assert.equal(result.index.diagnostics().chargedBytes, 0);
    assert.throws(() => result.header);
    t.diagnostic(`bytes only: body=${bodyBytes}, event=${payloadBytes}, route=${routeBytes}, collections=${collectionBytes}, callbackBacking=${callbackMaxBacking}, callbackJSON=${callbackMaxJSON}, callbackUTF16=${callbackMaxUTF16}`);
  } finally { InboxIndex.prototype.addEvent = add; InboxIndex.prototype.finishBuild = finish; delete s.controls.hook; }
  await k.close();
});
