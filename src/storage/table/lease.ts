import { randomUUID } from 'node:crypto';
import { integer } from './codec.js';
import type { LeaseClock, LeaseValue } from './types.js';
import { TableError } from './types.js';

const duration = 120000; const margin = 6000; const renewAfter = 40000;
const clock: LeaseClock = { wallNow: () => Date.now(), monotonicNow: () => performance.now(),
  setTimer(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return () => clearTimeout(timer); } };
export interface LeaseFrame { value: LeaseValue; wall: number; mono: number }
/** Local authority only: metadata readback, not a timer, confirms a new grant. */
export class LeaseController {
  readonly lost = new AbortController();
  private frame: LeaseFrame | undefined;
  private confirmed = false;
  private expiry: (() => void) | undefined;
  private renewal: (() => void) | undefined;
  private readonly time: LeaseClock;
  constructor(input: LeaseClock | undefined, private readonly onRenew: () => void, private readonly onLoss: () => void) {
    const source = input ?? clock;
    this.time = { wallNow: source.wallNow.bind(source), monotonicNow: source.monotonicNow.bind(source), setTimer: source.setTimer.bind(source) };
  }
  propose(sequence: number): LeaseFrame {
    const wall = integer(this.time.wallNow(), 0, Number.MAX_SAFE_INTEGER - duration);
    const mono = this.time.monotonicNow();
    if (!Number.isFinite(mono) || mono < 0 || mono > Number.MAX_SAFE_INTEGER - duration) throw new TableError('invalid-input');
    return { wall, mono, value: { schema: 1, durationMs: duration, skewMs: 5000, handoffMs: 1000,
      sequence: integer(sequence, 1, Number.MAX_SAFE_INTEGER), invocation: randomUUID(), expiresAt: wall + duration } };
  }
  begin(frame: LeaseFrame): void { this.frame = frame; this.confirmed = false; this.schedule(); }
  confirm(frame: LeaseFrame): void {
    if (!this.permit() || !this.valid(frame)) { this.revoke(); throw new TableError('unresolved'); }
    this.frame = frame; this.confirmed = true; this.schedule();
  }
  allowed(): boolean { return this.confirmed && this.permit(); }
  permit(): boolean {
    if (this.lost.signal.aborted || !this.frame) return false;
    if (!this.valid(this.frame)) { this.revoke(); return false; } return true;
  }
  due(): boolean { return this.allowed() && this.time.monotonicNow() >= this.frame!.mono + renewAfter; }
  cancel(): void { this.clear(); this.frame = undefined; this.confirmed = false; }
  revoke(): void {
    if (this.lost.signal.aborted) return;
    this.clear(); this.confirmed = false; this.lost.abort(); this.onLoss();
  }
  private valid(frame: LeaseFrame): boolean {
    const wall = this.time.wallNow(); const mono = this.time.monotonicNow();
    return Number.isSafeInteger(wall) && Number.isFinite(mono) && mono >= frame.mono &&
      Math.abs((wall - frame.wall) - (mono - frame.mono)) <= 5000 &&
      wall < frame.value.expiresAt - margin && mono < frame.mono + duration - margin;
  }
  private clear(): void { this.expiry?.(); this.renewal?.(); this.expiry = undefined; this.renewal = undefined; }
  private schedule(): void {
    this.clear(); const frame = this.frame!;
    const remaining = () => Math.min(frame.mono + duration - margin - this.time.monotonicNow(), frame.value.expiresAt - margin - this.time.wallNow());
    const expire = () => { if (this.permit()) this.expiry = this.time.setTimer(expire, Math.max(1, Math.ceil(remaining()))); };
    this.expiry = this.time.setTimer(expire, Math.max(1, Math.ceil(remaining())));
    const renew = () => {
      if (!this.allowed()) return;
      const remaining = frame.mono + renewAfter - this.time.monotonicNow();
      // A timer may wake just before the fractional monotonic deadline.
      if (remaining > 0) this.renewal = this.time.setTimer(renew, Math.max(1, Math.ceil(remaining)));
      else this.onRenew();
    };
    if (this.confirmed) this.renewal = this.time.setTimer(renew,
      Math.max(1, Math.ceil(frame.mono + renewAfter - this.time.monotonicNow())));
  }
}
