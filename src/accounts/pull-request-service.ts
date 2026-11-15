import type { DirectoryContext, DirectoryScope } from '../directory/types.js';
import type { AccountStore } from './store.js';
import { AccountError } from './store.js';
import type { TaskGrant } from './grants.js';
import type { createGitHub } from './github.js';
import { githubArguments, GitHubError } from './github.js';
import { proposalIdentity, proposalDigest, proposalArgs } from './pull-request-proposal.js';
import type { Proposal } from './pull-request-proposal.js';
import { canonicalJSON } from '../directory/codec.js';

export function createPullRequestService(options: { accounts: AccountStore; githubAccounts: AccountStore;
  github: Pick<ReturnType<typeof createGitHub>, 'readProposalFacts'>; scope: DirectoryScope; now?: () => number;
  postProposal(proposal: Proposal, ctx: DirectoryContext): Promise<'delivered' | 'uncertain' | 'unavailable'> }) {
  const now = options.now ?? Date.now;
  return {
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
        if (!await safeOutput(JSON.stringify(p))) throw new GitHubError();
      }
      if (!await safeOutput(JSON.stringify(p))) throw new GitHubError();
      p = await options.accounts.reserveProposal({ ...p, state: 'pending' }, operation, ctx);
      if (p.state !== 'pending') return { text: 'This approval request is no longer pending. Ask again for a new card.' };
      const sent = await options.postProposal(p, ctx);
      if (sent === 'unavailable') throw new GitHubError();
      return { text: sent === 'delivered' ? 'Approval card sent to the requester.' :
        'The approval request is saved, but I could not confirm the card arrived. Check this conversation before asking again.' };
    },
  };
}
