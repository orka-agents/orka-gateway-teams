import { validateOutcome, validateScope } from '../delivery/identity.js';
import type { BeginDeliveryResult, DeliveryClaim, DeliveryOutcome } from '../delivery/types.js';
import { validateRoute } from '../ingress/codec.js';
import type { ReplyRoute } from '../ingress/types.js';
import type { DeliveryRequest } from '../protocol/types.js';
import { formatDelivery } from '../teams/format.js';
import type { OutgoingTeamsMessage } from '../teams/format.js';
import type { DeliveryContext, DeliveryDispatcher, DeliveryResponse, DispatcherOptions } from './types.js';
import { snapshotDelivery } from './validate.js';

const retryable: DeliveryResponse = Object.freeze({ status: 'retryableError', message: 'Delivery is temporarily unavailable.' });
const nonRetryable: DeliveryResponse = Object.freeze({ status: 'nonRetryableError', message: 'Delivery cannot be completed safely.' });

export function createDeliveryDispatcher(options: DispatcherOptions): DeliveryDispatcher {
  const { journal, sender, getRoute } = options;
  const scope = validateScope(options.scope);
  const services = new Set(options.serviceUrls); const recipients = new Set(options.recipientIds);
  const work = new Set<Promise<DeliveryResponse>>(); const controllers = new Set<AbortController>();
  let healthy = true; let stopped = false; let stopping: Promise<void> | undefined;

  function settle(claim: DeliveryClaim, outcome: DeliveryOutcome): DeliveryResponse {
    try {
      // Only our fresh claim may transition. Even unchanged is unexpected here:
      // no second settler or late-result repair is part of the dispatcher contract.
      if (journal.settle(claim, outcome) !== 'recorded') { healthy = false; return retryable; }
      return response(outcome);
    } catch { healthy = false; return retryable; }
  }

  async function dispatch(input: Readonly<DeliveryRequest>, signal: AbortSignal, deadline: number): Promise<DeliveryResponse> {
    let request: DeliveryRequest;
    try { request = snapshotDelivery(input, scope); } catch { return nonRetryable; }
    if (stopped || !healthy) return retryable;
    let begun: BeginDeliveryResult;
    try { begun = journal.begin(request); } catch { healthy = false; return retryable; }
    // Durable history is authoritative even after current routing policy changes.
    if (begun.kind !== 'claimed') return response(begun);
    const { claim } = begun;
    let saved: ReplyRoute | undefined;
    try { saved = getRoute(request.replyTarget); }
    catch { healthy = false; settle(claim, { kind: 'retryable' }); return retryable; }
    let route: ReplyRoute; let message: OutgoingTeamsMessage;
    try {
      route = validateRoute(saved);
      if (!services.has(route.serviceUrl) || !recipients.has(route.bot.id) || route.conversation.tenantId !== scope.tenantId ||
          request.accountId !== scope.tenantId || request.contextId !== route.conversation.id || request.threadId) {
        return settle(claim, { kind: 'rejected' });
      }
      message = formatDelivery(request);
    } catch { return settle(claim, { kind: 'rejected' }); }
    // The budget starts before snapshot/SQLite/formatting. Do not rely solely
    // on a timer getting a turn after potentially blocking synchronous work.
    if (stopped || !healthy || signal.aborted || !Number.isFinite(deadline) || performance.now() >= deadline) {
      return settle(claim, { kind: 'retryable' });
    }
    let outcome: DeliveryOutcome;
    try { outcome = validateOutcome(await sender.send(route, message, { signal, deadline })); }
    catch { outcome = { kind: 'unknown' }; }
    // A confirmed receipt is not discarded because the caller disconnected.
    // It still must be durably settled before any delivered response escapes.
    return settle(claim, outcome);
  }

  return {
    get healthy() { return healthy; },
    deliver(request, context: DeliveryContext = {}) {
      const deadline = Math.min(performance.now() + 9000, context.deadline ?? Infinity);
      const controller = new AbortController(); controllers.add(controller);
      const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
      let resolve!: (value: DeliveryResponse) => void;
      const pending = new Promise<DeliveryResponse>((done) => { resolve = done; });
      // Register before synchronous callbacks; dispatch takes its deep snapshot
      // and begins the journal synchronously, before the first provider await.
      work.add(pending);
      void dispatch(request, signal, deadline).then(resolve, () => { healthy = false; resolve(retryable); });
      void pending.then(() => { work.delete(pending); controllers.delete(controller); });
      return pending;
    },
    stop() {
      if (!stopping) {
        stopped = true;
        for (const controller of controllers) controller.abort();
        stopping = (async () => { await Promise.all([Promise.all(work), sender.stop()]); })();
      }
      return stopping;
    },
  };
}

function response(outcome: Exclude<BeginDeliveryResult, { kind: 'claimed' }> | DeliveryOutcome): DeliveryResponse {
  if (outcome.kind === 'delivered') return { status: 'delivered', providerMessageId: outcome.providerMessageId };
  return outcome.kind === 'inFlight' || outcome.kind === 'retryable' ? retryable : nonRetryable;
}
