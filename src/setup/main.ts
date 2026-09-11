import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSetupConfig } from './config.js';
import { startSetupCapture } from './server.js';
import type { SetupCapture } from './server.js';

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const abort = new AbortController();
  const shutdown = () => abort.abort();
  let capture: SetupCapture | undefined;
  // Installed before configuration/file/SDK startup, including the first await.
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  try {
    if (args.length) throw new Error('Invalid setup configuration');
    capture = await startSetupCapture(parseSetupConfig(env), {}, abort.signal);
    if (!abort.signal.aborted) process.stderr.write('teams-setup: listening\n');
    await capture.done;
    process.stderr.write('teams-setup: saved\n'); return 0;
  } catch {
    process.stderr.write('teams-setup: failed\n'); return 1;
  } finally {
    await capture?.stop();
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2), process.env);
}
