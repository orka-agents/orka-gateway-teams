import type { IAdaptiveCard, ITextBlock } from '@microsoft/teams.cards';
import type { Proposal } from '../accounts/pull-request-proposal.js';
import { object } from '../storage/table/codec.js';
import { MAX_OUTGOING_MESSAGE_BYTES } from './format.js';

function boundedLabel(s: string, max: number): { text: string; truncated: boolean } {
  const points = Array.from(s);
  const escaped = (n: number) => points.slice(0, n).join('').replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/gu, '\\$1');
  // Budget the escaped JSON bytes, without splitting a Unicode point or an escape sequence.
  let low = 0; let high = Math.min(points.length, max);
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(escaped(mid))) <= max) low = mid; else high = mid - 1; }
  return { text: escaped(low) + (low < points.length ? '… (truncated)' : ''), truncated: low < points.length };
}
const label = (s: string, max: number) => boundedLabel(s, max).text;
/** Preview only. Decision actions are deliberately absent until the decision handler ships. */
export function buildPullRequestCard(p: Proposal, viewer: 'room' | 'sender', _decisionsEnabled: boolean): IAdaptiveCard {
  const block = (text: string, heading = false): ITextBlock => ({ type: 'TextBlock', text, wrap: true, ...(heading ? { weight: 'Bolder', size: 'Medium' } : {}) });
  const state = p.state === 'expired' ? 'Expired. Ask again to get a new card.' : p.state === 'superseded' ? 'Replaced by a newer request.' :
    p.state === 'pending' ? viewer === 'sender' ? 'Approval actions are not enabled yet.' : `Waiting for ${label(p.displayName, 80)} to approve. Approval actions are not enabled yet.` : 'This request is no longer pending.';
  const preview = boundedLabel(p.body || 'No description supplied.', 240); const expanded = boundedLabel(p.body, 1800);
  const body: ITextBlock[] = [block('Pull request proposal', true), block(state),
    block(`Asked by ${label(p.displayName, 80)} · expires ${new Date(p.expiresAt).toISOString()}`),
    block(`Title (written by the agent): ${label(p.title, 180)}`, true), block(`${label(p.owner, 100)}/${label(p.repo, 100)}`),
    block(`${label(p.head, 180)} → ${label(p.base, 180)}`),
    block(`${p.commits} commit(s) · ${p.fileCount}${p.filesComplete ? '' : '+ returned'} files · +${p.additions} −${p.deletions} · head ${p.headSHA.slice(0, 7)}${p.filesComplete ? '' : ' (file list and line totals incomplete)'}`),
    ...p.files.map(f => block(`${label(f.path, 100)}  +${f.additions} −${f.deletions}`)),
    ...(p.fileCount > p.files.length ? [block(`+${p.fileCount - p.files.length} more${p.filesComplete ? '' : ' returned files'}`)] : []),
    block('Description (written by the agent)', true), block(preview.text),
    block(`Opens as you (@${label(p.githubLogin, 39)}) on GitHub. Merging stays with the repository's reviewers.`)];
  return { type: 'AdaptiveCard', version: '1.5', fallbackText: 'Pull request proposal. Approval actions are not enabled yet.', body,
    refresh: { action: { type: 'Action.Execute', verb: 'pr-refresh', data: { proposal: p.id, rev: p.revision, digest: p.payloadDigest } }, userIds: [p.senderMRI] },
    actions: [...(preview.truncated ? [{ type: 'Action.ShowCard' as const, title: expanded.truncated ? 'Show more description (truncated)' : 'Show full description',
      card: { type: 'AdaptiveCard' as const, version: '1.5' as const, body: [block(expanded.text)] } }] : []),
      { type: 'Action.OpenUrl', title: 'View changes', url: `https://github.com/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/compare/${p.baseSHA}...${p.headSHA}` }] };
}
/** Closed projection: SDK/arbitrary card properties cannot become an HTTP invoke response. */
export function cardInvokeResponse(input: unknown): { statusCode: 200; type: 'application/vnd.microsoft.card.adaptive'; value: IAdaptiveCard } | undefined {
  try {
    if (!input || typeof input !== 'object' || !('statusCode' in input) || input.statusCode !== 200 || !('type' in input) ||
      input.type !== 'application/vnd.microsoft.card.adaptive' || !('value' in input)) return undefined;
    if (Buffer.byteLength(JSON.stringify(input.value)) > MAX_OUTGOING_MESSAGE_BYTES) return undefined;
    const card = JSON.parse(JSON.stringify(input.value)) as unknown;
    const string = (s: unknown) => { if (typeof s !== 'string' || Buffer.byteLength(s) > MAX_OUTGOING_MESSAGE_BYTES) throw new Error(); };
    const validate = (input: unknown, nested = false) => {
      const c = object(input, ['type', 'version', 'fallbackText', 'body', 'actions', 'refresh']);
      if (c.type !== 'AdaptiveCard' || c.version !== '1.5' || !Array.isArray(c.body) || c.body.length > 32) throw new Error();
      if (c.fallbackText !== undefined) string(c.fallbackText);
      for (const b of c.body) { const t = object(b, ['type', 'text', 'wrap', 'weight', 'size']);
        if (t.type !== 'TextBlock' || t.wrap !== true || t.weight !== undefined && t.weight !== 'Bolder' || t.size !== undefined && t.size !== 'Medium') throw new Error(); string(t.text); }
      if (c.actions !== undefined) {
        if (nested || !Array.isArray(c.actions) || c.actions.length > 2) throw new Error();
        for (const a of c.actions) { const v = object(a, ['type', 'title', ...(a.type === 'Action.ShowCard' ? ['card'] : ['url'])]); string(v.title);
          if (v.type === 'Action.ShowCard') validate(v.card, true);
          else if (v.type !== 'Action.OpenUrl' || typeof v.url !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9%_.-]+\/[A-Za-z0-9%_.-]+\/compare\/[A-Za-z0-9%_.-]+\.\.\.[a-f0-9]{40}$/u.test(v.url)) throw new Error(); }
      }
      if (c.refresh !== undefined) {
        if (nested) throw new Error(); const r = object(c.refresh, ['action', 'userIds']); const a = object(r.action, ['type', 'verb', 'data']); const d = object(a.data, ['proposal', 'rev', 'digest']);
        if (a.type !== 'Action.Execute' || a.verb !== 'pr-refresh' || d.rev !== 1 || !/^[a-f0-9]{64}$/u.test(String(d.proposal)) || !/^[a-f0-9]{64}$/u.test(String(d.digest)) ||
          !Array.isArray(r.userIds) || r.userIds.length !== 1) throw new Error(); string(r.userIds[0]);
      }
    };
    validate(card); return { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card as IAdaptiveCard };
  } catch { return undefined; }
}
