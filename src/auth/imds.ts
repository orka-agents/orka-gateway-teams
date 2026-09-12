import http from 'node:http';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { tlsVerificationEnabled } from '../ingress/config.js';

/** Native transport seam only; no production URL, proxy or credential override. */
export type ImdsRequest = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

/** The sole plaintext exception: Azure's fixed link-local Linux IMDS endpoint. */
export async function requestManagedIdentity(clientId: string, request: ImdsRequest = http.request): Promise<unknown> {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(clientId) || !tlsVerificationEnabled()) throw failure();
    const endpoint = new URL('http://169.254.169.254/metadata/identity/oauth2/token');
    endpoint.search = new URLSearchParams({ 'api-version': '2018-02-01', resource: 'api://AzureADTokenExchange', client_id: clientId }).toString();
    return await new Promise<unknown>((resolve, reject) => {
      let response: IncomingMessage | undefined; let result: Record<string, unknown> | undefined; let failed = false;
      const deadline = performance.now() + 5000;
      const expired = () => !Number.isFinite(performance.now()) || performance.now() >= deadline;
      if (!Number.isFinite(deadline)) throw failure();
      const abort = () => { failed = true; response?.destroy(); req.destroy(); };
      const req = request(endpoint, { method: 'GET', headers: { Metadata: 'true', Connection: 'close' }, agent: false,
        maxHeaderSize: 16384 }, (res) => {
        response = res; res.on('error', abort); res.on('aborted', abort);
        if (res.statusCode !== 200 || (res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity')) { abort(); return; }
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length; if (size > 65536 || expired()) abort(); else chunks.push(chunk);
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
      const timer = setTimeout(abort, 5000);
      req.on('error', () => { failed = true; });
      // Destruction only initiates cancellation. Sender drain must own the actual request's close.
      req.once('close', () => {
        clearTimeout(timer);
        if (!failed && result && !expired() && tlsVerificationEnabled()) resolve(result); else reject(failure());
      });
      req.end();
    });
  } catch { throw failure(); }
}
function failure(): Error { return new Error('Managed identity token unavailable'); }
