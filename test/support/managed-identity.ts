import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingMessage, RequestOptions, ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from '@azure/msal-node';
import { receiverConfig } from './ingress-auth.js';
import { syntheticAccessToken } from './certificate.js';

const { clientSecret: _unused, ...receiver } = receiverConfig;
export const miConfig = { ...receiver, credentialMode: 'managed-identity-federation' as const,
  managedIdentityClientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', managedIdentityPrincipalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
export const entraEndpoint = `https://login.microsoftonline.com/${receiver.tenantId}/oauth2/v2.0/token`;
export function assertion(claims: Record<string, unknown> = {}): string {
  return ['e30', Buffer.from(JSON.stringify({ tid: receiver.tenantId, sub: miConfig.managedIdentityPrincipalId,
    iss: `https://login.microsoftonline.com/${receiver.tenantId}/v2.0`, aud: 'api://AzureADTokenExchange',
    exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url'), 'c3ludGhldGlj'].join('.');
}
export async function imdsFixture(t: TestContext, listener: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
  res.end(JSON.stringify({ access_token: assertion() }));
}) {
  const server = http.createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = http.request; let calls = 0; let closed = 0;
  const imdsRequest = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    calls++;
    assert.equal(url.href, 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=api%3A%2F%2FAzureADTokenExchange&client_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(options.method, 'GET'); assert.equal(options.agent, false); assert.equal(options.maxHeaderSize, 16384);
    const req = request(new URL(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`), options, callback);
    req.once('close', () => { closed++; }); return req;
  };
  return { imdsRequest, calls: () => calls, closed: () => closed };
}
export function entraNetwork(post: (url: string, options?: NetworkRequestOptions) => Promise<NetworkResponse<unknown>> = async () => ({
  status: 200, headers: {}, body: { access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 },
})): INetworkModule {
  return { sendGetRequestAsync: async () => { throw new Error('Unexpected discovery'); },
    sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) => post(url, options) as Promise<NetworkResponse<T>> };
}
