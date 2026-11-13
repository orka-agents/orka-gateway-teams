import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { identity } from '../ingress/codec.js';
import { canonicalJSON, parseCanonicalJSON, validateScope } from '../directory/codec.js';
import { createNativeTable } from '../directory/table.js';
import type { DirectoryBinding, DirectoryContext, DirectoryDependencies } from '../directory/types.js';
import { DirectoryError } from '../directory/types.js';
import { etag, integer, object, uuid } from '../storage/table/codec.js';

export interface AccountSubject { objectId: string }
export interface AccountTokens { accessToken: string; expiresAt: number; assertion?: string; assertionExpiresAt?: number }
export interface AccountChallenge {
  id: string; objectId: string; conversationId: string; activityId: string; generation: number; expiresAt: number;
  state: 'open' | 'exchanging' | 'done' | 'failed';
}
export class AccountError extends Error {
  constructor(readonly code: 'invalid-input' | 'corrupt' | 'unavailable' | 'conflict' | 'unready' | 'busy' | 'closed') {
    super(`Account storage: ${code}`); this.name = 'AccountError';
  }
}
type Account = { kind: 'account'; objectId: string; generation: number; lastUsed: number; tokens?: AccountTokens };
type Challenge = AccountChallenge & { kind: 'challenge'; ownerUUID?: string };
type Document = Account | Challenge;
// The native transport cannot accept a plaintext document or a token-bearing value.
type Ciphertext = { generation: number; ciphertext: Buffer };
type CipherRow = { row: string; etag: string; value: Ciphertext };
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function bad(code: AccountError['code'] = 'corrupt'): never { throw new AccountError(code); }
const minute = 60_000; const idle = 30 * 86_400_000;

/** Borrows registry authority; it never creates a table, acquires a lease or retries a write. */
export function createAccountStore(binding: DirectoryBinding, key: Buffer, dependencies: DirectoryDependencies,
  authority: { allowed(): boolean }, now: () => number = Date.now) {
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
  const accountKey = (objectId: string) => ({ row: `account_${hash([identity(objectId), 'workiq'])}` });
  const challengeHash = (ch: Omit<AccountChallenge, 'id' | 'expiresAt' | 'state'>) =>
    hash([binding.appId, binding.tenantId, ch.objectId, ch.conversationId, ch.activityId, ch.generation]);
  const idKey = (id: string) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9-]{36}$/u.test(id)) bad('invalid-input');
    uuid(id.slice(65)); return { row: `challenge_${id.slice(0, 64)}` };
  };
  const docKey = (v: Document) => v.kind === 'account' ? accountKey(v.objectId) : idKey(v.id);
  function validTokens(input: unknown): AccountTokens {
    const v = object(input, ['accessToken', 'expiresAt', 'assertion', 'assertionExpiresAt']);
    const token = (s: unknown) => { if (typeof s !== 'string' || !s || Buffer.byteLength(s) > 16 * 1024 || /[\p{Cc}\uD800-\uDFFF]/u.test(s)) bad(); };
    token(v.accessToken); integer(v.expiresAt, 1, Number.MAX_SAFE_INTEGER);
    if (v.assertion !== undefined || v.assertionExpiresAt !== undefined) { token(v.assertion); integer(v.assertionExpiresAt, 1, Number.MAX_SAFE_INTEGER); }
    return v as unknown as AccountTokens;
  }
  function validate(v: Document): Document {
    identity(v.objectId); integer(v.generation, 1, Number.MAX_SAFE_INTEGER);
    if (v.kind === 'account') {
      object(v, ['kind', 'objectId', 'generation', 'lastUsed', 'tokens']); integer(v.lastUsed, 0, Number.MAX_SAFE_INTEGER);
      if (v.tokens !== undefined) validTokens(v.tokens);
    } else {
      object(v, ['kind', 'id', 'objectId', 'conversationId', 'activityId', 'generation', 'expiresAt', 'state', 'ownerUUID']);
      if (v.kind !== 'challenge' || !['open', 'exchanging', 'done', 'failed'].includes(v.state)) bad();
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
        if (v.PartitionKey !== partition || typeof v.RowKey !== 'string' || !/^(?:account|challenge)_[a-f0-9]{64}$/u.test(v.RowKey) ||
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
  const usable = (v: Account): boolean => !!v.tokens && now() - v.lastUsed < idle;
  const publicChallenge = ({ kind: _kind, ownerUUID: _owner, ...ch }: Challenge): AccountChallenge => ch;
  const sameChallenge = (a: Document, b: AccountChallenge): a is Challenge => a.kind === 'challenge' &&
    canonicalJSON(publicChallenge({ ...a, state: b.state })) === canonicalJSON(b);
  async function current(ch: AccountChallenge, ctx: DirectoryContext, done = false) {
    const row = await read(idKey(ch.id), ctx); const a = await read(accountKey(ch.objectId), ctx);
    if (!row || !sameChallenge(row.value, ch) || row.value.ownerUUID !== ownerUUID ||
      row.value.state !== (done ? 'done' : 'exchanging') || (!done && now() >= ch.expiresAt) || a?.value.generation !== ch.generation) return undefined;
    return { row, account: a };
  }
  return {
    inspect(subject: AccountSubject, ctx: DirectoryContext, forDisconnect = false): Promise<{ generation: number; linked: boolean }> {
      return run(ctx, async c => { const r = await read(accountKey(subject.objectId), c); const v = r?.value as Account | undefined;
        return { generation: v?.generation ?? 0, linked: !!v && usable(v) && !!v.tokens &&
          (v.tokens.expiresAt > now() || (tokensFor(v, r!.etag)?.assertionExpiresAt ?? 0) > now()) }; }, forDisconnect);
    },
    challenge(subject: AccountSubject, conversationId: string, activityId: string, ctx: DirectoryContext): Promise<AccountChallenge> {
      return run(ctx, async c => {
        const objectId = identity(subject.objectId); identity(conversationId); identity(activityId);
        let a = await read(accountKey(objectId), c);
        if (!a) a = await persist(undefined, { kind: 'account', objectId, generation: 1, lastUsed: now() }, c,
          v => v.kind === 'account' && v.objectId === objectId && v.generation === 1);
        const base = { objectId, conversationId, activityId, generation: a.value.generation };
        const row = { row: `challenge_${challengeHash(base)}` }; const existing = await read(row, c);
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
    claim(ch: AccountChallenge, ctx: DirectoryContext): Promise<'claimed' | 'done' | 'unavailable'> {
      return run(ctx, async c => {
        const row = await read(idKey(ch.id), c); const a = await read(accountKey(ch.objectId), c);
        if (!row || !sameChallenge(row.value, ch) || a?.value.generation !== ch.generation) return 'unavailable';
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
          if (value.expiresAt <= now()) return false;
          if (value.assertionExpiresAt !== undefined) value.assertionExpiresAt = Math.min(value.assertionExpiresAt, now() + 10 * minute);
          const published = await persist(owned.account, { kind: 'account', objectId: ch.objectId, generation: ch.generation, lastUsed: now(), tokens: durable(value) }, c);
          const after = await current(ch, c); if (!after || after.account.etag !== published.etag) return false;
          await persist(after.row, { ...after.row.value as Challenge, state: 'done' }, c);
          const saved = await current(ch, c, true);
          if (!saved || saved.account.etag !== published.etag) return false;
          remember(accountKey(ch.objectId).row, ch.generation, published.etag, value);
          return true;
        } catch (e) { if (e instanceof AccountError && ['conflict', 'unavailable'].includes(e.code)) return false; throw e; }
      });
    },
    acquire(subject: AccountSubject, generation: number, refresh: (assertion: string) => Promise<AccountTokens>, ctx: DirectoryContext): Promise<{ kind: 'token'; accessToken: string } | { kind: 'signin-required' }> {
      return run(ctx, async c => {
        const k = accountKey(subject.objectId); integer(generation, 0, Number.MAX_SAFE_INTEGER);
        const flightKey = `${k.row}:${generation}`; let flight = flights.get(flightKey);
        if (!flight) {
          flight = (async () => {
            const row = await read(k, c); const a = row?.value as Account | undefined;
            if (!row || !a || a.generation !== generation || !usable(a) || !a.tokens) return undefined;
            let tokens = tokensFor(a, row.etag)!;
            if (tokens.expiresAt <= now()) {
              if (!tokens.assertion || (tokens.assertionExpiresAt ?? 0) <= now()) return undefined;
              try { const renewed = validTokens(await refresh(tokens.assertion)); check(c);
                tokens = { ...renewed, ...(tokens.assertion ? { assertion: tokens.assertion, assertionExpiresAt: tokens.assertionExpiresAt! } : {}) };
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
