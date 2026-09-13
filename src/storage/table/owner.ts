import { randomUUID } from 'node:crypto';
import { bindTable, bytes, dataRow, digest, etag, fail, initializationDigest, integer, metadata, object } from './codec.js';
import { OwnedTableClient } from './client.js';
import type { WorkContext } from './client.js';
import { DEFAULT_LIMITS, MAX_PAYLOAD_BYTES, MAX_STATE_BYTES, MAX_WIRE_BYTES, TableError } from './types.js';
import type { BoundTable, CallOptions, DataAction, DataKey, Metadata, MutationInput, MutationResult, Plan, Planner, StoredRecord, TableBinding, TableDependencies, TableLimits } from './types.js';

type Lifecycle = 'unowned' | 'acquiring' | 'owned-unready' | 'envelope-audited' | 'reconciling' | 'poisoned' | 'closing' | 'closed';
type Job = { run: (context: WorkContext) => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: TableError) => void;
  context: WorkContext; bytes: number; started: boolean; finished: boolean; timer: ReturnType<typeof setTimeout>; removeAbort: () => void };
interface Confirmed { kind: 'committed' | 'cancelled'; record: StoredRecord }
function m(record: StoredRecord | undefined): Metadata {
  if (!record || record.row !== 'M' || record.value.kind !== 'metadata') throw new TableError('corrupt'); return record.value;
}
function same(a: StoredRecord, b: StoredRecord): boolean { return a.etag === b.etag && a.value.digest === b.value.digest; }
function eligible(context: WorkContext): boolean { return !context.signal.aborted && performance.now() < context.deadline; }
function snapshotRecord(record: StoredRecord | undefined): StoredRecord | undefined {
  if (!record) return undefined;
  const value = record.value;
  return { ...record, value: value.kind === 'data' ? { ...value, payload: Buffer.from(value.payload) } :
    { ...value, state: Buffer.from(value.state), result: Buffer.from(value.result), release: Buffer.from(value.release) } };
}

/** Synchronous construction keeps possibly acquired ownership reachable even when acquire rejects. */
export function createTableKernel(binding: TableBinding, dependencies: TableDependencies, limits: Partial<TableLimits> = {}): TableKernel {
  return new TableKernel(bindTable(binding), dependencies, limits);
}
class TableKernel {
  private lifecycle: Lifecycle = 'unowned';
  private ownership: 'none' | 'possible' | 'owned' = 'none';
  private owner = '';
  private fence?: StoredRecord;
  private readonly client: OwnedTableClient;
  private readonly limits: TableLimits;
  private readonly queue: Job[] = [];
  private active: Job | undefined;
  private pending = 0;
  private pendingBytes = 0;
  private closing?: Promise<void>;
  private invalidated = false;
  private readonly writePermission = new AbortController();
  private drain?: () => void;
  constructor(private readonly binding: BoundTable, dependencies: TableDependencies, limits: Partial<TableLimits>) {
    object(limits, Object.keys(DEFAULT_LIMITS)); this.limits = { ...DEFAULT_LIMITS, ...limits };
    integer(this.limits.maxPending, 1, 1024); integer(this.limits.maxPendingBytes, 1, 256 * 1024 * 1024);
    integer(this.limits.callTimeoutMs, 1, 300000); integer(this.limits.cleanupTimeoutMs, 1, 300000);
    integer(this.limits.reconciliationReads, 2, 16); integer(this.limits.scanPages, 1, 100000); integer(this.limits.scanBytes, 1, 256 * 1024 * 1024);
    this.client = new OwnedTableClient(binding, dependencies);
  }
  status() {
    return Object.freeze({ lifecycle: this.closing && this.lifecycle !== 'closed' ? 'closing' : this.invalidated && this.lifecycle !== 'closed' ? 'poisoned' : this.lifecycle,
      ownership: this.ownership, pending: this.pending, pendingBytes: this.pendingBytes });
  }
  initialize(options?: CallOptions): Promise<void> {
    return this.enqueue(0, options, async context => {
      this.requireUnowned();
      const records = await this.collect(context);
      if (records.length) throw new TableError('exists');
      if (!eligible(context)) throw new TableError('not-submitted');
      const initId = randomUUID();
      const expected = metadata(this.binding, { initId, initDigest: initializationDigest(this.binding, initId), owner: '', epoch: 0,
        invocation: initId, operation: 'initialize', plan: digest(['initialize', initId]), state: Buffer.alloc(0), result: Buffer.alloc(0), release: Buffer.alloc(0) });
      try { await this.write(expected, undefined, [], context); } catch { /* ACK is not authority. */ }
      const cleanup = this.cleanup();
      try {
        for (let i = 0; i < this.limits.reconciliationReads && eligible(cleanup.context); i++) {
          try {
            const current = await this.client.read('M', cleanup.context);
            if (current) {
              const value = m(current);
              if (value.initId === expected.initId && value.initDigest === expected.initDigest) return;
              break;
            }
          } catch (e) { if (e instanceof TableError && e.code === 'corrupt') break; }
        }
        this.poison();
      } finally { cleanup.done(); }
    });
  }
  acquire(options?: CallOptions): Promise<void> {
    return this.enqueue(0, options, async context => {
      this.requireUnowned(); const original = await this.client.read('M', context);
      if (!original) throw new TableError('missing'); const previous = m(original);
      if (previous.owner !== '') throw new TableError('busy');
      if (!eligible(context)) throw new TableError('not-submitted');
      this.owner = randomUUID(); const invocation = randomUUID();
      const expected = metadata(this.binding, { ...previous, owner: this.owner, epoch: integer(previous.epoch + 1, 1, Number.MAX_SAFE_INTEGER),
        invocation, operation: 'acquire', plan: digest(['acquire', previous.digest, this.owner, invocation]) });
      this.ownership = 'possible'; this.lifecycle = 'acquiring';
      const result = await this.transition(original, expected, [], context);
      this.fence = result.record;
      if (result.kind === 'cancelled') { this.owner = ''; this.ownership = 'none'; this.lifecycle = 'unowned'; throw new TableError('not-submitted'); }
      this.ownership = 'owned'; this.lifecycle = 'owned-unready';
    });
  }
  read(key: DataKey | 'M', options?: CallOptions): Promise<StoredRecord | undefined> {
    let row: string;
    try { row = key === 'M' ? 'M' : dataRow(this.binding, key); } catch { return Promise.reject(new TableError('invalid-input')); }
    return this.enqueue(Buffer.byteLength(row), options, async context => {
      const current = this.ownership === 'owned' && !this.invalidated && this.lifecycle !== 'poisoned' ? await this.authority(context) : undefined;
      const record = row === 'M' && current ? current : await this.readRecord(row, context);
      if (current && row !== 'M') await this.authority(context);
      return record;
    });
  }
  scan(options?: CallOptions): Promise<readonly StoredRecord[]> {
    return this.enqueue(0, options, async context => {
      this.requireOwned(false); this.lifecycle = 'owned-unready';
      try {
        const before = await this.authority(context); const records = await this.collect(context);
        const control = records.find(r => r.row === 'M');
        if (!control || !same(before, control)) this.poison();
        const after = await this.authority(context); if (!same(before, after)) this.poison();
        if (!eligible(context)) throw new TableError('incomplete'); this.lifecycle = 'envelope-audited'; return records;
      } catch (error) {
        if (error instanceof TableError && ['corrupt', 'unresolved'].includes(error.code)) this.poison();
        throw new TableError('incomplete');
      }
    });
  }
  mutate(input: MutationInput, planner: Planner, options?: CallOptions): Promise<MutationResult> {
    let snapshot: MutationInput; let size: number;
    try {
      object(input, ['input', 'keys']); if (!Array.isArray(input.keys) || input.keys.length > 99 || typeof planner !== 'function') fail();
      if (!(input.input instanceof Uint8Array) || input.input.byteLength > MAX_PAYLOAD_BYTES) fail();
      const rows = new Set<string>(); const keys = input.keys.map(key => {
        const row = dataRow(this.binding, key); if (rows.has(row)) fail(); rows.add(row); return { type: key.type, id: key.id };
      });
      size = input.input.byteLength + [...rows].reduce((n, row) => n + Buffer.byteLength(row), 0);
      // Admission is checked before retaining copies; enqueue is synchronous too.
      this.capacity(size); snapshot = { input: bytes(input.input, MAX_PAYLOAD_BYTES), keys };
    } catch (error) { return Promise.reject(error instanceof TableError ? error : new TableError('invalid-input')); }
    return this.enqueue(size, options, async context => {
      this.requireOwned(true); const original = await this.authority(context); const records: (StoredRecord | undefined)[] = [];
      for (const key of snapshot.keys) records.push(await this.readRecord(dataRow(this.binding, key), context));
      if (!eligible(context)) throw new TableError('not-submitted');
      let plan: Plan;
      try {
        // Planner never receives the authoritative M or retained input buffers.
        const proposed = planner({ input: bytes(snapshot.input, MAX_PAYLOAD_BYTES), state: Buffer.from(m(original).state), records: records.map(snapshotRecord) });
        if (proposed instanceof Promise) {
          // Invalid trusted planners cannot surface a later raw rejection. Their external work is not a supported kernel operation.
          void Promise.prototype.then.call(proposed, () => undefined, () => undefined); fail();
        }
        plan = this.plan(proposed);
      } catch { throw new TableError('invalid-input'); }
      if (!eligible(context)) throw new TableError('not-submitted');
      const invocation = randomUUID();
      const expected = metadata(this.binding, { ...m(original), invocation, operation: 'mutate', state: Buffer.from(plan.state), result: Buffer.from(plan.result),
        plan: digest(['mutate', invocation, original.value.digest, plan.actions.map(a => [a.kind, a.key.type, a.key.id,
          a.kind === 'replace' ? a.etag : '', Buffer.from(a.payload).toString('base64')]), Buffer.from(plan.state).toString('base64'), Buffer.from(plan.result).toString('base64')]) });
      this.lifecycle = 'reconciling';
      const result = await this.transition(original, expected, plan.actions, context); this.fence = result.record; this.lifecycle = 'envelope-audited';
      return result.kind === 'committed' ? { kind: 'committed', result: Buffer.from(expected.result) } : { kind: 'cancelled' };
    });
  }
  /** Irreversible domain-audit failure. Completion cannot restore authority; close still drains. */
  invalidate(): void { this.invalidated = true; this.lifecycle = 'poisoned'; this.writePermission.abort(); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Set the intake fence before cancelling queued work or waiting on active promises.
    const drained = new Promise<void>(resolve => { if (this.active) this.drain = resolve; else resolve(); });
    this.closing = drained.then(async () => {
      let error: TableError | undefined;
      try {
        if (this.invalidated || this.lifecycle === 'poisoned' || this.ownership === 'possible') throw new TableError('unresolved');
        if (this.ownership === 'owned') {
          const cleanup = this.cleanup();
          try {
            const original = await this.authority(cleanup.context); const previous = m(original); const invocation = randomUUID();
            const plan = digest(['release', previous.digest, invocation]);
            const release = Buffer.from(JSON.stringify([previous.owner, previous.epoch, invocation, plan]));
            const expected = metadata(this.binding, { ...previous, owner: '', invocation, operation: 'release', plan, release });
            const result = await this.transition(original, expected, [], cleanup.context);
            if (result.kind !== 'committed') throw new TableError('unresolved');
            this.fence = result.record; this.owner = ''; this.ownership = 'none';
          } finally { cleanup.done(); }
        }
      } catch { error = new TableError('unresolved'); }
      this.lifecycle = 'closing';
      try { await this.client.close(); } catch { error ??= new TableError('unavailable'); }
      this.lifecycle = 'closed'; if (error) throw error;
    });
    for (const job of [...this.queue]) this.cancel(job, new TableError('not-submitted'));
    return this.closing;
  }
  private capacity(size: number): void {
    if (this.closing) throw new TableError('closed');
    if (this.pending >= this.limits.maxPending || this.pendingBytes + size > this.limits.maxPendingBytes) throw new TableError('not-submitted');
  }
  private enqueue<T>(size: number, options: CallOptions | undefined, run: (context: WorkContext) => Promise<T>): Promise<T> {
    try {
      this.capacity(size); if (options !== undefined) object(options, ['signal', 'timeoutMs']);
      const timeout = integer(options?.timeoutMs ?? this.limits.callTimeoutMs, 1, 300000);
      if (options?.signal !== undefined && !(options.signal instanceof AbortSignal)) fail();
      const signal = options?.signal ?? new AbortController().signal;
      if (signal.aborted) throw new TableError('not-submitted');
      const context = { signal, deadline: performance.now() + timeout };
      return new Promise<T>((resolve, reject) => {
        const abort = () => this.cancel(job, new TableError(job.started ? 'unavailable' : 'not-submitted'));
        const job: Job = { run, resolve: value => resolve(value as T), reject, bytes: size, context, started: false, finished: false,
          timer: setTimeout(abort, timeout), removeAbort: () => signal.removeEventListener('abort', abort) };
        signal.addEventListener('abort', abort, { once: true });
        this.pending++; this.pendingBytes += size; this.queue.push(job); this.pump();
      });
    } catch (error) { return Promise.reject(error instanceof TableError ? error : new TableError('invalid-input')); }
  }
  private cancel(job: Job, error: TableError): void {
    if (job.finished) return;
    job.reject(error);
    if (!job.started) {
      const index = this.queue.indexOf(job); if (index < 0) return;
      this.queue.splice(index, 1); this.finish(job);
    }
  }
  private finish(job: Job): void {
    job.finished = true; clearTimeout(job.timer); job.removeAbort(); this.pending--; this.pendingBytes -= job.bytes;
  }
  private pump(): void {
    if (this.active || this.closing) return;
    const job = this.queue.shift(); if (!job) return;
    this.active = job; job.started = true;
    const invalidatedAtStart = this.invalidated;
    const complete = (result: { value: unknown } | { error: TableError }) => {
      // Actual work has settled. Release its slot before publishing completion, so a
      // sequential caller can immediately reserve it even with a one-slot profile.
      this.finish(job); this.active = undefined;
      // Fence work invalidated in flight; already-poisoned diagnostic reads
      // retain their existing behavior. Mutations still require healthy ownership.
      if (this.invalidated && !invalidatedAtStart) job.reject(new TableError('unresolved'));
      else if ('error' in result) job.reject(result.error);
      else if (eligible(job.context)) job.resolve(result.value); else job.reject(new TableError('unavailable'));
      if (this.closing) this.drain?.(); else this.pump();
    };
    void Promise.resolve().then(() => {
      if (!eligible(job.context)) throw new TableError('not-submitted'); return job.run(job.context);
    }).then(value => complete({ value }), error => complete({ error: error instanceof TableError ? error : new TableError('unavailable') }));
  }
  private requireUnowned(): void {
    if (this.invalidated || this.lifecycle === 'poisoned') throw new TableError('unresolved');
    if (this.ownership !== 'none') throw new TableError('busy');
  }
  private requireOwned(audited: boolean): void {
    if (this.invalidated || this.lifecycle === 'poisoned') throw new TableError('unresolved');
    if (this.ownership !== 'owned' || (audited && this.lifecycle !== 'envelope-audited')) throw new TableError('unready');
  }
  private poison(): never { this.invalidate(); throw new TableError('unresolved'); }
  private async readRecord(row: string, context: WorkContext): Promise<StoredRecord | undefined> {
    try { return await this.client.read(row, context); } catch (error) {
      if (this.ownership === 'owned' && error instanceof TableError && error.code === 'corrupt') this.poison();
      throw error;
    }
  }
  private async authority(context: WorkContext): Promise<StoredRecord> {
    let record: StoredRecord | undefined;
    try { record = await this.client.read('M', context); } catch (error) {
      if (error instanceof TableError && error.code === 'corrupt') return this.poison();
      throw new TableError('unavailable');
    }
    if (!record || !this.fence || !same(record, this.fence) || m(record).owner !== this.owner) this.poison(); return record;
  }
  private cleanup(): { context: WorkContext; done: () => void } {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.limits.cleanupTimeoutMs);
    return { context: { signal: controller.signal, deadline: performance.now() + this.limits.cleanupTimeoutMs }, done: () => clearTimeout(timer) };
  }
  private write(expected: Metadata, originalETag: string | undefined, actions: readonly DataAction[], context: WorkContext): Promise<void> {
    if (this.invalidated) throw new TableError('unresolved');
    // Revoke pre-POST permission even across token awaits and independent cleanup
    // contexts. Reads and actual token/request/socket drain remain independent.
    return this.client.write(expected, originalETag, actions, { ...context, signal: AbortSignal.any([context.signal, this.writePermission.signal]) });
  }
  private async transition(original: StoredRecord, expected: Metadata, actions: readonly DataAction[], context: WorkContext): Promise<Confirmed> {
    if (this.invalidated) throw new TableError('unresolved');
    try { await this.write(expected, original.etag, actions, context); } catch { /* Always reconcile; never resubmit original. */ }
    const cleanup = this.cleanup(); let barrier: Metadata | undefined;
    try {
      for (let i = 0; i < this.limits.reconciliationReads && eligible(cleanup.context); i++) {
        let current: StoredRecord | undefined;
        try { current = await this.client.read('M', cleanup.context); } catch (error) {
          if (error instanceof TableError && error.code === 'corrupt') break; continue;
        }
        if (!current) break;
        const value = m(current);
        if (value.digest === expected.digest) return { kind: 'committed', record: current };
        // Release has owner-empty M. A later owner may already have advanced M, but must preserve this exact receipt.
        if (expected.operation === 'release' && value.initId === expected.initId && value.initDigest === expected.initDigest &&
            value.epoch > expected.epoch && value.owner !== this.owner && value.release.equals(expected.release)) return { kind: 'committed', record: current };
        if (barrier && value.digest === barrier.digest) return { kind: 'cancelled', record: current };
        if (!same(current, original)) break;
        if (!barrier) {
          if (this.invalidated) throw new TableError('unresolved');
          const invocation = randomUUID(); barrier = metadata(this.binding, { ...m(original), invocation, operation: 'barrier',
            plan: digest(['barrier', original.value.digest, expected.digest, invocation]) });
          try { await this.write(barrier, original.etag, [], cleanup.context); } catch { /* 412 and lost ACK require another raw read. */ }
        }
      }
      return this.poison();
    } finally { cleanup.done(); }
  }
  private async collect(context: WorkContext): Promise<StoredRecord[]> {
    const records: StoredRecord[] = []; let cursor; let size = 0; let lastRow: string | undefined;
    const tokens = new Set<string>();
    for (let i = 0; i < this.limits.scanPages && eligible(context); i++) {
      const page = await this.client.page(context, cursor); size += page.size;
      if (size > this.limits.scanBytes) throw new TableError('incomplete');
      for (const record of page.records) {
        if (lastRow !== undefined && record.row <= lastRow) throw new TableError('incomplete'); lastRow = record.row; records.push(record);
      }
      if (!page.cursor) return records;
      // Fixed-size hashes, bounded by scanPages; never retain private opaque tokens in history.
      const tokenHash = digest(page.cursor.token); if (tokens.has(tokenHash)) throw new TableError('incomplete'); tokens.add(tokenHash); cursor = page.cursor;
    }
    throw new TableError('incomplete');
  }
  private plan(input: Plan): Plan {
    const value = object(input, ['state', 'result', 'actions']);
    const state = bytes(value.state, MAX_STATE_BYTES); const result = bytes(value.result, MAX_STATE_BYTES);
    if (!Array.isArray(value.actions) || value.actions.length > 99) fail();
    let upper = 8192 + 4 * Math.ceil((this.binding.bytes.length + state.length + result.length + 1024) / 3) + 16;
    const rows = new Set<string>(); const actions: DataAction[] = [];
    for (const raw of value.actions) {
      const action = object(raw, ['kind', 'key', 'payload', 'etag']);
      if (action.kind !== 'create' && action.kind !== 'replace') fail();
      const key = object(action.key, ['type', 'id']) as unknown as DataKey; const row = dataRow(this.binding, key);
      if (rows.has(row) || !(action.payload instanceof Uint8Array) || action.payload.length > MAX_PAYLOAD_BYTES) fail(); rows.add(row);
      upper += 8192 + 4 * Math.ceil(action.payload.length / 3) + 16; if (upper > MAX_WIRE_BYTES) fail();
      const keyCopy = { type: key.type, id: key.id }; const payload = Buffer.from(action.payload);
      if (action.kind === 'replace') actions.push({ kind: 'replace', key: keyCopy, payload, etag: etag(action.etag) });
      else { if (action.etag !== undefined) fail(); actions.push({ kind: 'create', key: keyCopy, payload }); }
    }
    return { state, result, actions };
  }
}
