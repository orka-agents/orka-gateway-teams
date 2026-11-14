import assert from 'node:assert/strict';
import https from 'node:https';
import { httpsFixture } from './ingress-https.js';
export const completed = (id: unknown, text = 'Answer') => ({ jsonrpc: '2.0', id, result: { task: { id: 'provider-task', contextId: 'private-context',
  status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'artifact', parts: [{ text }] }] } } });

export async function workIQFixture(t: Parameters<typeof httpsFixture>[0]) {
  const bodies: Record<string, any>[] = []; let behavior: (req: Parameters<Parameters<typeof httpsFixture>[1]>[0], res: Parameters<Parameters<typeof httpsFixture>[1]>[1], body: any) => void = (_req, res, body) => res.end(JSON.stringify(completed(body.id)));
  const fixture = await httpsFixture(t, async (req, res) => {
    assert.equal(req.url, '/a2a/'); assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer ACCESS-PRIVATE');
    assert.equal(req.headers['a2a-version'], '1.0');
    const chunks: Buffer[] = []; for await (const b of req) chunks.push(Buffer.from(b));
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); res.setHeader('content-type', 'application/json'); behavior(req, res, body);
  });
  const request = ((url: URL, options: https.RequestOptions, cb: Parameters<typeof https.request>[2]) => {
    assert.equal(url.href, 'https://workiq.svc.cloud.microsoft/a2a/'); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
    return https.request(new URL(url.pathname, fixture.baseUrl), { ...options, hostname: '127.0.0.1', servername: 'localhost', ca: fixture.ca }, cb!);
  }) as typeof https.request;
  return { request, bodies, behavior: (fn: typeof behavior) => { behavior = fn; } };
}
