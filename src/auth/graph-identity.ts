import { tlsVerificationEnabled } from '../ingress/config.js';
import { uuid } from '../policy/config.js';
import { prepareAcaIdentity } from './aca.js';
import type { ImdsRequest } from './imds.js';

export interface PolicyRequestContext { readonly signal: AbortSignal; readonly deadline: number }
export interface GraphIdentity {
  assertUsable(): void;
  token(context: PolicyRequestContext): Promise<string>;
  close(): Promise<void>;
}
/** Separate application purpose; never borrows a bot/storage token or arbitrary audience. */
export function createGraphIdentity(input: string, dependencies: { request?: ImdsRequest } = {}): GraphIdentity {
  try {
    const clientId = uuid(input); const aca = prepareAcaIdentity(); const request = dependencies.request;
    if (request !== undefined && typeof request !== 'function') throw failure();
    let closing: Promise<void> | undefined; const work = new Set<Promise<string>>();
    const assertUsable = () => { if (closing || !tlsVerificationEnabled()) throw failure(); aca.assertUsable(); };
    assertUsable();
    return Object.freeze({ assertUsable,
      token(context: PolicyRequestContext): Promise<string> {
        try {
          assertUsable(); const { signal, deadline } = context;
          const eligible = () => !signal.aborted && Number.isFinite(deadline) && Number.isFinite(performance.now()) && performance.now() < deadline;
          if (!eligible() || work.size >= 32) throw failure();
          const operation = (async () => {
            // Caller eligibility never releases native ownership: acquisition drains in identity-http.
            const body = await aca.requestGraphToken(clientId, request); assertUsable();
            const expires = typeof body.expires_on === 'string' && /^\d{1,16}$/u.test(body.expires_on) ? Number(body.expires_on) : body.expires_on;
            const wall = Date.now(); const token = body.access_token;
            if (!eligible() || !Number.isFinite(wall) || typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(token) ||
                body.token_type !== 'Bearer' || body.resource !== 'https://graph.microsoft.com/' || typeof expires !== 'number' ||
                !Number.isFinite(expires * 1000) || expires * 1000 <= wall || (body.client_id !== undefined && uuid(body.client_id) !== clientId)) throw failure();
            return token;
          })().catch(() => { throw failure(); });
          work.add(operation); void operation.then(() => work.delete(operation), () => work.delete(operation)); return operation;
        } catch { return Promise.reject(failure()); }
      },
      close() { closing ??= Promise.allSettled([...work]).then(() => {}); return closing; },
    });
  } catch { throw new Error('Invalid Graph identity credentials'); }
}
function failure(): Error { return new Error('Graph token unavailable'); }
