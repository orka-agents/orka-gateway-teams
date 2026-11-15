import { proposalDigest, proposalIdentity } from '../../src/accounts/pull-request-proposal.js';
import type { Proposal } from '../../src/accounts/pull-request-proposal.js';
import { binding } from './directory-table.js';
export function proposalFixture(operation = 'operation'): Proposal {
  const p: Proposal = { id: '', revision: 1, state: 'pending', appId: binding.appId, tenantId: binding.tenantId, objectId: 'sender-private', generation: 1,
    conversationId: 'chat-private', senderMRI: '29:sender-private', displayName: 'Example Sender', activityId: 'activity-private', replyTarget: 'reply-private',
    route: { serviceUrl: 'https://teams-service.example.invalid/', channelId: 'msteams', bot: { id: 'bot', role: 'bot' },
      conversation: { id: 'chat-private', tenantId: binding.tenantId, conversationType: 'personal' } },
    targetId: 'tools', targetDigest: 'a'.repeat(64), grantRef: 'c'.repeat(64), taskUID: 'task-private', githubGeneration: 2,
    owner: 'example', repo: 'project', base: 'main', head: 'orka/fix', headSHA: 'a'.repeat(40), baseSHA: 'b'.repeat(40),
    title: 'Retry the lease read', body: 'Agent-written description', githubId: '123', githubLogin: 'example-sender',
    commits: 1, fileCount: 1, additions: 3, deletions: 1, filesComplete: true, files: [{ path: 'src/lease.ts', additions: 3, deletions: 1 }],
    createdAt: 1_800_000_000_000, expiresAt: 1_800_003_600_000, payloadDigest: '' };
  p.id = proposalIdentity(p.grantRef, p.taskUID, operation); p.payloadDigest = proposalDigest(p); return p;
}
