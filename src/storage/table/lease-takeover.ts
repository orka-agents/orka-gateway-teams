import { bindTable, integer } from './codec.js';
import { OwnedTableClient } from './client.js';
import type { CallOptions, ForeignOwnerFenceV2, LeaseClock, TableBinding, TableLeaseDependencies } from './types.js';
import { TableError } from './types.js';

const systemClock: LeaseClock = { wallNow: Date.now, monotonicNow: () => performance.now(),
  setTimer(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } };
/** A paired local confidence check, not proof of initial UTC accuracy. */
export function expiryClock(input?: LeaseClock) {
  const source = input ?? systemClock;
  const wallNow = source.wallNow.bind(source); const monoNow = source.monotonicNow.bind(source);
  const wall = wallNow(); const mono = monoNow(); let lost = false;
  const now = () => {
    const w = wallNow(); const m = monoNow();
    if (!Number.isSafeInteger(w) || w < 0 || !Number.isFinite(m) || m < mono ||
        !Number.isSafeInteger(wall) || !Number.isFinite(mono) || Math.abs((w - wall) - (m - mono)) > 5000) lost = true;
    if (lost) throw new TableError('unresolved'); return w;
  };
  now();
  return { now, safe: (expiresAt: number) => now() > expiresAt + 5000,
    monotonicNow: monoNow, setTimer: source.setTimer.bind(source) };
}

/** Outside the owner FIFO: wait once for the initially observed lease, then read
 * with a fresh request budget. A renewal is busy, never another wait. */
export async function waitForTableLeaseV3(binding: TableBinding, dependencies: TableLeaseDependencies,
  options: CallOptions = {}): Promise<ForeignOwnerFenceV2 | undefined> {
  const bound = bindTable(binding); const time = expiryClock(dependencies.leaseClock);
  const timeout = integer(options.timeoutMs ?? 30000, 1, 300000);
  const signal = options.signal ?? new AbortController().signal;
  const client = new OwnedTableClient(bound, dependencies, 3);
  const read = () => client.read('M', { signal, deadline: performance.now() + timeout });
  try {
    let row = await read();
    if (signal.aborted) throw new TableError('incomplete');
    if (!row || row.value.kind !== 'metadata' || !row.value.owner) return undefined;
    const first = row; const lease = row.value.lease!;
    if (!time.safe(lease.expiresAt)) {
      const end = time.monotonicNow() + Math.min(135001, Math.max(1, lease.expiresAt + 5001 - time.now()));
      await new Promise<void>((resolve, reject) => {
        let stop: (() => void) | undefined; let settled = false;
        const finish = (error?: TableError) => { if (settled) return; settled = true; stop?.(); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        const abort = () => finish(new TableError('incomplete'));
        const wake = () => { try {
          if (signal.aborted) return abort();
          if (time.safe(lease.expiresAt) || time.monotonicNow() >= end) return finish();
          stop = time.setTimer(wake, Math.max(1, Math.ceil(Math.min(end - time.monotonicNow(), lease.expiresAt + 5001 - time.now()))));
        } catch { finish(new TableError('unresolved')); } };
        signal.addEventListener('abort', abort, { once: true }); wake();
      });
      row = await read();
      if (signal.aborted) throw new TableError('incomplete');
      if (!row || row.value.kind !== 'metadata') throw new TableError('unresolved');
      if (row.etag !== first.etag || row.value.digest !== first.value.digest) throw new TableError('busy');
      if (!time.safe(lease.expiresAt)) throw new TableError('busy');
    }
    const m = row.value;
    return { initId: m.initId, initDigest: m.initDigest, owner: m.owner, epoch: m.epoch, mDigest: m.digest, etag: row.etag };
  } finally { await client.close(); }
}
