import { randomUUID } from 'node:crypto';
import type { ClientRequest } from 'node:http';
import https from 'node:https';
import { parseCanonicalJSON } from '../directory/codec.js';
import type { DirectoryContext } from '../directory/types.js';
import { tlsVerificationEnabled } from '../ingress/config.js';
import { integer, object } from '../storage/table/codec.js';

export interface WorkIQArguments { question: string; location?: { timeZoneOffset: number; timeZone: string } }
const failure = () => new Error('Tool unavailable');
export function workIQArguments(input: unknown): WorkIQArguments {
  const v = object(input, ['question', 'location']);
  if (typeof v.question !== 'string' || !v.question.trim() || Buffer.byteLength(v.question) > 32768 ||
    /[\uD800-\uDFFF]/u.test(v.question) || /\p{Cc}/u.test(v.question.replace(/[\t\r\n]/gu, ''))) throw failure();
  let location: WorkIQArguments['location'];
  if (v.location !== undefined) {
    const l = object(v.location, ['timeZoneOffset', 'timeZone']);
    if (typeof l.timeZone !== 'string' || l.timeZone.length > 128) throw failure();
    new Intl.DateTimeFormat('en', { timeZone: l.timeZone });
    location = { timeZoneOffset: integer(l.timeZoneOffset, -840, 840), timeZone: l.timeZone };
  }
  return { question: v.question, ...(location ? { location } : {}) };
}
function completedText(input: unknown, id: string): string {
  const v = object(input, ['jsonrpc', 'id', 'result']); if (v.jsonrpc !== '2.0' || v.id !== id) throw failure();
  const result = object(v.result, ['task']); const task = object(result.task);
  const status = object(task.status); if (status.state !== 'TASK_STATE_COMPLETED' || !Array.isArray(task.artifacts) ||
    !task.artifacts.length || task.artifacts.length > 128) throw failure();
  const texts: string[] = [];
  for (const artifact of task.artifacts) {
    const a = object(artifact); if (!Array.isArray(a.parts) || !a.parts.length || a.parts.length > 128) throw failure();
    for (const part of a.parts) { const p = object(part, ['text', 'metadata']); if (typeof p.text !== 'string' || !p.text.trim()) throw failure(); texts.push(p.text); }
  }
  const text = texts.join('\n'); if (Buffer.byteLength(text) > 131072) throw failure(); return text;
}
/** Fixed read-only A2A call. The native request seam is for library tests, never runtime routing configuration. */
export function createWorkIQ(deps: { request?: typeof https.request } = {}) {
  const request = deps.request ?? https.request; const shutdown = new AbortController(); const work = new Set<Promise<unknown>>();
  let closed = false;
  const active = (ctx: DirectoryContext) => {
    if (closed || ctx.signal.aborted || performance.now() >= ctx.deadline || !Number.isFinite(ctx.deadline) ||
      ctx.authorizeWrite?.() === false || !tlsVerificationEnabled()) throw failure();
  };
  function post(args: WorkIQArguments, token: string, ctx: DirectoryContext): Promise<{ text: string }> {
    const id = randomUUID(); const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'SendMessage', params: {
      message: { role: 'ROLE_USER', messageId: randomUUID(), parts: [{ text: args.question }], ...(args.location ? { metadata: { Location: args.location } } : {}) } } }));
    return new Promise((resolve, reject) => {
      let req: ClientRequest | undefined; let requestClosed = false; let socketClosed = true; let result: { text: string } | undefined; let failed = false;
      const finish = () => {
        if (!requestClosed || !socketClosed) return;
        clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); shutdown.signal.removeEventListener('abort', abort);
        if (result && !failed) resolve(result); else reject(failure());
      };
      const abort = () => { failed = true; req?.destroy(); };
      const timer = setTimeout(abort, Math.max(1, ctx.deadline - performance.now())); timer.unref();
      ctx.signal.addEventListener('abort', abort, { once: true }); shutdown.signal.addEventListener('abort', abort, { once: true });
      try {
        active(ctx);
        req = request(new URL('https://workiq.svc.cloud.microsoft/a2a/'), { method: 'POST', agent: false, rejectUnauthorized: true, maxHeaderSize: 16384,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length,
            'A2A-Version': '1.0', Accept: 'application/json', 'Accept-Encoding': 'identity', Connection: 'close' } }, res => {
          const chunks: Buffer[] = []; let size = 0;
          res.on('error', abort); res.on('aborted', abort);
          res.on('data', (b: Buffer) => { size += b.length; if (size > 262144) abort(); else chunks.push(b); });
          res.on('end', () => {
            try {
              active(ctx);
              if (res.statusCode !== 200 || !res.complete || res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity' ||
                !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(res.headers['content-type'] ?? '')) throw failure();
              const text = completedText(parseCanonicalJSON(Buffer.concat(chunks)), id);
              if (text.includes(token)) throw failure(); result = { text };
            } catch { failed = true; }
            req?.destroy();
          });
        });
        req.once('socket', socket => { socketClosed = false; socket.once('close', () => { socketClosed = true; finish(); }); });
        req.once('error', () => { failed = true; }); req.once('close', () => { requestClosed = true; finish(); });
        active(ctx); req.end(body);
      } catch { abort(); if (!req) { requestClosed = true; finish(); } }
    });
  }
  return {
    ask(input: unknown, token: string, ctx: DirectoryContext): Promise<{ text: string }> {
      try { active(ctx); if (work.size >= 4 || typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/u.test(token) || token.length > 16384) throw failure();
        const args = workIQArguments(input); const pending = post(args, token, ctx).catch(() => { throw failure(); });
        work.add(pending); void pending.then(() => work.delete(pending), () => work.delete(pending)); return pending;
      } catch { return Promise.reject(failure()); }
    },
    async close(): Promise<void> { closed = true; shutdown.abort(); await Promise.allSettled(work); },
  };
}
