import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigurationError, parseConfig, tlsVerificationEnabled, validateOutboundConfig, validateReceiverConfig } from './config.js';
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
/** Trusted library opening seams only; CLI configuration always selects SQLite. */
export interface IngressRuntimeDependencies extends ReceiverDependencies {
  openIngressStore?: (path: string, scope: Readonly<IngressScope>, options: StoreOptions) => IngressPort | Promise<IngressPort>;
  openDeliveryJournal?: (path: string, scope: Readonly<JournalScope>) => DeliveryJournalPort | Promise<DeliveryJournalPort>;
}
export async function startIngressRuntime(config: ServeConfig, dependencies: IngressRuntimeDependencies = {}, signal?: AbortSignal): Promise<IngressRuntime> {
  if (!tlsVerificationEnabled()) throw new ConfigurationError();
  const receiverConfig = validateReceiverConfig(config.receiver);
  const outbound = config.outbound === undefined ? undefined : validateOutboundConfig(config.outbound, config.dbPath, config.bearerToken, receiverConfig);
  try {
    const databases = [config.dbPath, ...(outbound ? [outbound.dbPath, `${outbound.dbPath}.owner.sqlite`] : [])];
    assertCredentialSeparation(receiverConfig, databases.flatMap((path) => [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]));
  } catch { throw new ConfigurationError(); }
  if (signal?.aborted) throw new Error('Ingress startup failed');
  // Snapshot before any opening await; credentials and CA are prepared before
  // ownership, so neither can be reread through a live SQLite inode.
  const dbPath = config.dbPath; const scope = { ...config.scope }; const policy = { ...config.policy };
  const deps = { ...dependencies };
  const prepared = prepareReceiver(receiverConfig, deps);
  const client = createOrkaClient(scope, { bearerToken: config.bearerToken,
    ...(config.caFile === undefined ? {} : { ca: readCaBundle(config.caFile) }) });
  const abort = new AbortController(); let fatal = false; let closing: Promise<void> | undefined;
  let ready = false; let stopRuntime: (() => Promise<void>) | undefined;
  const cancel = () => { ready = false; abort.abort(); void stopRuntime?.().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const assertStarting = () => { if (signal?.aborted || abort.signal.aborted) throw new Error('Ingress startup failed'); };
  let store: IngressPort | undefined; let journal: DeliveryJournalPort | undefined;
  let receiver: Receiver | undefined; let api: OutboundServer | undefined;
  const closeStores = () => Promise.allSettled([
    Promise.resolve().then(() => journal?.close()), Promise.resolve().then(() => store?.close()),
  ]);
  try {
    assertStarting();
    store = await (deps.openIngressStore ?? ((path, target, options) => createIngressPort(openIngressStore(path, target, options))))(dbPath, scope, { policy });
    assertStarting();
    const ownedStore = store;
    const journalScope = { appId: ownedStore.scope.appId, tenantId: ownedStore.scope.tenantId };
    // Own both stores before binding either listener. Never reopen the inbox for routes.
    if (outbound) journal = await (deps.openDeliveryJournal ?? openDeliveryJournal)(outbound.dbPath, journalScope);
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
      const config = parseConfig(env, args[0]);
      if (args[0] === 'init') initializeIngressStore(config.dbPath, config.scope);
      else initializeDeliveryJournal(config.dbPath, { appId: config.scope.appId, tenantId: config.scope.tenantId });
      logIngress('initialized'); return 0;
    }
    const config = parseConfig(env, 'serve');
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
