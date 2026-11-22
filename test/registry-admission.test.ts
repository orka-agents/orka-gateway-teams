import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeIngressStore, openIngressStore } from '../src/ingress/store.js';
import test from 'node:test';
import type { KubernetesContext } from '../src/registry/kubernetes.js';
import { snapshotRegistry } from '../src/registry/config.js';
import { createRegistryAdmission } from '../src/registry/admission.js';
import { BindingCheckError } from '../src/directory/provision.js';
import { bindingName } from '../src/directory/codec.js';
import { openDirectory } from '../src/directory/store.js';
import { DirectoryError } from '../src/directory/types.js';
import { AccountError } from '../src/accounts/store.js';
import type { Proposal, ProposalVersion } from '../src/accounts/pull-request-proposal.js';
import { proposalFixture } from './support/pull-request-proposal.js';
import type { TaskGrant } from '../src/accounts/grants.js';
import { grantReference } from '../src/accounts/grants.js';
import type { AccountChallenge, BrowserAttempt } from '../src/accounts/store.js';
import type { ConnectionRecord } from '../src/directory/types.js';
import { createGroupAuthorizer } from '../src/policy/admission.js';
import type { PolicyAdmission } from '../src/policy/admission.js';
import { snapshotGroupPolicy } from '../src/policy/config.js';
import type { AdmissionContext } from '../src/ingress/server.js';
import { createExternalEventId } from '../src/teams/ids.js';
import type { EventEnvelope } from '../src/protocol/types.js';
import type { AdmissionResult, IngressClaim, ReplyRoute } from '../src/ingress/types.js';
import type { ProviderResult } from '../src/outbound/types.js';
import { expectedEvent } from './fixtures/incoming.js';
import { memoryDirectoryTable } from './support/directory-memory.js';
import { registryInput } from './support/registry.js';
import { deferred } from './support/ingress-auth.js';

const context = (activityId: string = randomUUID()): AdmissionContext => ({ activityId, signal: new AbortController().signal,
  deadline: performance.now() + 10000, commandText: 'help', subject: { tenantId: expectedEvent.accountId, objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', chatKind: 'personal' } });
async function fixture(t: test.TestContext, count = 2, delegated?: Parameters<typeof createRegistryAdmission>[0]['delegated'], chatKind: 'personal' | 'groupChat' = 'personal',
  proposals?: Parameters<typeof createRegistryAdmission>[0]['proposals'], logProposalText?: readonly (boolean | undefined)[], safeOutput?: (text: string) => boolean) {
  const input = registryInput(count); const texts: { line: string; cardsBefore: number }[] = [];
  logProposalText?.forEach((flag, i) => { if (flag !== undefined) (input.targets[i] as Record<string, unknown>).logProposalText = flag; }); if (count === 32) for (const target of input.targets) target.label = '\\'.repeat(256);
  const config = snapshotRegistry(input); const scope = { appId: config.targets[0]!.config.scope.appId, tenantId: expectedEvent.accountId };
  const memory = memoryDirectoryTable(); const directory = await openDirectory(memory.table, context()); t.after(() => directory.close());
  let eligible: PolicyAdmission = { kind: 'eligible', targets: config.targets.map(t => ({ id: t.id, label: t.label })) };
  let policyAuthorizer: Pick<ReturnType<typeof createGroupAuthorizer>, 'authorize'> | undefined;
  let authorized = 0; let outcome: ProviderResult = { kind: 'delivered', providerMessageId: 'receipt' }; let allowed = true;
  const turns: { event: Readonly<EventEnvelope>; route: Readonly<ReplyRoute> }[] = [];
  const sent: { text: string; route: unknown }[] = []; const admitted: string[] = []; const checks: string[] = []; let failCheck = false; let failureCategory: BindingCheckError['category'] = 'binding-conflict';
  let checkGate: Promise<void> | undefined; let sendGate: Promise<void> | undefined; let agent = { uid: 'agent-uid', generation: 1 };
  const evidence = (c: ConnectionRecord) => ({ namespace: 'default', name: c.bindingName, uid: 'uid', generation: 1, spec: {} });
  const slots = config.targets.map(target => ({ target, inbox: { admit: async (event: Readonly<EventEnvelope>, route: Readonly<ReplyRoute>): Promise<AdmissionResult> => {
    turns.push(structuredClone({ event, route })); admitted.push(target.id); return { kind: 'accepted' as const, replyTarget: event.replyTarget! };
  } }, provisioner: { reconcile: async (c: ConnectionRecord) => { checks.push('reconcile:' + target.id); await checkGate; if (failCheck) throw new BindingCheckError('target-paused'); return evidence(c); },
    check: async (c: ConnectionRecord, _ctx: KubernetesContext) => { checks.push('check:' + target.id); await checkGate; if (failCheck) throw new BindingCheckError(failureCategory); return evidence(c); },
    revision: async () => ({ ...agent }) } }));
  const authority = { allowed: () => allowed, revalidate: async () => allowed, lost: new AbortController().signal };
  const logs: string[] = [];
  const makeSink = () => createRegistryAdmission({ config, directory, slots, authority, active: () => allowed,
    ...(delegated ? { delegated } : {}), ...(proposals ? { proposals } : {}), ...(safeOutput ? { safeOutput } : {}),
    logProposalText: line => texts.push({ line, cardsBefore: sent.length }),
    authorizer: { authorize: async (...args) => { authorized++; return policyAuthorizer ? policyAuthorizer.authorize(...args) : eligible; } }, log: (category, target, detail) => logs.push(category + ':' + target + (detail ? ' ' + JSON.stringify(detail) : '')) });
  const sink = makeSink();
  const bindSender = (s: typeof sink) => s.bindControlSender({ send: async (route, message) => {
    sent.push({ text: JSON.stringify(message), route }); await sendGate; return outcome;
  } });
  bindSender(sink);
  const event = { ...expectedEvent, text: 'help' }; const baseRoute = { serviceUrl: 'https://teams-service.example.invalid/', channelId: 'msteams' as const,
    bot: { id: '28:fixture-app', role: 'bot' as const } };
  const route: ReplyRoute = chatKind === 'groupChat' ? { ...baseRoute, conversation: { id: event.contextId, tenantId: scope.tenantId, conversationType: 'groupChat' }, requester: event.sender } :
    { ...baseRoute, conversation: { id: event.contextId, tenantId: scope.tenantId, conversationType: 'personal' } };
  const run = (text = 'help', id: string = randomUUID(), changed = {}) => sink.admit({ ...event, ...changed, text }, route, { ...context(id), commandText: text,
    delegatedTenant: true, controlRecipient: { id: '29:fixture-person', ...(chatKind === 'groupChat' ? { isTargeted: true as const } : {}) } });
  const provision = async (id = 'primary', conversationId = event.contextId, chatKind: 'personal' | 'groupChat' = 'personal', legacy = false) => {
    const target = config.targets.find(t => t.id === id)!;
    const conn: ConnectionRecord = { schema: 1, kind: 'conn', scope, conversationId, chatKind, targetId: id,
      identityDigest: target.identityDigest!, bindingName: bindingName(scope, conversationId, target.identityDigest!), state: 'reserved' };
    return directory.markProvisioned(await directory.reserveConnection(conn, context()), evidence(conn), context(), legacy ? undefined : { uid: 'agent-uid', generation: 1 });
  };
  return { sink, restart: () => { const s = makeSink(); bindSender(s); return s; }, directory, scope, config, slots, event, route, run, provision, sent, admitted, turns, checks, logs, texts, authorized: () => authorized,
    authorizeWith: (value: typeof policyAuthorizer) => { policyAuthorizer = value; },
    policy: (value: PolicyAdmission) => { eligible = value; }, outcome: (value: ProviderResult) => { outcome = value; },
    fail: (value: boolean, category: BindingCheckError['category'] = 'binding-conflict') => { failCheck = value; failureCategory = category; }, checkGate: (value: Promise<void>) => { checkGate = value; },
    sendGate: (value: Promise<void>) => { sendGate = value; }, revoke: () => { allowed = false; },
    agent: (value: { uid: string; generation: number }) => { agent = value; } };
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
  assert.equal(await f.sink.preflight('target-5', claim, context().signal), 'busy');
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
    const healthy = { ...f.event, contextId: 'healthy-chat' }; const route: ReplyRoute = { serviceUrl: f.route.serviceUrl, channelId: 'msteams', bot: f.route.bot,
      conversation: { id: healthy.contextId, tenantId: f.scope.tenantId, conversationType: 'personal' } };
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
  gate.resolve(); await recovery; assert.equal((await joined).kind, 'full'); assert.equal(await preflight, 'deadline');
  assert.equal(released, true, 'cancelled joiner must release before the recoverer completes');
  assert.equal(deadlineRespected, true, 'two-second preflight must not inherit the admission recovery budget');
});

test('missing or wrong-target relay evidence is retry-only without connection creation or membership lookup', async t => {
  const f = await fixture(t); const claim: IngressClaim = { externalEventId: f.event.externalEventId, attemptId: randomUUID(), attempt: 1, event: f.event };
  assert.equal(await f.sink.preflight('primary', claim, context().signal), 'connection-missing'); assert.equal(f.authorized(), 0);
  await f.provision('tools'); assert.equal(await f.sink.preflight('primary', claim, context().signal), 'connection-mismatch');
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
  let gate: Promise<void> | undefined; let consumed = false;
  const attempt = { challenge: ch, state: 'synthetic-private-state', nonce: 'synthetic-private-nonce', verifier: 'synthetic-private-verifier' };
  const accounts = {
    providerIdentity: async () => undefined,
    getProposal: async (): Promise<ProposalVersion | undefined> => undefined, reserveProposal: async () => { throw new Error('not a proposal'); },
    replaceProposal: async () => { throw new Error('not a proposal'); }, claimProposal: async () => { throw new Error('not a proposal'); },
    reserveProposalWrite: async () => { throw new Error('not a proposal'); }, completeProposalWrite: async () => { throw new Error('not a proposal'); },
    visitRecoverableProposals: async () => {}, proposalWriteOutcome: async () => undefined, fenceUnsentProposal: async (): Promise<'uncertain'> => 'uncertain',
    reserveGrant: async (input: TaskGrant) => input,
    getGrant: async (_ref: string) => undefined as TaskGrant | undefined,
    watch: () => { throw new Error('not a tool handoff'); },
    pin: () => { throw new Error('not a tool handoff'); },
    safeGrantOutput: async () => true, safeOutput: async (_subject: unknown, _generation: number, _text: string, _ctx: unknown) => true, invalidate: async () => {},
    reserveWrite: async () => { throw new Error('not a write'); }, completeWrite: async () => {},
    bindGrant: async () => { throw new Error('not issuance'); },
    prepareGitHub: async () => undefined, claimGitHub: async () => undefined,
    prepareBrowser: async (_ch: AccountChallenge) => consumed || done ? undefined : attempt,
    claimBrowser: async (state: string) => {
      if (consumed || state !== attempt.state) return undefined;
      consumed = true; return { ...attempt, challenge: { ...ch, method: 'browser' as const } };
    },
    published: async (_ch: AccountChallenge) => done && linked,
    inspect: async (_subject?: unknown, _ctx?: unknown, _forDisconnect?: boolean) => ({ generation: 1, linked }),
    challenge: async () => ch, getChallenge: async (id: string) => id === ch.id ? ch : undefined,
    claim: async () => done ? 'done' as const : claimed ? 'unavailable' as const : (claimed = true, 'claimed' as const),
    complete: async () => { done = true; linked = true; return true; },
    acquire: async () => linked ? { kind: 'token' as const, accessToken: 'synthetic-private-workiq' } : { kind: 'signin-required' as const },
    disconnect: async () => { disconnects++; linked = false; return 2; }, close: async () => {},
  };
  const auth = {
    authorizeUrl: (_attempt: BrowserAttempt, redirectUri: string) => 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?' + new URLSearchParams({ redirect_uri: redirectUri }),
    redeemCode: async (code: string) => { if (code !== 'synthetic-private-code') throw new Error('Rejected');
      return { accessToken: 'synthetic-private-workiq', expiresAt: Date.now() + 60000, refreshToken: 'synthetic-private-refresh' }; },
    refresh: async () => ({ accessToken: 'synthetic-private-workiq', expiresAt: Date.now() + 60000 }),
    verify: async (raw: string, oid: string) => { verifies++; if (raw !== 'synthetic-private-assertion' || oid !== ch.objectId) throw new Error('Rejected');
    return { assertionExpiresAt: Date.now() + 600000 }; },
    exchange: async () => { exchanges++; await gate; return { accessToken: 'synthetic-private-workiq', expiresAt: Date.now() + 60000 }; }, close: async () => {} };
  return { delegated: { accounts, auth, apiUri: 'api://gateway', connectionName: 'workiq' }, ch,
    exchanges: () => exchanges, verifies: () => verifies, disconnects: () => disconnects,
    gate: (value: Promise<void>) => { gate = value; } };
}

for (const kind of ['personal', 'groupChat'] as const) test(`${kind}: group_revise_preserves_sender_session_without_fake_mention and fresh normal grant`, async t => {
  const d = delegatedFixture(); await d.delegated.accounts.complete(); const f = await fixture(t, 2, d.delegated, kind);
  await f.provision('primary', f.event.contextId, kind);
  const route = structuredClone(f.route); if (route.requester) route.requester = { id: d.ch.objectId, displayName: 'First profile' };
  const p = { ...proposalFixture(), ...f.scope, conversationId: f.event.contextId, objectId: d.ch.objectId, senderMRI: '29:fixture-person', displayName: 'First profile',
    route,
    targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest!, state: 'revise-requested' as const,
    claim: { decision: 'revise' as const, tenantId: f.scope.tenantId, objectId: d.ch.objectId, invokeActivityId: 'winning-invoke', decidedAt: Date.now(), note: 'disconnect', revisionReplyTarget: 'fresh-reply' } };
  const grants: TaskGrant[] = []; d.delegated.accounts.reserveGrant = async input => { grants.push(input); return input; };
  const ctx = { ...context(), subject: { ...context().subject, chatKind: kind }, delegatedTenant: true,
    controlRecipient: { id: p.senderMRI, ...(kind === 'groupChat' ? { isTargeted: true as const } : {}) } };
  assert.equal(await f.sink.admitRevision(p, ctx), 'delivered'); assert.equal(f.turns.length, 1);
  assert.deepEqual(f.turns[0], { event: { protocolVersion: 'orka.gateway.v1', eventType: 'text', accountId: p.tenantId, contextId: p.conversationId,
    externalEventId: createExternalEventId({ tenantId: p.tenantId, conversationId: p.conversationId, activityId: 'winning-invoke' }),
    sender: { id: kind === 'personal' ? p.senderMRI : p.objectId, displayName: p.displayName },
    text: 'Change the proposed pull request for orka/fix: disconnect', replyTarget: 'fresh-reply' }, route: p.route });
  assert.equal(d.disconnects(), 0); assert.equal(grants.length, 1); assert.notEqual(grants[0]!.ref, p.grantRef);
  assert.equal(grants[0]!.eventId, f.turns[0]!.event.externalEventId); assert.equal(grants[0]!.binding, undefined);
  assert.deepEqual(grants[0]!.tools, ['workiq']); assert.equal(f.turns[0]!.event.metadata, undefined);
  f.policy({ kind: 'unavailable', category: 'graph-unavailable' }); assert.equal(await f.sink.admitRevision(p, ctx), 'full'); assert.equal(f.turns.length, 1);
  f.policy({ kind: 'no-access', text: '' }); assert.equal(await f.sink.admitRevision(p, ctx), 'conflict'); assert.equal(f.turns.length, 1);
});
test('expired revision operation stays retryable and a fresh authenticated attempt can admit the saved note', async t => {
  const d = delegatedFixture(); await d.delegated.accounts.complete(); const f = await fixture(t, 2, d.delegated); await f.provision();
  const p = { ...proposalFixture(), ...f.scope, conversationId: f.event.contextId, objectId: d.ch.objectId, senderMRI: '29:fixture-person', route: f.route,
    targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest!, state: 'revise-requested' as const,
    claim: { decision: 'revise' as const, tenantId: f.scope.tenantId, objectId: d.ch.objectId, invokeActivityId: 'saved-invoke', decidedAt: Date.now(), note: 'saved note', revisionReplyTarget: 'saved-reply' } };
  const ctx = { ...context(), delegatedTenant: true, controlRecipient: { id: p.senderMRI } };
  assert.equal(await f.sink.admitRevision(p, { ...ctx, deadline: performance.now() - 1 }), 'full');
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await f.sink.admitRevision(p, { ...ctx, signal: cancelled.signal }), 'full');
  assert.equal(f.turns.length, 0);
  assert.equal(await f.sink.admitRevision(p, ctx), 'delivered');
  assert.equal(f.turns.length, 1); assert.equal(f.turns[0]!.event.replyTarget, 'saved-reply');
});
test('signin_control_is_not_revision_delivered; authenticated sender follow-up rechecks sign-in without changing event identity', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, d.delegated); await f.provision();
  const p = { ...proposalFixture(), ...f.scope, conversationId: f.event.contextId, objectId: d.ch.objectId, senderMRI: '29:fixture-person', route: f.route,
    targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest!, state: 'revise-requested' as const,
    claim: { decision: 'revise' as const, tenantId: f.scope.tenantId, objectId: d.ch.objectId, invokeActivityId: 'first-invoke', decidedAt: Date.now(), note: 'add test', revisionReplyTarget: 'fresh-reply' } };
  const ctx = { ...context(), delegatedTenant: true, controlRecipient: { id: p.senderMRI } };
  assert.equal(await f.sink.admitRevision(p, ctx), 'signin-required'); assert.equal(f.turns.length, 0); assert.equal(f.sent.length, 1);
  assert.equal(await f.restart().admitRevision(p, ctx), 'signin-required'); assert.equal(f.sent.length, 1);
  const grants: TaskGrant[] = []; d.delegated.accounts.reserveGrant = async input => { grants.push(input); return input; };
  await d.delegated.accounts.complete(); d.delegated.accounts.inspect = async () => ({ generation: 2, linked: true });
  assert.equal(f.turns.length, 0); // Sign-in completion itself never replays the note.
  assert.equal(await f.restart().admitRevision(p, ctx), 'delivered'); assert.equal(grants[0]!.generation, 2);
  assert.equal(f.turns.length, 1); assert.equal(f.turns[0]!.event.replyTarget, 'fresh-reply');
  assert.equal(await f.sink.admitRevision(p, { ...ctx, subject: { ...ctx.subject, objectId: 'other' } }), 'conflict');
  assert.equal(await f.sink.admitRevision(p, { ...ctx, delegatedTenant: false }), 'conflict');
  assert.equal(await f.sink.admitRevision(p, { ...ctx, controlRecipient: { id: '29:other' } }), 'conflict'); assert.equal(f.turns.length, 1);
});

test('uncertain_card_send_never_resends_after_restart and refresh scopes identity, policy, expiry and supersession', async t => {
  const d = delegatedFixture(); await d.delegated.accounts.complete(); const f = await fixture(t, 2, d.delegated, 'groupChat'); await f.provision('primary', f.event.contextId, 'groupChat');
  const p = { ...proposalFixture(), ...f.scope, objectId: d.ch.objectId, conversationId: f.event.contextId, route: f.route,
    targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest!, createdAt: Date.now(), expiresAt: Date.now() + 3_600_000 };
  d.delegated.accounts.getProposal = async () => ({ proposal: p, etag: 'W/"1"' });
  f.fail(true, 'target-paused'); assert.equal(await f.sink.postProposal(p, context()), 'unavailable'); assert.equal(f.sent.length, 0);
  f.fail(false); await new Promise(resolve => setTimeout(resolve, 1010));
  f.outcome({ kind: 'unknown' }); assert.equal(await f.sink.postProposal(p, context()), 'uncertain'); assert.equal(f.sent.length, 1);
  const restarted = f.restart(); assert.equal(await restarted.postProposal(p, context()), 'uncertain'); assert.equal(f.sent.length, 1);
  const input = { type: 'invoke', name: 'adaptiveCard/action', id: 'refresh', channelId: 'msteams',
    conversation: { id: p.conversationId, tenantId: p.tenantId, conversationType: 'groupChat' }, from: { id: p.senderMRI, aadObjectId: p.objectId },
    value: { action: { type: 'Action.Execute', verb: 'pr-refresh', data: { proposal: p.id, rev: 1, digest: p.payloadDigest } } } };
  const tenantOnly = { ...input, conversation: { ...input.conversation, tenantId: undefined } };
  // Teams adds trigger and isRefresh to an automatic refresh's data; the card still renders for the sender.
  const teamsRefresh = { ...input, value: { trigger: 'automatic', action: { ...input.value.action, data: { ...input.value.action.data, trigger: 'automatic', isRefresh: true } } } };
  assert.equal((await restarted.cardAction!(teamsRefresh, context())).status, 200);
  assert.equal((await restarted.cardAction!(tenantOnly, context())).status, 200);
  const sender = await restarted.cardAction!(input, context()); assert.equal(sender.status, 200); assert.match(JSON.stringify(sender.body), /Approval isn't turned on for this chat yet/);
  const other = await restarted.cardAction!({ ...input, from: { id: '29:other', aadObjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } },
    { ...context(), subject: { ...context().subject, objectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', chatKind: 'groupChat' } });
  assert.equal(other.status, 200); assert.match(JSON.stringify(other.body), /Waiting for/); assert.ok(!JSON.stringify(other.body).includes('pr-approve'));
  assert.equal((await restarted.cardAction!({ ...input, conversation: { ...input.conversation, id: 'foreign' } }, context())).status, 403);
  assert.equal((await restarted.cardAction!({ ...input, value: { action: { ...input.value.action, verb: 'pr-approve' } } }, context())).status, 403);
  p.state = 'superseded'; assert.match(JSON.stringify((await restarted.cardAction!(input, context())).body), /Replaced/);
  p.state = 'expired'; assert.match(JSON.stringify((await restarted.cardAction!(input, context())).body), /Expired/);
  f.policy({ kind: 'no-access', text: '' }); assert.equal((await restarted.cardAction!(input, context())).status, 403);
});

// What an operator needs to tell which client sent a card action and what it got back.
async function cardLogFixture(t: test.TestContext) {
  const d = delegatedFixture(); await d.delegated.accounts.complete(); const decided: string[] = [];
  const f = await fixture(t, 2, d.delegated, 'personal', { refresh: () => {},
    decide: async (p, decision) => { decided.push(decision); if (decision === 'reject') throw new Error('PRIVATE_FAILURE'); return { ...p, state: 'approving' }; } });
  await f.provision();
  const p: Proposal = { ...proposalFixture(), ...f.scope, objectId: d.ch.objectId, conversationId: f.event.contextId, route: f.route,
    targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest!, title: 'PRIVATE_TITLE', body: 'PRIVATE_BODY' };
  d.delegated.accounts.getProposal = async (...ids: unknown[]) => ids[0] === p.id ? { proposal: p, etag: 'W/"1"' } : undefined;
  const data = { proposal: p.id, rev: 1, digest: p.payloadDigest };
  const input = { type: 'invoke', name: 'adaptiveCard/action', id: 'invoke-1', channelId: 'msteams', serviceUrl: 'https://SMBA.example.invalid/amer/PRIVATE_PATH/?PRIVATE_QUERY=1',
    entities: [{ type: 'mention', text: 'PRIVATE_MENTION' }, { type: 'clientInfo', platform: 'iOS', locale: 'PRIVATE_LOCALE', country: 'PRIVATE_COUNTRY', timezone: 'PRIVATE_ZONE' }],
    conversation: { id: p.conversationId, tenantId: p.tenantId, conversationType: 'personal' }, from: { id: p.senderMRI, aadObjectId: p.objectId, name: 'PRIVATE_NAME' },
    value: { action: { type: 'Action.Execute', verb: 'pr-refresh', data } } };
  const act = async (changed: Record<string, unknown> = {}, action: Record<string, unknown> = {}, ctx = context()) => {
    const before = f.logs.length;
    const result = await f.sink.cardAction!({ ...input, ...changed, value: { ...input.value, ...(changed.value as object), action: { ...input.value.action, ...action } } }, ctx);
    assert.equal(f.logs.length, before + 1, 'one line per invoke'); const line = /^card-action:(\S+) (\{.*\})$/u.exec(f.logs.at(-1)!); assert.ok(line);
    const { ms, ...rest } = JSON.parse(line[2]!) as Record<string, unknown>; assert.ok(Number.isInteger(ms) && (ms as number) >= 0 && (ms as number) < 4500);
    assert.equal(rest.status, result.status, 'the logged status is the one returned');
    return { ...(line[1] === 'undefined' ? {} : { target: line[1] }), ...rest };
  };
  return { d, f, p, data, input, act, decided };
}
test('a card action logs one line: verb, trigger, proposal, service host, client platform, status, outcome and extra field names', async t => {
  const { f, p, data, act, decided } = await cardLogFixture(t);
  const seen = { target: 'primary', proposal: p.id, service: 'smba.example.invalid', platform: 'iOS', status: 200 };
  assert.deepEqual(await act(), { ...seen, verb: 'pr-refresh', outcome: 'pending' });
  assert.deepEqual(await act({ entities: [{ type: 'clientInfo', platform: 'ANDROID' }] }), { ...seen, platform: 'Android', verb: 'pr-refresh', outcome: 'pending' });
  // What Teams adds to an automatic refresh, and to a tap on Approve.
  assert.deepEqual(await act({ value: { trigger: 'automatic' } }, { data: { ...data, trigger: 'automatic', isRefresh: true } }),
    { ...seen, verb: 'pr-refresh', trigger: 'automatic', outcome: 'pending', extra: 'data:trigger,isRefresh' });
  assert.deepEqual(await act({ value: { trigger: 'manual' } }, { verb: 'pr-approve', data: { ...data, imageUrl: 'PRIVATE_IMAGE', isButtonClickTrigger: true, trigger: 'manual' } }),
    { ...seen, verb: 'pr-approve', trigger: 'manual', outcome: 'approving', extra: 'data:imageUrl,isButtonClickTrigger,trigger' });
  assert.deepEqual(decided, ['approve']);
  p.state = 'opened'; assert.deepEqual(await act(), { ...seen, verb: 'pr-refresh', outcome: 'opened' });
  // Another desktop client, no client entity, no service URL: the line carries what is there.
  assert.deepEqual(await act({ entities: [{ type: 'clientInfo', platform: 'Web' }] }), { ...seen, platform: 'Web', verb: 'pr-refresh', outcome: 'opened' });
  const { service: _service, platform: _platform, ...bare } = seen;
  assert.deepEqual(await act({ entities: undefined, serviceUrl: undefined }), { ...bare, verb: 'pr-refresh', outcome: 'opened' });
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|chat|29:|aaaaaaaa/u);
  for (const value of [p.title, p.body, p.payloadDigest, p.objectId, p.senderMRI, p.conversationId, p.tenantId, p.displayName, p.githubLogin]) assert.ok(!JSON.stringify(f.logs).includes(value), value);
});
test('a refused card action logs the stage it stopped at with status 403', async t => {
  const { d, f, p, data, act, decided } = await cardLogFixture(t);
  const seen = { proposal: p.id, service: 'smba.example.invalid', platform: 'iOS', status: 403 }; const { proposal: _proposal, ...unread } = seen;
  assert.deepEqual(await act({ from: 'PRIVATE_FROM' }), { ...unread, verb: 'unknown', outcome: 'denied-activity' });
  assert.deepEqual(await act({}, { verb: 'PRIVATE_VERB' }), { ...seen, verb: 'unknown', outcome: 'denied-action' });
  assert.deepEqual(await act({}, { type: 'Action.Submit' }), { ...seen, verb: 'pr-refresh', outcome: 'denied-action' });
  assert.deepEqual(await act({ from: { id: '29:other', aadObjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }), { ...seen, verb: 'pr-refresh', outcome: 'denied-action' });
  assert.deepEqual(await act({}, { data: { ...data, proposal: 'PRIVATE_ID' } }), { ...unread, verb: 'pr-refresh', outcome: 'denied-proposal' });
  assert.deepEqual(await act({}, { data: { ...data, digest: 'PRIVATE_DIGEST' } }), { ...seen, verb: 'pr-refresh', outcome: 'denied-proposal' });
  assert.deepEqual(await act({ conversation: { id: 'PRIVATE_CHAT', tenantId: p.tenantId, conversationType: 'personal' } }), { ...seen, verb: 'pr-refresh', outcome: 'denied-proposal' });
  const other = { ...context(), subject: { ...context().subject, objectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
  assert.deepEqual(await act({ from: { id: '29:other', aadObjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }, { verb: 'pr-approve' }, other),
    { ...seen, target: 'primary', verb: 'pr-approve', outcome: 'denied-decision' });
  assert.deepEqual(await act({}, { verb: 'pr-reject' }), { ...seen, target: 'primary', verb: 'pr-reject', outcome: 'denied-decision' });
  assert.deepEqual(decided, ['reject'], 'only the sender reaches a decision');
  d.delegated.accounts.safeOutput = async () => false;
  assert.deepEqual(await act(), { ...seen, target: 'primary', verb: 'pr-refresh', outcome: 'denied-output' });
  d.delegated.accounts.safeOutput = async () => true; f.policy({ kind: 'no-access', text: '' });
  assert.deepEqual(await act(), { ...seen, target: 'primary', verb: 'pr-refresh', outcome: 'denied-connection' });
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|chat|29:|aaaaaaaa|bbbbbbbb/u);
});
test('card action field names, trigger, platform and service host are logged only in a fixed shape', async t => {
  const { f, p, data, act } = await cardLogFixture(t);
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'PRIVATE_VALUE']));
  const line = await act({ serviceUrl: 'PRIVATE_NOT_A_URL', entities: [{ type: 'clientInfo', platform: 'PRIVATEPLATFORM' }],
    value: { trigger: 'PRIVATE_TRIGGER', 'PRIVATE KEY': 1, ok_name: 'PRIVATE_VALUE' } },
  { data: { ...data, ...many }, ['x'.repeat(33)]: 1, title: 'PRIVATE_TITLE', id: 'PRIVATE_ACTION_ID' });
  assert.deepEqual(line, { target: 'primary', proposal: p.id, platform: 'other', status: 200, verb: 'pr-refresh', trigger: 'unknown', outcome: 'pending',
    extra: `value:?,ok_name;action:?;data:${Array.from({ length: 16 }, (_, i) => `k${i}`).join(',')}` });
  assert.deepEqual(await act({ serviceUrl: 'https://[::1]/', entities: 'PRIVATE_ENTITIES' }), { target: 'primary', proposal: p.id, service: '?', status: 200, verb: 'pr-refresh', outcome: 'pending' });
  assert.deepEqual(await act({ serviceUrl: 'https://x/' + 'p'.repeat(2048), entities: [{ type: 'clientInfo', platform: 7 }] }),
    { target: 'primary', proposal: p.id, platform: 'other', status: 200, verb: 'pr-refresh', outcome: 'pending' });
  // A platform that is not text, even one that cannot be turned into text, neither fails the action nor loses its line.
  for (const platform of [{ toString: null }, ['iOS'], null, true]) assert.deepEqual(await act({ entities: [{ type: 'clientInfo', platform }] }),
    { target: 'primary', proposal: p.id, service: 'smba.example.invalid', platform: 'other', status: 200, verb: 'pr-refresh', outcome: 'pending' });
  // A platform is named only from the fixed list, so it cannot carry a conversation id or other chosen text.
  assert.deepEqual(await act({ entities: [{ type: 'clientInfo', platform: 'Room123' }] }),
    { target: 'primary', proposal: p.id, service: 'smba.example.invalid', platform: 'other', status: 200, verb: 'pr-refresh', outcome: 'pending' });
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|Room123/u);
});
async function proposalTextFixture(t: test.TestContext, flags: readonly (boolean | undefined)[], changed: Partial<Proposal> = {}) {
  const d = delegatedFixture(); await d.delegated.accounts.complete();
  const f = await fixture(t, 2, d.delegated, 'personal', undefined, flags, text => !text.includes('BOT_SECRET_PRIVATE') && !text.includes('example/project-secret')); await f.provision();
  const p: Proposal = { ...proposalFixture(), ...f.scope, objectId: d.ch.objectId, conversationId: f.event.contextId, route: f.route,
    targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest!, createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, ...changed };
  d.delegated.accounts.getProposal = async () => ({ proposal: p, etag: 'W/"1"' });
  return { d, f, p };
}
test('a target with logProposalText logs the proposal text on one line before its card is posted', async t => {
  const written = { title: 'Retry "the" lease read', body: 'First line\nSecond line\twith a tab\r\n\u2028and\u2029more' };
  const { d, f, p } = await proposalTextFixture(t, [true], written);
  assert.equal(await f.sink.postProposal(p, context()), 'delivered'); assert.equal(f.sent.length, 1);
  assert.equal(f.texts.length, 1); assert.equal(f.texts[0]!.cardsBefore, 0, 'written before the card is sent');
  const prefix = 'pull-request-proposal-text (primary) '; assert.ok(f.texts[0]!.line.startsWith(prefix));
  assert.doesNotMatch(f.texts[0]!.line, /[\r\n\u2028\u2029]/u, 'the text stays on one line for every reader');
  assert.deepEqual(JSON.parse(f.texts[0]!.line.slice(prefix.length)), { proposal: p.id, repository: 'example/project', base: 'main', head: 'orka/fix', ...written });
  assert.ok(!JSON.stringify(f.logs).includes('lease read'), 'the routine log holds none of it');
  // The outcome card that follows a decision is not a proposal waiting to be read.
  const opened = { ...p, state: 'opened' as const, outcome: { kind: 'opened' as const, number: 12, url: 'https://github.com/example/project/pull/12', headSHA: 'a'.repeat(40) } };
  d.delegated.accounts.getProposal = async () => ({ proposal: opened, etag: 'W/"2"' });
  await f.sink.postDecision(opened, context()); assert.equal(f.sent.length, 2); assert.equal(f.texts.length, 1);
});
for (const flags of [[], [false], [undefined, true]] as const) test(`targets with logProposalText ${JSON.stringify(flags)} log no text for the first target's proposal`, async t => {
  const { f, p } = await proposalTextFixture(t, flags);
  assert.equal(await f.sink.postProposal(p, context()), 'delivered'); assert.equal(f.sent.length, 1); assert.deepEqual(f.texts, []);
  assert.ok(!JSON.stringify(f.logs).includes(p.title) && !JSON.stringify(f.logs).includes(p.body));
});
test('proposal text the card check refuses is not logged, including a credential only the gateway process holds', async t => {
  // The bot's own secret is checked where the card is built, after the task tool's check.
  const bot = await proposalTextFixture(t, [true], { body: 'see BOT_SECRET_PRIVATE' });
  assert.notEqual(await bot.f.sink.postProposal(bot.p, context()), 'delivered'); assert.deepEqual([bot.f.texts, bot.f.sent], [[], []]);
  const account = await proposalTextFixture(t, [true], { body: 'see ACCOUNT_PRIVATE' });
  account.d.delegated.accounts.safeOutput = async (_s, _g, text) => !text.includes('ACCOUNT_PRIVATE');
  assert.notEqual(await account.f.sink.postProposal(account.p, context()), 'delivered'); assert.deepEqual([account.f.texts, account.f.sent], [[], []]);
  // The line joins owner and repository; a credential that only that joined text matches keeps the line out.
  const joined = await proposalTextFixture(t, [true], { repo: 'project-secret', title: 'Plain title' });
  await joined.f.sink.postProposal(joined.p, context()); assert.deepEqual(joined.f.texts, []);
});
test('a card action on a gateway without sign-in still logs its refusal', async t => {
  const f = await fixture(t); const result = await f.sink.cardAction!({ type: 'invoke', name: 'adaptiveCard/action', serviceUrl: 'https://smba.example.invalid/',
    value: { action: { type: 'Action.Execute', verb: 'pr-approve', data: {} } } }, context());
  assert.equal(result.status, 403); assert.equal(f.logs.length, 1);
  const { ms: _ms, ...line } = JSON.parse(f.logs[0]!.slice('card-action:undefined '.length)) as Record<string, unknown>;
  assert.deepEqual(line, { verb: 'unknown', service: 'smba.example.invalid', status: 403, outcome: 'denied-unavailable' });
});

for (const crash of ['before', 'after'] as const) test(`normal Revise admission survives crash ${crash} durable inbox commit with one saved event`, async t => {
  const d = delegatedFixture(); await d.delegated.accounts.complete(); const f = await fixture(t, 2, d.delegated); await f.provision();
  const dir = mkdtempSync(join(tmpdir(), 'revision-inbox-')); const path = join(dir, 'inbox.sqlite');
  const scope = f.config.targets[0]!.config.scope; initializeIngressStore(path, scope); let inbox = openIngressStore(path, scope);
  t.after(() => { inbox.close(); rmSync(dir, { recursive: true, force: true }); });
  const p = { ...proposalFixture(), ...f.scope, conversationId: f.event.contextId, objectId: d.ch.objectId, senderMRI: '29:fixture-person', route: f.route,
    targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest!, state: 'revise-requested' as const,
    claim: { decision: 'revise' as const, tenantId: f.scope.tenantId, objectId: d.ch.objectId, invokeActivityId: 'winning-invoke', decidedAt: Date.now(), note: 'saved note', revisionReplyTarget: 'saved-reply' } };
  const ctx = { ...context(), delegatedTenant: true, controlRecipient: { id: p.senderMRI } }; let fail = true;
  f.slots[0]!.inbox.admit = async (event, route) => {
    if (fail && crash === 'before') throw new Error('simulated before commit');
    const result = inbox.admit(event, route); if (fail) throw new Error('simulated lost commit response'); return result;
  };
  await assert.rejects(f.sink.admitRevision(p, ctx)); inbox.close(); inbox = openIngressStore(path, scope); fail = false;
  const nextContext = { ...ctx, activityId: 'new-refresh-id' };
  assert.equal(await f.restart().admitRevision(p, nextContext), 'delivered');
  assert.equal(await f.restart().admitRevision(p, { ...nextContext }), 'delivered');
  const claim = inbox.claim()!; assert.equal(claim.event.text, 'Change the proposed pull request for orka/fix: saved note');
  assert.equal(claim.event.replyTarget, 'saved-reply'); assert.equal(claim.event.externalEventId,
    createExternalEventId({ tenantId: p.tenantId, conversationId: p.conversationId, activityId: 'winning-invoke' }));
  assert.deepEqual(inbox.getRoute('saved-reply'), p.route); assert.equal(inbox.claim(), undefined);
});

test('claimed revision retains fixed status after sign-in changes generation without restoring revoked private preview', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, d.delegated); await f.provision();
  const p: Proposal = { ...proposalFixture(), ...f.scope, objectId: d.ch.objectId, conversationId: f.event.contextId, route: f.route,
    targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest!, state: 'revise-requested', revisionAdmission: 'signin-required',
    claim: { decision: 'revise', tenantId: f.scope.tenantId, objectId: d.ch.objectId, invokeActivityId: 'first', decidedAt: Date.now(), note: 'PRIVATE_NOTE', revisionReplyTarget: 'saved-reply' } };
  d.delegated.accounts.getProposal = async () => ({ proposal: p, etag: 'W/"1"' });
  d.delegated.accounts.inspect = async () => ({ generation: 2, linked: true });
  d.delegated.accounts.safeOutput = async (_s, generation, text) => generation === 2 && !text.includes('PRIVATE_NOTE');
  const input = { type: 'invoke', name: 'adaptiveCard/action', conversation: f.route.conversation, from: { id: p.senderMRI, aadObjectId: p.objectId },
    value: { action: { type: 'Action.Execute', verb: 'pr-refresh', data: { proposal: p.id, rev: 1, digest: p.payloadDigest } } } };
  for (const status of ['pending', 'full', 'signin-required', 'conflict', 'delivered'] as const) {
    p.revisionAdmission = status;
    const result = await f.sink.cardAction!(input, { ...context(), delegatedTenant: true, controlRecipient: { id: p.senderMRI } });
    assert.equal(result.status, 200); const wire = JSON.stringify(result.body);
    assert.match(wire, status === 'delivered' ? /Changes requested\. Sent to the agent\./ : status === 'signin-required' ? /Changes not sent\. Sign in, then send them again\./ : status === 'conflict' ? /Changes not sent\. Reply in the chat/ : /Sending your changes…/);
    assert.match(wire, /Details are hidden because you signed in again\./);
    for (const privateValue of [p.title, p.body, p.head, p.displayName, p.githubLogin, 'PRIVATE_NOTE']) assert.ok(!wire.includes(privateValue));
    assert.ok(!wire.includes('pr-approve')); assert.ok(!wire.includes('pr-revise'));
  }
});

test('raw decoded revision note cannot hide a configured credential behind JSON quote escaping', async t => {
  const d = delegatedFixture(); await d.delegated.accounts.complete(); const f = await fixture(t, 2, d.delegated); await f.provision();
  const secret = 'QUOTED_"_PRIVATE';
  const p = { ...proposalFixture(), ...f.scope, objectId: d.ch.objectId, conversationId: f.event.contextId, route: f.route,
    targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest!, state: 'revise-requested' as const, revisionAdmission: 'delivered' as const,
    claim: { decision: 'revise' as const, tenantId: f.scope.tenantId, objectId: d.ch.objectId, invokeActivityId: 'first', decidedAt: Date.now(), note: secret, revisionReplyTarget: 'reply' } };
  d.delegated.accounts.getProposal = async () => ({ proposal: p, etag: 'W/"1"' });
  d.delegated.accounts.safeOutput = async (_s, _g, text) => !text.includes(secret);
  const input = { type: 'invoke', name: 'adaptiveCard/action', conversation: f.route.conversation, from: { id: p.senderMRI, aadObjectId: p.objectId },
    value: { action: { type: 'Action.Execute', verb: 'pr-refresh', data: { proposal: p.id, rev: 1, digest: p.payloadDigest } } } };
  assert.equal((await f.sink.cardAction!(input, context())).status, 403);
});

test('unknown_decision_reply_not_resent_after_restart and plaintext control stores only result references', async t => {
  const d = delegatedFixture(); await d.delegated.accounts.complete(); const f = await fixture(t, 2, d.delegated); await f.provision();
  const p = { ...proposalFixture(), ...f.scope, objectId: d.ch.objectId, conversationId: f.event.contextId, route: f.route,
    targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest!, state: 'opened' as const,
    outcome: { kind: 'opened' as const, number: 12, url: 'https://github.com/example/project/pull/12', headSHA: 'a'.repeat(40) } };
  d.delegated.accounts.getProposal = async () => ({ proposal: p, etag: 'W/"1"' });
  f.outcome({ kind: 'unknown' }); await f.sink.postDecision(p, context()); assert.equal(f.sent.length, 1);
  await f.restart().postDecision(p, context()); assert.equal(f.sent.length, 1);
  const receipt = await f.directory.getControl({ kind: 'control', conversationId: p.conversationId,
    activityId: `pr:${p.id}:1:${(await import('../src/accounts/pull-request-proposal.js')).proposalHash(p.outcome)}` }, context());
  assert.equal(receipt?.state, 'unknown'); assert.equal(receipt?.reply.kind, 'pr-decision');
  assert.ok(!JSON.stringify(receipt).includes(p.title)); assert.ok(!JSON.stringify(receipt).includes(p.outcome.url));
});
test('expired_account_decision_sends_only_fixed_signin_notice_without_old_private_facts', async t => {
  const d = delegatedFixture(); await d.delegated.accounts.complete(); const f = await fixture(t, 2, d.delegated); await f.provision();
  const p = { ...proposalFixture(), ...f.scope, objectId: d.ch.objectId, conversationId: f.event.contextId, route: f.route,
    targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest!, state: 'failed' as const, outcome: { kind: 'signin-required' as const } };
  d.delegated.accounts.getProposal = async () => ({ proposal: p, etag: 'W/"1"' });
  d.delegated.accounts.safeOutput = async () => false;
  await f.sink.postDecision(p, context()); assert.equal(f.sent.length, 1); assert.match(f.sent[0]!.text, /Sign in/);
  for (const privateValue of [p.title, p.body, p.githubLogin, p.head]) assert.ok(!f.sent[0]!.text.includes(privateValue));
});
test('delegated admission reserves sender generation before inbox and refuses immutable grant conflicts or missing authenticated sender', async t => {
  const d = delegatedFixture(); await d.delegated.accounts.complete(); const f = await fixture(t, 2, d.delegated); await f.provision();
  const reserved: TaskGrant[] = [];
  d.delegated.accounts.reserveGrant = async input => { assert.equal(f.admitted.length, 0); reserved.push(input); return input; };
  assert.equal((await f.run('work', 'proposal-origin-activity')).kind, 'accepted'); assert.equal(reserved.length, 1);
  assert.deepEqual(reserved[0], { ref: grantReference(f.scope, f.config.targets[0]!, f.event.externalEventId, f.event.replyTarget!), objectId: d.ch.objectId,
    generation: 1, provider: 'workiq', targetId: 'primary', targetDigest: f.config.targets[0]!.identityDigest, eventId: f.event.externalEventId, tools: ['workiq'],
    proposalOrigin: { conversationId: f.event.contextId, replyTarget: f.event.replyTarget!, route: f.route,
      senderMRI: '29:fixture-person', objectId: d.ch.objectId, displayName: 'Example Person', activityId: 'proposal-origin-activity' } });
  d.delegated.accounts.reserveGrant = async () => { throw new AccountError('conflict'); };
  assert.equal((await f.run('retry')).kind, 'conflict'); assert.equal(f.admitted.length, 1);
  assert.equal((await f.sink.admit(f.event, f.route, { ...context(), delegatedTenant: true, controlRecipient: { id: '29:p' },
    subject: { tenantId: f.scope.tenantId, chatKind: 'personal' } })).kind, 'conflict'); assert.equal(reserved.length, 1);
});

test('browser publishes success signal before held notification while callback work remains awaited', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, { ...d.delegated, publicOrigin: 'https://signin.example.invalid' });
  await f.provision(); await f.run('work', 'work'); let committed = false;
  const held = deferred<void>(); f.sendGate(held.promise);
  let done = false; const pending = f.sink.browser!.callback(new URLSearchParams({ state: 'synthetic-private-state', code: 'synthetic-private-code' }),
    { ...context(), committed: () => { committed = true; } }).then(value => { done = true; return value; });
  for (let n = 0; n < 1000 && f.sent.length < 2; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 2); assert.equal(committed, true); assert.equal(done, false);
  held.resolve(); assert.equal(await pending, true); assert.equal(f.admitted.length, 0);
});

for (const failure of ['mixed-case', 'partial-false', 'partial-throw', 'new-generation'] as const)
  test(`SSO completion reconciles ${failure} without weakening the account generation fence`, async t => {
    const d = delegatedFixture(); const f = await fixture(t, 2, d.delegated); await f.provision();
    const complete = d.delegated.accounts.complete;
    let claims = 0;
    if (failure !== 'mixed-case') d.delegated.accounts.claim = async () => ++claims === 1 ? 'claimed' : 'unavailable';
    if (failure !== 'mixed-case') d.delegated.accounts.complete = async () => {
      await complete(); if (failure === 'partial-throw') throw new AccountError('unavailable'); return false;
    };
    if (failure === 'new-generation') {
      d.delegated.accounts.inspect = async () => ({ generation: 2, linked: true });
      d.delegated.accounts.published = async () => false;
    }
    const invoke = { channelData: { tenant: { id: f.scope.tenantId } }, conversation: f.route.conversation,
      from: { id: '29:fixture-person', aadObjectId: failure === 'mixed-case' ? d.ch.objectId.toUpperCase() : d.ch.objectId },
      recipient: f.route.bot, serviceUrl: f.route.serviceUrl,
      value: { id: d.ch.id, connectionName: 'workiq', token: 'synthetic-private-assertion' } };
    assert.equal((await f.sink.exchange!(invoke, context())).status, failure === 'new-generation' ? 412 : 200);
    assert.equal(d.exchanges(), 1); assert.equal(f.admitted.length, 0);
    if (failure !== 'new-generation') {
      assert.equal((await f.sink.exchange!(invoke, context())).status, 200);
      assert.equal(d.exchanges(), 1);
      await f.run('new work'); assert.equal(f.admitted.length, 1);
    }
  });

test('configured fallback is direct in personal chat and retains sender SSO in group chat', async t => {
  for (const kind of ['personal', 'groupChat'] as const) {
    const d = delegatedFixture(); const f = await fixture(t, 2, { ...d.delegated, publicOrigin: 'https://signin.example.invalid' }, kind);
    await f.provision('primary', f.event.contextId, kind); await f.run('work', 'work');
    const attachment = JSON.parse(f.sent[0]!.text).attachments[0];
    assert.equal(attachment.contentType, 'application/vnd.microsoft.card.' + (kind === 'personal' ? 'signin' : 'oauth'));
    assert.equal(attachment.content.buttons[0].value, 'https://signin.example.invalid/signin?challenge=' + d.ch.id);
    assert.equal(!!attachment.content.tokenExchangeResource, kind === 'groupChat');
    assert.doesNotMatch(f.sent[0]!.text, /verifier|nonce|synthetic-private/);
  }
});

test('browser completion correlates the saved sign-in control and asks only for resend', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, { ...d.delegated, publicOrigin: 'https://signin.example.invalid' });
  await f.provision(); await f.run('work', 'work');
  const browser = f.sink.browser!;
  assert.notEqual(browser, undefined);
  const begun = await browser.begin(d.ch.id, context()); assert.ok(typeof begun === 'string');
  const url = new URL(begun);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://signin.example.invalid/oauth/callback');
  assert.equal(await browser.callback(new URLSearchParams({ state: 'synthetic-private-state', code: 'synthetic-private-code' }), context()), true);
  assert.equal(await browser.callback(new URLSearchParams({ state: 'synthetic-private-state', code: 'synthetic-private-code' }), context()), false);
  assert.equal(await browser.begin(d.ch.id, context()), undefined);
  assert.equal(f.admitted.length, 0); assert.equal(f.sent.length, 2);
  assert.match(f.sent[1]!.text, /[Ss]end your request again/);
  assert.doesNotMatch(JSON.stringify({ sent: f.sent, logs: f.logs }), /synthetic-private/);
  await f.run('new work'); assert.equal(f.admitted.length, 1);
});

test('user-rule removal after draining blocks a retained browser callback before linking or work', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, { ...d.delegated, publicOrigin: 'https://signin.example.invalid' });
  const makeAuthorizer = (listed: boolean) => createGroupAuthorizer(snapshotGroupPolicy({ schemaVersion: 1, policies: [
    { schemaVersion: 1, targetId: 'primary', frontAgent: 'front', rules: listed ? [{ userObjectId: d.ch.objectId, chatKinds: ['personal'] }] : [] },
  ] }, registryInput()));
  const original = makeAuthorizer(true); f.authorizeWith(original);
  await f.provision(); await f.run('work', 'work');
  assert.equal(typeof await f.sink.browser!.begin(d.ch.id, context()), 'string');
  await original.close();
  const removed = makeAuthorizer(false); t.after(() => removed.close()); f.authorizeWith(removed);
  const restarted = f.restart();
  assert.equal(await restarted.browser!.callback(new URLSearchParams({ state: 'synthetic-private-state', code: 'synthetic-private-code' }), context()), false);
  assert.equal((await d.delegated.accounts.inspect()).linked, false); assert.equal(f.admitted.length, 0);
  assert.equal(f.sent.length, 1); assert.doesNotMatch(JSON.stringify({ sent: f.sent, logs: f.logs }), /synthetic-private/);
});
test('browser wrong account, OAuth error, missing original control and changed policy never link or replay work', async t => {
  for (const reason of ['account', 'error', 'control', 'policy', 'connection'] as const) {
    const d = delegatedFixture(); const f = await fixture(t, 2, { ...d.delegated, publicOrigin: 'https://signin.example.invalid' });
    await f.provision(); await f.run('work', 'work');
    assert.notEqual(f.sink.browser, undefined);
    if (reason === 'control') f.directory.getControl = async () => undefined;
    if (reason === 'policy') f.policy({ kind: 'no-access', text: '' });
    if (reason === 'connection') f.directory.getConnection = async () => undefined;
    const form = new URLSearchParams({ state: 'synthetic-private-state', ...(reason === 'error' ? { error: 'consent_required' } :
      { code: reason === 'account' ? 'wrong-account' : 'synthetic-private-code' }) });
    assert.equal(await f.sink.browser!.callback(form, context()), false);
    assert.equal((await d.delegated.accounts.inspect()).linked, false); assert.equal(f.admitted.length, 0);
    assert.equal(await f.sink.browser!.callback(new URLSearchParams({ state: 'synthetic-private-state', code: 'synthetic-private-code' }), context()), false);
  }
});

test('an old refresh-capable account cannot masquerade as this challenge publication', async t => {
  for (const flow of ['browser', 'sso-retry'] as const) {
    const d = delegatedFixture(); const f = await fixture(t, 2, { ...d.delegated, publicOrigin: 'https://signin.example.invalid' });
    await f.provision(); await f.run('work', 'work');
    d.delegated.accounts.inspect = async () => ({ generation: 1, linked: true });
    d.delegated.accounts.complete = async () => false;
    if (flow === 'browser') {
      assert.equal(await f.sink.browser!.callback(new URLSearchParams({ state: 'synthetic-private-state', code: 'synthetic-private-code' }), context()), false);
    } else {
      d.delegated.accounts.claim = async () => 'unavailable';
      const invoke = { channelData: { tenant: { id: f.scope.tenantId } }, conversation: f.route.conversation,
        from: { id: '29:fixture-person', aadObjectId: d.ch.objectId }, recipient: f.route.bot, serviceUrl: f.route.serviceUrl,
        value: { id: d.ch.id, connectionName: 'workiq', token: 'synthetic-private-assertion' } };
      assert.equal((await f.sink.exchange!(invoke, context())).status, 412); assert.equal(d.exchanges(), 0);
    }
    assert.equal(f.sent.length, 1); assert.equal(f.admitted.length, 0);
  }
});

test('browser capacity reserves Bot admission and late shutdown cannot publish a link', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, { ...d.delegated, publicOrigin: 'https://signin.example.invalid' });
  await f.provision(); await f.run('work', 'work'); assert.notEqual(f.sink.browser, undefined);
  const held = deferred<void>(); let entered = false;
  d.delegated.accounts.prepareBrowser = async () => { entered = true; await held.promise; return undefined; };
  const pending = f.sink.browser!.begin(d.ch.id, context());
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.sink.browser!.begin(d.ch.id, context()), undefined);
  assert.equal((await f.run('help')).kind, 'accepted'); f.revoke(); held.resolve();
  assert.equal(await pending, undefined);
});

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

test('group sign-in rendering preserves the targeted Teams recipient through durable controls', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, d.delegated, 'groupChat');
  await f.provision('primary', f.event.contextId, 'groupChat');
  await f.run('work', 'group-signin'); assert.equal(f.admitted.length, 0);
  const card = JSON.parse(f.sent[0]!.text);
  assert.deepEqual(card.recipient, { id: '29:fixture-person', isTargeted: true });
  assert.equal(card.attachments[0].contentType, 'application/vnd.microsoft.card.oauth');
});

test('overlapping copies of one work activity cannot cross its later sign-in reservation', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, d.delegated); await f.provision();
  const held = deferred<void>(); let inspecting = false; let inspections = 0;
  d.delegated.accounts.inspect = async () => { if (++inspections === 1) { inspecting = true; await held.promise; return { generation: 1, linked: false }; }
    return { generation: 1, linked: true }; };
  d.delegated.accounts.acquire = async () => ({ kind: 'token', accessToken: 'synthetic-private-workiq' });
  const first = f.run('work', 'overlap'); while (!inspecting) await new Promise(r => setImmediate(r));
  try { assert.equal((await f.run('work', 'overlap')).kind, 'full'); assert.equal(f.admitted.length, 0); }
  finally { held.resolve(); await first; }
  assert.equal((await f.run('work', 'overlap')).kind, 'duplicate'); assert.equal(f.admitted.length, 0); assert.equal(f.sent.length, 1);
});

test('disconnect generation inspection uses the reserved account capacity', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, d.delegated); await f.provision();
  d.delegated.accounts.inspect = async (_s, _c, forDisconnect) => {
    if (!forDisconnect) throw new AccountError('busy'); return { generation: 1, linked: false };
  };
  assert.equal((await f.run('disconnect')).kind, 'accepted'); assert.equal(d.disconnects(), 1);
});

test('stale ready disconnect does not confirm that a newly linked account is disconnected', async t => {
  const d = delegatedFixture(); const f = await fixture(t, 2, d.delegated); await f.provision();
  f.outcome({ kind: 'retryable' }); await f.run('disconnect', 'old-disconnect'); const sends = f.sent.length;
  d.delegated.accounts.inspect = async () => ({ generation: 2, linked: true });
  f.outcome({ kind: 'delivered', providerMessageId: 'receipt' });
  assert.equal((await f.run('disconnect', 'old-disconnect')).kind, 'duplicate'); assert.equal(f.sent.length, sends);
});

// Orka pins a session to its first Task's Agent revision and names it by Binding UID (#75).
for (const kind of ['personal', 'groupChat'] as const) test(`${kind} chat keeps its Binding while the Agent is unchanged and moves to a new one after a change, across restart`, async t => {
  const f = await fixture(t, 2, undefined, kind); const first = await f.provision('primary', f.event.contextId, kind);
  const claim = (): IngressClaim => ({ externalEventId: f.event.externalEventId, attemptId: randomUUID(), attempt: 1, event: f.event });
  const reconciles = () => f.checks.filter(c => c.startsWith('reconcile:')).length;
  for (let i = 0; i < 2; i++) assert.equal(await f.sink.preflight('primary', claim(), context().signal), true);
  assert.deepEqual(await f.directory.getConnection(f.event.contextId, context()), first); assert.equal(reconciles(), 0); assert.deepEqual(f.logs, []);

  f.agent({ uid: 'agent-uid', generation: 2 }); const sink = f.restart();
  assert.equal(await sink.preflight('primary', claim(), context().signal), true);
  const renewed = (await f.directory.getConnection(f.event.contextId, context()))!;
  assert.equal(renewed.epoch, 1); assert.equal(renewed.bindingName, bindingName(f.scope, f.event.contextId, first.identityDigest, 1));
  assert.deepEqual(renewed.agent, { uid: 'agent-uid', generation: 2 }); assert.equal(renewed.state === 'provisioned' && renewed.binding.name, renewed.bindingName);
  assert.deepEqual([renewed.chatKind, renewed.targetId, renewed.identityDigest], [first.chatKind, first.targetId, first.identityDigest]);
  assert.equal(reconciles(), 1);
  assert.deepEqual(f.logs, [`session-renewed:primary {"binding":"${renewed.bindingName}","epoch":1,"fromAgentGeneration":1,"toAgentGeneration":2}`]);

  assert.equal(await f.restart().preflight('primary', claim(), context().signal), true);
  assert.deepEqual(await f.directory.getConnection(f.event.contextId, context()), renewed); assert.equal(reconciles(), 1);
});

test('a chat saved before Agent revisions were recorded moves once, then stays', async t => {
  const f = await fixture(t); await f.provision('primary', f.event.contextId, 'personal', true);
  const claim = (): IngressClaim => ({ externalEventId: f.event.externalEventId, attemptId: randomUUID(), attempt: 1, event: f.event });
  assert.equal(await f.sink.preflight('primary', claim(), context().signal), true);
  assert.equal(await f.sink.preflight('primary', claim(), context().signal), true);
  const saved = (await f.directory.getConnection(f.event.contextId, context()))!;
  assert.deepEqual([saved.epoch, saved.agent], [1, { uid: 'agent-uid', generation: 1 }]); assert.match(f.logs[0]!, /"fromAgentGeneration":"unknown"/u);
  assert.equal(f.logs.length, 1);
});

test('a failed move leaves the chat on its current Binding and retries on the next forward', async t => {
  const f = await fixture(t); const pinned = await f.provision();
  const claim = (): IngressClaim => ({ externalEventId: f.event.externalEventId, attemptId: randomUUID(), attempt: 1, event: f.event });
  f.agent({ uid: 'agent-uid', generation: 2 }); const reconcile = f.slots[0]!.provisioner.reconcile;
  f.slots[0]!.provisioner.reconcile = async () => { throw Object.assign(new BindingCheckError('target-paused'), { step: 'binding' as const }); };
  assert.equal(await f.sink.preflight('primary', claim(), context().signal), 'target-paused:binding');
  // Inside the one-second pause no read is made, so there is no step to name.
  assert.equal(await f.sink.preflight('primary', claim(), context().signal), 'target-paused');
  assert.deepEqual(await f.directory.getConnection(f.event.contextId, context()), pinned);
  f.slots[0]!.provisioner.reconcile = reconcile; await new Promise(resolve => setTimeout(resolve, 1010));
  assert.equal(await f.sink.preflight('primary', claim(), context().signal), true);
  assert.equal((await f.directory.getConnection(f.event.contextId, context()))!.epoch, 1);
});

test('connecting a chat records the Agent revision its first session will pin', async t => {
  const f = await fixture(t); f.agent({ uid: 'agent-uid', generation: 4 }); await f.run('use primary');
  assert.deepEqual((await f.directory.getConnection(f.event.contextId, context()))!.agent, { uid: 'agent-uid', generation: 4 });
});

test('a refused preflight names the storage that failed and a cancelled one says so', async t => {
  const f = await fixture(t); await f.provision();
  const claim: IngressClaim = { externalEventId: f.event.externalEventId, attemptId: randomUUID(), attempt: 1, event: f.event };
  const getConnection = f.directory.getConnection; f.directory.getConnection = async () => { throw new DirectoryError('unavailable'); };
  assert.equal(await f.sink.preflight('primary', claim, context().signal), 'directory-unavailable');
  f.directory.getConnection = getConnection;
  assert.equal(await f.sink.preflight('primary', claim, AbortSignal.abort()), 'cancelled');
  assert.equal(await f.sink.preflight('primary', claim, context().signal), true);
});
