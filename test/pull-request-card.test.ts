import assert from 'node:assert/strict';
import test from 'node:test';
import type { Proposal } from '../src/accounts/pull-request-proposal.js';
import { MAX_OUTGOING_MESSAGE_BYTES } from '../src/teams/format.js';
import { buildPullRequestCard, cardInvokeResponse, pullRequestNotice } from '../src/teams/pull-request-card.js';
import { proposalFixture } from './support/pull-request-proposal.js';

const response = (value: unknown) => cardInvokeResponse({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value });
const texts = (card: unknown): string[] => { const found: string[] = [];
  JSON.stringify(card, (key, value) => { if (key === 'text' && typeof value === 'string') found.push(value); return value; }); return found; };
const titles = (card: { actions?: { title?: string }[] }) => (card.actions ?? []).map(a => a.title);
const box = (card: { body?: unknown[] }) => card.body!.find((b: any) => b.type === 'Container') as any;
const claim = (p: Proposal, decision: 'reject' | 'revise', note?: string) => ({ decision, tenantId: p.tenantId, objectId: p.objectId, invokeActivityId: 'invoke', decidedAt: p.createdAt,
  ...(note === undefined ? {} : { note, revisionReplyTarget: 'new-reply' }) });
const opened = (p: Proposal) => ({ kind: 'opened' as const, number: 12, url: 'https://github.com/example/project/pull/12', headSHA: p.headSHA });
const longBody = 'First paragraph of the description. '.repeat(20);
const fiveFiles = [['a.ts', 1, 0], ['dir/big.ts', 90, 30], ['c.ts', 4, 4], ['d.ts', 0, 2], ['e.ts', 50, 0], ['f.ts', 10, 10], ['g.ts', 3, 0]]
  .map(([path, additions, deletions]) => ({ path: String(path), additions: Number(additions), deletions: Number(deletions) }));

/** Every card state the gateway can show, with the heading, the lines under it and the buttons each one must have. */
function states(): { name: string; p: Proposal; viewer?: 'room'; enabled?: false; head: string; alert?: true; lines?: string[]; buttons: string[] }[] {
  const p = proposalFixture(); const revise = (revisionAdmission: NonNullable<Proposal['revisionAdmission']>): Proposal =>
    ({ ...p, state: 'revise-requested', revisionAdmission, claim: claim(p, 'revise', 'Cap retries at 5') });
  const failed = (kind: 'branch-moved' | 'permission' | 'signin-required' | 'validation' | 'failed'): Proposal => ({ ...p, state: kind === 'branch-moved' ? 'branch-moved' : 'failed', outcome: { kind } });
  return [
    { name: 'pending sender', p, head: 'Open this pull request?', lines: ['Expires at {{TIME(2027-01-15T09:00:00Z)}} · opens as @example\\-sender'], buttons: ['Approve', 'Revise', 'Reject'] },
    { name: 'pending room', p, viewer: 'room', head: 'Waiting for Example Sender to approve', lines: ['Expires at {{TIME(2027-01-15T09:00:00Z)}} · asked by Example Sender'], buttons: [] },
    { name: 'pending sender, decisions off', p, enabled: false, head: 'Pull request waiting', lines: ["Approval isn't turned on for this chat yet.", 'Expires at {{TIME(2027-01-15T09:00:00Z)}} · opens as @example\\-sender'], buttons: [] },
    { name: 'pending room, decisions off', p, viewer: 'room', enabled: false, head: 'Waiting for Example Sender to approve', lines: ["Approval isn't turned on for this chat yet.", 'Expires at {{TIME(2027-01-15T09:00:00Z)}} · asked by Example Sender'], buttons: [] },
    { name: 'approving', p: { ...p, state: 'approving' }, head: 'Approved. Opening the pull request…', buttons: ['View changes'] },
    { name: 'opened', p: { ...p, state: 'opened', outcome: opened(p) }, head: 'Opened #12', buttons: ['Open pull request'] },
    { name: 'already open', p: { ...p, state: 'opened', outcome: { ...opened(p), existing: true } }, head: 'Already open: #12', buttons: ['Open pull request'] },
    { name: 'opened, branch moved', p: { ...p, state: 'opened', outcome: { ...opened(p), headSHA: 'c'.repeat(40) } }, head: 'Opened #12',
      lines: ['The branch moved while opening. The pull request is at ccccccc, not the approved aaaaaaa.'], buttons: ['Open pull request'] },
    { name: 'rejected sender', p: { ...p, state: 'rejected', claim: claim(p, 'reject') }, head: 'Not opened. You rejected it.', buttons: ['View changes'] },
    { name: 'rejected room', p: { ...p, state: 'rejected', claim: claim(p, 'reject') }, viewer: 'room', head: 'Not opened. Example Sender rejected it.', buttons: ['View changes'] },
    { name: 'revise sending', p: revise('pending'), head: 'Sending your changes…', lines: ['Your note: "Cap retries at 5"'], buttons: ['View changes'] },
    { name: 'revise queue full', p: revise('full'), head: 'Sending your changes…', lines: ['Your note: "Cap retries at 5"'], buttons: ['View changes'] },
    { name: 'revise sent', p: revise('delivered'), head: 'Changes requested. Sent to the agent.', lines: ['Your note: "Cap retries at 5"'], buttons: ['View changes'] },
    { name: 'revise sent, room', p: revise('delivered'), viewer: 'room', head: 'Changes requested. Sent to the agent.', lines: ['Note from Example Sender: "Cap retries at 5"'], buttons: ['View changes'] },
    { name: 'revise sending, room', p: revise('pending'), viewer: 'room', head: 'Sending your changes…', buttons: ['View changes'] },
    { name: 'revise conflict, room', p: revise('conflict'), viewer: 'room', head: 'Changes not sent. Reply in the chat with what to change.', alert: true, buttons: ['View changes'] },
    { name: 'revise sign-in, room', p: revise('signin-required'), viewer: 'room', head: 'Changes not sent. Sign in, then send them again.', alert: true, buttons: ['View changes'] },
    { name: 'revise conflict', p: revise('conflict'), head: 'Changes not sent. Reply in the chat with what to change.', alert: true, lines: ['Your note: "Cap retries at 5"'], buttons: ['View changes'] },
    { name: 'revise sign-in', p: revise('signin-required'), head: 'Changes not sent. Sign in, then send them again.', alert: true, lines: ['Your note: "Cap retries at 5"'], buttons: ['View changes'] },
    { name: 'expired', p: { ...p, state: 'expired' }, head: 'Expired. Nothing was opened.', lines: ['Ask the agent again for a new card.'], buttons: ['View changes'] },
    { name: 'superseded', p: { ...p, state: 'superseded' }, head: 'Replaced by a newer card.', buttons: [] },
    { name: 'failed', p: failed('failed'), head: 'Not opened', alert: true, lines: ['Ask the agent again for a new card.'], buttons: ['View changes'] },
    { name: 'failed permission', p: failed('permission'), head: 'Not opened', alert: true, lines: ["This GitHub account can't open pull requests in example/project."], buttons: ['View changes'] },
    { name: 'failed branch moved', p: failed('branch-moved'), head: 'Not opened', alert: true, lines: ['The branch changed after approval. Ask the agent again for a new card.'], buttons: ['View changes'] },
    { name: 'failed validation', p: failed('validation'), head: 'Not opened', alert: true, lines: ['GitHub rejected the pull request details. Ask the agent again for a new card.'], buttons: ['View changes'] },
    { name: 'failed sign-in', p: failed('signin-required'), head: 'Not opened', alert: true, lines: ['Your account link expired. Sign in, then ask the agent again for a new card.'], buttons: ['View changes'] },
    { name: 'uncertain', p: { ...p, state: 'uncertain', outcome: { kind: 'uncertain' } }, head: "Couldn't confirm the pull request opened", alert: true,
      lines: ['Check [the branch](https://github.com/example/project/tree/orka%2Ffix) on GitHub before asking again.'], buttons: ['View changes'] },
    { name: 'no longer pending', p: { ...p, state: 'failed' }, head: 'This request is no longer pending.', buttons: ['View changes'] },
  ];
}
for (const s of states()) test(`card state: ${s.name}`, () => {
  const p = { ...s.p, body: longBody, files: fiveFiles, fileCount: 7 }; const card = buildPullRequestCard(p, s.viewer ?? 'sender', s.enabled ?? true);
  const pending = p.state === 'pending'; const [caption, head, ...rest] = card.body as any[];
  // The first two lines are always ours: where it is, then the question or the outcome.
  assert.deepEqual(caption, { type: 'TextBlock', text: 'Pull request · example/project', wrap: true, isSubtle: true, size: 'Small', spacing: 'None' });
  assert.deepEqual(head, { type: 'TextBlock', text: s.head, wrap: true, weight: 'Bolder', size: 'Medium', spacing: 'Small', ...(s.alert ? { color: 'Attention' } : {}) });
  const before = rest.slice(0, rest.findIndex(b => b.type === 'Container'));
  assert.deepEqual(before.map(b => b.text), s.lines ?? []);
  assert.deepEqual(titles(card), s.buttons);
  assert.equal(card.fallbackText, `Pull request: ${s.viewer === 'room' && pending ? 'Waiting for approval' : s.name === 'rejected room' ? 'Not opened. Rejected.' : s.head}`);
  // The agent's words appear only inside the captioned box: the title always, the description only while pending.
  const agent = box(card); assert.deepEqual(agent.items.slice(0, 2).map((i: any) => i.text), ['Written by the agent', 'Retry the lease read']);
  assert.equal(agent.items.length, pending ? 4 : 2);
  assert.equal(JSON.stringify(card.body!.filter(b => b !== agent)).includes('First paragraph'), false);
  // Size, branch, files and expiry belong to a card that can still be decided.
  const wire = JSON.stringify(card);
  for (const detail of ['{{TIME(', 'orka/fix → main', 'ColumnSet', 'dir/big', 'View changes](']) assert.equal(wire.includes(detail), pending, detail);
  // Only the sender of a pending card with decisions on gets anything that acts.
  assert.equal(/pr-approve|pr-reject|pr-revise/u.test(wire), pending && s.viewer !== 'room' && s.enabled !== false);
  assert.deepEqual(card.refresh, { action: { type: 'Action.Execute', verb: 'pr-refresh', data: { proposal: p.id, rev: 1, digest: p.payloadDigest } }, userIds: ['29:sender-private'] });
  for (const privateValue of [p.taskUID, p.grantRef, p.targetId, p.replyTarget]) assert.ok(!wire.includes(privateValue));
  // A note the agent has not been sent yet is the sender's alone.
  if (p.state === 'revise-requested') assert.equal(wire.includes('Cap retries at 5'), s.viewer !== 'room' || p.revisionAdmission === 'delivered');
  assert.ok(response(card), 'every state passes the closed projection');
  assert.ok(Buffer.byteLength(wire) < 6144);
});

test('pending card: Approve is the only styled button, then Revise, then Reject; the diff is pinned by both SHAs', () => {
  const p = proposalFixture(); const card = buildPullRequestCard(p, 'sender', true); const data = { proposal: p.id, rev: 1, digest: p.payloadDigest };
  assert.deepEqual(card.actions, [
    { type: 'Action.Execute', title: 'Approve', style: 'positive', verb: 'pr-approve', data },
    { type: 'Action.ShowCard', title: 'Revise', card: { type: 'AdaptiveCard', version: '1.5',
      body: [{ type: 'Input.Text', id: 'note', isMultiline: true, maxLength: 2000, placeholder: 'What should change?' }],
      actions: [{ type: 'Action.Execute', title: 'Send', verb: 'pr-revise', data }] } },
    { type: 'Action.Execute', title: 'Reject', verb: 'pr-reject', data }]);
  const compare = `https://github.com/example/project/compare/${p.baseSHA}...${p.headSHA}`;
  assert.ok(texts(card).includes(`**1 file** · +3 −1 · 1 commit · [View changes](${compare})`));
  assert.ok(!JSON.stringify(card).includes(p.headSHA.slice(0, 7) + ' '), 'the short SHA is not shown as text');
  const closed = buildPullRequestCard({ ...p, state: 'expired' }, 'sender', true);
  assert.deepEqual(closed.actions, [{ type: 'Action.OpenUrl', title: 'View changes', url: compare }]);
});

test('files: the five largest changes first, counts beside each path, then how many more', () => {
  const p = { ...proposalFixture(), files: fiveFiles, fileCount: 23, additions: 612, deletions: 140, commits: 6 }; const card = buildPullRequestCard(p, 'sender', true);
  const rows = (card.body as any[]).filter(b => b.type === 'ColumnSet');
  assert.deepEqual(rows.map(r => r.columns.map((c: any) => c.items[0].text)), [['dir/big\\.ts', '+90 −30'], ['e\\.ts', '+50 −0'], ['f\\.ts', '+10 −10'], ['c\\.ts', '+4 −4'], ['g\\.ts', '+3 −0']]);
  assert.deepEqual(rows[0], { type: 'ColumnSet', spacing: 'Small', columns: [
    { type: 'Column', width: 'stretch', items: [{ type: 'TextBlock', text: 'dir/big\\.ts', wrap: true, fontType: 'Monospace', size: 'Small' }] },
    { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: '+90 −30', wrap: true, isSubtle: true, size: 'Small' }] }] });
  assert.deepEqual(rows.slice(1).map(r => r.spacing), ['None', 'None', 'None', 'None']);
  assert.ok(texts(card).includes('and 18 more')); assert.ok(texts(card).some(t => t.startsWith('**23 files** · +612 −140 · 6 commits · ')));
  assert.deepEqual(p.files, fiveFiles, 'the stored order is not changed');
  const one = buildPullRequestCard(proposalFixture(), 'sender', true);
  assert.equal((one.body as any[]).filter(b => b.type === 'ColumnSet').length, 1); assert.ok(!texts(one).some(t => /more$/u.test(t)));
});

test('incomplete file list: the count is a minimum and the warning is in the alert colour, above the files', () => {
  const p = { ...proposalFixture(), files: fiveFiles, fileCount: 300, filesComplete: false }; const body = buildPullRequestCard(p, 'room', true).body as any[];
  const warning = body.findIndex(b => b.text === 'GitHub returned only part of the file list. Check the full diff before approving.');
  assert.deepEqual({ color: body[warning].color, size: body[warning].size }, { color: 'Attention', size: 'Small' });
  assert.match(body[warning - 1].text, /^\*\*300\+ files\*\* · /u); assert.equal(body[warning + 1].type, 'ColumnSet');
  assert.ok(!JSON.stringify(buildPullRequestCard(proposalFixture(), 'room', true)).includes('only part'));
});

test('description: a short one shows whole; a long one is cut by escaped bytes and opens in place under the same caption', () => {
  const p = proposalFixture(); const more = (card: unknown) => box(card as any).items.find((i: any) => i.type === 'ActionSet');
  const short = buildPullRequestCard(p, 'sender', true);
  assert.deepEqual(box(short).items.map((i: any) => i.text), ['Written by the agent', 'Retry the lease read', 'Agent\\-written description']); assert.equal(more(short), undefined);
  assert.equal(box(buildPullRequestCard({ ...p, body: '' }, 'sender', true)).items[2].text, 'No description.');
  for (const [body, cut, cutAgain] of [['字'.repeat(90), false, false], ['字'.repeat(120), true, false], ['&'.repeat(50), false, false], ['&'.repeat(200), true, false],
    ['x'.repeat(278), false, false], ['x'.repeat(279), true, false], ['x'.repeat(300), true, false], ['&'.repeat(500), true, true]] as const) {
    const card = buildPullRequestCard({ ...p, body }, 'sender', true); const preview = box(card).items[2].text as string;
    assert.equal(preview.endsWith('…'), cut, body.slice(0, 1) + body.length); assert.ok(Buffer.byteLength(JSON.stringify(preview)) <= 280 + 3);
    assert.equal(more(card) !== undefined, cut);
    if (!cut) continue;
    assert.deepEqual({ ...more(card), actions: [{ ...more(card).actions[0], card: undefined }] }, { type: 'ActionSet', spacing: 'Small', actions: [{ type: 'Action.ShowCard', title: 'Show more', card: undefined }] });
    const expanded = more(card).actions[0].card;
    assert.deepEqual(Object.keys(expanded), ['type', 'version', 'body']);
    assert.deepEqual(expanded.body.map((b: any) => b.text.slice(0, 20)), ['Written by the agent', expanded.body[1].text.slice(0, 20), ...(cutAgain ? ['Shortened to fit thi'] : [])]);
    assert.equal(expanded.body[1].text.endsWith('…'), cutAgain); assert.ok(expanded.body[1].text.startsWith(preview.slice(0, -1)) && expanded.body[1].text !== preview);
    assert.ok(response(card));
  }
});

test('untrusted text is escaped everywhere it appears and cannot start a link, a mention or a time', () => {
  const p = proposalFixture(); const evil = '[Admin](https://evil.invalid) **x** <at>a</at> {{TIME(2020-01-01T00:00:00Z)}}';
  Object.assign(p, { displayName: evil, title: evil, body: evil.repeat(40), owner: evil, repo: evil, head: evil, base: evil,
    files: [{ path: evil, additions: 1, deletions: 1 }], claim: claim(p, 'revise', evil) });
  const cards = [buildPullRequestCard(p, 'room', true), buildPullRequestCard(p, 'sender', true),
    ...(['rejected', 'uncertain', 'failed', 'revise-requested'] as const).flatMap(state => (['room', 'sender'] as const).map(viewer =>
      buildPullRequestCard({ ...p, state, ...(state === 'failed' ? { outcome: { kind: 'permission' as const } } : {}) }, viewer, true)))];
  for (const card of cards) for (const text of [...texts(card), card.fallbackText!]) {
    assert.ok(!text.includes('[Admin](') && !text.includes('**x**') && !text.includes('<at>'), text);
    // The only unescaped link targets and time are ours.
    for (const [target] of text.matchAll(/(?<!\\)\]\(([^)]*)\)/gu)) assert.match(target, /^\]\(https:\/\/github\.com\/[A-Za-z0-9%_.-]+\/[A-Za-z0-9%_.-]+\/(compare|tree)\/[A-Za-z0-9%_.-]+\)$/u);
    for (const [time] of text.matchAll(/\{\{[^}]*\}\}/gu)) assert.equal(time, '{{TIME(2027-01-15T09:00:00Z)}}');
  }
  assert.ok(!cards[0]!.fallbackText!.includes('Admin') && !cards[2]!.fallbackText!.includes('Admin'), 'fallback text is ours only');
  assert.ok(response(cards[1]));
});

test('largest card stays under the message limit and inside the projection', () => {
  const p = proposalFixture(); p.title = '&'.repeat(256); p.body = '&'.repeat(16384); p.displayName = '&'.repeat(1024);
  p.owner = 'a'.repeat(100); p.repo = '_'.repeat(100); p.head = '_'.repeat(256); p.base = '_'.repeat(256);
  p.files = Array.from({ length: 10 }, () => ({ path: '&'.repeat(4096), additions: Number.MAX_SAFE_INTEGER, deletions: Number.MAX_SAFE_INTEGER })); p.fileCount = 300; p.filesComplete = false;
  for (const viewer of ['room', 'sender'] as const) for (const state of ['pending', 'revise-requested'] as const) {
    const card = buildPullRequestCard({ ...p, state, ...(state === 'pending' ? {} : { claim: claim(p, 'revise', '&'.repeat(2000)) }) }, viewer, true);
    assert.ok(Buffer.byteLength(JSON.stringify({ type: 'message', replyToId: p.activityId, attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] })) <= MAX_OUTGOING_MESSAGE_BYTES);
    assert.ok(card.body!.length <= 32); assert.ok(response(card));
  }
});

test('fixed notices copy nothing from the proposal and pass the projection', () => {
  const head = (card: any) => card.body.map((b: any) => b.text);
  assert.deepEqual(pullRequestNotice('signin-expired'), { type: 'AdaptiveCard', version: '1.5', fallbackText: 'Pull request: Not opened', body: [
    { type: 'TextBlock', text: 'Pull request', wrap: true, isSubtle: true, size: 'Small', spacing: 'None' },
    { type: 'TextBlock', text: 'Not opened', wrap: true, weight: 'Bolder', size: 'Medium', spacing: 'Small' },
    { type: 'TextBlock', text: 'Your account link expired. Sign in, then ask the agent again for a new card.', wrap: true, spacing: 'Small' }] });
  const hidden = 'Details are hidden because you signed in again.';
  assert.deepEqual(head(pullRequestNotice('delivered')), ['Pull request', 'Changes requested. Sent to the agent.', hidden]);
  assert.deepEqual(head(pullRequestNotice('conflict')), ['Pull request', 'Changes not sent. Reply in the chat with what to change.', hidden]);
  assert.deepEqual(head(pullRequestNotice('signin-required')), ['Pull request', 'Changes not sent. Sign in, then send them again.', hidden]);
  for (const kind of ['pending', 'full', undefined] as const) assert.deepEqual(head(pullRequestNotice(kind)), ['Pull request', 'Sending your changes…', hidden]);
  assert.equal((pullRequestNotice('conflict').body![1] as any).color, 'Attention');
  for (const kind of ['signin-expired', 'pending', 'delivered', 'conflict', 'signin-required'] as const) assert.ok(response(pullRequestNotice(kind)));
});

// The projection is a security boundary: an invoke response carries only what the builder can produce.
const full = () => buildPullRequestCard({ ...proposalFixture(), body: longBody, files: fiveFiles, fileCount: 300, filesComplete: false }, 'sender', true) as any;
const part = { head: (c: any) => c.body[1], box: (c: any) => box(c), set: (c: any) => box(c).items[3], more: (c: any) => box(c).items[3].actions[0], expanded: (c: any) => box(c).items[3].actions[0].card,
  row: (c: any) => c.body.find((b: any) => b.type === 'ColumnSet'), column: (c: any) => c.body.find((b: any) => b.type === 'ColumnSet').columns[0],
  approve: (c: any) => c.actions[0], revise: (c: any) => c.actions[1], send: (c: any) => c.actions[1].card.actions[0], reject: (c: any) => c.actions[2] };

test('projection: the full pending card passes, and is returned without the wrapper\'s extra fields', () => {
  const card = full(); const projected = cardInvokeResponse({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card, secret: 'hidden' });
  assert.deepEqual(projected, { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card });
  assert.equal(response({ type: 'AdaptiveCard', version: '1.5', body: [], secret: 'hidden' }), undefined);
  for (const wrapper of [{ statusCode: 201 }, { type: 'application/vnd.microsoft.activity.message' }]) assert.equal(cardInvokeResponse({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card, ...wrapper }), undefined);
});

for (const [name, target] of Object.entries(part)) test(`projection rejects an unknown key on the ${name}`, () => {
  for (const key of ['id', 'selectAction', 'url', 'backgroundImage', 'isVisible', 'fallback', 'requires', 'style', 'bleed', 'tooltip', 'iconUrl', 'mode']) {
    const forged = full(); const element = target(forged);
    if (key in element) continue;
    element[key] = key === 'style' ? 'positive' : 'x'; assert.equal(response(forged), undefined, key);
  }
  assert.ok(response(full()));
});

test('projection rejects every value the builder does not use', () => {
  const mutations: [string, (c: any) => void][] = [
    ['text weight', c => { part.head(c).weight = 'Lighter'; }], ['text size', c => { part.head(c).size = 'ExtraLarge'; }], ['text colour', c => { part.head(c).color = 'Good'; }],
    ['text colour case', c => { part.head(c).color = 'attention'; }], ['text spacing', c => { part.head(c).spacing = 'Padding'; }], ['subtle false', c => { c.body[0].isSubtle = false; }],
    ['font', c => { part.row(c).columns[0].items[0].fontType = 'Default'; }], ['no wrap', c => { part.head(c).wrap = false; }], ['text not a string', c => { part.head(c).text = 7; }],
    ['text over the limit', c => { part.head(c).text = 'x'.repeat(MAX_OUTGOING_MESSAGE_BYTES + 1); }],
    ['other body element', c => { c.body.push({ type: 'Image', url: 'https://example.invalid/x.png' }); }], ['top-level ActionSet', c => { c.body.push(part.set(c)); }],
    ['top-level FactSet', c => { c.body.push({ type: 'FactSet', facts: [] }); }], ['top-level input', c => { c.body.push(part.revise(c).card.body[0]); }],
    ['second container', c => { c.body.push(structuredClone(part.box(c))); }], ['second container without a button', c => { const again = structuredClone(part.box(c)); again.items.pop(); c.body.push(again); }],
    ['container style', c => { part.box(c).style = 'attention'; }], ['container without style', c => { delete part.box(c).style; }], ['container spacing', c => { part.box(c).spacing = 'None'; }],
    ['empty container', c => { part.box(c).items = []; }], ['container items not a list', c => { part.box(c).items = { 0: part.head(c) }; }], ['fifth container item', c => { part.box(c).items.unshift(part.head(c)); }],
    ['container in container', c => { part.box(c).items[2] = structuredClone(part.box(c)); }], ['columns in container', c => { part.box(c).items[2] = part.row(c); }],
    ['input in container', c => { part.box(c).items[2] = part.revise(c).card.body[0]; }], ['ActionSet before text', c => { const items = part.box(c).items; [items[2], items[3]] = [items[3], items[2]]; }],
    ['second ActionSet', c => { part.box(c).items[2] = structuredClone(part.set(c)); }], ['ActionSet spacing', c => { part.set(c).spacing = 'Large'; }],
    ['two actions in the set', c => { part.set(c).actions.push(structuredClone(part.more(c))); }], ['empty set', c => { part.set(c).actions = []; }],
    ['Execute in the set', c => { part.set(c).actions[0] = part.approve(c); }], ['OpenUrl in the set', c => { part.set(c).actions[0] = { type: 'Action.OpenUrl', title: 'Show more', url: 'https://github.com/a/b/pull/1' }; }],
    ['other title in the set', c => { part.more(c).title = 'Revise'; }], ['expanded card with actions', c => { part.expanded(c).actions = [part.approve(c)]; }],
    ['expanded card with empty actions', c => { part.expanded(c).actions = []; }], ['expanded card with refresh', c => { part.expanded(c).refresh = c.refresh; }],
    ['expanded card with a container', c => { part.expanded(c).body.push(structuredClone(part.box(c))); }], ['expanded card with columns', c => { part.expanded(c).body.push(part.row(c)); }],
    ['expanded card with an input', c => { part.expanded(c).body.push(part.revise(c).card.body[0]); }], ['expanded card version', c => { part.expanded(c).version = '1.6'; }],
    ['row spacing', c => { part.row(c).spacing = 'Medium'; }], ['one column', c => { part.row(c).columns.pop(); }], ['three columns', c => { part.row(c).columns.push(structuredClone(part.column(c))); }],
    ['columns swapped', c => { part.row(c).columns.reverse(); }], ['column width', c => { part.column(c).width = '200px'; }], ['column type', c => { part.column(c).type = 'Container'; }],
    ['two texts in a column', c => { part.column(c).items.push(part.head(c)); }], ['empty column', c => { part.column(c).items = []; }], ['container in a column', c => { part.column(c).items = [structuredClone(part.box(c))]; }],
    ['approve style', c => { part.approve(c).style = 'destructive'; }], ['styled reject', c => { part.reject(c).style = 'positive'; }], ['destructive reject', c => { part.reject(c).style = 'destructive'; }],
    ['styled send', c => { part.send(c).style = 'positive'; }], ['styled revise', c => { part.revise(c).style = 'positive'; }], ['styled link', c => { c.actions.push({ type: 'Action.OpenUrl', title: 'x', style: 'positive', url: 'https://github.com/a/b/pull/1' }); }],
    ['revise from the top level', c => { part.approve(c).verb = 'pr-revise'; }], ['other verb', c => { part.reject(c).verb = 'pr-merge'; }], ['extra data', c => { part.approve(c).data.note = 'x'; }],
    ['other revision', c => { part.approve(c).data.rev = 2; }], ['short digest', c => { part.approve(c).data.digest = 'abc'; }],
    ['top-level Show more', c => { c.actions.push(structuredClone(part.more(c))); }], ['top-level text ShowCard', c => { c.actions[1] = { type: 'Action.ShowCard', title: 'Show full description', card: part.expanded(c) }; }],
    ['revise note limit', c => { part.revise(c).card.body[0].maxLength = 2001; }], ['revise input id', c => { part.revise(c).card.body[0].id = 'token'; }], ['revise sends approve', c => { part.send(c).verb = 'pr-approve'; }],
    ['second revise action', c => { part.revise(c).card.actions.push(part.approve(c)); }], ['revise card with text', c => { part.revise(c).card.body.push(part.head(c)); }],
    ['link elsewhere', c => { c.actions = [{ type: 'Action.OpenUrl', title: 'View changes', url: 'https://github.com.evil.invalid/a/b/pull/1' }]; }],
    ['link to another GitHub page', c => { c.actions = [{ type: 'Action.OpenUrl', title: 'View changes', url: 'https://github.com/a/b/settings' }]; }],
    ['six actions', c => { c.actions.push(...[1, 2, 3].map(n => ({ type: 'Action.OpenUrl', title: 'x', url: `https://github.com/a/b/pull/${n}` }))); }],
    ['33 body elements', c => { while (c.body.length < 33) c.body.push(part.head(c)); }], ['card version', c => { c.version = '1.4'; }],
    ['two refresh users', c => { c.refresh.userIds.push('29:other'); }], ['other refresh verb', c => { c.refresh.action.verb = 'pr-approve'; }], ['refresh key', c => { c.refresh.expires = '2030-01-01T00:00:00Z'; }],
    ['card key', c => { c.msteams = { width: 'Full' }; }], ['card over the limit', c => { part.expanded(c).body[1].text = 'x'.repeat(MAX_OUTGOING_MESSAGE_BYTES); }],
  ];
  for (const [name, mutate] of mutations) { const forged = full(); mutate(forged); assert.equal(response(forged), undefined, name); }
  assert.equal(new Set(mutations.map(m => m[0])).size, mutations.length);
});

test('projection accepts each allowed value, so the rejections above are not accidents', () => {
  for (const mutate of [(c: any) => { delete part.approve(c).style; }, (c: any) => { part.box(c).items.pop(); }, (c: any) => { part.row(c).spacing = 'None'; },
    (c: any) => { part.head(c).color = 'Attention'; }, (c: any) => { part.head(c).size = 'Small'; part.head(c).spacing = 'Medium'; part.head(c).fontType = 'Monospace'; part.head(c).isSubtle = true; },
    (c: any) => { c.actions = [{ type: 'Action.OpenUrl', title: 'Open pull request', url: 'https://github.com/a/b/pull/1' }]; }, (c: any) => { delete c.actions; delete c.refresh; delete c.fallbackText; },
  ]) { const card = full(); mutate(card); assert.ok(response(card)); }
});
