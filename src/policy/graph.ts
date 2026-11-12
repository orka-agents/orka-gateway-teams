import type { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import type { GraphIdentity, PolicyRequestContext } from '../auth/graph-identity.js';
import { tlsVerificationEnabled } from '../ingress/config.js';
import { auditFields, subscribeAuditAbort } from '../storage/table/audit.js';
import { uuid } from './config.js';

export interface GraphMembershipClient {
  lookup(objectId: string, groupIds: readonly string[], context: PolicyRequestContext): Promise<readonly string[]>;
  close(): Promise<void>;
}
/** Fixed Graph destination and application purpose. The client owns its identity source. */
export function createGraphMembershipClient(identity: GraphIdentity, dependencies: { request?: typeof https.request } = {}): GraphMembershipClient {
  const request = dependencies.request ?? https.request;
  const work = new Set<Promise<readonly string[]>>(); const cancellations = new Set<() => void>(); let closing: Promise<void> | undefined;
  const usable = () => { if (closing || !tlsVerificationEnabled()) throw failure(); identity.assertUsable(); };
  function post(objectId: string, groups: readonly string[], token: string, context: PolicyRequestContext): Promise<readonly string[]> {
    return new Promise((resolve, reject) => {
      let req: ClientRequest | undefined; let response: IncomingMessage | undefined;
      let result: readonly string[] | undefined; let failed = false; let requestClosed = false; let socketClosed = true;
      let removeAbort: (() => void) | undefined;
      const eligible = () => !context.signal.aborted && performance.now() < context.deadline && Number.isFinite(performance.now());
      const finish = () => {
        if (!requestClosed || !socketClosed) return;
        clearTimeout(timer); removeAbort?.(); cancellations.delete(abort);
        try { usable(); if (failed || !result || !eligible()) throw failure(); resolve(result); } catch { reject(failure()); }
      };
      const abort = () => { failed = true; result = undefined; response?.destroy(); req?.destroy(); };
      const timer = setTimeout(abort, Math.max(0, context.deadline - performance.now()));
      cancellations.add(abort); removeAbort = subscribeAuditAbort(context.signal, abort);
      try {
        usable(); if (!eligible()) throw failure();
        const body = JSON.stringify({ groupIds: groups });
        req = request(new URL(`https://graph.microsoft.com/v1.0/users/${objectId}/checkMemberGroups`), {
          method: 'POST', agent: false, rejectUnauthorized: true, maxHeaderSize: 16384,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json',
            'content-length': Buffer.byteLength(body), connection: 'close' },
        }, res => {
          response = res; res.on('error', abort); res.on('aborted', abort);
          if (res.statusCode !== 200 || (res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity')) { abort(); return; }
          let size = 0; const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65536 || !eligible()) abort(); else chunks.push(Buffer.from(chunk)); });
          res.on('end', () => {
            try {
              if (failed || !res.complete || !eligible()) throw failure();
              const value = auditFields(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))), ['value', '@odata.context']);
              if ((value['@odata.context'] !== undefined && typeof value['@odata.context'] !== 'string') || !Array.isArray(value.value) || value.value.length > groups.length) throw failure();
              const memberships = value.value.map(uuid);
              if (new Set(memberships).size !== memberships.length || memberships.some(id => !groups.includes(id))) throw failure();
              result = Object.freeze(memberships); req?.destroy();
            } catch { abort(); }
          });
          res.on('close', () => { if (!res.complete) abort(); });
        });
        req.once('socket', socket => { socketClosed = false; socket.once('close', () => { socketClosed = true; finish(); }); });
        req.on('error', () => { failed = true; });
        req.once('close', () => { requestClosed = true; finish(); });
        if (failed || !eligible()) abort(); else req.end(body);
      } catch { abort(); if (!req) { requestClosed = true; finish(); } }
    });
  }
  return Object.freeze({
    lookup(input: string, inputGroups: readonly string[], context: PolicyRequestContext): Promise<readonly string[]> {
      try {
        usable(); const objectId = uuid(input);
        if (!Array.isArray(inputGroups) || inputGroups.length > 256 || work.size >= 32 || !Number.isFinite(context.deadline)) throw failure();
        const groups = inputGroups.map(uuid); if (new Set(groups).size !== groups.length) throw failure();
        const signal = context.signal; const deadline = Math.min(context.deadline, performance.now() + 10000);
        const eligible = () => !signal.aborted && Number.isFinite(deadline) && Number.isFinite(performance.now()) && performance.now() < deadline;
        if (!eligible()) throw failure();
        const operation = (async () => {
          if (!groups.length) return Object.freeze([]);
          const token = await identity.token({ signal, deadline }); usable();
          if (!eligible() || typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(token)) throw failure();
          const batches: Promise<readonly string[]>[] = [];
          for (let n = 0; n < groups.length; n += 20) batches.push(post(objectId, groups.slice(n, n + 20), token, { signal, deadline }));
          // All native batches drain before the caller can release its reservation, even on failure.
          const results = await Promise.allSettled(batches); usable();
          if (!eligible() || results.some(r => r.status === 'rejected')) throw failure();
          return Object.freeze(results.flatMap(r => r.status === 'fulfilled' ? [...r.value] : []).sort());
        })().catch(() => { throw failure(); });
        work.add(operation); void operation.then(() => work.delete(operation), () => work.delete(operation)); return operation;
      } catch { return Promise.reject(failure()); }
    },
    close() {
      if (!closing) {
        closing = Promise.allSettled([...work]).then(() => identity.close());
        for (const abort of cancellations) abort();
      }
      return closing;
    },
  });
}
function failure(): Error { return new Error('Graph membership unavailable'); }
