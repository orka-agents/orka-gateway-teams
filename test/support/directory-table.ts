import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { TestContext } from 'node:test';
import type { DirectoryBinding, DirectoryDependencies, ConnectionRecord } from '../../src/directory/types.js';
import { httpsFixture } from './ingress-https.js';

export const binding: DirectoryBinding = { account: 'example123', table: 'Directory', appId: 'app', tenantId: 'tenant' };
export const key = { kind: 'conn' as const, conversationId: 'chat' };
export function sample(): ConnectionRecord {
  const name = createHash('sha256').update(JSON.stringify(['teams-binding-v1', 'app', 'tenant', 'chat', 'a'.repeat(64)])).digest('hex').slice(0, 56);
  return { schema: 1, kind: 'conn', scope: { appId: 'app', tenantId: 'tenant' }, conversationId: 'chat', chatKind: 'personal',
    targetId: 'tools', identityDigest: 'a'.repeat(64), bindingName: 'teams-'+name, state: 'reserved' };
}
export function context(ms = 30000) { return { signal: new AbortController().signal, deadline: performance.now() + ms }; }
export function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
export async function eventually(check: () => boolean) { for (let i = 0; i < 2000; i++) { if (check()) return; await new Promise(r => setTimeout(r, 2)); } throw new Error('fixture condition not reached'); }
export type DirectoryRequest = { req: IncomingMessage; res: ServerResponse; url: URL; body: Record<string, unknown> | undefined; reply(): void };
export async function directoryFixture(t: TestContext) {
  const rows = new Map<string, Record<string, unknown>>(); const requests: { method: string; url: URL; headers: IncomingMessage['headers'] }[] = [];
  const stats = { tokens: 0, requests: 0, requestCloses: 0, sockets: 0, socketCloses: 0 }; let version = 0;
  const controls: { hook?: (request: DirectoryRequest) => void | Promise<void> } = {};
  const fixture = await httpsFixture(t, async (req, res) => {
    stats.requests++; const url = new URL(req.url!, 'https://example123.table.core.windows.net');
    requests.push({ method: req.method!, url, headers: req.headers });
    assert.equal(req.headers.host, 'example123.table.core.windows.net'); assert.equal(req.headers.authorization, 'Bearer synthetic-directory-token');
    assert.equal(req.headers.accept, 'application/json;odata=fullmetadata'); assert.equal(req.headers['x-ms-version'], '2019-02-02');
    assert.ok(Number.isFinite(Date.parse(String(req.headers['x-ms-date'])))); assert.equal(req.headers.prefer, 'return-no-content');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : undefined;
    function error(status: number, code: string) { res.writeHead(status, { 'x-ms-error-code': code, 'content-type': 'application/json' }); res.end(JSON.stringify({ 'odata.error': { code } })); }
    function reply() {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json;odata=fullmetadata');
        if (url.pathname === '/Directory()') {
          const filter = url.searchParams.get('$filter')!; assert.equal(url.searchParams.get('$top'), filter.includes('RowKey eq') ? '1' : '4');
          const partition = /^PartitionKey eq '([^']+)'/.exec(filter)?.[1]; const row = /RowKey eq '([^']+)'/.exec(filter)?.[1];
          const next = url.searchParams.get('NextRowKey'); const top = Number(url.searchParams.get('$top'));
          const values = [...rows.values()].filter(r => r.PartitionKey === partition && (!row || r.RowKey === row) &&
            (!filter.includes('Armed eq true') || r.Armed === true) && (!next || String(r.RowKey) >= next))
            .sort((a, b) => String(a.RowKey).localeCompare(String(b.RowKey)));
          if (values.length > top) res.setHeader('x-ms-continuation-nextrowkey', String(values[top]!.RowKey));
          res.end(JSON.stringify({ 'odata.metadata': 'https://example123.table.core.windows.net/$metadata#Directory', value: values.slice(0, top) })); return;
        }
        const row = /RowKey='([^']+)'/.exec(decodeURIComponent(url.pathname))?.[1]; const value = rows.get(row!);
        if (!value) { error(404, 'EntityNotFound'); return; }
        res.setHeader('etag', String(value['odata.etag'])); res.end(JSON.stringify(value)); return;
      }
      assert.ok(body); const fields = ['PartitionKey', 'RowKey', 'V', 'Payload', 'Payload@odata.type', 'Digest', 'Armed'];
      assert.deepEqual(Object.keys(body).sort(), fields.sort()); assert.equal(body['Payload@odata.type'], 'Edm.Binary'); assert.equal(typeof body.Armed, 'boolean');
      const previous = rows.get(String(body.RowKey));
      if (req.method === 'POST' && previous) { error(409, 'EntityAlreadyExists'); return; }
      if (req.method === 'PUT' && !previous) { error(404, 'ResourceNotFound'); return; }
      if (req.method === 'PUT' && req.headers['if-match'] !== previous!['odata.etag']) { error(412, 'UpdateConditionNotSatisfied'); return; }
      rows.set(String(body.RowKey), { ...body, Timestamp: '2026-11-11T00:00:00Z', 'odata.etag': `W/"${++version}"` }); res.writeHead(204); res.end();
    }
    if (controls.hook) await controls.hook({ req, res, url, body, reply }); else reply();
  });
  const request: typeof https.request = ((url: URL, options: https.RequestOptions, callback: Parameters<typeof https.request>[2]) => {
    assert.equal(url.origin, 'https://example123.table.core.windows.net'); assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true); assert.equal(options.maxHeaderSize, 16384);
    const req = https.request(new URL(url.pathname + url.search, fixture.baseUrl), { ...options, hostname: '127.0.0.1', servername: 'localhost', ca: fixture.ca }, callback!);
    req.once('close', () => stats.requestCloses++); req.once('socket', socket => { stats.sockets++; socket.once('close', () => stats.socketCloses++); }); return req;
  }) as typeof https.request;
  const dependencies: DirectoryDependencies = { token: async (scope, ctx) => {
    stats.tokens++; assert.equal(scope, 'https://storage.azure.com/.default'); assert.ok(ctx.signal instanceof AbortSignal); assert.ok(Number.isFinite(ctx.deadline)); return 'synthetic-directory-token';
  }, request };
  return { rows, requests, stats, controls, dependencies, fixture, request };
}
