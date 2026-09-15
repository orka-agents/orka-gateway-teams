import type { ManagedIdentityHost } from './credentials.js';
import type { ImdsRequest } from './imds.js';
import type { TableDependencies } from '../storage/table/types.js';
import { prepareAcaIdentity, assertAcaEnvironment } from './aca.js';
import { requestIdentityJSON } from './identity-http.js';
import { tlsVerificationEnabled } from '../ingress/config.js';

export interface StorageIdentityConfig { host: ManagedIdentityHost; clientId: string }
export interface StorageIdentityDependencies { request?: ImdsRequest }
export interface StorageTokenProvider { token: TableDependencies['token']; close(): Promise<void> }
export interface PreparedStorageIdentity {
  assertUsable(): void;
  createProvider(dependencies?: StorageIdentityDependencies): StorageTokenProvider;
}
interface CacheEntry { token: string; expiresAt: number; receivedAt: number; receivedMono: number }

/** Synchronous preparation pins the platform source before any store can own resources. */
export function prepareStorageIdentity(input: Readonly<StorageIdentityConfig>): PreparedStorageIdentity {
  try {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => key !== 'host' && key !== 'clientId')) throw failure();
    const host = input.host;
    if (host !== 'imds' && host !== 'azure-container-apps') throw failure();
    const clientId = canonicalClientId(input.clientId);
    let aca = host === 'azure-container-apps' ? prepareAcaIdentity() : undefined;
    let created = false; let closed = false;
    const assertUsable = () => {
      try {
        if (closed || !tlsVerificationEnabled() || !Number.isFinite(Date.now()) || !Number.isFinite(performance.now())) throw failure();
        if (host === 'azure-container-apps') aca!.assertUsable();
        else {
          assertAcaEnvironment();
          // Like bot IMDS, tolerate but never read the unused ACI header.
          if (process.env.IDENTITY_ENDPOINT !== undefined) throw failure();
        }
      } catch { throw new Error('Invalid storage identity credentials'); }
    };
    assertUsable();
    return { assertUsable, createProvider(dependencies = {}) {
      if (created) throw new Error('Invalid storage identity credentials'); created = true;
      assertUsable();
      let request = dependencies.request;
      if (request !== undefined && typeof request !== 'function') throw new Error('Invalid storage identity credentials');
      let cache: CacheEntry | undefined; let flight: Promise<CacheEntry> | undefined; let closing: Promise<void> | undefined;
      const callers = new Set<Promise<string>>();
      const refresh = async (): Promise<CacheEntry> => {
        assertUsable();
        let response: Record<string, unknown>;
        if (aca) response = await aca.requestStorageToken(clientId, request);
        else {
          const url = new URL('http://169.254.169.254/metadata/identity/oauth2/token');
          url.search = new URLSearchParams({ 'api-version': '2018-02-01', resource: 'https://storage.azure.com/', client_id: clientId }).toString();
          response = await requestIdentityJSON(url, { Metadata: 'true' }, request);
        }
        assertUsable();
        const entry = storageEnvelope(response, clientId); cache = entry; return entry;
      };
      const token: TableDependencies['token'] = (scope, context) => {
        try {
          if (scope !== 'https://storage.azure.com/.default' || closing || callers.size >= 32) throw failure();
          assertUsable();
          // Snapshot caller eligibility before awaiting shared work; never retain a mutable context.
          const signal = context.signal; const deadline = context.deadline;
          const eligible = () => !signal.aborted && Number.isFinite(deadline) && Number.isFinite(performance.now()) && performance.now() < deadline;
          if (!eligible()) throw failure();
          const pending = (async () => {
            let entry = cache;
            const wall = Date.now(); const mono = performance.now();
            if (!entry || wall < entry.receivedAt || mono < entry.receivedMono || wall >= entry.expiresAt - 60000 ||
                wall >= entry.receivedAt + 300000 || mono >= entry.receivedMono + 300000) {
              cache = undefined;
              if (!flight) {
                flight = refresh();
                void flight.then(() => { flight = undefined; }, () => { flight = undefined; });
              }
              // Cancellation is eligibility, not completion: keep this actual caller's
              // reservation until the shared native request AND socket have drained.
              entry = await flight;
            }
            assertUsable();
            if (closing || !eligible() || Date.now() >= entry.expiresAt) throw failure();
            return entry.token;
          })().catch(() => { throw failure(); });
          callers.add(pending);
          void pending.then(() => callers.delete(pending), () => callers.delete(pending));
          return pending;
        } catch { return Promise.reject(failure()); }
      };
      return { token, close() {
        closing ??= Promise.allSettled([...callers]).then(() => {
          closed = true; cache = undefined; flight = undefined; request = undefined; aca = undefined;
        });
        return closing;
      } };
    } };
  } catch { throw new Error('Invalid storage identity credentials'); }
}

function storageEnvelope(body: Record<string, unknown>, clientId: string): CacheEntry {
  const token = body.access_token;
  const expires = typeof body.expires_on === 'string' && /^\d{1,16}$/u.test(body.expires_on) ? Number(body.expires_on) : body.expires_on;
  const wall = Date.now(); const mono = performance.now();
  if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(token) || body.token_type !== 'Bearer' ||
      body.resource !== 'https://storage.azure.com/' || typeof expires !== 'number' || !Number.isFinite(expires * 1000) || expires * 1000 <= wall ||
      (body.client_id !== undefined && canonicalClientId(body.client_id) !== clientId)) throw failure();
  return { token, expiresAt: expires * 1000, receivedAt: wall, receivedMono: mono };
}
function canonicalClientId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw failure();
  return value.toLowerCase();
}
function failure(): Error { return new Error('Storage token unavailable'); }
