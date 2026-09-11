import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { PUBLIC } from '@microsoft/teams.api';
import { personalMessage } from '../fixtures/incoming.js';

export const appId = '22222222-2222-4222-8222-222222222222';
export const tenantId = '11111111-1111-4111-8111-111111111111';
export const serviceUrl = 'https://teams-service.example.invalid/';
export const recipientId = '28:fixture-app';
export const receiverConfig = { appId, tenantId, clientSecret: randomUUID(), recipientIds: [recipientId],
  serviceUrls: [serviceUrl], host: '127.0.0.1', port: 0 };
export const scope = { appId, tenantId, orkaBaseUrl: 'https://orka.example.invalid/', gatewayNamespace: 'default', gatewayName: 'teams' };
export function activity(): Record<string, any> { return JSON.parse(JSON.stringify(personalMessage)); }

export async function authFixture(t: TestContext) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const key = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256', endorsements: ['msteams'] };
  let keys: unknown[] = [key]; let sdkKeys: unknown[] | undefined; let requests = 0; let strictRequests = 0;
  let sdkGate: Promise<void> | undefined; let strictGate: Promise<void> | undefined;
  const server = createServer(async (req, res) => {
    requests++; const strict = req.url === '/strict-keys'; if (strict) strictRequests++;
    if (strict) await strictGate; else await sdkGate;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: strict ? keys : sdkKeys ?? keys }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing fixture listener');
  const base = `http://127.0.0.1:${address.port}`;
  const dependencies = { sdkCloud: { ...PUBLIC, openIdMetadataUrl: `${base}/openidconfiguration` },
    fetchKeys: (_url: string, options: RequestInit) => fetch(`${base}/strict-keys`, options) };
  function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    // A JSON string permits deliberately invalid/missing registered claims while
    // jsonwebtoken still performs the real RS256 signature, not hand-rolled crypto.
    return jwt.sign(JSON.stringify({ iss: 'https://api.botframework.com', aud: appId, exp: now + 3600, nbf: now - 10,
      serviceurl: serviceUrl, ...overrides }), privateKey, { algorithm: 'RS256', header: { alg: 'RS256', typ: 'JWT', kid, ...header } });
  }
  return { dependencies, token, key, setKeys: (value: unknown[]) => { keys = value; }, requests: () => requests,
    strictRequests: () => strictRequests, setSdkKeys: (value: unknown[]) => { sdkKeys = value; },
    delaySdk: (gate: Promise<void>) => { sdkGate = gate; }, delayStrict: (gate: Promise<void>) => { strictGate = gate; },
    signPayload: (payload: string) => jwt.sign(payload, privateKey, { algorithm: 'RS256', header: { alg: 'RS256', typ: 'JWT', kid } }) };
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function post(port: number, token: string, body: unknown = activity()) {
  return fetch(`http://127.0.0.1:${port}/api/messages`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
