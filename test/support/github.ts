import assert from 'node:assert/strict';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { httpsFixture } from './ingress-https.js';
export const githubPair = () => ({ access_token: 'ghu_ACCESS_PRIVATE', refresh_token: 'ghr_REFRESH_PRIVATE', token_type: 'bearer',
  expires_in: 28800, refresh_token_expires_in: 15897600, scope: '' });
export async function githubFixture(t: Parameters<typeof httpsFixture>[0]) {
  const requests: { url: string; method: string; headers: IncomingMessage['headers']; form: URLSearchParams }[] = [];
  let behavior: (req: IncomingMessage, res: ServerResponse) => void = (req, res) => res.end(JSON.stringify(req.url === '/user' ? { id: 12345, login: 'changeable', email: 'not-identity@example.invalid' } : githubPair()));
  let sockets = 0;
  const fixture = await httpsFixture(t, async (req, res) => {
    const chunks: Buffer[] = []; for await (const b of req) chunks.push(Buffer.from(b));
    requests.push({ url: req.url!, method: req.method!, headers: req.headers, form: new URLSearchParams(Buffer.concat(chunks).toString()) });
    res.setHeader('content-type', 'application/json'); behavior(req, res);
  });
  const request = ((url: URL, options: https.RequestOptions, cb: Parameters<typeof https.request>[2]) => {
    assert.ok(['https://github.com/login/oauth/access_token', 'https://api.github.com/user'].includes(url.href));
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
    const req = https.request(new URL(url.pathname, fixture.baseUrl), { ...options, hostname: '127.0.0.1', servername: 'localhost', ca: fixture.ca }, cb!);
    req.once('socket', socket => { sockets++; socket.once('close', () => sockets--); }); return req;
  }) as typeof https.request;
  return { request, requests, sockets: () => sockets, behavior: (fn: typeof behavior) => { behavior = fn; } };
}
