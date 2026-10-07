// Test-only clock at the real CLI boundary. Leave timeout, SDK and native I/O real.
import { chmodSync } from 'node:fs';
import { mock } from 'node:test';

mock.timers.enable({ apis: ['setInterval'] });
mock.method(process, 'memoryUsage', () => ({ rss: 101, heapTotal: 202, heapUsed: 303, external: 404, arrayBuffers: 505,
  text: 'private-message-sentinel', token: 'private-token-sentinel', extra: 'private-extra-sentinel' }));
const write = process.stderr.write.bind(process.stderr);
const marker = (phase: string) => write(`diagnostics-test: ${phase}\n`);
let listening = false;
mock.method(process.stderr, 'write', (...args: Parameters<typeof process.stderr.write>) => {
  const result = write(...args);
  if (args[0] === 'teams-ingress: listening\n') {
    listening = true;
    setImmediate(() => {
      mock.timers.tick(59999); marker('before-first-minute');
      mock.timers.tick(1); mock.timers.tick(60000); marker('two-minutes');
      const mode = process.env.MEMORY_DIAGNOSTICS_TEST;
      if (mode === 'natural-failure') {
        // Metadata-only external storage fault; never read/close a live SQLite file.
        chmodSync(process.env.INGRESS_DB!, 0o644);
      } else {
        process.emit(mode === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
        // Still in the signal turn: runtime draining cannot have finished yet.
        mock.timers.tick(120000); marker('signal-draining');
      }
    });
  }
  return result;
});
const on = process.on;
mock.method(process, 'on', function (this: NodeJS.Process, ...args: Parameters<typeof process.on>) {
  const result = on.apply(this, args);
  if (args[0] === 'SIGTERM') {
    mock.timers.tick(120000); marker('starting');
    // Deliver after handler installation but before any startup/recovery I/O.
    if (process.env.MEMORY_DIAGNOSTICS_TEST === 'early-signal') process.emit('SIGTERM');
  }
  return result;
});
process.once('beforeExit', () => {
  mock.timers.tick(120000); marker(listening ? 'after-runtime' : 'without-listening');
});
