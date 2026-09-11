import type { IngressStore, OrkaClient, OrkaPostResult } from './types.js';

/** One persisted attempt, one POST, one fenced settlement. Composition owns serialization and shutdown/drain. */
export async function relayOne(store: IngressStore, client: OrkaClient, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const claim = store.claim();
  if (!claim) return false;
  let result: OrkaPostResult;
  try { result = await client.post(claim.event, signal); }
  catch { result = { kind: 'retry' }; }
  if (signal?.aborted && result.kind !== 'retry') result = { kind: 'retry' };
  if (result.kind === 'receipt') store.complete(claim, result.receipt);
  else if (result.kind === 'blocked') store.block(claim, result.reason);
  else {
    const backoff = Math.min(60000, 1000 * 2 ** Math.min(6, claim.attempt - 1));
    store.retry(claim, Math.max(backoff, result.retryAfterMs ?? 0));
  }
  // A stale result is harmless. Storage failures must escape to stop the loop,
  // not be reclassified as network failures or cause a second settlement.
  return true;
}
