import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { initializeSessionCorrelation, openSessionCorrelation } from '../src/delivery/sqlite-session-correlation.js';
import { ConfigurationError } from '../src/ingress/config.js';
import type { ServeConfig } from '../src/ingress/config.js';
import { startIngressRuntime } from '../src/ingress/main.js';
import { certificateFiles } from './support/certificate.js';
import { receiverConfig, scope } from './support/ingress-auth.js';

const journalScope = { appId: scope.appId, tenantId: scope.tenantId };
function fixture(t: TestContext): ServeConfig {
  const directory = fs.mkdtempSync(join(tmpdir(), 'teams-ca-separation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { dbPath: join(directory, 'inbox.sqlite'), scope, receiver: { ...receiverConfig, credentialMode: 'client-secret' },
    bearerToken: randomUUID(), policy: { maxPending: 1000, maxRecords: 100000, replayWindowMs: 86400000 },
    outbound: { dbPath: join(directory, 'delivery.sqlite'), correlationDbPath: join(directory, 'correlation.sqlite'),
      bearerToken: randomUUID(), host: '127.0.0.1', port: 0 } };
}
function correlationProbe(path: string): number | null {
  const source = `import { openSessionCorrelation } from './src/delivery/sqlite-session-correlation.ts';
    try { const handle = openSessionCorrelation(process.argv[1], JSON.parse(process.argv[2])); handle.close(); process.exit(3); }
    catch (error) { process.exit(error.code === 'busy' ? 0 : 4); }`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, path, JSON.stringify(journalScope)],
    { cwd: process.cwd(), stdio: 'pipe', timeout: 10000 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null);
  return child.status;
}

for (const alias of ['name', 'parent symlink', 'file symlink', 'hardlink'] as const) {
  test(`failed client-secret startup with CA ${alias} alias preserves a live correlation owner's child-process exclusion`, async (t) => {
    const config = fixture(t); const path = config.outbound!.correlationDbPath!;
    initializeSessionCorrelation(path, journalScope); const owner = openSessionCorrelation(path, journalScope);
    const ownerPath = `${path}.owner.sqlite`; const aliasPath = join(dirname(path), 'ca-alias.pem');
    try {
      assert.equal(correlationProbe(path), 0, 'fresh child must be busy before startup');
      config.caFile = ownerPath;
      if (alias === 'parent symlink') {
        fs.symlinkSync(dirname(path), join(dirname(path), 'directory-alias'));
        config.caFile = join(dirname(path), 'directory-alias', 'correlation.sqlite.owner.sqlite');
      } else if (alias === 'file symlink' || alias === 'hardlink') {
        if (alias === 'hardlink') fs.linkSync(ownerPath, aliasPath); else fs.symlinkSync(ownerPath, aliasPath);
        config.caFile = aliasPath;
      }
      try { await assert.rejects(startIngressRuntime(config), ConfigurationError); }
      finally { if (alias === 'hardlink' || alias === 'file symlink') fs.rmSync(aliasPath); }
      // Remove the hard link before probing: nlink validation must not masquerade as ownership exclusion.
      assert.equal(correlationProbe(path), 0, 'fresh child must remain busy after rejected CA startup');
    } finally { owner.close(); }
    assert.equal(correlationProbe(path), 3, 'fresh child must open only after the original owner closes');
  });
}

const sidecars = ['', '-journal', '-wal', '-shm'];
for (const target of ['ingress', 'delivery', 'correlation'] as const) {
  const suffixes = target === 'ingress' ? sidecars : [...sidecars, ...sidecars.map(suffix => `.owner.sqlite${suffix}`)];
  for (const suffix of suffixes) test(`CA separation from ${target}${suffix} uses metadata only for names and inode aliases`, async (t) => {
    for (const alias of ['name', 'file symlink', 'hardlink'] as const) await t.test(alias, async (t) => {
      const config = fixture(t);
      const base = target === 'ingress' ? config.dbPath : target === 'delivery' ? config.outbound!.dbPath : config.outbound!.correlationDbPath!;
      const path = base + suffix; fs.writeFileSync(path, 'synthetic non-PEM storage', { mode: 0o600 });
      config.caFile = path;
      if (alias !== 'name') {
        config.caFile = join(dirname(path), 'ca-alias.pem');
        if (alias === 'hardlink') fs.linkSync(path, config.caFile); else fs.symlinkSync(path, config.caFile);
      }
      const open = fs.openSync; let opens = 0;
      t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => { opens++; return open(...args); });
      await assert.rejects(startIngressRuntime(config), ConfigurationError);
      assert.equal(opens, 0, 'CA/storage collision must fail before any ordinary fd opens');
    });
  });
}

test('ingress-only client-secret CA collision is rejected without an ordinary database read', async (t) => {
  const full = fixture(t); const { outbound: _outbound, ...config } = full;
  fs.writeFileSync(config.dbPath, 'synthetic non-PEM storage', { mode: 0o600 }); config.caFile = config.dbPath;
  const open = fs.openSync; let opens = 0;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => { opens++; return open(...args); });
  await assert.rejects(startIngressRuntime(config), ConfigurationError); assert.equal(opens, 0);
});

for (const mode of ['certificate', 'managed-identity-federation'] as const) {
  test(`CA collision is metadata-only in ${mode} credential mode too`, async (t) => {
    const config = fixture(t); const { clientSecret: _secret, ...receiver } = receiverConfig;
    config.receiver = mode === 'certificate' ? certificateFiles(t).config : { ...receiver, credentialMode: mode,
      managedIdentityClientId: '33333333-3333-4333-8333-333333333333', managedIdentityPrincipalId: '44444444-4444-4444-8444-444444444444' };
    config.caFile = `${config.outbound!.correlationDbPath!}.owner.sqlite`;
    fs.writeFileSync(config.caFile, 'synthetic non-PEM storage', { mode: 0o600 });
    const open = fs.openSync; let opens = 0;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => { opens++; return open(...args); });
    await assert.rejects(startIngressRuntime(config), ConfigurationError); assert.equal(opens, 0);
  });
}
