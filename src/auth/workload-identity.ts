import fs from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import type { TokenCredentials } from '@microsoft/teams.api';
import type { INetworkModule } from '@azure/msal-node';
import { assertWorkloadIdentityEnvironment, validateBotCredential } from './credentials.js';
import type { SharedBotCredentialConfig } from './credentials.js';
import { certificateTokenEndpoint, createCertificateNetwork, validAccessToken } from './network.js';
import { createAppToken } from './app-token.js';
import { tlsVerificationEnabled } from '../ingress/config.js';

type WorkloadIdentityConfig = Extract<SharedBotCredentialConfig, { credentialMode: 'workload-identity' }> & { appId: string; tenantId: string };
export interface PreparedWorkloadIdentity { assertUsable(): void; createToken(network?: INetworkModule): TokenCredentials['token'] }

/** Structural preparation only. Setup/ingress-only mode never reads the assertion or contacts Entra. */
export function prepareWorkloadIdentity(input: WorkloadIdentityConfig): PreparedWorkloadIdentity {
  try {
    const config = validateBotCredential(input); if (config.credentialMode !== 'workload-identity') throw new Error();
    const appId = input.appId; const tenantId = input.tenantId; const endpoint = certificateTokenEndpoint(tenantId);
    const assertUsable = () => {
      try {
        assertWorkloadIdentityEnvironment(process.env, appId, tenantId, config.workloadIdentityTokenFile);
        if (!tlsVerificationEnabled() || !Number.isFinite(Date.now())) throw new Error();
      } catch { throw new Error('Invalid workload identity credentials'); }
    };
    assertUsable(); let created = false;
    return { assertUsable, createToken(network = createCertificateNetwork(tenantId)) {
      if (created) throw new Error('Invalid workload identity credentials'); created = true;
      return createAppToken(appId, tenantId, { clientAssertion: async (options) => {
        assertUsable();
        if (options.clientId !== appId || options.tokenEndpoint !== endpoint || options.fmiPath !== undefined) throw tokenFailure();
        // Resolve the current Kubernetes projection on every acquisition, including
        // MSAL final-token cache hits. Do not retain the rotating service-account JWT.
        const token = readProjection(config.workloadIdentityTokenFile);
        assertUsable();
        if (!validAccessToken(token)) throw tokenFailure();
        const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
        const audience = claims.aud;
        if (claims.iss !== config.workloadIdentityIssuer || claims.sub !== config.workloadIdentitySubject ||
            (audience !== 'api://AzureADTokenExchange' && (!Array.isArray(audience) || audience.length !== 1 || audience[0] !== 'api://AzureADTokenExchange')) ||
            typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000 + 10 ||
            (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > Date.now() / 1000))) throw tokenFailure();
        // Entra verifies the signature and exact federated credential; decoding here
        // only prevents sending a mismatched local assertion to the fixed endpoint.
        return token;
      } }, assertUsable, network, tokenFailure);
    } };
  } catch { throw new Error('Invalid workload identity credentials'); }
}

/** Metadata only, before SQLite ownership: closing any alias can release POSIX locks. */
export function assertWorkloadIdentitySeparation(input: SharedBotCredentialConfig, paths: readonly string[]): void {
  if (input.credentialMode !== 'workload-identity' || paths.length === 0) return;
  try {
    const parent = fs.realpathSync(dirname(input.workloadIdentityTokenFile));
    const tokenPath = fs.realpathSync(input.workloadIdentityTokenFile); const token = fs.statSync(tokenPath);
    if (!inside(parent, tokenPath)) throw tokenFailure();
    privateTokenFile(token); trustedDirectory(dirname(tokenPath));
    for (const path of paths) {
      const name = join(fs.realpathSync(dirname(path)), basename(path));
      const stamp = fs.statSync(path, { throwIfNoEntry: false });
      if (inside(parent, name) || (stamp !== undefined && token.dev === stamp.dev && token.ino === stamp.ino)) throw tokenFailure();
    }
  } catch { throw new Error('Invalid workload identity credentials'); }
}

function readProjection(path: string): string {
  for (let attempt = 0; ; attempt++) {
    try {
      const parent = fs.realpathSync(dirname(path)); const resolved = fs.realpathSync(path);
      // Kubernetes uses token -> ..data/token -> timestamped-directory/token.
      // Permit that rotation inside the selected mount, never a link outside it.
      if (resolved === parent || !inside(parent, resolved)) throw tokenFailure();
      trustedDirectory(dirname(resolved));
      const expected = fs.lstatSync(resolved); privateTokenFile(expected);
      const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const before = fs.fstatSync(fd); same(expected, before); privateTokenFile(before);
        const bytes = Buffer.alloc(before.size + 1); const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        const after = fs.fstatSync(fd); same(before, after);
        if (count !== before.size) throw tokenFailure();
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
      } finally { fs.closeSync(fd); }
    } catch (error) {
      // Rotation can unlink the old generation between realpath and open.
      if (attempt === 0 && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw tokenFailure();
    }
  }
}
function inside(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function privateTokenFile(stamp: Stats): void {
  const mode = stamp.mode & 0o7777;
  if (!stamp.isFile() || stamp.uid !== process.getuid?.() || stamp.nlink !== 1 || stamp.size < 1 || stamp.size > 8192 ||
      (mode !== 0o400 && mode !== 0o600)) throw tokenFailure();
}
function same(a: Stats, b: Stats): void {
  // An already-open old generation remains a valid snapshot after kubelet unlinks
  // it. nlink/ctime changes alone are allowed; content, identity and modes are not.
  if (a.dev !== b.dev || a.ino !== b.ino || a.uid !== b.uid || a.mode !== b.mode || a.size !== b.size || a.mtimeMs !== b.mtimeMs) throw tokenFailure();
}
function trustedDirectory(path: string): void {
  const uid = process.getuid?.(); if (uid === undefined) throw tokenFailure();
  const root = parse(path).root; let current = root;
  for (const part of ['', ...path.slice(root.length).split('/').filter(Boolean)]) {
    if (part) current = join(current, part);
    const stamp = fs.lstatSync(current); const mode = stamp.mode & 0o7777;
    if (!stamp.isDirectory() || (stamp.uid !== 0 && stamp.uid !== uid) ||
        ((mode & 0o022) !== 0 && !(stamp.uid === 0 && (mode & 0o1000) !== 0))) throw tokenFailure();
  }
}
function tokenFailure(): Error { return new Error('Workload identity token unavailable'); }
