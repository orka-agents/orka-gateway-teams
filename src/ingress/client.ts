import { request } from 'node:https';
import { MAX_ADAPTER_RESPONSE_BYTES } from '../protocol/types.js';
import { decode, encode, integer, invalid, validateEvent, validateReceipt, validateScope } from './codec.js';
import type { IngressScope, OrkaClient, OrkaPostResult } from './types.js';

export function createOrkaClient(inputScope: Readonly<IngressScope>, options: { bearerToken: string; ca?: string | Buffer; timeoutMs?: number }): OrkaClient {
  const scope = validateScope(inputScope);
  const timeoutMs = integer(options.timeoutMs ?? 5000, 1, 2147483647);
  const bearer = options.bearerToken;
  if (typeof bearer !== 'string' || !bearer || bearer.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(bearer)) invalid();
  const ca = Buffer.isBuffer(options.ca) ? Buffer.from(options.ca) : options.ca;
  if (scope.gatewayNamespace === '.' || scope.gatewayNamespace === '..' || scope.gatewayName === '.' || scope.gatewayName === '..') invalid();
  const url = new URL(`api/v1/gateways/${encodeURIComponent(scope.gatewayNamespace)}/${encodeURIComponent(scope.gatewayName)}/events`, scope.orkaBaseUrl);
  return {
    async post(input, signal) {
      let body: Buffer;
      try { body = encode(validateEvent(input)); } catch { return { kind: 'blocked', reason: 'invalid-event' }; }
      if (signal?.aborted) return { kind: 'retry' };
      return new Promise<OrkaPostResult>((resolve) => {
        let settled = false;
        let req: ReturnType<typeof request> | undefined;
        const finish = (result: OrkaPostResult) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          resolve(result); req?.destroy();
        };
        const abort = () => finish({ kind: 'retry' });
        // Absolute deadline, starting before DNS/TLS/request creation. Socket
        // inactivity timeouts alone allow an indefinitely slow-dripping peer.
        const timer = setTimeout(abort, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          req = request(url, { method: 'POST', agent: false, ...(ca === undefined ? {} : { ca }), rejectUnauthorized: true,
            maxHeaderSize: 16 * 1024,
            headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'content-length': body.length, accept: 'application/json' },
          }, (response) => {
            const status = response.statusCode ?? 0;
            if (status !== 202) {
              if (status === 409) finish({ kind: 'blocked', reason: 'conflict' });
              else if ([400, 413, 415].includes(status)) finish({ kind: 'blocked', reason: 'invalid-event' });
              else if (status >= 300 && status < 400) finish({ kind: 'blocked', reason: 'redirect' });
              else {
                const delay = [429, 503].includes(status) ? retryAfter(response.headers['retry-after']) : undefined;
                finish(delay === undefined ? { kind: 'retry' } : { kind: 'retry', retryAfterMs: delay });
              }
              response.destroy(); return;
            }
            const chunks: Buffer[] = []; let size = 0;
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_ADAPTER_RESPONSE_BYTES) { finish({ kind: 'retry' }); response.destroy(); }
              else chunks.push(chunk);
            });
            response.on('error', abort); response.on('aborted', abort);
            response.on('end', () => {
              try { finish({ kind: 'receipt', receipt: validateReceipt(decode(Buffer.concat(chunks))) }); }
              catch { finish({ kind: 'retry' }); }
            });
            response.on('close', () => { if (!response.complete) abort(); });
          });
          req.on('error', abort);
          req.end(body);
          if (signal?.aborted) abort();
        } catch { abort(); }
      });
    },
  };
}

function retryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/u.test(value)) {
    const milliseconds = BigInt(value) * 1000n;
    return milliseconds > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(milliseconds);
  }
  // Do not let Date.parse reinterpret malformed delta-seconds as a calendar date.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), /u.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
