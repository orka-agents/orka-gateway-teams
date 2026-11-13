import { createPublicKey } from 'node:crypto';
import https from 'node:https';
import type { ClientRequest } from 'node:http';
import jwt from 'jsonwebtoken';
import { prepareFederatedAssertion } from './managed-identity.js';
import type { ManagedIdentityDependencies } from './managed-identity.js';
import type { ReceiverConfig } from '../ingress/config.js';
import { tlsVerificationEnabled, validateReceiverConfig } from '../ingress/config.js';
import type { DirectoryContext } from '../directory/types.js';
import type { FetchKeys } from '../ingress/auth.js';
import type { AccountTokens } from '../accounts/store.js';

export const WORK_IQ_SCOPE = 'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask';
export class DelegatedAuthError extends Error {
  constructor(readonly code: 'invalid-grant' | 'unavailable' = 'unavailable') { super('Delegated sign-in unavailable'); }
}
const failure = () => new DelegatedAuthError();
/** Separate from Bot authentication/cache: only the verified sender assertion goes to OBO. */
export function createDelegatedAuth(input: ReceiverConfig, deps: {
  fetchKeys?: FetchKeys; managedIdentity?: ManagedIdentityDependencies; request?: typeof https.request;
} = {}) {
  const config = validateReceiverConfig(input);
  if (config.credentialMode !== 'managed-identity-federation') throw failure();
  const assertion = prepareFederatedAssertion(config, deps.managedIdentity);
  const root = `https://login.microsoftonline.com/${config.tenantId.toLowerCase()}`;
  const fetchKeys = deps.fetchKeys ?? fetch; const request = deps.request ?? https.request;
  let cached: Record<string, unknown>[] = []; let expires = 0; let nextFetch = 0; let loading: Promise<void> | undefined;
  let closed = false; const shutdown = new AbortController(); const work = new Set<Promise<unknown>>();
  const active = (ctx: DirectoryContext) => {
    if (closed || ctx.signal.aborted || performance.now() >= ctx.deadline || !Number.isFinite(ctx.deadline) || !tlsVerificationEnabled()) throw failure();
  };
  function run<T>(ctx: DirectoryContext, action: () => Promise<T>): Promise<T> {
    try { active(ctx); if (work.size >= 4) throw failure(); } catch { return Promise.reject(failure()); }
    const pending = action().then(value => { active(ctx); return value; }).catch((error: unknown) => { throw error instanceof DelegatedAuthError ? error : failure(); });
    work.add(pending); void pending.then(() => work.delete(pending), () => work.delete(pending)); return pending;
  }
  async function keys() {
    if (performance.now() < expires) return;
    if (loading) return loading;
    if (performance.now() < nextFetch) throw failure();
    nextFetch = performance.now() + 5000;
    loading = (async () => {
      const response = await fetchKeys(`${root}/discovery/v2.0/keys`, { redirect: 'error',
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(5000)]), headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' } });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw failure(); }
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 2 * 1024 * 1024) throw failure(); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!object(value) || !Array.isArray(value.keys) || !value.keys.length || value.keys.length > 1024) throw failure();
      const seen = new Set<string>(); const fresh: Record<string, unknown>[] = [];
      for (const key of value.keys) {
        if (!object(key) || typeof key.kid !== 'string' || !key.kid || key.kid.length > 256 || seen.has(key.kid)) throw failure();
        seen.add(key.kid); fresh.push(key);
      }
      cached = fresh; expires = performance.now() + 300000;
    })();
    try { await loading; } finally { loading = undefined; }
  }
  function claims(raw: string) {
    if (typeof raw !== 'string' || raw.length > 12000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(raw)) throw failure();
    const decoded = jwt.decode(raw, { complete: true });
    if (!decoded || decoded.header.alg !== 'RS256' || typeof decoded.header.kid !== 'string') throw failure();
    const key = cached.find(k => k.kid === decoded.header.kid);
    if (!key || key.kty !== 'RSA' || key.use !== undefined && key.use !== 'sig' || key.alg !== undefined && key.alg !== 'RS256' ||
      typeof key.n !== 'string' || typeof key.e !== 'string') throw failure();
    const result = jwt.verify(raw, createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: key.n, e: key.e } }),
      { algorithms: ['RS256'], issuer: `${root}/v2.0`, audience: config.appId });
    if (typeof result === 'string' || result.aud !== config.appId || typeof result.exp !== 'number' || !Number.isFinite(result.exp) ||
      result.exp * 1000 <= Date.now() || result.tid !== config.tenantId || typeof result.oid !== 'string' ||
      typeof result.scp !== 'string' || !result.scp.split(' ').includes('access_as_user')) throw failure();
    return result;
  }
  function post(body: Buffer, ctx: DirectoryContext): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let req: ClientRequest | undefined; let requestClosed = false; let socketClosed = true;
      let result: Record<string, unknown> | undefined; let failed = false; let reason: Error = failure();
      const finish = () => {
        if (!requestClosed || !socketClosed) return;
        clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); shutdown.signal.removeEventListener('abort', abort);
        if (result && !failed) resolve(result); else reject(reason);
      };
      const abort = () => { failed = true; req?.destroy(); };
      const timer = setTimeout(abort, Math.max(1, Math.min(8000, ctx.deadline - performance.now())));
      ctx.signal.addEventListener('abort', abort, { once: true }); shutdown.signal.addEventListener('abort', abort, { once: true });
      try {
        active(ctx);
        req = request(new URL(`${root}/oauth2/v2.0/token`), { method: 'POST', agent: false, rejectUnauthorized: true, maxHeaderSize: 16384,
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length), Accept: 'application/json', Connection: 'close' } }, res => {
          const chunks: Buffer[] = []; let size = 0;
          res.on('error', abort); res.on('aborted', abort);
          res.on('data', (b: Buffer) => { size += b.length; if (size > 65536) abort(); else chunks.push(b); });
          res.on('end', () => {
            try {
              active(ctx);
              if (!res.complete || res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity') throw failure();
              const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
              if (res.statusCode === 400 && object(value) && value.error === 'invalid_grant') throw new DelegatedAuthError('invalid-grant');
              if (res.statusCode !== 200 || !object(value) || 'error' in value) throw failure(); result = value;
            } catch (error) { failed = true; if (error instanceof DelegatedAuthError) reason = error; }
            req?.destroy();
          });
        });
        req.once('socket', socket => { socketClosed = false; socket.once('close', () => { socketClosed = true; finish(); }); });
        req.once('error', () => { failed = true; }); req.once('close', () => { requestClosed = true; finish(); });
        active(ctx); req.end(body);
      } catch { abort(); if (!req) { requestClosed = true; finish(); } }
    });
  }
  return {
    verify(raw: string, objectId: string, ctx: DirectoryContext): Promise<{ assertionExpiresAt: number }> {
      return run(ctx, async () => { await keys(); active(ctx); const p = claims(raw);
        if (p.oid !== objectId) throw failure(); return { assertionExpiresAt: Math.min(p.exp! * 1000, Date.now() + 600000) }; });
    },
    exchange(raw: string, ctx: DirectoryContext): Promise<AccountTokens> {
      return run(ctx, async () => {
        await keys(); active(ctx); const p = claims(raw);
        if (ctx.deadline - performance.now() < 1000) throw failure();
        const federated = await assertion(); active(ctx);
        const body = Buffer.from(new URLSearchParams({ client_id: config.appId, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: federated, grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', requested_token_use: 'on_behalf_of', assertion: raw, scope: WORK_IQ_SCOPE }).toString());
        const value = await post(body, ctx); active(ctx);
        if (typeof value.access_token !== 'string' || value.access_token.length > 16384 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(value.access_token) ||
          value.token_type !== 'Bearer' || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86400 ||
          typeof value.scope !== 'string' || !value.scope.split(' ').some(s => s === WORK_IQ_SCOPE || s === 'WorkIQAgent.Ask')) throw failure();
        return { accessToken: value.access_token, expiresAt: Date.now() + value.expires_in * 1000, assertion: raw,
          assertionExpiresAt: Math.min(p.exp! * 1000, Date.now() + 600000) };
      });
    },
    async close() { closed = true; shutdown.abort(); await Promise.allSettled([...work]); cached = []; },
  };
}
function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
