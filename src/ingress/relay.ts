import type { IngressClaim, IngressPort, IngressStore, OrkaClient, OrkaPostPreparation, OrkaPostResult } from './types.js';

/** One persisted attempt, one POST, one fenced settlement. Composition owns serialization and shutdown/drain. */
export async function relayOne(store: IngressStore | IngressPort, client: OrkaClient, signal?: AbortSignal,
  isReady: () => boolean = () => true, preflight?: (claim: Readonly<IngressClaim>, signal?: AbortSignal) => Promise<boolean>): Promise<boolean> {
  const active = () => !signal?.aborted && isReady();
  if (!active()) return false;
  const isPort = 'claimForForwarding' in store;
  let claim: Readonly<IngressClaim>; let preflightFailed = false; let preparation: OrkaPostPreparation | undefined;
  const prepare = async (): Promise<OrkaPostPreparation> => {
    try { return await client.prepare!(claim.event, signal); }
    catch { return { kind: 'retry' }; }
  };
  if (isPort) {
    const grant = await store.claimForForwarding();
    if (!grant) return false;
    try {
      claim = structuredClone(grant.claim);
      if (preflight && !await preflight(claim, signal)) preflightFailed = true;
      if (!preflightFailed && client.prepare) preparation = await prepare();
      if (!preflightFailed && (!preparation || preparation.kind === 'ready')) {
        if (!active() || !await grant.revalidate()) return false;
        // Reconciliation may have outlived cancellation, expiry or quarantine.
        // No await is allowed between the owner's final take and client handoff.
        if (!active() || !grant.take() || !active()) return false;
      }
    } finally { grant.retire(); }
  } else {
    // Compatibility is deliberately synchronous, not Promise<legacy claim>:
    // asynchronous stores must implement the mandatory owner-local handoff.
    const legacy = store.claim();
    if (!legacy) return false;
    if ('then' in legacy) throw new Error('Async ingress requires forwarding permission');
    claim = legacy;
    if (client.prepare) preparation = await prepare();
    if (!active()) return false;
  }
  let result: OrkaPostResult;
  if (preflightFailed) result = { kind: 'retry' };
  else if (preparation && preparation.kind !== 'ready') result = preparation;
  else {
    try { result = await client.post(claim.event, signal, preparation); }
    catch { result = { kind: 'retry' }; }
  }
  if (signal?.aborted && result.kind !== 'retry') result = { kind: 'retry' };
  let settled: boolean;
  if (result.kind === 'receipt') settled = await store.complete(claim, result.receipt);
  else if (result.kind === 'blocked') settled = await store.block(claim, result.reason);
  else {
    const backoff = Math.min(60000, 1000 * 2 ** Math.min(6, claim.attempt - 1));
    settled = await store.retry(claim, Math.max(backoff, result.retryAfterMs ?? 0));
  }
  // Async-port staleness yields an idle poll. Legacy callers retain true after
  // a POST even if settlement is stale. Storage failures still escape unchanged.
  return isPort ? settled : true;
}
