import { basename, dirname, isAbsolute, join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseBotCredential, validateBotCredential } from '../auth/credentials.js';
import type { SharedBotCredentialConfig } from '../auth/credentials.js';
import { identity, validatePolicy } from './codec.js';
import type { IngressPolicy, IngressScope } from './types.js';

export type ReceiverConfig = SharedBotCredentialConfig & { appId: string; tenantId: string; recipientIds: readonly string[];
  serviceUrls: readonly string[]; host: string; port: number }

export class ConfigurationError extends Error { constructor() { super('Invalid ingress configuration'); } }
// SDK auth flags do not override Node's process-wide TLS trust bypass.
export function tlsVerificationEnabled(): boolean { return process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0'; }
export interface InitConfig { dbPath: string; scope: Readonly<IngressScope> }
export interface OutboundConfig { dbPath: string; bearerToken: string; host: string; port: number }
export interface ServeConfig extends InitConfig { receiver: ReceiverConfig; bearerToken: string; caFile?: string; policy: IngressPolicy; outbound?: OutboundConfig }
export function parseConfig(env: NodeJS.ProcessEnv, mode: 'init' | 'init-delivery'): InitConfig;
export function parseConfig(env: NodeJS.ProcessEnv, mode: 'serve'): ServeConfig;
export function parseConfig(env: NodeJS.ProcessEnv, mode: 'init' | 'init-delivery' | 'serve'): InitConfig | ServeConfig {
  try {
    const scope = Object.freeze({ appId: guid(env.TEAMS_APP_ID), tenantId: guid(env.TEAMS_TENANT_ID),
      orkaBaseUrl: baseUrl(env.ORKA_BASE_URL), gatewayNamespace: component(env.ORKA_GATEWAY_NAMESPACE), gatewayName: component(env.ORKA_GATEWAY_NAME) });
    if (mode === 'init-delivery') {
      const dbPath = absolutePath(env.DELIVERY_DB);
      if (env.INGRESS_DB !== undefined) validateStoragePaths(env.INGRESS_DB, dbPath);
      return { dbPath, scope };
    }
    const init = { dbPath: absolutePath(env.INGRESS_DB), scope };
    if (mode === 'init') {
      if (env.DELIVERY_DB !== undefined) validateStoragePaths(init.dbPath, env.DELIVERY_DB);
      return init;
    }
    const receiver = validateReceiverConfig({ appId: scope.appId, tenantId: scope.tenantId,
      ...parseBotCredential(env), recipientIds: list(env.TEAMS_RECIPIENT_IDS).map(identity),
      serviceUrls: list(env.TEAMS_SERVICE_URLS).map((value) => baseUrl(value, true)),
      host: env.INGRESS_HOST ?? '127.0.0.1', port: number(env.INGRESS_PORT, 3978, 1, 65535) });
    const bearerToken = secret(env.ORKA_BEARER_TOKEN);
    if (!/^[A-Za-z0-9\-._~+/]+=*$/u.test(bearerToken)) fail();
    const policy = validatePolicy({ maxPending: number(env.INGRESS_MAX_PENDING, 1000),
      maxRecords: number(env.INGRESS_MAX_RECORDS, 100000), replayWindowMs: number(env.INGRESS_REPLAY_WINDOW_MS, 86400000) });
    if (env.OUTBOUND_ENABLED !== undefined && !['true', 'false'].includes(env.OUTBOUND_ENABLED)) fail();
    let outbound: OutboundConfig | undefined;
    if (env.OUTBOUND_ENABLED === 'true') {
      outbound = validateOutboundConfig({ dbPath: absolutePath(env.DELIVERY_DB), bearerToken: secret(env.ORKA_OUTBOUND_BEARER_TOKEN),
        host: env.OUTBOUND_HOST ?? '127.0.0.1', port: number(env.OUTBOUND_PORT, 3979, 1, 65535) }, init.dbPath, bearerToken, receiver);
    } else if (['DELIVERY_DB', 'ORKA_OUTBOUND_BEARER_TOKEN', 'OUTBOUND_HOST', 'OUTBOUND_PORT'].some((key) => env[key] !== undefined)) fail();
    return { ...init, receiver, bearerToken, policy, ...(outbound === undefined ? {} : { outbound }),
      ...(env.ORKA_CA_FILE === undefined ? {} : { caFile: absolutePath(env.ORKA_CA_FILE) }) };
  } catch { throw new ConfigurationError(); }
}

/** Also validate direct library callers before creating SDK credentials or binding. */
export function validateReceiverConfig(input: ReceiverConfig): ReceiverConfig {
  try {
    if (!tlsVerificationEnabled()) fail();
    if (!isIP(input.host) || !Number.isInteger(input.port) || input.port < 0 || input.port > 65535) fail();
    if (!Array.isArray(input.recipientIds) || !Array.isArray(input.serviceUrls) || !input.recipientIds.length ||
        !input.serviceUrls.length || input.recipientIds.length > 100 || input.serviceUrls.length > 100) fail();
    const serviceUrls = input.serviceUrls.map((value) => { if (baseUrl(value, true) !== value) fail(); return value; });
    return Object.freeze({ appId: guid(input.appId), tenantId: guid(input.tenantId), ...validateBotCredential(input),
      recipientIds: Object.freeze([...new Set(input.recipientIds.map(identity))]), serviceUrls: Object.freeze([...new Set(serviceUrls)]),
      host: input.host, port: input.port });
  } catch { throw new ConfigurationError(); }
}

export function validateOutboundConfig(input: OutboundConfig, ingressPath: string, ingressToken: string, receiver: ReceiverConfig): OutboundConfig {
  try {
    const bearerToken = secret(input.bearerToken);
    if (!/^[A-Za-z0-9._~+/-]+=*$/u.test(bearerToken) || bearerToken === ingressToken || !isIP(input.host) ||
        !Number.isInteger(input.port) || input.port < 0 || input.port > 65535 ||
        (input.port !== 0 && input.port === receiver.port && input.host === receiver.host)) fail();
    const dbPath = absolutePath(input.dbPath); validateStoragePaths(ingressPath, dbPath);
    return Object.freeze({ dbPath, bearerToken, host: input.host, port: input.port });
  } catch { throw new ConfigurationError(); }
}

/** Metadata-only preflight: never open/close an ordinary fd on a live SQLite inode. */
function validateStoragePaths(ingressPath: string, deliveryPath: string): void {
  try {
    const canonical = (input: string) => {
      const path = absolutePath(input); return join(realpathSync(dirname(path)), basename(path));
    };
    const ingress = canonical(ingressPath); const delivery = canonical(deliveryPath);
    const paths = [ingress, delivery, `${delivery}.owner.sqlite`].flatMap((path) =>
      [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]);
    const names = new Set<string>(); const inodes = new Set<string>();
    for (const path of paths) {
      const stamp = statSync(path, { throwIfNoEntry: false });
      const name = stamp ? realpathSync(path) : path;
      const inode = stamp ? `${stamp.dev}:${stamp.ino}` : undefined;
      if (names.has(name) || (inode !== undefined && inodes.has(inode))) fail();
      names.add(name); if (inode !== undefined) inodes.add(inode);
    }
  } catch { throw new ConfigurationError(); }
}

function fail(): never { throw new ConfigurationError(); }
function guid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) fail();
  return value;
}
function secret(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /\p{Cc}/u.test(value)) fail();
  return value;
}
function component(value: unknown): string { const result = identity(value); if (result === '.' || result === '..') fail(); return result; }
function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || /\p{Cc}|[\uD800-\uDFFF]/u.test(value)) fail();
  return value;
}
function baseUrl(value: unknown, service = false): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\s?#]|[\uD800-\uDFFF]/u.test(value)) fail();
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash ||
      value.split('/')[2]?.includes('@') || (service && url.port)) fail();
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  if (url.href.length > 2048) fail();
  return url.href;
}
function list(value: string | undefined): unknown[] {
  if (!value || value.length > 220000) fail();
  const result: unknown = JSON.parse(value);
  if (!Array.isArray(result) || !result.length || result.length > 100) fail();
  return result;
}
function number(value: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) fail();
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail();
  return parsed;
}
