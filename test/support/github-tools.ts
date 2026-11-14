import assert from 'node:assert/strict';
import https from 'node:https';
import type { TestContext } from 'node:test';
import { httpsFixture } from './ingress-https.js';
export async function toolsFixture(t: TestContext) {
  const requests: { path: string; method: string; authorization: string | undefined; body: any }[] = [];
  let behavior: (req: typeof requests[number], res: import('node:http').ServerResponse) => void = (req, res) => {
    if (req.path.endsWith('/contents/dir/file.txt?ref=feature%2Fone')) res.end(JSON.stringify({ type: 'file', encoding: 'base64', content: 'SGVsbG8K', size: 6 }));
    else if (req.method === 'GET') res.end(JSON.stringify([{ number: 7, title: 'Bug', state: 'open', html_url: 'https://github.com/acme/repo/issues/7', body: 'not forwarded' }]));
    else { res.statusCode = 201; res.end(JSON.stringify({ number: 8, html_url: `https://github.com/acme/repo/${req.path.endsWith('/pulls') ? 'pull' : 'issues'}/8`, body: 'not forwarded' })); }
  };
  const f = await httpsFixture(t, async (req, res) => {
    const chunks: Buffer[] = []; for await (const b of req) chunks.push(Buffer.from(b));
    const value = { path: req.url!, method: req.method!, authorization: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined };
    requests.push(value); assert.equal(req.headers['x-github-api-version'], '2026-03-10'); assert.ok(req.headers['user-agent']);
    res.setHeader('content-type', 'application/json'); behavior(value, res);
  });
  const request = ((url: URL, options: https.RequestOptions, cb: Parameters<typeof https.request>[2]) => {
    assert.equal(url.origin, 'https://api.github.com'); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
    return https.request(new URL(url.pathname + url.search, f.baseUrl), { ...options, ca: f.ca, servername: 'localhost' }, cb!);
  }) as typeof https.request;
  return { request, requests, behavior: (fn: typeof behavior) => { behavior = fn; } };
}
