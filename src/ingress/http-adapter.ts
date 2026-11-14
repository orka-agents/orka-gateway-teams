import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpMethod, HttpRouteHandler, IHttpServerAdapter } from '@microsoft/teams.apps';

const BODY_BYTES = 256 * 1024;
const DEADLINE_MS = 10000;
const MAX_PENDING_HANDLERS = 32;
class HttpFailure extends Error { constructor(readonly status: number) { super('Request rejected'); } }

export interface BrowserSignin {
  readonly origin: string;
  begin(challengeId: string, context: { signal: AbortSignal; deadline: number }, cookie?: string): Promise<string | { redirect: string; cookie: { value: string; maxAge: number } } | undefined>;
  callback(form: URLSearchParams, context: { signal: AbortSignal; deadline: number; committed?(): void }, cookie?: string): Promise<boolean | { redirect: string; cookie: { value: string; maxAge: number } }>;
  githubCallback?(form: URLSearchParams, cookie: string, context: { signal: AbortSignal; deadline: number; committed?(): void }): Promise<boolean>;
}
const CHALLENGE = /^[a-f0-9]{64}\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

/** SDK message ingress and explicitly configured, isolated browser sign-in routes. */
export class NativeAdapter implements IHttpServerAdapter {
  private handler: HttpRouteHandler | undefined;
  private readonly context = new AsyncLocalStorage<{ signal: AbortSignal; deadline: number; finished: Promise<void> }>();
  private readonly work = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private stopping = false;
  private browsers = 0;
  private stopPromise: Promise<void> | undefined;
  private readonly server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: DEADLINE_MS,
    requestTimeout: DEADLINE_MS, connectionsCheckingInterval: 1000 }, (req, res) => {
    // Reserve before reading/retaining any body or queuing authentication/storage.
    // This set outlives HTTP timeout/disconnect and includes actual reconciliation.
    if (this.stopping || this.work.size >= MAX_PENDING_HANDLERS) { respond(res, 503); return; }
    const operation = this.handle(req, res);
    this.work.add(operation);
    const release = () => { this.work.delete(operation); };
    void operation.then(release, release);
  });

  constructor(private readonly verify: (authorization: unknown, body: unknown) => Promise<boolean>, private readonly browser?: BrowserSignin) {
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

  get requestContext(): Readonly<{ signal: AbortSignal; deadline: number }> {
    const context = this.context.getStore();
    if (!context) throw new Error('Missing ingress request context');
    return Object.freeze({ signal: context.signal, deadline: context.deadline });
  }

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
    const deadline = performance.now() + DEADLINE_MS;
    const controller = new AbortController(); this.controllers.add(controller);
    const finished = new Promise<void>((resolve) => { res.once('finish', resolve); res.once('close', resolve); });
    const timer = setTimeout(() => { controller.abort(); respond(res, 408); }, DEADLINE_MS); timer.unref();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', disconnected);
    let browser = false;
    try {
      if (this.stopping) throw new HttpFailure(503);
      if (this.browser && (req.url?.startsWith('/signin?') && req.method === 'GET' || req.url === '/oauth/callback' && req.method === 'POST' ||
        this.browser.githubCallback && req.url?.startsWith('/github/callback?') && req.method === 'GET')) {
        browser = true;
        if (this.browsers >= 2) throw new HttpFailure(503);
        this.browsers++;
        try { await this.handleBrowser(req, res, { signal: controller.signal, deadline }); }
        finally { this.browsers--; }
        return;
      }
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
      const result = await this.context.run({ signal: controller.signal, deadline, finished }, () => this.handler!({ body, headers }));
      respond(res, result.status, result.body);
    } catch (error) {
      const status = error instanceof HttpFailure ? error.status : 503;
      if (browser) browserResponse(res, status); else respond(res, status);
    }
    finally {
      clearTimeout(timer); this.controllers.delete(controller); res.off('close', disconnected);
    }
  }

  private async handleBrowser(req: IncomingMessage, res: ServerResponse, ctx: { signal: AbortSignal; deadline: number }): Promise<void> {
    if (req.method === 'GET' && req.url!.startsWith('/github/callback?')) {
      if (req.url!.length > 8192) throw new HttpFailure(413);
      const form = new URLSearchParams(req.url!.slice('/github/callback?'.length)); const keys = [...form.keys()];
      if (keys.some(k => !['code', 'state', 'error', 'error_description', 'error_uri'].includes(k)) || new Set(keys).size !== keys.length ||
        !form.get('state') || !!form.get('code') === !!form.get('error') || req.headersDistinct.cookie?.length !== 1) throw new HttpFailure(400);
      const cookies = req.headers.cookie!.split(';').map(v => v.trim()).filter(v => v.startsWith('__Host-github-link='));
      const cookie = cookies[0]?.slice('__Host-github-link='.length);
      if (cookies.length !== 1 || !cookie || !/^[A-Za-z0-9_-]{43}$/u.test(cookie)) throw new HttpFailure(400);
      const clear = '__Host-github-link=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';
      const ok = await this.browser!.githubCallback!(form, cookie, { ...ctx,
        committed: () => { if (!ctx.signal.aborted && !this.stopping) browserResponse(res, 200, undefined, clear); } });
      if (ctx.signal.aborted || this.stopping) throw new HttpFailure(503);
      browserResponse(res, ok ? 200 : 400, undefined, clear); return;
    }
    // Only the fixed early host cookie is accepted; never a context secret or selector.
    let initialCookie: string | undefined;
    if (req.headers.cookie !== undefined) {
      const cookies = req.headers.cookie.split(';').map(v => v.trim()).filter(v => v.startsWith('__Host-github-ms='));
      initialCookie = cookies[0]?.slice('__Host-github-ms='.length);
      if (req.headersDistinct.cookie?.length !== 1 || cookies.length > 1 || initialCookie !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(initialCookie)) throw new HttpFailure(400);
    }
    if (req.method === 'GET') {
      const query = new URLSearchParams(req.url!.slice('/signin?'.length));
      const id = query.get('challenge');
      if ([...query.keys()].length !== 1 || !id || !CHALLENGE.test(id)) throw new HttpFailure(400);
      const begun = await this.browser!.begin(id, ctx, initialCookie);
      const redirect = typeof begun === 'object' ? begun.redirect : begun;
      if (ctx.signal.aborted || this.stopping) throw new HttpFailure(503);
      if (!redirect) throw new HttpFailure(400);
      // A sign-in handler can redirect only to Entra, never a request-supplied return URL.
      const url = new URL(redirect);
      if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com' || url.port || url.username || url.password || url.hash) throw new HttpFailure(503);
      const cookie = typeof begun === 'object' ? begun.cookie : undefined;
      if (cookie && (!/^[A-Za-z0-9_-]{43}$/u.test(cookie.value) || !Number.isInteger(cookie.maxAge) || cookie.maxAge < 1 || cookie.maxAge > 600)) throw new HttpFailure(503);
      // Entra form_post is cross-site POST: explicit Lax would drop this binding.
      browserResponse(res, 302, redirect, cookie ? `__Host-github-ms=${cookie.value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${cookie.maxAge}` : undefined); return;
    }
    if (req.headersDistinct['content-type']?.length !== 1 ||
      !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? '') ||
      req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') throw new HttpFailure(415);
    if (Number(req.headers['content-length'] ?? 0) > 16384) throw new HttpFailure(413);
    const form = await readBody(req, ctx.signal, true) as URLSearchParams;
    const allowed = new Set(['code', 'state', 'session_state', 'error', 'error_description', 'error_uri']);
    const keys = [...form.keys()];
    if (keys.some(key => !allowed.has(key)) || new Set(keys).size !== keys.length || !form.get('state') ||
      !!form.get('code') === !!form.get('error')) throw new HttpFailure(400);
    // Account publication is success even when the best-effort notification outlives HTTP.
    // Keep awaiting the callback: response completion is not actual-work completion.
    const ok = await this.browser!.callback(form, { ...ctx, committed: () => { if (!ctx.signal.aborted && !this.stopping) browserResponse(res, 200); } }, initialCookie);
    if (ctx.signal.aborted || this.stopping) throw new HttpFailure(503);
    if (typeof ok === 'object') {
      const url = new URL(ok.redirect); const cookie = ok.cookie;
      if (url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize' || url.username || url.password || url.port || url.hash ||
        !/^[A-Za-z0-9_-]{43}$/u.test(cookie.value) || !Number.isInteger(cookie.maxAge) || cookie.maxAge < 1 || cookie.maxAge > 600) throw new HttpFailure(503);
      browserResponse(res, 302, ok.redirect, `__Host-github-link=${cookie.value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${cookie.maxAge}`); return;
    }
    browserResponse(res, ok ? 200 : 400);
  }
}

function browserResponse(res: ServerResponse, status: number, location?: string, cookie?: string): void {
  if (res.writableEnded || res.destroyed) return;
  const text = status === 200 ? 'You are signed in. Send your request again.' : status === 302 ? 'Continue in your browser.' :
    'Sign-in could not be completed. Send your request again to start a new sign-in.';
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Connection': 'close', ...(location ? { Location: location } : {}), ...(cookie ? { 'Set-Cookie': cookie } : {}) });
  res.end(text);
}

function respond(res: ServerResponse, status: number, body?: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const accepted = status === 200 && body !== null && typeof body === 'object' && 'status' in body &&
    ['accepted', 'duplicate', 'ignored'].includes(String(body.status));
  // Only our explicit invoke wrapper may cross this projection, never SDK bodies/errors.
  let invoke: { id: string; connectionName: string; failureDetail?: 'signin-required' } | undefined;
  if ((status === 200 || status === 412) && body !== null && typeof body === 'object' && 'invokeResponse' in body) {
    const value = body.invokeResponse;
    if (value !== null && typeof value === 'object' && 'id' in value && 'connectionName' in value &&
        typeof value.id === 'string' && /^[A-Za-z0-9._-]{0,256}$/u.test(value.id) &&
        typeof value.connectionName === 'string' && /^[A-Za-z0-9._-]{0,128}$/u.test(value.connectionName)) {
      invoke = { id: value.id, connectionName: value.connectionName, ...(status === 412 ? { failureDetail: 'signin-required' as const } : {}) };
    }
  }
  const text = JSON.stringify(invoke ?? (accepted ? { status: (body as { status: string }).status } : { error: 'Request rejected' }));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Connection': 'close' });
  res.end(text);
}

function readBody(req: IncomingMessage, signal: AbortSignal, form = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', failed); signal.removeEventListener('abort', abort); };
    const failed = () => { cleanup(); reject(new HttpFailure(400)); };
    const abort = () => { cleanup(); reject(new HttpFailure(408)); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > (form ? 16384 : BODY_BYTES)) { cleanup(); req.pause(); reject(new HttpFailure(413)); }
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
        resolve(form ? new URLSearchParams(text) : JSON.parse(text));
      }
      catch { reject(new HttpFailure(400)); }
    };
    req.on('data', data); req.once('end', end); req.once('error', failed); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
