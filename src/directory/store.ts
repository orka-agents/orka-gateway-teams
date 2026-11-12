import { randomUUID } from 'node:crypto';
import { canonicalJSON, recordKey, snapshotDirectoryRecord } from './codec.js';
import type { BindingEvidence, ConnectionRecord, ControlRecord, DirectoryContext, DirectoryKey, DirectoryRecord, DirectoryRow, DirectoryTable } from './types.js';
import { DirectoryError } from './types.js';

export type ControlSettlement = { kind: 'no-effect' | 'rejected' | 'unknown' } | { kind: 'delivered'; providerMessageId: string };
type ControlKey = Extract<DirectoryKey, { kind: 'control' }>;
type ArmedControl = Extract<ControlRecord, { state: 'armed' | 'rejected' | 'unknown' }> & { state: 'armed' };

/** Own the directory transport, but borrow combined V3 authority and its token source. */
export async function openDirectory(table: DirectoryTable, startup: DirectoryContext, authority?: { allowed(): boolean }) {
  const ownerUUID = randomUUID(); let closed = false; let ready = false; let closing: Promise<void> | undefined;
  const work = new Set<Promise<unknown>>();
  const check = (context: DirectoryContext, opening = false) => {
    if (closed) throw new DirectoryError('closed');
    if ((!opening && !ready) || authority?.allowed() === false) throw new DirectoryError('unready');
    if (context.signal.aborted || !Number.isFinite(context.deadline) || !Number.isFinite(performance.now()) || performance.now() >= context.deadline) throw new DirectoryError('unavailable');
    if (context.authorizeWrite?.() === false) throw new DirectoryError('unready');
  };
  const guarded = (context: DirectoryContext, opening = false): DirectoryContext => {
    check(context, opening); const signal = context.signal; const deadline = context.deadline; const supplied = context.authorizeWrite;
    return { signal, deadline, authorizeWrite: () => !closed && (opening || ready) && authority?.allowed() !== false && supplied?.() !== false };
  };
  const run = <T>(context: DirectoryContext, operation: (ctx: DirectoryContext) => Promise<T>): Promise<T> => {
    try {
      const ctx = guarded(context); const pending = operation(ctx).then(value => { check(ctx); return value; });
      work.add(pending); void pending.then(() => work.delete(pending), () => work.delete(pending)); return pending;
    } catch (error) { return Promise.reject(error); }
  };
  const read = async (key: DirectoryKey, context: DirectoryContext) => {
    const result = await table.get(key, context); check(context, !ready); return result;
  };
  const persist = async (previous: DirectoryRow | undefined, desired: DirectoryRecord, context: DirectoryContext) => {
    const value = snapshotDirectoryRecord(desired); const key = recordKey(value); check(context, !ready);
    const result = previous ? await table.replace(key, previous.etag, value, context) : await table.insert(key, value, context);
    check(context, !ready);
    // Neither an ACK nor a conflict is commit authority; an exact row is the proof.
    const saved = await read(key, context);
    if (saved && canonicalJSON(saved.value) === canonicalJSON(value)) return saved;
    throw new DirectoryError(result.kind === 'conflict' ? 'conflict' : 'unavailable');
  };
  const recover = async (row: DirectoryRow, context: DirectoryContext): Promise<DirectoryRow> => {
    if (row.value.kind !== 'control' || row.value.state !== 'armed' || row.value.ownerUUID === ownerUUID) return row;
    return persist(row, { ...row.value, state: 'unknown' }, context);
  };
  const connectionIdentity = (value: ConnectionRecord) => canonicalJSON([value.scope, value.conversationId, value.chatKind,
    value.targetId, value.identityDigest, value.bindingName, value.lineage]);
  const controlIdentity = (value: ControlRecord) => canonicalJSON([value.scope, value.conversationId, value.chatKind,
    value.activityId, value.fingerprint, value.desiredTargetDigest]);
  const controlRow = async (key: ControlKey, ctx: DirectoryContext) => {
    const row = await read(key, ctx); return row && recover(row, ctx);
  };
  try {
    const context = guarded(startup, true);
    const inherited = await table.list(context, true); check(context, true);
    for (const row of inherited) {
      if (row.value.kind !== 'control' || row.value.state !== 'armed') throw new DirectoryError('corrupt');
      await recover(row, context);
    }
    check(context, true); ready = true;
  } catch {
    closed = true; await table.close().catch(() => {}); throw new DirectoryError('unready');
  }
  return {
    getConnection(conversationId: string, context: DirectoryContext): Promise<ConnectionRecord | undefined> {
      return run(context, async ctx => {
        const row = await read({ kind: 'conn', conversationId }, ctx);
        if (row && row.value.kind !== 'conn') throw new DirectoryError('corrupt'); return row?.value as ConnectionRecord | undefined;
      });
    },
    reserveConnection(input: ConnectionRecord, context: DirectoryContext): Promise<ConnectionRecord> {
      return run(context, async ctx => {
        const value = snapshotDirectoryRecord(input) as ConnectionRecord; const key = recordKey(value);
        const existing = await read(key, ctx);
        if (existing) {
          if (existing.value.kind !== 'conn') throw new DirectoryError('corrupt');
          if (connectionIdentity(existing.value) !== connectionIdentity(value)) throw new DirectoryError('conflict'); return existing.value;
        }
        try { return (await persist(undefined, value, ctx)).value as ConnectionRecord; }
        catch (error) {
          if (!(error instanceof DirectoryError) || error.code !== 'conflict') throw error;
          const winner = await read(key, ctx);
          if (winner?.value.kind === 'conn' && connectionIdentity(winner.value) === connectionIdentity(value)) return winner.value;
          throw error;
        }
      });
    },
    markProvisioned(expected: ConnectionRecord, binding: BindingEvidence, context: DirectoryContext): Promise<ConnectionRecord> {
      return run(context, async ctx => {
        const candidate = snapshotDirectoryRecord({ ...expected, state: 'provisioned', binding }) as ConnectionRecord;
        const row = await read(recordKey(candidate), ctx);
        if (!row || row.value.kind !== 'conn' || connectionIdentity(row.value) !== connectionIdentity(candidate)) throw new DirectoryError('conflict');
        if (row.value.state === 'provisioned') {
          if (canonicalJSON(row.value) !== canonicalJSON(candidate)) throw new DirectoryError('conflict'); return row.value;
        }
        return (await persist(row, candidate, ctx)).value as ConnectionRecord;
      });
    },
    getControl(key: ControlKey, context: DirectoryContext): Promise<ControlRecord | undefined> {
      return run(context, async ctx => {
        const row = await controlRow(key, ctx);
        if (row && row.value.kind !== 'control') throw new DirectoryError('corrupt'); return row?.value as ControlRecord | undefined;
      });
    },
    reserveControl(input: ControlRecord, context: DirectoryContext): Promise<ControlRecord> {
      return run(context, async ctx => {
        const value = snapshotDirectoryRecord(input) as ControlRecord;
        if (value.state !== 'ready') throw new DirectoryError('invalid-input');
        const key: ControlKey = { kind: 'control', conversationId: value.conversationId, activityId: value.activityId };
        const existing = await controlRow(key, ctx);
        if (existing) {
          if (existing.value.kind !== 'control') throw new DirectoryError('corrupt');
          if (controlIdentity(existing.value) !== controlIdentity(value)) throw new DirectoryError('conflict'); return existing.value;
        }
        try { return (await persist(undefined, value, ctx)).value as ControlRecord; }
        catch (error) {
          if (!(error instanceof DirectoryError) || error.code !== 'conflict') throw error;
          const winner = await controlRow(key, ctx);
          if (winner?.value.kind === 'control' && controlIdentity(winner.value) === controlIdentity(value)) return winner.value;
          throw error;
        }
      });
    },
    armControl(key: ControlKey, context: DirectoryContext): Promise<ArmedControl> {
      return run(context, async ctx => {
        const row = await controlRow(key, ctx);
        if (!row || row.value.kind !== 'control' || row.value.state !== 'ready') throw new DirectoryError('conflict');
        const value = { ...row.value, state: 'armed' as const, ownerUUID, attemptUUID: randomUUID() };
        return (await persist(row, value, ctx)).value as ArmedControl;
      });
    },
    settleControl(key: ControlKey, attemptUUID: string, outcome: ControlSettlement, context: DirectoryContext): Promise<ControlRecord> {
      return run(context, async ctx => {
        const row = await controlRow(key, ctx);
        if (!row || row.value.kind !== 'control' || row.value.state !== 'armed' ||
            row.value.ownerUUID !== ownerUUID || row.value.attemptUUID !== attemptUUID) throw new DirectoryError('conflict');
        const { ownerUUID: _owner, attemptUUID: _attempt, ...base } = row.value;
        const value: ControlRecord = outcome.kind === 'no-effect' ? { ...base, state: 'ready' } :
          outcome.kind === 'delivered' ? { ...row.value, state: 'delivered', providerMessageId: outcome.providerMessageId } : { ...row.value, state: outcome.kind };
        return (await persist(row, value, ctx)).value as ControlRecord;
      });
    },
    close(): Promise<void> {
      if (!closing) { closed = true; ready = false;
        closing = Promise.allSettled([table.close(), ...work]).then(results => {
          if (results[0]?.status === 'rejected') throw new DirectoryError('unavailable');
        });
      }
      return closing;
    },
  };
}
export type Directory = Awaited<ReturnType<typeof openDirectory>>;
