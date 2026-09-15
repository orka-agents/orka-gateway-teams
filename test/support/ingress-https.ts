import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import type { RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Minimal cleanup contract used by these fixtures, also in the in-process image gate. */
export interface FixtureHooks { after(cleanup: () => void | Promise<void>): void }

export async function httpsFixture(t: FixtureHooks, listener: RequestListener) {
  // Private directory and ephemeral key: never committed or printed. OpenSSL
  // writes the key privately; stderr (including progress) is not forwarded.
  const directory = mkdtempSync(join(tmpdir(), 'teams-ingress-tls-'));
  let key: Buffer; let ca: Buffer;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
      '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    key = readFileSync(join(directory, 'key.pem')); ca = readFileSync(join(directory, 'cert.pem'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const server = createServer({ key, cert: ca }, listener);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing test listener');
  return { ca, baseUrl: `https://localhost:${address.port}/`, server };
}
