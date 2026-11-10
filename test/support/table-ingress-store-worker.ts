import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { createTableIngressStore, createTableIngressStoreV3 } from '../../src/ingress/table-store.js';
import { createOrkaClient } from '../../src/ingress/client.js';
import { relayOne } from '../../src/ingress/relay.js';
import { TableError } from '../../src/storage/table/types.js';
import { ingressBinding } from './table-service.js';
import { pair } from './table-ingress-audit.js';
import { options } from './table-ingress-store.js';
import { processClock } from './table-process-clock.js';
interface Config { format?: 3; clockFile?: string; fresh?: boolean; tableUrl: string; tableCA: string; providerUrl: string; providerCA: string; mode: 'grant' | 'relay' | 'probe' | 'held-relay' }
process.once('message', (config: Config) => { void run(config); });
async function run(config: Config): Promise<void> {
  const j = (config.format === 3 ? createTableIngressStoreV3 : createTableIngressStore)(ingressBinding, {
    ...(config.clockFile ? { leaseClock: processClock(config.clockFile) } : {}), token: async () => 'synthetic.private.table.canary',
    request: ((url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) =>
      https.request(new URL(url.pathname + url.search, config.tableUrl), { ...options, hostname: '127.0.0.1', servername: 'localhost', ca: config.tableCA }, callback)) as typeof https.request,
  }, { ...options, ...(config.clockFile ? { now: processClock(config.clockFile).wallNow } : {}) });
  try {
    await j.open();
    if (config.mode !== 'probe') { const p = pair(config.fresh ? 'event-fresh' : 'event-a', config.fresh ? 'target-fresh' : 'target-a'); await j.admit(p.event.body!, p.route.route); }
    let ready: boolean;
    if (config.mode === 'held-relay') {
      const claim = j.claimForForwarding.bind(j);
      j.claimForForwarding = async () => {
        const grant = await claim();
        const resume = new Promise<void>(resolve => process.once('message', () => resolve()));
        process.send?.({ kind: 'armed' }); await resume; return grant;
      };
    }
    if (config.mode === 'relay' || config.mode === 'held-relay') ready = await relayOne(j, createOrkaClient({ ...j.scope, orkaBaseUrl: config.providerUrl },
      { bearerToken: 'synthetic.provider.token', ca: config.providerCA,
        ...(config.format === 3 ? { authority: j.leaseAuthority() } : {}) }));
    else ready = !!await j.claimForForwarding();
    const close = new Promise<void>(resolve => { process.once('message', () => resolve()); });
    process.send?.({ kind: 'ready', claim: ready }); await close;
    await j.close(); process.send?.({ kind: 'closed' }); process.disconnect();
  } catch (error) {
    await j.close().catch(() => undefined);
    process.send?.({ kind: 'error', code: error instanceof TableError ? error.code : 'unavailable' }); process.disconnect();
  }
}
