import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { PUBLIC } from '@microsoft/teams.api';
import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from '@azure/msal-node';
import { tlsVerificationEnabled } from '../ingress/config.js';

export function certificateTokenEndpoint(tenantId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(tenantId)) throw failure();
  return `${PUBLIC.loginEndpoint}/${tenantId.toLowerCase()}/oauth2/v2.0/token`;
}

/** One native request, no agent pool/proxy, redirect, discovery, or hidden retry. */
export function createCertificateNetwork(tenantId: string): INetworkModule {
  const endpoint = certificateTokenEndpoint(tenantId);
  return {
    sendGetRequestAsync: async () => { throw failure(); },
    async sendPostRequestAsync<T>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> {
      try {
        if (url !== endpoint || !tlsVerificationEnabled() || typeof options?.body !== 'string' ||
            !options.body.length || Buffer.byteLength(options.body) > 65536) throw failure();
        const headers = { ...options.headers, Host: new URL(endpoint).host, Connection: 'close',
          'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(options.body)) };
        if (Object.entries(headers).reduce((size, [key, value]) => size + Buffer.byteLength(key) + Buffer.byteLength(value) + 4, 0) > 16384) throw failure();
        return await new Promise<NetworkResponse<T>>((resolve, reject) => {
          let response: IncomingMessage | undefined; let result: NetworkResponse<T> | undefined; let failed = false;
          const abort = () => { failed = true; response?.destroy(); req.destroy(); };
          const deadline = performance.now() + 5000;
          const req = https.request(new URL(endpoint), { method: 'POST', headers, agent: false, rejectUnauthorized: true,
            maxHeaderSize: 16384 }, (res) => {
            response = res;
            res.on('error', abort); res.on('aborted', abort);
            if (res.statusCode !== 200 || (res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity')) { abort(); return; }
            const chunks: Buffer[] = []; let size = 0;
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > 65536 || performance.now() >= deadline) abort(); else chunks.push(chunk);
            });
            res.on('end', () => {
              try {
                if (failed || !res.complete || performance.now() >= deadline || !tlsVerificationEnabled()) throw failure();
                const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
                const body = validateOAuthSuccess(JSON.parse(text));
                // MSAL needs no response headers for this single client-credential flow.
                result = { status: 200, headers: {}, body: body as T };
              } catch { abort(); }
            });
          });
          const timer = setTimeout(abort, 5000);
          req.on('error', () => { failed = true; });
          // Destruction is not settlement: wait for the owned native request to close.
          req.once('close', () => { clearTimeout(timer); if (!failed && result) resolve(result); else reject(failure()); });
          req.end(options.body);
        });
      } catch { throw failure(); }
    },
  };
}

export function validAccessToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)) return false;
  try {
    // Syntax only for the trusted OAuth response: keep SDK decoding failures out
    // of MSAL's cache without adding signature verification or claim policy.
    return value.split('.').every((segment, index) => {
      const bytes = Buffer.from(segment, 'base64url');
      if (bytes.toString('base64url') !== segment) return false;
      if (index === 2) return true;
      const object: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
      return object !== null && typeof object === 'object' && !Array.isArray(object);
    });
  } catch { return false; }
}

/** Applied BEFORE MSAL can cache anything, including at the trusted test I/O seam. */
export function validateOAuthSuccess(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  const body = value as Record<string, unknown>;
  if ('error' in body || !validAccessToken(body.access_token) || body.token_type !== 'Bearer') throw failure();
  const expires = duration(body.expires_in, false);
  const selected: Record<string, unknown> = { access_token: body.access_token, token_type: 'Bearer', expires_in: expires };
  for (const field of ['ext_expires_in', 'refresh_in']) if (body[field] !== undefined) selected[field] = duration(body[field], true);
  if (body.scope !== undefined) {
    if (body.scope !== PUBLIC.botScope) throw failure(); selected.scope = body.scope;
  }
  // Optional Entra metadata is not required. Validate types but do not feed user-token
  // or unrelated account/cache fields into this application-only flow.
  for (const field of ['client_info', 'id_token', 'refresh_token', 'foci', 'key_id', 'spa_code', 'spa_accountid']) {
    if (body[field] !== undefined && (typeof body[field] !== 'string' || (body[field] as string).length > 8192 || /\p{Cc}/u.test(body[field] as string))) throw failure();
  }
  for (const field of ['expires_on', 'not_before']) if (body[field] !== undefined) {
    const timestamp = numeric(body[field]);
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 8640000000000 ||
        (field === 'expires_on' ? timestamp * 1000 <= Date.now() : timestamp * 1000 > Date.now())) throw failure();
  }
  return selected;
}
function numeric(value: unknown): number {
  if (typeof value === 'string' && /^\d+$/u.test(value) && value.length <= 16) return Number(value);
  return typeof value === 'number' ? value : NaN;
}
function duration(value: unknown, zero: boolean): number {
  const number = numeric(value);
  if (!Number.isFinite(number) || number < (zero ? 0 : 1) || number > 604800) throw failure(); return number;
}
function failure(): Error { return new Error('Certificate token unavailable'); }
