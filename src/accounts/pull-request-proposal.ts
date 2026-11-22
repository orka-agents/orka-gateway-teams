import { createHash } from 'node:crypto';
import { canonicalJSON, validateScope } from '../directory/codec.js';
import { identity, validateRoute } from '../ingress/codec.js';
import { integer, object } from '../storage/table/codec.js';
import type { ReplyRoute } from '../ingress/types.js';
import { grantRef, operationKey } from './grants.js';

export interface ProposalOrigin { conversationId: string; replyTarget: string; route: ReplyRoute; senderMRI: string;
  objectId: string; displayName: string; activityId: string }
export interface ProposalFacts { headSHA: string; baseSHA: string; githubId: string; githubLogin: string; commits: number;
  files: { path: string; additions: number; deletions: number }[]; fileCount: number; additions: number; deletions: number; filesComplete: boolean }
export interface ClaimEvidence { decision: 'approve' | 'reject' | 'revise'; tenantId: string; objectId: string; invokeActivityId: string;
  decidedAt: number; note?: string; revisionReplyTarget?: string }
export type RevisionAdmission = 'pending' | 'delivered' | 'full' | 'signin-required' | 'conflict';
export type ProposalResult = { kind: 'opened'; number: number; url: string; headSHA: string; existing?: true };
/** `closed` is the pull request GitHub opened at a commit that wasn't approved, which the gateway then closed. */
export type ProposalOutcome = ProposalResult | { kind: 'branch-moved'; closed?: number } | { kind: 'permission' | 'signin-required' | 'validation' | 'failed' | 'uncertain' };
export interface Proposal extends ProposalOrigin, ProposalFacts {
  id: string; revision: 1; state: 'pending' | 'approving' | 'opened' | 'rejected' | 'revise-requested' | 'superseded' | 'expired' | 'branch-moved' | 'failed' | 'uncertain';
  appId: string; tenantId: string; generation: number; githubGeneration: number; targetId: string; targetDigest: string; grantRef: string; taskUID: string;
  owner: string; repo: string; base: string; head: string; title: string; body: string; createdAt: number; expiresAt: number; payloadDigest: string;
  claim?: ClaimEvidence; revisionAdmission?: RevisionAdmission; cardActivityId?: string; prNumber?: number; prUrl?: string; outcome?: ProposalOutcome;
}
export interface ProposalVersion { proposal: Proposal; etag: string; needsProjection?: true }
export interface ProposalSelector { id: string; objectId: string; generation: number; proposalId: string; revision: 1;
  state: 'pending' | 'claimed'; claim?: ClaimEvidence }
export const proposalHash = (v: unknown) => createHash('sha256').update(canonicalJSON(v)).digest('hex');
export const proposalIdentity = (ref: string, taskUID: string, operation: string) =>
  proposalHash(['teams-pr-proposal-v1', grantRef(ref), identity(taskUID), 'github-propose-pull-request', operationKey(operation)]);
export const proposalSelectorId = (p: Proposal) => proposalHash(['teams-pr-selector-v1', p.appId, p.tenantId, p.conversationId, p.objectId]);
export const proposalArgs = (p: Proposal) => ({ owner: p.owner, repo: p.repo, base: p.base, head: p.head, title: p.title, body: p.body });
// Check decoded display strings too: JSON escaping must not hide a configured credential.
export const proposalOutput = (p: Proposal) => JSON.stringify(p) + '\n' +
  [p.title, p.body, p.claim?.note ?? '', p.displayName, p.githubLogin, p.owner, p.repo, p.base, p.head, ...p.files.map(f => f.path)].join('\n');
export function proposalDigest(p: Proposal): string {
  const { payloadDigest: _digest, state: _state, claim: _claim, cardActivityId: _card, prNumber: _number, prUrl: _url, outcome: _outcome, revisionAdmission: _admission, ...frozen } = p;
  return proposalHash(frozen);
}
const originKeys = ['conversationId', 'replyTarget', 'route', 'senderMRI', 'objectId', 'displayName', 'activityId'];
function text(v: unknown, max = 4096): string {
  if (typeof v !== 'string' || Buffer.byteLength(v) > max || /[\uD800-\uDFFF]/u.test(v)) throw new Error('Invalid proposal'); return v;
}
export function proposalOrigin(input: unknown): ProposalOrigin {
  const v = object(input, originKeys); const route = validateRoute(v.route);
  for (const k of originKeys.filter(k => !['route', 'displayName'].includes(k))) identity(v[k]); text(v.displayName, 1024);
  if (route.conversation.id !== v.conversationId || route.conversation.conversationType === 'channel') throw new Error('Invalid proposal origin');
  return { ...v, route } as unknown as ProposalOrigin;
}
export function claimEvidence(input: unknown): ClaimEvidence {
  const v = object(input, ['decision', 'tenantId', 'objectId', 'invokeActivityId', 'decidedAt', 'note', 'revisionReplyTarget']);
  if (!['approve', 'reject', 'revise'].includes(String(v.decision))) throw new Error('Invalid claim');
  identity(v.tenantId); identity(v.objectId); identity(v.invokeActivityId); integer(v.decidedAt, 1, Number.MAX_SAFE_INTEGER);
  if (v.decision === 'revise') { if (!text(v.note, 8000).trim() || Array.from(v.note as string).length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(v.note as string)) throw new Error('Invalid claim'); identity(v.revisionReplyTarget); }
  else if (v.note !== undefined || v.revisionReplyTarget !== undefined) throw new Error('Invalid claim');
  return v as unknown as ClaimEvidence;
}
export function decodeSelector(input: unknown): ProposalSelector {
  const v = object(input, ['id', 'objectId', 'generation', 'proposalId', 'revision', 'state', 'claim']);
  grantRef(v.id); grantRef(v.proposalId); identity(v.objectId); integer(v.generation, 1, Number.MAX_SAFE_INTEGER);
  if (v.revision !== 1 || !['pending', 'claimed'].includes(String(v.state))) throw new Error('Invalid selector');
  if (v.state === 'claimed') claimEvidence(v.claim); else if (v.claim !== undefined) throw new Error('Invalid selector');
  return v as unknown as ProposalSelector;
}
export function decodeProposal(input: unknown): Proposal {
  const v = object(input, [...originKeys, 'id', 'revision', 'state', 'appId', 'tenantId', 'generation', 'githubGeneration', 'targetId', 'targetDigest',
    'grantRef', 'taskUID', 'owner', 'repo', 'base', 'head', 'title', 'body', 'headSHA', 'baseSHA', 'githubId', 'githubLogin', 'commits', 'files',
    'fileCount', 'additions', 'deletions', 'filesComplete', 'createdAt', 'expiresAt', 'payloadDigest', 'claim', 'revisionAdmission', 'cardActivityId', 'prNumber', 'prUrl', 'outcome']);
  proposalOrigin(Object.fromEntries(originKeys.map(k => [k, v[k]]))); validateScope({ appId: v.appId, tenantId: v.tenantId });
  for (const k of ['id', 'targetDigest', 'grantRef', 'payloadDigest']) grantRef(v[k]);
  for (const k of ['targetId', 'taskUID']) identity(v[k]);
  for (const k of ['generation', 'githubGeneration', 'createdAt', 'expiresAt', 'commits']) integer(v[k], 1, Number.MAX_SAFE_INTEGER);
  for (const k of ['fileCount', 'additions', 'deletions']) integer(v[k], 0, Number.MAX_SAFE_INTEGER);
  for (const k of ['owner', 'repo', 'base', 'head', 'title']) if (!text(v[k], 256).trim()) throw new Error('Invalid proposal'); text(v.body, 16384);
  if (typeof v.githubId !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(v.githubId) || !/^[A-Za-z0-9-]{1,39}$/u.test(text(v.githubLogin)) ||
    !/^[a-f0-9]{40}$/u.test(text(v.headSHA)) || !/^[a-f0-9]{40}$/u.test(text(v.baseSHA))) throw new Error('Invalid comparison');
  if (!Array.isArray(v.files) || v.files.length > 10 || typeof v.filesComplete !== 'boolean') throw new Error('Invalid files');
  for (const file of v.files) { const f = object(file, ['path', 'additions', 'deletions']); text(f.path); integer(f.additions, 0, Number.MAX_SAFE_INTEGER); integer(f.deletions, 0, Number.MAX_SAFE_INTEGER); }
  const p = v as unknown as Proposal;
  if (p.revision !== 1 || !['pending', 'approving', 'opened', 'rejected', 'revise-requested', 'superseded', 'expired', 'branch-moved', 'failed', 'uncertain'].includes(p.state) ||
    p.expiresAt !== p.createdAt + 3_600_000 || p.route.conversation.tenantId !== p.tenantId || proposalDigest(p) !== p.payloadDigest) throw new Error('Invalid proposal');
  if (p.claim !== undefined) claimEvidence(p.claim);
  if (p.revisionAdmission !== undefined && (p.state !== 'revise-requested' || p.claim?.decision !== 'revise' ||
    !['pending', 'delivered', 'full', 'signin-required', 'conflict'].includes(p.revisionAdmission))) throw new Error('Invalid revision admission');
  if (p.cardActivityId !== undefined) identity(p.cardActivityId);
  if (p.prNumber !== undefined) integer(p.prNumber, 1, Number.MAX_SAFE_INTEGER); if (p.prUrl !== undefined) text(p.prUrl);
  if (p.outcome !== undefined) proposalOutcome(p, p.outcome);
  return p;
}
export function proposalOutcome(p: Pick<Proposal, 'owner' | 'repo'>, input: unknown): ProposalOutcome {
  const v = object(input, ['kind', 'number', 'url', 'headSHA', 'existing', 'closed']);
  if (v.kind === 'opened') {
    integer(v.number, 1, Number.MAX_SAFE_INTEGER);
    if (v.closed !== undefined || v.url !== `https://github.com/${p.owner}/${p.repo}/pull/${v.number}` || typeof v.headSHA !== 'string' || !/^[a-f0-9]{40}$/u.test(v.headSHA) || v.existing !== undefined && v.existing !== true) throw new Error('Invalid result');
  } else if (v.kind === 'branch-moved' && v.closed !== undefined) { integer(v.closed, 1, Number.MAX_SAFE_INTEGER); if (Object.keys(v).length !== 2) throw new Error('Invalid outcome');
  } else if (!['branch-moved', 'permission', 'signin-required', 'validation', 'failed', 'uncertain'].includes(String(v.kind)) || Object.keys(v).length !== 1) throw new Error('Invalid outcome');
  return v as unknown as ProposalOutcome;
}
export function projectClaim(p: Proposal, claim: ClaimEvidence): Proposal {
  return { ...p, claim, ...(claim.decision === 'revise' ? { revisionAdmission: 'pending' as const } : {}), state: claim.decision === 'approve' ? 'approving' : claim.decision === 'reject' ? 'rejected' : 'revise-requested' };
}
