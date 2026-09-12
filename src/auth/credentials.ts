import { isAbsolute, normalize } from 'node:path';
import type { Credentials, TokenCredentials } from '@microsoft/teams.api';

export type SharedBotCredentialConfig =
  | { credentialMode?: 'client-secret'; clientSecret: string; certificateFile?: never; privateKeyFile?: never }
  | { credentialMode: 'certificate'; clientSecret?: never; certificateFile: string; privateKeyFile: string };

/** Structural only: private material is never part of configuration or its validation. */
export function parseBotCredential(env: NodeJS.ProcessEnv): SharedBotCredentialConfig {
  if (env.TEAMS_CREDENTIAL_MODE === 'certificate') assertCertificateEnvironment(env);
  return validateBotCredential({ credentialMode: env.TEAMS_CREDENTIAL_MODE, clientSecret: env.TEAMS_CLIENT_SECRET,
    certificateFile: env.TEAMS_CERTIFICATE_FILE, privateKeyFile: env.TEAMS_PRIVATE_KEY_FILE });
}

export function validateBotCredential(input: unknown): SharedBotCredentialConfig {
  if (!input || typeof input !== 'object') return fail();
  const value = input as Record<string, unknown>;
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
function fail(): never { throw new Error('Invalid bot credentials'); }
