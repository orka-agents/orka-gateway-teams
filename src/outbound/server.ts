import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { Socket } from 'node:net';
import { identity, validateScope } from '../delivery/identity.js';
import type { JournalScope } from '../delivery/types.js';
import { ConfigurationError, tlsVerificationEnabled } from '../ingress/config.js';
import { MAX_HTTP_BODY_BYTES } from '../protocol/types.js';
import type { DeliveryDispatcher, DeliveryResponse } from './types.js';
import { decodeDelivery } from './validate.js';

export interface OutboundServerConfig { host: string; port: number; bearerToken: string }
export interface OutboundServer { port: number; failed: Promise<never>; stop(): Promise<void> }
const DEADLINE_MS = 10000;
const retryable: DeliveryResponse = Object.freeze({ status: 'retryableError', message: 'Delivery is temporarily unavailable.' });
const rejected: DeliveryResponse = Object.freeze({ status: 'nonRetryableError', message: 'Delivery cannot be completed safely.' });
const capabilities = { protocolVersion: 'orka.gateway.v1', adapterName: 'orka-gateway-teams', adapterVersion: '0.0.0',
  capabilities: { inboundText: true, outboundText: true, threads: false, senderIdentity: true, explicitSessions: false, idempotentDelivery: true } };
class HttpFailure extends Error { constructor(readonly status: number) { super('Request rejected'); } }

/** Separate bearer boundary; never registers a route on the Teams SDK listener. */
export async function startOutboundServer(config: OutboundServerConfig, dispatcher: DeliveryDispatcher, inputScope: Readonly<JournalScope>, isReady: () => boolean): Promise<OutboundServer> {
  if (!tlsVerificationEnabled() || !isIP(config.host) || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535 ||
      typeof config.bearerToken !== 'string' || !config.bearerToken || config.bearerToken.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(config.bearerToken)) throw new ConfigurationError();
  const scope = validateScope(inputScope); const expected = digest(config.bearerToken);
  const starts = new WeakMap<Socket, number>(); const work = new Set<Promise<void>>(); const controllers = new Set<AbortController>();
  let active = 0; let stopping = false; let closing: Promise<void> | undefined; let bound = false;
  let fail!: (error: Error) => void; const failed = new Promise<never>((_resolve, reject) => { fail = reject; });
  void failed.catch(() => {});
  const server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: DEADLINE_MS, requestTimeout: DEADLINE_MS,
    connectionsCheckingInterval: 1000 }, (req, res) => {
    const operation = handle(req, res); work.add(operation); void operation.then(() => work.delete(operation));
  });
  server.maxRequestsPerSocket = 1;
  server.on('connection', (socket) => {
    starts.set(socket, performance.now());
    const timer = setTimeout(() => socket.destroy(), DEADLINE_MS); timer.unref();
    socket.once('close', () => clearTimeout(timer));
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  server.on('error', () => { if (bound && !stopping) fail(new Error('Outbound listener failed')); });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controller = new AbortController(); controllers.add(controller); let admitted = false; let authenticated = false;
    const deadline = (starts.get(req.socket) ?? performance.now()) + DEADLINE_MS;
    const finished = new Promise<void>((resolve) => { res.once('finish', resolve); res.once('close', resolve); });
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', disconnected);
    const timer = setTimeout(() => { controller.abort(); respond(res, 408, retryable); }, Math.max(1, Math.ceil(deadline - performance.now()))); timer.unref();
    try {
      // Authenticate even unavailable/unknown routes, before consuming any body or consulting readiness/storage.
      const values = req.headersDistinct.authorization;
      const token = values?.length === 1 ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/iu.exec(values[0]!)?.[1] : undefined;
      if (!token || token.length > 8192 || !timingSafeEqual(expected, digest(token))) throw new HttpFailure(401);
      authenticated = true;
      if (stopping || !tlsVerificationEnabled() || !dispatcher.healthy || !isReady()) throw new HttpFailure(503);
      if (req.method === 'GET' && req.url === '/v1/health') { respond(res, 200, { status: 'ok' }); return; }
      if (req.method === 'GET' && req.url === '/v1/capabilities') { respond(res, 200, capabilities); return; }
      if (req.method !== 'POST' || req.url !== '/v1/deliveries') throw new HttpFailure(404);
      if (active >= 32) { respond(res, 200, retryable); return; }
      active++; admitted = true;
      const type = req.headersDistinct['content-type']; const encoding = req.headersDistinct['content-encoding'];
      if (type?.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type[0]!) ||
          (encoding !== undefined && (encoding.length !== 1 || encoding[0] !== 'identity'))) throw new HttpFailure(415);
      if (Number(req.headers['content-length'] ?? 0) > MAX_HTTP_BODY_BYTES) throw new HttpFailure(413);
      const bytes = await readBody(req, controller.signal);
      let delivery;
      try { delivery = decodeDelivery(bytes, scope); } catch { throw new HttpFailure(400); }
      // Body/header time consumes the same absolute budget. Reserve 1s for settlement/response.
      const dispatchDeadline = Math.min(performance.now() + 9000, deadline - 1000);
      if (controller.signal.aborted || stopping || performance.now() >= dispatchDeadline || !dispatcher.healthy || !isReady()) throw new HttpFailure(503);
      const result = await dispatcher.deliver(delivery, { signal: controller.signal, deadline: dispatchDeadline });
      respond(res, 200, safeDelivery(result));
    } catch (error) {
      const status = error instanceof HttpFailure ? error.status : 503;
      respond(res, status, status >= 500 || status === 408 ? retryable : rejected);
    } finally {
      // A poisoned dispatcher must not let runtime shutdown preempt its fixed response.
      if (authenticated && !dispatcher.healthy) void finished.then(() => fail(new Error('Outbound storage failed')));
      clearTimeout(timer); controllers.delete(controller); res.off('close', disconnected); if (admitted) active--;
    }
  }

  function stop(): Promise<void> {
    closing ??= (async () => {
      stopping = true; for (const controller of controllers) controller.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections(); await closed; await Promise.all(work);
    })();
    return closing;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const error = () => { server.off('listening', ready); reject(new Error('Outbound startup failed')); };
      const ready = () => { server.off('error', error); resolve(); };
      server.once('error', error); server.once('listening', ready); server.listen(config.port, config.host);
    });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error();
    bound = true; return { port: address.port, failed, stop };
  } catch { await stop(); throw new Error('Outbound startup failed'); }
}

function digest(token: string): Buffer { return createHash('sha256').update(token).digest(); }
function safeDelivery(result: DeliveryResponse): DeliveryResponse {
  if (result.status === 'delivered') return { status: 'delivered', providerMessageId: identity(result.providerMessageId) };
  return result.status === 'nonRetryableError' ? rejected : retryable;
}
function respond(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Connection: 'close' }); res.end(text);
}
function readBody(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', failed); signal.removeEventListener('abort', abort); };
    const failed = () => { cleanup(); reject(new HttpFailure(400)); };
    const abort = () => { cleanup(); reject(new HttpFailure(408)); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) { cleanup(); req.pause(); reject(new HttpFailure(413)); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on('data', data); req.once('end', end); req.once('error', failed); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
