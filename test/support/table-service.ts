import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import { httpsFixture } from './ingress-https.js';
import type { TableBinding, TableDependencies } from '../../src/storage/table/types.js';

export const tableBinding: TableBinding = { account: 'Example123', table: 'Journal', kind: 'delivery', storeId: 'stable', scope: { appId: 'App', tenantId: 'Tenant' } };
export const ingressBinding: TableBinding = { account: 'Example123', table: 'Journal', kind: 'ingress', storeId: 'stable',
  scope: { appId: 'App', tenantId: 'Tenant', orkaBaseUrl: 'https://orka.example.invalid/', gatewayNamespace: 'gateway', gatewayName: 'teams' } };
export const partition = 'v1_delivery_c3RhYmxl';
export const boundBytes = Buffer.from(JSON.stringify(['orka-table-v1', 'example123', 'journal', 'delivery', 'stable', ['App', 'Tenant']]));
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export const syntheticToken = 'synthetic.private.table.canary';
export interface WireAction { method: string; etag?: string; entity: Record<string, unknown> }
export interface ServiceRequest { req: IncomingMessage; res: ServerResponse; path: string; actions: WireAction[]; commit(): boolean; reply(): void }
export function stamp(entity: Record<string, unknown>, version: number): Record<string, unknown> {
  return { ...entity, Timestamp: '2026-01-02T03:04:05.1234567Z', 'Timestamp@odata.type': 'Edm.DateTime',
    'odata.etag': `W/"${version}"`, 'odata.type': 'example123.Journal',
    'odata.id': `https://example123.table.core.windows.net/Journal(PartitionKey='${entity.PartitionKey}',RowKey='${entity.RowKey}')`,
    'odata.editLink': `Journal(PartitionKey='${entity.PartitionKey}',RowKey='${entity.RowKey}')` };
}
export function wireM(owner = '', epoch = 0): Record<string, unknown> {
  const id = '11111111-1111-4111-8111-111111111111';
  const m = { PartitionKey: partition, RowKey: 'M', V: 1, Binding: boundBytes.toString('base64'), 'Binding@odata.type': 'Edm.Binary',
    InitId: id, InitDigest: hash(['orka-init-v1', boundBytes.toString('base64'), id]), Owner: owner,
    Epoch: '0', 'Epoch@odata.type': 'Edm.Int64', Invocation: id, Operation: 'initialize', Plan: hash(['initialize', id]),
    State: '', 'State@odata.type': 'Edm.Binary', Result: '', 'Result@odata.type': 'Edm.Binary', Release: '', 'Release@odata.type': 'Edm.Binary' };
  if (epoch > 0) {
    const priorOwner = '22222222-2222-4222-8222-222222222222';
    const releaseInvocation = '33333333-3333-4333-8333-333333333333';
    // A synthetic prior owned mutation supplies the released epoch, without replaying
    // an unbounded history in overflow tests. Hashes/receipts stay fixture-owned.
    const previous = { ...m, Owner: priorOwner, Epoch: String(owner ? epoch - 1 : epoch),
      Invocation: '77777777-7777-4777-8777-777777777777', Operation: 'mutate', Plan: 'a'.repeat(64) };
    if (Number(previous.Epoch) > 1) previous.Release = Buffer.from(JSON.stringify([
      '88888888-8888-4888-8888-888888888888', Number(previous.Epoch) - 1, '99999999-9999-4999-8999-999999999999', 'b'.repeat(64),
    ])).toString('base64');
    const releasePlan = hash(['release', mDigest(previous), releaseInvocation]);
    const released = { ...previous, Owner: '', Invocation: releaseInvocation, Operation: 'release', Plan: releasePlan,
      Release: Buffer.from(JSON.stringify([priorOwner, Number(previous.Epoch), releaseInvocation, releasePlan])).toString('base64') };
    if (!owner) return { ...released, Digest: mDigest(released) };
    const original = epoch === 1 ? { ...m, Owner: '' } : released;
    const invocation = '44444444-4444-4444-8444-444444444444';
    const acquired = { ...original, Owner: owner, Epoch: String(epoch), Invocation: invocation, Operation: 'acquire',
      Plan: hash(['acquire', mDigest(original), owner, invocation]) };
    return { ...acquired, Digest: mDigest(acquired) };
  }
  return { ...m, Digest: mDigest(m) };
}
export function mDigest(m: Record<string, unknown>): string {
  return hash(['orka-m-v1', m.Binding, m.InitId, m.InitDigest, m.Owner, Number(m.Epoch), m.Invocation, m.Operation, m.Plan, m.State, m.Result, m.Release]);
}
function checkEntity(e: Record<string, unknown>, expectedPartition: string, expectedBinding: Buffer): boolean {
  if (e.PartitionKey !== expectedPartition || e.V !== 1 || typeof e.RowKey !== 'string') return false;
  if (e.RowKey === 'M') return e.Digest === mDigest(e) && e.Binding === expectedBinding.toString('base64');
  const chunks = Array.from({ length: Number(e.Count) }, (_, i) => Buffer.from(String(e[`B${i}`]), 'base64'));
  const payload = Buffer.concat(chunks);
  return e.RowKey === `${e.T}_${Buffer.from(String(e.Id)).toString('base64url')}` && payload.length === e.Length &&
    chunks.every((b, i) => b.length <= 65536 && b.toString('base64') === e[`B${i}`] && e[`B${i}@odata.type`] === 'Edm.Binary') &&
    e.Digest === hash(['orka-data-v1', expectedBinding.toString('base64'), e.T, e.Id, payload.toString('base64')]);
}
export async function tableService(t: TestContext, kind: 'delivery' | 'ingress' = 'delivery') {
  const partition = kind === 'delivery' ? 'v1_delivery_c3RhYmxl' : 'v1_ingress_c3RhYmxl';
  const expectedBinding = kind === 'delivery' ? boundBytes : Buffer.from(JSON.stringify(['orka-table-v1', 'example123', 'journal', 'ingress', 'stable',
    ['App', 'Tenant', 'https://orka.example.invalid/', 'gateway', 'teams']]));
  const rows = new Map<string, Record<string, unknown>>(); let version = 0;
  const stats = { requests: 0, writes: 0, reads: 0, pages: 0, tokens: 0, requestCloses: 0, socketCloses: 0, bytes: 0, violation: false, lastActions: 0, conditionFailure: '' };
  const controls: { hook?: (event: ServiceRequest) => Promise<void> | void; request?: TableDependencies['request'] } = {};
  function error(res: ServerResponse, status: number, code: string) {
    res.writeHead(status, { 'content-type': 'application/json', 'x-ms-error-code': code }); res.end(JSON.stringify({ 'odata.error': { code, message: { lang: 'en-US', value: 'synthetic service error' } } }));
  }
  const fixture = await httpsFixture(t, async (req, res) => {
    try {
      stats.requests++;
      if (req.headers.host !== 'example123.table.core.windows.net' || req.headers.authorization !== `Bearer ${syntheticToken}` ||
          req.headers.connection !== 'close' || req.headers.accept !== 'application/json;odata=fullmetadata') stats.violation = true;
      const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
      const body = Buffer.concat(parts); stats.bytes += body.length;
      const path = decodeURIComponent(req.url ?? ''); const actions: WireAction[] = [];
      if (req.method !== 'GET') {
        stats.writes++;
        if (path === '/$batch') {
          // Parse the real SDK multipart requests, without using production transition/codec code.
          for (const section of body.toString().split(/content-type: application\/http/iu).slice(1)) {
            const match = /\r\n(POST|PUT) ([^\r\n]+) HTTP\/1\.1\r\n([\s\S]*?)\r\n\r\n(?:\r\n)*([^\r\n]+)/iu.exec(section);
            if (!match) throw new Error();
            const tag = /^if-match: (.+)$/imu.exec(match[3]!);
            actions.push({ method: match[1]!.toUpperCase(), ...(tag ? { etag: tag[1]!.trim() } : {}), entity: JSON.parse(match[4]!) });
          }
        } else actions.push({ method: req.method!, ...(req.headers['if-match'] ? { etag: String(req.headers['if-match']) } : {}), entity: JSON.parse(body.toString()) });
        stats.lastActions = actions.length;
        if (!actions.length || actions.length > 100 || actions.filter(a => a.entity.RowKey === 'M').length !== 1 || !actions.every(a => checkEntity(a.entity, partition, expectedBinding))) stats.violation = true;
      }
      let committed: boolean | undefined;
      const commit = () => {
        if (committed !== undefined) return committed;
        const names = new Set<string>();
        for (const action of actions) {
          const row = String(action.entity.RowKey); const previous = rows.get(row);
          if (names.has(row) || (action.method === 'POST' ? !!previous : !previous || action.etag !== previous['odata.etag'])) {
            stats.conditionFailure = names.has(row) ? 'duplicate' : action.method === 'POST' ? 'exists' : !previous ? 'missing' : action.etag === undefined ? 'no-etag' : 'etag-mismatch';
            return committed = false;
          }
          names.add(row);
        }
        for (const action of actions) rows.set(String(action.entity.RowKey), stamp(structuredClone(action.entity), ++version));
        return committed = true;
      };
      const reply = () => {
        if (req.method !== 'GET') { if (!commit()) { error(res, 412, 'UpdateConditionNotSatisfied'); return; } res.writeHead(path === '/$batch' ? 202 : 204); res.end(); return; }
        const row = /RowKey='([^']+)'/u.exec(path)?.[1];
        res.setHeader('content-type', 'application/json;odata=fullmetadata');
        if (row) {
          stats.reads++; const entity = rows.get(row); if (!entity) { error(res, 404, 'EntityNotFound'); return; }
          res.setHeader('etag', String(entity['odata.etag'])); res.end(JSON.stringify(entity));
        } else {
          stats.pages++;
          const url = new URL(req.url!, 'https://example123.table.core.windows.net');
          if (url.searchParams.get('$filter') !== `PartitionKey eq '${partition}'` || url.searchParams.get('$top') !== '1') stats.violation = true;
          const sorted = [...rows.keys()].sort(); const next = url.searchParams.get('NextRowKey');
          const index = next ? sorted.indexOf(next) : 0; const key = sorted[index]; const after = sorted[index + 1];
          if (after) { res.setHeader('x-ms-continuation-NextPartitionKey', partition); res.setHeader('x-ms-continuation-NextRowKey', after); }
          res.end(JSON.stringify({ 'odata.metadata': 'https://example123.table.core.windows.net/$metadata#Journal', value: key ? [rows.get(key)] : [] }));
        }
      };
      if (controls.hook) await controls.hook({ req, res, path, actions, commit, reply }); else reply();
    } catch { stats.violation = true; res.destroy(); }
  });
  const request: typeof https.request = ((url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
    if (url.origin !== 'https://example123.table.core.windows.net' || options.agent !== false || options.rejectUnauthorized !== true) stats.violation = true;
    const req = https.request(new URL(url.pathname + url.search, fixture.baseUrl), { ...options, hostname: '127.0.0.1', servername: 'localhost', ca: fixture.ca }, callback as never);
    req.once('close', () => stats.requestCloses++); req.once('socket', socket => socket.once('close', () => stats.socketCloses++));
    return req;
  }) as typeof https.request;
  const dependencies: TableDependencies = { token: async (scope, context) => { stats.tokens++; if (scope !== 'https://storage.azure.com/.default' || !(context.signal instanceof AbortSignal) || !Number.isFinite(context.deadline)) stats.violation = true; return syntheticToken; },
    request: ((...args: Parameters<typeof https.request>) => (controls.request ?? request)(...args)) as typeof https.request };
  t.after(() => { if (stats.violation) throw new Error('Table fixture boundary violation'); });
  return { rows, stats, controls, dependencies, request, fixture };
}
export function context(ms = 30000) { return { signal: new AbortController().signal, deadline: performance.now() + ms }; }
export function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
export async function eventually(check: () => boolean) { for (let i = 0; i < 2000; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Fixture condition did not complete'); }
