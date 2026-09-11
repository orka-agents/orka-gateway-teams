import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpMethod, HttpRouteHandler, IHttpServerAdapter } from '@microsoft/teams.apps';

const BODY_BYTES = 256 * 1024;
const DEADLINE_MS = 10000;
class HttpFailure extends Error { constructor(readonly status: number) { super('Request rejected'); } }

/** Only the SDK-registered handler is callable; there is no alternate ingress route. */
export class NativeAdapter implements IHttpServerAdapter {
  private handler: HttpRouteHandler | undefined;
  private readonly context = new AsyncLocalStorage<{ signal: AbortSignal; finished: Promise<void> }>();
  private readonly work = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  private readonly server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: DEADLINE_MS,
    requestTimeout: DEADLINE_MS, connectionsCheckingInterval: 1000 }, (req, res) => {
    const operation = this.handle(req, res);
    this.work.add(operation); void operation.finally(() => this.work.delete(operation));
  });

  constructor(private readonly verify: (authorization: unknown, body: unknown) => Promise<boolean>) {
    this.server.maxRequestsPerSocket = 1;
    this.server.on('connection', (socket) => {
      // Absolute header deadline, not a sliding inactivity timeout.
      const timer = setTimeout(() => socket.destroy(), DEADLINE_MS); timer.unref();
      socket.once('close', () => clearTimeout(timer));
    });
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      else socket.destroy();
    });
  }

  registerRoute(method: HttpMethod, path: string, handler: HttpRouteHandler): void {
    if (method !== 'POST' || path !== '/api/messages' || this.handler) throw new Error('Unsupported ingress route');
    this.handler = handler;
  }

  get active(): boolean { return !this.stopping && this.context.getStore()?.signal.aborted === false; }

  afterResponse(callback: () => void): void {
    const context = this.context.getStore();
    if (!context) throw new Error('Missing ingress request context');
    void context.finished.then(callback);
  }

  async listen(host: string, port: number): Promise<number> {
    if (!this.handler) throw new Error('Ingress not initialized');
    await new Promise<void>((resolve, reject) => {
      const failed = () => { this.server.off('listening', ready); reject(new Error('Ingress listen failed')); };
      const ready = () => { this.server.off('error', failed); resolve(); };
      this.server.once('error', failed); this.server.once('listening', ready); this.server.listen(port, host);
    });
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Ingress listen failed');
    return address.port;
  }

  stop(): Promise<void> {
    this.stopPromise ??= (async () => {
      this.stopping = true;
      for (const controller of this.controllers) controller.abort();
      const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.server.closeAllConnections();
      await closed; await Promise.all(this.work);
    })();
    return this.stopPromise;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controller = new AbortController(); this.controllers.add(controller);
    const finished = new Promise<void>((resolve) => { res.once('finish', resolve); res.once('close', resolve); });
    const timer = setTimeout(() => { controller.abort(); respond(res, 408); }, DEADLINE_MS); timer.unref();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', disconnected);
    try {
      if (this.stopping) throw new HttpFailure(503);
      if (req.method !== 'POST' || req.url !== '/api/messages' || !this.handler) throw new HttpFailure(404);
      const headers: Record<string, string | string[]> = {};
      for (const [name, values] of Object.entries(req.headersDistinct)) {
        if (values) headers[name] = values.length === 1 ? values[0]! : values;
      }
      if (typeof headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headers['content-type']) ||
          (headers['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity')) throw new HttpFailure(415);
      if (Number(req.headers['content-length'] ?? 0) > BODY_BYTES) throw new HttpFailure(413);
      const body = await readBody(req, controller.signal);
      const verified = await this.verify(headers.authorization, body);
      if (!verified) throw new HttpFailure(401);
      if (controller.signal.aborted || this.stopping) throw new HttpFailure(503);
      const result = await this.context.run({ signal: controller.signal, finished }, () => this.handler!({ body, headers }));
      respond(res, result.status, result.body);
    } catch (error) { respond(res, error instanceof HttpFailure ? error.status : 503); }
    finally {
      clearTimeout(timer); this.controllers.delete(controller); res.off('close', disconnected);
    }
  }
}

function respond(res: ServerResponse, status: number, body?: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const accepted = status === 200 && body !== null && typeof body === 'object' && 'status' in body &&
    ['accepted', 'duplicate', 'ignored'].includes(String(body.status));
  // Never serialize SDK bodies/errors; even authenticated caller data stays private.
  const text = JSON.stringify(accepted ? { status: (body as { status: string }).status } : { error: 'Request rejected' });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Connection': 'close' });
  res.end(text);
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', failed); signal.removeEventListener('abort', abort); };
    const failed = () => { cleanup(); reject(new HttpFailure(400)); };
    const abort = () => { cleanup(); reject(new HttpFailure(408)); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_BYTES) { cleanup(); req.pause(); reject(new HttpFailure(413)); }
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new HttpFailure(400)); }
    };
    req.on('data', data); req.once('end', end); req.once('error', failed); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
