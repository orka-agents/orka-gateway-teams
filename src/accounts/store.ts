import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { identity } from '../ingress/codec.js';
import { grantRef, taskGrant, grantBinding, operationKey, writeTool } from './grants.js';
import type { TaskGrant, GrantBinding } from './grants.js';
import { canonicalJSON, parseCanonicalJSON, validateScope } from '../directory/codec.js';
import { createNativeTable } from '../directory/table.js';
import type { DirectoryBinding, DirectoryContext, DirectoryDependencies } from '../directory/types.js';
import { DirectoryError } from '../directory/types.js';
import { etag, integer, object, uuid } from '../storage/table/codec.js';

export interface AccountSubject { objectId: string }
export interface AccountTokens { accessToken: string; expiresAt: number; refreshToken?: string; assertion?: string; assertionExpiresAt?: number;
  providerUserId?: string; refreshExpiresAt?: number }
export interface GitHubAttempt extends BrowserAttempt { cookie: string }
export interface AccountChallenge {
  id: string; objectId: string; conversationId: string; activityId: string; generation: number; expiresAt: number;
  state: 'open' | 'exchanging' | 'committing' | 'done' | 'failed'; method?: 'browser';
}
export interface BrowserAttempt { challenge: AccountChallenge; state: string; nonce: string; verifier: string }
export class AccountError extends Error {
  constructor(readonly code: 'invalid-input' | 'corrupt' | 'unavailable' | 'conflict' | 'unready' | 'busy' | 'closed' | 'operation-conflict') {
    super(`Account storage: ${code}`); this.name = 'AccountError';
  }
}
type Account = { kind: 'account'; objectId: string; generation: number; lastUsed: number; tokens?: AccountTokens; challengeId?: string; renewing?: true };
type Challenge = AccountChallenge & { kind: 'challenge'; ownerUUID?: string;
  browser?: { state: string; nonce: string; verifier: string; consumed: boolean };
  github?: { state: string; verifier: string; cookieDigest: string; consumed: boolean } };
type Grant = TaskGrant & { kind: 'grant' };
type Write = { kind: 'write'; id: string; ref: string; tool: string; objectId: string; generation: number; githubGeneration: number;
  argsDigest: string; ownerUUID: string; state: 'reserved' | 'done'; text?: string };
type Document = Account | Challenge | Grant | Write;
// The native transport cannot accept a plaintext document or a token-bearing value.
type Ciphertext = { generation: number; ciphertext: Buffer };
type CipherRow = { row: string; etag: string; value: Ciphertext };
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function bad(code: AccountError['code'] = 'corrupt'): never { throw new AccountError(code); }
const minute = 60_000; const idle = 30 * 86_400_000;

/** Borrows registry authority; it never creates a table, acquires a lease or retries a write. */
export function createAccountStore(binding: DirectoryBinding, key: Buffer, dependencies: DirectoryDependencies,
  authority: { allowed(): boolean }, now: () => number = Date.now, provider: 'workiq' | 'github' = 'workiq') {
  try { validateScope({ appId: binding.appId, tenantId: binding.tenantId });
    if (!Buffer.isBuffer(key) || key.length !== 32) bad('invalid-input');
  } catch { bad('invalid-input'); }
  const secret = Buffer.from(key); const ownerUUID = randomUUID();
  // SSO assertions are short-lived process memory, not durable account caches.
  const assertions = new Map<string, { generation: number; etag: string; assertion: string; assertionExpiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  const forget = (id: string) => { const prior = assertions.get(id); if (prior) clearTimeout(prior.timer); assertions.delete(id); };
  const durable = ({ assertion: _assertion, assertionExpiresAt: _expiry, ...tokens }: AccountTokens) => tokens;
  function remember(id: string, generation: number, etag: string, tokens: AccountTokens) {
    forget(id);
    if (!tokens.assertion || !tokens.assertionExpiresAt || tokens.assertionExpiresAt <= now()) return;
    if (assertions.size >= 1024) forget(assertions.keys().next().value!);
    const assertionExpiresAt = Math.min(tokens.assertionExpiresAt, now() + 10 * minute);
    const timer = setTimeout(() => forget(id), assertionExpiresAt - now()); timer.unref();
    assertions.set(id, { generation, etag, assertion: tokens.assertion, assertionExpiresAt, timer });
  }
  function tokensFor(a: Account, etag: string): AccountTokens | undefined {
    const id = accountKey(a.objectId).row; const cached = assertions.get(id);
    if (cached && cached.assertionExpiresAt <= now()) forget(id);
    const live = assertions.get(id); return a.tokens && { ...a.tokens, ...(live?.generation === a.generation && live.etag === etag ?
      { assertion: live.assertion, assertionExpiresAt: live.assertionExpiresAt } : {}) };
  }
  const partition = `accounts_${hash(['teams-accounts-v1', binding.appId, binding.tenantId])}`;
  const accountKey = (objectId: string) => ({ row: `account_${hash([identity(objectId), provider])}` });
  const challengeHash = (ch: Omit<AccountChallenge, 'id' | 'expiresAt' | 'state'>) =>
    hash([binding.appId, binding.tenantId, ch.objectId, ch.conversationId, ch.activityId, ch.generation, ...(provider === 'github' ? ['github'] : [])]);
  const challengeKey = (digest: string) => ({ row: `challenge_${provider === 'github' ? hash(['github', digest]) : digest}` });
  const idKey = (id: string) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9-]{36}$/u.test(id)) bad('invalid-input');
    uuid(id.slice(65)); return challengeKey(id.slice(0, 64));
  };
  const grantKey = (ref: string) => ({ row: `grant_${grantRef(ref)}` });
  const writeKey = (id: string) => ({ row: `write_${grantRef(id)}` });
  const docKey = (v: Document) => v.kind === 'account' ? accountKey(v.objectId) : v.kind === 'grant' ? grantKey(v.ref) : v.kind === 'write' ? writeKey(v.id) : idKey(v.id);
  function validTokens(input: unknown): AccountTokens {
    const v = object(input, ['accessToken', 'expiresAt', 'refreshToken', 'assertion', 'assertionExpiresAt',
      ...(provider === 'github' ? ['providerUserId', 'refreshExpiresAt'] : [])]);
    const token = (s: unknown) => { if (typeof s !== 'string' || !s || Buffer.byteLength(s) > 16 * 1024 || /[\p{Cc}\uD800-\uDFFF]/u.test(s)) bad(); };
    token(v.accessToken); integer(v.expiresAt, 1, Number.MAX_SAFE_INTEGER);
    if (v.refreshToken !== undefined) token(v.refreshToken);
    if (provider === 'github') {
      token(v.refreshToken); integer(v.refreshExpiresAt, 1, Number.MAX_SAFE_INTEGER);
      if (typeof v.providerUserId !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(v.providerUserId) || v.assertion !== undefined || v.assertionExpiresAt !== undefined) bad();
    }
    if (v.assertion !== undefined || v.assertionExpiresAt !== undefined) { token(v.assertion); integer(v.assertionExpiresAt, 1, Number.MAX_SAFE_INTEGER); }
    return v as unknown as AccountTokens;
  }
  function validate(v: Document): Document {
    identity(v.objectId); integer(v.generation, 1, Number.MAX_SAFE_INTEGER);
    if (v.kind === 'account') {
      object(v, ['kind', 'objectId', 'generation', 'lastUsed', 'tokens', 'challengeId', ...(provider === 'github' ? ['renewing'] : [])]); integer(v.lastUsed, 0, Number.MAX_SAFE_INTEGER);
      if (v.renewing !== undefined && v.renewing !== true) bad();
      if (v.tokens !== undefined) validTokens(v.tokens);
      if (v.challengeId !== undefined) idKey(v.challengeId);
    } else if (v.kind === 'grant') {
      const { kind: _kind, ...grant } = v; taskGrant(grant);
    } else if (v.kind === 'write') {
      object(v, ['kind', 'id', 'ref', 'tool', 'objectId', 'generation', 'githubGeneration', 'argsDigest', 'ownerUUID', 'state', 'text']);
      grantRef(v.id); grantRef(v.ref); grantRef(v.argsDigest); uuid(v.ownerUUID); integer(v.githubGeneration, 1, Number.MAX_SAFE_INTEGER);
      if (!writeTool(v.tool) || !['reserved', 'done'].includes(v.state) || (v.state === 'done' ? typeof v.text !== 'string' || Buffer.byteLength(v.text) > 32768 : v.text !== undefined)) bad();
    } else {
      object(v, ['kind', 'id', 'objectId', 'conversationId', 'activityId', 'generation', 'expiresAt', 'state', 'ownerUUID', 'method', 'browser', ...(provider === 'github' ? ['github'] : [])]);
      if (v.kind !== 'challenge' || !['open', 'exchanging', 'committing', 'done', 'failed'].includes(v.state) ||
        v.method !== undefined && v.method !== 'browser') bad();
      if (v.browser !== undefined) {
        const b = object(v.browser, ['state', 'nonce', 'verifier', 'consumed']);
        if (typeof b.state !== 'string' || !b.state.startsWith(v.id + '.') || !/^[A-Za-z0-9_-]{43}$/u.test(b.state.slice(v.id.length + 1)) ||
          typeof b.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(b.nonce) ||
          typeof b.verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(b.verifier) || typeof b.consumed !== 'boolean') bad();
      }
      if (v.github !== undefined) {
        const g = object(v.github, ['state', 'verifier', 'cookieDigest', 'consumed']);
        if (v.method !== 'browser' || typeof g.state !== 'string' || !g.state.startsWith(v.id + '.') ||
          !/^[A-Za-z0-9_-]{43}$/u.test(g.state.slice(v.id.length + 1)) || typeof g.verifier !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/u.test(g.verifier) || typeof g.cookieDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(g.cookieDigest) || typeof g.consumed !== 'boolean') bad();
      }
      if (v.method === 'browser' && !v.browser?.consumed) bad();
      identity(v.conversationId); identity(v.activityId); integer(v.expiresAt, 1, Number.MAX_SAFE_INTEGER); idKey(v.id);
      if (!v.id.startsWith(challengeHash(v) + '.') || (v.state !== 'open' && v.ownerUUID === undefined)) bad();
      if (v.ownerUUID !== undefined) uuid(v.ownerUUID);
    }
    return v;
  }
  const aad = (row: string, generation: number) => Buffer.from(JSON.stringify([partition, row, generation, 1]));
  function seal(value: Document): Ciphertext {
    validate(value); const row = docKey(value).row; const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, iv); cipher.setAAD(aad(row, value.generation));
    const data = Buffer.from(canonicalJSON(value)); if (data.length > 48 * 1024) bad('invalid-input');
    const ciphertext = Buffer.concat([iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
    return { generation: value.generation, ciphertext };
  }
  function unseal(row: CipherRow): Document {
    try {
      const { generation, ciphertext: data } = row.value;
      const cipher = createDecipheriv('aes-256-gcm', secret, data.subarray(0, 12));
      cipher.setAAD(aad(row.row, generation)); cipher.setAuthTag(data.subarray(-16));
      const value = validate(parseCanonicalJSON(Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()])) as unknown as Document);
      if (value.generation !== generation || docKey(value).row !== row.row) bad(); return value;
    } catch { return bad(); }
  }
  function encode(k: { row: string }, value: Ciphertext): Record<string, unknown> {
    const generation = Buffer.alloc(8); generation.writeBigUInt64BE(BigInt(value.generation));
    const payload = Buffer.concat([generation, value.ciphertext]).toString('base64');
    return { PartitionKey: partition, RowKey: k.row, V: 1, Payload: payload, 'Payload@odata.type': 'Edm.Binary',
      Digest: hash(['teams-accounts-row-v1', partition, k.row, payload]), Armed: false };
  }
  const table = createNativeTable<{ row: string }, Ciphertext, CipherRow>(binding, dependencies, {
    partition, key: k => ({ partition, row: k.row }), encode, row: r => r.row, armed: () => false,
    decode(input, expected, header) {
      try {
        const types = { PartitionKey: 'Edm.String', RowKey: 'Edm.String', V: 'Edm.Int32', Payload: 'Edm.Binary', Digest: 'Edm.String', Armed: 'Edm.Boolean', Timestamp: 'Edm.DateTime' };
        const v = object(input, [...Object.keys(types), ...Object.keys(types).map(k => `${k}@odata.type`),
          'odata.etag', 'odata.metadata', 'odata.id', 'odata.editLink', 'odata.editlink', 'odata.type']);
        for (const [k, type] of Object.entries(types)) if (v[`${k}@odata.type`] !== undefined && v[`${k}@odata.type`] !== type) bad();
        if (v.PartitionKey !== partition || typeof v.RowKey !== 'string' || !/^(?:account|challenge|grant|write)_[a-f0-9]{64}$/u.test(v.RowKey) ||
          (expected && v.RowKey !== expected.row) || v.V !== 1 || v.Armed !== false || v['Payload@odata.type'] !== 'Edm.Binary' ||
          typeof v.Payload !== 'string' || v.Payload.length > 66_000) bad();
        const data = Buffer.from(v.Payload, 'base64');
        if (data.length < 37 || data.toString('base64') !== v.Payload || v.Digest !== hash(['teams-accounts-row-v1', partition, v.RowKey, v.Payload])) bad();
        const generation = Number(data.readBigUInt64BE()); integer(generation, 1, Number.MAX_SAFE_INTEGER);
        const tag = etag(v['odata.etag']); if (header !== undefined && etag(header) !== tag) bad();
        if (typeof v.Timestamp !== 'string' || !Number.isFinite(Date.parse(v.Timestamp))) bad();
        return { row: v.RowKey, etag: tag, value: { generation, ciphertext: data.subarray(8) } };
      } catch { return bad(); }
    },
  });
  let closed = false; let closing: Promise<void> | undefined;
  const work = new Set<Promise<unknown>>();
  const flights = new Map<string, Promise<{ accessToken: string } | undefined>>();
  function check(ctx: DirectoryContext) {
    if (closed) bad('closed');
    if (!authority.allowed() || ctx.authorizeWrite?.() === false) bad('unready');
    if (!(ctx.signal instanceof AbortSignal) || !Number.isFinite(ctx.deadline)) bad('invalid-input');
    if (ctx.signal.aborted || performance.now() >= ctx.deadline) bad('unavailable');
  }
  function run<T>(context: DirectoryContext, operation: (ctx: DirectoryContext) => Promise<T>, disconnect = false): Promise<T> {
    try {
      check(context); if (work.size >= (disconnect ? 4 : 3)) bad('busy');
      const ctx = { ...context, authorizeWrite: () => !closed && authority.allowed() && context.authorizeWrite?.() !== false };
      const pending = Promise.resolve().then(() => { check(ctx); return operation(ctx); }).then(value => { check(ctx); return value; })
        .catch((e: unknown) => { throw e instanceof AccountError ? e : new AccountError(e instanceof DirectoryError ? e.code : 'unavailable'); });
      work.add(pending); void pending.then(() => work.delete(pending), () => work.delete(pending)); return pending;
    } catch (e) { return Promise.reject(e instanceof AccountError ? e : new AccountError('unavailable')); }
  }
  async function read(k: { row: string }, ctx: DirectoryContext) {
    const row = await table.get(k, ctx); check(ctx); return row && { ...row, encrypted: row.value, value: unseal(row) };
  }
  type Row = NonNullable<Awaited<ReturnType<typeof read>>>;
  async function persist(previous: Row | undefined, value: Document, ctx: DirectoryContext, winner?: (v: Document) => boolean): Promise<Row> {
    check(ctx); const k = docKey(value); const encrypted = seal(value);
    const result = previous ? await table.replace(k, previous.etag, encrypted, ctx) : await table.insert(k, encrypted, ctx);
    check(ctx); const saved = await read(k, ctx);
    if (saved && ((saved.encrypted.generation === encrypted.generation && saved.encrypted.ciphertext.equals(encrypted.ciphertext)) || winner?.(saved.value))) return saved;
    return bad(result.kind === 'conflict' ? 'conflict' : 'unavailable');
  }
  const usable = (v: Account): boolean => !!v.tokens && !v.renewing && now() - v.lastUsed < idle &&
    (provider === 'workiq' || v.tokens.refreshExpiresAt! > now());
  const publicChallenge = ({ kind: _kind, ownerUUID: _owner, browser: _browser, github: _github, ...ch }: Challenge): AccountChallenge => ch;
  const attempt = (ch: Challenge): BrowserAttempt => ({ challenge: publicChallenge(ch), state: ch.browser!.state,
    nonce: ch.browser!.nonce, verifier: ch.browser!.verifier });
  const browserAvailable = (ch: Challenge) => ['open', 'exchanging', 'failed'].includes(ch.state) && !ch.browser?.consumed && now() < ch.expiresAt;
  const sameChallenge = (a: Document, b: AccountChallenge): a is Challenge => a.kind === 'challenge' &&
    canonicalJSON(publicChallenge({ ...a, state: b.state })) === canonicalJSON(b);
  async function current(ch: AccountChallenge, ctx: DirectoryContext, state: AccountChallenge['state'] = 'exchanging') {
    const row = await read(idKey(ch.id), ctx); const a = await read(accountKey(ch.objectId), ctx);
    if (!row || !sameChallenge(row.value, ch) || row.value.ownerUUID !== ownerUUID ||
      row.value.state !== state || (state !== 'done' && now() >= ch.expiresAt) ||
      !(a?.value.generation === ch.generation || provider === 'github' && (state === 'committing' || state === 'done') &&
        a?.value.kind === 'account' && a.value.generation === ch.generation + 1 && a.value.challengeId === ch.id)) return undefined;
    return { row, account: a };
  }
  const publicGrant = ({ kind: _kind, ...grant }: Grant): TaskGrant => grant;
  async function liveGrant(ref: string, c: DirectoryContext): Promise<Row | undefined> {
    const row = await read(grantKey(ref), c); if (row?.value.kind !== 'grant') return undefined;
    const account = await read(accountKey(row.value.objectId), c);
    return account?.value.kind === 'account' && account.value.generation === row.value.generation && usable(account.value) ? row : undefined;
  }
  return {
    reserveGrant(input: TaskGrant, ctx: DirectoryContext): Promise<TaskGrant> {
      return run(ctx, async c => {
        let grant: TaskGrant; try { grant = taskGrant(input); if (grant.binding) bad('invalid-input'); } catch { return bad('invalid-input'); }
        const same = (v: Document) => {
          if (v.kind !== 'grant') return false;
          const { binding: _binding, ...reservation } = publicGrant(v); return canonicalJSON(reservation) === canonicalJSON(grant);
        };
        const existing = await read(grantKey(grant.ref), c);
        if (existing && !same(existing.value)) bad('conflict');
        const a = await read(accountKey(grant.objectId), c);
        if (a?.value.kind !== 'account' || a.value.generation !== grant.generation || !usable(a.value)) bad('conflict');
        const saved = existing ?? await persist(undefined, { kind: 'grant', ...grant }, c, same);
        if (!same(saved.value) || !await liveGrant(grant.ref, c)) bad('conflict');
        return publicGrant(saved.value as Grant);
      });
    },
    getGrant(ref: string, ctx: DirectoryContext): Promise<TaskGrant | undefined> {
      return run(ctx, async c => { const row = await liveGrant(ref, c); return row && publicGrant(row.value as Grant); });
    },
    safeGrantOutput(ref: string, text: string, ctx: DirectoryContext): Promise<boolean> {
      return run(ctx, async c => {
        const grant = await liveGrant(ref, c); if (grant?.value.kind !== 'grant') return false;
        const row = await read(accountKey(grant.value.objectId), c); if (row?.value.kind !== 'account' || row.value.generation !== grant.value.generation) return false;
        const tokens = tokensFor(row.value, row.etag);
        return !!tokens && ![tokens.accessToken, tokens.refreshToken, tokens.assertion].some(secret => secret && text.includes(secret));
      });
    },
    safeOutput(subject: AccountSubject, generation: number, text: string, ctx: DirectoryContext): Promise<boolean> {
      return run(ctx, async c => { const row = await read(accountKey(subject.objectId), c); const a = row?.value;
        if (!row) return generation === 0;
        if (a?.kind !== 'account' || a.generation !== generation) return false;
        const tokens = tokensFor(a, row.etag); return !tokens || ![tokens.accessToken, tokens.refreshToken, tokens.assertion].some(s => s && text.includes(s)); });
    },
    invalidate(subject: AccountSubject, generation: number, rejectedToken: string, ctx: DirectoryContext): Promise<void> {
      return run(ctx, async c => { const row = await read(accountKey(subject.objectId), c); const a = row?.value;
        if (!row || a?.kind !== 'account' || a.generation !== generation || a.tokens?.accessToken !== rejectedToken) return;
        try { await persist(row, { kind: 'account', objectId: subject.objectId, generation: generation + 1, lastUsed: now() }, c); }
        catch (e) { if (!(e instanceof AccountError && e.code === 'conflict')) throw e; } });
    },
    reserveWrite(grant: TaskGrant, tool: string, operation: string, args: unknown, ctx: DirectoryContext): Promise<
      { kind: 'send'; id: string } | { kind: 'done'; text: string } | { kind: 'uncertain' }> {
      return run(ctx, async c => {
        if (provider !== 'workiq' || !writeTool(tool) || !grant.githubGeneration || !grant.binding?.tools.includes(tool)) bad('invalid-input');
        const live = await liveGrant(grant.ref, c);
        if (live?.value.kind !== 'grant' || canonicalJSON(publicGrant(live.value)) !== canonicalJSON(grant)) bad('conflict');
        const id = hash(['teams-task-write-v1', grant.ref, tool, operationKey(operation)]); const argsDigest = hash(canonicalJSON(args));
        const previous = await read(writeKey(id), c);
        if (previous) { const v = previous.value;
          if (v.kind !== 'write' || v.ref !== grant.ref || v.tool !== tool || v.argsDigest !== argsDigest || v.objectId !== grant.objectId ||
            v.generation !== grant.generation || v.githubGeneration !== grant.githubGeneration) bad('operation-conflict');
          return v.state === 'done' ? { kind: 'done', text: v.text! } : { kind: 'uncertain' };
        }
        // CREATE-only send permission; an existing reservation is uncertain forever.
        await persist(undefined, { kind: 'write', id, ref: grant.ref, tool, objectId: grant.objectId, generation: grant.generation,
          githubGeneration: grant.githubGeneration, argsDigest, ownerUUID, state: 'reserved' }, c);
        return { kind: 'send', id };
      });
    },
    completeWrite(id: string, text: string, ctx: DirectoryContext): Promise<void> {
      return run(ctx, async c => { const row = await read(writeKey(id), c); const v = row?.value;
        if (!row || v?.kind !== 'write' || v.ownerUUID !== ownerUUID || v.state !== 'reserved' || !await liveGrant(v.ref, c)) bad('conflict');
        await persist(row, { ...v, state: 'done', text }, c); });
    },
    bindGrant(ref: string, targetId: string, input: GrantBinding, ctx: DirectoryContext): Promise<TaskGrant> {
      return run(ctx, async c => {
        let binding: GrantBinding; try { binding = grantBinding(input); } catch { return bad('invalid-input'); }
        if (binding.deadline <= now()) bad('invalid-input');
        const row = await liveGrant(ref, c); const v = row?.value;
        if (!row || v?.kind !== 'grant' || v.targetId !== targetId || binding.tools.some(t => !v.tools.includes(t))) bad('conflict');
        const same = (g: Document) => g.kind === 'grant' && canonicalJSON(g) === canonicalJSON({ ...v, binding });
        if (v.binding && !same(v)) bad('conflict');
        const saved = v.binding ? row : await persist(row, { ...v, binding }, c, same);
        if (!same(saved.value) || !await liveGrant(ref, c)) bad('conflict'); return publicGrant(saved.value as Grant);
      });
    },
    inspect(subject: AccountSubject, ctx: DirectoryContext, forDisconnect = false): Promise<{ generation: number; linked: boolean }> {
      return run(ctx, async c => { const r = await read(accountKey(subject.objectId), c); const v = r?.value as Account | undefined;
        return { generation: v?.generation ?? 0, linked: !!v && usable(v) && !!v.tokens &&
          (v.tokens.expiresAt > now() || !!v.tokens.refreshToken || (tokensFor(v, r!.etag)?.assertionExpiresAt ?? 0) > now()) }; }, forDisconnect);
    },
    published(ch: AccountChallenge, ctx: DirectoryContext): Promise<boolean> {
      return run(ctx, async c => {
        idKey(ch.id); const row = await read(accountKey(ch.objectId), c); const a = row?.value;
        return a?.kind === 'account' && a.challengeId === ch.id && a.generation === ch.generation + (provider === 'github' ? 1 : 0) &&
          usable(a) && (a.tokens?.expiresAt ?? 0) > now();
      });
    },
    challenge(subject: AccountSubject, conversationId: string, activityId: string, ctx: DirectoryContext): Promise<AccountChallenge> {
      return run(ctx, async c => {
        const objectId = identity(subject.objectId); identity(conversationId); identity(activityId);
        let a = await read(accountKey(objectId), c);
        if (!a) a = await persist(undefined, { kind: 'account', objectId, generation: 1, lastUsed: now() }, c,
          v => v.kind === 'account' && v.objectId === objectId && v.generation === 1);
        const base = { objectId, conversationId, activityId, generation: a.value.generation };
        const row = challengeKey(challengeHash(base)); const existing = await read(row, c);
        const value: Challenge = { ...base, kind: 'challenge', id: `${challengeHash(base)}.${randomUUID()}`, expiresAt: now() + 10 * minute, state: 'open' };
        const matches = (v: Document) => v.kind === 'challenge' && challengeHash(v) === challengeHash(base);
        const saved = existing ?? await persist(undefined, value, c, matches);
        if (!matches(saved.value)) bad('conflict');
        if ((await read(accountKey(objectId), c))?.value.generation !== base.generation) bad('conflict');
        return publicChallenge(saved.value as Challenge);
      });
    },
    getChallenge(id: string, ctx: DirectoryContext): Promise<AccountChallenge | undefined> {
      return run(ctx, async c => { const r = await read(idKey(id), c);
        return r?.value.kind === 'challenge' && r.value.id === id ? publicChallenge(r.value) : undefined; });
    },
    prepareBrowser(ch: AccountChallenge, ctx: DirectoryContext): Promise<BrowserAttempt | undefined> {
      return run(ctx, async c => {
        const row = await read(idKey(ch.id), c); const a = await read(accountKey(ch.objectId), c);
        if (!row || !sameChallenge(row.value, ch) || !browserAvailable(row.value) || a?.value.generation !== ch.generation) return undefined;
        let saved = row;
        if (!row.value.browser) {
          const random = () => randomBytes(32).toString('base64url');
          saved = await persist(row, { ...row.value, browser: { state: `${ch.id}.${random()}`, nonce: random(), verifier: random(), consumed: false } }, c,
            v => sameChallenge(v, ch) && browserAvailable(v) && !!v.browser);
        }
        if (saved.value.kind !== 'challenge' || !browserAvailable(saved.value) ||
          (await read(accountKey(ch.objectId), c))?.value.generation !== ch.generation) return undefined;
        return attempt(saved.value);
      });
    },
    claimBrowser(state: string, ctx: DirectoryContext): Promise<BrowserAttempt | undefined> {
      return run(ctx, async c => {
        if (typeof state !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.[A-Za-z0-9_-]{43}$/u.test(state)) return undefined;
        const row = await read(idKey(state.slice(0, 101)), c);
        if (row?.value.kind !== 'challenge' || !browserAvailable(row.value) || !row.value.browser ||
          !timingSafeEqual(Buffer.from(state), Buffer.from(row.value.browser.state))) return undefined;
        const ch = row.value; const a = await read(accountKey(ch.objectId), c);
        if (a?.value.generation !== ch.generation) return undefined;
        const claimed: Challenge = { ...ch, method: 'browser', state: 'exchanging', ownerUUID, browser: { ...ch.browser!, consumed: true } };
        try { await persist(row, claimed, c); }
        catch (e) { if (e instanceof AccountError && ['conflict', 'unavailable'].includes(e.code)) return undefined; throw e; }
        return await current(publicChallenge(claimed), c) ? attempt(claimed) : undefined;
      });
    },
    prepareGitHub(input: BrowserAttempt, ctx: DirectoryContext): Promise<GitHubAttempt | undefined> {
      return run(ctx, async c => {
        if (provider !== 'github') return undefined;
        const owned = await current(input.challenge, c); const ch = owned?.row.value;
        if (!owned || ch?.kind !== 'challenge' || ch.method !== 'browser' || ch.github || ch.browser?.state !== input.state) return undefined;
        const random = () => randomBytes(32).toString('base64url'); const cookie = random();
        const github = { state: `${ch.id}.${random()}`, verifier: random(), cookieDigest: hash(cookie), consumed: false };
        await persist(owned.row, { ...ch, github }, c);
        return await current(input.challenge, c) ? { challenge: publicChallenge(ch), nonce: input.nonce, state: github.state, verifier: github.verifier, cookie } : undefined;
      });
    },
    claimGitHub(state: string, cookie: string, ctx: DirectoryContext): Promise<BrowserAttempt | undefined> {
      return run(ctx, async c => {
        if (provider !== 'github' || typeof state !== 'string' || state.length !== 145 || !/^[A-Za-z0-9_-]{43}$/u.test(cookie)) return undefined;
        let row: Row | undefined; try { row = await read(idKey(state.slice(0, 101)), c); } catch (e) { if (e instanceof AccountError && e.code === 'invalid-input') return undefined; throw e; }
        const ch = row?.value;
        if (!row || ch?.kind !== 'challenge' || ch.state !== 'exchanging' || !ch.github || ch.github.consumed || now() >= ch.expiresAt ||
          ch.github.state !== state || !timingSafeEqual(Buffer.from(hash(cookie)), Buffer.from(ch.github.cookieDigest)) ||
          (await read(accountKey(ch.objectId), c))?.value.generation !== ch.generation) return undefined;
        const claimed = { ...ch, ownerUUID, github: { ...ch.github, consumed: true } };
        try { await persist(row, claimed, c); } catch (e) { if (e instanceof AccountError && ['conflict', 'unavailable'].includes(e.code)) return undefined; throw e; }
        return await current(publicChallenge(claimed), c) ? { challenge: publicChallenge(claimed), state, nonce: ch.browser!.nonce, verifier: ch.github.verifier } : undefined;
      });
    },
    claim(ch: AccountChallenge, ctx: DirectoryContext): Promise<'claimed' | 'done' | 'unavailable'> {
      return run(ctx, async c => {
        const row = await read(idKey(ch.id), c); const a = await read(accountKey(ch.objectId), c);
        if (!row || !sameChallenge(row.value, ch) || row.value.method === 'browser' || a?.value.generation !== ch.generation) return 'unavailable';
        if (row.value.state === 'done') return 'done';
        if (row.value.state !== 'open' || now() >= ch.expiresAt) return 'unavailable';
        try { await persist(row, { ...row.value, state: 'exchanging', ownerUUID }, c); }
        catch (e) { if (e instanceof AccountError && ['conflict', 'unavailable'].includes(e.code)) return 'unavailable'; throw e; }
        return await current(ch, c) ? 'claimed' : 'unavailable';
      });
    },
    complete(ch: AccountChallenge, tokens: AccountTokens, ctx: DirectoryContext): Promise<boolean> {
      return run(ctx, async c => {
        try {
          const owned = await current(ch, c); if (!owned) return false;
          const value = { ...validTokens(tokens) };
          if (value.expiresAt <= now() || provider === 'github' && (value.refreshExpiresAt! <= now() ||
            (owned.row.value as Challenge).method === 'browser' && !(owned.row.value as Challenge).github?.consumed)) return false;
          if (value.assertionExpiresAt !== undefined) value.assertionExpiresAt = Math.min(value.assertionExpiresAt, now() + 10 * minute);
          const previous = (owned.account.value as Account).tokens?.refreshToken;
          if (provider === 'workiq' && !value.refreshToken && previous) value.refreshToken = previous;
          // Serialize takeover against publication, not just against its final acknowledgement.
          await persist(owned.row, { ...owned.row.value as Challenge, state: 'committing' }, c);
          if (!await current(ch, c, 'committing')) return false;
          const published = await persist(owned.account, { kind: 'account', objectId: ch.objectId, generation: ch.generation + (provider === 'github' ? 1 : 0),
            lastUsed: now(), tokens: durable(value), challengeId: ch.id }, c);
          const after = await current(ch, c, 'committing'); if (!after || after.account.etag !== published.etag) return false;
          await persist(after.row, { ...after.row.value as Challenge, state: 'done' }, c);
          const saved = await current(ch, c, 'done');
          if (!saved || saved.account.etag !== published.etag) return false;
          remember(accountKey(ch.objectId).row, ch.generation, published.etag, value);
          return true;
        } catch (e) { if (e instanceof AccountError && ['conflict', 'unavailable'].includes(e.code)) return false; throw e; }
      });
    },
    acquire(subject: AccountSubject, generation: number, refresh: (assertion: string) => Promise<AccountTokens>, ctx: DirectoryContext,
      refreshCache?: (refreshToken: string) => Promise<AccountTokens>): Promise<{ kind: 'token'; accessToken: string } | { kind: 'signin-required' }> {
      return run(ctx, async c => {
        const k = accountKey(subject.objectId); integer(generation, 0, Number.MAX_SAFE_INTEGER);
        const flightKey = `${k.row}:${generation}`; let flight = flights.get(flightKey);
        if (!flight) {
          flight = (async () => {
            let row = await read(k, c); const a = row?.value as Account | undefined;
            if (!row || !a || a.generation !== generation) return undefined;
            const invalidate = async () => { await persist(row, { kind: 'account', objectId: a.objectId, generation: generation + 1, lastUsed: now() }, c); };
            if (provider === 'github' && (a.renewing || a.tokens && a.tokens.refreshExpiresAt! <= now())) { await invalidate(); return undefined; }
            if (!usable(a) || !a.tokens) return undefined;
            let tokens = tokensFor(a, row.etag)!;
            if (provider === 'github' && tokens.expiresAt <= now()) {
              if (!refreshCache) return undefined;
              // A crash after this CAS must never reuse a possibly spent refresh token.
              try { row = await persist(row, { ...a, renewing: true }, c); } catch { check(c); return undefined; }
              try {
                const renewed = validTokens(await refreshCache(tokens.refreshToken!)); check(c);
                if (renewed.providerUserId !== tokens.providerUserId || renewed.expiresAt <= now() || renewed.refreshExpiresAt! <= now()) bad();
                tokens = renewed;
              } catch { check(c); try { await invalidate(); } catch { check(c); } return undefined; }
            }
            if (tokens.expiresAt <= now()) {
              const cachedRefresh = tokens.refreshToken && refreshCache;
              if (!cachedRefresh && (!tokens.assertion || (tokens.assertionExpiresAt ?? 0) <= now())) return undefined;
              try { const renewed = validTokens(await (cachedRefresh ? refreshCache!(tokens.refreshToken!) : refresh(tokens.assertion!))); check(c);
                tokens = { ...renewed, ...(tokens.refreshToken && !renewed.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
                  ...(tokens.assertion ? { assertion: tokens.assertion, assertionExpiresAt: tokens.assertionExpiresAt! } : {}) };
                if (tokens.expiresAt <= now()) return undefined;
              } catch (error) {
                check(c);
                if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'invalid-grant') {
                  try { await persist(row, { kind: 'account', objectId: a.objectId, generation: generation + 1, lastUsed: now() }, c); forget(k.row); } catch { check(c); }
                }
                return undefined;
              }
            }
            try {
              // Pin the original ETag through remote renewal, including its failure path.
              const saved = await persist(row, { ...a, tokens: durable(tokens), lastUsed: now() }, c);
              const cached = assertions.get(k.row); if (cached?.etag === row.etag) cached.etag = saved.etag;
              return { accessToken: tokens.accessToken };
            } catch { check(c); return undefined; }
          })();
          flights.set(flightKey, flight); const active = flight;
          void active.then(() => { if (flights.get(flightKey) === active) flights.delete(flightKey); }, () => { if (flights.get(flightKey) === active) flights.delete(flightKey); });
        }
        const result = await flight; check(c); const latest = await read(k, c);
        if (!result || latest?.value.kind !== 'account' || latest.value.generation !== generation || latest.value.tokens?.accessToken !== result.accessToken ||
          !usable(latest.value) || (latest.value.tokens?.expiresAt ?? 0) <= now()) return { kind: 'signin-required' };
        return { kind: 'token', accessToken: result.accessToken };
      });
    },
    disconnect(subject: AccountSubject, ctx: DirectoryContext, expectedGeneration?: number): Promise<number> {
      return run(ctx, async c => { const row = await read(accountKey(subject.objectId), c); const currentGeneration = row?.value.generation ?? 0;
        if (expectedGeneration !== undefined && currentGeneration !== expectedGeneration) return currentGeneration;
        const generation = currentGeneration + 1;
        await persist(row, { kind: 'account', objectId: subject.objectId, generation, lastUsed: now() }, c);
        forget(accountKey(subject.objectId).row); return generation; }, true);
    },
    close(): Promise<void> {
      if (!closing) { closed = true; for (const id of assertions.keys()) forget(id);
        closing = Promise.allSettled([table.close(), ...work]).then(() => { secret.fill(0); }); }
      return closing;
    },
  };
}
export type AccountStore = ReturnType<typeof createAccountStore>;
