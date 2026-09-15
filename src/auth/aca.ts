import { isIP } from 'node:net';
import type { ImdsRequest } from './imds.js';
import { requestIdentityJSON } from './identity-http.js';

/** Environment selection only. Endpoint/header values never enter structural bot configuration. */
export function assertAcaEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  // ACA also supplies legacy MSI aliases. Leave them untouched and unread; only
  // the canonical IDENTITY_ENDPOINT / IDENTITY_HEADER source is selected below.
  if (env.AZURE_FEDERATED_TOKEN_FILE !== undefined) throw failure();
}

/** Private prepared source: no I/O, public endpoint override, or retained rotating header. */
export function prepareAcaIdentity() {
  const pinned = process.env.IDENTITY_ENDPOINT;
  const endpoint = localEndpoint(pinned);
  const assertUsable = () => {
    assertAcaEnvironment();
    if (process.env.IDENTITY_ENDPOINT !== pinned) throw failure();
    identityHeader();
  };
  assertUsable();
  async function acquire(clientId: string, purpose: 'bot' | 'storage', request?: ImdsRequest): Promise<Record<string, unknown>> {
    assertUsable();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(clientId)) throw failure();
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ 'api-version': '2019-08-01',
      resource: purpose === 'bot' ? 'api://AzureADTokenExchange' : 'https://storage.azure.com/', client_id: clientId }).toString();
    const result = await requestIdentityJSON(url, { 'X-IDENTITY-HEADER': identityHeader() }, request);
    assertUsable(); return result;
  }
  return { assertUsable,
    requestBotAssertion: (clientId: string, request?: ImdsRequest) => acquire(clientId, 'bot', request),
    requestStorageToken: (clientId: string, request?: ImdsRequest) => acquire(clientId, 'storage', request) };
}

function identityHeader(): string {
  const value = process.env.IDENTITY_HEADER;
  if (typeof value !== 'string' || !value.length || value.length > 8192 || /[^\x21-\x7e]/u.test(value)) throw failure();
  return value;
}
function localEndpoint(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 4096 || /[\s\\?#]/u.test(value)) throw failure();
    // Check the literal authority before WHATWG normalization (which accepts hex/short IPv4).
    const match = /^http:\/\/(\[[^\]]+\]|[^/:@]+)(?::[0-9]+)?(\/.*)?$/u.exec(value);
    if (!match) throw failure();
    const literal = match[1]!; const host = literal.startsWith('[') ? literal.slice(1, -1) : literal;
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== (match[2] ?? '/')) throw failure();
    if (host.toLowerCase() === 'localhost') url.hostname = '127.0.0.1';
    else if (isIP(host) === 4) {
      const parts = host.split('.').map(Number);
      if (parts[0] !== 127 && !(parts[0] === 169 && parts[1] === 254)) throw failure();
    } else if (isIP(host) === 6) {
      const canonical = url.hostname.slice(1, -1);
      const first = Number.parseInt(canonical.split(':')[0]!, 16);
      if (canonical !== '::1' && !(first >= 0xfe80 && first <= 0xfebf)) throw failure();
    } else throw failure();
    return url.href;
  } catch { throw failure(); }
}
function failure(): Error { return new Error('Invalid ACA identity source'); }
