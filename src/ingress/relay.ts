import type { ForwardRetry, IngressClaim, IngressPort, IngressStore, OrkaClient, OrkaPostPreparation, OrkaPostResult } from './types.js';
import { reasonCode } from './types.js';

/** One persisted attempt, one POST, one fenced settlement. Composition owns serialization and shutdown/drain.
 * `preflight` answers true, or false or a fixed reason code for a refusal. `report` hears every attempt put back. */
export async function relayOne(store: IngressStore | IngressPort, client: OrkaClient, signal?: AbortSignal,
  isReady: () => boolean = () => true, preflight?: (claim: Readonly<IngressClaim>, signal?: AbortSignal) => Promise<boolean | string>,
  report?: (retry: Readonly<ForwardRetry>) => void): Promise<boolean> {
  const active = () => !signal?.aborted && isReady();
  if (!active()) return false;
  const isPort = 'claimForForwarding' in store;
  if (!isPort && client.prepare) throw new Error('Async ingress requires forwarding permission');
  let claim: Readonly<IngressClaim>; let refused: string | undefined; let preparation: OrkaPostPreparation | undefined;
  // A line that cannot be written must not change what happens to the event.
  const tell = (retry: ForwardRetry) => { try { report?.(retry); } catch { /* Logged nothing. */ } };
  const prepare = async (): Promise<OrkaPostPreparation> => {
    try { return await client.prepare!(claim.event, signal); }
    catch (error) { return { kind: 'retry', reason: reasonCode(error) }; }
  };
  if (isPort) {
    const grant = await store.claimForForwarding();
    if (!grant) return false;
    try {
      claim = structuredClone(grant.claim);
      const checked = preflight ? await preflight(claim, signal) : true;
      if (checked !== true) refused = checked || 'refused';
      if (refused === undefined && client.prepare) preparation = await prepare();
      if (refused === undefined && (!preparation || preparation.kind === 'ready')) {
        // Reconciliation may have outlived cancellation, expiry or quarantine.
        // No await is allowed between the owner's final take and client handoff.
        // The inbox withdraws a refused attempt itself: put back, or blocked when the event's replay window
        // has passed. No settlement follows below, so this is the only line that attempt gets.
        const taken = active() && await grant.revalidate() && active() && grant.take();
        if (!taken || !active()) { tell({ stage: 'inbox', reason: active() ? 'not-eligible' : 'cancelled', attempt: claim.attempt }); return false; }
      }
    } finally { grant.retire(); }
  } else {
    // Compatibility is deliberately synchronous, not Promise<legacy claim>:
    // asynchronous stores must implement the mandatory owner-local handoff.
    const legacy = store.claim();
    if (!legacy) return false;
    if ('then' in legacy) throw new Error('Async ingress requires forwarding permission');
    claim = legacy;
    if (!active()) return false;
  }
  let result: OrkaPostResult; let stage: ForwardRetry['stage'] = 'post';
  if (refused !== undefined) { result = { kind: 'retry', reason: refused }; stage = 'check'; }
  else if (preparation && preparation.kind !== 'ready') { result = preparation; stage = 'grant'; }
  else {
    try { result = await client.post(claim.event, signal, preparation); }
    catch (error) { result = { kind: 'retry', reason: reasonCode(error) }; }
  }
  if (signal?.aborted && result.kind !== 'retry') result = { kind: 'retry', reason: 'cancelled' };
  let settled: boolean;
  if (result.kind === 'receipt') settled = await store.complete(claim, result.receipt);
  else if (result.kind === 'blocked') settled = await store.block(claim, result.reason);
  else {
    const backoff = Math.min(60000, 1000 * 2 ** Math.min(6, claim.attempt - 1));
    const delayMs = Math.max(backoff, result.retryAfterMs ?? 0);
    tell({ stage, reason: result.reason ?? 'unknown', attempt: claim.attempt, delayMs });
    settled = await store.retry(claim, delayMs);
  }
  // Async-port staleness yields an idle poll. Legacy callers retain true after
  // a POST even if settlement is stale. Storage failures still escape unchanged.
  return isPort ? settled : true;
}
