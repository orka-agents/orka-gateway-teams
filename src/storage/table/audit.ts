import { types } from 'node:util';
import { addAbortListener } from 'node:events';
import { fail, integer } from './codec.js';
import type { AnyStoredRecord, AuditVisitorFor, MetadataFormat } from './format.js';
import { TableError } from './types.js';
import type { OwnedAuditBudget, OwnedAuditOptions } from './types.js';

export interface AuditConfig extends OwnedAuditBudget {
  passes: 1 | 2;
  record: (this: void, pass: 1 | 2, record: Readonly<AnyStoredRecord>) => undefined;
  endPass: (this: void, pass: 1 | 2) => undefined;
  finalize: (this: void) => undefined;
  signal: AbortSignal | undefined;
  requestTimeoutMs: number;
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
export function signalAborted(signal: AbortSignal): boolean { return aborted.call(signal) as boolean; }

/** Node's resistant listener, backed only by the already-brand-checked native signal. */
export function subscribeAuditAbort(signal: AbortSignal, listener: () => void): () => void {
  // addAbortListener reads these public properties. A private view preserves its
  // native stop-propagation resistance without invoking caller method/getter overrides.
  const view = { get aborted() { return signalAborted(signal); },
    addEventListener: EventTarget.prototype.addEventListener.bind(signal),
    removeEventListener: EventTarget.prototype.removeEventListener.bind(signal) } as AbortSignal;
  const subscription = addAbortListener(view, listener);
  return () => subscription[Symbol.dispose]();
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) fail();
    // Read the descriptor, not the caller object (including Proxy get traps).
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
/** Descriptor validation precedes admission; retain no original visitor/budget/options object. */
export function auditConfig<F extends MetadataFormat>(visitor: AuditVisitorFor<F>, budget: OwnedAuditBudget, options?: OwnedAuditOptions): AuditConfig {
  const v = fields(visitor, ['passes', 'record', 'endPass', 'finalize']);
  const b = fields(budget, ['maxPages', 'maxPageBytes', 'maxDurationMs', 'maxTrackingBytes']);
  const o = options === undefined ? Object.create(null) as Record<string, unknown> : fields(options, ['signal', 'requestTimeoutMs']);
  for (const key of ['passes', 'record', 'endPass', 'finalize']) if (!Object.hasOwn(v, key)) fail();
  for (const key of ['maxPages', 'maxPageBytes', 'maxDurationMs', 'maxTrackingBytes']) if (!Object.hasOwn(b, key)) fail();
  if ((v.passes !== 1 && v.passes !== 2) || typeof v.record !== 'function' || typeof v.endPass !== 'function' || typeof v.finalize !== 'function') fail();
  const signal = Object.hasOwn(o, 'signal') ? o.signal : undefined;
  if (signal !== undefined) {
    if (!(signal instanceof AbortSignal)) fail(); signalAborted(signal); // Native brand check, not a caller's overridden getter.
  }
  const timeout = Object.hasOwn(o, 'requestTimeoutMs') ? o.requestTimeoutMs : undefined;
  return { passes: v.passes, record: v.record as AuditConfig['record'], endPass: v.endPass as AuditConfig['endPass'], finalize: v.finalize as AuditConfig['finalize'],
    maxPages: integer(b.maxPages, 1, Number.MAX_SAFE_INTEGER), maxPageBytes: integer(b.maxPageBytes, 1, Number.MAX_SAFE_INTEGER),
    maxDurationMs: integer(b.maxDurationMs, 1, 2147483647), maxTrackingBytes: integer(b.maxTrackingBytes, 1, 256 * 1024 * 1024),
    requestTimeoutMs: integer(timeout === undefined ? 30000 : timeout, 1, 300000), signal: signal as AbortSignal | undefined };
}
/** Validated safe-integer work counters must fit before arithmetic can round. */
export function chargeAuditWork(total: number, amount: number, limit: number): number {
  if (amount > limit - total) throw new TableError('incomplete'); return total + amount;
}
/**
 * Best-effort handling of ordinary returned/thrown/cross-realm native Promises.
 * Avoids instance then getters, not constructor/species machinery; assumes safe
 * constructor/species and relevant intrinsics. A tampered immutable Promise can
 * still reject unhandled (process diagnostics/termination), separately from audit
 * poisoning. Trusted synchronous callbacks are not sandboxed by this defense.
 */
export function containCallbackPromise(value: unknown): void {
  if (types.isPromise(value)) void Promise.prototype.then.call(value, () => undefined, () => undefined);
}
