import { createHash } from 'node:crypto';
import type { ClientRequest } from 'node:http';
import https from 'node:https';
import type { AccountTokens, BrowserAttempt } from './store.js';
import type { DirectoryContext } from '../directory/types.js';
import { tlsVerificationEnabled } from '../ingress/config.js';
import { object as fields } from '../storage/table/codec.js';
import { githubTools } from './grants.js';
import type { GitHubTool } from './grants.js';
import type { Proposal, ProposalFacts, ProposalResult } from './pull-request-proposal.js';

/** step is a fixed proposal-read stage for logs, never a value. */
/** `no-response` means GitHub gave no answer: a request ran out its eight seconds, the connection dropped, or GitHub returned a server error. */
export class GitHubError extends Error { constructor(readonly code = 'unavailable', readonly step?: string) { super('GitHub sign-in unavailable'); } }
export function githubArguments(tool: GitHubTool, input: unknown): Record<string, string> {
  const keys = tool === 'github-read-file' ? ['path', 'ref'] : tool === 'github-list-issues' ? ['state'] : tool === 'github-read-issue' ? [] :
    tool === 'github-create-issue' ? ['title', 'body'] : ['title', 'body', 'head', 'base'];
  const v = fields(input, ['owner', 'repo', ...keys, ...(tool === 'github-read-issue' ? ['number'] : [])]); const out: Record<string, string> = {};
  if (tool === 'github-read-issue') {
    // Accept the canonical decimal string too: the task service passes normalized arguments on to the request.
    const n = typeof v.number === 'string' && /^[1-9][0-9]{0,9}$/u.test(v.number) ? Number(v.number) : v.number;
    if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 2 ** 31 - 1) throw failure(); out.number = String(n);
  }
  const text = (key: string, max: number, optional = false) => {
    const value = v[key]; if (value === undefined && optional) return;
    if (typeof value !== 'string' || Buffer.byteLength(value) > max || key !== 'body' && !value.trim() ||
      /[\uD800-\uDFFF]/u.test(value) || /\p{Cc}/u.test(key === 'body' ? value.replace(/[\t\r\n]/gu, '') : value)) throw failure(); out[key] = value;
  };
  text('owner', 100); text('repo', 100);
  if (!/^[A-Za-z0-9-]+$/u.test(out.owner!) || !/^[A-Za-z0-9_.-]+$/u.test(out.repo!) || ['.', '..'].includes(out.repo!)) throw failure();
  for (const key of keys) text(key, key === 'body' ? 16384 : key === 'path' ? 1024 : 256, ['body', 'ref', 'state'].includes(key));
  if (tool === 'github-read-file' && (out.path!.includes('\\') || out.path!.split('/').some(s => !s || s === '.' || s === '..'))) throw failure();
  if (out.state !== undefined && !['open', 'closed', 'all'].includes(out.state)) throw failure();
  if (tool === 'github-propose-pull-request') for (const ref of [out.base!, out.head!]) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/u.test(ref) || /\.\.|\/\/|@\{|\/$|\.$|\.lock(?:\/|$)/u.test(ref)) throw failure();
  }
  return out;
}

/** Fixed and value-free: the same text whether or not the repository exists. */
export const REPOSITORY_NOT_ALLOWED = "This gateway's operator has not allowed its GitHub tools to use that repository. This call read and changed nothing; do not retry.";
/** allowed holds lower-case "owner/repo" and "owner/*" entries. Only ASCII is folded, as GitHub names are ASCII. */
export function repositoryAllowed(allowed: readonly string[] | undefined, owner: string, repo: string): boolean {
  return !!allowed && (allowed.includes(`${lower(owner)}/*`) || allowed.includes(`${lower(owner)}/${lower(repo)}`));
}
/** GitHub reads an "owner:branch" pull request head from that owner's fork, whatever its name, so another owner needs its wildcard entry. */
export function headAllowed(allowed: readonly string[] | undefined, owner: string, head: string): boolean {
  const colon = head.indexOf(':'); if (colon < 0) return true;
  const source = lower(head.slice(0, colon)); return source === lower(owner) || !!allowed?.includes(`${source}/*`);
}
const lower = (s: string) => s.replace(/[A-Z]/gu, c => c.toLowerCase());

const failure = () => new GitHubError();
const ISSUE_BODY_BYTES = 16384;
/** Cut at a code point so the JSON-escaped text stays within max bytes; the final 32 KiB check still bounds the whole result. */
function clip(text: string, max: number): [string, boolean] {
  let size = 0; let end = 0;
  for (const ch of text) { size += Buffer.byteLength(JSON.stringify(ch)) - 2; if (size > max) return [text.slice(0, end), true]; end += ch.length; }
  return [text, false];
}
const credential = (v: unknown): v is string => typeof v === 'string' && v.length <= 16384 && /^[A-Za-z0-9._~+/-]+=*$/u.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** GitHub App web flow only. Destinations and headers cannot be selected by a caller. */
export function createGitHub(input: { clientId: string; clientSecret: string; publicOrigin: string }, deps: {
  request?: typeof https.request; now?: () => number;
} = {}) {
  const config = { ...input }; const origin = new URL(config.publicOrigin);
  if (!credential(config.clientId) || !credential(config.clientSecret) || origin.protocol !== 'https:' || origin.origin !== config.publicOrigin ||
    origin.username || origin.password || origin.port) throw failure();
  const redirectUri = `${config.publicOrigin}/github/callback`; const request = deps.request ?? https.request; const now = deps.now ?? Date.now;
  const shutdown = new AbortController(); const work = new Set<Promise<unknown>>(); let closed = false;
  const active = (ctx: DirectoryContext) => {
    if (closed || ctx.signal.aborted || !Number.isFinite(ctx.deadline) || performance.now() >= ctx.deadline ||
      ctx.authorizeWrite?.() === false || !tlsVerificationEnabled()) throw failure();
  };
  function json(userToken: string | undefined, fields: Record<string, string>, ctx: DirectoryContext,
    api?: { path: string; body?: Record<string, string>; method?: 'PATCH' }): Promise<unknown> {
    // REST issue/PR objects carry unreturned metadata; keep OAuth's smaller credential-response bound.
    const maxResponseBytes = api ? 1024 * 1024 : 65536;
    const body = api?.body ? Buffer.from(JSON.stringify(api.body)) : userToken ? undefined : Buffer.from(new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }).toString());
    return new Promise((resolve, reject) => {
      let req: ClientRequest | undefined; let requestClosed = false; let socketClosed = true;
      let result: unknown; let failed = false; let reason = failure(); let silent = false;
      const finish = () => {
        if (!requestClosed || !socketClosed) return;
        clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); shutdown.signal.removeEventListener('abort', abort);
        if (result !== undefined && !failed) resolve(result); else reject(silent && reason.code === 'unavailable' ? new GitHubError('no-response') : reason);
      };
      const abort = () => { failed = true; req?.destroy(); };
      // Only a failure the gateway did not cause itself counts as GitHub's silence.
      const dropped = () => { if (!failed) silent = true; abort(); };
      const wait = Math.max(1, Math.min(8000, ctx.deadline - performance.now()));
      const timer = setTimeout(() => { if (wait === 8000) dropped(); else abort(); }, wait); timer.unref();
      ctx.signal.addEventListener('abort', abort, { once: true }); shutdown.signal.addEventListener('abort', abort, { once: true });
      try {
        active(ctx);
        req = request(new URL(api ? `https://api.github.com${api.path}` : userToken ? 'https://api.github.com/user' : 'https://github.com/login/oauth/access_token'), {
          method: api?.method ?? (body ? 'POST' : 'GET'), agent: false, rejectUnauthorized: true, maxHeaderSize: 16384,
          headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', Connection: 'close',
            ...(userToken ? { Authorization: `Bearer ${userToken}`, 'User-Agent': 'orka-gateway-teams', 'X-GitHub-Api-Version': '2026-03-10' } : {}),
            ...(body ? { 'Content-Type': api ? 'application/json' : 'application/x-www-form-urlencoded', 'Content-Length': body.length } : {}) } }, res => {
          const chunks: Buffer[] = []; let size = 0;
          res.on('error', dropped); res.on('aborted', dropped);
          res.on('data', (b: Buffer) => { size += b.length; if (size > maxResponseBytes) abort(); else chunks.push(b); });
          res.on('end', () => {
            try {
              active(ctx);
              if (api && (res.statusCode ?? 0) >= 500) throw new GitHubError('no-response');
              if (!res.complete || res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity' ||
                !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(res.headers['content-type'] ?? '')) throw failure();
              const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
              if (api && res.statusCode === 401) throw new GitHubError('unauthorized');
              if (api?.body && res.statusCode === 422) throw new GitHubError('validation');
              if (api && res.statusCode === 403 && object(value) && value.message === 'Resource not accessible by integration' &&
                res.headers['retry-after'] === undefined && res.headers['x-ratelimit-remaining'] !== '0') throw new GitHubError('permission');
              if (res.statusCode !== (api?.body && !api.method ? 201 : 200) || (!object(value) && !Array.isArray(value)) || object(value) && 'error' in value) throw failure(); result = value;
            } catch (e) { failed = true; if (e instanceof GitHubError) reason = e; }
            req?.destroy();
          });
        });
        req.once('socket', socket => { socketClosed = false; socket.once('close', () => { socketClosed = true; finish(); }); });
        req.once('error', dropped); req.once('close', () => { requestClosed = true; finish(); });
        active(ctx); req.end(body);
      } catch { abort(); if (!req) { requestClosed = true; finish(); } }
    });
  }
  function exchange(fields: Record<string, string>, ctx: DirectoryContext): Promise<AccountTokens> {
    try { active(ctx); if (work.size >= 4 || Object.entries(fields).some(([k, v]) => k !== 'redirect_uri' && !credential(v))) throw failure(); }
    catch { return Promise.reject(failure()); }
    const pending = (async () => {
      const value = await json(undefined, fields, ctx); active(ctx); if (!object(value)) throw failure();
      const expiry = (v: unknown, max: number) => { if (!Number.isSafeInteger(v) || (v as number) <= 0 || (v as number) > max) throw failure(); return now() + (v as number) * 1000; };
      if (!credential(value.access_token) || !credential(value.refresh_token) || value.token_type !== 'bearer') throw failure();
      const expiresAt = expiry(value.expires_in, 28800); const refreshExpiresAt = expiry(value.refresh_token_expires_in, 15897600);
      const user = await json(value.access_token, {}, ctx); active(ctx);
      if (!object(user) || !Number.isSafeInteger(user.id) || (user.id as number) <= 0) throw failure();
      return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt, refreshExpiresAt, providerUserId: String(user.id) };
    })().catch(() => { throw failure(); });
    work.add(pending); void pending.then(() => work.delete(pending), () => work.delete(pending)); return pending;
  }
  function apiWork<T>(token: string, ctx: DirectoryContext, action: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(() => { active(ctx); if (!credential(token) || work.size > 4) throw failure(); return action(); });
    work.add(pending); void pending.then(() => work.delete(pending), () => work.delete(pending)); return pending;
  }
  const root = (p: Proposal) => `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}`;
  function pullResult(p: Proposal, v: unknown): ProposalResult {
    if (!object(v) || !Number.isSafeInteger(v.number) || (v.number as number) < 1 || !object(v.head) || !object(v.base) ||
      !object(v.head.repo) || !object(v.base.repo) || v.head.ref !== p.head || v.base.ref !== p.base ||
      String(v.head.repo.full_name).toLowerCase() !== `${p.owner}/${p.repo}`.toLowerCase() || String(v.base.repo.full_name).toLowerCase() !== `${p.owner}/${p.repo}`.toLowerCase() ||
      typeof v.head.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(v.head.sha)) throw failure();
    const url = `https://github.com/${p.owner}/${p.repo}/pull/${v.number}`;
    if (typeof v.html_url !== 'string' || v.html_url.toLowerCase() !== url.toLowerCase()) throw failure();
    return { kind: 'opened', number: v.number as number, url, headSHA: v.head.sha };
  }
  return {
    readUserId(token: string, ctx: DirectoryContext): Promise<string> {
      return apiWork(token, ctx, async () => { const v = await json(token, {}, ctx, { path: '/user' }); active(ctx);
        if (!object(v) || !Number.isSafeInteger(v.id) || (v.id as number) < 1) throw failure(); return String(v.id); });
    },
    readHead(p: Proposal, token: string, ctx: DirectoryContext): Promise<string> {
      return apiWork(token, ctx, async () => {
        const v = await json(token, {}, ctx, { path: `${root(p)}/git/ref/heads/${p.head.split('/').map(encodeURIComponent).join('/')}` }); active(ctx);
        if (!object(v) || v.ref !== `refs/heads/${p.head}` || !object(v.object) || v.object.type !== 'commit' || typeof v.object.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(v.object.sha)) throw failure();
        return v.object.sha;
      });
    },
    findPullRequest(p: Proposal, token: string, ctx: DirectoryContext, all = false): Promise<ProposalResult | undefined> {
      return apiWork(token, ctx, async () => {
        let match: ProposalResult | undefined;
        for (let page = 1; page <= 1000; page++) {
          const query = new URLSearchParams({ head: `${p.owner}:${p.head}`, base: p.base, state: all ? 'all' : 'open', per_page: '100', page: String(page) });
          const values = await json(token, {}, ctx, { path: `${root(p)}/pulls?${query}` }); active(ctx);
          if (!Array.isArray(values) || values.length > 100) throw failure();
          for (const v of values) {
            if (!object(v) || !object(v.head) || !object(v.base) || !object(v.head.repo) || !object(v.base.repo)) throw failure();
            if (v.head.ref !== p.head || v.base.ref !== p.base || String(v.head.repo.full_name).toLowerCase() !== `${p.owner}/${p.repo}`.toLowerCase() ||
              String(v.base.repo.full_name).toLowerCase() !== `${p.owner}/${p.repo}`.toLowerCase()) continue;
            if (match) throw new GitHubError('ambiguous'); match = { ...pullResult(p, v), existing: true };
          }
          if (values.length < 100) return match;
        }
        throw failure();
      });
    },
    openProposedPullRequest(p: Proposal, token: string, ctx: DirectoryContext): Promise<ProposalResult> {
      return apiWork(token, ctx, async () => { const v = await json(token, {}, ctx, { path: `${root(p)}/pulls`,
        body: { base: p.base, head: p.head, title: p.title, body: p.body } }); active(ctx); return pullResult(p, v); });
    },
    /** Closes a pull request this gateway has just opened. It resolves only when GitHub reports it closed. */
    closePullRequest(p: Proposal, number: number, token: string, ctx: DirectoryContext): Promise<void> {
      return apiWork(token, ctx, async () => { const v = await json(token, {}, ctx, { path: `${root(p)}/pulls/${number}`, method: 'PATCH', body: { state: 'closed' } }); active(ctx);
        if (pullResult(p, v).number !== number || !object(v) || v.state !== 'closed') throw failure(); });
    },
    safeOutput: (text: string) => !text.includes(config.clientSecret),
    readProposalFacts(args: Record<string, string>, token: string, ctx: DirectoryContext): Promise<ProposalFacts> {
      let step = 'start';
      const pending = (async () => {
        active(ctx); if (!credential(token) || work.size >= 4) throw failure(); githubArguments('github-propose-pull-request', args);
        const root = `/repos/${encodeURIComponent(args.owner!)}/${encodeURIComponent(args.repo!)}`;
        const get = async (path: string) => { const v = await json(token, {}, ctx, { path }); active(ctx); if (!object(v)) throw failure(); return v; };
        const sha = (v: unknown) => { if (typeof v !== 'string' || !/^[a-f0-9]{40}$/u.test(v)) throw failure(); return v; };
        const count = (v: unknown) => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw failure(); return v as number; };
        step = 'user'; const user = await get('/user');
        if (!Number.isSafeInteger(user.id) || (user.id as number) <= 0 || typeof user.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/u.test(user.login)) throw failure();
        step = 'head'; const ref = await get(`${root}/git/ref/heads/${args.head!.split('/').map(encodeURIComponent).join('/')}`);
        if (ref.ref !== `refs/heads/${args.head}` || !object(ref.object) || ref.object.type !== 'commit') throw failure();
        const headSHA = sha(ref.object.sha);
        step = 'compare'; const first = await get(`${root}/compare/${encodeURIComponent(args.base!)}...${headSHA}?per_page=100&page=1`);
        if (!object(first.base_commit)) throw failure(); const baseSHA = sha(first.base_commit.sha); const total = count(first.total_commits);
        if (!total) throw failure(); let checked = 0;
        const authors = (v: Record<string, unknown>) => {
          if (v.total_commits !== total || !Array.isArray(v.commits) || v.commits.length !== Math.min(100, total - checked)) throw failure();
          for (const c of v.commits) {
            if (!object(c) || !object(c.commit) || !object(c.commit.author) || c.commit.author.name !== 'Orka Publisher' || c.commit.author.email !== 'publisher@orka.ai') throw failure();
          }
          checked += v.commits.length;
        };
        step = 'authors'; authors(first);
        while (checked < total) authors(await get(`${root}/compare/${baseSHA}...${headSHA}?per_page=100&page=${checked / 100 + 1}`));
        step = 'files'; if (!Array.isArray(first.files) || first.files.length > 300) throw failure(); let additions = 0; let deletions = 0;
        const files = first.files.map(file => {
          if (!object(file) || typeof file.filename !== 'string' || !file.filename || Buffer.byteLength(file.filename) > 4096 || /[\p{Cc}\uD800-\uDFFF]/u.test(file.filename)) throw failure();
          const a = count(file.additions); const d = count(file.deletions); additions = count(additions + a); deletions = count(deletions + d);
          return { path: file.filename, additions: a, deletions: d };
        });
        return { headSHA, baseSHA, githubId: String(user.id), githubLogin: user.login, commits: total,
          // The card previews the largest changes, so keep those when the list is cut to ten.
          files: [...files].sort((a, b) => b.additions + b.deletions - a.additions - a.deletions).slice(0, 10),
          fileCount: files.length, additions, deletions, filesComplete: files.length < 300 };
      })().catch((e: unknown) => { throw new GitHubError(e instanceof GitHubError ? e.code : 'unavailable', step); });
      work.add(pending); void pending.then(() => work.delete(pending), () => work.delete(pending)); return pending;
    },
    tool(tool: GitHubTool, input: unknown, token: string, ctx: DirectoryContext): Promise<{ text: string }> {
      try { active(ctx); if (tool === 'github-propose-pull-request' || !githubTools.includes(tool) || !credential(token) || work.size >= 4) throw failure(); } catch { return Promise.reject(failure()); }
      const pending = (async () => {
        const args = githubArguments(tool, input); const root = `/repos/${encodeURIComponent(args.owner!)}/${encodeURIComponent(args.repo!)}`;
        let path: string; let body: Record<string, string> | undefined;
        if (tool === 'github-read-file') path = `${root}/contents/${args.path!.split('/').map(encodeURIComponent).join('/')}${args.ref === undefined ? '' : '?' + new URLSearchParams({ ref: args.ref })}`;
        else if (tool === 'github-read-issue') path = `${root}/issues/${args.number}`;
        else if (tool === 'github-list-issues') path = `${root}/issues?${new URLSearchParams({ state: args.state ?? 'open', per_page: '30', page: '1' })}`;
        else { path = root + (tool === 'github-create-issue' ? '/issues' : '/pulls'); const { owner: _owner, repo: _repo, ...data } = args; body = data; }
        const value = await json(token, {}, ctx, { path, ...(body ? { body } : {}) }); active(ctx);
        const url = (v: unknown, kind: string) => { if (!object(v) || !Number.isSafeInteger(v.number) || (v.number as number) < 1) throw failure();
          const url = `https://github.com/${args.owner}/${args.repo}/${kind}/${v.number}`;
          if (typeof v.html_url !== 'string' || v.html_url.toLowerCase() !== url.toLowerCase()) throw failure(); return { number: v.number as number, url }; };
        let text: string;
        if (tool === 'github-read-file') {
          if (!object(value) || value.type !== 'file' || value.encoding !== 'base64' || typeof value.content !== 'string') throw failure();
          const encoded = value.content.replace(/[\r\n]/gu, ''); const bytes = Buffer.from(encoded, 'base64');
          if (bytes.length > 32768 || bytes.toString('base64') !== encoded || value.size !== bytes.length) throw failure();
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } else if (tool === 'github-read-issue') {
          if (!object(value) || value.number !== Number(args.number) || typeof value.title !== 'string' || Buffer.byteLength(value.title) > 1024 ||
            !['open', 'closed'].includes(value.state as string) || value.body !== null && typeof value.body !== 'string' || !Array.isArray(value.labels)) throw failure();
          const result = url(value, 'pull_request' in value ? 'pull' : 'issues');
          const labels = value.labels.slice(0, 20).map(l => { const name = object(l) ? l.name : l;
            if (typeof name !== 'string' || Buffer.byteLength(name) > 256) throw failure(); return name; });
          const [body, truncated] = clip(value.body ?? '', ISSUE_BODY_BYTES);
          text = JSON.stringify({ number: result.number, title: value.title, state: value.state, labels, url: result.url, body,
            ...(truncated ? { bodyTruncated: `Body cut at ${ISSUE_BODY_BYTES} bytes; the full text is at url.` } : {}) });
        } else if (tool === 'github-list-issues') {
          if (!Array.isArray(value) || value.length > 30) throw failure();
          text = JSON.stringify(value.map(v => { const result = url(v, object(v) && 'pull_request' in v ? 'pull' : 'issues');
            if (!object(v) || typeof v.title !== 'string' || Buffer.byteLength(v.title) > 1024 || !['open', 'closed'].includes(v.state as string)) throw failure();
            return { number: result.number, title: v.title, state: v.state, url: result.url }; }));
        } else text = JSON.stringify(url(value, tool === 'github-create-issue' ? 'issues' : 'pull'));
        if (Buffer.byteLength(text) > 32768 || text.includes(token) || text.includes(config.clientSecret)) throw failure(); return { text };
      })().catch((e: unknown) => { throw e instanceof GitHubError ? e : failure(); });
      work.add(pending); void pending.then(() => work.delete(pending), () => work.delete(pending)); return pending;
    },
    authorizeUrl(attempt: BrowserAttempt): string {
      if (closed) throw failure();
      return `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri,
        scope: 'offline_access', state: attempt.state, code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'), code_challenge_method: 'S256' })}`;
    },
    redeemCode(code: string, attempt: BrowserAttempt, ctx: DirectoryContext): Promise<AccountTokens> {
      return exchange({ code, code_verifier: attempt.verifier, redirect_uri: redirectUri }, ctx);
    },
    refresh(refreshToken: string, ctx: DirectoryContext): Promise<AccountTokens> { return exchange({ grant_type: 'refresh_token', refresh_token: refreshToken }, ctx); },
    async close(): Promise<void> { closed = true; shutdown.abort(); await Promise.allSettled(work); config.clientSecret = ''; },
  };
}
