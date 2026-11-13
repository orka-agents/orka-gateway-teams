import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { KubernetesContext } from '../src/registry/kubernetes.js';
import { snapshotRegistry } from '../src/registry/config.js';
import { createRegistryAdmission } from '../src/registry/admission.js';
import { BindingCheckError } from '../src/directory/provision.js';
import { bindingName } from '../src/directory/codec.js';
import { openDirectory } from '../src/directory/store.js';
import { DirectoryError } from '../src/directory/types.js';
import type { ConnectionRecord } from '../src/directory/types.js';
import type { PolicyAdmission } from '../src/policy/admission.js';
import type { AdmissionContext } from '../src/ingress/server.js';
import type { IngressClaim, ReplyRoute } from '../src/ingress/types.js';
import type { ProviderResult } from '../src/outbound/types.js';
import { expectedEvent } from './fixtures/incoming.js';
import { memoryDirectoryTable } from './support/directory-memory.js';
import { registryInput } from './support/registry.js';
import { deferred } from './support/ingress-auth.js';

const context = (activityId: string = randomUUID()): AdmissionContext => ({ activityId, signal: new AbortController().signal,
  deadline: performance.now() + 10000, commandText: 'help', subject: { tenantId: expectedEvent.accountId, objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', chatKind: 'personal' } });
async function fixture(t: test.TestContext, count = 2, delegated?: Parameters<typeof createRegistryAdmission>[0]['delegated']) {
  const input = registryInput(count); if (count === 32) for (const target of input.targets) target.label = '\\'.repeat(256);
  const config = snapshotRegistry(input); const scope = { appId: config.targets[0]!.config.scope.appId, tenantId: expectedEvent.accountId };
  const memory = memoryDirectoryTable(); const directory = await openDirectory(memory.table, context()); t.after(() => directory.close());
  let eligible: PolicyAdmission = { kind: 'eligible', targets: config.targets.map(t => ({ id: t.id, label: t.label })) };
  let authorized = 0; let outcome: ProviderResult = { kind: 'delivered', providerMessageId: 'receipt' }; let allowed = true;
  const sent: { text: string; route: unknown }[] = []; const admitted: string[] = []; const checks: string[] = []; let failCheck = false; let failureCategory: BindingCheckError['category'] = 'binding-conflict';
  let checkGate: Promise<void> | undefined; let sendGate: Promise<void> | undefined;
  const evidence = (c: ConnectionRecord) => ({ namespace: 'default', name: c.bindingName, uid: 'uid', generation: 1, spec: {} });
  const slots = config.targets.map(target => ({ target, inbox: { admit: async (event: typeof expectedEvent) => {
    admitted.push(target.id); return { kind: 'accepted' as const, replyTarget: event.replyTarget! };
  } }, provisioner: { reconcile: async (c: ConnectionRecord) => { checks.push('reconcile:' + target.id); await checkGate; if (failCheck) throw new BindingCheckError('target-paused'); return evidence(c); },
    check: async (c: ConnectionRecord, _ctx: KubernetesContext) => { checks.push('check:' + target.id); await checkGate; if (failCheck) throw new BindingCheckError(failureCategory); return evidence(c); } } }));
  const authority = { allowed: () => allowed, revalidate: async () => allowed, lost: new AbortController().signal };
  const logs: string[] = [];
  const sink = createRegistryAdmission({ config, directory, slots, authority, active: () => allowed,
    ...(delegated ? { delegated } : {}),
    authorizer: { authorize: async () => { authorized++; return eligible; } }, log: (category, target) => logs.push(category + ':' + target) });
  sink.bindControlSender({ send: async (route, message) => {
    sent.push({ text: JSON.stringify(message), route }); await sendGate; return outcome;
  } });
  const event = { ...expectedEvent, text: 'help' }; const route: ReplyRoute = { serviceUrl: 'https://teams-service.example.invalid/', channelId: 'msteams',
    bot: { id: '28:fixture-app', role: 'bot' }, conversation: { id: event.contextId, tenantId: scope.tenantId, conversationType: 'personal' } };
  const run = (text = 'help', id: string = randomUUID(), changed = {}) => sink.admit({ ...event, ...changed, text }, route, { ...context(id), commandText: text,
    delegatedTenant: true, controlRecipient: { id: '29:fixture-person' } });
  const provision = async (id = 'primary', conversationId = event.contextId) => {
    const target = config.targets.find(t => t.id === id)!;
    const conn: ConnectionRecord = { schema: 1, kind: 'conn', scope, conversationId, chatKind: 'personal', targetId: id,
      identityDigest: target.identityDigest!, bindingName: bindingName(scope, conversationId, target.identityDigest!), state: 'reserved' };
    return directory.markProvisioned(await directory.reserveConnection(conn, context()), evidence(conn), context());
  };
  return { sink, directory, scope, config, slots, event, route, run, provision, sent, admitted, checks, logs, authorized: () => authorized,
    policy: (value: PolicyAdmission) => { eligible = value; }, outcome: (value: ProviderResult) => { outcome = value; },
    fail: (value: boolean, category: BindingCheckError['category'] = 'binding-conflict') => { failCheck = value; failureCategory = category; }, checkGate: (value: Promise<void>) => { checkGate = value; },
    sendGate: (value: Promise<void>) => { sendGate = value; }, revoke: () => { allowed = false; } };
}

test('discovery and explicit choice create no Task; connected ordinary text reaches only pinned inbox', async t => {
  const f = await fixture(t); assert.equal((await f.run()).kind, 'accepted'); assert.match(f.sent[0]!.text, /use primary/);
  assert.equal(await f.directory.getConnection(f.event.contextId, context()), undefined); assert.deepEqual(f.admitted, []);
  assert.equal((await f.run('use tools')).kind, 'accepted'); assert.equal((await f.directory.getConnection(f.event.contextId, context()))!.targetId, 'tools');
  assert.deepEqual(f.admitted, []); assert.match(f.sent[1]!.text, /Send your request again/);
  assert.equal((await f.run('request')).kind, 'accepted'); assert.deepEqual(f.admitted, ['tools']); assert.ok(f.checks.includes('check:tools'));
  await f.run('use tools'); assert.ok(f.checks.includes('reconcile:tools'));
  await f.run('use primary'); assert.match(f.sent.at(-1)!.text, /switching|Switching/); assert.deepEqual(f.admitted, ['tools']);
});

test('no-access including unknown or ineligible choices uses reservation, no connection or Task', async t => {
  const f = await fixture(t); f.policy({ kind: 'no-access', text: 'ignored input' });
  await f.run('use primary'); await f.run('anything');
  f.policy({ kind: 'eligible', targets: [{ id: 'primary', label: 'primary' }] }); await f.run('use tools'); await f.run('use unknown');
  for (const send of f.sent) { assert.match(send.text, /You don't have access/); assert.doesNotMatch(send.text, /tools|unknown/); }
  assert.equal(await f.directory.getConnection(f.event.contextId, context()), undefined); assert.equal(f.admitted.length, 0);
});

test('duplicate command is reauthorized, changed identity conflicts before effects, terminal send never repeats', async t => {
  const f = await fixture(t); const id = randomUUID(); await f.run('use primary', id); const n = f.checks.length;
  assert.equal((await f.run('use tools', id)).kind, 'conflict'); assert.equal(f.checks.length, n); assert.equal(f.sent.length, 1);
  assert.equal((await f.run('use primary', id)).kind, 'duplicate'); assert.equal(f.sent.length, 1); assert.equal(f.authorized(), 3);
  f.policy({ kind: 'no-access', text: '' }); await f.run('use primary', id); assert.equal(f.sent.length, 1); assert.equal(f.admitted.length, 0);
  await f.run('request'); assert.match(f.sent.at(-1)!.text, /You don't have access/); assert.equal(f.admitted.length, 0);
});

for (const kind of ['unknown', 'retryable'] as const) test(`control ${kind} preserves original route and retry semantics`, async t => {
  const f = await fixture(t); f.outcome({ kind }); const id = randomUUID(); await f.run('help', id);
  const key = { kind: 'control' as const, conversationId: f.event.contextId, activityId: id };
  assert.equal((await f.directory.getControl(key, context()))!.state, kind === 'unknown' ? 'unknown' : 'ready');
  await f.run('help', id); assert.equal(f.sent.length, kind === 'unknown' ? 1 : 2);
});

test('failed provisioning still binds command identity before another command or retry', async t => {
  const f = await fixture(t); f.fail(true); const id = randomUUID();
  assert.equal((await f.run('use primary', id)).kind, 'full');
  assert.equal((await f.run('use tools', id)).kind, 'conflict'); assert.equal(f.sent.length, 0);
  assert.equal((await f.directory.getConnection(f.event.contextId, context()))!.targetId, 'primary');
});

test('command reserved before connection write can resume after a no-effect storage interruption', async t => {
  const f = await fixture(t); const reserve = f.directory.reserveConnection;
  f.directory.reserveConnection = async () => { throw new DirectoryError('unavailable'); }; const id = randomUUID();
  assert.equal((await f.run('use primary', id)).kind, 'full');
  const saved = await f.directory.getControl({ kind: 'control', conversationId: f.event.contextId, activityId: id }, context());
  assert.equal(saved?.state, 'ready'); assert.equal(f.sent.length, 0);
  f.directory.reserveConnection = reserve;
  assert.equal((await f.run('use primary', id)).kind, 'accepted'); assert.match(f.sent[0]!.text, /This chat uses primary/);
});

test('new policy before saved discovery prevents exposing a formerly eligible target', async t => {
  const f = await fixture(t); f.outcome({ kind: 'retryable' }); const id = randomUUID(); await f.run('help', id);
  f.policy({ kind: 'eligible', targets: [{ id: 'primary', label: 'primary' }] });
  assert.equal((await f.run('help', id)).kind, 'conflict'); assert.equal(f.sent.length, 1);
});

test('first-choice races stay permanent and altered command creates no second connection effect', async t => {
  const f = await fixture(t); const results = await Promise.all([f.run('use primary'), f.run('use tools')]);
  assert.ok(results.some(r => r.kind === 'accepted')); const c = await f.directory.getConnection(f.event.contextId, context()); assert.ok(c);
  assert.ok(['primary', 'tools'].includes(c.targetId)); assert.equal(f.admitted.length, 0);
});

test('late readiness after cancellation or authority loss cannot admit or send', async t => {
  for (const reason of ['cancel', 'authority'] as const) {
    const f = await fixture(t); await f.provision(); const gate = deferred<void>(); f.checkGate(gate.promise);
    const abort = new AbortController(); const ctx = { ...context(), signal: abort.signal, deadline: performance.now() + 10000 };
    const pending = f.sink.admit({ ...f.event, text: 'request' }, f.route, ctx);
    while (!f.checks.length) await new Promise(resolve => setImmediate(resolve));
    if (reason === 'cancel') abort.abort(); if (reason === 'authority') f.revoke();
    gate.resolve(); await pending; assert.equal(f.admitted.length, 0); assert.equal(f.sent.length, 0);
  }
});

test('four whole operations retain directory capacity through settlement; fifth refuses before effect', async t => {
  const f = await fixture(t, 6); const gate = deferred<void>(); f.sendGate(gate.promise);
  const pending = Array.from({ length: 4 }, () => f.run());
  while (f.sent.length < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.run()).kind, 'full');
  const claim: IngressClaim = { externalEventId: f.event.externalEventId, attemptId: randomUUID(), attempt: 1, event: f.event };
  assert.equal(await f.sink.preflight('target-5', claim, context().signal), false);
  gate.resolve(); await Promise.all(pending);
});

test('paused target retries are coalesced/rate limited and successful recovery checks each conversation afresh', async t => {
  const f = await fixture(t); await f.provision(); f.fail(true, 'target-paused'); assert.equal((await f.run('request')).kind, 'full');
  const before = f.checks.length; assert.equal((await f.run('request')).kind, 'full'); assert.equal(f.checks.length, before);
  assert.equal(f.logs.filter(s => s.startsWith('target-paused')).length, 1); f.fail(false);
  await new Promise(resolve => setTimeout(resolve, 1010)); assert.equal((await f.run('request')).kind, 'accepted');
  assert.equal(f.admitted.length, 1);
});

test('one connection conflict or caller cancellation does not pause healthy chats on the target', async t => {
  for (const failure of ['conflict', 'cancel'] as const) {
    const f = await fixture(t); await f.provision(); await f.provision('primary', 'healthy-chat');
    const check = f.slots[0]!.provisioner.check;
    const gate = deferred<void>(); let entered = false;
    f.slots[0]!.provisioner.check = async (c, ctx) => {
      if (c.conversationId === f.event.contextId) { entered = true;
        if (failure === 'conflict') throw new BindingCheckError('binding-conflict'); await gate.promise;
      }
      return check(c, ctx);
    };
    const abort = new AbortController(); const pending = f.sink.admit(f.event, f.route, { ...context(), signal: abort.signal });
    while (!entered) await new Promise(resolve => setImmediate(resolve));
    if (failure === 'cancel') abort.abort(); gate.resolve(); assert.equal((await pending).kind, 'full');
    const healthy = { ...f.event, contextId: 'healthy-chat' }; const route = { ...f.route, conversation: { ...f.route.conversation, id: healthy.contextId } };
    assert.equal((await f.sink.admit(healthy, route, context())).kind, 'accepted');
    assert.equal(await f.sink.preflight('primary', { externalEventId: healthy.externalEventId, attemptId: randomUUID(), attempt: 1, event: healthy }, context().signal), true);
  }
});

test('recovery joiners retain their own cancellation and two-second preflight deadline', async t => {
  const f = await fixture(t); await f.provision(); f.fail(true, 'target-paused'); await f.run('request');
  f.fail(false); await new Promise(resolve => setTimeout(resolve, 1010));
  const gate = deferred<void>(); f.checkGate(gate.promise); const before = f.checks.length;
  const recovery = f.run('request'); t.after(() => gate.resolve());
  while (f.checks.length === before) await new Promise(resolve => setImmediate(resolve));
  const abort = new AbortController(); let cancelled = false;
  const joined = Promise.resolve(f.sink.admit(f.event, f.route, { ...context(), signal: abort.signal })).then(r => { cancelled = true; return r; });
  // Allow the caller to reach the shared recovery before disconnecting.
  for (let n = 0; n < 4; n++) await new Promise(resolve => setImmediate(resolve));
  abort.abort(); for (let n = 0; n < 2; n++) await new Promise(resolve => setImmediate(resolve));
  const released = cancelled;
  let preflightDone = false;
  const preflight = f.sink.preflight('primary', { externalEventId: f.event.externalEventId, attemptId: randomUUID(), attempt: 1, event: f.event }, context().signal).then(r => { preflightDone = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 2200)); const deadlineRespected = preflightDone;
  gate.resolve(); await recovery; assert.equal((await joined).kind, 'full'); assert.equal(await preflight, false);
  assert.equal(released, true, 'cancelled joiner must release before the recoverer completes');
  assert.equal(deadlineRespected, true, 'two-second preflight must not inherit the admission recovery budget');
});

test('missing or wrong-target relay evidence is retry-only without connection creation or membership lookup', async t => {
  const f = await fixture(t); const claim: IngressClaim = { externalEventId: f.event.externalEventId, attemptId: randomUUID(), attempt: 1, event: f.event };
  assert.equal(await f.sink.preflight('primary', claim, context().signal), false); assert.equal(f.authorized(), 0);
  await f.provision('tools'); assert.equal(await f.sink.preflight('primary', claim, context().signal), false);
  assert.equal(await f.sink.preflight('tools', claim, context().signal), true); assert.equal(f.admitted.length, 0);
});

test('maximum discovery labels remain literal and entire control message fits the confined sender budget', async t => {
  const f = await fixture(t, 32); await f.run();
  assert.ok(Buffer.byteLength(f.sent[0]!.text) <= 20 * 1024);
  const card = JSON.parse(f.sent[0]!.text).attachments[0].content;
  assert.equal(card.body[0].type, 'RichTextBlock');
});

test('retryable connected notification rechecks readiness before a new control attempt', async t => {
  const f = await fixture(t); f.outcome({ kind: 'retryable' }); const id = randomUUID(); await f.run('use primary', id);
  f.fail(true); assert.equal((await f.run('use primary', id)).kind, 'full'); assert.equal(f.sent.length, 1);
});

test('expired original deadline and corrupt directory cannot admit a late result', async t => {
  const f = await fixture(t); await f.provision(); const gate = deferred<void>(); f.checkGate(gate.promise);
  const pending = f.sink.admit({ ...f.event, text: 'request' }, f.route, { ...context(), deadline: performance.now() + 30 });
  while (!f.checks.length) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 40)); gate.resolve();
  assert.equal((await pending).kind, 'full'); assert.equal(f.admitted.length, 0);
  f.directory.getConnection = async () => { throw new DirectoryError('corrupt'); };
  await assert.rejects(async () => f.run(), { code: 'corrupt' });
});

test('late directory integrity failure remains fatal even when caller disconnects', async t => {
  const f = await fixture(t); const gate = deferred<void>(); let entered = false;
  f.directory.getConnection = async () => { entered = true; await gate.promise; throw new DirectoryError('corrupt'); };
  const abort = new AbortController(); const pending = f.sink.admit(f.event, f.route, { ...context(), signal: abort.signal });
  while (!entered) await new Promise(resolve => setImmediate(resolve)); abort.abort(); gate.resolve();
  await assert.rejects(Promise.resolve(pending), { code: 'corrupt' });
});

test('Graph failure is transient and channels touch neither policy nor directory', async t => {
  const f = await fixture(t); f.policy({ kind: 'unavailable', category: 'graph-unavailable' }); assert.equal((await f.run()).kind, 'full');
  assert.equal(f.sent.length, 0); const n = f.authorized();
  assert.equal((await f.sink.admit(f.event, { ...f.route, conversation: { ...f.route.conversation, conversationType: 'channel' }, requester: f.event.sender, threadId: 'root' }, context())).kind, 'conflict');
  assert.equal(f.authorized(), n);
});

function delegatedFixture() {
  const ch = { id: 'opaque-challenge', objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', conversationId: expectedEvent.contextId,
    activityId: 'work', generation: 1, expiresAt: Date.now() + 600000, state: 'open' as const };
  let linked = false; let claimed = false; let done = false; let exchanges = 0; let verifies = 0; let disconnects = 0;
  let gate: Promise<void> | undefined;
  const accounts = {
    inspect: async () => ({ generation: 1, linked }),
    challenge: async () => ch, getChallenge: async (id: string) => id === ch.id ? ch : undefined,
    claim: async () => done ? 'done' as const : claimed ? 'unavailable' as const : (claimed = true, 'claimed' as const),
    complete: async () => { done = true; linked = true; return true; },
    acquire: async () => linked ? { kind: 'token' as const, accessToken: 'synthetic-private-workiq' } : { kind: 'signin-required' as const },
    disconnect: async () => { disconnects++; linked = false; return 2; }, close: async () => {},
  };
  const auth = { verify: async (raw: string, oid: string) => { verifies++; if (raw !== 'synthetic-private-assertion' || oid !== ch.objectId) throw new Error('Rejected');
    return { assertionExpiresAt: Date.now() + 600000 }; },
    exchange: async () => { exchanges++; await gate; return { accessToken: 'synthetic-private-workiq', expiresAt: Date.now() + 60000 }; }, close: async () => {} };
  return { delegated: { accounts, auth, apiUri: 'api://gateway', connectionName: 'workiq' }, ch,
    exchanges: () => exchanges, verifies: () => verifies, disconnects: () => disconnects,
    gate: (value: Promise<void>) => { gate = value; } };
}

test('SSO is not needed for discovery/use; work reserves one sign-in card, never an old event', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, d.delegated);
  await f.run('help'); await f.run('use primary'); assert.equal(f.sent.length, 2);
  await f.run('work', 'work'); assert.equal(f.admitted.length, 0); assert.match(f.sent[2]!.text, /card.oauth/);
  assert.doesNotMatch(JSON.stringify(f.sent), /synthetic-private/);
  await f.run('work', 'work'); assert.equal(f.sent.length, 3); assert.equal(f.admitted.length, 0);
  assert.equal(d.exchanges(), 0);
});

test('SSO wrong sender/conversation/token rejects before effects; duplicate invokes join one exchange and send completion once', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, d.delegated); await f.provision();
  const ctx = context();
  const invoke = { type: 'invoke', name: 'signin/tokenExchange', channelData: { tenant: { id: f.scope.tenantId } },
    conversation: { ...f.route.conversation }, from: { id: '29:fixture-person', aadObjectId: d.ch.objectId },
    recipient: f.route.bot, serviceUrl: f.route.serviceUrl,
    value: { id: d.ch.id, connectionName: 'workiq', token: 'synthetic-private-assertion' } };
  const exchange = (input: unknown = invoke, supplied = ctx) => f.sink.exchange!(input, supplied);
  assert.equal((await exchange({ ...invoke, conversation: { ...invoke.conversation, id: 'other' } })).status, 412);
  assert.equal((await exchange(invoke, { ...ctx, subject: { ...ctx.subject, objectId: f.config.targets[0]!.config.scope.appId } })).status, 412);
  assert.equal((await exchange({ ...invoke, value: { ...invoke.value, token: 'wrong-token' } })).status, 412);
  assert.equal(d.exchanges(), 0); assert.equal(f.sent.length, 0);
  const held = deferred<void>(); d.gate(held.promise);
  const first = exchange(); while (!d.exchanges()) await new Promise(r => setImmediate(r)); const second = exchange(); held.resolve();
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.equal(d.exchanges(), 1); assert.equal(f.admitted.length, 0); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /[Ss]end your request again/);
  assert.equal((await exchange()).status, 200); assert.equal(f.sent.length, 1); assert.equal(d.exchanges(), 1);
  await f.run('new work'); assert.equal(f.admitted.length, 1);
  await f.run('disconnect'); assert.equal(d.disconnects(), 1); assert.equal(f.admitted.length, 1);
  assert.doesNotMatch(JSON.stringify({ sent: f.sent, logs: f.logs, admitted: f.admitted }), /synthetic-private/);
});
