import https from 'node:https';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { startIngressRuntime } from '../../src/ingress/main.js';
import { tableRuntimeConfig } from './table-runtime.js';
import { scope } from './ingress-auth.js';
import { processClock } from './table-process-clock.js';

process.once('message', (config: { tableUrl: string; tableCA: string; identityUrl: string; clockFile: string }) => {
  void (async () => {
    const selected = tableRuntimeConfig(scope); selected.storage.backend = 'table-v3';
    const runtime = await startIngressRuntime(selected, { tableLeaseClock: processClock(config.clockFile),
      tableRequest: ((url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) =>
        https.request(new URL(url.pathname + url.search, config.tableUrl), { ...options, hostname: '127.0.0.1', ca: config.tableCA, servername: 'localhost' }, callback)) as typeof https.request,
      storageIdentity: { request: ((url: URL, options: http.RequestOptions, callback: (response: IncomingMessage) => void) =>
        http.request(new URL(url.pathname + url.search, config.identityUrl), options, callback)) as typeof http.request } });
    const close = new Promise<void>(resolve => process.once('message', () => resolve()));
    process.send?.({ kind: 'ready', port: runtime.port, outboundPort: runtime.outboundPort }); await close;
    await runtime.stop(); await runtime.done; process.send?.({ kind: 'closed' }); process.disconnect();
  })().catch(() => { process.send?.({ kind: 'error' }); process.disconnect(); });
});
