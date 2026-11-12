import { pathToFileURL } from 'node:url';
import { prepareStorageIdentity } from '../auth/storage-identity.js';
import { parseRegistryConfig } from '../registry/config.js';
import { absoluteFile, readRegistryFile } from '../registry/files.js';
import { parseCanonicalJSON } from './codec.js';
import { importDirectory, validateDirectoryImport } from './import.js';
import { openDirectory } from './store.js';
import { createDirectoryTable } from './table.js';

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node dist/directory/main.js import <absolute-export-file>\nServing must be stopped and drained. Requires registry/storage configuration and TABLE_DIRECTORY_TABLE.\n'); return;
  }
  if (args.length !== 2 || args[0] !== 'import') throw new Error();
  const file = absoluteFile(args[1]); const registry = parseRegistryConfig(process.env); const target = registry.targets[0]!;
  const name = process.env.TABLE_DIRECTORY_TABLE;
  if (!name || !/^[a-z][a-z0-9]{2,62}$/iu.test(name) || name.toLowerCase() === target.config.storage.table.toLowerCase()) throw new Error();
  const rows = validateDirectoryImport(parseCanonicalJSON(Buffer.from(readRegistryFile(file, 256 * 1024)), 131072), registry);
  const provider = prepareStorageIdentity(target.config.storage.identity).createProvider();
  const table = createDirectoryTable({ account: target.config.storage.account, table: name,
    appId: target.config.scope.appId, tenantId: target.config.scope.tenantId }, { token: provider.token });
  const abort = new AbortController(); const cancel = () => abort.abort(); const deadline = performance.now() + 30000;
  const timer = setTimeout(cancel, 30000); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const context = { signal: abort.signal, deadline }; const directory = await openDirectory(table, context);
    try { await importDirectory(rows, directory, context); } finally { await directory.close(); }
    process.stdout.write('Directory import complete.\n');
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await table.close(); await provider.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).catch(() => { process.stderr.write('Directory import failed. Check the reviewed export and offline configuration.\n'); process.exitCode = 1; });
}
