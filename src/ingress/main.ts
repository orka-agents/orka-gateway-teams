import { lstatSync } from 'node:fs';
import { LeaseRuntimeFailure, readCaBundle } from './runtime-shared.js';
import { parseRegistryConfig } from '../registry/config.js';
import { startRegistryRuntime } from '../registry/runtime.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertCaSeparation, ConfigurationError, parseCorrelationConfig, tlsVerificationEnabled, validateOutboundConfig, validateReceiverConfig } from './config.js';
import { parseRuntimeConfig, parseTableUpgradeConfig, parseTableRecoveryConfig, snapshotTableInitConfig, snapshotTableServeConfig } from './runtime-config.js';
import type { RuntimeServeConfig, TableInitConfig, TableRecoveryConfig, TableUpgradeConfig } from './runtime-config.js';
import { prepareStorageIdentity } from '../auth/storage-identity.js';
import type { StorageIdentityDependencies, StorageTokenProvider } from '../auth/storage-identity.js';
import type { LeaseAuthority, TableLeaseDependencies, TableDependencies } from '../storage/table/types.js';
import { createTableIngressStore, createTableIngressStoreV3 } from './table-store.js';
import { reclaimTableIngress, reclaimTableIngressV3 } from './table-recovery.js';
import { reclaimTableDeliveryOperatorV2, reclaimTableDeliveryOperatorV3 } from '../delivery/table-recovery.js';
import { createTableKernelV2, createTableKernelV3 } from '../storage/table/owner.js';
import { upgradeTableIngressV2, upgradeTableDeliveryV2 } from '../storage/table/upgrade.js';
import { TableRecoveryUncertainError } from '../storage/table/recovery.js';
import { hex, integer, uuid } from '../storage/table/codec.js';
import type { ForeignOwnerFenceV2, TableBinding } from '../storage/table/types.js';
import { createTableDeliveryJournalV2, createTableDeliveryJournalV3, TableDeliveryStartupFailure } from '../delivery/table-journal.js';
import { auditConfig, auditFields } from '../storage/table/audit.js';
import type { ServeConfig } from './config.js';
import { logIngress, startProcessMemoryDiagnostics } from './logger.js';
import { createOrkaClient } from './client.js';
import { createIngressPort, initializeIngressStore, openIngressStore } from './store.js';
import type { IngressPort, IngressScope, StoreOptions } from './types.js';
import { relayOne } from './relay.js';
import { prepareReceiver } from './server.js';
import { assertCredentialSeparation } from '../auth/certificate.js';
import type { Receiver, ReceiverDependencies } from './server.js';
import { initializeDeliveryJournal, openDeliveryJournal } from '../delivery/journal.js';
import { initializeSessionCorrelation, openSessionCorrelation } from '../delivery/sqlite-session-correlation.js';
import type { SQLiteSessionCorrelation } from '../delivery/sqlite-session-correlation.js';
import type { SessionCorrelationPort } from '../delivery/session-correlation.js';
import { DeliveryJournalError } from '../delivery/types.js';
import type { DeliveryJournalPort, JournalScope } from '../delivery/types.js';
import { TableError } from '../storage/table/types.js';
import { startOutboundServer } from '../outbound/server.js';
import type { OutboundServer } from '../outbound/server.js';

export interface IngressRuntime { port: number; done: Promise<void>; stop(): Promise<void>; outboundPort?: number }
export type RecoveryReason = 'owner-or-epoch-mismatch' | 'already-unowned' | 'audit-or-storage-failed' | 'outcome-uncertain' | 'cancelled';
export class RecoveryFailure extends Error {
  constructor(readonly reason: RecoveryReason) { super(`operator-recovery-failed: ${reason}`); }
}
export type StartupCategory = 'lease-owned-busy' | 'lease-authority-lost' | 'lease-transition-uncertain' | 'lease-format-unsupported' | 'store-open-failed' | 'store-owned-requires-operator-recovery' | 'listener-failed' | 'startup-failed' | 'startup-cleanup-failed';
export type StartupReason = 'missing' | 'occupied' | 'corrupt' | 'incomplete' | 'unresolved' | 'unavailable' | 'cancelled' | 'ingress' | 'outbound';
export class StartupFailure extends Error {
  cleanupFailed = false;
  constructor(readonly category: StartupCategory, readonly reason: StartupReason, readonly store?: 'ingress' | 'delivery' | 'correlation') {
    super(`${category}: ${reason}`);
  }
}
function openFailure(error: unknown, store: 'ingress' | 'delivery' | 'correlation', table: boolean, v3 = false): StartupFailure {
  const code = error instanceof TableError || error instanceof DeliveryJournalError ? error.code : undefined;
  if (table && code === 'busy') return new StartupFailure(v3 ? 'lease-owned-busy' : 'store-owned-requires-operator-recovery', 'occupied', store);
  const reason = store === 'correlation' && code === 'busy' ? 'occupied' : error instanceof TableDeliveryStartupFailure ? error.startupReason :
    code === 'missing' || code === 'corrupt' || code === 'incomplete' || code === 'unresolved' ? code : 'unavailable';
  return new StartupFailure(v3 && code === 'corrupt' ? 'lease-format-unsupported' : v3 && code === 'unresolved' ? 'lease-transition-uncertain' : 'store-open-failed', reason, store);
}
/** Trusted native seams; legacy opening hooks remain SQLite-only. */
export interface IngressRuntimeDependencies extends ReceiverDependencies {
  openIngressStore?: (path: string, scope: Readonly<IngressScope>, options: StoreOptions) => IngressPort | Promise<IngressPort>;
  openDeliveryJournal?: (path: string, scope: Readonly<JournalScope>) => DeliveryJournalPort | Promise<DeliveryJournalPort>;
  tableRequest?: TableDependencies['request'];
  tableLeaseClock?: TableLeaseDependencies['leaseClock'];
  storageIdentity?: StorageIdentityDependencies;
}
export async function startIngressRuntime(config: RuntimeServeConfig, dependencies: IngressRuntimeDependencies = {}, signal?: AbortSignal): Promise<IngressRuntime> {
  if (!tlsVerificationEnabled()) throw new ConfigurationError();
  const table = 'storage' in config ? snapshotTableServeConfig(config) : undefined;
  const sqlite = table === undefined ? config as ServeConfig : undefined;
  const selected = table ?? sqlite!;
  const receiverConfig = table?.receiver ?? validateReceiverConfig(selected.receiver);
  const sqliteOutbound = sqlite?.outbound === undefined ? undefined : validateOutboundConfig(sqlite.outbound, sqlite.dbPath, sqlite.bearerToken, receiverConfig);
  const outbound = table?.outbound ?? sqliteOutbound;
  const caFile = selected.caFile;
  try {
    const correlationPaths = sqliteOutbound?.correlationDbPath === undefined ? [] :
      [sqliteOutbound.correlationDbPath, `${sqliteOutbound.correlationDbPath}.owner.sqlite`];
    const databases = sqlite === undefined ? [] : [sqlite.dbPath,
      ...(sqliteOutbound ? [sqliteOutbound.dbPath, `${sqliteOutbound.dbPath}.owner.sqlite`] : []), ...correlationPaths];
    const paths = databases.flatMap((path) => [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]);
    assertCaSeparation(caFile, paths);
    assertCredentialSeparation(receiverConfig, paths);
  } catch { throw new ConfigurationError(); }
  if (signal?.aborted) throw new StartupFailure('startup-failed', 'cancelled');
  // Snapshot before any opening await; credentials and CA are prepared before
  // ownership, so neither can be reread through a live SQLite inode.
  const dbPath = sqlite?.dbPath; const scope = { ...selected.scope }; const policy = { ...selected.policy };
  const deps = { ...dependencies };
  if (table && (deps.openIngressStore !== undefined || deps.openDeliveryJournal !== undefined)) throw new ConfigurationError();
  const prepared = prepareReceiver(receiverConfig, deps);
  const authorities: LeaseAuthority[] = []; const authorityLoss = new AbortController();
  const authority: LeaseAuthority | undefined = table?.storage.backend === 'table-v3' ? {
    allowed: () => !authorityLoss.signal.aborted && authorities.every(a => a.allowed()),
    revalidate: async () => {
      for (const a of authorities) if (!await a.revalidate()) return false;
      return authority!.allowed();
    }, lost: authorityLoss.signal,
  } : undefined;
  const client = createOrkaClient(scope, { bearerToken: selected.bearerToken,
    ...(authority === undefined ? {} : { authority }),
    ...(caFile === undefined ? {} : { ca: readCaBundle(caFile) }) });
  const storageProvider = table === undefined ? undefined : prepareTableProvider(table.storage.identity, deps);
  const abort = new AbortController(); let fatal = false; let closing: Promise<void> | undefined;
  let ready = false; let stopRuntime: (() => Promise<void>) | undefined;
  const cancel = () => {
    ready = false; abort.abort();
    if (stopRuntime) void stopRuntime().catch(() => {});
    else if (authority && (signal?.aborted || (phase === 'delivery-store' && authorities[0]?.lost.aborted && !authorities[1]?.lost.aborted))) {
      // open() may be in the cancellable foreign-lease wait. Retained handles
      // cancel that wait and drain their own startup; catch still owns cleanup.
      setImmediate(() => {
        if (phase === 'ingress-store' || phase === 'delivery-store') {
          void Promise.resolve().then(() => store?.close()).catch(() => {});
          void Promise.resolve().then(() => journal?.close()).catch(() => {});
        }
      });
    }
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const lost = () => { fatal = true; authorityLoss.abort(); cancel(); };
  const subscriptions: (() => void)[] = [];
  const subscribe = (a: LeaseAuthority) => {
    authorities.push(a); a.lost.addEventListener('abort', lost, { once: true });
    subscriptions.push(() => a.lost.removeEventListener('abort', lost));
    if (a.lost.aborted) lost();
  };
  const active = () => ready && !abort.signal.aborted && (authority?.allowed() ?? true);
  const assertStarting = () => { if (signal?.aborted || abort.signal.aborted) throw new Error('Ingress startup failed'); };
  let store: IngressPort | undefined; let journal: DeliveryJournalPort | undefined;
  let correlation: SessionCorrelationPort | undefined; let sidecar: SQLiteSessionCorrelation | undefined;
  let receiver: Receiver | undefined; let api: OutboundServer | undefined;
  const closeStores = async () => {
    for (const unsubscribe of subscriptions) unsubscribe();
    const stores = await Promise.allSettled([
      Promise.resolve().then(() => sidecar?.close()),
      Promise.resolve().then(() => journal?.close()), Promise.resolve().then(() => store?.close()),
    ]);
    // Release/reconciliation may need a fresh token even after either store fails.
    const provider = await Promise.allSettled([Promise.resolve().then(() => storageProvider?.close())]);
    return [...stores, ...provider];
  };
  let phase: 'correlation-store' | 'ingress-store' | 'delivery-store' | 'ingress-listener' | 'outbound-listener' | 'startup' = 'startup';
  try {
    assertStarting();
    if (table) {
      const storage = table.storage;
      const native: TableLeaseDependencies = { token: storageProvider!.token, ...(deps.tableRequest === undefined ? {} : { request: deps.tableRequest }),
        ...(deps.tableLeaseClock === undefined ? {} : { leaseClock: deps.tableLeaseClock }) };
      const v3 = storage.backend === 'table-v3';
      const inbox = (v3 ? createTableIngressStoreV3 : createTableIngressStore)({ kind: 'ingress', account: storage.account, table: storage.table,
        storeId: storage.ingressStoreId, scope }, native, { audit: storage.audit, maxIndexBytes: storage.maxIndexBytes, policy });
      store = inbox;
      // Retain each actual handle immediately. BOTH constructions precede ANY open await.
      const delivery = outbound === undefined ? undefined : (v3 ? createTableDeliveryJournalV3 : createTableDeliveryJournalV2)({ kind: 'delivery', account: storage.account,
        table: storage.table, storeId: storage.deliveryStoreId!, scope: { appId: scope.appId, tenantId: scope.tenantId } }, native);
      journal = delivery; correlation = delivery;
      // Subscribe both domains before either open can acquire, audit or lose authority.
      if (v3) { subscribe(inbox.leaseAuthority()); if (delivery) subscribe(delivery.leaseAuthority()); }
      phase = 'ingress-store'; await inbox.open(); phase = 'startup'; assertStarting();
      if (delivery) { phase = 'delivery-store'; await delivery.open(); phase = 'startup'; }
    } else {
      // Only absence of the configured main file is no evidence. If it exists,
      // missing ownership/schema, corruption, foreign scope or busy is fatal.
      // Metadata-only preflight/open precedes any inbox/journal ownership.
      if (sqliteOutbound?.correlationDbPath !== undefined) {
        phase = 'correlation-store';
        if (lstatSync(sqliteOutbound.correlationDbPath, { throwIfNoEntry: false })) {
          sidecar = openSessionCorrelation(sqliteOutbound.correlationDbPath, { appId: scope.appId, tenantId: scope.tenantId });
          correlation = sidecar;
        }
        phase = 'startup'; assertStarting();
      }
      phase = 'ingress-store';
      store = await (deps.openIngressStore ?? ((path, target, options) => createIngressPort(openIngressStore(path, target, options))))(dbPath!, scope, { policy });
      phase = 'startup'; assertStarting();
      if (sqliteOutbound) {
        phase = 'delivery-store'; journal = await (deps.openDeliveryJournal ?? openDeliveryJournal)(sqliteOutbound.dbPath,
          { appId: store.scope.appId, tenantId: store.scope.tenantId }); phase = 'startup';
      }
    }
    const ownedStore = store;
    const journalScope = { appId: ownedStore.scope.appId, tenantId: ownedStore.scope.tenantId };
    // Both complete domain audits precede either listener. Never reopen the inbox for routes.
    assertStarting();
    phase = 'ingress-listener';
    receiver = await prepared.start({ scope: ownedStore.scope,
      admit: (event, route) => active() ? ownedStore.admit(event, route) : { kind: 'full' } },
      journal === undefined ? undefined : { journal, ...(authority === undefined ? {} : { authority }), getRoute: (key) => ownedStore.getRoute(key),
        ...(outbound?.interimDelivery === undefined ? {} : { interimDelivery: outbound.interimDelivery }),
        ...(outbound?.meetingDrafts === undefined ? {} : { meetingDrafts: outbound.meetingDrafts }),
        ...(correlation === undefined ? {} : { correlation }) }, abort.signal);
    phase = 'startup'; assertStarting();
    if (outbound) { phase = 'outbound-listener'; api = await startOutboundServer(outbound, receiver.outbound!, journalScope, active); }
    phase = 'startup'; assertStarting();
    if (authority && !authority.allowed()) throw new Error('Ingress startup failed');
    ready = true;
  } catch (error) {
    const storeFailure = phase === 'ingress-store' || phase === 'delivery-store' || phase === 'correlation-store' ?
      openFailure(error, phase === 'ingress-store' ? 'ingress' : phase === 'delivery-store' ? 'delivery' : 'correlation', table !== undefined, table?.storage.backend === 'table-v3') : undefined;
    const failure = storeFailure && ['corrupt', 'unresolved', 'incomplete'].includes(storeFailure.reason) ? storeFailure :
      signal?.aborted ? new StartupFailure('startup-failed', 'cancelled') : storeFailure ??
      (phase === 'ingress-listener' || phase === 'outbound-listener' ?
        new StartupFailure('listener-failed', phase === 'ingress-listener' ? 'ingress' : 'outbound') :
        new StartupFailure(authorityLoss.signal.aborted ? 'lease-authority-lost' : 'startup-failed', 'unavailable'));
    ready = false; abort.abort();
    // Late open/initialize work reaches here only after it actually completes.
    const listeners = await Promise.allSettled([api?.stop(), receiver?.stop()]);
    const stores = await closeStores(); signal?.removeEventListener('abort', cancel);
    failure.cleanupFailed = [...listeners, ...stores].some(result => result.status === 'rejected');
    throw failure;
  }
  const ownedReceiver = receiver; const ownedStore = store;
  let resolveDone!: () => void; let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => {});
  const relay = (async () => {
    try {
      while (!abort.signal.aborted) {
        if (!await relayOne(ownedStore, client, abort.signal, active)) {
          try { await sleep(100, undefined, { signal: abort.signal }); }
          catch { if (!abort.signal.aborted) throw new Error('Relay scheduling failed'); }
        }
      }
    } catch { fatal = true; abort.abort(); }
  })();

  function stop(): Promise<void> {
    closing ??= (async () => {
      ready = false; abort.abort();
      // HTTP intake, SDK/token/provider work and BOTH directions' settlement drain before either handle closes.
      const settled = await Promise.allSettled([api?.stop(), ownedReceiver.stop(), relay]);
      if (settled.some((result) => result.status === 'rejected')) fatal = true;
      const closed = await closeStores();
      if (closed.some((result) => result.status === 'rejected')) fatal = true;
      signal?.removeEventListener('abort', cancel);
      if (fatal) {
        const error = authority ? new LeaseRuntimeFailure(authorityLoss.signal.aborted ? 'lease-authority-lost' : 'lease-transition-uncertain') :
          new Error('Ingress storage failed');
        rejectDone(error); throw error;
      }
      resolveDone();
    })();
    return closing;
  }
  stopRuntime = stop;
  void ownedReceiver.failed.catch(() => { fatal = true; void stop().catch(() => {}); });
  void api?.failed.catch(() => { fatal = true; void stop().catch(() => {}); });
  // A synchronous first claim can signal cancellation before stopRuntime is set.
  void relay.then(() => { if (fatal || abort.signal.aborted) void stop().catch(() => {}); });
  return { port: ownedReceiver.port, done, stop, ...(api === undefined ? {} : { outboundPort: api.port }) };
}

/** Explicit retained initializer, also used by the async CLI; never invoked by serve. */
export async function initializeTableStore(config: TableInitConfig,
  dependencies: Pick<IngressRuntimeDependencies, 'tableRequest' | 'storageIdentity'> = {}, signal?: AbortSignal): Promise<void> {
  const selected = snapshotTableInitConfig(config);
  if (signal?.aborted) throw new Error('Table initialization failed');
  let deps: Pick<IngressRuntimeDependencies, 'tableRequest' | 'storageIdentity'>;
  let provider: StorageTokenProvider;
  try {
    deps = auditFields(dependencies, ['tableRequest', 'storageIdentity']);
    provider = prepareTableProvider(selected.storage.identity, deps);
  } catch { throw new ConfigurationError(); }
  let handle: { initialize(): Promise<void>; close(): Promise<void> } | undefined;
  let failed = false;
  try {
    const { account, table, storeId } = selected.storage;
    const native: TableDependencies = { token: provider.token, ...(deps.tableRequest === undefined ? {} : { request: deps.tableRequest }) };
    const v3 = selected.storage.backend === 'table-v3';
    handle = selected.kind === 'ingress' ? (v3 ? createTableIngressStoreV3 : createTableIngressStore)({ kind: 'ingress', account, table, storeId, scope: selected.scope },
      native, { audit: selected.audit, maxIndexBytes: selected.maxIndexBytes }) :
      (v3 ? createTableDeliveryJournalV3 : createTableDeliveryJournalV2)({ kind: 'delivery', account, table, storeId,
        scope: { appId: selected.scope.appId, tenantId: selected.scope.tenantId } }, native);
    await handle.initialize();
  } catch { failed = true; }
  const closed = await Promise.allSettled([Promise.resolve().then(() => handle?.close())]);
  const drained = await Promise.allSettled([Promise.resolve().then(() => provider.close())]);
  if (failed || signal?.aborted || [...closed, ...drained].some(result => result.status === 'rejected')) throw new Error('Table initialization failed');
}

/** One explicit, bounded Table V2 operator action; never starts listeners or acquires an ordinary owner. */
export async function reclaimTableStore(config: TableRecoveryConfig,
  dependencies: Pick<IngressRuntimeDependencies, 'tableRequest' | 'storageIdentity'> = {}, signal?: AbortSignal): Promise<void> {
  const selected = snapshotTableInitConfig(config.target);
  let expectedOwner: string; let expectedEpoch: number; let attestation: string; let budget: TableRecoveryConfig['audit'];
  try {
    expectedOwner = uuid(config.expectedOwner); expectedEpoch = integer(config.expectedEpoch, 1, Number.MAX_SAFE_INTEGER);
    attestation = hex(config.attestationDigest);
    const validated = auditConfig<2>({ passes: 2, record() {}, endPass() {}, finalize() {} }, config.audit);
    budget = { maxPages: validated.maxPages, maxPageBytes: validated.maxPageBytes,
      maxDurationMs: validated.maxDurationMs, maxTrackingBytes: validated.maxTrackingBytes };
  } catch { throw new ConfigurationError(); }
  if (signal?.aborted) throw new RecoveryFailure('cancelled');
  const storage = selected.storage;
  const binding: TableBinding = selected.kind === 'ingress' ? { kind: 'ingress', account: storage.account, table: storage.table,
    storeId: storage.storeId, scope: selected.scope } : { kind: 'delivery', account: storage.account, table: storage.table,
    storeId: storage.storeId, scope: { appId: selected.scope.appId, tenantId: selected.scope.tenantId } };
  let deps: Pick<IngressRuntimeDependencies, 'tableRequest' | 'storageIdentity'>;
  let provider: StorageTokenProvider;
  try {
    deps = auditFields(dependencies, ['tableRequest', 'storageIdentity']);
    provider = prepareTableProvider(storage.identity, deps);
  } catch { throw new ConfigurationError(); }
  const native: TableDependencies = { token: provider.token, ...(deps.tableRequest === undefined ? {} : { request: deps.tableRequest }) };
  const v3 = storage.backend === 'table-v3';
  const reader = (v3 ? createTableKernelV3 : createTableKernelV2)(binding, native);
  let failure: unknown;
  try {
    const record = await reader.read('M', { ...(signal ? { signal } : {}) });
    if (!record || record.value.kind !== 'metadata') throw new RecoveryFailure('audit-or-storage-failed');
    const m = record.value;
    if (m.owner === '') throw new RecoveryFailure('already-unowned');
    if (m.owner !== expectedOwner || m.epoch !== expectedEpoch) throw new RecoveryFailure('owner-or-epoch-mismatch');
    const fence: ForeignOwnerFenceV2 = { initId: m.initId, initDigest: m.initDigest, owner: m.owner,
      epoch: m.epoch, mDigest: m.digest, etag: record.etag };
    await reader.close();
    if (selected.kind === 'ingress') await (v3 ? reclaimTableIngressV3 : reclaimTableIngress)(binding, native, fence, budget,
      selected.maxIndexBytes, attestation, signal ? { signal } : undefined);
    else await (v3 ? reclaimTableDeliveryOperatorV3 : reclaimTableDeliveryOperatorV2)(binding, native, fence, budget, attestation, signal ? { signal } : undefined);
  } catch (error) {
    failure = error instanceof RecoveryFailure ? error : new RecoveryFailure(error instanceof TableRecoveryUncertainError ?
      'outcome-uncertain' : signal?.aborted ? 'cancelled' : error instanceof TableError && error.code === 'busy' ?
        'already-unowned' : 'audit-or-storage-failed');
  }
  const drained = await Promise.allSettled([reader.close(), provider.close()]);
  if (drained.some(result => result.status === 'rejected')) throw new RecoveryFailure('outcome-uncertain');
  if (failure) throw failure;
}

/** Explicit, one-partition, owner-empty V2 to V3 transition. Never invoked by serve. */
export async function upgradeTableStore(config: TableUpgradeConfig,
  dependencies: Pick<IngressRuntimeDependencies, 'tableRequest' | 'storageIdentity'> = {}, signal?: AbortSignal): Promise<void> {
  const target = snapshotTableInitConfig(config.target);
  if (target.storage.backend !== 'table-v3') throw new ConfigurationError();
  let attestation: string; let budget: TableUpgradeConfig['audit'];
  try {
    attestation = hex(config.attestationDigest);
    const a = auditConfig<2>({ passes: 2, record() {}, endPass() {}, finalize() {} }, config.audit);
    budget = { maxPages: a.maxPages, maxPageBytes: a.maxPageBytes, maxDurationMs: a.maxDurationMs, maxTrackingBytes: a.maxTrackingBytes };
  } catch { throw new ConfigurationError(); }
  const deps: Pick<IngressRuntimeDependencies, 'tableRequest' | 'storageIdentity'> = auditFields(dependencies, ['tableRequest', 'storageIdentity']);
  const provider = prepareTableProvider(target.storage.identity, deps);
  const { account, table, storeId } = target.storage;
  const binding: TableBinding = { account, table, storeId, ...(target.kind === 'ingress' ? { kind: 'ingress', scope: target.scope } :
    { kind: 'delivery', scope: { appId: target.scope.appId, tenantId: target.scope.tenantId } }) };
  const native: TableDependencies = { token: provider.token, ...(deps.tableRequest === undefined ? {} : { request: deps.tableRequest }) };
  let failure: unknown;
  try {
    if (target.kind === 'ingress') await upgradeTableIngressV2(binding, native, budget, target.maxIndexBytes, attestation, signal ? { signal } : undefined);
    else await upgradeTableDeliveryV2(binding, native, budget, attestation, signal ? { signal } : undefined);
  } catch { failure = new Error('lease-transition-uncertain'); }
  try { await provider.close(); } catch { failure = new Error('lease-transition-uncertain'); }
  if (failure) throw failure;
}

function prepareTableProvider(identity: TableInitConfig['storage']['identity'], dependencies: Pick<IngressRuntimeDependencies, 'tableRequest' | 'storageIdentity'>): StorageTokenProvider {
  try {
    if (dependencies.tableRequest !== undefined && typeof dependencies.tableRequest !== 'function') throw new ConfigurationError();
    const identityDeps = dependencies.storageIdentity === undefined ? {} : auditFields(dependencies.storageIdentity, ['request']);
    return prepareStorageIdentity(identity).createProvider(identityDeps);
  } catch { throw new ConfigurationError(); }
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let runtime: IngressRuntime | undefined; const abort = new AbortController();
  let stopDiagnostics: (() => void) | undefined;
  const shutdown = () => { stopDiagnostics?.(); abort.abort(); if (runtime) void runtime.stop().catch(() => {}); };
  try {
    if (args.length !== 1 || !['init', 'init-delivery', 'init-correlation', 'serve', 'serve-registry', 'recover-ingress', 'recover-delivery', 'upgrade-ingress', 'upgrade-delivery'].includes(args[0]!)) throw new ConfigurationError();
    if (args[0] === 'init-correlation') {
      const config = parseCorrelationConfig(env);
      initializeSessionCorrelation(config.dbPath, config.scope); logIngress('initialized'); return 0;
    }
    if (args[0] === 'upgrade-ingress' || args[0] === 'upgrade-delivery') {
      const config = parseTableUpgradeConfig(env, args[0] === 'upgrade-ingress' ? 'ingress' : 'delivery');
      process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
      try { await upgradeTableStore(config, {}, abort.signal); }
      catch { logIngress('lease-transition-uncertain', undefined, config.target.kind); return 1; }
      logIngress('upgraded', undefined, config.target.kind); return 0;
    }
    if (args[0] === 'recover-ingress' || args[0] === 'recover-delivery') {
      const config = parseTableRecoveryConfig(env, args[0] === 'recover-ingress' ? 'ingress' : 'delivery');
      process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
      await reclaimTableStore(config, {}, abort.signal);
      logIngress('reclaimed', undefined, config.target.kind); return 0;
    }
    if (args[0] === 'init' || args[0] === 'init-delivery') {
      const config = parseRuntimeConfig(env, args[0]);
      if ('storage' in config) {
        process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
        await initializeTableStore(config, {}, abort.signal);
      } else if (args[0] === 'init') initializeIngressStore(config.dbPath, config.scope);
      else initializeDeliveryJournal(config.dbPath, { appId: config.scope.appId, tenantId: config.scope.tenantId });
      logIngress('initialized'); return 0;
    }
    const registry = args[0] === 'serve-registry' ? parseRegistryConfig(env) : undefined;
    const config = registry ? undefined : parseRuntimeConfig(env, 'serve');
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
    // No environment-controlled cloud, JWKS or authentication override enters here.
    runtime = registry ? await startRegistryRuntime(registry, {}, abort.signal) : await startIngressRuntime(config!, {}, abort.signal);
    if (!abort.signal.aborted) { logIngress('listening'); stopDiagnostics = startProcessMemoryDiagnostics(); }
    else shutdown();
    await runtime.done; logIngress('stopped'); return 0;
  } catch (error) {
    if (error instanceof LeaseRuntimeFailure) logIngress(error.category);
    else if (error instanceof RecoveryFailure) logIngress('operator-recovery-failed', error.reason);
    else if (error instanceof StartupFailure) {
      logIngress(error.category, error.reason, error.store);
      if (error.cleanupFailed) logIngress('startup-cleanup-failed', 'unavailable');
    }
    else if (error instanceof ConfigurationError) logIngress('configuration-failed', 'invalid-configuration');
    else if (runtime) logIngress('storage-failed', 'runtime-failure');
    else logIngress('startup-failed', 'unavailable');
    return 1;
  } finally {
    stopDiagnostics?.();
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2), process.env);
}
