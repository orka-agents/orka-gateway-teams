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
const LINK_EXPIRED = 'Your sign-in expired. Sign in again, then ask Orka for a new card.';
const AGAIN = 'Ask Orka again.';
const NEWER = 'Go to newer card';
const MESSAGE = /^https:\/\/teams\.microsoft\.com\/l\/message\/19:[A-Za-z0-9_-]{1,200}@(?:thread\.v2|unq\.gbl\.spaces)\/[0-9]{1,20}\?context=%7B%22contextType%22:%22chat%22%7D$/u;
/** A link to a message in the same chat, or nothing where Teams documents none: a one-to-one chat with a bot has no `19:` chat ID. */
function messageLink(chat: string, message: string | undefined): string | undefined {
  const url = `https://teams.microsoft.com/l/message/${chat}/${message}?context=%7B%22contextType%22:%22chat%22%7D`;
  return message !== undefined && MESSAGE.test(url) ? url : undefined;
}
/** The opening of the description: its first paragraph, cut at a sentence end to about four lines on a phone. */
function opening(body: string): string {
  const paragraphs = body.trim().split(/\n\s*\n/u).map(p => p.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  // A Markdown heading alone says nothing, so start at the text under it.
  const first = Array.from(paragraphs.find(p => !/^#{1,6} /u.test(p)) ?? paragraphs[0] ?? '');
  if (first.length <= 140) return first.join('');
  const cut = first.slice(0, 140).join(''); const sentence = Math.max(...['. ', '! ', '? '].map(end => cut.lastIndexOf(end)));
  const space = cut.lastIndexOf(' ');
  return sentence >= 40 ? cut.slice(0, sentence + 1) : `${space >= 40 ? cut.slice(0, space) : cut}…`;
}
/** A path that fits one line on a phone: whole folders are dropped from the left. */
function shortPath(path: string, max = 30): string {
  const points = Array.from(path); if (points.length <= max) return path;
  const parts = path.split('/'); let kept = parts.pop()!;
  while (parts.length && Array.from(`${parts.at(-1)}/${kept}`).length <= max - 2) kept = `${parts.pop()}/${kept}`;
  return Array.from(kept).length <= max - 2 ? `…/${kept}` : `…${points.slice(1 - max).join('')}`;
}

interface Status { head: string; fallback?: string; alert?: true; detail?: string; note?: string; open?: true }
function revisionStatus(admission: RevisionAdmission | undefined): Status {
  // After a sent note the agent may ask a question instead of proposing again, so a new card is not promised.
  return admission === 'delivered' ? { head: 'Changes requested', detail: 'Sent to Orka. It will reply in this chat with a new card or a question.' } :
    admission === 'signin-required' ? { head: 'Changes not sent', alert: true, detail: 'Your sign-in expired. Sign in, then send your note to Orka in the chat.' } :
      admission === 'conflict' ? { head: 'Changes not sent', alert: true, detail: "This card couldn't send your note. Send it to Orka in the chat instead." } : { head: 'Sending your changes…' };
}
function status(p: Proposal, viewer: 'room' | 'sender', decisionsEnabled: boolean): Status {
  const who = label(p.displayName, 80); const o = p.outcome;
  if (p.state === 'pending') return { open: true, ...(decisionsEnabled ? {} : { detail: "Approval isn't turned on for this chat yet." }),
    ...(viewer === 'room' ? { head: `Waiting for ${who} to approve`, fallback: 'Waiting for approval' } : { head: decisionsEnabled ? 'Open this pull request?' : 'Pull request waiting' }) };
  if (p.state === 'approving') return { head: 'Approved', detail: 'Opening the pull request…' };
  if (o?.kind === 'opened' && o.headSHA === p.headSHA) return { head: `${o.existing ? 'Already open as ' : 'Opened '}#${o.number}`, ...(o.existing ? { detail: 'Nothing new was opened.' } : {}) };
  // Reached only when the gateway couldn't close it, or found it, open or closed, after losing track of its own request.
  if (o?.kind === 'opened') return { head: o.existing ? `#${o.number} has changes you didn't approve` : `Opened #${o.number} with changes you didn't approve`, alert: true,
    detail: 'The branch changed after you approved. Review the pull request before it merges.',
    note: `Approved ${p.headSHA.slice(0, 7)} · pull request is at ${o.headSHA.slice(0, 7)}` };
  if (p.state === 'rejected') return { head: 'Not opened', fallback: 'Not opened. Rejected.', detail: viewer === 'sender' ? 'You rejected it.' : `${who} rejected it.` };
  if (p.state === 'revise-requested') { const s = revisionStatus(p.revisionAdmission);
    // The step is for the sender, who alone can take it.
    return viewer === 'sender' || p.revisionAdmission === 'delivered' ? s : { head: s.head, ...(s.alert ? { alert: s.alert } : {}) }; }
  if (p.state === 'expired') return { head: 'Expired', detail: `Nothing was opened. ${AGAIN}` };
  if (p.state === 'superseded') return { head: 'Replaced by a newer card.' };
  if (p.state === 'uncertain') return { head: "Couldn't confirm the pull request opened", alert: true,
    detail: `It may have opened. Look for it on GitHub before asking again${viewer === 'sender' ? ", so you don't get two" : ''}.` };
  // The sender's own card in a one-to-one chat carries an "Ask again" button in place of the instruction.
  const reason = o?.kind === 'branch-moved' ? `The branch changed after you approved.${o.closed ? ` GitHub opened #${o.closed} at the new commit, so it was closed.` : ''}${askAgain(p, viewer) ? '' : ` ${AGAIN}`}` :
    o?.kind === 'permission' ? `@${label(p.githubLogin, 39)} can't open pull requests in ${label(p.owner, 100)}/${label(p.repo, 100)}. Get access to the repository or link a different GitHub account, then ask again.` :
      o?.kind === 'signin-required' ? LINK_EXPIRED :
        o?.kind === 'validation' ? `GitHub rejected the pull request details. ${AGAIN}` :
          o?.kind === 'failed' ? `${o.cause === 'github' ? "GitHub didn't respond. Nothing was opened." : o.cause === 'gateway' ? 'Something went wrong on our side. Nothing was opened.' :
            'Something went wrong before the pull request could be opened.'} ${AGAIN}` : undefined;
  return reason ? { head: 'Not opened', alert: true, detail: reason } : { head: 'This request is no longer pending.' };
}
/** The chat message "Ask again" sends as the sender, or nothing where a button can't send one: a group chat only hears messages that mention the bot. */
function askAgain(p: Proposal, viewer: 'room' | 'sender'): string | undefined {
  if (viewer !== 'sender' || p.outcome?.kind !== 'branch-moved' || p.route.conversation.conversationType !== 'personal') return undefined;
  return `Send a new approval card for the pull request${/^[A-Za-z0-9._\/-]{1,100}$/u.test(p.head) ? ` from ${p.head}` : ''}. The branch changed after I approved.`;
}
const ASK_AGAIN = /^Send a new approval card for the pull request(?: from [A-Za-z0-9._\/-]{1,100})?\. The branch changed after I approved\.$/u;
/** Only the server-verified sender receives decision actions; invokes still recheck authority. `newerCard` is the message holding the card that replaced this one. */
export function buildPullRequestCard(p: Proposal, viewer: 'room' | 'sender', decisionsEnabled: boolean, newerCard?: string): IAdaptiveCard {
  const s = status(p, viewer, decisionsEnabled); const newer = p.state === 'superseded' ? messageLink(p.conversationId, newerCard) : undefined; const again = askAgain(p, viewer); const data = { proposal: p.id, rev: p.revision, digest: p.payloadDigest };
  const repository = `https://github.com/${part(p.owner)}/${part(p.repo)}`; const compare = `${repository}/compare/${p.baseSHA}...${p.headSHA}`;
  const start = opening(p.body); const preview = start ? boundedLabel(start, 280) : { text: 'No description.', truncated: false }; const expanded = boundedLabel(p.body, 1800);
  const more = preview.truncated || start !== p.body.trim();
  const files = [...p.files].sort((a, b) => b.additions + b.deletions - a.additions - a.deletions).slice(0, 5);
  const decide = decisionsEnabled && viewer === 'sender' && p.state === 'pending';
  // The rest of the chat sees the note only once it has been sent on as a chat turn.
  const note = p.state === 'revise-requested' && (viewer === 'sender' || p.revisionAdmission === 'delivered') ?
    [line(`${viewer === 'sender' ? 'Your note' : `Note from ${label(p.displayName, 80)}`}: "${label(p.claim?.note ?? '', 2400)}"`, { spacing: 'Small' })] : [];
  // The viewer's Teams client turns TIME into its own local time. Agent text cannot: its braces are escaped.
  const expires = `Expires at {{TIME(${new Date(p.expiresAt).toISOString().slice(0, 19)}Z)}}`;
  const body: CardElement[] = [caption(`Pull request · ${label(p.owner, 100)}/${label(p.repo, 100)}`),
    line(s.head, { weight: 'Bolder', size: 'Medium', spacing: 'Small', ...(s.alert ? { color: 'Attention' } : {}) }),
    // What the sender has not seen comes before anything else they read.
    ...(s.open && !p.filesComplete ? [line('GitHub returned only part of the file list. Check the full diff before approving.', { color: 'Attention', spacing: 'Small' })] : []),
    ...(s.detail ? [line(s.detail, { spacing: 'Small' })] : []), ...(s.note ? [line(s.note, { isSubtle: true, size: 'Small', spacing: 'Small' })] : []), ...note,
    ...(s.open ? [line(viewer === 'sender' ? expires : `${expires} · asked by ${label(p.displayName, 80)}`, { isSubtle: true, size: 'Small', spacing: 'Small' })] : []),
    // Everything the agent wrote sits in this one tinted box, under its caption.
    { type: 'Container', style: 'emphasis', spacing: 'Medium', items: [caption('Written by the agent'), line(label(p.title, 180), { weight: 'Bolder', spacing: 'Small' }),
      ...(s.open ? [line(preview.text, { spacing: 'Small' })] : [])] },
    // Under the box, not in it: a button inside a tinted box is drawn filled, and only Approve should be.
    ...(s.open && more ? [{ type: 'ActionSet' as const, spacing: 'Small' as const, actions: [{ type: 'Action.ShowCard' as const, title: 'Show full description',
      card: { type: 'AdaptiveCard' as const, version: '1.5' as const, body: [caption('Written by the agent'), line(expanded.text, { spacing: 'Small' }),
        ...(expanded.truncated ? [caption('Shortened to fit this card.')] : [])] } }] }] : []),
    ...(s.open ? [line(`${label(p.head, 180)} → ${label(p.base, 180)}`, { fontType: 'Monospace', size: 'Small', spacing: 'Medium' }),
      line(`**${p.fileCount}${p.filesComplete ? '' : '+'} ${p.fileCount === 1 && p.filesComplete ? 'file' : 'files'}** · +${p.additions} −${p.deletions} · ${p.commits} ${p.commits === 1 ? 'commit' : 'commits'}`, { spacing: 'Small' }),
      ...files.map((f, i): CardElement => ({ type: 'ColumnSet', spacing: i ? 'None' : 'Small', columns: [
        { type: 'Column', width: 'stretch', items: [line(label(shortPath(f.path), 160), { fontType: 'Monospace', size: 'Small' })] },
        { type: 'Column', width: 'auto', items: [line(`+${f.additions} −${f.deletions}`, { isSubtle: true, size: 'Small' })] }] })),
      ...(p.fileCount > files.length ? [caption(`and ${p.filesComplete ? '' : 'at least '}${p.fileCount - files.length} more`)] : []),
      ...(decide && !p.filesComplete ? [] : [line(`[View changes on GitHub](${compare})`, { spacing: 'Small' })]),
      ...(viewer === 'sender' ? [line(`Opens on GitHub as @${label(p.githubLogin, 39)}`, { spacing: 'Medium' })] : []),
      // With part of the list missing, reading the diff is the first button. It has its own row: four buttons don't fit a phone.
      ...(decide && !p.filesComplete ? [{ type: 'ActionSet' as const, spacing: 'Small' as const, actions: [{ type: 'Action.OpenUrl' as const, title: 'View full diff', url: compare }] }] : [])] : [])];
  return { type: 'AdaptiveCard', version: '1.5', fallbackText: `Pull request: ${s.fallback ?? s.head}`, body,
    refresh: { action: { type: 'Action.Execute', verb: 'pr-refresh', data }, userIds: [p.senderMRI] },
    actions: [...(decide ? [
      { type: 'Action.Execute' as const, title: 'Approve', style: 'positive' as const, verb: 'pr-approve', data },
      { type: 'Action.ShowCard' as const, title: 'Ask for changes', card: { type: 'AdaptiveCard' as const, version: '1.5' as const,
        body: [{ type: 'Input.Text' as const, id: 'note', isMultiline: true, maxLength: 2000, placeholder: 'What should change?' }],
        actions: [{ type: 'Action.Execute' as const, title: 'Send', verb: 'pr-revise', data }] } },
      { type: 'Action.Execute' as const, title: 'Reject', verb: 'pr-reject', data }] : []),
      // The search lists any pull request already open from this branch.
      ...(p.state === 'uncertain' ? [{ type: 'Action.OpenUrl' as const, title: 'Check on GitHub', url: `${repository}/pulls?q=is%3Apr+head%3A${part(p.head)}` }] : []),
      ...(newer ? [{ type: 'Action.OpenUrl' as const, title: NEWER, url: newer }] : []),
      ...(again ? [{ type: 'Action.Submit' as const, title: 'Ask again', data: { msteams: { type: 'imBack' as const, value: again } } }] : []),
      ...(p.outcome?.kind === 'opened' ? [{ type: 'Action.OpenUrl' as const, title: 'Open pull request', url: p.outcome.url }] :
        s.open || p.state === 'superseded' ? [] : [{ type: 'Action.OpenUrl' as const, title: 'View changes', url: compare }])] };
}
/** A fixed notice for a card whose account link changed. It copies no proposal or account text. */
export function pullRequestNotice(kind: 'signin-expired' | RevisionAdmission | undefined): IAdaptiveCard {
  const hidden = 'Details are hidden because you signed in again.'; const r = kind === 'signin-expired' ? undefined : revisionStatus(kind);
  const s: Status = r ? { ...r, detail: r.detail ? `${r.detail} ${hidden}` : hidden } : { head: 'Not opened', alert: true, detail: LINK_EXPIRED };
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
    // The agent's box holds text only. Straight after it, at most one "Show full description" opens text only.
    const container = (input: unknown) => { const c = object(input, ['type', 'style', 'spacing', 'items']);
      if (c.style !== 'emphasis' || c.spacing !== 'Medium') throw new Error(); list(c.items, 3, 1).forEach(text); };
    const description = (input: unknown) => { const s = object(input, ['type', 'spacing', 'actions']); const a = object(list(s.actions, 1, 1)[0], ['type', 'title', 'card']);
      if (s.spacing !== 'Small' || a.type !== 'Action.ShowCard' || a.title !== 'Show full description') throw new Error(); validate(a.card, true); };
    const GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9%_.-]+\/[A-Za-z0-9%_.-]+\/(?:(compare\/[A-Za-z0-9%_.-]+\.\.\.[a-f0-9]{40})|pull\/[1-9][0-9]*|pulls\?q=is%3Apr\+head%3A[A-Za-z0-9%_.-]+)$/u;
    // The last body element may be one button to the full diff.
    const diff = (input: unknown) => { const s = object(input, ['type', 'spacing', 'actions']); const a = object(list(s.actions, 1, 1)[0], ['type', 'title', 'url']);
      if (s.spacing !== 'Small' || a.type !== 'Action.OpenUrl' || a.title !== 'View full diff' || typeof a.url !== 'string' || !GITHUB.exec(a.url)?.[1]) throw new Error(); };
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
      let boxes = 0; let box = -1;
      const items: unknown[] = revision ? [] : c.body;
      items.forEach((b, i) => { const type = b && typeof b === 'object' && 'type' in b ? b.type : undefined;
        if (!nested && type === 'Container' && !boxes++) { container(b); box = i; } else if (!nested && type === 'ActionSet' && i === box + 1 && i) description(b);
        else if (!nested && type === 'ActionSet' && i === items.length - 1) diff(b);
        else if (!nested && type === 'ColumnSet') columns(b); else text(b); });
      if (c.actions !== undefined) {
        if (nested && !revision || !Array.isArray(c.actions) || c.actions.length > (revision ? 1 : 5)) throw new Error();
        for (const a of c.actions) { const v = object(a, ['type', 'title', ...(a.type === 'Action.ShowCard' ? ['card'] : a.type === 'Action.Execute' ? ['verb', 'data', ...(a.verb === 'pr-approve' ? ['style'] : [])] : a.type === 'Action.Submit' ? ['data'] : ['url'])]); string(v.title);
          if (v.type === 'Action.Submit') {
            // "Ask again" may only post a chat message as the person who pressed it.
            const m = object(object(v.data, ['msteams']).msteams, ['type', 'value']);
            if (nested || v.title !== 'Ask again' || m.type !== 'imBack' || typeof m.value !== 'string' || !ASK_AGAIN.test(m.value)) throw new Error();
          } else if (v.type === 'Action.Execute') {
            const d = object(v.data, ['proposal', 'rev', 'digest']); only(v.style, 'positive');
            if (!(revision ? v.verb === 'pr-revise' && v.title === 'Send' : ['pr-approve', 'pr-reject'].includes(String(v.verb))) || d.rev !== 1 || !/^[a-f0-9]{64}$/u.test(String(d.proposal)) || !/^[a-f0-9]{64}$/u.test(String(d.digest))) throw new Error();
          } else if (!nested && v.type === 'Action.ShowCard' && v.title === 'Ask for changes') validate(v.card, true, true);
          // One button may leave for Teams, and only to a message in a chat.
          else if (nested || v.type !== 'Action.OpenUrl' || typeof v.url !== 'string' || !(v.title === NEWER ? MESSAGE : GITHUB).test(v.url)) throw new Error(); }
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
