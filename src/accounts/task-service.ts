import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DirectoryContext } from '../directory/types.js';
import { object } from '../storage/table/codec.js';
import type { LeaseAuthority } from '../storage/table/types.js';
import type { TaskGrant } from './grants.js';
import { grantBinding, grantRef, githubTools, writeTool, operationKey } from './grants.js';
import type { AccountStore, AccountTokens } from './store.js';
import { AccountError } from './store.js';
import { githubArguments, GitHubError } from './github.js';
import type { createGitHub } from './github.js';
import type { GitHubTool } from './grants.js';
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
  github?: { accounts: AccountStore; auth: Pick<ReturnType<typeof createGitHub>, 'refresh' | 'tool' | 'safeOutput'> };
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
  const toolFor = (path: string) => ['workiq', ...(options.github ? githubTools : [])].find(t => path === `/v1/task-tools/${t}`);
  async function githubLive(grant: TaskGrant, ctx: DirectoryContext) {
    if (!grant.githubGeneration || !options.github) return false;
    const a = await options.github.accounts.inspect({ objectId: grant.objectId }, ctx); return a.linked && a.generation === grant.githubGeneration;
  }
  async function safeOutput(grant: TaskGrant, text: string, token: string, accessToken: string, ctx: DirectoryContext) {
    if ([token, accessToken, ...privateCredentials].some(s => s && text.includes(s)) || !await options.accounts.safeGrantOutput(grant.ref, text, ctx)) return false;
    if (!options.github) return true;
    const a = await options.github.accounts.inspect({ objectId: grant.objectId }, ctx);
    return options.github.auth.safeOutput(text) && await options.github.accounts.safeOutput({ objectId: grant.objectId }, a.generation, text, ctx);
  }
  function authenticate(path: string, token: string): boolean {
    if (closed || !options.authority.allowed()) { clear(); return false; } purge();
    return path === '/v1/task-passes' ? !!targetFor(token) : toolFor(path) !== undefined && passes.has(passKey(token));
  }
  async function issue(token: string, input: unknown, ctx: DirectoryContext): Promise<TaskReply> {
    const target = targetFor(token); if (!target) return refusal('tool-unavailable', 401);
    const v = object(input, ['protocolVersion', 'grantRef', 'namespaceUID', 'gatewayUID', 'taskUID', 'tools', 'deadline']);
    if (v.protocolVersion !== 'orka.gateway.v1' || v.gatewayUID !== target.gatewayUid) return refusal();
    const binding = grantBinding({ namespaceUID: v.namespaceUID, gatewayUID: v.gatewayUID, taskUID: v.taskUID, tools: v.tools, deadline: deadline(v.deadline) });
    const ref = grantRef(v.grantRef); const grant = await options.accounts.getGrant(ref, ctx);
    if (!grant || grant.targetId !== target.id || grant.targetDigest !== target.identityDigest || binding.deadline <= now() ||
      grant.githubGeneration && !await githubLive(grant, ctx)) return refusal();
    try { await options.accounts.bindGrant(ref, target.id, binding, ctx); }
    catch (e) { if (e instanceof AccountError && e.code === 'conflict') options.log?.('grant-binding-conflict'); throw e; }
    if (!await options.authority.revalidate() || !active(ctx)) return refusal();
    const bound = await options.accounts.getGrant(ref, ctx); if (!bound?.binding || !active(ctx) || bound.githubGeneration && !await githubLive(bound, ctx)) return refusal();
    purge(); if (passes.size >= 1024) return refusal('tool-unavailable', 503);
    // Orka checks the five-minute cap against its own clock at receipt.
    const expiresAt = Math.min(now() + 290_000, binding.deadline); if (expiresAt <= now()) return refusal();
    const pass = randomBytes(32).toString('base64url'); passes.set(passKey(pass), { grant: bound, expiresAt });
    return { status: 200, body: { pass, expiresAt: new Date(expiresAt).toISOString() } };
  }
  async function call(tool: string, token: string, input: unknown, supplied: DirectoryContext, operation?: string): Promise<TaskReply> {
    const writing = writeTool(tool); const key = passKey(token); const pass = passes.get(key); passes.delete(key); // Consume before any await, including storage/renewal.
    if (!pass || pass.expiresAt <= now() || !pass.grant.binding || pass.grant.binding.deadline <= now()) return refusal('tool-unavailable', writing ? 503 : 403);
    const frozen = pass.grant;
    let args: unknown;
    try { args = tool === 'workiq' ? workIQArguments(input) : githubArguments(tool as GitHubTool, input); if (writing) operationKey(operation); }
    catch { return refusal('tool-unavailable', writing ? 400 : 403); }
    const guards: ReturnType<AccountStore['watch']>[] = [];
    const ctx = { ...supplied, deadline: Math.min(supplied.deadline, performance.now() + frozen.binding!.deadline - now()),
      authorizeWrite: () => active(supplied) && pass.expiresAt > now() && frozen.binding!.deadline > now() && guards.every(g => g.active()) };
    const live = async () => {
      const grant = await options.accounts.getGrant(frozen.ref, ctx);
      if (!grant?.binding || grant.generation !== frozen.generation || grant.githubGeneration !== frozen.githubGeneration ||
        grant.binding.taskUID !== frozen.binding!.taskUID || !grant.binding.tools.includes(tool)) return false;
      if (tool === 'workiq' && grant.githubGeneration && !await githubLive(grant, ctx)) return false;
      if (!await options.accounts.getGrant(frozen.ref, ctx)) return false;
      // Table reads remain authoritative; local guards fence both providers through native handoff.
      if (tool !== 'workiq' && grant.githubGeneration && !await githubLive(grant, ctx)) return false;
      return active(ctx) && pass.expiresAt > now() && frozen.binding!.deadline > now();
    };
    let acquired: Awaited<ReturnType<AccountStore['acquire']>> | undefined;
    try {
      if (!await live() || tool !== 'workiq' && !frozen.githubGeneration) return refusal('signin-required', writing ? 503 : 403);
      const subject = { objectId: frozen.objectId }; const g = options.github;
      acquired = tool === 'workiq' ? await options.accounts.acquire(subject, frozen.generation, assertion => options.auth.exchange(assertion, ctx), ctx,
        refreshToken => options.auth.refresh(refreshToken, ctx)) : await g!.accounts.acquire(subject, frozen.githubGeneration!, async () => { throw new Error(); }, ctx,
          refreshToken => g!.auth.refresh(refreshToken, ctx));
      if (acquired.kind !== 'token') return refusal('signin-required', writing ? 503 : 403);
      // Own refresh must finish first. From here neither account may mutate across awaits.
      guards.push(options.accounts.watch(subject));
      if (frozen.githubGeneration && g) guards.push(g.accounts.watch(subject));
      // Selected acquisition already pins its row. Fence late UNKNOWN writes on
      // the other required account too; uncertainty/conflict refuses, never retries.
      if (tool !== 'workiq' ? !await options.accounts.pin(subject, frozen.generation, ctx) :
        frozen.githubGeneration && g && !await g.accounts.pin(subject, frozen.githubGeneration, ctx)) return refusal('signin-required', writing ? 503 : 403);
      // A lookup failure may conceal an earlier successful effect: write storage uncertainty is always503.
      const reservation = writing ? await options.accounts.reserveWrite(frozen, tool, operation!, args, ctx) : undefined;
      if (reservation?.kind === 'uncertain') return refusal('tool-unavailable', 503);
      if (!await options.authority.revalidate() || !await live()) return refusal('tool-unavailable', writing ? 503 : 403);
      if (reservation?.kind === 'done') {
        return await safeOutput(frozen, reservation.text, token, acquired.accessToken, ctx) && await live() ?
          { status: 200, body: { text: reservation.text } } : refusal('tool-unavailable', 503);
      }
      const result = tool === 'workiq' ? await provider.ask(args, acquired.accessToken, ctx) : await g!.auth.tool(tool as GitHubTool, args, acquired.accessToken, ctx);
      if (!await safeOutput(frozen, result.text, token, acquired.accessToken, ctx) || !await live()) return refusal('tool-unavailable', writing ? 503 : 403);
      if (reservation?.kind === 'send') await options.accounts.completeWrite(reservation.id, result.text, ctx);
      if (!active(ctx)) return refusal('tool-unavailable', writing ? 503 : 403);
      return { status: 200, body: result };
    } catch (e) {
      // Native handoff is over; invalidating its rejected credential must not fence itself.
      for (const guard of guards.splice(0)) guard.release();
      if (e instanceof GitHubError && e.code === 'unauthorized' && tool !== 'workiq' && acquired?.kind === 'token') {
        try { await options.github!.accounts.invalidate({ objectId: frozen.objectId }, frozen.githubGeneration!, acquired.accessToken, ctx); } catch { /* No retry or newer-token invalidation. */ }
      }
      return refusal('tool-unavailable', e instanceof AccountError && e.code === 'operation-conflict' ? 403 : writing ? 503 : 403);
    } finally { for (const guard of guards) guard.release(); }
  }
  return {
    authenticate,
    handle(path: string, token: string, input: unknown, supplied: DirectoryContext, operation?: string): Promise<TaskReply> {
      if (!active(supplied)) return Promise.resolve(refusal('tool-unavailable', writeTool(toolFor(path) ?? '') ? 503 : 403));
      if (work.size >= 4) return Promise.resolve(refusal('tool-unavailable', 503));
      const ctx = { ...supplied, signal: AbortSignal.any([supplied.signal, shutdown.signal]), authorizeWrite: () => !closed && options.authority.allowed() && supplied.authorizeWrite?.() !== false };
      const pending = Promise.resolve().then(() => {
        const tool = toolFor(path);
        if (!active(ctx)) return refusal('tool-unavailable', writeTool(tool ?? '') ? 503 : 403);
        return path === '/v1/task-passes' ? issue(token, input, ctx) : tool ? call(tool, token, input, ctx, operation) : refusal();
      }).catch(() => refusal('tool-unavailable', writeTool(toolFor(path) ?? '') ? 503 : 403));
      work.add(pending); void pending.then(() => work.delete(pending)); return pending;
    },
    async close(): Promise<void> { closed = true; clear(); shutdown.abort(); options.authority.lost.removeEventListener('abort', clear); await Promise.allSettled(work); await provider.close(); },
  };
}
export type TaskService = ReturnType<typeof createTaskService>;
