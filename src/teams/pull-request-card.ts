import type { CardElement, IAdaptiveCard, ITextBlock } from '@microsoft/teams.cards';
import type { Proposal, RevisionAdmission } from '../accounts/pull-request-proposal.js';
import { object } from '../storage/table/codec.js';
import { MAX_OUTGOING_MESSAGE_BYTES } from './format.js';

function boundedLabel(s: string, max: number): { text: string; truncated: boolean } {
  const points = Array.from(s);
  const escaped = (n: number) => points.slice(0, n).join('').replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/gu, '\\$1');
  // Budget the escaped JSON bytes, without splitting a Unicode point or an escape sequence.
  let low = 0; let high = Math.min(points.length, max);
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(escaped(mid))) <= max) low = mid; else high = mid - 1; }
  return { text: escaped(low) + (low < points.length ? '…' : ''), truncated: low < points.length };
}
const label = (s: string, max: number) => boundedLabel(s, max).text;
const line = (text: string, style: Partial<ITextBlock> = {}): ITextBlock => ({ type: 'TextBlock', text, wrap: true, ...style });
const caption = (text: string): ITextBlock => line(text, { isSubtle: true, size: 'Small', spacing: 'None' });
// A path part that also cannot close the Markdown link it sits in.
const part = (s: string) => encodeURIComponent(s).replace(/[!'()*~]/gu, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const LINK_EXPIRED = 'Your account link expired. Sign in, then ask the agent again for a new card.';

interface Status { head: string; fallback?: string; alert?: true; detail?: string; note?: string; open?: true }
function revisionStatus(admission: RevisionAdmission | undefined): Status {
  return admission === 'delivered' ? { head: 'Changes requested. Sent to the agent.' } :
    admission === 'signin-required' ? { head: 'Changes not sent. Sign in, then send them again.', alert: true } :
      admission === 'conflict' ? { head: 'Changes not sent. Reply in the chat with what to change.', alert: true } : { head: 'Sending your changes…' };
}
function status(p: Proposal, viewer: 'room' | 'sender', decisionsEnabled: boolean): Status {
  const who = label(p.displayName, 80); const o = p.outcome; const again = 'Ask the agent again for a new card.';
  if (p.state === 'pending') return { open: true, ...(decisionsEnabled ? {} : { detail: "Approval isn't turned on for this chat yet." }),
    ...(viewer === 'room' ? { head: `Waiting for ${who} to approve`, fallback: 'Waiting for approval' } : { head: decisionsEnabled ? 'Open this pull request?' : 'Pull request waiting' }) };
  if (p.state === 'approving') return { head: 'Approved. Opening the pull request…' };
  if (o?.kind === 'opened' && o.headSHA === p.headSHA) return { head: `${o.existing ? 'Already open: ' : 'Opened '}#${o.number}` };
  // Reached only when the gateway couldn't close it, or found it after losing track of its own request.
  if (o?.kind === 'opened') return { head: `${o.existing ? 'Open: ' : 'Opened '}#${o.number} with changes you didn't approve`, alert: true,
    detail: 'The branch changed after you approved. Review the pull request before it merges.',
    note: `Approved ${p.headSHA.slice(0, 7)} · pull request is at ${o.headSHA.slice(0, 7)}` };
  if (p.state === 'rejected') return viewer === 'sender' ? { head: 'Not opened. You rejected it.' } : { head: `Not opened. ${who} rejected it.`, fallback: 'Not opened. Rejected.' };
  // The rest of the chat sees the note only once it has been sent on as a chat turn.
  if (p.state === 'revise-requested') return { ...revisionStatus(p.revisionAdmission), ...(viewer === 'sender' || p.revisionAdmission === 'delivered' ?
    { detail: `${viewer === 'sender' ? 'Your note' : `Note from ${who}`}: "${label(p.claim?.note ?? '', 2400)}"` } : {}) };
  if (p.state === 'expired') return { head: 'Expired. Nothing was opened.', detail: again };
  if (p.state === 'superseded') return { head: 'Replaced by a newer card.' };
  if (p.state === 'uncertain') return { head: "Couldn't confirm the pull request opened", alert: true,
    detail: `Check [the branch](https://github.com/${part(p.owner)}/${part(p.repo)}/tree/${part(p.head)}) on GitHub before asking again.` };
  // The sender's own card in a one-to-one chat carries an "Ask again" button in place of the instruction.
  const reason = o?.kind === 'branch-moved' ? `The branch changed after you approved.${o.closed ? ` GitHub opened #${o.closed} at the new commit, so it was closed.` : ''}${askAgain(p, viewer) ? '' : ' Ask Orka again.'}` :
    o?.kind === 'permission' ? `This GitHub account can't open pull requests in ${label(p.owner, 100)}/${label(p.repo, 100)}.` :
      o?.kind === 'signin-required' ? LINK_EXPIRED :
        o?.kind === 'validation' ? `GitHub rejected the pull request details. ${again}` : o?.kind === 'failed' ? again : undefined;
  return reason ? { head: 'Not opened', alert: true, detail: reason } : { head: 'This request is no longer pending.' };
}
/** The chat message "Ask again" sends as the sender, or nothing where a button can't send one: a group chat only hears messages that mention the bot. */
function askAgain(p: Proposal, viewer: 'room' | 'sender'): string | undefined {
  if (viewer !== 'sender' || p.outcome?.kind !== 'branch-moved' || p.route.conversation.conversationType !== 'personal') return undefined;
  return `Send a new approval card for the pull request${/^[A-Za-z0-9._\/-]{1,100}$/u.test(p.head) ? ` from ${p.head}` : ''}. The branch changed after I approved.`;
}
/** Only the server-verified sender receives decision actions; invokes still recheck authority. */
export function buildPullRequestCard(p: Proposal, viewer: 'room' | 'sender', decisionsEnabled: boolean): IAdaptiveCard {
  const s = status(p, viewer, decisionsEnabled); const again = askAgain(p, viewer); const data = { proposal: p.id, rev: p.revision, digest: p.payloadDigest };
  const compare = `https://github.com/${part(p.owner)}/${part(p.repo)}/compare/${p.baseSHA}...${p.headSHA}`;
  const preview = p.body ? boundedLabel(p.body, 280) : { text: 'No description.', truncated: false }; const expanded = boundedLabel(p.body, 1800);
  const files = [...p.files].sort((a, b) => b.additions + b.deletions - a.additions - a.deletions).slice(0, 5);
  // The viewer's Teams client turns TIME into its own local time. Agent text cannot: its braces are escaped.
  const expires = `Expires at {{TIME(${new Date(p.expiresAt).toISOString().slice(0, 19)}Z)}}`;
  const body: CardElement[] = [caption(`Pull request · ${label(p.owner, 100)}/${label(p.repo, 100)}`),
    line(s.head, { weight: 'Bolder', size: 'Medium', spacing: 'Small', ...(s.alert ? { color: 'Attention' } : {}) }),
    ...(s.detail ? [line(s.detail, { spacing: 'Small' })] : []), ...(s.note ? [line(s.note, { isSubtle: true, size: 'Small', spacing: 'Small' })] : []),
    ...(s.open ? [line(`${expires} · ${viewer === 'sender' ? `opens as @${label(p.githubLogin, 39)}` : `asked by ${label(p.displayName, 80)}`}`, { isSubtle: true, size: 'Small', spacing: 'Small' })] : []),
    // Everything the agent wrote sits in this one tinted box, under its caption.
    { type: 'Container', style: 'emphasis', spacing: 'Medium', items: [caption('Written by the agent'), line(label(p.title, 180), { weight: 'Bolder', spacing: 'Small' }),
      ...(s.open ? [line(preview.text, { spacing: 'Small' })] : []),
      ...(s.open && preview.truncated ? [{ type: 'ActionSet' as const, spacing: 'Small' as const, actions: [{ type: 'Action.ShowCard' as const, title: 'Show more',
        card: { type: 'AdaptiveCard' as const, version: '1.5' as const, body: [caption('Written by the agent'), line(expanded.text, { spacing: 'Small' }),
          ...(expanded.truncated ? [caption('Shortened to fit this card.')] : [])] } }] }] : [])] },
    ...(s.open ? [line(`${label(p.head, 180)} → ${label(p.base, 180)}`, { fontType: 'Monospace', size: 'Small', spacing: 'Medium' }),
      line(`**${p.fileCount}${p.filesComplete ? '' : '+'} ${p.fileCount === 1 && p.filesComplete ? 'file' : 'files'}** · +${p.additions} −${p.deletions} · ${p.commits} ${p.commits === 1 ? 'commit' : 'commits'} · [View changes](${compare})`, { spacing: 'Small' }),
      ...(p.filesComplete ? [] : [line('GitHub returned only part of the file list. Check the full diff before approving.', { color: 'Attention', size: 'Small', spacing: 'Small' })]),
      ...files.map((f, i): CardElement => ({ type: 'ColumnSet', spacing: i ? 'None' : 'Small', columns: [
        { type: 'Column', width: 'stretch', items: [line(label(f.path, 100), { fontType: 'Monospace', size: 'Small' })] },
        { type: 'Column', width: 'auto', items: [line(`+${f.additions} −${f.deletions}`, { isSubtle: true, size: 'Small' })] }] })),
      ...(p.fileCount > files.length ? [caption(`and ${p.fileCount - files.length} more`)] : [])] : [])];
  return { type: 'AdaptiveCard', version: '1.5', fallbackText: `Pull request: ${s.fallback ?? s.head}`, body,
    refresh: { action: { type: 'Action.Execute', verb: 'pr-refresh', data }, userIds: [p.senderMRI] },
    actions: [...(decisionsEnabled && viewer === 'sender' && p.state === 'pending' ? [
      { type: 'Action.Execute' as const, title: 'Approve', style: 'positive' as const, verb: 'pr-approve', data },
      { type: 'Action.ShowCard' as const, title: 'Revise', card: { type: 'AdaptiveCard' as const, version: '1.5' as const,
        body: [{ type: 'Input.Text' as const, id: 'note', isMultiline: true, maxLength: 2000, placeholder: 'What should change?' }],
        actions: [{ type: 'Action.Execute' as const, title: 'Send', verb: 'pr-revise', data }] } },
      { type: 'Action.Execute' as const, title: 'Reject', verb: 'pr-reject', data }] : []),
      ...(again ? [{ type: 'Action.Submit' as const, title: 'Ask again', data: { msteams: { type: 'imBack' as const, value: again } } }] : []),
      ...(p.outcome?.kind === 'opened' ? [{ type: 'Action.OpenUrl' as const, title: 'Open pull request', url: p.outcome.url }] :
        s.open || p.state === 'superseded' ? [] : [{ type: 'Action.OpenUrl' as const, title: 'View changes', url: compare }])] };
}
/** A fixed notice for a card whose account link changed. It copies no proposal or account text. */
export function pullRequestNotice(kind: 'signin-expired' | RevisionAdmission | undefined): IAdaptiveCard {
  const s: Status = kind === 'signin-expired' ? { head: 'Not opened', detail: LINK_EXPIRED } : { ...revisionStatus(kind), detail: 'Details are hidden because you signed in again.' };
  return { type: 'AdaptiveCard', version: '1.5', fallbackText: `Pull request: ${s.head}`, body: [caption('Pull request'),
    line(s.head, { weight: 'Bolder', size: 'Medium', spacing: 'Small', ...(s.alert ? { color: 'Attention' } : {}) }), line(s.detail!, { spacing: 'Small' })] };
}
/** Closed projection: SDK/arbitrary card properties cannot become an HTTP invoke response. */
export function cardInvokeResponse(input: unknown): { statusCode: 200; type: 'application/vnd.microsoft.card.adaptive'; value: IAdaptiveCard } | undefined {
  try {
    if (!input || typeof input !== 'object' || !('statusCode' in input) || input.statusCode !== 200 || !('type' in input) ||
      input.type !== 'application/vnd.microsoft.card.adaptive' || !('value' in input)) return undefined;
    if (Buffer.byteLength(JSON.stringify(input.value)) > MAX_OUTGOING_MESSAGE_BYTES) return undefined;
    const card = JSON.parse(JSON.stringify(input.value)) as unknown;
    const string = (s: unknown) => { if (typeof s !== 'string' || Buffer.byteLength(s) > MAX_OUTGOING_MESSAGE_BYTES) throw new Error(); };
    const only = (value: unknown, ...allowed: unknown[]) => { if (value !== undefined && !allowed.includes(value)) throw new Error(); };
    const list = (value: unknown, max: number, min = 0): unknown[] => { if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(); return value; };
    const text = (input: unknown) => { const t = object(input, ['type', 'text', 'wrap', 'weight', 'size', 'isSubtle', 'color', 'fontType', 'spacing']);
      if (t.type !== 'TextBlock' || t.wrap !== true) throw new Error(); string(t.text);
      only(t.weight, 'Bolder'); only(t.size, 'Medium', 'Small'); only(t.isSubtle, true); only(t.color, 'Attention'); only(t.fontType, 'Monospace'); only(t.spacing, 'None', 'Small', 'Medium'); };
    // The agent's box: text, then at most one "Show more" that opens text only.
    const container = (input: unknown) => { const c = object(input, ['type', 'style', 'spacing', 'items']);
      if (c.style !== 'emphasis' || c.spacing !== 'Medium') throw new Error();
      list(c.items, 4, 1).forEach((item, i, items) => { if (!item || typeof item !== 'object' || !('type' in item) || item.type !== 'ActionSet') return text(item);
        const s = object(item, ['type', 'spacing', 'actions']); const a = object(list(s.actions, 1, 1)[0], ['type', 'title', 'card']);
        if (i !== items.length - 1 || s.spacing !== 'Small' || a.type !== 'Action.ShowCard' || a.title !== 'Show more') throw new Error(); validate(a.card, true); }); };
    // One file: its path, then its line counts.
    const columns = (input: unknown) => { const s = object(input, ['type', 'spacing', 'columns']); only(s.spacing, 'None', 'Small');
      list(s.columns, 2, 2).forEach((column, i) => { const c = object(column, ['type', 'width', 'items']);
        if (c.type !== 'Column' || c.width !== (i ? 'auto' : 'stretch')) throw new Error(); text(list(c.items, 1, 1)[0]); }); };
    const validate = (input: unknown, nested = false, revision = false) => {
      const c = object(input, ['type', 'version', 'fallbackText', 'body', 'actions', 'refresh']);
      if (c.type !== 'AdaptiveCard' || c.version !== '1.5' || !Array.isArray(c.body) || c.body.length > 32) throw new Error();
      if (c.fallbackText !== undefined) string(c.fallbackText);
      if (revision) {
        if (c.body.length !== 1 || !Array.isArray(c.actions) || c.actions.length !== 1) throw new Error();
        const t = object(c.body[0], ['type', 'id', 'isMultiline', 'maxLength', 'placeholder']);
        if (t.type !== 'Input.Text' || t.id !== 'note' || t.isMultiline !== true || t.maxLength !== 2000 || t.placeholder !== 'What should change?') throw new Error();
      }
      let boxes = 0;
      for (const b of revision ? [] : c.body) { const type = b && typeof b === 'object' && 'type' in b ? b.type : undefined;
        if (!nested && type === 'Container' && !boxes++) container(b); else if (!nested && type === 'ColumnSet') columns(b); else text(b); }
      if (c.actions !== undefined) {
        if (nested && !revision || !Array.isArray(c.actions) || c.actions.length > (revision ? 1 : 5)) throw new Error();
        for (const a of c.actions) { const v = object(a, ['type', 'title', ...(a.type === 'Action.ShowCard' ? ['card'] : a.type === 'Action.Execute' ? ['verb', 'data', ...(a.verb === 'pr-approve' ? ['style'] : [])] : a.type === 'Action.Submit' ? ['data'] : ['url'])]); string(v.title);
          if (v.type === 'Action.Submit') {
            // "Ask again" may only post a chat message as the person who pressed it.
            const m = object(object(v.data, ['msteams']).msteams, ['type', 'value']);
            if (nested || v.title !== 'Ask again' || m.type !== 'imBack' || typeof m.value !== 'string' || !m.value || m.value.length > 300) throw new Error();
          } else if (v.type === 'Action.Execute') {
            const d = object(v.data, ['proposal', 'rev', 'digest']); only(v.style, 'positive');
            if (!(revision ? v.verb === 'pr-revise' && v.title === 'Send' : ['pr-approve', 'pr-reject'].includes(String(v.verb))) || d.rev !== 1 || !/^[a-f0-9]{64}$/u.test(String(d.proposal)) || !/^[a-f0-9]{64}$/u.test(String(d.digest))) throw new Error();
          } else if (!nested && v.type === 'Action.ShowCard' && v.title === 'Revise') validate(v.card, true, true);
          else if (nested || v.type !== 'Action.OpenUrl' || typeof v.url !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9%_.-]+\/[A-Za-z0-9%_.-]+\/(?:compare\/[A-Za-z0-9%_.-]+\.\.\.[a-f0-9]{40}|pull\/[1-9][0-9]*)$/u.test(v.url)) throw new Error(); }
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
