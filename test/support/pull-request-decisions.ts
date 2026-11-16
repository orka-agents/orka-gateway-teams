import type { TestContext } from 'node:test';
import { createAccountStore } from '../../src/accounts/store.js';
import { createGitHub } from '../../src/accounts/github.js';
import { createPullRequestService } from '../../src/accounts/pull-request-service.js';
import { proposalDigest } from '../../src/accounts/pull-request-proposal.js';
import type { Proposal } from '../../src/accounts/pull-request-proposal.js';
import { grantsFixture } from './task-grants.js';
import { toolsFixture } from './github-tools.js';
import { proposalFixture } from './pull-request-proposal.js';
import { binding, context, eventually } from './directory-table.js';
export async function decisionsFixture(t: TestContext) {
  const f = await grantsFixture(t); const remote = await toolsFixture(t);
  const gh = createAccountStore(binding, Buffer.alloc(32, 7), f.dependencies, f.authority, f.now, 'github'); t.after(() => gh.close());
  const ch = await gh.challenge(f.subject, 'chat-private', 'github', context()); await gh.claim(ch, context());
  await gh.complete(ch, { accessToken: 'GH_PRIVATE', refreshToken: 'GH_REFRESH_PRIVATE', providerUserId: '123', expiresAt: f.now() + 10000000, refreshExpiresAt: f.now() + 20000000 }, context());
  const github = createGitHub({ clientId: 'client', clientSecret: 'CLIENT_PRIVATE', publicOrigin: 'https://signin.example.invalid' }, { request: remote.request }); t.after(() => github.close());
  let connected = true; const replies: Proposal[] = [];
  const result = (sha = 'a'.repeat(40)) => ({ number: 12, html_url: 'https://github.com/example/project/pull/12', head: { ref: 'orka/fix', sha, repo: { full_name: 'example/project' } }, base: { ref: 'main', repo: { full_name: 'example/project' } } });
  remote.behavior((req, res) => {
    if (req.path === '/user') return void res.end('{"id":123,"login":"sender"}');
    if (req.path.includes('/git/ref/heads/')) return void res.end(JSON.stringify({ ref: 'refs/heads/orka/fix', object: { type: 'commit', sha: 'a'.repeat(40) } }));
    if (req.method === 'GET') return void res.end('[]');
    res.statusCode = 201; res.end(JSON.stringify(result()));
  });
  const make = (store = f.store) => {
    const service = createPullRequestService({ accounts: store, githubAccounts: gh, github, scope: binding, now: f.now,
      postProposal: async () => 'delivered', decisions: { authority: f.authority, connected: async () => connected,
        postDecision: async p => { replies.push(structuredClone(p)); } } });
    t.after(() => service.close()); return service;
  };
  const service = make(); const p = proposalFixture(); await f.store.reserveProposal(p, 'operation', context());
  const ctx = () => ({ ...context(), subject: { tenantId: p.tenantId, objectId: p.objectId, chatKind: 'personal' as const } });
  const decide = (decision: 'approve' | 'reject' = 'approve', current = p, supplied = ctx()) => service.decide(current, decision, 'invoke', supplied);
  const settled = async () => { await eventually(() => replies.length > 0); return (await f.store.getProposal(p.id, context()))!.proposal; };
  return { ...f, ...remote, gh, github, service, make, p, ctx, decide, settled, replies, result,
    connected: (v: boolean) => { connected = v; }, redigest: (p: Proposal) => { p.payloadDigest = proposalDigest(p); return p; } };
}
