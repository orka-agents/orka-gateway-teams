import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DirectoryContext } from '../directory/types.js';
import { object } from '../storage/table/codec.js';
import type { LeaseAuthority } from '../storage/table/types.js';
import type { TaskGrant } from './grants.js';
import { grantBinding, grantRef } from './grants.js';
import type { AccountStore, AccountTokens } from './store.js';
import { AccountError } from './store.js';
import { createWorkIQ, workIQArguments } from './workiq.js';

export interface TaskReply { status: number; body: unknown }
interface Target { id: string; gatewayUid: string; identityDigest: string; taskPassToken: string }
const digest = (s: string) => createHash('sha256').update(s).digest();
const refusal = (error = 'tool-unavailable', status = 403): TaskReply => ({ status, body: { error } });
function deadline(input: unknown): number {
  if (typeof input !== 'string' || input.length > 128) throw new Error();
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/u.exec(input);
  if (!m) throw new Error();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59 ||
    m[7]!.length > 1 && (Number(m[7]!.slice(1, 3)) > 23 || Number(m[7]!.slice(4)) > 59)) throw new Error();
  const value = Date.parse(input); if (!Number.isSafeInteger(value)) throw new Error(); return value;
}
/** Controller-only first binding; passes are process-local, single-use, hash indexed and never persisted. */
export function createTaskService(options: {
  accounts: AccountStore; authority: LeaseAuthority; targets: readonly Target[];
  auth: { exchange(token: string, ctx: DirectoryContext): Promise<AccountTokens>; refresh(token: string, ctx: DirectoryContext): Promise<AccountTokens> };
  workiq?: Parameters<typeof createWorkIQ>[0]; now?: () => number; privateCredentials?: readonly string[]; log?(category: 'grant-binding-conflict'): void;
}) {
  const now = options.now ?? Date.now; const provider = createWorkIQ(options.workiq);
  const targets = options.targets.map(t => ({ ...t, expected: digest(t.taskPassToken) }));
  const privateCredentials = [...targets.map(t => t.taskPassToken), ...(options.privateCredentials ?? [])];
  const passes = new Map<string, { grant: TaskGrant; expiresAt: number }>(); const work = new Set<Promise<TaskReply>>(); const shutdown = new AbortController(); let closed = false;
  const clear = () => passes.clear(); options.authority.lost.addEventListener('abort', clear, { once: true });
  const active = (ctx: DirectoryContext) => !closed && options.authority.allowed() && !ctx.signal.aborted && performance.now() < ctx.deadline && ctx.authorizeWrite?.() !== false;
  const purge = () => { for (const [k, p] of passes) if (p.expiresAt <= now()) passes.delete(k); };
  const targetFor = (token: string) => { const hash = digest(token); return targets.find(t => timingSafeEqual(t.expected, hash)); };
  const passKey = (token: string) => digest(token).toString('hex');
  function authenticate(path: string, token: string): boolean {
    if (closed || !options.authority.allowed()) { clear(); return false; } purge();
    return path === '/v1/task-passes' ? !!targetFor(token) : path === '/v1/task-tools/workiq' && passes.has(passKey(token));
  }
  async function issue(token: string, input: unknown, ctx: DirectoryContext): Promise<TaskReply> {
    const target = targetFor(token); if (!target) return refusal('tool-unavailable', 401);
    const v = object(input, ['protocolVersion', 'grantRef', 'namespaceUID', 'gatewayUID', 'taskUID', 'tools', 'deadline']);
    if (v.protocolVersion !== 'orka.gateway.v1' || v.gatewayUID !== target.gatewayUid) return refusal();
    const binding = grantBinding({ namespaceUID: v.namespaceUID, gatewayUID: v.gatewayUID, taskUID: v.taskUID, tools: v.tools, deadline: deadline(v.deadline) });
    const ref = grantRef(v.grantRef); const grant = await options.accounts.getGrant(ref, ctx);
    if (!grant || grant.targetId !== target.id || grant.targetDigest !== target.identityDigest || binding.deadline <= now()) return refusal();
    try { await options.accounts.bindGrant(ref, target.id, binding, ctx); }
    catch (e) { if (e instanceof AccountError && e.code === 'conflict') options.log?.('grant-binding-conflict'); throw e; }
    if (!await options.authority.revalidate() || !active(ctx)) return refusal();
    const bound = await options.accounts.getGrant(ref, ctx); if (!bound?.binding || !active(ctx)) return refusal();
    purge(); if (passes.size >= 1024) return refusal('tool-unavailable', 503);
    // Orka checks the five-minute cap against its own clock at receipt.
    const expiresAt = Math.min(now() + 290_000, binding.deadline); if (expiresAt <= now()) return refusal();
    const pass = randomBytes(32).toString('base64url'); passes.set(passKey(pass), { grant: bound, expiresAt });
    return { status: 200, body: { pass, expiresAt: new Date(expiresAt).toISOString() } };
  }
  async function call(token: string, input: unknown, supplied: DirectoryContext): Promise<TaskReply> {
    const key = passKey(token); const pass = passes.get(key); passes.delete(key); // Consume before any await, including storage/renewal.
    if (!pass || pass.expiresAt <= now() || !pass.grant.binding || pass.grant.binding.deadline <= now()) return refusal();
    const args = workIQArguments(input); const frozen = pass.grant;
    const ctx = { ...supplied, deadline: Math.min(supplied.deadline, performance.now() + frozen.binding!.deadline - now()) };
    const grant = await options.accounts.getGrant(frozen.ref, ctx);
    if (!grant || !grant.binding || grant.generation !== frozen.generation || grant.binding.taskUID !== frozen.binding!.taskUID || !grant.binding.tools.includes('workiq')) return refusal('signin-required');
    const acquired = await options.accounts.acquire({ objectId: grant.objectId }, grant.generation, assertion => options.auth.exchange(assertion, ctx), ctx,
      refreshToken => options.auth.refresh(refreshToken, ctx));
    if (acquired.kind !== 'token') return refusal('signin-required');
    if (!await options.authority.revalidate() || !active(ctx)) return refusal();
    // Renewal and owner validation may await; re-read the original generation last, immediately before native send.
    if (!await options.accounts.getGrant(frozen.ref, ctx)) return refusal('signin-required');
    if (!active(ctx) || pass.expiresAt <= now() || frozen.binding!.deadline <= now()) return refusal();
    const result = await provider.ask(args, acquired.accessToken, ctx);
    if ([token, ...privateCredentials].some(secret => secret && result.text.includes(secret)) ||
      !await options.accounts.safeGrantOutput(frozen.ref, result.text, ctx)) return refusal();
    return { status: 200, body: result };
  }
  return {
    authenticate,
    handle(path: string, token: string, input: unknown, supplied: DirectoryContext): Promise<TaskReply> {
      if (!active(supplied)) return Promise.resolve(refusal());
      if (work.size >= 4) return Promise.resolve(refusal('tool-unavailable', 503));
      const ctx = { ...supplied, signal: AbortSignal.any([supplied.signal, shutdown.signal]), authorizeWrite: () => !closed && options.authority.allowed() && supplied.authorizeWrite?.() !== false };
      const pending = Promise.resolve().then(() => {
        if (!active(ctx)) return refusal();
        return path === '/v1/task-passes' ? issue(token, input, ctx) : path === '/v1/task-tools/workiq' ? call(token, input, ctx) : refusal();
      }).catch(() => refusal());
      work.add(pending); void pending.then(() => work.delete(pending)); return pending;
    },
    async close(): Promise<void> { closed = true; clear(); shutdown.abort(); options.authority.lost.removeEventListener('abort', clear); await Promise.allSettled(work); await provider.close(); },
  };
}
export type TaskService = ReturnType<typeof createTaskService>;
