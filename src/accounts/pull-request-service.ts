import type { ExchangeContext } from '../ingress/server.js';
import type { LeaseAuthority } from '../storage/table/types.js';
import type { DirectoryContext, DirectoryScope } from '../directory/types.js';
import type { AccountStore } from './store.js';
import { AccountError } from './store.js';
import type { TaskGrant } from './grants.js';
import type { createGitHub } from './github.js';
import { githubArguments, GitHubError } from './github.js';
import { proposalIdentity, proposalDigest, proposalArgs, proposalOutput } from './pull-request-proposal.js';
import type { Proposal } from './pull-request-proposal.js';
import { canonicalJSON } from '../directory/codec.js';

export function createPullRequestService(options: { accounts: AccountStore; githubAccounts: AccountStore;
  github: Pick<ReturnType<typeof createGitHub>, 'readProposalFacts'>; scope: DirectoryScope; now?: () => number;
  postProposal(proposal: Proposal, ctx: DirectoryContext): Promise<'delivered' | 'uncertain' | 'unavailable'>;
  decisions?: { authority: LeaseAuthority; connected(p: Proposal, ctx: DirectoryContext): Promise<boolean>;
    postDecision(p: Proposal, ctx: DirectoryContext): Promise<void> } }) {
  const now = options.now ?? Date.now; let closed = false;
  const active = (ctx: DirectoryContext) => !closed && !!options.decisions?.authority.allowed() && !ctx.signal.aborted && performance.now() < ctx.deadline;
  async function generations(p: Proposal, ctx: DirectoryContext) {
    const subject = { objectId: p.objectId }; const a = await options.accounts.inspect(subject, ctx);
    const g = await options.githubAccounts.inspect(subject, ctx);
    return a.linked && a.generation === p.generation && g.linked && g.generation === p.githubGeneration &&
      await options.githubAccounts.providerIdentity(subject, p.githubGeneration, ctx) === p.githubId;
  }
  return {
    async decide(expected: Proposal, decision: 'approve' | 'reject', activityId: string, supplied: ExchangeContext): Promise<Proposal> {
      const ctx = { ...supplied, deadline: Math.min(supplied.deadline, performance.now() + 4000), authorizeWrite: () => active(ctx) };
      if (!active(ctx) || supplied.subject.tenantId !== expected.tenantId || supplied.subject.objectId !== expected.objectId ||
        expected.appId !== options.scope.appId || expected.tenantId !== options.scope.tenantId || !['approve', 'reject'].includes(decision)) throw new GitHubError();
      const p = (await options.accounts.getProposal(expected.id, ctx))?.proposal;
      if (!p || p.payloadDigest !== expected.payloadDigest || p.revision !== expected.revision || !await options.decisions!.connected(p, ctx) ||
        !await generations(p, ctx)) throw new GitHubError();
      if (p.state === 'pending') await options.accounts.claimProposal(p, { decision, tenantId: p.tenantId, objectId: p.objectId, invokeActivityId: activityId, decidedAt: now() }, ctx);
      return (await options.accounts.getProposal(p.id, ctx))!.proposal;
    },
    async close(): Promise<void> { closed = true; },

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
