import { addAbortListener } from 'node:events';
import { createSessionObservation } from '../delivery/session-correlation.js';
import { validateOutcome, validateScope } from '../delivery/identity.js';
import type { BeginDeliveryResult, DeliveryClaim, DeliveryOutcome } from '../delivery/types.js';
import { validateRoute } from '../ingress/codec.js';
import { ConfigurationError } from '../ingress/config.js';
import type { ReplyRoute } from '../ingress/types.js';
import type { DeliveryRequest } from '../protocol/types.js';
import { formatDelivery } from '../teams/format.js';
import type { OutgoingTeamsMessage } from '../teams/format.js';
import type { DeliveryContext, DeliveryDispatcher, DeliveryResponse, DispatcherOptions } from './types.js';
import { snapshotDelivery } from './validate.js';

const retryable: DeliveryResponse = Object.freeze({ status: 'retryableError', message: 'Delivery is temporarily unavailable.' });
const nonRetryable: DeliveryResponse = Object.freeze({ status: 'nonRetryableError', message: 'Delivery cannot be completed safely.' });

export function createDeliveryDispatcher(options: DispatcherOptions): DeliveryDispatcher {
  const { journal, sender, getRoute, correlation, interimDelivery } = options;
  if (interimDelivery !== undefined && typeof interimDelivery !== 'boolean') throw new ConfigurationError();
  const scope = validateScope(options.scope);
  const services = new Set(options.serviceUrls); const recipients = new Set(options.recipientIds);
  const work = new Set<Promise<DeliveryResponse>>(); const controllers = new Set<AbortController>();
  let healthy = true; let stopped = false; let stopping: Promise<void> | undefined;

  function poison(): void {
    healthy = false;
    for (const controller of controllers) controller.abort();
  }

  async function settle(claim: DeliveryClaim, outcome: DeliveryOutcome, retire: () => void): Promise<DeliveryResponse> {
    // Revoke this attempt's local permission before finalization can queue/await.
    // The sender also fences finished token/provider continuations independently.
    retire();
    try {
      // Only our fresh claim may transition. Even unchanged is unexpected here:
      // no second settler or late-result repair is part of the dispatcher contract.
      if (await journal.settle(claim, outcome) !== 'recorded') { poison(); return retryable; }
      return response(outcome);
    } catch { poison(); return retryable; }
  }

  async function dispatch(input: Readonly<DeliveryRequest>, signal: AbortSignal, deadline: number, retire: () => void): Promise<DeliveryResponse> {
    let request: DeliveryRequest;
    try { request = snapshotDelivery(input, scope); } catch { return nonRetryable; }
    const active = () => !stopped && healthy && !signal.aborted && Number.isFinite(deadline) && performance.now() < deadline;
    if (!active()) return retryable;
    let begun: BeginDeliveryResult;
    try { begun = await journal.begin(request); } catch { poison(); return retryable; }
    // Durable history is authoritative even after current routing policy changes.
    if (begun.kind !== 'claimed') return response(begun);
    const { claim } = begun;
    const finish = (outcome: DeliveryOutcome) => settle(claim, outcome, retire);
    if (!active()) return finish({ kind: 'retryable' });
    // Withdraw new-send permission, never a historical receipt or uncertain claim.
    if (request.kind === 'message' && interimDelivery !== true) return finish({ kind: 'rejected' });
    let saved: ReplyRoute | undefined;
    try { saved = await getRoute(request.replyTarget); }
    catch { poison(); return finish({ kind: 'retryable' }); }
    if (!active()) return finish({ kind: 'retryable' });
    let route: ReplyRoute;
    try {
      route = validateRoute(saved);
      if (!services.has(route.serviceUrl) || !recipients.has(route.bot.id) || route.conversation.tenantId !== scope.tenantId ||
          request.accountId !== scope.tenantId || request.contextId !== route.conversation.id ||
          (route.conversation.conversationType === 'channel' ? request.threadId !== route.threadId : !!request.threadId)) {
        return finish({ kind: 'rejected' });
      }
    } catch { return finish({ kind: 'rejected' }); }
    const shared = route.conversation.conversationType !== 'personal';
    let continuation = false;
    if (shared && correlation) {
      try {
        const observation = createSessionObservation(scope, request);
        if (observation) {
          const result = await correlation.observeSession(observation);
          if (!active()) return finish({ kind: 'retryable' });
          if (result.kind === 'full') return finish({ kind: 'retryable' });
          continuation = result.continuation;
        }
      } catch { poison(); return finish({ kind: 'retryable' }); }
    }
    let message: OutgoingTeamsMessage;
    try {
      message = formatDelivery(request, shared ? {
        ...(route.requester?.displayName === undefined ? {} : { requesterDisplayName: route.requester.displayName }),
        continuation,
        ...(route.conversation.conversationType === 'channel' ? { replyToId: route.threadId } : {}),
      } : undefined);
    } catch { return finish({ kind: 'rejected' }); }
    // The budget starts before snapshot/SQLite/formatting. Do not rely solely
    // on a timer getting a turn after potentially blocking synchronous work.
    if (!active()) return finish({ kind: 'retryable' });
    let outcome: DeliveryOutcome;
    try { outcome = validateOutcome(await sender.send(route, message, { signal, deadline })); }
    catch { outcome = { kind: 'unknown' }; }
    // A confirmed receipt is not discarded because the caller disconnected.
    // It still must be durably settled before any delivered response escapes.
    return finish(outcome);
  }

  return {
    get healthy() { return healthy; },
    deliver(request, context: DeliveryContext = {}) {
      const deadline = Math.min(performance.now() + 9000, context.deadline ?? Infinity);
      const controller = new AbortController(); controllers.add(controller);
      const caller = context.signal;
      // Callers may reuse a long-lived signal. Release its forwarding listener
      // after dispatch/settlement, without weakening stop or retirement fences.
      const forwardCaller = () => controller.abort(caller!.reason);
      if (caller?.aborted) forwardCaller();
      const subscription = caller && !caller.aborted ? addAbortListener(caller, forwardCaller) : undefined;
      let resolve!: (value: DeliveryResponse) => void;
      const pending = new Promise<DeliveryResponse>((done) => { resolve = done; });
      // Register before synchronous callbacks; dispatch takes its deep snapshot
      // before calling the async-compatible journal, not after its first await.
      work.add(pending);
      void dispatch(request, controller.signal, deadline, () => controller.abort())
        .finally(() => subscription?.[Symbol.dispose]()).then(resolve, () => { poison(); resolve(retryable); });
      void pending.then(() => { work.delete(pending); controllers.delete(controller); });
      return pending;
    },
    stop() {
      if (!stopping) {
        stopped = true;
        for (const controller of controllers) controller.abort();
        stopping = (async () => {
          const results = await Promise.allSettled([Promise.all(work), sender.stop()]);
          if (results.some((result) => result.status === 'rejected')) throw new Error('Delivery shutdown failed');
        })();
      }
      return stopping;
    },
  };
}

function response(outcome: Exclude<BeginDeliveryResult, { kind: 'claimed' }> | DeliveryOutcome): DeliveryResponse {
  if (outcome.kind === 'delivered') return { status: 'delivered', providerMessageId: outcome.providerMessageId };
  return outcome.kind === 'inFlight' || outcome.kind === 'retryable' ? retryable : nonRetryable;
}
