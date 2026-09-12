import type { TokenCredentials } from '@microsoft/teams.api';
import { assertManagedIdentityEnvironment, validateBotCredential } from './credentials.js';
import type { SharedBotCredentialConfig } from './credentials.js';
import type { INetworkModule } from '@azure/msal-node';
import { certificateTokenEndpoint, createCertificateNetwork, validAccessToken } from './network.js';
import { createAppToken } from './app-token.js';
import { requestManagedIdentity } from './imds.js';
import type { ImdsRequest } from './imds.js';
import { tlsVerificationEnabled } from '../ingress/config.js';

type ManagedIdentityConfig = Extract<SharedBotCredentialConfig, { credentialMode: 'managed-identity-federation' }> & { appId: string; tenantId: string };
export interface ManagedIdentityDependencies { imdsRequest?: ImdsRequest; entraNetwork?: INetworkModule }
export interface PreparedManagedIdentity { assertUsable(): void; createToken(dependencies?: ManagedIdentityDependencies): TokenCredentials['token'] }

/** Structural preparation only: no credential files, CCA, requests or descriptors. */
export function prepareManagedIdentity(input: ManagedIdentityConfig): PreparedManagedIdentity {
  try {
    const config = validateBotCredential(input); if (config.credentialMode !== 'managed-identity-federation') throw new Error();
    const appId = input.appId; const tenantId = input.tenantId; const endpoint = certificateTokenEndpoint(tenantId);
    const assertUsable = () => {
      try { assertManagedIdentityEnvironment(); if (!tlsVerificationEnabled() || !Number.isFinite(Date.now())) throw new Error(); }
      catch { throw new Error('Invalid managed identity credentials'); }
    };
    assertUsable(); let created = false;
    return { assertUsable, createToken(dependencies = {}) {
      if (created) throw new Error('Invalid managed identity credentials'); created = true;
      const { imdsRequest, entraNetwork } = dependencies;
      return createAppToken(appId, tenantId, { clientAssertion: async (options) => {
        assertUsable();
        if (options.clientId !== appId || options.tokenEndpoint !== endpoint || options.fmiPath !== undefined) throw tokenFailure();
        // MSAL resolves this BEFORE its final-token cache lookup. Fresh IMDS on
        // every acquisition is intentional; no second cache or placeholder assertion.
        const response = await requestManagedIdentity(config.managedIdentityClientId, imdsRequest);
        assertUsable();
        return selectedAssertion(response, tenantId.toLowerCase(), config.managedIdentityPrincipalId);
      } }, assertUsable, entraNetwork ?? createCertificateNetwork(tenantId), tokenFailure);
    } };
  } catch { throw new Error('Invalid managed identity credentials'); }
}

function selectedAssertion(response: unknown, tenantId: string, principalId: string): string {
  if (!response || typeof response !== 'object' || !('access_token' in response) || !validAccessToken(response.access_token)) throw tokenFailure();
  const token = response.access_token;
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  // Safety-check the trusted IMDS response; Entra, not this decoder, verifies its signature.
  if (typeof claims.tid !== 'string' || claims.tid.toLowerCase() !== tenantId ||
      typeof claims.sub !== 'string' || claims.sub.toLowerCase() !== principalId ||
      claims.iss !== `https://login.microsoftonline.com/${tenantId}/v2.0` ||
      (claims.aud !== 'api://AzureADTokenExchange' && claims.aud !== 'fb60f99c-7a34-4190-8149-302f77469936') ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000 + 10) throw tokenFailure();
  return token;
}
function tokenFailure(): Error { return new Error('Managed identity token unavailable'); }
