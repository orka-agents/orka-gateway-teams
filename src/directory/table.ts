import type { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import { tlsVerificationEnabled } from '../ingress/config.js';
import { subscribeAuditAbort } from '../storage/table/audit.js';
import { etag, object, rawJSON } from '../storage/table/codec.js';
import { decodeEntity, directoryKey, encodeEntity, validateScope } from './codec.js';
import type { DirectoryBinding, DirectoryContext, DirectoryDependencies, DirectoryKey, DirectoryRecord, DirectoryRow, DirectoryTable, DirectoryWriteResult } from './types.js';
import { DirectoryError } from './types.js';

interface Response { status: number; headers: IncomingMessage['headers']; body: Buffer }
const failed = () => new DirectoryError('unavailable');
const corrupt = () => new DirectoryError('corrupt');
const unready = () => new DirectoryError('unready');
export function createDirectoryTable(input: DirectoryBinding, deps: DirectoryDependencies): DirectoryTable {
  let scope: ReturnType<typeof validateScope>; let base: URL; let table: string;
  try {
    object(input, ['account', 'table', 'appId', 'tenantId']); scope = validateScope({ appId: input.appId, tenantId: input.tenantId });
    if (typeof input.account !== 'string' || typeof input.table !== 'string' || !/^[a-z0-9]{3,24}$/u.test(input.account) ||
      !/^[a-zA-Z][a-zA-Z0-9]{2,62}$/u.test(input.table) || typeof deps.token !== 'function') throw failed();
    base = new URL(`https://${input.account}.table.core.windows.net`); table = input.table;
  } catch { throw new DirectoryError('invalid-input'); }
  const request = deps.request ?? https.request; const token = deps.token;
  const work = new Set<Promise<unknown>>();
  const cancellations = new Set<AbortController>();
  let closing: Promise<void> | undefined; let closed = false;
  function usable(context: DirectoryContext, write = false): void {
    if (closed || context.signal.aborted || performance.now() >= context.deadline || !tlsVerificationEnabled() ||
      (write && context.authorizeWrite && !context.authorizeWrite())) throw failed();
  }
  function run<T>(context: DirectoryContext, operation: (ctx: DirectoryContext) => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new DirectoryError('closed'));
    if (work.size >= 4) return Promise.reject(new DirectoryError('busy'));
    if (!(context.signal instanceof AbortSignal) || !Number.isFinite(context.deadline) ||
      (context.authorizeWrite !== undefined && typeof context.authorizeWrite !== 'function')) {
      return Promise.reject(new DirectoryError('invalid-input'));
    }
    const controller = new AbortController();
    const remove = subscribeAuditAbort(context.signal, () => controller.abort());
    const ctx = { ...context, signal: controller.signal }; let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const remaining = ctx.deadline - performance.now();
      if (remaining <= 0) controller.abort(); else timer = setTimeout(expire, Math.min(remaining, 2147483647));
    };
    expire(); cancellations.add(controller);
    const promise = Promise.resolve().then(() => { usable(ctx); return operation(ctx); })
      .catch((e: unknown) => { throw e instanceof DirectoryError ? e : failed(); })
      .finally(() => { clearTimeout(timer); remove(); cancellations.delete(controller); work.delete(promise); });
    work.add(promise); return promise;
  }
  async function native(path: string, method: 'GET' | 'POST' | 'PUT', ctx: DirectoryContext, body?: Buffer, tag?: string, handoff?: () => void): Promise<Response> {
    usable(ctx, method !== 'GET');
    const bearer = await token('https://storage.azure.com/.default', { signal: ctx.signal, deadline: ctx.deadline });
    usable(ctx, method !== 'GET');
    if (typeof bearer !== 'string' || bearer.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(bearer)) throw failed();
    return new Promise<Response>((resolve, reject) => {
      let req: ClientRequest | undefined; let socket: Socket | undefined;
      let requestClosed = false; let socketClosed = true;
      let result: Response | DirectoryError | undefined; let remove = () => {};
      // Neither a response end nor a request close proves the physical socket drained.
      const complete = () => {
        if (!result || (req && !requestClosed) || !socketClosed) return;
        remove(); result instanceof DirectoryError ? reject(result) : resolve(result);
      };
      const finish = (value: Response | DirectoryError) => {
        if (result) return;
        result = value; req?.destroy(); socket?.destroy(); complete();
      };
      remove = subscribeAuditAbort(ctx.signal, () => finish(failed()));
      try {
        usable(ctx, method !== 'GET');
        req = request(new URL(path, base), {
          method, agent: false, rejectUnauthorized: true, maxHeaderSize: 16384,
          headers: {
            host: base.host, authorization: `Bearer ${bearer}`, accept: 'application/json;odata=fullmetadata',
            prefer: 'return-no-content', 'x-ms-version': '2019-02-02', 'x-ms-date': new Date().toUTCString(),
            ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
            ...(tag === undefined ? {} : { 'if-match': tag }),
          },
        }, res => {
          const chunks: Buffer[] = []; let size = 0;
          res.once('error', () => finish(failed())); res.once('aborted', () => finish(failed()));
          const selected = new Set<string>();
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            const name = res.rawHeaders[i]!.toLowerCase();
            if (!['etag', 'content-type', 'content-encoding', 'x-ms-error-code',
              'x-ms-continuation-nextpartitionkey', 'x-ms-continuation-nextrowkey'].includes(name)) continue;
            if (selected.has(name)) { finish(corrupt()); return; }
            selected.add(name);
          }
          if (res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity') {
            finish(corrupt()); return;
          }
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 512 * 1024) finish(corrupt()); else chunks.push(chunk);
          });
          res.once('end', () => {
            if (!res.complete || ctx.signal.aborted || performance.now() >= ctx.deadline || !tlsVerificationEnabled()) finish(failed());
            else finish({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
          });
          res.once('close', () => { if (!res.complete) finish(failed()); });
        });
        req.once('socket', value => {
          socket = value; socketClosed = false;
          value.once('close', () => { socketClosed = true; complete(); });
          if (result) value.destroy();
        });
        req.once('close', () => { requestClosed = true; if (!result) finish(failed()); complete(); });
        req.once('error', () => finish(failed()));
        usable(ctx, method !== 'GET');
        if (result) { req.destroy(); return; }
        handoff?.(); req.end(body);
      } catch { finish(failed()); }
    });
  }
  function json(response: Response): unknown {
    try {
      if (!/^application\/json(?:\s*;[^\r\n]*)?$/iu.test(String(response.headers['content-type']))) {
        throw corrupt();
      }
      return rawJSON(response.body);
    } catch { throw corrupt(); }
  }
  function cursor(response: Response): { partition?: string; row?: string } | undefined {
    const next: { partition?: string; row?: string } = {};
    for (const [field, header] of [['partition', 'x-ms-continuation-nextpartitionkey'], ['row', 'x-ms-continuation-nextrowkey']] as const) {
      const value = response.headers[header]; if (value === undefined) continue;
      if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || /[\p{Cc}\uD800-\uDFFF]/u.test(value)) throw corrupt();
      next[field] = value;
    }
    return Object.keys(next).length ? next : undefined;
  }
  function page(response: Response, max: number): DirectoryRow[] {
    try {
      const p = object(json(response), ['odata.metadata', 'value']); const meta = p['odata.metadata'];
      if (meta !== undefined && (typeof meta !== 'string' || meta.length > 4096 || !/^https?:\/\/[^\s]+$/u.test(meta))) throw corrupt();
      if (!Array.isArray(p.value) || p.value.length > max) throw corrupt();
      return p.value.map(v => decodeEntity(scope, v));
    } catch { throw corrupt(); }
  }
  function query(key?: DirectoryKey, armedOnly = false, next?: { partition?: string; row?: string }): string {
    const partition = directoryKey(scope, key ?? { kind: 'conn', conversationId: 'query' }).partition;
    const filter = `PartitionKey eq '${partition}'${key ? ` and RowKey eq '${directoryKey(scope, key).row}'` : armedOnly ? ' and Armed eq true' : ''}`;
    // Four maximum payloads plus bounded FULLmetadata fit the 512 KiB response cap.
    const params = new URLSearchParams({ '$filter': filter, '$top': key ? '1' : '4' });
    if (next?.partition !== undefined) params.set('NextPartitionKey', next.partition);
    if (next?.row !== undefined) params.set('NextRowKey', next.row);
    return `/${table}()?${params}`;
  }
  function path(key: DirectoryKey): string {
    const k = directoryKey(scope, key); return `/${table}(PartitionKey='${k.partition}',RowKey='${k.row}')`;
  }
  function mutation(key: DirectoryKey, value: DirectoryRecord, context: DirectoryContext, tag?: string): Promise<DirectoryWriteResult> {
    let body: Buffer;
    try { body = Buffer.from(JSON.stringify(encodeEntity(scope, key, value))); if (tag !== undefined) etag(tag); }
    catch { return Promise.reject(new DirectoryError('invalid-input')); }
    return run(context, async ctx => {
      usable(ctx, true); let response: Response; let handed = false;
      try {
        response = await native(tag === undefined ? `/${table}` : path(key), tag === undefined ? 'POST' : 'PUT',
          ctx, body, tag, () => { handed = true; });
      } catch (error) { if (!handed) throw error; return { kind: 'uncertain' }; }
      if (response.status === 409 || response.status === 412) return { kind: 'conflict' };
      return { kind: (response.status === 204 || (tag === undefined && response.status === 201)) && !response.body.length ? 'ack' : 'uncertain' };
    });
  }
  return Object.freeze({
    get(key: DirectoryKey, context: DirectoryContext) {
      let endpoint: string; try { endpoint = path(key); } catch { return Promise.reject(new DirectoryError('invalid-input')); }
      return run(context, async ctx => {
        const response = await native(endpoint, 'GET', ctx);
        if (response.status === 404) {
          let errorCode = response.headers['x-ms-error-code'];
          if (response.body.length) {
            try {
              const error = object(object(rawJSON(response.body))['odata.error']);
              if (typeof error.code !== 'string' || (errorCode !== undefined && error.code !== errorCode)) throw corrupt();
              errorCode = error.code;
            } catch { throw corrupt(); }
          }
          if (errorCode === 'EntityNotFound') return undefined;
          if (errorCode === 'ResourceNotFound') {
            const exact = await native(query(key), 'GET', ctx);
            if (exact.status !== 200) throw failed();
            const rows = page(exact, 1);
            if (cursor(exact) || (rows[0] && rows[0].row !== directoryKey(scope, key).row)) throw corrupt();
            return rows[0];
          }
        }
        if (response.status !== 200) throw failed();
        return decodeEntity(scope, json(response), key, typeof response.headers.etag === 'string' ? response.headers.etag : undefined);
      });
    },
    insert: (key: DirectoryKey, value: DirectoryRecord, context: DirectoryContext) => mutation(key, value, context),
    replace(key: DirectoryKey, tag: string, value: DirectoryRecord, context: DirectoryContext) {
      try { etag(tag); } catch { return Promise.reject(new DirectoryError('invalid-input')); }
      return mutation(key, value, context, tag);
    },
    list(context: DirectoryContext, armedOnly = false) {
      return run(context, async ctx => {
        const rows: DirectoryRow[] = []; const seenRows = new Set<string>(); const seenCursors = new Set<string>();
        let next: ReturnType<typeof cursor>; let size = 0;
        for (let count = 0; count < 1000; count++) {
          const response = await native(query(undefined, armedOnly, next), 'GET', ctx);
          if (response.status !== 200) throw failed();
          size += response.body.length;
          if (size > 32 * 1024 * 1024) throw unready();
          for (const row of page(response, 4)) {
            if (seenRows.has(row.row) || (armedOnly && !(row.value.kind === 'control' && row.value.state === 'armed'))) throw corrupt();
            seenRows.add(row.row); rows.push(row); if (rows.length > 100000) throw unready();
          }
          next = cursor(response); if (!next) return rows;
          const serialized = JSON.stringify(next); if (seenCursors.has(serialized)) throw unready(); seenCursors.add(serialized);
        }
        throw unready();
      });
    },
    close() {
      closed = true;
      for (const controller of cancellations) controller.abort();
      closing ??= Promise.allSettled([...work]).then(() => {});
      return closing;
    },
  });
}
