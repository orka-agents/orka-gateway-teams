import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { createTableKernel, createTableKernelV2 } from '../../src/storage/table/index.js';
import type { OwnedAuditVisitor, OwnedAuditVisitorV2 } from '../../src/storage/table/index.js';
import { budget, code, emptyInput, emptyPlan, visitor } from './owned-audit.js';
import { syntheticToken, tableBinding } from './table-service.js';

export interface PromiseCase {
  format: 1 | 2; callback: 'record' | 'endPass' | 'finalize'; disposition: 'returned' | 'thrown'; malformed: boolean;
}
interface Config extends PromiseCase { tableUrl: string; tableCA: string }

// Diagnostic child only. Explicit --unhandled-rejections=throw plus this listener
// counts the unsupported path without letting Node print the private reason.
let violation: Promise<never> | undefined; let unhandled = 0; let callbackRejections = 0;
process.on('unhandledRejection', (_reason, promise) => { unhandled++; if (promise === violation) callbackRejections++; });
process.once('message', (config: Config) => {
  void run(config).then(result => {
    process.send?.({ kind: 'result', ...result }, () => process.disconnect());
  }, () => {
    process.exitCode = 1;
    process.send?.({ kind: 'error', code: 'child-failed' }, () => process.disconnect());
  });
});

async function run(config: Config) {
  let requests = 0; let requestCloses = 0; let socketCloses = 0;
  const kernel = (config.format === 1 ? createTableKernel : createTableKernelV2)(tableBinding, {
    token: async () => syntheticToken,
    request: ((url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
      requests++;
      const request = https.request(new URL(url.pathname + url.search, config.tableUrl),
        { ...options, hostname: '127.0.0.1', servername: 'localhost', ca: config.tableCA }, callback);
      request.once('close', () => requestCloses++);
      request.once('socket', socket => socket.once('close', () => socketCloses++));
      return request;
    }) as typeof https.request,
  });
  const outcome = (operation: Promise<unknown>) => operation.then(() => 'success', error => code('unresolved')(error) ? 'unresolved' : 'other');
  try {
    await kernel.initialize(); await kernel.acquire();
    let callbacks = 0; let laterCallbacks = 0; let constructorReads = 0; let invoked = false; let ready = false;
    const observe = (): undefined => {
      callbacks++; if (invoked) laterCallbacks++;
      ready ||= kernel.status().lifecycle === 'envelope-audited';
    };
    const invalid = () => {
      observe(); invoked = true;
      violation = Promise.reject(new Error('synthetic private callback rejection'));
      if (config.malformed) Object.defineProperty(violation, 'constructor', { configurable: false, get() {
        constructorReads++; throw new Error('synthetic private constructor failure');
      } });
      if (config.disposition === 'thrown') throw violation;
      return violation;
    };
    // JS/casts can still break the trusted synchronous contract. Exercise the real
    // callback boundary, not a standalone invocation of the Promise helper.
    const auditVisitor = { passes: 2, record: observe, endPass: observe, finalize: observe, [config.callback]: invalid } as unknown as OwnedAuditVisitor & OwnedAuditVisitorV2;
    const audit = await outcome(kernel.auditOwned(auditVisitor, budget()));
    ready ||= kernel.status().lifecycle === 'envelope-audited';
    const poisoned = kernel.status().lifecycle === 'poisoned';
    const mutation = await outcome(kernel.mutate(emptyInput, emptyPlan));
    const laterAudit = await outcome(kernel.auditOwned({ ...visitor(), record: observe, endPass: observe, finalize: observe }, budget()));
    ready ||= kernel.status().lifecycle === 'envelope-audited';
    const close = await outcome(kernel.close());
    // Cross an event-loop turn after actual drain so Node reports unhandled
    // rejections. This delay is diagnostic observation, never timeout-as-drain.
    await new Promise<void>(resolve => setImmediate(resolve));
    return { audit, mutation, laterAudit, close, poisoned, ready, callbacks, laterCallbacks, constructorReads,
      unhandled, callbackRejections, pending: kernel.status().pending, closed: kernel.status().lifecycle === 'closed',
      requests, requestCloses, socketCloses };
  } finally {
    // Always await real kernel/native cleanup, even when setup or observation fails.
    // A hung close makes the parent timeout fail; it is not reported as drained.
    await kernel.close().catch(() => undefined);
  }
}
