import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { receiverConfig } from './ingress-auth.js';

const { clientSecret: _unused, ...receiver } = receiverConfig;
export const workloadConfig = { ...receiver, credentialMode: 'workload-identity' as const,
  workloadIdentityTokenFile: '/private/projected-identity/token',
  workloadIdentityIssuer: `https://westus2.oic.prod-aks.azure.com/${receiver.tenantId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/`,
  workloadIdentitySubject: 'system:serviceaccount:orka-system:teams' };

/** Synthetic JWT syntax only; Entra I/O is replaced at the existing network seam. */
export function projectedAssertion(claims: Record<string, unknown> = {}): string {
  return ['e30', Buffer.from(JSON.stringify({ iss: workloadConfig.workloadIdentityIssuer,
    sub: workloadConfig.workloadIdentitySubject, aud: ['api://AzureADTokenExchange'],
    exp: Math.floor(Date.now() / 1000) + 3600, nbf: Math.floor(Date.now() / 1000) - 10, ...claims })).toString('base64url'), 'c3ludGhldGlj'].join('.');
}

export function workloadFiles(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'teams-workload-identity-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token'); let generation = 0;
  fs.symlinkSync('..data/token', tokenFile);
  function rotate(claims: Record<string, unknown> = {}) {
    const name = `..generation-${++generation}`; const folder = join(directory, name); fs.mkdirSync(folder, { mode: 0o700 });
    const token = projectedAssertion(claims); const resolved = join(folder, 'token');
    fs.writeFileSync(resolved, token, { mode: 0o600, flag: 'wx' });
    fs.symlinkSync(name, join(directory, '..data-next')); fs.renameSync(join(directory, '..data-next'), join(directory, '..data'));
    return { token, resolved };
  }
  const initial = rotate();
  return { directory, tokenFile, initial, rotate, config: { ...workloadConfig, workloadIdentityTokenFile: tokenFile } };
}
