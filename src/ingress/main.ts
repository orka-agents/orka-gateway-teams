import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigurationError, tlsVerificationEnabled, validateOutboundConfig, validateReceiverConfig } from './config.js';
import { parseRuntimeConfig, snapshotTableInitConfig, snapshotTableServeConfig } from './runtime-config.js';
import type { RuntimeServeConfig, TableInitConfig } from './runtime-config.js';
import { prepareStorageIdentity } from '../auth/storage-identity.js';
import type { StorageIdentityDependencies, StorageTokenProvider } from '../auth/storage-identity.js';
import type { TableDependencies } from '../storage/table/types.js';
import { createTableIngressStore } from './table-store.js';
import { createTableDeliveryJournalV2 } from '../delivery/table-journal.js';
import { auditFields } from '../storage/table/audit.js';
import type { ServeConfig } from './config.js';
import { logIngress } from './logger.js';
import { createOrkaClient } from './client.js';
import { createIngressPort, initializeIngressStore, openIngressStore } from './store.js';
import type { IngressPort, IngressScope, StoreOptions } from './types.js';
import { relayOne } from './relay.js';
import { prepareReceiver } from './server.js';
import { assertCredentialSeparation } from '../auth/certificate.js';
import type { Receiver, ReceiverDependencies } from './server.js';
import { initializeDeliveryJournal, openDeliveryJournal } from '../delivery/journal.js';
import type { DeliveryJournalPort, JournalScope } from '../delivery/types.js';
import { startOutboundServer } from '../outbound/server.js';
import type { OutboundServer } from '../outbound/server.js';

export interface IngressRuntime { port: number; done: Promise<void>; stop(): Promise<void>; outboundPort?: number }
/** Trusted native seams; legacy opening hooks remain SQLite-only. */
export interface IngressRuntimeDependencies extends ReceiverDependencies {
  openIngressStore?: (path: string, scope: Readonly<IngressScope>, options: StoreOptions) => IngressPort | Promise<IngressPort>;
  openDeliveryJournal?: (path: string, scope: Readonly<JournalScope>) => DeliveryJournalPort | Promise<DeliveryJournalPort>;
  tableRequest?: TableDependencies['request'];
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
  try {
    const databases = sqlite === undefined ? [] : [sqlite.dbPath, ...(sqliteOutbound ? [sqliteOutbound.dbPath, `${sqliteOutbound.dbPath}.owner.sqlite`] : [])];
    assertCredentialSeparation(receiverConfig, databases.flatMap((path) => [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]));
  } catch { throw new ConfigurationError(); }
  if (signal?.aborted) throw new Error('Ingress startup failed');
  // Snapshot before any opening await; credentials and CA are prepared before
  // ownership, so neither can be reread through a live SQLite inode.
  const dbPath = sqlite?.dbPath; const scope = { ...selected.scope }; const policy = { ...selected.policy };
  const deps = { ...dependencies };
  if (table && (deps.openIngressStore !== undefined || deps.openDeliveryJournal !== undefined)) throw new ConfigurationError();
  const prepared = prepareReceiver(receiverConfig, deps);
  const client = createOrkaClient(scope, { bearerToken: selected.bearerToken,
    ...(selected.caFile === undefined ? {} : { ca: readCaBundle(selected.caFile) }) });
  const storageProvider = table === undefined ? undefined : prepareTableProvider(table.storage.identity, deps);
  const abort = new AbortController(); let fatal = false; let closing: Promise<void> | undefined;
  let ready = false; let stopRuntime: (() => Promise<void>) | undefined;
  const cancel = () => { ready = false; abort.abort(); void stopRuntime?.().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const assertStarting = () => { if (signal?.aborted || abort.signal.aborted) throw new Error('Ingress startup failed'); };
  let store: IngressPort | undefined; let journal: DeliveryJournalPort | undefined;
  let receiver: Receiver | undefined; let api: OutboundServer | undefined;
  const closeStores = async () => {
    const stores = await Promise.allSettled([
      Promise.resolve().then(() => journal?.close()), Promise.resolve().then(() => store?.close()),
    ]);
    // Release/reconciliation may need a fresh token even after either store fails.
    const provider = await Promise.allSettled([Promise.resolve().then(() => storageProvider?.close())]);
    return [...stores, ...provider];
  };
  try {
    assertStarting();
    if (table) {
      const storage = table.storage;
      const native: TableDependencies = { token: storageProvider!.token, ...(deps.tableRequest === undefined ? {} : { request: deps.tableRequest }) };
      const inbox = createTableIngressStore({ kind: 'ingress', account: storage.account, table: storage.table,
        storeId: storage.ingressStoreId, scope }, native, { audit: storage.audit, maxIndexBytes: storage.maxIndexBytes, policy });
      store = inbox;
      // Retain each actual handle immediately. BOTH constructions precede ANY open await.
      const delivery = outbound === undefined ? undefined : createTableDeliveryJournalV2({ kind: 'delivery', account: storage.account,
        table: storage.table, storeId: storage.deliveryStoreId!, scope: { appId: scope.appId, tenantId: scope.tenantId } }, native);
      journal = delivery;
      await inbox.open(); assertStarting();
      if (delivery) await delivery.open();
    } else {
      store = await (deps.openIngressStore ?? ((path, target, options) => createIngressPort(openIngressStore(path, target, options))))(dbPath!, scope, { policy });
      assertStarting();
      if (sqliteOutbound) journal = await (deps.openDeliveryJournal ?? openDeliveryJournal)(sqliteOutbound.dbPath,
        { appId: store.scope.appId, tenantId: store.scope.tenantId });
    }
    const ownedStore = store;
    const journalScope = { appId: ownedStore.scope.appId, tenantId: ownedStore.scope.tenantId };
    // Both complete domain audits precede either listener. Never reopen the inbox for routes.
    assertStarting();
    receiver = await prepared.start({ scope: ownedStore.scope,
      admit: (event, route) => ready ? ownedStore.admit(event, route) : { kind: 'full' } },
      journal === undefined ? undefined : { journal, getRoute: (key) => ownedStore.getRoute(key) }, abort.signal);
    assertStarting();
    if (outbound) api = await startOutboundServer(outbound, receiver.outbound!, journalScope, () => ready);
    assertStarting(); ready = true;
  } catch {
    ready = false; abort.abort();
    // Late open/initialize work reaches here only after it actually completes.
    await Promise.allSettled([api?.stop(), receiver?.stop()]);
    await closeStores(); signal?.removeEventListener('abort', cancel);
    throw new Error('Ingress startup failed');
  }
  const ownedReceiver = receiver; const ownedStore = store;
  let resolveDone!: () => void; let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => {});
  const relay = (async () => {
    try {
      while (!abort.signal.aborted) {
        if (!await relayOne(ownedStore, client, abort.signal, () => ready)) {
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
      if (fatal) { const error = new Error('Ingress storage failed'); rejectDone(error); throw error; }
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
    handle = selected.kind === 'ingress' ? createTableIngressStore({ kind: 'ingress', account, table, storeId, scope: selected.scope },
      native, { audit: selected.audit, maxIndexBytes: selected.maxIndexBytes }) :
      createTableDeliveryJournalV2({ kind: 'delivery', account, table, storeId,
        scope: { appId: selected.scope.appId, tenantId: selected.scope.tenantId } }, native);
    await handle.initialize();
  } catch { failed = true; }
  const closed = await Promise.allSettled([Promise.resolve().then(() => handle?.close())]);
  const drained = await Promise.allSettled([Promise.resolve().then(() => provider.close())]);
  if (failed || signal?.aborted || [...closed, ...drained].some(result => result.status === 'rejected')) throw new Error('Table initialization failed');
}

function prepareTableProvider(identity: TableInitConfig['storage']['identity'], dependencies: Pick<IngressRuntimeDependencies, 'tableRequest' | 'storageIdentity'>): StorageTokenProvider {
  try {
    if (dependencies.tableRequest !== undefined && typeof dependencies.tableRequest !== 'function') throw new ConfigurationError();
    const identityDeps = dependencies.storageIdentity === undefined ? {} : auditFields(dependencies.storageIdentity, ['request']);
    return prepareStorageIdentity(identity).createProvider(identityDeps);
  } catch { throw new ConfigurationError(); }
}

function readCaBundle(path: string): Buffer {
  try {
    const bytes = readFileSync(path);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const pem = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu;
    const certificates = text.match(pem);
    // Parse each certificate, not only the first one OpenSSL finds, and refuse
    // incomplete blocks or arbitrary trailing content instead of silently trusting a partial bundle.
    if (!certificates?.length || !/^[\t\r\n ]*$/u.test(text.replace(pem, ''))) throw new ConfigurationError();
    for (const certificate of certificates) new X509Certificate(certificate);
    return bytes;
  } catch { throw new ConfigurationError(); }
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let runtime: IngressRuntime | undefined; const abort = new AbortController();
  const shutdown = () => { abort.abort(); if (runtime) void runtime.stop().catch(() => {}); };
  try {
    if (args.length !== 1 || (args[0] !== 'init' && args[0] !== 'init-delivery' && args[0] !== 'serve')) throw new ConfigurationError();
    if (args[0] === 'init' || args[0] === 'init-delivery') {
      const config = parseRuntimeConfig(env, args[0]);
      if ('storage' in config) {
        process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
        await initializeTableStore(config, {}, abort.signal);
      } else if (args[0] === 'init') initializeIngressStore(config.dbPath, config.scope);
      else initializeDeliveryJournal(config.dbPath, { appId: config.scope.appId, tenantId: config.scope.tenantId });
      logIngress('initialized'); return 0;
    }
    const config = parseRuntimeConfig(env, 'serve');
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
    // No environment-controlled cloud, JWKS or authentication override enters here.
    runtime = await startIngressRuntime(config, {}, abort.signal);
    if (!abort.signal.aborted) logIngress('listening'); else shutdown();
    await runtime.done; logIngress('stopped'); return 0;
  } catch (error) {
    logIngress(error instanceof ConfigurationError ? 'configuration-failed' : runtime ? 'storage-failed' : 'startup-failed');
    return 1;
  } finally {
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2), process.env);
}
