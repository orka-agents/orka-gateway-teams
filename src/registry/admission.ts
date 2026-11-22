import { randomBytes } from 'node:crypto';
import type { createPullRequestService } from '../accounts/pull-request-service.js';
import { proposalOutput, proposalHash, proposalDecisionText } from '../accounts/pull-request-proposal.js';
import { createExternalEventId } from '../teams/ids.js';
import type { Proposal, RevisionAdmission } from '../accounts/pull-request-proposal.js';
import { object } from '../storage/table/codec.js';
import { buildPullRequestCard } from '../teams/pull-request-card.js';
import { MAX_OUTGOING_MESSAGE_BYTES } from '../teams/format.js';
import { identity } from '../delivery/identity.js';
import { AccountError } from '../accounts/store.js';
import { grantReference, githubTools } from '../accounts/grants.js';
import type { AccountStore, AccountChallenge, AccountTokens } from '../accounts/store.js';
import { uuid } from '../policy/config.js';
import type { createGitHub } from '../accounts/github.js';
import type { createDelegatedAuth } from '../auth/delegated.js';
import type { ExchangeContext, ExchangeResponse } from '../ingress/server.js';
import { bindingName, controlFingerprint, parseUseCommand } from '../directory/codec.js';
import type { Directory } from '../directory/store.js';
import { BindingCheckError } from '../directory/provision.js';
import type { createBindingProvisioner } from '../directory/provision.js';
import { DirectoryError, MAX_BINDING_EPOCH } from '../directory/types.js';
import type { ConnectionRecord, ControlRecord, ControlReply, DirectoryContext } from '../directory/types.js';
import type { AdmissionContext, AdmissionSink } from '../ingress/server.js';
import type { AdmissionResult, IngressClaim, IngressPort, ReplyRoute } from '../ingress/types.js';
import type { ProviderSender } from '../outbound/types.js';
import { NO_ACCESS_TEXT } from '../policy/admission.js';
import type { createGroupAuthorizer } from '../policy/admission.js';
import type { EventEnvelope } from '../protocol/types.js';
import { subscribeAuditAbort } from '../storage/table/audit.js';
import type { LeaseAuthority } from '../storage/table/types.js';
import { TableError } from '../storage/table/types.js';
import type { ProviderMessage } from '../outbound/types.js';
import type { RegistryConfig, RegistryTarget } from './config.js';

type Category = BindingCheckError['category'] | 'graph-unavailable' | 'signin-required' | 'signin-complete' | 'session-renewed' | 'card-action';
interface DelegatedOptions { accounts: AccountStore; auth: ReturnType<typeof createDelegatedAuth>; apiUri: string; connectionName: string; publicOrigin?: string }
interface Slot { target: RegistryTarget; inbox: Pick<IngressPort, 'admit'>; provisioner: ReturnType<typeof createBindingProvisioner> }
interface Options { proposals?: Pick<ReturnType<typeof createPullRequestService>, 'decide' | 'refresh'>; safeOutput?(text: string): boolean; github?: { accounts: AccountStore; auth: ReturnType<typeof createGitHub> }; delegated?: DelegatedOptions; config: RegistryConfig; directory: Directory; slots: readonly Slot[]; authority: LeaseAuthority; active(): boolean;
  authorizer: Pick<ReturnType<typeof createGroupAuthorizer>, 'authorize'>; log(category: Category, targetId?: string, detail?: Readonly<Record<string, string | number>>): void;
  /** Called only for a target with logProposalText: one line holding the text of the card about to be posted. */
  logProposalText?(line: string): void }

/** Four complete consumers share the directory's four places, including control settlement.
 * No waiting queue, cached Binding authority, replacement target or second sender. */
export function createRegistryAdmission(options: Options): AdmissionSink & {
  bindControlSender(sender: Pick<ProviderSender, 'send'>): void;
  postProposal(proposal: Proposal, ctx: DirectoryContext): Promise<'delivered' | 'uncertain' | 'unavailable'>;
  checkProposal(p: Proposal, ctx: DirectoryContext): Promise<boolean>;
  postDecision(p: Proposal, ctx: DirectoryContext): Promise<void>;
  admitRevision(p: Proposal, ctx: ExchangeContext): Promise<Exclude<RevisionAdmission, 'pending'>>;
  /** True, or a fixed reason code for the forward-retry line. */
  preflight(targetId: string, claim: Readonly<IngressClaim>, signal: AbortSignal): Promise<true | string>;
} {
  const { directory, authority, authorizer } = options;
  const scope = { appId: options.config.targets[0]!.config.scope.appId, tenantId: options.config.targets[0]!.config.scope.tenantId };
  const slots = new Map(options.slots.map(slot => [slot.target.id, slot]));
  const exchanges = new Map<string, Promise<boolean>>();
  let browserBusy = false;
  const activities = new Set<string>();
  const paused = new Map<string, { next: number; pending?: Promise<void> }>();
  const logged = new Map<string, Set<Category>>(); let consumers = 0;
  let sender: Pick<ProviderSender, 'send'> | undefined;
  const active = (ctx: DirectoryContext) => options.active() && authority.allowed() && !ctx.signal.aborted && performance.now() < ctx.deadline;
  const assertActive = (ctx: DirectoryContext) => { if (!active(ctx)) throw new BindingCheckError('target-paused'); };
  const log = (category: Category, id = '') => {
    const prior = logged.get(id) ?? new Set<Category>();
    if (!prior.has(category)) { prior.add(category); logged.set(id, prior); options.log(category, id || undefined); }
  };
  const transient = (error: unknown) => error instanceof AccountError && ['busy', 'conflict', 'unavailable', 'unready'].includes(error.code) || error instanceof BindingCheckError || error instanceof DirectoryError &&
    ['busy', 'conflict', 'unavailable'].includes(error.code) || error instanceof TableError && error.code === 'not-submitted';
  function joinRecovery(pending: Promise<void>, ctx: DirectoryContext): Promise<void> {
    // The recoverer retains/drains its own native work. A joiner owns only this
    // wait and must not borrow a longer admission budget while holding a grant.
    return new Promise((resolve, reject) => {
      let finished = false; let remove = () => {};
      const finish = (error?: unknown) => {
        if (finished) return; finished = true; clearTimeout(timer); remove();
        if (error === undefined) resolve(); else reject(error);
      };
      const cancelled = () => finish(new BindingCheckError('target-paused'));
      const timer = setTimeout(cancelled, Math.max(1, Math.ceil(ctx.deadline - performance.now())));
      remove = subscribeAuditAbort(ctx.signal, cancelled);
      void pending.then(() => finish(), error => finish(error));
      if (!active(ctx)) cancelled();
    });
  }
  /** Orka pins a session to the Agent revision of its first Task. When the front Agent has changed since,
   * move the chat to a new, higher-priority Binding: Orka names sessions by Binding UID, so the next
   * Task starts a new session. The old Binding, session and history stay untouched. */
  async function follow(slot: Slot, connection: ConnectionRecord, ctx: DirectoryContext): Promise<ConnectionRecord> {
    const k8s = { signal: ctx.signal, deadline: ctx.deadline, allowed: () => active(ctx) };
    const agent = await slot.provisioner.revision(k8s); assertActive(ctx);
    // A chat recorded before revisions were tracked has an unknown pin: one fresh session beats a known failure.
    if (connection.state !== 'provisioned' || connection.agent?.uid === agent.uid && connection.agent.generation === agent.generation) return connection;
    const epoch = (connection.epoch ?? 0) + 1;
    if (epoch > MAX_BINDING_EPOCH) throw new BindingCheckError('binding-conflict');
    const { binding: _binding, agent: previous, ...base } = connection;
    const reserved: ConnectionRecord = { ...base, epoch, state: 'reserved',
      bindingName: bindingName(scope, connection.conversationId, connection.identityDigest, epoch) };
    const binding = await slot.provisioner.reconcile(reserved, k8s); assertActive(ctx);
    const saved = await directory.updateConnection(connection, { ...reserved, state: 'provisioned', binding, agent }, ctx);
    options.log('session-renewed', slot.target.id, { binding: saved.bindingName, epoch,
      fromAgentGeneration: previous?.generation ?? 'unknown', toAgentGeneration: agent.generation });
    return saved;
  }
  async function check(slot: Slot, connection: ConnectionRecord, ctx: DirectoryContext, reconcile = false, renew = false): Promise<ConnectionRecord> {
    assertActive(ctx); const id = slot.target.id; const state = paused.get(id);
    if (state?.pending) { await joinRecovery(state.pending, ctx); assertActive(ctx); }
    else if (state && performance.now() < state.next) throw new BindingCheckError('target-paused');
    const run = async () => {
      try {
        assertActive(ctx);
        const k8s = { signal: ctx.signal, deadline: ctx.deadline, allowed: () => active(ctx) };
        // A new chat's first session will pin the Agent revision current now.
        const agent = reconcile && connection.state === 'reserved' ? await slot.provisioner.revision(k8s) : undefined;
        const evidence = await slot.provisioner[reconcile ? 'reconcile' : 'check'](connection, k8s);
        assertActive(ctx);
        const saved = reconcile ? await directory.markProvisioned(connection, evidence, ctx, agent) : renew ? await follow(slot, connection, ctx) : connection;
        assertActive(ctx); paused.delete(id); logged.delete(id); return saved;
      } catch (error) {
        if (error instanceof BindingCheckError && active(ctx)) {
          // A bad Binding belongs to this connection; a timed-out/disconnected
          // caller says nothing about the health of the target or its other chats.
          if (error.category !== 'binding-conflict') paused.set(id, { next: performance.now() + 1000 });
          log(error.category, id);
        }
        throw error;
      }
    };
    if (!state || state.pending) return run();
    // Only the recovering caller owns this check. Joiners recheck their own
    // exact connection afterward; another conversation's evidence is not authority.
    const operation = run(); state.pending = operation.then(() => {}); void state.pending.catch(() => {});
    try { return await operation; }
    finally { if (paused.get(id) === state) delete state.pending; }
  }
  function validConnection(value: ConnectionRecord, slot: Slot, event: Readonly<EventEnvelope>, kind: string): boolean {
    return value.scope.appId === scope.appId && value.scope.tenantId === scope.tenantId && value.chatKind === kind &&
      value.conversationId === event.contextId && value.targetId === slot.target.id && value.identityDigest === slot.target.identityDigest;
  }
  const keyOf = (record: ControlRecord) => ({ kind: 'control' as const, conversationId: record.conversationId, activityId: record.activityId });
  function permitted(reply: ControlReply, eligible: readonly { id: string }[], denied: boolean): boolean {
    if (reply.kind === 'no-access') return true;
    if (denied) return false;
    return reply.kind === 'discovery' ? reply.targets.every(t => eligible.some(e => e.id === t.id)) : eligible.some(e => e.id === reply.targetId);
  }
  async function control(candidate: ControlRecord, eligible: readonly { id: string }[], denied: boolean, ctx: DirectoryContext,
    connection?: ConnectionRecord, beforeArm?: () => void): Promise<AdmissionResult> {
    assertActive(ctx);
    const saved = candidate.state === 'ready' ? await directory.reserveControl(candidate, ctx) : candidate; assertActive(ctx);
    if (!permitted(saved.reply, eligible, denied)) return { kind: 'conflict' };
    if (saved.state !== 'ready') return { kind: 'duplicate', replyTarget: '' };
    if (saved.reply.kind === 'connected' && (connection?.state !== 'provisioned' || connection.targetId !== saved.reply.targetId ||
        connection.identityDigest !== slots.get(saved.reply.targetId)?.target.identityDigest)) return { kind: 'conflict' };
    const route = saved.route; const receiver = options.config.targets[0]!.config.receiver;
    if (!receiver.serviceUrls.includes(route.serviceUrl) || !receiver.recipientIds.includes(route.bot.id) ||
        route.conversation.tenantId !== scope.tenantId || route.conversation.id !== saved.conversationId) throw new DirectoryError('corrupt');
    if (!sender) throw new DirectoryError('unready');
    const message = saved.reply.kind === 'pr-approval' || saved.reply.kind === 'pr-decision' ? await proposalMessage(saved, ctx) : formatControl(saved.reply, options.delegated, route.conversation.conversationType);
    beforeArm?.();
    const armed = await directory.armControl(keyOf(saved), ctx); assertActive(ctx);
    const sendAuthority = saved.reply.kind === 'pr-approval' || saved.reply.kind === 'pr-decision' ? { ...authority, allowed: () => authority.allowed() && active(ctx) && ctx.authorizeWrite?.() !== false } : authority;
    const outcome = await sender.send(route, message, { signal: ctx.signal, deadline: ctx.deadline, authority: sendAuthority });
    assertActive(ctx);
    await directory.settleControl(keyOf(saved), armed.attemptUUID, outcome.kind === 'delivered' ? outcome : { kind: outcome.kind === 'retryable' ? 'no-effect' : 'unknown' }, ctx);
    return outcome.kind === 'retryable' ? { kind: 'full' } : { kind: 'accepted', replyTarget: '' };
  }
  async function safeProposal(p: Proposal, text: string, ctx: DirectoryContext, generation = p.generation, githubGeneration = p.githubGeneration) {
    if (!options.delegated || options.safeOutput?.(text) === false) return false;
    return await options.delegated.accounts.safeOutput({ objectId: p.objectId }, generation, text, ctx) &&
      (!options.github || options.github.auth.safeOutput(text) && await options.github.accounts.safeOutput({ objectId: p.objectId }, githubGeneration, text, ctx));
  }
  async function proposalMessage(saved: ControlRecord, ctx: DirectoryContext): Promise<ProviderMessage> {
    if (!['pr-approval', 'pr-decision'].includes(saved.reply.kind) || !options.delegated) throw new DirectoryError('unready');
    const reply = saved.reply as Extract<ControlReply, { kind: 'pr-approval' | 'pr-decision' }>;
    const p = (await options.delegated.accounts.getProposal(reply.proposal, ctx))?.proposal;
    if (!p || reply.kind === 'pr-approval' && p.state !== 'pending' || reply.kind === 'pr-decision' && reply.outcome !== proposalHash(p.outcome ?? p.state) || p.payloadDigest !== reply.digest || p.revision !== reply.rev || p.conversationId !== saved.conversationId || p.targetId !== reply.targetId) throw new DirectoryError('unready');
    const signin = p.outcome?.kind === 'signin-required';
    // Revocation fences private previews. This fixed notice copies no old account/proposal strings.
    const card = signin ? { type: 'AdaptiveCard' as const, version: '1.5' as const, body: [{ type: 'TextBlock' as const, wrap: true, text: proposalDecisionText(p) }] } : buildPullRequestCard(p, 'room', !!options.proposals);
    const message: ProviderMessage = { type: 'message', replyToId: p.activityId, attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] };
    const wire = JSON.stringify(message);
    const safe = signin ? options.safeOutput?.(wire) !== false && (!options.github || options.github.auth.safeOutput(wire)) :
      await safeProposal(p, proposalOutput(p), ctx) && await safeProposal(p, wire, ctx);
    if (Buffer.byteLength(wire) > MAX_OUTGOING_MESSAGE_BYTES || !safe) throw new DirectoryError('unready');
    // Read by an operator before the sender decides. The line passes the same credential checks as the card it precedes.
    if (reply.kind === 'pr-approval' && options.logProposalText && options.config.targets.find(t => t.id === p.targetId)?.logProposalText) {
      const line = `pull-request-proposal-text (${p.targetId}) ${JSON.stringify({ proposal: p.id, repository: `${p.owner}/${p.repo}`, base: p.base, head: p.head, title: p.title, body: p.body })
        .replace(/[\u2028\u2029]/gu, c => c === '\u2028' ? '\\u2028' : '\\u2029')}`;
      if (await safeProposal(p, line, ctx)) options.logProposalText(line);
    }
    return message;
  }
  async function proposalConnection(p: Proposal, subject: ExchangeContext['subject'], ctx: DirectoryContext) {
    if (p.appId !== scope.appId || p.tenantId !== scope.tenantId || subject.tenantId !== scope.tenantId) return undefined;
    const connection = await directory.getConnection(p.conversationId, ctx); const slot = slots.get(p.targetId); assertActive(ctx);
    if (!connection || !slot || connection.state !== 'provisioned' || connection.targetId !== p.targetId || connection.identityDigest !== p.targetDigest || slot.target.identityDigest !== p.targetDigest) return undefined;
    const policy = await authorizer.authorize({ ...subject, chatKind: connection.chatKind }, ctx, p.targetId); assertActive(ctx);
    if (policy.kind !== 'eligible' || !policy.targets.some(t => t.id === p.targetId)) return undefined;
    await check(slot, connection, ctx); return { connection, targets: policy.targets };
  }
  async function postProposal(p: Proposal, supplied: DirectoryContext, decision = false): Promise<'delivered' | 'uncertain' | 'unavailable'> {
    if (consumers >= 4 || !options.delegated || p.route.conversation.conversationType === 'channel') return 'unavailable'; consumers++;
    const ctx = { ...supplied, authorizeWrite: () => active(supplied) && supplied.authorizeWrite?.() !== false };
    let armAttempted = false;
    const outcome = proposalHash(p.outcome ?? p.state);
    const activityId = `pr:${p.id}:${p.revision}${decision ? ':' + outcome : ''}`; const key = { kind: 'control' as const, conversationId: p.conversationId, activityId };
    try {
      assertActive(ctx); const bound = await proposalConnection(p, { tenantId: p.tenantId, objectId: p.objectId, chatKind: p.route.conversation.conversationType === 'groupChat' ? 'groupChat' : 'personal' }, ctx);
      if (!bound) return 'unavailable';
      await control({ schema: 1, kind: 'control', scope, conversationId: p.conversationId, activityId, chatKind: bound.connection.chatKind,
        fingerprint: controlFingerprint(scope, p.conversationId, activityId, p.objectId, `${p.id}:${p.revision}:${p.payloadDigest}`, p.targetDigest),
        currentTargetDigest: p.targetDigest, desiredTargetDigest: p.targetDigest,
        route: { serviceUrl: p.route.serviceUrl, channelId: 'msteams', bot: p.route.bot, conversation: { ...p.route.conversation, conversationType: bound.connection.chatKind } },
        reply: decision ? { kind: 'pr-decision', targetId: p.targetId, proposal: p.id, rev: p.revision, digest: p.payloadDigest, outcome } :
          { kind: 'pr-approval', targetId: p.targetId, proposal: p.id, rev: p.revision, digest: p.payloadDigest }, state: 'ready' }, bound.targets, false, ctx, bound.connection, () => { armAttempted = true; });
      const receipt = await directory.getControl(key, ctx); assertActive(ctx);
      if (receipt?.state !== 'delivered') return receipt && receipt.state !== 'ready' && receipt.state !== 'rejected' ? 'uncertain' : 'unavailable';
      try { const version = await options.delegated.accounts.getProposal(p.id, ctx);
        if (!decision && version && !version.proposal.cardActivityId) await options.delegated.accounts.replaceProposal(version, { ...version.proposal, cardActivityId: receipt.providerMessageId }, ctx);
      } catch { /* The directory receipt remains authoritative. */ }
      return 'delivered';
    } catch {
      if (!armAttempted) try {
        const receipt = await directory.getControl(key, ctx);
        if (!receipt || receipt.state === 'ready' || receipt.state === 'rejected') return 'unavailable';
      } catch { /* An unreadable prior attempt is not proof of no effect. */ }
      return 'uncertain';
    }
    finally { consumers--; }
  }
  // One line per card invoke: fixed words, the proposal id and field names only, never what the person or the agent wrote.
  async function cardAction(input: unknown, supplied: ExchangeContext): Promise<{ status: number; body: unknown }> {
    const started = performance.now(); const seen: CardActionSeen = { stage: options.delegated ? 'busy' : 'unavailable', extra: [] };
    const result = await handleCardAction(input, supplied, seen);
    // The action has already been decided; a failure to describe it must not change what the client is told.
    try { options.log('card-action', seen.targetId, { verb: seen.verb ?? 'unknown', ...(seen.trigger ? { trigger: seen.trigger } : {}),
      ...(seen.proposal ? { proposal: seen.proposal } : {}), ...cardActionClient(input), status: result.status,
      outcome: result.status === 200 && seen.state ? seen.state : `denied-${seen.stage}`, ms: Math.round(performance.now() - started),
      ...(seen.extra.length ? { extra: seen.extra.join(';') } : {}) }); } catch { /* Logged nothing. */ }
    return result;
  }
  async function handleCardAction(input: unknown, supplied: ExchangeContext, seen: CardActionSeen): Promise<{ status: number; body: unknown }> {
    const denied = { status: 403, body: {} }; if (consumers >= 4 || !options.delegated) return denied; consumers++;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 4000); timer.unref();
    const ctx = { ...supplied, deadline: Math.min(supplied.deadline, performance.now() + 4000), signal: AbortSignal.any([supplied.signal, controller.signal]), authorizeWrite: () => active(ctx) };
    try {
      seen.stage = 'activity'; assertActive(ctx); if (!record(input) || input.type !== 'invoke' || input.name !== 'adaptiveCard/action' || !record(input.conversation) || !record(input.from)) return denied;
      // Teams adds fields of its own (for example trigger and isRefresh in data); read only the known ones and log the names of the rest.
      seen.stage = 'action';
      const pick = (v: unknown, keys: readonly string[], where: string) => {
        const all = object(v); const extra = Object.keys(all).filter(k => !keys.includes(k));
        if (extra.length) seen.extra.push(`${where}:${extra.slice(0, 16).map(k => /^[A-Za-z0-9_]{1,32}$/u.test(k) ? k : '?').join(',')}`);
        return Object.fromEntries(keys.filter(k => Object.hasOwn(all, k)).map(k => [k, all[k]]));
      };
      const value = pick(input.value, ['action', 'trigger'], 'value'); const action = pick(value.action, ['type', 'verb', 'data', 'id', 'title'], 'action');
      if (cardVerbs.includes(String(action.verb))) seen.verb = String(action.verb);
      if (value.trigger !== undefined) seen.trigger = value.trigger === 'automatic' || value.trigger === 'manual' ? value.trigger : 'unknown';
      const revise = action.verb === 'pr-revise'; const data = pick(action.data, ['proposal', 'rev', 'digest', ...(revise ? ['note'] : [])], 'data');
      if (typeof data.proposal === 'string' && /^[a-f0-9]{64}$/u.test(data.proposal)) seen.proposal = data.proposal;
      if (action.type !== 'Action.Execute' || !cardVerbs.includes(String(action.verb)) || data.rev !== 1 || typeof data.proposal !== 'string' || typeof data.digest !== 'string' ||
        !supplied.subject.objectId || input.from.aadObjectId !== supplied.subject.objectId) return denied;
      seen.stage = 'proposal'; let p = (await options.delegated.accounts.getProposal(data.proposal, ctx))?.proposal;
      if (!p || p.conversationId !== input.conversation.id || input.conversation.tenantId !== undefined && p.tenantId !== input.conversation.tenantId || p.payloadDigest !== data.digest || p.revision !== data.rev) return denied;
      seen.targetId = p.targetId; seen.stage = 'connection'; if (!await proposalConnection(p, supplied.subject, ctx)) return denied;
      if (action.verb !== 'pr-refresh') {
        seen.stage = 'decision';
        if (!options.proposals || supplied.subject.objectId !== p.objectId) return denied;
        if (revise && (!supplied.delegatedTenant || supplied.controlRecipient?.id !== p.senderMRI || typeof data.note !== 'string' ||
          input.serviceUrl !== p.route.serviceUrl || !record(input.recipient) || input.recipient.id !== p.route.bot.id ||
          input.conversation.conversationType !== p.route.conversation.conversationType)) return denied;
        p = await options.proposals.decide(p, revise ? 'revise' : action.verb === 'pr-approve' ? 'approve' : 'reject', identity(input.id), ctx, revise ? data.note as string : undefined);
      }
      if (action.verb === 'pr-refresh' && supplied.subject.objectId === p.objectId) options.proposals?.refresh(p, ctx);
      seen.stage = 'output'; let card = buildPullRequestCard(p, supplied.subject.objectId === p.objectId ? 'sender' : 'room', !!options.proposals);
      if (!await safeProposal(p, proposalOutput(p), ctx) || !await safeProposal(p, JSON.stringify(card), ctx)) {
        if (p.state !== 'revise-requested' || supplied.subject.objectId !== p.objectId || !supplied.controlRecipient) return denied;
        const subject = { objectId: p.objectId }; const current = await options.delegated.accounts.inspect(subject, ctx);
        const github = await options.github?.accounts.inspect(subject, ctx);
        if (current.generation === p.generation && (!github || github.generation === p.githubGeneration)) return denied;
        // A fresh sign-in can resume the saved turn, but cannot restore revoked private preview facts.
        const text = p.revisionAdmission === 'delivered' ? 'Your revision was sent.' : p.revisionAdmission === 'signin-required' ?
          'Sign in, then send your revision again.' : p.revisionAdmission === 'conflict' ? 'Your revision was not sent. Reply with what to change.' : 'Sending your revision…';
        card = { type: 'AdaptiveCard', version: '1.5', body: [{ type: 'TextBlock', wrap: true, text }],
          ...(card.refresh ? { refresh: { ...card.refresh, userIds: [supplied.controlRecipient.id] } } : {}) };
        if (!await safeProposal(p, JSON.stringify(card), ctx, current.generation, github?.generation ?? p.githubGeneration)) return denied;
      }
      assertActive(ctx); seen.state = p.state; return { status: 200, body: { cardInvokeResponse: { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card } } };
    } catch { return denied; }
    finally { clearTimeout(timer); consumers--; }
  }
  async function admitRevision(p: Proposal, ctx: ExchangeContext): Promise<Exclude<RevisionAdmission, 'pending'>> {
    const claim = p.claim; const kind = p.route.conversation.conversationType;
    if (!active(ctx)) return 'full';
    if (p.state !== 'revise-requested' || claim?.decision !== 'revise' || kind === 'channel' ||
      ctx.subject.tenantId !== p.tenantId || ctx.subject.objectId !== p.objectId || ctx.subject.chatKind !== kind ||
      p.appId !== scope.appId || p.tenantId !== scope.tenantId || !ctx.delegatedTenant || ctx.controlRecipient?.id !== p.senderMRI) return 'conflict';
    const connection = await directory.getConnection(p.conversationId, ctx); const slot = slots.get(p.targetId);
    if (!connection || !slot || connection.state !== 'provisioned' || connection.targetId !== p.targetId ||
      connection.identityDigest !== p.targetDigest || slot.target.identityDigest !== p.targetDigest) return 'conflict';
    // The winning encrypted bytes, not refresh/redelivery input, identify the new normal turn.
    const event: EventEnvelope = { protocolVersion: 'orka.gateway.v1', eventType: 'text', accountId: p.tenantId, contextId: p.conversationId,
      externalEventId: createExternalEventId({ tenantId: p.tenantId, conversationId: p.conversationId, activityId: claim.invokeActivityId }),
      sender: { id: kind === 'personal' ? p.senderMRI : p.objectId, ...(p.displayName ? { displayName: p.displayName } : {}) },
      text: `Change the proposed pull request for ${p.head}: ${claim.note!}`, replyTarget: claim.revisionReplyTarget! };
    const result = await admit(event, p.route, { signal: ctx.signal, deadline: ctx.deadline, subject: ctx.subject,
      activityId: claim.invokeActivityId, delegatedTenant: ctx.delegatedTenant, controlRecipient: ctx.controlRecipient }, true);
    if (result.kind === 'full' || result.kind === 'conflict') return result.kind;
    if ('replyTarget' in result && result.replyTarget === claim.revisionReplyTarget) return 'delivered';
    // Control sends also report accepted/duplicate, but never attest inbox admission.
    const control = await directory.getControl({ kind: 'control', conversationId: p.conversationId, activityId: claim.invokeActivityId }, ctx);
    return control?.reply.kind === 'signin' ? 'signin-required' : 'conflict';
  }
  async function admit(event: Readonly<EventEnvelope>, route: Readonly<ReplyRoute>, supplied?: AdmissionContext, resumeSignin = false): Promise<AdmissionResult> {
    if (route.conversation.conversationType === 'channel') return { kind: 'conflict' };
    if (!supplied || consumers >= 4) return { kind: 'full' };
    const context = { ...supplied }; const ctx: DirectoryContext = { signal: context.signal, deadline: context.deadline, authorizeWrite: () => active(ctx) };
    // Do not queue old work across a later sign-in reservation; retry the overlap.
    const activityKey = options.delegated ? JSON.stringify([event.contextId, context.activityId]) : undefined;
    if (!active(ctx) || activityKey !== undefined && activities.has(activityKey)) return { kind: 'full' };
    consumers++; if (activityKey !== undefined) activities.add(activityKey);
    try {
      const command = context.commandText === undefined ? undefined : parseUseCommand(context.commandText);
      const desired = command === undefined ? undefined : slots.get(command);
      const policy = await authorizer.authorize(context.subject, ctx, command); assertActive(ctx);
      if (policy.kind === 'unavailable') { log('graph-unavailable'); return { kind: 'full' }; }
      logged.delete('');
      const eligible = policy.kind === 'eligible' ? policy.targets : [];
      const denied = policy.kind === 'no-access' || command !== undefined && !eligible.some(t => t.id === command);
      const desiredTargetDigest = desired?.target.identityDigest ?? null;
      const fingerprint = controlFingerprint(scope, event.contextId, context.activityId, event.sender.id, event.text, desiredTargetDigest);
      const chatKind = route.conversation.conversationType;
      const candidate = (reply: ControlReply, currentTargetDigest: string | null): ControlRecord => ({ schema: 1, kind: 'control', scope,
        conversationId: event.contextId, chatKind, activityId: context.activityId, fingerprint, currentTargetDigest, desiredTargetDigest,
        route: { serviceUrl: route.serviceUrl, channelId: 'msteams', bot: { ...route.bot },
          conversation: { id: route.conversation.id, tenantId: route.conversation.tenantId, conversationType: chatKind } }, reply, state: 'ready' });
      const previous = await directory.getControl({ kind: 'control', conversationId: event.contextId, activityId: context.activityId }, ctx); assertActive(ctx);
      if (previous && (previous.fingerprint !== fingerprint || previous.desiredTargetDigest !== desiredTargetDigest)) return { kind: 'conflict' };
      // A revoked duplicate cannot expose the old reply or recover its send right.
      if (previous && !permitted(previous.reply, eligible, denied)) return { kind: 'conflict' };
      let connection = await directory.getConnection(event.contextId, ctx); assertActive(ctx);
      let reply: ControlReply;
      if (denied) reply = { kind: 'no-access' };
      else if (previous && (previous.state !== 'ready' || previous.reply.kind !== 'connected') && !(resumeSignin && previous.reply.kind === 'signin')) {
        if (previous.state === 'ready' && (previous.reply.kind === 'disconnected' || previous.reply.kind === 'github-disconnected') && options.delegated && context.subject.objectId) {
          const subject = { objectId: context.subject.objectId };
          const accounts = previous.reply.kind === 'github-disconnected' ? options.github?.accounts : options.delegated.accounts;
          if (!accounts) return { kind: 'conflict' };
          await accounts.disconnect(subject, ctx, previous.reply.generation); assertActive(ctx);
          if ((await accounts.inspect(subject, ctx, true)).linked) return { kind: 'duplicate', replyTarget: '' };
        }
        return await control(previous, eligible, false, ctx, connection);
      }
      else if (options.delegated && (context.commandText?.trim() === 'disconnect' || options.github && context.commandText?.trim() === 'disconnect github')) {
        if (!context.delegatedTenant || !context.subject.objectId || !context.controlRecipient) return { kind: 'conflict' };
        const accounts = context.commandText?.trim() === 'disconnect github' ? options.github!.accounts : options.delegated.accounts;
        const kind = context.commandText?.trim() === 'disconnect github' ? 'github-disconnected' : 'disconnected';
        const subject = { objectId: context.subject.objectId }; const account = await accounts.inspect(subject, ctx, true); assertActive(ctx);
        const saved = await directory.reserveControl(candidate({ kind, generation: account.generation,
          targetId: eligible[0]!.id, recipient: context.controlRecipient }, connection?.identityDigest ?? null), ctx); assertActive(ctx);
        if (saved.reply.kind !== kind || !('generation' in saved.reply)) return { kind: 'conflict' };
        if (saved.state === 'ready') {
          await accounts.disconnect(subject, ctx, saved.reply.generation);
          if ((await accounts.inspect(subject, ctx, true)).linked) return { kind: 'duplicate', replyTarget: '' };
        }
        return await control(saved, eligible, false, ctx, connection);
      }
      else if (!connection && command === undefined) reply = { kind: 'discovery', targets: eligible.map(t => ({ ...t })) };
      else if (command !== undefined) {
        if (!desired) return { kind: 'conflict' };
        if (connection && connection.targetId !== command) {
          // Do not name the existing target unless this sender can use it.
          if (!eligible.some(t => t.id === connection!.targetId)) reply = { kind: 'no-access' };
          else { const existing = slots.get(connection.targetId); if (!existing) throw new DirectoryError('corrupt');
            reply = { kind: 'switching', targetId: existing.target.id, label: existing.target.label }; }
        } else {
          if (!connection) {
            // Bind the activity/content before the first connection effect. Ready
            // is not a sent notification; a same-command retry resumes both steps.
            await directory.reserveControl(candidate({ kind: 'connected', targetId: command, label: desired.target.label }, null), ctx);
            assertActive(ctx);
            connection = await directory.reserveConnection({ schema: 1, kind: 'conn', scope, conversationId: event.contextId,
              chatKind, targetId: command, identityDigest: desired.target.identityDigest!,
              bindingName: bindingName(scope, event.contextId, desired.target.identityDigest!), state: 'reserved' }, ctx);
          }
          assertActive(ctx);
          if (!validConnection(connection, desired, event, route.conversation.conversationType)) throw new BindingCheckError('binding-conflict');
          connection = await check(desired, connection, ctx, true); assertActive(ctx);
          reply = { kind: 'connected', targetId: command, label: desired.target.label };
        }
      } else {
        const slot = slots.get(connection!.targetId);
        if (!eligible.some(t => t.id === connection!.targetId)) reply = { kind: 'no-access' };
        else {
          if (!slot || !validConnection(connection!, slot, event, route.conversation.conversationType)) throw new BindingCheckError('binding-conflict');
          if (connection!.state !== 'provisioned') return { kind: 'full' };
          if (options.delegated && (!context.delegatedTenant || !context.subject.objectId || !context.controlRecipient)) return { kind: 'conflict' };
          await check(slot, connection!, ctx); assertActive(ctx);
          if (options.github && context.commandText?.trim() === 'link github') {
            const challenge = await options.github.accounts.challenge({ objectId: context.subject.objectId! }, event.contextId, context.activityId, ctx); assertActive(ctx);
            return await control(candidate({ kind: 'github-signin', targetId: slot.target.id, challengeId: challenge.id, recipient: context.controlRecipient! },
              connection!.identityDigest), eligible, false, ctx, connection);
          }
          if (options.delegated) {
            const subject = { objectId: context.subject.objectId! }; const accounts = options.delegated.accounts;
            const account = await accounts.inspect(subject, ctx); assertActive(ctx);
            const acquired = account.linked ? await accounts.acquire(subject, account.generation, assertion => options.delegated!.auth.exchange(assertion, ctx), ctx,
              refreshToken => options.delegated!.auth.refresh(refreshToken, ctx)) : { kind: 'signin-required' };
            assertActive(ctx);
            if (acquired.kind !== 'token') {
              const challenge = await accounts.challenge(subject, event.contextId, context.activityId, ctx); assertActive(ctx);
              log('signin-required');
              return await control(candidate({ kind: 'signin', targetId: slot.target.id, challengeId: challenge.id, recipient: context.controlRecipient! }, connection!.identityDigest), eligible, false, ctx, connection);
            }
            const github = options.github ? await options.github.accounts.inspect(subject, ctx) : undefined; assertActive(ctx);
            try {
              await accounts.reserveGrant({ ref: grantReference(scope, slot.target, event.externalEventId, event.replyTarget!), objectId: subject.objectId,
                generation: account.generation, provider: 'workiq', targetId: slot.target.id, targetDigest: slot.target.identityDigest!,
                eventId: event.externalEventId, tools: ['workiq', ...(options.github ? githubTools : [])],
                proposalOrigin: { conversationId: event.contextId, replyTarget: event.replyTarget!, route: structuredClone(route),
                  senderMRI: context.controlRecipient!.id, objectId: subject.objectId, displayName: event.sender.displayName ?? '', activityId: context.activityId },
                ...(options.github ? { githubGeneration: github?.linked ? github.generation : 0 } : {}) }, ctx); assertActive(ctx);
            } catch (error) { if (error instanceof AccountError && error.code === 'conflict') return { kind: 'conflict' }; throw error; }
          }
          return await slot.inbox.admit(event, route);
        }
      }
      assertActive(ctx);
      return await control(candidate(reply, connection?.identityDigest ?? null), eligible, denied, ctx, connection);
    } catch (error) {
      if (transient(error) || error instanceof DirectoryError && error.code === 'unready' && !active(ctx)) {
        return { kind: error instanceof DirectoryError && error.code === 'conflict' ? 'conflict' : 'full' };
      }
      throw error;
    } finally { consumers--; if (activityKey !== undefined) activities.delete(activityKey); }
  }
  async function exchange(input: unknown, supplied: ExchangeContext): Promise<ExchangeResponse> {
    const d = options.delegated!; let id = '';
    const response = (ok: boolean): ExchangeResponse => ({ status: ok ? 200 : 412, body: { id, connectionName: d.connectionName,
      ...(ok ? {} : { failureDetail: 'signin-required' as const }) } });
    if (consumers >= 4) return response(false); consumers++;
    const ctx: DirectoryContext = { signal: supplied.signal, deadline: supplied.deadline, authorizeWrite: () => active(ctx) };
    try {
      assertActive(ctx);
      if (!record(input) || !record(input.value) || !record(input.conversation) || !record(input.from) || !record(input.recipient) ||
          !record(input.channelData) || !record(input.channelData.tenant) || input.channelData.tenant.id !== scope.tenantId ||
          input.value.connectionName !== d.connectionName || typeof input.value.id !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/u.test(input.value.id) ||
          typeof input.value.token !== 'string' || !supplied.subject.objectId || uuid(input.from.aadObjectId) !== supplied.subject.objectId) return response(false);
      id = input.value.id; const raw = input.value.token; const objectId = supplied.subject.objectId;
      const conversationId = identity(input.conversation.id); const recipient = { id: identity(input.from.id),
        ...(input.conversation.conversationType === 'groupChat' ? { isTargeted: true as const } : {}) };
      const challenge = await d.accounts.getChallenge(id, ctx); assertActive(ctx);
      if (!challenge || challenge.method === 'browser' || challenge.objectId !== objectId || challenge.conversationId !== conversationId || challenge.expiresAt <= Date.now()) return response(false);
      await d.auth.verify(raw, objectId, ctx); assertActive(ctx);
      const connection = await directory.getConnection(conversationId, ctx); assertActive(ctx);
      if (!connection || connection.state !== 'provisioned') return response(false);
      const policy = await authorizer.authorize(supplied.subject, ctx, connection.targetId); assertActive(ctx);
      if (policy.kind !== 'eligible') return response(false);
      const slot = slots.get(connection.targetId); if (!slot || connection.identityDigest !== slot.target.identityDigest) return response(false);
      await check(slot, connection, ctx); assertActive(ctx);
      let pending = exchanges.get(id);
      if (!pending) {
        pending = (async () => {
          const claimed = await d.accounts.claim(challenge, ctx); assertActive(ctx);
          if (claimed === 'done') return true;
          if (claimed !== 'claimed') return d.accounts.published(challenge, ctx);
          const tokens = await d.auth.exchange(raw, ctx); assertActive(ctx);
          return completeLinked(challenge, tokens, ctx);
        })();
        exchanges.set(id, pending); const owned = pending;
        void owned.finally(() => { if (exchanges.get(id) === owned) exchanges.delete(id); }).catch(() => {});
      }
      const ok = await pending; if (!ok) return response(false);
      // Durable sign-in wins even if its bounded notification cannot complete.
      try {
        assertActive(ctx); const activityId = `signin:${id}`;
        const receiver = options.config.targets[0]!.config.receiver;
        if (typeof input.serviceUrl !== 'string' || !receiver.serviceUrls.includes(input.serviceUrl) ||
          typeof input.recipient.id !== 'string' || !receiver.recipientIds.includes(input.recipient.id)) return response(true);
        await control({ schema: 1, kind: 'control', scope, conversationId, chatKind: connection.chatKind, activityId,
          fingerprint: controlFingerprint(scope, conversationId, activityId, objectId, `signin-complete-v1:${id}`, connection.identityDigest),
          currentTargetDigest: connection.identityDigest, desiredTargetDigest: connection.identityDigest,
          route: { serviceUrl: input.serviceUrl, channelId: 'msteams', bot: { id: input.recipient.id, role: 'bot' },
            conversation: { id: conversationId, tenantId: scope.tenantId, conversationType: connection.chatKind } },
          reply: { kind: 'signed-in', targetId: connection.targetId, recipient }, state: 'ready' }, policy.targets, false, ctx, connection);
      } catch { /* Notification uncertainty cannot replay OBO or start old work. */ }
      log('signin-complete'); return response(true);
    } catch { log('signin-required'); return response(false); }
    finally { consumers--; }
  }
  async function completeLinked(ch: AccountChallenge, tokens: AccountTokens, ctx: DirectoryContext, accounts = options.delegated!.accounts): Promise<boolean> {
    try { if (await accounts.complete(ch, tokens, ctx)) return true; } catch { /* Reconcile a possible account publication below. */ }
    return accounts.published(ch, ctx);
  }
  async function browserOperation<T>(supplied: DirectoryContext, failed: T, action: (ctx: DirectoryContext) => Promise<T>): Promise<T> {
    // Public browser work may borrow only one of the four admission places.
    if (browserBusy || consumers >= 4) return failed;
    browserBusy = true; consumers++;
    const ctx: DirectoryContext = { ...supplied, authorizeWrite: () => active(ctx) };
    try { assertActive(ctx); const result = await action(ctx); assertActive(ctx); return result; }
    catch { log('signin-required'); return failed; }
    finally { browserBusy = false; consumers--; }
  }
  async function browserControl(ch: AccountChallenge, ctx: DirectoryContext, github = false) {
    const saved = await directory.getControl({ kind: 'control', conversationId: ch.conversationId, activityId: ch.activityId }, ctx); assertActive(ctx);
    if (!saved || saved.reply.kind !== (github ? 'github-signin' : 'signin') || !('challengeId' in saved.reply) || saved.reply.challengeId !== ch.id || ch.expiresAt <= Date.now()) return undefined;
    const connection = await directory.getConnection(ch.conversationId, ctx); assertActive(ctx);
    if (!connection || connection.state !== 'provisioned' || connection.targetId !== saved.reply.targetId ||
      connection.identityDigest !== saved.currentTargetDigest || connection.chatKind !== saved.chatKind) return undefined;
    const policy = await authorizer.authorize({ tenantId: scope.tenantId, objectId: ch.objectId, chatKind: connection.chatKind }, ctx, connection.targetId); assertActive(ctx);
    const slot = slots.get(connection.targetId);
    if (policy.kind !== 'eligible' || !slot || connection.identityDigest !== slot.target.identityDigest) return undefined;
    await check(slot, connection, ctx); assertActive(ctx);
    return { saved, connection, targets: policy.targets, recipient: saved.reply.recipient };
  }
  const d = options.delegated; const origin = d?.publicOrigin;
  const browser = d && origin ? {
    origin,
    begin: (id: string, supplied: DirectoryContext, cookie?: string) => browserOperation<string | { redirect: string; cookie: { value: string; maxAge: number } } | undefined>(supplied, undefined, async ctx => {
      const workiq = await d.accounts.getChallenge(id, ctx); assertActive(ctx);
      const ch = workiq ?? await options.github?.accounts.getChallenge(id, ctx); assertActive(ctx);
      if (!ch || !await browserControl(ch, ctx, !workiq)) return undefined;
      const candidate = workiq ? undefined : cookie ?? randomBytes(32).toString('base64url');
      const attempt = await (workiq ? d.accounts : options.github!.accounts).prepareBrowser(ch, ctx, candidate); assertActive(ctx);
      if (!attempt) return undefined;
      const redirect = d.auth.authorizeUrl(attempt, `${origin}/oauth/callback`);
      return workiq ? redirect : { redirect, cookie: { value: candidate!, maxAge: Math.max(1, Math.min(600, Math.floor((ch.expiresAt - Date.now()) / 1000))) } };
    }),
    callback: (form: URLSearchParams, supplied: DirectoryContext & { committed?(): void }, cookie?: string) => browserOperation<boolean | { redirect: string; cookie: { value: string; maxAge: number } }>(supplied, false, async ctx => {
      const workiq = await d.accounts.claimBrowser(form.get('state') ?? '', ctx); assertActive(ctx);
      const attempt = workiq ?? await options.github?.accounts.claimBrowser(form.get('state') ?? '', ctx, cookie); assertActive(ctx);
      // Even consent refusal burns its state; retry starts with a new chat request.
      if (!attempt || form.has('error') || !form.get('code')) return false;
      const ch = attempt.challenge; const bound = await browserControl(ch, ctx, !workiq); if (!bound) return false;
      const tokens = await d.auth.redeemCode(form.get('code')!, attempt, `${origin}/oauth/callback`, ctx); assertActive(ctx);
      if (!workiq) {
        if (!await browserControl(ch, ctx, true)) return false;
        const continuation = await options.github!.accounts.prepareGitHub(attempt, ctx); assertActive(ctx);
        return continuation ? { redirect: options.github!.auth.authorizeUrl(continuation), cookie: { value: continuation.cookie,
          maxAge: Math.max(1, Math.min(600, Math.floor((ch.expiresAt - Date.now()) / 1000))) } } : false;
      }
      if (!await completeLinked(ch, tokens, ctx)) return false;
      supplied.committed?.();
      try {
        const activityId = `signin:${ch.id}`; const connection = bound.connection;
        await control({ schema: 1, kind: 'control', scope, conversationId: ch.conversationId, chatKind: connection.chatKind, activityId,
          fingerprint: controlFingerprint(scope, ch.conversationId, activityId, ch.objectId, `signin-complete-v1:${ch.id}`, connection.identityDigest),
          currentTargetDigest: connection.identityDigest, desiredTargetDigest: connection.identityDigest, route: bound.saved.route,
          reply: { kind: 'signed-in', targetId: connection.targetId, recipient: bound.recipient }, state: 'ready' }, bound.targets, false, ctx, connection);
      } catch { /* Saved sign-in wins; uncertain notification never starts old work. */ }
      log('signin-complete'); return true;
    }),
    ...(options.github ? { githubCallback: (form: URLSearchParams, cookie: string, supplied: DirectoryContext & { committed?(): void }) => browserOperation(supplied, false, async ctx => {
      const g = options.github!; const attempt = await g.accounts.claimGitHub(form.get('state') ?? '', cookie, ctx); assertActive(ctx);
      if (!attempt || form.has('error') || !form.get('code')) return false;
      const ch = attempt.challenge; const bound = await browserControl(ch, ctx, true); if (!bound) return false;
      const tokens = await g.auth.redeemCode(form.get('code')!, attempt, ctx); assertActive(ctx);
      if (!await browserControl(ch, ctx, true) || !await completeLinked(ch, tokens, ctx, g.accounts)) return false;
      supplied.committed?.();
      try {
        const activityId = `github-signin:${ch.id}`; const connection = bound.connection;
        await control({ schema: 1, kind: 'control', scope, conversationId: ch.conversationId, chatKind: connection.chatKind, activityId,
          fingerprint: controlFingerprint(scope, ch.conversationId, activityId, ch.objectId, `github-signin-complete-v1:${ch.id}`, connection.identityDigest),
          currentTargetDigest: connection.identityDigest, desiredTargetDigest: connection.identityDigest, route: bound.saved.route,
          reply: { kind: 'github-signed-in', targetId: connection.targetId, recipient: bound.recipient }, state: 'ready' }, bound.targets, false, ctx, connection);
      } catch { /* Durable linking wins; never replay the old request or an uncertain notification. */ }
      log('signin-complete'); return true;
    }) } : {}),
  } : undefined;
  return {
    scope: options.config.targets[0]!.config.scope, admit,
    ...(browser ? { browser } : {}),
    ...(options.delegated ? { exchange } : {}),
    postProposal, cardAction, admitRevision,
    checkProposal: async (p, ctx) => !!await proposalConnection(p, { tenantId: p.tenantId, objectId: p.objectId, chatKind: p.route.conversation.conversationType === 'groupChat' ? 'groupChat' : 'personal' }, ctx),
    postDecision: async (p, ctx) => { await postProposal(p, ctx, true); },
    bindControlSender(value) { if (sender) throw new Error('Control sender already bound'); sender = value; },
    async preflight(targetId, claim, signal) {
      if (consumers >= 4) return 'busy'; consumers++;
      const ctx: DirectoryContext = { signal, deadline: performance.now() + 2000, authorizeWrite: () => active(ctx) };
      try {
        assertActive(ctx); const slot = slots.get(targetId);
        const connection = await directory.getConnection(claim.event.contextId, ctx); assertActive(ctx);
        if (!slot || !connection || connection.state !== 'provisioned' || !validConnection(connection, slot, claim.event, connection.chatKind)) {
          log('binding-conflict', targetId); return !connection ? 'connection-missing' : connection.state !== 'provisioned' ? 'connection-reserved' : 'connection-mismatch';
        }
        // Last step before Orka sees the event: move the chat first if its front Agent changed.
        await check(slot, connection, ctx, false, true); assertActive(ctx); return true;
      } catch (error) {
        if (!transient(error) && !(error instanceof DirectoryError && error.code === 'unready' && !active(ctx))) throw error;
        // An expired budget surfaces as whichever read was running, so name the budget first.
        if (!active(ctx)) return signal.aborted ? 'cancelled' : performance.now() >= ctx.deadline ? 'deadline' : 'not-serving';
        if (error instanceof BindingCheckError) return error.step ? `${error.category}:${error.step}` : error.category;
        return `${error instanceof DirectoryError ? 'directory' : error instanceof AccountError ? 'account' : 'table'}-${(error as { code: string }).code}`;
      }
      finally { consumers--; }
    },
  };
}

function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
const cardVerbs = ['pr-refresh', 'pr-approve', 'pr-reject', 'pr-revise'];
const clientPlatforms = ['Web', 'Windows', 'Mac', 'iOS', 'Android', 'Linux'];
interface CardActionSeen { stage: 'unavailable' | 'busy' | 'activity' | 'action' | 'proposal' | 'connection' | 'decision' | 'output';
  verb?: string; trigger?: string; proposal?: string; targetId?: string; state?: string; extra: string[] }
/** Where the invoke came from: the service URL's host in a fixed shape and the client platform Teams reports, from a fixed list. */
function cardActionClient(input: unknown): { service?: string; platform?: string } {
  if (!record(input)) return {};
  let service: string | undefined;
  try { service = typeof input.serviceUrl === 'string' && input.serviceUrl.length <= 2048 ? new URL(input.serviceUrl).hostname : undefined; } catch { /* Not a URL. */ }
  const info = Array.isArray(input.entities) ? input.entities.slice(0, 16).find(e => record(e) && e.type === 'clientInfo') as Record<string, unknown> | undefined : undefined;
  return { ...(service === undefined ? {} : { service: /^[a-z0-9.-]{1,253}$/u.test(service) ? service : '?' }),
    ...(info?.platform === undefined ? {} : { platform: typeof info.platform === 'string' && clientPlatforms.find(name => name.toLowerCase() === (info.platform as string).toLowerCase()) || 'other' }) };
}
function formatControl(reply: ControlReply, delegated?: DelegatedOptions, chatKind?: string): ProviderMessage {
  if (reply.kind === 'signin' || reply.kind === 'github-signin') {
    if (!delegated) throw new DirectoryError('unready');
    const text = reply.kind === 'github-signin' ? 'Sign in with Microsoft, then link your GitHub account.' : 'Sign in to continue. Send your request again after signing in.';
    const button = delegated.publicOrigin ? { type: 'signin' as const, title: 'Sign in',
      value: `${delegated.publicOrigin}/signin?challenge=${encodeURIComponent(reply.challengeId)}` } : undefined;
    if (button && (chatKind === 'personal' || reply.kind === 'github-signin')) return { type: 'message', recipient: reply.recipient,
      attachments: [{ contentType: 'application/vnd.microsoft.card.signin', content: { text, buttons: [button] } }] };
    return { type: 'message', recipient: reply.recipient, attachments: [{ contentType: 'application/vnd.microsoft.card.oauth', content: {
      text, connectionName: delegated.connectionName,
      tokenExchangeResource: { id: reply.challengeId, uri: delegated.apiUri, providerId: 'Azure Active Directory v2' }, buttons: button ? [button] : [] } }] };
  }
  const text = reply.kind === 'github-signed-in' ? 'Your GitHub account is linked. Send your request again.' : reply.kind === 'github-disconnected' ? 'Your GitHub account is disconnected.' : reply.kind === 'signed-in' ? 'You are signed in. Send your request again.' : reply.kind === 'disconnected' ? 'Your account is disconnected.' : reply.kind === 'no-access' ? NO_ACCESS_TEXT : reply.kind === 'discovery' ?
    `Connect this chat: ${reply.targets.map(t => t.label).join(' or ')}. Send ${reply.targets.map(t => `“use ${t.id}”`).join(' or ')}.` :
    reply.kind === 'connected' ? `This chat uses ${reply.label}. Send your request again.` :
      'Switching this chat to another Orka is not supported.';
  return { type: 'message', ...('recipient' in reply ? { recipient: { ...reply.recipient, role: 'user' as const } } : {}), attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
    type: 'AdaptiveCard', version: '1.4', fallbackText: reply.kind === 'no-access' ? NO_ACCESS_TEXT : 'Orka chat connection', body: [{ type: 'RichTextBlock', inlines: [{ type: 'TextRun', text }] }] } }] };
}
