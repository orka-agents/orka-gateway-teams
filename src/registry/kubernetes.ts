import type { ClientRequest } from 'node:http';
import https from 'node:https';
import { ConfigurationError, tlsVerificationEnabled } from '../ingress/config.js';
import { readCaBundle } from '../ingress/runtime-shared.js';
import { auditFields, subscribeAuditAbort } from '../storage/table/audit.js';
import type { RegistryTarget } from './config.js';
import { snapshotRegistry } from './config.js';
import { readRegistryFile } from './files.js';

export function createKubernetesReader(input: RegistryTarget, dependencies: { request?: typeof https.request; now?: () => number } = {}) {
  const target = snapshotRegistry({ schemaVersion: 1, legacyTargetId: input.id, targets: [input] }).targets[0]!;
  if (!tlsVerificationEnabled()) throw new ConfigurationError();
  const request = dependencies.request ?? https.request; const now = dependencies.now ?? Date.now;
  const ca = target.kubernetesCaFile === undefined ? undefined : readCaBundle(target.kubernetesCaFile);
  const namespace = encodeURIComponent(target.config.scope.gatewayNamespace);
  const gatewayRoot = `/apis/gateway.orka.ai/v1alpha1/namespaces/${namespace}`;
  const bindingPath = `${gatewayRoot}/gatewaybindings`;
  const work = new Set<Promise<unknown>>(); const cancellations = new Set<() => void>(); let closed = false;
  const failed = () => new Error('Kubernetes read failed');
  function credential(): string {
    try {
      const data = auditFields(JSON.parse(readRegistryFile(target.kubernetesTokenFile, 16384)), ['token', 'expiresAt']);
      if (typeof data.token !== 'string' || !data.token || data.token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(data.token) ||
          typeof data.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(data.expiresAt)) throw failed();
      const expiry = Date.parse(data.expiresAt); const clock = now();
      if (!Number.isFinite(expiry) || !Number.isFinite(clock) || new Date(expiry).toISOString() !== (data.expiresAt.length === 20 ? data.expiresAt.replace('Z', '.000Z') : data.expiresAt)) throw failed();
      if (expiry - clock <= 300000) throw new Error('credential-expiring');
      return data.token;
    } catch (error) { throw error instanceof Error && error.message === 'credential-expiring' ? error : failed(); }
  }
  function get(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (closed || signal?.aborted || !tlsVerificationEnabled()) return Promise.reject(failed());
    let bearer: string; try { bearer = credential(); } catch (error) { return Promise.reject(error); }
    const operation = new Promise<Record<string, unknown>>((resolve, reject) => {
      let req: ClientRequest | undefined; let settled = false; let removeAbort: (() => void) | undefined;
      const finish = (value?: Record<string, unknown>) => {
        if (settled) return; settled = true; clearTimeout(timer); removeAbort?.(); cancellations.delete(abort);
        const complete = () => value === undefined ? reject(failed()) : resolve(value);
        // Logical completion is not actual native close; close() drains this promise.
        if (req && !req.closed) { req.once('close', complete); req.destroy(); } else complete();
      };
      const abort = () => finish(); const timer = setTimeout(abort, 10000);
      cancellations.add(abort);
      if (signal) removeAbort = subscribeAuditAbort(signal, abort);
      try {
        if (closed || signal?.aborted || !tlsVerificationEnabled()) { abort(); return; }
        req = request(new URL(path, target.kubernetesBaseUrl), { method: 'GET', agent: false, rejectUnauthorized: true, maxHeaderSize: 16384,
          ...(ca === undefined ? {} : { ca }), headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' } }, response => {
          if (response.statusCode !== 200) { finish(); response.destroy(); return; }
          let size = 0; const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1048576) { finish(); response.destroy(); } else chunks.push(chunk); });
          response.on('error', abort); response.on('aborted', abort);
          response.on('end', () => {
            try {
              const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
              if (!record(value) || !record(value.metadata) || typeof value.kind !== 'string') throw failed(); finish(value);
            } catch { finish(); }
          });
          response.on('close', () => { if (!response.complete) abort(); });
        });
        req.once('error', abort); req.once('close', () => { if (!settled) abort(); });
        if (closed || signal?.aborted || settled) { req.destroy(); return; } req.end();
      } catch { finish(); }
    });
    work.add(operation); void operation.then(() => work.delete(operation), () => work.delete(operation)); return operation;
  }
  return Object.freeze({
    getGateway: (signal?: AbortSignal) => get(`${gatewayRoot}/gateways/${encodeURIComponent(target.config.scope.gatewayName)}`, signal),
    getAgent: (signal?: AbortSignal) => get(`/apis/core.orka.ai/v1alpha1/namespaces/${namespace}/agents/${encodeURIComponent(target.frontAgent.name)}`, signal),
    async listBindings(signal?: AbortSignal): Promise<Record<string, unknown>[]> {
      const result: Record<string, unknown>[] = []; const continuations = new Set<string>(); let continuation = '';
      for (let page = 0; page < 100; page++) {
        const value = await get(`${bindingPath}?limit=100${continuation ? `&continue=${encodeURIComponent(continuation)}` : ''}`, signal);
        if (!Array.isArray(value.items) || !value.items.every(record) || value.items.length > 10000 - result.length) throw failed();
        result.push(...value.items as Record<string, unknown>[]);
        const next = (value.metadata as Record<string, unknown>).continue;
        if (next === undefined || next === '') return result;
        if (typeof next !== 'string' || next.length > 8192 || /[\p{Cc}\uD800-\uDFFF]/u.test(next) || continuations.has(next)) throw failed();
        continuations.add(next); continuation = next;
      }
      throw failed();
    },
    async close(): Promise<void> { closed = true; for (const abort of cancellations) abort(); await Promise.allSettled([...work]); },
  });
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
