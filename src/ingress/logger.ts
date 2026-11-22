import type { ILogger } from '@microsoft/teams.common';

// The SDK logs pre-auth activities and arbitrary error objects, even in children.
// Discard all SDK arguments; application observability uses fixed categories and numeric samples only.
const discard = (..._values: unknown[]): void => {};
export const safeSdkLogger: ILogger = Object.freeze({ debug: discard, info: discard, warn: discard,
  error: discard, trace: discard, log: discard, child: () => safeSdkLogger });

export type IngressLogEvent = 'listening' | 'stopped' | 'initialized' | 'configuration-failed' | 'startup-failed' | 'storage-failed' |
  'store-open-failed' | 'store-owned-requires-operator-recovery' | 'listener-failed' | 'startup-cleanup-failed' |
  'reclaimed' | 'operator-recovery-failed' | 'upgraded' | 'lease-transition-uncertain' | 'lease-owned-busy' | 'lease-authority-lost' | 'lease-format-unsupported';
export type IngressLogReason = 'invalid-configuration' | 'runtime-failure' | 'missing' | 'occupied' | 'corrupt' | 'incomplete' |
  'unresolved' | 'unavailable' | 'cancelled' | 'ingress' | 'outbound' | 'owner-or-epoch-mismatch' | 'already-unowned' |
  'audit-or-storage-failed' | 'outcome-uncertain';
export function logIngress(event: IngressLogEvent, reason?: IngressLogReason, store?: 'ingress' | 'delivery' | 'correlation'): void {
  process.stderr.write(`teams-ingress: ${event}${store ? ` (${store})` : ''}${reason ? `: ${reason}` : ''}\n`);
}

/** One line per forward attempt put back: fixed words and numbers only, never an event, a person or what they wrote. */
export function logForwardRetry(retry: Readonly<import('./types.js').ForwardRetry>, targetId?: string): void {
  process.stderr.write(`teams-ingress: forward-retry${targetId ? ` (${targetId})` : ''} stage=${retry.stage} reason=${retry.reason} attempt=${retry.attempt}${
    retry.delayMs === undefined ? '' : ` retryMs=${retry.delayMs}`}\n`);
}

/** CLI-only diagnostics: project numeric fields, never arbitrary SDK or process data. */
export function startProcessMemoryDiagnostics(): () => void {
  const timer = setInterval(() => {
    const { rss, heapTotal, heapUsed, external, arrayBuffers } = process.memoryUsage();
    process.stderr.write(`teams-ingress: process-memory ${JSON.stringify({ rss, heapTotal, heapUsed, external, arrayBuffers })}\n`);
  }, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
