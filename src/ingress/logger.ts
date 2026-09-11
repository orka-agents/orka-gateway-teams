import type { ILogger } from '@microsoft/teams.common';

// The SDK logs pre-auth activities and arbitrary error objects, even in children.
// Discard all SDK arguments; application observability uses fixed categories only.
const discard = (..._values: unknown[]): void => {};
export const safeSdkLogger: ILogger = Object.freeze({ debug: discard, info: discard, warn: discard,
  error: discard, trace: discard, log: discard, child: () => safeSdkLogger });

export type IngressLogEvent = 'listening' | 'stopped' | 'initialized' | 'configuration-failed' | 'startup-failed' | 'storage-failed';
export function logIngress(event: IngressLogEvent): void {
  process.stderr.write(`teams-ingress: ${event}\n`);
}
