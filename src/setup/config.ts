import { isIP } from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import { tlsVerificationEnabled } from '../ingress/config.js';

import { parseBotCredential, validateBotCredential } from '../auth/credentials.js';
import type { SharedBotCredentialConfig } from '../auth/credentials.js';

export type SetupConfig = SharedBotCredentialConfig & {
  appId: string; tenantId: string; host: string; port: number;
  challengeFile: string; captureFile: string; timeoutMs: number;
}

export function parseSetupConfig(env: NodeJS.ProcessEnv): Readonly<SetupConfig> {
  try {
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || Object.keys(env).some((key) =>
      /^(ORKA_|INGRESS_|OUTBOUND_)/u.test(key) || ['DELIVERY_DB', 'TEAMS_RECIPIENT_IDS', 'TEAMS_SERVICE_URLS'].includes(key))) fail();
    return validateSetupConfig({ appId: guid(env.TEAMS_APP_ID), tenantId: guid(env.TEAMS_TENANT_ID),
      ...parseBotCredential(env), challengeFile: path(env.SETUP_CHALLENGE_FILE), captureFile: path(env.SETUP_CAPTURE_FILE),
      host: env.SETUP_HOST ?? '127.0.0.1', port: number(env.SETUP_PORT, 3978, 1, 65535),
      timeoutMs: number(env.SETUP_TIMEOUT_MS, 600000, 1000, 900000) });
  } catch { return fail(); }
}

/** Separate preflight: no fabricated routing allowlist and no runtime config expansion. */
export function validateSetupConfig(input: SetupConfig): Readonly<SetupConfig> {
  try {
    if (!tlsVerificationEnabled() || !isIP(input.host) || !Number.isInteger(input.port) || input.port < 0 || input.port > 65535 ||
        !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 900000) fail();
    const challengeFile = path(input.challengeFile); const captureFile = path(input.captureFile);
    if (challengeFile === captureFile) fail();
    return Object.freeze({ appId: guid(input.appId), tenantId: guid(input.tenantId), ...validateBotCredential(input),
      challengeFile, captureFile, host: input.host, port: input.port, timeoutMs: input.timeoutMs });
  } catch { return fail(); }
}

function fail(): never { throw new Error('Invalid setup configuration'); }
// Scope validation remains local; the shared credential fragment has no routing policy.
function guid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) fail();
  return value;
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || Buffer.byteLength(value) > 4096 || /\p{Cc}|[\uD800-\uDFFF]/u.test(value) ||
      normalize(value) !== value || value.endsWith('/')) fail();
  return value;
}
function number(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) fail();
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail();
  return parsed;
}
