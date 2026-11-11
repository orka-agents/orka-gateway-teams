import { setTimeout as sleep } from 'node:timers/promises';
import { prepareStorageIdentity } from '../auth/storage-identity.js';
import { createTableDeliveryJournalV3 } from '../delivery/table-journal.js';
import { createOrkaClient } from '../ingress/client.js';
import { ConfigurationError, tlsVerificationEnabled } from '../ingress/config.js';
import type { IngressRuntime, IngressRuntimeDependencies } from '../ingress/main.js';
import { relayOne } from '../ingress/relay.js';
import { LeaseRuntimeFailure, readCaBundle } from '../ingress/runtime-shared.js';
import type { Receiver } from '../ingress/server.js';
import { prepareReceiver } from '../ingress/server.js';
import { createTableIngressStoreV3 } from '../ingress/table-store.js';
import type { OutboundServer } from '../outbound/server.js';
import { startTargetOutboundServer } from '../outbound/server.js';
import type { LeaseAuthority } from '../storage/table/types.js';
import type { RegistryConfig } from './config.js';
import { snapshotRegistry } from './config.js';

export async function startRegistryRuntime(input: RegistryConfig, dependencies: IngressRuntimeDependencies = {}, signal?: AbortSignal): Promise<IngressRuntime> {
  const config = snapshotRegistry(input); const deps = { ...dependencies };
  if (!tlsVerificationEnabled() || deps.openIngressStore !== undefined || deps.openDeliveryJournal !== undefined) throw new ConfigurationError();
  if (signal?.aborted) throw new Error('Registry startup cancelled');
  const legacy = config.targets.find(t => t.id === config.legacyTargetId)!;
  const prepared = prepareReceiver(legacy.config.receiver, deps);
  const abort = new AbortController(); const loss = new AbortController(); const authorities: LeaseAuthority[] = [];
  const subscriptions: (() => void)[] = []; const handles: { open(): Promise<unknown>; close(): Promise<unknown> }[] = [];
  let ready = false; let fatal = false; let opening = true; let receiver: Receiver | undefined; let api: OutboundServer | undefined;
  let stopRuntime: (() => Promise<void>) | undefined; let closing: Promise<void> | undefined;
  const authority: LeaseAuthority = {
    allowed: () => !loss.signal.aborted && !abort.signal.aborted && authorities.every(a => a.allowed()),
    revalidate: async () => { for (const a of authorities) if (!await a.revalidate()) return false; return authority.allowed(); }, lost: loss.signal,
  };
  const clients = config.targets.map(t => createOrkaClient(t.config.scope, { bearerToken: t.config.bearerToken, authority,
    ...(t.config.caFile === undefined ? {} : { ca: readCaBundle(t.config.caFile) }) }));
  const provider = prepareStorageIdentity(legacy.config.storage.identity).createProvider(deps.storageIdentity);
  const unsubscribe = () => { for (const remove of subscriptions.splice(0)) remove(); };
  const closeStores = async () => {
    unsubscribe(); const results = await Promise.allSettled(handles.map(h => Promise.resolve().then(() => h.close())));
    results.push(...await Promise.allSettled([Promise.resolve().then(() => provider.close())])); return results;
  };
  const cancel = () => {
    ready = false; abort.abort();
    if (stopRuntime) void stopRuntime().catch(() => {});
    else if (opening) {
      // Cancel foreign-lease waits only during store opening. Listener/SDK startup
      // must unwind and drain before catch releases any store.
      setImmediate(() => { if (!stopRuntime && opening) { unsubscribe(); for (const h of handles) void Promise.resolve().then(() => h.close()).catch(() => {}); } });
    }
  };
  const lost = () => { fatal = true; loss.abort(); cancel(); };
  const subscribe = (a: LeaseAuthority) => {
    authorities.push(a); a.lost.addEventListener('abort', lost, { once: true }); subscriptions.push(() => a.lost.removeEventListener('abort', lost));
    if (a.lost.aborted) lost();
  };
  const assertStarting = () => { if (abort.signal.aborted || signal?.aborted) throw new Error('Registry startup cancelled'); };
  const active = () => ready && authority.allowed();
  signal?.addEventListener('abort', cancel, { once: true });
  const slots: { target: typeof legacy; inbox: ReturnType<typeof createTableIngressStoreV3>; journal: ReturnType<typeof createTableDeliveryJournalV3> }[] = [];
  try {
    for (const target of config.targets) {
      const c = target.config; const s = c.storage;
      const native = { token: provider.token, ...(deps.tableRequest === undefined ? {} : { request: deps.tableRequest }),
        ...(deps.tableLeaseClock === undefined ? {} : { leaseClock: deps.tableLeaseClock }) };
      const inbox = createTableIngressStoreV3({ kind: 'ingress', account: s.account, table: s.table, storeId: s.ingressStoreId, scope: c.scope }, native,
        { audit: s.audit, maxIndexBytes: s.maxIndexBytes, policy: c.policy });
      handles.push(inbox); subscribe(inbox.leaseAuthority());
      const journal = createTableDeliveryJournalV3({ kind: 'delivery', account: s.account, table: s.table, storeId: s.deliveryStoreId!,
        scope: { appId: c.scope.appId, tenantId: c.scope.tenantId } }, native);
      handles.push(journal); subscribe(journal.leaseAuthority()); slots.push({ target, inbox, journal });
    }
    // Every handle is retained and subscribed before the first ownership await.
    for (const h of handles) { assertStarting(); await h.open(); assertStarting(); }
    opening = false;
    const admission = slots.find(s => s.target.id === config.legacyTargetId)!.inbox;
    receiver = await prepared.start({ scope: admission.scope, admit: (event, route) => active() ? admission.admit(event, route) : { kind: 'full' } },
      { targets: slots.map(s => ({ id: s.target.id, journal: s.journal, correlation: s.journal, authority,
        getRoute: key => s.inbox.getRoute(key),
        ...(s.target.config.outbound!.interimDelivery === undefined ? {} : { interimDelivery: s.target.config.outbound!.interimDelivery }),
        ...(s.target.config.outbound!.meetingDrafts === undefined ? {} : { meetingDrafts: s.target.config.outbound!.meetingDrafts }) })) }, abort.signal);
    assertStarting();
    api = await startTargetOutboundServer(legacy.config.outbound!, slots.map(s => ({
      ...s.target.config.outbound!, prefix: s.target.id === config.legacyTargetId ? '' : `/targets/${s.target.id}`,
      dispatcher: receiver!.outbounds!.get(s.target.id)!, scope: { appId: s.target.config.scope.appId, tenantId: s.target.config.scope.tenantId },
    })), active);
    assertStarting(); if (!authority.allowed()) throw new Error('Registry authority lost'); ready = true;
  } catch {
    ready = false; abort.abort();
    await Promise.allSettled([api?.stop(), receiver?.stop()]); await closeStores(); signal?.removeEventListener('abort', cancel);
    throw new LeaseRuntimeFailure(loss.signal.aborted ? 'lease-authority-lost' : 'lease-transition-uncertain');
  }
  let resolveDone!: () => void; let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }); void done.catch(() => {});
  const relays = slots.map((s, i) => (async () => {
    try {
      while (!abort.signal.aborted) {
        if (!await relayOne(s.inbox, clients[i]!, abort.signal, active)) {
          try { await sleep(100, undefined, { signal: abort.signal }); }
          catch { if (!abort.signal.aborted) throw new Error('Relay scheduling failed'); }
        }
      }
    } catch { fatal = true; cancel(); }
  })());
  const stop = (): Promise<void> => closing ??= (async () => {
    ready = false; abort.abort();
    const drained = await Promise.allSettled([api!.stop(), receiver!.stop(), ...relays]);
    const closed = await closeStores(); signal?.removeEventListener('abort', cancel);
    if (fatal || [...drained, ...closed].some(r => r.status === 'rejected')) {
      const error = new LeaseRuntimeFailure(loss.signal.aborted ? 'lease-authority-lost' : 'lease-transition-uncertain'); rejectDone(error); throw error;
    }
    resolveDone();
  })();
  stopRuntime = stop;
  void receiver.failed.catch(() => { fatal = true; cancel(); }); void api.failed.catch(() => { fatal = true; cancel(); });
  if (abort.signal.aborted) void stop().catch(() => {});
  return { port: receiver.port, outboundPort: api.port, done, stop };
}
