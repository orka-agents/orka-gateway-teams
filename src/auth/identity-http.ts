import http from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { ImdsRequest } from './imds.js';
import { tlsVerificationEnabled } from '../ingress/config.js';

/** Internal transport for purpose-bound wrappers, never a caller-configurable metadata proxy. */
export async function requestIdentityJSON(endpoint: URL, headers: Record<string, string>, request: ImdsRequest = http.request): Promise<Record<string, unknown>> {
  try {
    if (!tlsVerificationEnabled()) throw failure();
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      let req: ClientRequest | undefined; let response: IncomingMessage | undefined; let result: Record<string, unknown> | undefined;
      let failed = false; let requestClosed = false; let socketClosed = true;
      const deadline = performance.now() + 5000;
      const expired = () => !Number.isFinite(performance.now()) || performance.now() >= deadline;
      if (!Number.isFinite(deadline)) throw failure();
      const finish = () => {
        if (!requestClosed || !socketClosed) return;
        clearTimeout(timer);
        if (!failed && result && !expired() && tlsVerificationEnabled()) resolve(result); else reject(failure());
      };
      const abort = () => { failed = true; result = undefined; response?.destroy(); req?.destroy(); };
      const timer = setTimeout(abort, 5000);
      try {
        req = request(endpoint, { method: 'GET', headers: { ...headers, Connection: 'close' }, agent: false, maxHeaderSize: 16384 }, res => {
          response = res; res.on('error', abort); res.on('aborted', abort);
          if (res.statusCode !== 200 || (res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity')) { abort(); return; }
          const chunks: Buffer[] = []; let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 65536 || expired()) abort(); else chunks.push(Buffer.from(chunk));
          });
          res.on('end', () => {
            try {
              if (failed || !res.complete || expired() || !tlsVerificationEnabled()) throw failure();
              const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
              const body: unknown = JSON.parse(text);
              if (!body || typeof body !== 'object' || Array.isArray(body) || 'error' in body) throw failure();
              result = body as Record<string, unknown>;
            } catch { abort(); }
          });
        });
        req.once('socket', socket => {
          socketClosed = false; socket.once('close', () => { socketClosed = true; finish(); });
        });
        req.on('error', () => { failed = true; });
        req.once('close', () => { requestClosed = true; finish(); });
        if (expired()) abort(); else req.end();
      } catch {
        abort(); if (!req) { requestClosed = true; finish(); }
      }
    });
  } catch { throw failure(); }
}
function failure(): Error { return new Error('Identity token unavailable'); }
