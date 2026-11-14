import { createHash } from 'node:crypto';
import type { ClientRequest } from 'node:http';
import https from 'node:https';
import type { AccountTokens, BrowserAttempt } from './store.js';
import type { DirectoryContext } from '../directory/types.js';
import { tlsVerificationEnabled } from '../ingress/config.js';
import { object as fields } from '../storage/table/codec.js';
import { githubTools } from './grants.js';
import type { GitHubTool } from './grants.js';

export class GitHubError extends Error { constructor(readonly code = 'unavailable') { super('GitHub sign-in unavailable'); } }
export function githubArguments(tool: GitHubTool, input: unknown): Record<string, string> {
  const keys = tool === 'github-read-file' ? ['path', 'ref'] : tool === 'github-list-issues' ? ['state'] :
    tool === 'github-create-issue' ? ['title', 'body'] : ['title', 'body', 'head', 'base'];
  const v = fields(input, ['owner', 'repo', ...keys]); const out: Record<string, string> = {};
  const text = (key: string, max: number, optional = false) => {
    const value = v[key]; if (value === undefined && optional) return;
    if (typeof value !== 'string' || Buffer.byteLength(value) > max || key !== 'body' && !value.trim() ||
      /[\uD800-\uDFFF]/u.test(value) || /\p{Cc}/u.test(key === 'body' ? value.replace(/[\t\r\n]/gu, '') : value)) throw failure(); out[key] = value;
  };
  text('owner', 100); text('repo', 100);
  if (!/^[A-Za-z0-9-]+$/u.test(out.owner!) || !/^[A-Za-z0-9_.-]+$/u.test(out.repo!) || ['.', '..'].includes(out.repo!)) throw failure();
  for (const key of keys) text(key, key === 'body' ? 16384 : key === 'path' ? 1024 : 256, ['body', 'ref', 'state'].includes(key));
  if (tool === 'github-read-file' && (out.path!.includes('\\') || out.path!.split('/').some(s => !s || s === '.' || s === '..'))) throw failure();
  if (out.state !== undefined && !['open', 'closed', 'all'].includes(out.state)) throw failure(); return out;
}

const failure = () => new GitHubError();
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
    api?: { path: string; body?: Record<string, string> }): Promise<unknown> {
    // REST issue/PR objects carry unreturned metadata; keep OAuth's smaller credential-response bound.
    const maxResponseBytes = api ? 1024 * 1024 : 65536;
    const body = api?.body ? Buffer.from(JSON.stringify(api.body)) : userToken ? undefined : Buffer.from(new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }).toString());
    return new Promise((resolve, reject) => {
      let req: ClientRequest | undefined; let requestClosed = false; let socketClosed = true;
      let result: unknown; let failed = false; let reason = failure();
      const finish = () => {
        if (!requestClosed || !socketClosed) return;
        clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); shutdown.signal.removeEventListener('abort', abort);
        if (result !== undefined && !failed) resolve(result); else reject(reason);
      };
      const abort = () => { failed = true; req?.destroy(); };
      const timer = setTimeout(abort, Math.max(1, Math.min(8000, ctx.deadline - performance.now()))); timer.unref();
      ctx.signal.addEventListener('abort', abort, { once: true }); shutdown.signal.addEventListener('abort', abort, { once: true });
      try {
        active(ctx);
        req = request(new URL(api ? `https://api.github.com${api.path}` : userToken ? 'https://api.github.com/user' : 'https://github.com/login/oauth/access_token'), {
          method: body ? 'POST' : 'GET', agent: false, rejectUnauthorized: true, maxHeaderSize: 16384,
          headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', Connection: 'close',
            ...(userToken ? { Authorization: `Bearer ${userToken}`, 'User-Agent': 'orka-gateway-teams', 'X-GitHub-Api-Version': '2026-03-10' } : {}),
            ...(body ? { 'Content-Type': api ? 'application/json' : 'application/x-www-form-urlencoded', 'Content-Length': body.length } : {}) } }, res => {
          const chunks: Buffer[] = []; let size = 0;
          res.on('error', abort); res.on('aborted', abort);
          res.on('data', (b: Buffer) => { size += b.length; if (size > maxResponseBytes) abort(); else chunks.push(b); });
          res.on('end', () => {
            try {
              active(ctx);
              if (api && res.statusCode === 401) throw new GitHubError('unauthorized');
              if (res.statusCode !== (api?.body ? 201 : 200) || !res.complete || res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity' ||
                !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(res.headers['content-type'] ?? '')) throw failure();
              const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
              if ((!object(value) && !Array.isArray(value)) || object(value) && 'error' in value) throw failure(); result = value;
            } catch (e) { failed = true; if (e instanceof GitHubError) reason = e; }
            req?.destroy();
          });
        });
        req.once('socket', socket => { socketClosed = false; socket.once('close', () => { socketClosed = true; finish(); }); });
        req.once('error', () => { failed = true; }); req.once('close', () => { requestClosed = true; finish(); });
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
  return {
    safeOutput: (text: string) => !text.includes(config.clientSecret),
    tool(tool: GitHubTool, input: unknown, token: string, ctx: DirectoryContext): Promise<{ text: string }> {
      try { active(ctx); if (!githubTools.includes(tool) || !credential(token) || work.size >= 4) throw failure(); } catch { return Promise.reject(failure()); }
      const pending = (async () => {
        const args = githubArguments(tool, input); const root = `/repos/${encodeURIComponent(args.owner!)}/${encodeURIComponent(args.repo!)}`;
        let path: string; let body: Record<string, string> | undefined;
        if (tool === 'github-read-file') path = `${root}/contents/${args.path!.split('/').map(encodeURIComponent).join('/')}${args.ref === undefined ? '' : '?' + new URLSearchParams({ ref: args.ref })}`;
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
