import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigurationError, parseConfig } from './config.js';
import type { ServeConfig } from './config.js';
import { logIngress } from './logger.js';
import { createOrkaClient } from './client.js';
import { initializeIngressStore, openIngressStore } from './store.js';
import { relayOne } from './relay.js';
import { startReceiver } from './server.js';
import type { Receiver, ReceiverDependencies } from './server.js';

export interface IngressRuntime { port: number; done: Promise<void>; stop(): Promise<void> }
export async function startIngressRuntime(config: ServeConfig, dependencies: ReceiverDependencies = {}): Promise<IngressRuntime> {
  const client = createOrkaClient(config.scope, { bearerToken: config.bearerToken,
    ...(config.caFile === undefined ? {} : { ca: readFileSync(config.caFile) }) });
  const store = openIngressStore(config.dbPath, config.scope, { policy: config.policy });
  let receiver: Receiver;
  try { receiver = await startReceiver(config.receiver, store, dependencies); }
  catch { store.close(); throw new Error('Ingress startup failed'); }
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
      abort.abort();
      // No handle closes until both HTTP admission and network settlement finish.
      const settled = await Promise.allSettled([receiver.stop(), relay]);
      if (settled.some((result) => result.status === 'rejected')) fatal = true;
      try { store.close(); } catch { fatal = true; }
      if (fatal) { const error = new Error('Ingress storage failed'); rejectDone(error); throw error; }
      resolveDone();
    })();
    return closing;
  }
  void receiver.failed.catch(() => { fatal = true; void stop().catch(() => {}); });
  void relay.then(() => { if (fatal) void stop().catch(() => {}); });
  return { port: receiver.port, done, stop };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let runtime: IngressRuntime | undefined; let requestedStop = false;
  const shutdown = () => { requestedStop = true; if (runtime) void runtime.stop().catch(() => {}); };
  try {
    if (args.length !== 1 || (args[0] !== 'init' && args[0] !== 'serve')) throw new ConfigurationError();
    if (args[0] === 'init') {
      const config = parseConfig(env, 'init'); initializeIngressStore(config.dbPath, config.scope);
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
