import { hash, stamp } from './table-service.js';
import { wireM2 } from './table-v2.js';

// Independently encoded wire/policy; no production digest or lease helpers.
export function lease(sequence = 1, expiresAt = 1120000) {
  return { schema: 1, durationMs: 120000, skewMs: 5000, handoffMs: 1000, sequence,
    invocation: '55555555-5555-4555-8555-555555555555', expiresAt };
}
export function digest3(m: Record<string, unknown>) {
  const domain = hash(['orka-m-v2', m.Binding, m.InitId, m.InitDigest, m.Owner, Number(m.Epoch), m.Invocation,
    m.Operation, m.Plan, m.State, m.Result, m.Exit]);
  return hash(['orka-m-v3', domain, m.Lease]);
}
export function wireM3(owner = '', epoch = 0) {
  const m = { ...wireM2(owner, epoch), V: 3, Lease: owner ? Buffer.from(JSON.stringify(lease())).toString('base64') : '', 'Lease@odata.type': 'Edm.Binary' };
  return { ...m, Digest: digest3(m) };
}
export function changedM3(original: Record<string, unknown>, change: Record<string, unknown>, version = 100) {
  const m = { ...original, ...change }; return stamp({ ...m, Digest: digest3(m) }, version);
}
export class TestClock {
  wall = 1000000; mono = 0;
  private id = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  wallNow = () => this.wall;
  monotonicNow = () => this.mono;
  setTimer = (callback: () => void, delay: number) => {
    const id = ++this.id; this.timers.set(id, { at: this.mono + delay, callback });
    return () => { this.timers.delete(id); };
  };
  advance(ms: number, runTimers = true) {
    this.wall += ms; this.mono += ms;
    if (runTimers) for (const [id, timer] of [...this.timers]) if (timer.at <= this.mono && this.timers.delete(id)) timer.callback();
  }
  get pendingTimers() { return this.timers.size; }
}
