import { readFileSync } from 'node:fs';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import type { LeaseClock } from '../../src/storage/table/types.js';

// A test-only native barrier, never loaded by a production runtime.
export function pauseAfterPost(baseUrl: string): void {
  const native = https.request; const target = new URL(baseUrl);
  https.request = ((...args: Parameters<typeof https.request>) => {
    const req = native(...args); const first = args[0] as string | URL | https.RequestOptions;
    const url = first instanceof URL ? first : typeof first === 'string' ? new URL(first) :
      new URL(`https://${first.hostname ?? first.host}${first.port ? ':' + first.port : ''}${first.path ?? '/'}`);
    if (url.origin === target.origin && req.method === 'POST') req.once('finish', () => {
      // The worker, not a loaded parent, stops immediately after native flush.
      // Its ordinary request deadline cannot retire the attempt before SIGSTOP.
      process.kill(process.pid, 'SIGSTOP');
    });
    return req;
  }) as typeof https.request;
  syncBuiltinESMExports();
}

// Trusted library clock only. The parent changes the paired offset while the
// real worker is SIGSTOPped; no IPC continuation or expiry timer must run first.
export function processClock(path: string): LeaseClock {
  const offset = () => Number(readFileSync(path, 'utf8'));
  return { wallNow: () => Date.now() + offset(), monotonicNow: () => performance.now() + offset(),
    setTimer(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } };
}
