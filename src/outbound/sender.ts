import { Agent } from 'node:https';
import { Client } from '@microsoft/teams.common/http';
import type { RequestConfig } from '@microsoft/teams.common/http';
import { identity } from '../delivery/identity.js';
import { httpsBase } from '../ingress/codec.js';
import { tlsVerificationEnabled } from '../ingress/config.js';
import { safeSdkLogger } from '../ingress/logger.js';
import type { ReplyRoute } from '../ingress/types.js';
import { MAX_ADAPTER_RESPONSE_BYTES } from '../protocol/types.js';
import { MAX_OUTGOING_MESSAGE_BYTES } from '../teams/format.js';
import type { OutgoingTeamsMessage } from '../teams/format.js';
import type { DeliveryContext, ProviderResult, ProviderSender } from './types.js';

// Trusted library I/O seam. Production always uses the fresh public SDK client.
export type ProviderPost = (url: string, body: Buffer, config: RequestConfig<Buffer>) => Promise<{ status: number; data: unknown }>;
export function createProviderSender(acquireToken: () => Promise<string | undefined>, options: { ca?: string | Buffer; post?: ProviderPost } = {}): ProviderSender {
  const ca = Buffer.isBuffer(options.ca) ? Buffer.from(options.ca) : options.ca;
  const agent = new Agent({ rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) });
  const client = new Client({ logger: safeSdkLogger });
  const post: ProviderPost = options.post ?? ((url, body, config) => client.post(url, body, config));
  const work = new Set<Promise<unknown>>();
  const io = new Set<Promise<unknown>>();
  const aborts = new Set<() => void>();
  let tokenWork: Promise<string | undefined> | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;

  function token(): Promise<string | undefined> {
    if (!tokenWork) {
      // The public SDK acquisition cannot be cancelled. Share AND drain the
      // original work, never a caller's deadline race or a growing retry queue.
      const pending = Promise.resolve().then(() => stopped ? undefined : acquireToken()).catch(() => undefined);
      tokenWork = pending; io.add(pending);
      void pending.then(() => { io.delete(pending); if (tokenWork === pending) tokenWork = undefined; });
    }
    return tokenWork;
  }

  function send(route: Readonly<ReplyRoute>, message: Readonly<OutgoingTeamsMessage>, context: DeliveryContext = {}): Promise<ProviderResult> {
    const deadline = Math.min(performance.now() + 9000, context.deadline ?? Infinity);
    let url: string; let body: Buffer;
    try {
      const base = httpsBase(route.serviceUrl);
      const conversationId = identity(route.conversation.id);
      // URL parsers normalize these even after encodeURIComponent.
      if (conversationId === '.' || conversationId === '..') throw new Error();
      url = `${base}v3/conversations/${encodeURIComponent(conversationId)}/activities`;
      body = Buffer.from(JSON.stringify(message), 'utf8');
      if (body.length > MAX_OUTGOING_MESSAGE_BYTES) throw new Error();
    } catch { return Promise.resolve({ kind: 'retryable' }); }
    if (stopped || context.signal?.aborted || !Number.isFinite(deadline) || performance.now() >= deadline || !tlsVerificationEnabled()) {
      return Promise.resolve({ kind: 'retryable' });
    }
    const result = new Promise<ProviderResult>((resolve) => {
      const controller = new AbortController();
      let finished = false; let handedOff = false;
      const finish = (outcome: ProviderResult) => {
        if (finished) return;
        finished = true; clearTimeout(timer); aborts.delete(abort); context.signal?.removeEventListener('abort', abort);
        resolve(outcome);
      };
      const abort = () => {
        finish({ kind: handedOff ? 'unknown' : 'retryable' });
        controller.abort();
      };
      const timer = setTimeout(abort, Math.max(1, Math.ceil(deadline - performance.now())));
      aborts.add(abort); context.signal?.addEventListener('abort', abort, { once: true });
      void token().then((value) => {
        if (finished) return;
        // A timer alone is insufficient: synchronous SQLite/token work can
        // exhaust the budget before the event loop gets to run that timer.
        if (stopped || context.signal?.aborted || performance.now() >= deadline || !tlsVerificationEnabled() ||
            typeof value !== 'string' || !value || value.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(value)) {
          finish({ kind: 'retryable' }); return;
        }
        const config: RequestConfig<Buffer> = {
          token: value, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Accept: 'application/json' },
          httpsAgent: agent, maxRedirects: 0, proxy: false, responseType: 'arraybuffer', decompress: false,
          maxContentLength: MAX_ADAPTER_RESPONSE_BYTES, maxBodyLength: MAX_OUTGOING_MESSAGE_BYTES,
          validateStatus: () => true, signal: controller.signal, timeout: Math.max(1, Math.ceil(deadline - performance.now())),
        };
        // Uncertainty begins at SDK handoff, not a guessed socket write boundary.
        // No inherited retry interceptors; withConfig receives a fresh config
        // and string token so it cannot start hidden token acquisition.
        handedOff = true;
        try {
          const pending = post(url, body, config).then((response) => {
            if (finished) return;
            finish(receipt(response));
          }, () => finish({ kind: 'unknown' })).catch(() => finish({ kind: 'unknown' }));
          io.add(pending); void pending.then(() => io.delete(pending));
        } catch { finish({ kind: 'unknown' }); }
      });
    });
    work.add(result); void result.then(() => work.delete(result));
    return result;
  }

  return {
    send,
    stop() {
      if (!stopping) {
        stopped = true;
        for (const abort of aborts) abort();
        stopping = (async () => {
          await Promise.all(work); await Promise.all(io);
          agent.destroy();
        })();
      }
      return stopping;
    },
  };
}

function receipt(response: { status: number; data: unknown }): ProviderResult {
  try {
    if (![200, 201].includes(response.status) || !(response.data instanceof Uint8Array) || response.data.byteLength > MAX_ADAPTER_RESPONSE_BYTES) return { kind: 'unknown' };
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(response.data);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('id' in value)) return { kind: 'unknown' };
    return { kind: 'delivered', providerMessageId: identity(value.id) };
  } catch { return { kind: 'unknown' }; }
}
