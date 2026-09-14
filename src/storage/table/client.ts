import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { TableClient } from '@azure/data-tables';
import type { TableEntity, TransactionAction } from '@azure/data-tables';
import { createHttpHeaders, defaultRetryPolicy, bearerTokenAuthenticationPolicyName, decompressResponsePolicyName,
  logPolicyName, proxyPolicyName, redirectPolicyName, tracingPolicyName } from '@azure/core-rest-pipeline';
import type { PipelineRequest, PipelineResponse } from '@azure/core-rest-pipeline';
import { tlsVerificationEnabled } from '../../ingress/config.js';
import { data, dataRow, encodeRecord, etag, fail, object, rawJSON } from './codec.js';
import { MAX_RESPONSE_BYTES, MAX_WIRE_BYTES, TableError } from './types.js';
import type { BoundTable, DataAction, TableDependencies } from './types.js';
import { encodeMetadata, readPage, readRecord, receiptBytes } from './format.js';
import type { MetadataFor, MetadataFormat, StoredFor } from './format.js';

export interface WorkContext { signal: AbortSignal; deadline: number }
export interface PageCursor { token: string; partition?: string; row?: string }
export interface RawPage<F extends MetadataFormat = 1> { records: StoredFor<F>[]; size: number; cursor?: PageCursor }
/** Internal owned-audit gate, never a legacy response-limit override. */
export interface AuditPageAllowance { maxBytes: number; exhaust: () => void }
type RequestKind = { kind: 'read'; row: string } | { kind: 'page'; cursor?: PageCursor; allowance?: AuditPageAllowance } | { kind: 'write'; initialize: boolean };
interface NativeResponse { status: number; body: Buffer; headers: IncomingMessage['headers'] }
function available(context: WorkContext): boolean { return !context.signal.aborted && performance.now() < context.deadline; }
function unavailable(): TableError { return new TableError('unavailable'); }

/** Public SDK serialization only. No caller can obtain or configure the SDK client. */
export class OwnedTableClient<F extends MetadataFormat = 1> {
  private readonly work = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private readonly request: typeof https.request;
  private readonly token: TableDependencies['token'];
  private readonly format: F;
  constructor(private readonly binding: BoundTable, dependencies: TableDependencies, ...format: [format: F] | (1 extends F ? [] : never)) {
    if (typeof dependencies.token !== 'function') fail();
    this.format = (format[0] ?? 1) as F;
    this.token = dependencies.token; this.request = dependencies.request ?? https.request;
  }
  private track<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new TableError('closed'));
    const promise = Promise.resolve().then(run).catch((e: unknown) => { throw e instanceof TableError ? e : unavailable(); });
    this.work.add(promise); void promise.then(() => this.work.delete(promise), () => this.work.delete(promise)); return promise;
  }
  read(row: string, context: WorkContext): Promise<StoredFor<F> | undefined> {
    return this.track(async () => {
      if (row !== 'M' && !/^(event|route|delivery|alias|control)_[A-Za-z0-9_-]{1,342}$/u.test(row)) fail();
      let record: StoredFor<F> | undefined;
      const sdk = this.sdk({ kind: 'read', row }, context, response => {
        if (response.status === 404 && errorCode(response) === 'EntityNotFound') return;
        if (response.status !== 200) throw unavailable();
        record = readRecord(this.format, this.binding, response.body, row, header(response.headers.etag));
      });
      await sdk.getEntity(this.binding.partition, row); return record;
    });
  }
  page(context: WorkContext, cursor?: PageCursor, allowance?: AuditPageAllowance): Promise<RawPage<F>> {
    return this.track(async () => {
      let exhausted = false; let corrupt = false;
      if (allowance && (!Number.isSafeInteger(allowance.maxBytes) || allowance.maxBytes < 1 || allowance.maxBytes > MAX_RESPONSE_BYTES)) fail();
      const gate = allowance ? { maxBytes: allowance.maxBytes, exhaust: () => { exhausted = true; allowance.exhaust(); } } : undefined;
      let page: RawPage<F> | undefined; let parts: Omit<PageCursor, 'token'> = {};
      const sdk = this.sdk({ kind: 'page', ...(cursor ? { cursor } : {}), ...(gate ? { allowance: gate } : {}) }, context, response => {
        if (response.status !== 200) throw unavailable();
        page = { records: readPage(this.format, this.binding, response.body), size: response.body.length };
        const partition = continuation(response.headers['x-ms-continuation-nextpartitionkey']);
        const row = continuation(response.headers['x-ms-continuation-nextrowkey']);
        parts = { ...(partition !== undefined ? { partition } : {}), ...(row !== undefined ? { row } : {}) };
      });
      // One yield per iterator. A second yield adds the opaque private continuation to an SDK span.
      const iterator = sdk.listEntities({ queryOptions: { filter: `PartitionKey eq '${this.binding.partition}'` } })
        .byPage({ maxPageSize: 1, ...(cursor ? { continuationToken: cursor.token } : {}) });
      try {
        try {
          const result = await iterator.next(); if (!page || result.done) throw new TableError('incomplete');
          const token = result.value.continuationToken;
          if (token !== undefined) {
            if (token.length > 8192 || (!parts.partition && !parts.row)) throw new TableError('corrupt');
            page.cursor = { token, ...parts };
          } else if (parts.partition || parts.row) throw new TableError('incomplete');
          return page;
        } catch (error) {
          if (allowance && error instanceof TableError && error.code === 'corrupt') corrupt = true;
          throw error;
        } finally { await iterator.return?.(); }
      } catch (error) {
        // Cleanup cannot erase already observed corruption or the native body
        // gate. A truncated body must never become decoder input.
        if (corrupt) throw new TableError('corrupt');
        if (exhausted) throw new TableError('incomplete'); throw error;
      }
    });
  }
  write(m: MetadataFor<F>, originalETag: string | undefined, actions: readonly DataAction[], context: WorkContext): Promise<void> {
    // Inputs here are kernel-owned; copy actions and validate their closed shapes before any SDK/auth work.
    let transaction: TransactionAction[];
    try {
      // Recovery-shaped metadata is readable, not writable through this normal-owner transport.
      if (this.format === 2 && m.operation === 'recover') fail();
      if (!Array.isArray(actions) || actions.length > 99 || (originalETag === undefined && actions.length)) fail();
      if (originalETag !== undefined) etag(originalETag);
      const entity = encodeMetadata(this.format, this.binding, m) as TableEntity;
      transaction = [originalETag === undefined ? ['create', entity] : ['update', entity, 'Replace', { etag: originalETag }]];
      let upper = 8192 + 4 * Math.ceil((this.binding.bytes.length + m.state.length + m.result.length + receiptBytes(m).length) / 3) + 16;
      const rows = new Set(['M']);
      for (const action of actions) {
        object(action, action.kind === 'replace' ? ['kind', 'key', 'payload', 'etag'] : ['kind', 'key', 'payload']);
        if (action.kind !== 'create' && action.kind !== 'replace') fail();
        const value = data(this.binding, action.key, action.payload); const row = dataRow(this.binding, action.key);
        if (rows.has(row)) fail(); rows.add(row);
        upper += 8192 + 4 * Math.ceil(value.payload.length / 3) + 16;
        if (upper > MAX_WIRE_BYTES) fail();
        const encoded = encodeRecord(this.binding, value) as TableEntity;
        transaction.push(action.kind === 'create' ? ['create', encoded] : ['update', encoded, 'Replace', { etag: etag(action.etag) }]);
      }
    } catch { return Promise.reject(new TableError('invalid-input')); }
    return this.track(async () => {
      const sdk = this.sdk({ kind: 'write', initialize: originalETag === undefined }, context, () => {});
      if (originalETag === undefined) await sdk.createEntity(transaction[0]![1]); else await sdk.submitTransaction(transaction);
    });
  }
  close(): Promise<void> {
    this.closing ??= Promise.allSettled([...this.work]).then(() => {}); return this.closing;
  }
  private sdk(kind: RequestKind, context: WorkContext, consume: (response: NativeResponse) => void): TableClient {
    const sdk = new TableClient(`https://${this.binding.account}.table.core.windows.net`, this.binding.table, {
      retryOptions: { maxRetries: 0 }, redirectOptions: { maxRetries: 0 },
      httpClient: { sendRequest: async (request: PipelineRequest): Promise<PipelineResponse> => {
        try {
          const body = request.body === undefined ? '' : request.body;
          if (typeof body !== 'string') throw unavailable();
          this.fence(request, body, kind);
          if (!available(context)) throw unavailable();
          const signal = new AbortController(); const abort = () => signal.abort();
          context.signal.addEventListener('abort', abort, { once: true });
          const timer = setTimeout(abort, Math.max(1, context.deadline - performance.now()));
          let response: NativeResponse;
          try {
            // Await the real token callback even after deadline; timeout is not resource drain.
            let token: string;
            try { token = await this.token('https://storage.azure.com/.default', { signal: signal.signal, deadline: context.deadline }); }
            catch { throw unavailable(); }
            if (!available(context) || signal.signal.aborted || typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(token)) throw unavailable();
            this.fence(request, body, kind);
            response = await this.native(request, body, token, { signal: signal.signal, deadline: context.deadline }, kind.kind === 'page' ? kind.allowance : undefined);
          } finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort); }
          if (kind.kind !== 'write') {
            if (response.status !== 200 && !(kind.kind === 'read' && response.status === 404)) throw unavailable();
            if (!/^application\/json(?:\s*;[^\r\n]*)?$/iu.test(header(response.headers['content-type']) ?? '')) {
              throw response.status === 200 ? new TableError('corrupt') : unavailable();
            }
          }
          consume(response);
          // Raw bytes/ETags/errors never enter SDK normalization or high-level exception spans.
          if (kind.kind === 'write') {
            if (![202, 204].includes(response.status)) throw unavailable();
            return { request, status: response.status, headers: createHttpHeaders(), bodyAsText: '' };
          }
          const headers = createHttpHeaders({ 'content-type': 'application/json' });
          if (kind.kind === 'page') for (const name of ['x-ms-continuation-nextpartitionkey', 'x-ms-continuation-nextrowkey']) {
            const value = continuation(response.headers[name]); if (value !== undefined) headers.set(name, value);
          }
          return { request, status: 200, headers, bodyAsText: kind.kind === 'page' ? '{"value":[]}' : '{}' };
        } catch (error) { throw error instanceof TableError ? error : unavailable(); }
      } },
    });
    for (const name of [logPolicyName, tracingPolicyName, proxyPolicyName, redirectPolicyName, decompressResponsePolicyName,
      bearerTokenAuthenticationPolicyName, defaultRetryPolicy({ maxRetries: 0 }).name]) sdk.pipeline.removePolicy({ name });
    sdk.pipeline.addPolicy({ name: 'tableContainment', async sendRequest(request, next) {
      try { return await next(request); } catch (error) { throw error instanceof TableError ? error : unavailable(); }
    } }, { phase: 'Serialize', beforePolicies: ['serializationPolicy'] });
    return sdk;
  }
  private fence(request: PipelineRequest, body: string, kind: RequestKind): void {
    const url = new URL(request.url); const path = decodeURIComponent(url.pathname);
    if (!tlsVerificationEnabled() || url.origin !== `https://${this.binding.account}.table.core.windows.net` || url.username || url.password || url.hash ||
        Buffer.byteLength(body) > MAX_WIRE_BYTES) throw unavailable();
    if (kind.kind === 'write') {
      if (request.method !== 'POST' || path !== (kind.initialize ? `/${this.binding.table}` : '/$batch') || url.search) throw unavailable();
    } else {
      if (request.method !== 'GET' || body) throw unavailable();
      if (kind.kind === 'read') {
        if (path !== `/${this.binding.table}(PartitionKey='${this.binding.partition}',RowKey='${kind.row}')` || url.search) throw unavailable();
      } else {
        if (path !== `/${this.binding.table}()` || url.searchParams.get('$filter') !== `PartitionKey eq '${this.binding.partition}'` || url.searchParams.get('$top') !== '1') throw unavailable();
        const expected = new Map([['$filter', `PartitionKey eq '${this.binding.partition}'`], ['$top', '1']]);
        if (kind.cursor?.partition !== undefined) expected.set('NextPartitionKey', kind.cursor.partition);
        if (kind.cursor?.row !== undefined) expected.set('NextRowKey', kind.cursor.row);
        if ([...url.searchParams].length !== expected.size || [...url.searchParams].some(([k, v]) => expected.get(k) !== v)) throw unavailable();
      }
    }
  }
  private native(request: PipelineRequest, body: string, token: string, context: WorkContext, allowance?: AuditPageAllowance): Promise<NativeResponse> {
    return new Promise((resolve, reject) => {
      let req: ClientRequest | undefined; let response: IncomingMessage | undefined; let result: NativeResponse | undefined;
      let failed = false; let exhausted = false; let requestClosed = false; let socketClosed = true;
      const finish = () => {
        if (!requestClosed || !socketClosed) return;
        context.signal.removeEventListener('abort', abort);
        if (exhausted) reject(new TableError('incomplete')); else if (failed || !result) reject(unavailable()); else resolve(result);
      };
      const abort = () => { failed = true; response?.destroy(); req?.destroy(); };
      try {
        const headers = request.headers.toJSON();
        // Auth is only present in the native request, not PipelineRequest/SDK errors.
        Object.assign(headers, { host: `${this.binding.account}.table.core.windows.net`, authorization: `Bearer ${token}`,
          accept: 'application/json;odata=fullmetadata', connection: 'close', 'content-length': String(Buffer.byteLength(body)) });
        delete headers['accept-encoding'];
        if (Object.entries(headers).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v) + 4, 0) > 16384) throw unavailable();
        req = this.request(new URL(request.url), { method: request.method, headers, agent: false, rejectUnauthorized: true, maxHeaderSize: 16384 }, res => {
          response = res; const chunks: Buffer[] = []; let size = 0;
          res.on('error', abort); res.on('aborted', abort);
          const consumed = new Set<string>();
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            const name = res.rawHeaders[i]!.toLowerCase();
            if (['etag', 'content-type', 'content-encoding', 'x-ms-error-code', 'x-ms-continuation-nextpartitionkey', 'x-ms-continuation-nextrowkey'].includes(name)) {
              if (consumed.has(name)) { abort(); return; } consumed.add(name);
            }
          }
          if (res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity') { abort(); return; }
          res.on('data', (part: Buffer) => {
            if (allowance && part.length > allowance.maxBytes - size) {
              if (!exhausted) { exhausted = true; allowance.exhaust(); }
              abort(); return;
            }
            size += part.length;
            if (size > MAX_RESPONSE_BYTES || !available(context)) abort(); else chunks.push(Buffer.from(part));
          });
          res.on('end', () => {
            if (!res.complete || !available(context) || failed || !tlsVerificationEnabled()) { abort(); return; }
            result = { status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers };
          });
        });
        req.once('socket', socket => { socketClosed = false; socket.once('close', () => { socketClosed = true; finish(); }); });
        req.on('error', () => { failed = true; }); req.once('close', () => { requestClosed = true; finish(); });
        context.signal.addEventListener('abort', abort, { once: true });
        if (!available(context)) abort(); else req.end(body);
      } catch {
        failed = true;
        if (req) req.destroy(); else { requestClosed = true; finish(); }
      }
    });
  }
}
function header(value: string | string[] | undefined): string | undefined { if (Array.isArray(value)) throw new TableError('corrupt'); return value; }
function continuation(value: string | string[] | undefined): string | undefined {
  const text = header(value);
  if (text !== undefined && (!text || text.length > 2048 || /[^\x21-\x7e]/u.test(text))) throw new TableError('corrupt'); return text;
}
function errorCode(response: NativeResponse): string {
  try {
    const envelope = object(rawJSON(response.body), ['odata.error']); const error = object(envelope['odata.error'], ['code', 'message']);
    const message = object(error.message, ['lang', 'value']);
    if (typeof message.lang !== 'string' || message.lang.length > 32 || typeof message.value !== 'string' || message.value.length > 8192 ||
        typeof error.code !== 'string' || !['EntityNotFound', 'TableNotFound', 'EntityAlreadyExists', 'UpdateConditionNotSatisfied'].includes(error.code) ||
        (response.headers['x-ms-error-code'] !== undefined && response.headers['x-ms-error-code'] !== error.code)) throw unavailable();
    return error.code;
  } catch { throw unavailable(); }
}
