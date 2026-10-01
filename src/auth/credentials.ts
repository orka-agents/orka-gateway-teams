import { isAbsolute, normalize } from 'node:path';
import type { Credentials, TokenCredentials } from '@microsoft/teams.api';
import { assertAcaEnvironment } from './aca.js';

export type ManagedIdentityHost = 'imds' | 'azure-container-apps';

export type SharedBotCredentialConfig =
  | { credentialMode?: 'client-secret'; clientSecret: string; certificateFile?: never; privateKeyFile?: never; managedIdentityClientId?: never; managedIdentityPrincipalId?: never; managedIdentityHost?: never;
      workloadIdentityTokenFile?: never; workloadIdentityIssuer?: never; workloadIdentitySubject?: never }
  | { credentialMode: 'certificate'; clientSecret?: never; certificateFile: string; privateKeyFile: string; managedIdentityClientId?: never; managedIdentityPrincipalId?: never; managedIdentityHost?: never;
      workloadIdentityTokenFile?: never; workloadIdentityIssuer?: never; workloadIdentitySubject?: never }
  | { credentialMode: 'managed-identity-federation'; managedIdentityClientId: string; managedIdentityPrincipalId: string; managedIdentityHost?: ManagedIdentityHost;
      clientSecret?: never; certificateFile?: never; privateKeyFile?: never; workloadIdentityTokenFile?: never; workloadIdentityIssuer?: never; workloadIdentitySubject?: never }
  | { credentialMode: 'workload-identity'; workloadIdentityTokenFile: string; workloadIdentityIssuer: string; workloadIdentitySubject: string;
      clientSecret?: never; certificateFile?: never; privateKeyFile?: never; managedIdentityClientId?: never; managedIdentityPrincipalId?: never; managedIdentityHost?: never };

/** Structural only: private material is never part of configuration or its validation. */
export function parseBotCredential(env: NodeJS.ProcessEnv): SharedBotCredentialConfig {
  const rawHost = env.TEAMS_MANAGED_IDENTITY_HOST;
  if (env.TEAMS_CREDENTIAL_MODE === 'certificate') assertCertificateEnvironment(env);
  if (env.TEAMS_CREDENTIAL_MODE === 'managed-identity-federation') assertManagedIdentityEnvironment(env, managedIdentityHost(rawHost));
  const config = validateBotCredential({ appId: env.TEAMS_APP_ID, tenantId: env.TEAMS_TENANT_ID,
    credentialMode: env.TEAMS_CREDENTIAL_MODE, clientSecret: env.TEAMS_CLIENT_SECRET,
    certificateFile: env.TEAMS_CERTIFICATE_FILE, privateKeyFile: env.TEAMS_PRIVATE_KEY_FILE,
    managedIdentityClientId: env.TEAMS_MANAGED_IDENTITY_CLIENT_ID, managedIdentityPrincipalId: env.TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID,
    managedIdentityHost: rawHost, workloadIdentityTokenFile: env.AZURE_FEDERATED_TOKEN_FILE,
    workloadIdentityIssuer: env.TEAMS_WORKLOAD_IDENTITY_ISSUER, workloadIdentitySubject: env.TEAMS_WORKLOAD_IDENTITY_SUBJECT });
  if (config.credentialMode === 'workload-identity') {
    assertWorkloadIdentityEnvironment(env, canonicalGuid(env.TEAMS_APP_ID), canonicalGuid(env.TEAMS_TENANT_ID), config.workloadIdentityTokenFile);
  }
  return config;
}

export function validateBotCredential(input: unknown): SharedBotCredentialConfig {
  if (!input || typeof input !== 'object') return fail();
  const value = input as Record<string, unknown>;
  const rawHost = value.managedIdentityHost;
  if (value.credentialMode === 'workload-identity') {
    if (['clientSecret', 'certificateFile', 'privateKeyFile', 'token', 'clientCertificate', 'managedIdentityType',
      'managedIdentityClientId', 'managedIdentityPrincipalId', 'managedIdentityHost'].some((key) => value[key] !== undefined)) fail();
    const appId = canonicalGuid(value.appId); const tenantId = canonicalGuid(value.tenantId);
    const workloadIdentityTokenFile = credentialPath(value.workloadIdentityTokenFile);
    const workloadIdentityIssuer = workloadIssuer(value.workloadIdentityIssuer, tenantId);
    const workloadIdentitySubject = workloadSubject(value.workloadIdentitySubject);
    assertWorkloadIdentityEnvironment(process.env, appId, tenantId, workloadIdentityTokenFile);
    return Object.freeze({ credentialMode: 'workload-identity', workloadIdentityTokenFile, workloadIdentityIssuer, workloadIdentitySubject });
  }
  if (['workloadIdentityTokenFile', 'workloadIdentityIssuer', 'workloadIdentitySubject'].some((key) => value[key] !== undefined)) fail();
  if (value.credentialMode === 'managed-identity-federation') {
    const host = managedIdentityHost(rawHost);
    assertManagedIdentityEnvironment(process.env, host);
    if (['clientSecret', 'certificateFile', 'privateKeyFile', 'token', 'clientCertificate', 'managedIdentityType'].some((key) => value[key] !== undefined)) fail();
    const managedIdentityClientId = canonicalGuid(value.managedIdentityClientId);
    const managedIdentityPrincipalId = canonicalGuid(value.managedIdentityPrincipalId);
    if (canonicalGuid(value.appId) === managedIdentityClientId) fail();
    return Object.freeze({ credentialMode: 'managed-identity-federation', managedIdentityClientId, managedIdentityPrincipalId,
      ...(rawHost === undefined ? {} : { managedIdentityHost: host }) });
  }
  if (value.managedIdentityClientId !== undefined || value.managedIdentityPrincipalId !== undefined || rawHost !== undefined) fail();
  if (value.credentialMode === 'certificate') {
    assertCertificateEnvironment();
    if (['clientSecret', 'token', 'clientCertificate', 'managedIdentityClientId', 'managedIdentityType'].some((key) => value[key] !== undefined)) fail();
    const certificateFile = credentialPath(value.certificateFile); const privateKeyFile = credentialPath(value.privateKeyFile);
    if (certificateFile === privateKeyFile) fail();
    return Object.freeze({ credentialMode: 'certificate', certificateFile, privateKeyFile });
  }
  if (value.credentialMode !== undefined && value.credentialMode !== 'client-secret') fail();
  if (value.certificateFile !== undefined || value.privateKeyFile !== undefined) fail();
  const clientSecret = value.clientSecret;
  if (typeof clientSecret !== 'string' || !clientSecret.trim() || clientSecret.length > 8192 || /\p{Cc}/u.test(clientSecret)) fail();
  return Object.freeze({ ...(value.credentialMode === undefined ? {} : { credentialMode: 'client-secret' as const }), clientSecret });
}

/** The SDK gives even an ambient secret precedence over its public token callback. */
export function assertCertificateEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (env.CLIENT_SECRET !== undefined || env.MANAGED_IDENTITY_CLIENT_ID !== undefined) fail();
}

/** Explicit source selection; the omitted host retains the fixed Linux IMDS contract. */
export function assertManagedIdentityEnvironment(env: NodeJS.ProcessEnv = process.env, host: ManagedIdentityHost = 'imds'): void {
  assertCertificateEnvironment(env);
  if (host === 'azure-container-apps') { assertAcaEnvironment(env); return; }
  if (host !== 'imds') fail();
  // Linux ACI injects IDENTITY_HEADER even for fixed IMDS; its value is never used or forwarded.
  if (['IDENTITY_ENDPOINT', 'MSI_ENDPOINT', 'MSI_SECRET', 'AZURE_FEDERATED_TOKEN_FILE'].some((key) => env[key] !== undefined)) fail();
}

/** AKS is an explicit source, never an ambient SDK/default-credential fallback. */
export function assertWorkloadIdentityEnvironment(env: NodeJS.ProcessEnv, appId: string, tenantId: string, tokenFile: string): void {
  assertCertificateEnvironment(env);
  if (['IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET', 'AZURE_CLIENT_SECRET', 'AZURE_CLIENT_CERTIFICATE_PATH']
    .some((key) => env[key] !== undefined)) fail();
  if ((env.AZURE_FEDERATED_TOKEN_FILE !== undefined && env.AZURE_FEDERATED_TOKEN_FILE !== tokenFile) ||
      (env.AZURE_CLIENT_ID !== undefined && canonicalGuid(env.AZURE_CLIENT_ID) !== appId.toLowerCase()) ||
      (env.AZURE_TENANT_ID !== undefined && canonicalGuid(env.AZURE_TENANT_ID) !== tenantId.toLowerCase()) ||
      (env.AZURE_AUTHORITY_HOST !== undefined && env.AZURE_AUTHORITY_HOST !== 'https://login.microsoftonline.com/')) fail();
}

/** Check the public SDK selection, not private TokenManager implementation state. */
export function assertSelectedTokenCredentials(credentials: Credentials | undefined, appId: string, tenantId: string, token: TokenCredentials['token']): void {
  assertCertificateEnvironment();
  if (!credentials || !('token' in credentials) || credentials.token !== token || credentials.clientId !== appId ||
      credentials.tenantId !== tenantId || 'clientSecret' in credentials || 'managedIdentityType' in credentials) fail();
}

export const denyBotToken: TokenCredentials['token'] = async () => { throw new Error('Bot token acquisition disabled'); };

function credentialPath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || value.endsWith('/') ||
      Buffer.byteLength(value) > 4096 || /\p{Cc}|[\uD800-\uDFFF]/u.test(value)) fail();
  return value;
}
function canonicalGuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) fail();
  return value.toLowerCase();
}
function workloadIssuer(value: unknown, tenantId: string): string {
  if (typeof value !== 'string') fail();
  const match = /^https:\/\/[a-z0-9-]+\.oic\.prod-aks\.azure\.com\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/$/u.exec(value);
  if (!match || canonicalGuid(match[1]) !== tenantId) fail();
  canonicalGuid(match[2]); return value;
}
function workloadSubject(value: unknown): string {
  if (typeof value !== 'string') fail();
  const match = /^system:serviceaccount:([^:]+):([^:]+)$/u.exec(value);
  const label = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
  if (!match || !label.test(match[1]!) || match[2]!.length > 253 || !match[2]!.split('.').every((part) => label.test(part))) fail();
  return value;
}
function managedIdentityHost(value: unknown): ManagedIdentityHost {
  if (value === undefined) return 'imds';
  if (value !== 'imds' && value !== 'azure-container-apps') fail(); return value;
}
function fail(): never { throw new Error('Invalid bot credentials'); }
