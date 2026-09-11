import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { tlsVerificationEnabled } from './config.js';

export const PUBLIC_JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
const ISSUER = 'https://api.botframework.com';
const CACHE_MS = 300000;
const FETCH_MS = 5000;
const MAX_KEYS_BYTES = 2 * 1024 * 1024;
export type FetchKeys = (url: string, options: RequestInit) => Promise<Response>;

/** Supplemental public-cloud profile; the SDK must independently verify afterward. */
export function createStrictAuth(appId: string, fetchKeys: FetchKeys = fetch) {
  let keys = new Map<string, Record<string, unknown>>();
  let expires = 0; let nextFetch = 0; let loading: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    const now = performance.now();
    if (now < expires) return;
    if (loading) return loading;
    if (now < nextFetch) throw new Error('Keys unavailable');
    nextFetch = now + FETCH_MS;
    loading = (async () => {
      const response = await fetchKeys(PUBLIC_JWKS_URL, { signal: AbortSignal.timeout(FETCH_MS), redirect: 'error',
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' } });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Keys unavailable'); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > MAX_KEYS_BYTES) throw new Error('Keys unavailable');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!record(data) || !Array.isArray(data.keys) || !data.keys.length || data.keys.length > 1024) throw new Error('Keys unavailable');
      const fresh = new Map<string, Record<string, unknown>>();
      for (const key of data.keys) {
        if (!record(key) || typeof key.kid !== 'string' || !key.kid || key.kid.length > 256 || fresh.has(key.kid)) throw new Error('Keys unavailable');
        fresh.set(key.kid, key);
      }
      if (!tlsVerificationEnabled()) throw new Error('Keys unavailable');
      keys = fresh; expires = performance.now() + CACHE_MS;
    })();
    try { await loading; } finally { loading = undefined; }
  }

  return async (authorization: unknown, body: unknown): Promise<boolean> => {
    try {
      if (!tlsVerificationEnabled()) return false;
      if (typeof authorization !== 'string' || authorization.length > 12000 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(authorization) ||
          !record(body) || typeof body.serviceUrl !== 'string' || !body.serviceUrl) return false;
      const raw = authorization.slice(7);
      const decoded = jwt.decode(raw, { complete: true });
      if (!decoded || decoded.header.alg !== 'RS256' || typeof decoded.header.kid !== 'string' ||
          !decoded.header.kid || decoded.header.kid.length > 256) return false;
      await refresh();
      if (!tlsVerificationEnabled()) return false;
      // A cache miss never triggers a per-kid refresh. Rotation becomes visible
      // after five minutes; attacker-controlled kids cannot create a fetch storm.
      const key = keys.get(decoded.header.kid);
      if (!key || key.kty !== 'RSA' || (key.use !== undefined && key.use !== 'sig') ||
          (key.alg !== undefined && key.alg !== 'RS256') || !Array.isArray(key.endorsements) || !key.endorsements.includes('msteams') ||
          typeof key.n !== 'string' || typeof key.e !== 'string') return false;
      const publicKey = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
      const payload = jwt.verify(raw, publicKey, { algorithms: ['RS256'], issuer: ISSUER, audience: appId, clockTolerance: 300 });
      return typeof payload === 'object' && payload.aud === appId && payload.iss === ISSUER &&
        typeof payload.exp === 'number' && Number.isFinite(payload.exp) &&
        typeof payload.nbf === 'number' && Number.isFinite(payload.nbf) && payload.exp > payload.nbf &&
        typeof payload.serviceurl === 'string' && payload.serviceurl === body.serviceUrl;
    } catch { return false; }
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
