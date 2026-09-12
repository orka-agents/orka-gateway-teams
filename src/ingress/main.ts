import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigurationError, parseConfig, tlsVerificationEnabled, validateOutboundConfig, validateReceiverConfig } from './config.js';
import type { ServeConfig } from './config.js';
import { logIngress } from './logger.js';
import { createOrkaClient } from './client.js';
import { initializeIngressStore, openIngressStore } from './store.js';
import { relayOne } from './relay.js';
import { prepareReceiver } from './server.js';
import { assertCredentialSeparation } from '../auth/certificate.js';
import type { Receiver, ReceiverDependencies } from './server.js';
import { initializeDeliveryJournal, openDeliveryJournal } from '../delivery/journal.js';
import type { DeliveryJournal } from '../delivery/types.js';
import { startOutboundServer } from '../outbound/server.js';
import type { OutboundServer } from '../outbound/server.js';

export interface IngressRuntime { port: number; done: Promise<void>; stop(): Promise<void>; outboundPort?: number }
export async function startIngressRuntime(config: ServeConfig, dependencies: ReceiverDependencies = {}): Promise<IngressRuntime> {
  if (!tlsVerificationEnabled()) throw new ConfigurationError();
  const receiverConfig = validateReceiverConfig(config.receiver);
  const outbound = config.outbound === undefined ? undefined : validateOutboundConfig(config.outbound, config.dbPath, config.bearerToken, receiverConfig);
  try {
    const databases = [config.dbPath, ...(outbound ? [outbound.dbPath, `${outbound.dbPath}.owner.sqlite`] : [])];
    assertCredentialSeparation(receiverConfig, databases.flatMap((path) => [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]));
  } catch { throw new ConfigurationError(); }
  const prepared = prepareReceiver(receiverConfig, dependencies);
  const client = createOrkaClient(config.scope, { bearerToken: config.bearerToken,
    ...(config.caFile === undefined ? {} : { ca: readCaBundle(config.caFile) }) });
  const store = openIngressStore(config.dbPath, config.scope, { policy: config.policy });
  const journalScope = { appId: store.scope.appId, tenantId: store.scope.tenantId };
  let receiver: Receiver | undefined; let journal: DeliveryJournal | undefined; let api: OutboundServer | undefined; let ready = false;
  try {
    // Own both stores before binding either listener. Never reopen the exclusive inbox for routes.
    if (outbound) journal = openDeliveryJournal(outbound.dbPath, journalScope);
    receiver = await prepared.start(outbound ? { scope: store.scope,
      admit: (event, route) => ready ? store.admit(event, route) : { kind: 'full' } } : store,
      journal === undefined ? undefined : { journal, getRoute: (key) => store.getRoute(key) });
    if (outbound) api = await startOutboundServer(outbound, receiver.outbound!, journalScope, () => ready);
    ready = true;
  } catch {
    await Promise.allSettled([api?.stop(), receiver?.stop()]);
    try { journal?.close(); } finally { store.close(); }
    throw new Error('Ingress startup failed');
  }
  const ownedReceiver = receiver;
  const abort = new AbortController(); let fatal = false; let closing: Promise<void> | undefined;
  let resolveDone!: () => void; let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => {});
  const relay = (async () => {
    try {
      while (!abort.signal.aborted) {
        if (!await relayOne(store, client, abort.signal)) {
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
      try { journal?.close(); } catch { fatal = true; }
      try { store.close(); } catch { fatal = true; }
      if (fatal) { const error = new Error('Ingress storage failed'); rejectDone(error); throw error; }
      resolveDone();
    })();
    return closing;
  }
  void ownedReceiver.failed.catch(() => { fatal = true; void stop().catch(() => {}); });
  void api?.failed.catch(() => { fatal = true; void stop().catch(() => {}); });
  void relay.then(() => { if (fatal) void stop().catch(() => {}); });
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
  let runtime: IngressRuntime | undefined; let requestedStop = false;
  const shutdown = () => { requestedStop = true; if (runtime) void runtime.stop().catch(() => {}); };
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
    runtime = await startIngressRuntime(config);
    logIngress('listening'); if (requestedStop) shutdown();
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
