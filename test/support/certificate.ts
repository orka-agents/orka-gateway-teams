import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { receiverConfig } from './ingress-auth.js';

/** Independent synthetic app-auth material, never a user's credential or TLS key. */
export function certificateFiles(t: TestContext, algorithm = 'rsa:2048') {
  const directory = mkdtempSync(join(tmpdir(), 'teams-certificate-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const certificateFile = join(directory, 'certificate.crt'); const privateKeyFile = join(directory, 'private-key.pem');
  try {
    execFileSync('openssl', ['req', '-x509', ...(algorithm.startsWith('ec:') ?
      ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'] : ['-newkey', algorithm]), '-nodes', '-keyout', privateKeyFile,
      '-out', certificateFile, '-days', '1', '-subj', '/CN=synthetic-app-auth.invalid'], { stdio: 'ignore' });
    chmodSync(certificateFile, 0o600); chmodSync(privateKeyFile, 0o600);
  } catch { throw new Error('Synthetic certificate fixture failed'); }
  const { clientSecret: _unused, ...receiver } = receiverConfig;
  const config = { ...receiver, credentialMode: 'certificate' as const, certificateFile, privateKeyFile };
  return { directory, config, certificate: new X509Certificate(readFileSync(certificateFile)) };
}

// Syntactically valid synthetic JWT for the real SDK wrapper. Not an authentication credential.
export function syntheticAccessToken(): string {
  return [Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'c3ludGhldGlj'].join('.');
}
