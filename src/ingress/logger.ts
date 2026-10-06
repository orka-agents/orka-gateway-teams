import type { ILogger } from '@microsoft/teams.common';

// The SDK logs pre-auth activities and arbitrary error objects, even in children.
// Discard all SDK arguments; application observability uses fixed categories only.
const discard = (..._values: unknown[]): void => {};
export const safeSdkLogger: ILogger = Object.freeze({ debug: discard, info: discard, warn: discard,
  error: discard, trace: discard, log: discard, child: () => safeSdkLogger });

export type IngressLogEvent = 'listening' | 'stopped' | 'initialized' | 'configuration-failed' | 'startup-failed' | 'storage-failed' |
  'store-open-failed' | 'store-owned-requires-operator-recovery' | 'listener-failed' | 'startup-cleanup-failed' |
  'reclaimed' | 'operator-recovery-failed';
export type IngressLogReason = 'invalid-configuration' | 'runtime-failure' | 'missing' | 'occupied' | 'corrupt' | 'incomplete' |
  'unresolved' | 'unavailable' | 'cancelled' | 'ingress' | 'outbound' | 'owner-or-epoch-mismatch' | 'already-unowned' |
  'audit-or-storage-failed' | 'outcome-uncertain';
export function logIngress(event: IngressLogEvent, reason?: IngressLogReason, store?: 'ingress' | 'delivery' | 'correlation'): void {
  process.stderr.write(`teams-ingress: ${event}${store ? ` (${store})` : ''}${reason ? `: ${reason}` : ''}\n`);
}
