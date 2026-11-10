import { readFileSync } from 'node:fs';
import type { LeaseClock } from '../../src/storage/table/types.js';

// Trusted library clock only. The parent changes the paired offset while the
// real worker is SIGSTOPped; no IPC continuation or expiry timer must run first.
export function processClock(path: string): LeaseClock {
  const offset = () => Number(readFileSync(path, 'utf8'));
  return { wallNow: () => Date.now() + offset(), monotonicNow: () => performance.now() + offset(),
    setTimer(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } };
}
