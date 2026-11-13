import { identity } from '../delivery/identity.js';
import { AccountError } from '../accounts/store.js';
import type { AccountStore } from '../accounts/store.js';
import type { createDelegatedAuth } from '../auth/delegated.js';
import type { ExchangeContext, ExchangeResponse } from '../ingress/server.js';
import { bindingName, controlFingerprint, parseUseCommand } from '../directory/codec.js';
import type { Directory } from '../directory/store.js';
import { BindingCheckError } from '../directory/provision.js';
import type { createBindingProvisioner } from '../directory/provision.js';
import { DirectoryError } from '../directory/types.js';
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

type Category = BindingCheckError['category'] | 'graph-unavailable' | 'signin-required' | 'signin-complete';
interface DelegatedOptions { accounts: AccountStore; auth: ReturnType<typeof createDelegatedAuth>; apiUri: string; connectionName: string }
interface Slot { target: RegistryTarget; inbox: Pick<IngressPort, 'admit'>; provisioner: ReturnType<typeof createBindingProvisioner> }
interface Options { delegated?: DelegatedOptions; config: RegistryConfig; directory: Directory; slots: readonly Slot[]; authority: LeaseAuthority; active(): boolean;
  authorizer: Pick<ReturnType<typeof createGroupAuthorizer>, 'authorize'>; log(category: Category, targetId?: string): void }

/** Four complete consumers share the directory's four places, including control settlement.
 * No waiting queue, cached Binding authority, replacement target or second sender. */
export function createRegistryAdmission(options: Options): AdmissionSink & {
  bindControlSender(sender: Pick<ProviderSender, 'send'>): void;
  preflight(targetId: string, claim: Readonly<IngressClaim>, signal: AbortSignal): Promise<boolean>;
} {
  const { directory, authority, authorizer } = options;
  const scope = { appId: options.config.targets[0]!.config.scope.appId, tenantId: options.config.targets[0]!.config.scope.tenantId };
  const slots = new Map(options.slots.map(slot => [slot.target.id, slot]));
  const exchanges = new Map<string, Promise<boolean>>();
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
  async function check(slot: Slot, connection: ConnectionRecord, ctx: DirectoryContext, reconcile = false): Promise<ConnectionRecord> {
    assertActive(ctx); const id = slot.target.id; const state = paused.get(id);
    if (state?.pending) { await joinRecovery(state.pending, ctx); assertActive(ctx); }
    else if (state && performance.now() < state.next) throw new BindingCheckError('target-paused');
    const run = async () => {
      try {
        assertActive(ctx);
        const evidence = await slot.provisioner[reconcile ? 'reconcile' : 'check'](connection,
          { signal: ctx.signal, deadline: ctx.deadline, allowed: () => active(ctx) });
        assertActive(ctx);
        const saved = reconcile ? await directory.markProvisioned(connection, evidence, ctx) : connection;
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
    connection?: ConnectionRecord): Promise<AdmissionResult> {
    assertActive(ctx);
    const saved = candidate.state === 'ready' ? await directory.reserveControl(candidate, ctx) : candidate; assertActive(ctx);
    if (!permitted(saved.reply, eligible, denied)) return { kind: 'conflict' };
    if (saved.state !== 'ready') return { kind: 'duplicate', replyTarget: '' };
    if (saved.reply.kind === 'connected' && (connection?.state !== 'provisioned' || connection.targetId !== saved.reply.targetId ||
        connection.identityDigest !== slots.get(saved.reply.targetId)?.target.identityDigest)) return { kind: 'conflict' };
    const route = saved.route; const receiver = options.config.targets[0]!.config.receiver;
    if (!receiver.serviceUrls.includes(route.serviceUrl) || !receiver.recipientIds.includes(route.bot.id) ||
        route.conversation.tenantId !== scope.tenantId || route.conversation.id !== saved.conversationId) throw new DirectoryError('corrupt');
    const armed = await directory.armControl(keyOf(saved), ctx); assertActive(ctx);
    if (!sender) throw new DirectoryError('unready');
    const outcome = await sender.send(route, formatControl(saved.reply, options.delegated), { signal: ctx.signal, deadline: ctx.deadline, authority });
    assertActive(ctx);
    await directory.settleControl(keyOf(saved), armed.attemptUUID, outcome.kind === 'delivered' ? outcome : { kind: outcome.kind === 'retryable' ? 'no-effect' : 'unknown' }, ctx);
    return outcome.kind === 'retryable' ? { kind: 'full' } : { kind: 'accepted', replyTarget: '' };
  }
  async function admit(event: Readonly<EventEnvelope>, route: Readonly<ReplyRoute>, supplied?: AdmissionContext): Promise<AdmissionResult> {
    if (route.conversation.conversationType === 'channel') return { kind: 'conflict' };
    if (!supplied || consumers >= 4) return { kind: 'full' };
    const context = { ...supplied }; const ctx: DirectoryContext = { signal: context.signal, deadline: context.deadline, authorizeWrite: () => active(ctx) };
    if (!active(ctx)) return { kind: 'full' }; consumers++;
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
      else if (previous && (previous.state !== 'ready' || previous.reply.kind !== 'connected')) {
        if (previous.state === 'ready' && previous.reply.kind === 'disconnected' && options.delegated && context.subject.objectId) {
          await options.delegated.accounts.disconnect({ objectId: context.subject.objectId }, ctx, previous.reply.generation); assertActive(ctx);
        }
        return await control(previous, eligible, false, ctx, connection);
      }
      else if (options.delegated && context.commandText?.trim() === 'disconnect') {
        if (!context.delegatedTenant || !context.subject.objectId || !context.controlRecipient) return { kind: 'conflict' };
        const subject = { objectId: context.subject.objectId }; const account = await options.delegated.accounts.inspect(subject, ctx); assertActive(ctx);
        const saved = await directory.reserveControl(candidate({ kind: 'disconnected', generation: account.generation,
          targetId: eligible[0]!.id, recipient: context.controlRecipient }, connection?.identityDigest ?? null), ctx); assertActive(ctx);
        if (saved.reply.kind !== 'disconnected') return { kind: 'conflict' };
        if (saved.state === 'ready') await options.delegated.accounts.disconnect(subject, ctx, saved.reply.generation);
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
          if (options.delegated) {
            const subject = { objectId: context.subject.objectId! }; const accounts = options.delegated.accounts;
            const account = await accounts.inspect(subject, ctx); assertActive(ctx);
            const acquired = account.linked ? await accounts.acquire(subject, account.generation, assertion => options.delegated!.auth.exchange(assertion, ctx), ctx) : { kind: 'signin-required' };
            assertActive(ctx);
            if (acquired.kind !== 'token') {
              const challenge = await accounts.challenge(subject, event.contextId, context.activityId, ctx); assertActive(ctx);
              log('signin-required');
              return await control(candidate({ kind: 'signin', targetId: slot.target.id, challengeId: challenge.id, recipient: context.controlRecipient! }, connection!.identityDigest), eligible, false, ctx, connection);
            }
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
    } finally { consumers--; }
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
          typeof input.value.token !== 'string' || !supplied.subject.objectId || input.from.aadObjectId !== supplied.subject.objectId) return response(false);
      id = input.value.id; const raw = input.value.token; const objectId = supplied.subject.objectId;
      const conversationId = identity(input.conversation.id); const recipient = { id: identity(input.from.id),
        ...(input.conversation.conversationType === 'groupChat' ? { isTargeted: true as const } : {}) };
      const challenge = await d.accounts.getChallenge(id, ctx); assertActive(ctx);
      if (!challenge || challenge.objectId !== objectId || challenge.conversationId !== conversationId || challenge.expiresAt <= Date.now()) return response(false);
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
          if (claimed !== 'claimed') return false;
          const tokens = await d.auth.exchange(raw, ctx); assertActive(ctx);
          return d.accounts.complete(challenge, tokens, ctx);
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
  return {
    scope: options.config.targets[0]!.config.scope, admit,
    ...(options.delegated ? { exchange } : {}),
    bindControlSender(value) { if (sender) throw new Error('Control sender already bound'); sender = value; },
    async preflight(targetId, claim, signal) {
      if (consumers >= 4) return false; consumers++;
      const ctx: DirectoryContext = { signal, deadline: performance.now() + 2000, authorizeWrite: () => active(ctx) };
      try {
        assertActive(ctx); const slot = slots.get(targetId);
        const connection = await directory.getConnection(claim.event.contextId, ctx); assertActive(ctx);
        if (!slot || !connection || connection.state !== 'provisioned' || !validConnection(connection, slot, claim.event, connection.chatKind)) {
          log('binding-conflict', targetId); return false;
        }
        await check(slot, connection, ctx); assertActive(ctx); return true;
      } catch (error) {
        if (transient(error) || error instanceof DirectoryError && error.code === 'unready' && !active(ctx)) return false;
        throw error;
      }
      finally { consumers--; }
    },
  };
}

function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function formatControl(reply: ControlReply, delegated?: DelegatedOptions): ProviderMessage {
  if (reply.kind === 'signin') {
    if (!delegated) throw new DirectoryError('unready');
    return { type: 'message', recipient: reply.recipient, attachments: [{ contentType: 'application/vnd.microsoft.card.oauth', content: {
      text: 'Sign in to continue. Send your request again after signing in.', connectionName: delegated.connectionName,
      tokenExchangeResource: { id: reply.challengeId, uri: delegated.apiUri, providerId: 'Azure Active Directory v2' }, buttons: [] } }] };
  }
  const text = reply.kind === 'signed-in' ? 'You are signed in. Send your request again.' : reply.kind === 'disconnected' ? 'Your account is disconnected.' : reply.kind === 'no-access' ? NO_ACCESS_TEXT : reply.kind === 'discovery' ?
    `Connect this chat: ${reply.targets.map(t => t.label).join(' or ')}. Send ${reply.targets.map(t => `“use ${t.id}”`).join(' or ')}.` :
    reply.kind === 'connected' ? `This chat uses ${reply.label}. Send your request again.` :
      'Switching this chat to another Orka is not supported.';
  return { type: 'message', ...('recipient' in reply ? { recipient: { ...reply.recipient, role: 'user' as const } } : {}), attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
    type: 'AdaptiveCard', version: '1.4', fallbackText: reply.kind === 'no-access' ? NO_ACCESS_TEXT : 'Orka chat connection', body: [{ type: 'RichTextBlock', inlines: [{ type: 'TextRun', text }] }] } }] };
}
