import { PUBLIC } from '@microsoft/teams.api';
import type { TokenCredentials } from '@microsoft/teams.api';
import { ConfidentialClientApplication } from '@azure/msal-node';
import type { INetworkModule, NetworkRequestOptions, NetworkResponse, NodeAuthOptions } from '@azure/msal-node';
import { certificateTokenEndpoint, validAccessToken, validateOAuthSuccess } from './network.js';

type AppCredential =
  | { clientCertificate: NonNullable<NodeAuthOptions['clientCertificate']>; clientAssertion?: never }
  | { clientAssertion: NonNullable<NodeAuthOptions['clientAssertion']>; clientCertificate?: never };

/** Shared lazy CCA and its in-memory cache; callers own credential preparation and safe errors. */
export function createAppToken(appId: string, tenantId: string, credential: AppCredential, assertUsable: () => void,
  network: INetworkModule, tokenFailure: () => Error): TokenCredentials['token'] {
  const endpoint = certificateTokenEndpoint(tenantId); const authority = `${PUBLIC.loginEndpoint}/${tenantId.toLowerCase()}`;
  let client: ConfidentialClientApplication | undefined;
  const guardedNetwork: INetworkModule = {
    sendGetRequestAsync: async () => { throw tokenFailure(); },
    async sendPostRequestAsync<T>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> {
      // MSAL 5.6 appends only this generated telemetry query even with no
      // extraQueryParameters. Strip it; native I/O still has one exact URL.
      const query = url.slice(endpoint.length);
      if (!url.startsWith(endpoint) || !/^\?client-request-id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(query)) throw tokenFailure();
      assertUsable(); const response = await network.sendPostRequestAsync<unknown>(endpoint, options); assertUsable();
      if (response.status !== 200) throw tokenFailure();
      return { status: 200, headers: {}, body: validateOAuthSuccess(response.body) as T };
    },
  };
  return async (scope, requestedTenant) => {
    try {
      if ((typeof scope === 'string' ? scope !== PUBLIC.botScope : !Array.isArray(scope) || scope.length !== 1 || scope[0] !== PUBLIC.botScope) ||
          (requestedTenant !== undefined && requestedTenant !== tenantId)) throw tokenFailure();
      assertUsable();
      client ??= new ConfidentialClientApplication({ auth: { clientId: appId, authority,
        ...credential, knownAuthorities: [new URL(PUBLIC.loginEndpoint).host],
        authorityMetadata: JSON.stringify({ authorization_endpoint: `${authority}/oauth2/v2.0/authorize`, token_endpoint: endpoint,
          end_session_endpoint: `${authority}/oauth2/v2.0/logout`, issuer: `${authority}/v2.0`,
          jwks_uri: `${PUBLIC.loginEndpoint}/common/discovery/v2.0/keys` }) },
        system: { networkClient: guardedNetwork, disableInternalRetries: true,
          loggerOptions: { loggerCallback: () => {}, piiLoggingEnabled: false } } });
      const result = await client.acquireTokenByClientCredential({ scopes: [PUBLIC.botScope], azureRegion: 'DisableMsalForceRegion' });
      assertUsable();
      if (!result || !validAccessToken(result.accessToken) || !(result.expiresOn instanceof Date) ||
          !Number.isFinite(result.expiresOn.getTime()) || result.expiresOn.getTime() <= Date.now()) throw tokenFailure();
      return result.accessToken;
    } catch { throw tokenFailure(); }
  };
}
