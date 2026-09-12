import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, parse } from 'node:path';
import type { TokenCredentials } from '@microsoft/teams.api';
import type { INetworkModule } from '@azure/msal-node';
import { certificateTokenEndpoint, createCertificateNetwork } from './network.js';
import { createAppToken } from './app-token.js';
import { tlsVerificationEnabled } from '../ingress/config.js';
import { assertCertificateEnvironment, validateBotCredential } from './credentials.js';
import type { SharedBotCredentialConfig } from './credentials.js';

type CertificateConfig = Extract<SharedBotCredentialConfig, { credentialMode: 'certificate' }> & { appId: string; tenantId: string };
export interface PreparedCertificate { assertUsable(): void; createToken(network?: INetworkModule): TokenCredentials['token'] }

/** Only closures escape. File descriptors close before any store can be owned. */
export function prepareCertificate(input: CertificateConfig): PreparedCertificate {
  try {
    const config = validateBotCredential(input); if (config.credentialMode !== 'certificate') fail();
    const appId = input.appId; const tenantId = input.tenantId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(appId)) fail();
    certificateTokenEndpoint(tenantId);
    const directory = dirname(config.certificateFile);
    if (dirname(config.privateKeyFile) !== directory) fail();
    const parent = trustedParent(directory);
    const certStamp = fs.lstatSync(config.certificateFile); privateFile(certStamp, false);
    const keyStamp = fs.lstatSync(config.privateKeyFile); privateFile(keyStamp, true);
    if (sameInode(certStamp, keyStamp)) fail();
    const certificate = new X509Certificate(singlePem(snapshot(config.certificateFile, certStamp, false), false));
    const keyPem = singlePem(snapshot(config.privateKeyFile, keyStamp, true), true);
    const key = createPrivateKey(keyPem);
    const keyType = keyPem.includes('BEGIN RSA PRIVATE KEY') ? 'pkcs1' : 'pkcs8';
    const encoded = keyPem.replace(/-----[^\r\n]+-----/gu, '').replace(/\s/gu, '');
    // OpenSSL accepts trailing DER in some private-key formats. Re-encoding also
    // refuses that hidden payload instead of trusting the first parsed object.
    if (!key.export({ type: keyType, format: 'der' }).equals(Buffer.from(encoded, 'base64'))) fail();
    same(parent, trustedParent(directory));
    same(certStamp, fs.lstatSync(config.certificateFile)); same(keyStamp, fs.lstatSync(config.privateKeyFile));
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || !certificate.checkPrivateKey(key)) fail();
    const validFrom = certificate.validFromDate.getTime(); const validTo = certificate.validToDate.getTime();
    const assertUsable = () => {
      const now = Date.now();
      if (!tlsVerificationEnabled() || !Number.isFinite(now) || !Number.isFinite(validFrom) || !Number.isFinite(validTo) ||
          now < validFrom || now >= validTo) fail();
      try { assertCertificateEnvironment(); } catch { fail(); }
    };
    assertUsable();
    // Normalize PKCS1 too, but never return PEM/key objects as inspectable prepared state.
    const privateKey = key.export({ type: 'pkcs8', format: 'pem' }).toString();
    const thumbprintSha256 = createHash('sha256').update(certificate.raw).digest('hex');
    let created = false;
    return { assertUsable, createToken(network = createCertificateNetwork(tenantId)) {
      if (created) fail(); created = true;
      return createAppToken(appId, tenantId, { clientCertificate: { thumbprintSha256, privateKey } }, assertUsable, network, tokenFailure);
    } };
  } catch { return fail(); }
}

/** Metadata only, including resolved names and hard-link identities. Never open SQLite inodes. */
export function assertCredentialSeparation(input: SharedBotCredentialConfig, paths: readonly string[]): void {
  if (input.credentialMode !== 'certificate') return;
  try {
    const credentials = [input.certificateFile, input.privateKeyFile].map((path) => ({
      path: join(fs.realpathSync(dirname(path)), basename(path)), parent: fs.statSync(dirname(path)), stamp: fs.lstatSync(path),
    }));
    for (const path of paths) {
      const parent = fs.statSync(dirname(path)); const name = join(fs.realpathSync(dirname(path)), basename(path));
      const stamp = fs.statSync(path, { throwIfNoEntry: false });
      if (credentials.some((credential) => sameInode(parent, credential.parent) || credential.path === name ||
          (stamp !== undefined && sameInode(credential.stamp, stamp)))) fail();
    }
  } catch { fail(); }
}

function snapshot(path: string, expected: Stats, key: boolean): string {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd); same(expected, before); privateFile(before, key);
    const bytes = Buffer.alloc(before.size + 1); const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd); same(before, after); privateFile(after, key); same(after, fs.lstatSync(path));
    if (count !== before.size) fail();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
  } finally { fs.closeSync(fd); }
}
function singlePem(text: string, key: boolean): string {
  const pattern = key ? /^[\t\r\n ]*-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1-----[\t\r\n ]*$/u :
    /^[\t\r\n ]*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----[\t\r\n ]*$/u;
  if (!pattern.test(text)) fail(); return text;
}
function privateFile(stamp: Stats, key: boolean): void {
  const mode = stamp.mode & 0o7777;
  if (!stamp.isFile() || stamp.uid !== process.getuid?.() || stamp.nlink !== 1 || stamp.size < 1 || stamp.size > 65536 ||
      (key ? mode !== 0o600 : mode !== 0o600 && mode !== 0o400)) fail();
}
function sameInode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function same(a: Stats, b: Stats): void {
  if (!sameInode(a, b) || a.size !== b.size || a.mode !== b.mode || a.uid !== b.uid || a.nlink !== b.nlink ||
      a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs) fail();
}
function trustedParent(path: string): Stats {
  const uid = process.getuid?.(); if (uid === undefined) fail();
  const root = parse(path).root; let current = root; let result = fs.lstatSync(root);
  for (const part of ['', ...path.slice(root.length).split('/').filter(Boolean)]) {
    if (part) current = join(current, part);
    result = fs.lstatSync(current); const mode = result.mode & 0o7777;
    if (!result.isDirectory() || (result.uid !== 0 && result.uid !== uid) ||
        ((mode & 0o022) !== 0 && !(result.uid === 0 && (mode & 0o1000) !== 0))) fail();
  }
  if (result.uid !== uid || (result.mode & 0o7777) !== 0o700) fail(); return result;
}
function fail(): never { throw new Error('Invalid certificate credentials'); }
function tokenFailure(): Error { return new Error('Certificate token unavailable'); }
