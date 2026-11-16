import { randomUUID } from 'node:crypto';
import type { ExchangeContext } from '../ingress/server.js';
import type { LeaseAuthority } from '../storage/table/types.js';
import type { DirectoryContext, DirectoryScope } from '../directory/types.js';
import type { AccountStore } from './store.js';
import { AccountError } from './store.js';
import type { TaskGrant } from './grants.js';
import type { createGitHub } from './github.js';
import { githubArguments, GitHubError } from './github.js';
import { proposalIdentity, proposalDigest, proposalArgs, proposalOutput, projectClaim, claimEvidence } from './pull-request-proposal.js';
import type { Proposal, ProposalOutcome, RevisionAdmission } from './pull-request-proposal.js';
import { canonicalJSON } from '../directory/codec.js';

export function createPullRequestService(options: { accounts: AccountStore; githubAccounts: AccountStore;
  github: Pick<ReturnType<typeof createGitHub>, 'readProposalFacts' | 'readUserId' | 'readHead' | 'findPullRequest' | 'openProposedPullRequest' | 'refresh'>; scope: DirectoryScope; now?: () => number;
  postProposal(proposal: Proposal, ctx: DirectoryContext): Promise<'delivered' | 'uncertain' | 'unavailable'>;
  decisions?: { authority: LeaseAuthority; connected(p: Proposal, ctx: DirectoryContext): Promise<boolean>;
    admitRevision?(p: Proposal, ctx: ExchangeContext): Promise<Exclude<RevisionAdmission, 'pending'>>;
    postDecision(p: Proposal, ctx: DirectoryContext): Promise<void> } }) {
  const now = options.now ?? Date.now; let closed = false; let places = 0;
  const shutdown = new AbortController(); const effects = new Set<Promise<unknown>>(); const intake = new Set<Promise<unknown>>();
  const effectIds = new Set<string>(); let recovery: Promise<void> | undefined;
  const active = (ctx: DirectoryContext) => !closed && !!options.decisions?.authority.allowed() && !ctx.signal.aborted && performance.now() < ctx.deadline;
  async function generations(p: Proposal, ctx: DirectoryContext) {
    const subject = { objectId: p.objectId }; const a = await options.accounts.inspect(subject, ctx);
    const g = await options.githubAccounts.inspect(subject, ctx);
    return a.linked && a.generation === p.generation && g.linked && g.generation === p.githubGeneration &&
      await options.githubAccounts.providerIdentity(subject, p.githubGeneration, ctx) === p.githubId;
  }
  async function finish(p: Proposal, outcome: ProposalOutcome | undefined, ctx: DirectoryContext) {
    const version = await options.accounts.getProposal(p.id, ctx); if (!version) throw new GitHubError();
    const current = version.proposal;
    if (outcome && ['approving', 'uncertain'].includes(current.state)) {
      const state = outcome.kind === 'opened' ? 'opened' : outcome.kind === 'branch-moved' ? 'branch-moved' : outcome.kind === 'uncertain' ? 'uncertain' : 'failed';
      p = (await options.accounts.replaceProposal(version, { ...current, state, outcome }, ctx)).proposal;
    } else p = current;
    await options.decisions!.postDecision(p, ctx);
  }
  async function opening(p: Proposal, ctx: DirectoryContext, settlement: DirectoryContext) {
    const guards: ReturnType<AccountStore['watch']>[] = []; let reserving = false; let sent = false; let token: string | undefined;
    const bound = { ...ctx, authorizeWrite: () => active(ctx) && guards.every(g => g.active()) };
    let outcome: ProposalOutcome;
    try {
      if (p.claim?.decision === 'reject') { await finish(p, undefined, bound); return; }
      if (!await generations(p, bound) || !await options.decisions!.connected(p, bound)) throw new GitHubError('signin-required');
      const subject = { objectId: p.objectId };
      const acquired = await options.githubAccounts.acquire(subject, p.githubGeneration, async () => { throw new GitHubError(); }, bound, refresh => options.github.refresh(refresh, bound));
      if (acquired.kind !== 'token') throw new GitHubError('signin-required'); token = acquired.accessToken;
      guards.push(options.accounts.watch(subject), options.githubAccounts.watch(subject));
      if (!await options.accounts.pin(subject, p.generation, bound) || await options.github.readUserId(token, bound) !== p.githubId) throw new GitHubError('signin-required');
      if (await options.github.readHead(p, token, bound) !== p.headSHA) outcome = { kind: 'branch-moved' };
      else {
        const existing = await options.github.findPullRequest(p, token, bound);
        if (existing) outcome = existing;
        else {
          reserving = true; const reservation = await options.accounts.reserveProposalWrite(p, bound);
          if (reservation.kind === 'done') outcome = reservation.outcome;
          else if (reservation.kind === 'uncertain') outcome = { kind: 'uncertain' };
          else {
            if (!await options.decisions!.authority.revalidate() || !await generations(p, bound) || !await options.decisions!.connected(p, bound) || !bound.authorizeWrite()) throw new GitHubError('signin-required');
            // No await between the final local fence and the native client's own handoff check.
            sent = true;
            try { outcome = await options.github.openProposedPullRequest(p, token, bound); }
            catch (e) {
              if (!(e instanceof GitHubError && e.code === 'validation')) throw e;
              outcome = await options.github.findPullRequest(p, token, bound) ?? { kind: 'validation' };
            }
            await options.accounts.completeProposalWrite(p, outcome, bound);
          }
        }
      }
    } catch (e) {
      outcome = { kind: e instanceof GitHubError && e.code === 'permission' ? 'permission' :
        e instanceof GitHubError && ['signin-required', 'unauthorized'].includes(e.code) ? 'signin-required' : sent || reserving ? 'uncertain' : 'failed' };
      for (const g of guards.splice(0)) g.release();
      if (e instanceof GitHubError && e.code === 'unauthorized' && token) try { await options.githubAccounts.invalidate({ objectId: p.objectId }, p.githubGeneration, token, ctx); } catch { /* No retry. */ }
    } finally { for (const g of guards) g.release(); }
    // Settlement uses runtime authority, not a credential guard invalidated by disconnect.
    await finish(p, outcome!, settlement);
  }
  async function reconcile(p: Proposal, ctx: DirectoryContext, owned = false, settlement = ctx) {
    if (!active(ctx) || !owned && effectIds.has(p.id)) return;
    if (!owned) effectIds.add(p.id);
    try {
    const version = await options.accounts.getProposal(p.id, ctx); if (!version) return; p = version.proposal;
    if (version.needsProjection) await options.accounts.replaceProposal(version, p, ctx);
    if (!await generations(p, ctx) || !await options.decisions!.connected(p, ctx)) return;
    if (!['approving', 'uncertain'].includes(p.state)) { await finish(p, undefined, settlement); return; }
    const saved = await options.accounts.proposalWriteOutcome(p, ctx);
    if (saved) { await finish(p, saved, settlement); return; }
    const fence = await options.accounts.fenceUnsentProposal(p, ctx);
    if (fence === 'abandoned') { await finish(p, { kind: 'failed' }, settlement); return; }
    let outcome: ProposalOutcome = { kind: 'uncertain' };
    const guards: ReturnType<AccountStore['watch']>[] = [];
    const bound = { ...ctx, authorizeWrite: () => active(ctx) && guards.every(g => g.active()) };
    try {
      const subject = { objectId: p.objectId };
      // Recovery never renews through GitHub's POST token endpoint. Expired credentials retain uncertainty.
      const account = await options.githubAccounts.acquire(subject, p.githubGeneration, async () => { throw new GitHubError(); }, bound);
      if (account.kind === 'token') {
        guards.push(options.accounts.watch(subject), options.githubAccounts.watch(subject));
        if (await options.accounts.pin(subject, p.generation, bound) && await options.github.readUserId(account.accessToken, bound) === p.githubId &&
          await options.decisions!.authority.revalidate() && await options.decisions!.connected(p, bound))
          outcome = await options.github.findPullRequest(p, account.accessToken, bound, true) ?? outcome;
      }
    } catch { /* Missing, ambiguous or unreadable evidence never grants another POST. */ }
    finally { for (const g of guards) g.release(); }
    await finish(p, outcome, settlement);
    } finally { if (!owned) effectIds.delete(p.id); }
  }
  async function revising(p: Proposal, ctx: ExchangeContext, settlement: DirectoryContext) {
    const version = await options.accounts.getProposal(p.id, ctx); if (!version) return;
    p = version.proposal;
    if (p.claim?.decision !== 'revise' || ['delivered', 'conflict'].includes(p.revisionAdmission ?? 'pending')) return;
    if (version.needsProjection) await options.accounts.replaceProposal(version, p, ctx);
    const status = await options.decisions!.admitRevision!(p, ctx);
    const current = await options.accounts.getProposal(p.id, settlement);
    if (current && !['delivered', 'conflict'].includes(current.proposal.revisionAdmission ?? 'pending'))
      await options.accounts.replaceProposal(current, { ...current.proposal, revisionAdmission: status }, settlement);
  }
  function launch(p: Proposal, readOnly = false, sender?: ExchangeContext) {
    effectIds.add(p.id);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000); timer.unref();
    const ctx = { signal: AbortSignal.any([controller.signal, shutdown.signal, options.decisions!.authority.lost]), deadline: performance.now() + 30000,
      authorizeWrite: () => active(ctx) };
    // Reserve the last four seconds of the same thirty-second lifetime for outcome settlement, not more GitHub work.
    const operation = new AbortController(); const operationTimer = setTimeout(() => operation.abort(), 26000); operationTimer.unref();
    const work = { ...ctx, signal: AbortSignal.any([ctx.signal, operation.signal]), deadline: ctx.deadline - 4000 };
    const pending = (p.claim?.decision === 'revise' ? revising(p, { ...sender!, ...work }, ctx) :
      readOnly ? reconcile(p, work, true, ctx) : opening(p, work, ctx)).catch(() => { /* Retained claim/write evidence is reconciled, never re-POSTed. */ })
      .finally(() => { clearTimeout(timer); clearTimeout(operationTimer); effects.delete(pending); effectIds.delete(p.id); places--; });
    effects.add(pending);
  }
  async function decide(expected: Proposal, decision: 'approve' | 'reject' | 'revise', activityId: string, supplied: ExchangeContext, note?: string): Promise<Proposal> {
      const timerController = new AbortController(); const timer = setTimeout(() => timerController.abort(), 4000); timer.unref();
      const ctx = { ...supplied, signal: AbortSignal.any([supplied.signal, timerController.signal, shutdown.signal, options.decisions?.authority.lost ?? shutdown.signal]),
        deadline: Math.min(supplied.deadline, performance.now() + 4000), authorizeWrite: () => active(ctx) };
      let slot = false; let launched = false;
      try {
      if (!active(ctx) || supplied.subject.tenantId !== expected.tenantId || supplied.subject.objectId !== expected.objectId ||
        expected.appId !== options.scope.appId || expected.tenantId !== options.scope.tenantId || !['approve', 'reject', 'revise'].includes(decision)) throw new GitHubError();
      const p = (await options.accounts.getProposal(expected.id, ctx))?.proposal;
      if (!p || p.objectId !== supplied.subject.objectId || p.tenantId !== supplied.subject.tenantId || p.conversationId !== expected.conversationId ||
        p.payloadDigest !== expected.payloadDigest || p.revision !== expected.revision || !await options.decisions!.connected(p, ctx)) throw new GitHubError();
      if (p.state === 'revise-requested' && decision === 'revise') { refresh(p, supplied); return p; }
      if (!await generations(p, ctx)) throw new GitHubError();
      if (p.state !== 'pending' || places >= 4 || effectIds.has(p.id)) return p;
      places++; slot = true; effectIds.add(p.id);
      if (decision === 'revise' && !options.decisions!.admitRevision) throw new GitHubError();
      const claim = claimEvidence({ decision, tenantId: p.tenantId, objectId: p.objectId, invokeActivityId: activityId, decidedAt: now(),
        ...(decision === 'revise' ? { note, revisionReplyTarget: randomUUID() } : {}) });
      if (!await options.accounts.claimProposal(p, claim, ctx)) return (await options.accounts.getProposal(p.id, ctx))!.proposal;
      const claimed = projectClaim(p, claim); launch(claimed, false, supplied); launched = true; return claimed;
      } finally { clearTimeout(timer); if (slot && !launched) { places--; effectIds.delete(expected.id); } }
  }
  function refresh(p: Proposal, sender?: ExchangeContext) {
    const revision = p.state === 'revise-requested' && !['delivered', 'conflict'].includes(p.revisionAdmission ?? 'pending') &&
      !!sender && sender.delegatedTenant === true && sender.controlRecipient?.id === p.senderMRI &&
      sender.subject.tenantId === p.tenantId && sender.subject.objectId === p.objectId && active(sender) && !!options.decisions?.admitRevision;
    if (!closed && places < 4 && !effectIds.has(p.id) && (revision || ['approving', 'uncertain'].includes(p.state))) {
      places++; launch(p, true, sender && { ...sender, subject: { ...sender.subject } });
    }
  }
  return {
    refresh,
    recover(supplied: DirectoryContext): Promise<void> {
      if (recovery) return recovery;
      const ctx = { ...supplied, signal: AbortSignal.any([supplied.signal, shutdown.signal, options.decisions?.authority.lost ?? shutdown.signal]), authorizeWrite: () => active(ctx) };
      recovery = options.accounts.visitRecoverableProposals(ctx, async p => { try { await reconcile(p, ctx); } catch { /* Keep durable evidence for authenticated refresh or a later restart. */ } })
        .catch(() => { /* A bounded pass failure does not retry global startup. */ }).finally(() => { recovery = undefined; });
      return recovery;
    },
    decide(expected: Proposal, decision: 'approve' | 'reject' | 'revise', activityId: string, ctx: ExchangeContext, note?: string): Promise<Proposal> {
      const pending = decide(expected, decision, activityId, ctx, note); intake.add(pending);
      void pending.then(() => intake.delete(pending), () => intake.delete(pending)); return pending;
    },
    async close(): Promise<void> { closed = true; shutdown.abort(); await Promise.allSettled([...intake, ...effects, recovery]); },

    async propose(grant: TaskGrant, input: Record<string, string>, operation: string, token: string, ctx: DirectoryContext,
      safeOutput: (text: string) => Promise<boolean>): Promise<{ text: string }> {
      if (!grant.proposalOrigin || !grant.binding || !grant.githubGeneration || grant.proposalOrigin.objectId !== grant.objectId) throw new GitHubError();
      const args = githubArguments('github-propose-pull-request', input);
      const canonicalArgs = { ...args, body: args.body ?? '' };
      const id = proposalIdentity(grant.ref, grant.binding.taskUID, operation);
      let p = (await options.accounts.getProposal(id, ctx))?.proposal;
      if (p && canonicalJSON(proposalArgs(p)) !== canonicalJSON(canonicalArgs)) throw new AccountError('operation-conflict');
      if (!p) {
        const facts = await options.github.readProposalFacts(args, token, ctx);
        if (facts.githubId !== await options.githubAccounts.providerIdentity({ objectId: grant.objectId }, grant.githubGeneration, ctx)) throw new GitHubError();
        const createdAt = now();
        p = { ...grant.proposalOrigin, ...facts, ...options.scope, ...canonicalArgs, id, revision: 1, state: 'pending',
          generation: grant.generation, githubGeneration: grant.githubGeneration, targetId: grant.targetId, targetDigest: grant.targetDigest,
          grantRef: grant.ref, taskUID: grant.binding.taskUID, createdAt, expiresAt: createdAt + 3_600_000, payloadDigest: '' } as Proposal;
        p.payloadDigest = proposalDigest(p);
      }
      if (!await safeOutput(proposalOutput(p))) throw new GitHubError();
      p = await options.accounts.reserveProposal({ ...p, state: 'pending' }, operation, ctx);
      if (p.state !== 'pending') return { text: 'This approval request is no longer pending. Ask again for a new card.' };
      const sent = await options.postProposal(p, ctx);
      if (sent === 'unavailable') throw new GitHubError();
      return { text: sent === 'delivered' ? 'Approval card sent to the requester.' :
        'The approval request is saved, but I could not confirm the card arrived. Check this conversation before asking again.' };
    },
  };
}
