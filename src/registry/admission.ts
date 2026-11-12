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
import type { OutgoingTeamsMessage } from '../teams/format.js';
import type { RegistryConfig, RegistryTarget } from './config.js';

type Category = BindingCheckError['category'] | 'graph-unavailable';
interface Slot { target: RegistryTarget; inbox: Pick<IngressPort, 'admit'>; provisioner: ReturnType<typeof createBindingProvisioner> }
interface Options { config: RegistryConfig; directory: Directory; slots: readonly Slot[]; authority: LeaseAuthority; active(): boolean;
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
  const paused = new Map<string, { next: number; pending?: Promise<void> }>();
  const logged = new Map<string, Set<Category>>(); let consumers = 0;
  let sender: Pick<ProviderSender, 'send'> | undefined;
  const active = (ctx: DirectoryContext) => options.active() && authority.allowed() && !ctx.signal.aborted && performance.now() < ctx.deadline;
  const assertActive = (ctx: DirectoryContext) => { if (!active(ctx)) throw new BindingCheckError('target-paused'); };
  const log = (category: Category, id = '') => {
    const prior = logged.get(id) ?? new Set<Category>();
    if (!prior.has(category)) { prior.add(category); logged.set(id, prior); options.log(category, id || undefined); }
  };
  const transient = (error: unknown) => error instanceof BindingCheckError || error instanceof DirectoryError &&
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
    const outcome = await sender.send(route, formatControl(saved.reply), { signal: ctx.signal, deadline: ctx.deadline, authority });
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
        return await control(previous, eligible, false, ctx, connection);
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
          await check(slot, connection!, ctx); assertActive(ctx);
          return await slot.inbox.admit(event, route);
        }
      }
      assertActive(ctx);
      return await control(candidate(reply, connection?.identityDigest ?? null), eligible, denied, ctx, connection);
    } catch (error) {
      if (transient(error)) return { kind: error instanceof DirectoryError && error.code === 'conflict' ? 'conflict' : 'full' };
      throw error;
    } finally { consumers--; }
  }
  return {
    scope: options.config.targets[0]!.config.scope, admit,
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
      } catch (error) { if (transient(error)) return false; throw error; }
      finally { consumers--; }
    },
  };
}

function formatControl(reply: ControlReply): OutgoingTeamsMessage {
  const text = reply.kind === 'no-access' ? NO_ACCESS_TEXT : reply.kind === 'discovery' ?
    `Connect this chat: ${reply.targets.map(t => t.label).join(' or ')}. Send ${reply.targets.map(t => `“use ${t.id}”`).join(' or ')}.` :
    reply.kind === 'connected' ? `This chat uses ${reply.label}. Send your request again.` :
      'Switching this chat to another Orka is not supported.';
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
    type: 'AdaptiveCard', version: '1.4', fallbackText: reply.kind === 'no-access' ? NO_ACCESS_TEXT : 'Orka chat connection', body: [{ type: 'RichTextBlock', inlines: [{ type: 'TextRun', text }] }] } }] };
}
