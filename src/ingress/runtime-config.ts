import { isAbsolute } from 'node:path';
import { ConfigurationError, parseScopeConfig, parseServeSettings, parseSqliteConfig, parseStorageBackend,
  validateOutboundServerConfig, validateReceiverConfig } from './config.js';
import { validatePolicy, validateScope } from './codec.js';
import { auditConfig, auditFields } from '../storage/table/audit.js';
import { bindTable, integer } from '../storage/table/codec.js';
import type { InitConfig, ServeConfig } from './config.js';
import type { StorageIdentityConfig } from '../auth/storage-identity.js';
import type { OwnedAuditBudget } from '../storage/table/types.js';
import type { OutboundServerConfig } from '../outbound/server.js';
import type { IngressScope } from './types.js';

export type TableInitConfig = {
  storage: { backend: 'table-v2'; account: string; table: string; storeId: string; identity: StorageIdentityConfig };
  scope: Readonly<IngressScope>;
} & ({ kind: 'ingress'; audit: OwnedAuditBudget; maxIndexBytes: number } | { kind: 'delivery' });
export interface TableServeConfig extends Omit<ServeConfig, 'dbPath' | 'outbound'> {
  storage: { backend: 'table-v2'; account: string; table: string; ingressStoreId: string; deliveryStoreId?: string;
    identity: StorageIdentityConfig; audit: OwnedAuditBudget; maxIndexBytes: number };
  outbound?: OutboundServerConfig;
}
export type RuntimeServeConfig = ServeConfig | TableServeConfig;
export function parseRuntimeConfig(env: NodeJS.ProcessEnv, mode: 'init' | 'init-delivery'): InitConfig | TableInitConfig;
export function parseRuntimeConfig(env: NodeJS.ProcessEnv, mode: 'serve'): RuntimeServeConfig;
export function parseRuntimeConfig(env: NodeJS.ProcessEnv, mode: 'init' | 'init-delivery' | 'serve'): InitConfig | TableInitConfig | RuntimeServeConfig {
  try {
    if (parseStorageBackend(env) === 'sqlite') return parseSqliteConfig(env, mode);
    const scope = parseScopeConfig(env);
    const storage = { backend: 'table-v2' as const, account: env.TABLE_ACCOUNT!, table: env.TABLE_NAME!,
      identity: storageIdentity({ host: env.TABLE_MANAGED_IDENTITY_HOST, clientId: env.TABLE_MANAGED_IDENTITY_CLIENT_ID }) };
    if (mode === 'init-delivery') return snapshotTableInitConfig({ kind: 'delivery', scope,
      storage: { ...storage, storeId: env.TABLE_DELIVERY_STORE_ID! } });
    const audit = { maxPages: requiredNumber(env.TABLE_AUDIT_MAX_PAGES), maxPageBytes: requiredNumber(env.TABLE_AUDIT_MAX_BYTES),
      maxDurationMs: requiredNumber(env.TABLE_AUDIT_MAX_DURATION_MS), maxTrackingBytes: requiredNumber(env.TABLE_AUDIT_MAX_TRACKING_BYTES) };
    const maxIndexBytes = requiredNumber(env.TABLE_MAX_INDEX_BYTES);
    if (mode === 'init') return snapshotTableInitConfig({ kind: 'ingress', scope, audit, maxIndexBytes,
      storage: { ...storage, storeId: env.TABLE_INGRESS_STORE_ID! } });
    const settings = parseServeSettings(env, scope);
    const deliveryStoreId = env.TABLE_DELIVERY_STORE_ID;
    if (settings.outbound === undefined && deliveryStoreId !== undefined) throw new ConfigurationError();
    return snapshotTableServeConfig({ ...settings, storage: { ...storage, audit, maxIndexBytes, ingressStoreId: env.TABLE_INGRESS_STORE_ID!,
      ...(deliveryStoreId === undefined ? {} : { deliveryStoreId }) } });
  } catch { throw new ConfigurationError(); }
}

/** New Table inputs have a closed, captured shape; no duplicated caller bindings survive. */
export function snapshotTableServeConfig(input: TableServeConfig): TableServeConfig {
  try {
    const value = auditFields(input, ['storage', 'scope', 'receiver', 'bearerToken', 'caFile', 'policy', 'outbound']);
    const s = auditFields(value.storage, ['backend', 'account', 'table', 'ingressStoreId', 'deliveryStoreId', 'identity', 'audit', 'maxIndexBytes']);
    const scope = captureScope(value.scope);
    const receiver = validateReceiverConfig({ ...value.receiver as TableServeConfig['receiver'] });
    if (receiver.appId !== scope.appId || receiver.tenantId !== scope.tenantId) throw new ConfigurationError();
    const bearerToken = value.bearerToken;
    if (typeof bearerToken !== 'string' || bearerToken.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(bearerToken)) throw new ConfigurationError();
    const outbound = value.outbound === undefined ? undefined : validateOutboundServerConfig(
      auditFields(value.outbound, ['host', 'port', 'bearerToken']) as unknown as OutboundServerConfig, bearerToken, receiver);
    const binding = resource(s, s.ingressStoreId, 'ingress', scope);
    if (outbound) resource(s, s.deliveryStoreId, 'delivery', scope);
    else if (s.deliveryStoreId !== undefined) throw new ConfigurationError();
    const policy = Object.freeze(validatePolicy(auditFields(value.policy, ['maxPending', 'maxRecords', 'replayWindowMs'])));
    const caFile = value.caFile;
    if (caFile !== undefined && (typeof caFile !== 'string' || !isAbsolute(caFile) || caFile.length > 4096 || /\p{Cc}|[\uD800-\uDFFF]/u.test(caFile))) throw new ConfigurationError();
    return Object.freeze({ scope, receiver, bearerToken, policy, storage: Object.freeze({ backend: 'table-v2',
      account: binding.account, table: binding.table, ingressStoreId: s.ingressStoreId as string,
      ...(outbound === undefined ? {} : { deliveryStoreId: s.deliveryStoreId as string }),
      identity: storageIdentity(s.identity), ...budgets(s) }),
      ...(outbound === undefined ? {} : { outbound }), ...(caFile === undefined ? {} : { caFile }) });
  } catch { throw new ConfigurationError(); }
}

export function snapshotTableInitConfig(input: TableInitConfig): TableInitConfig {
  try {
    const value = auditFields(input, ['storage', 'scope', 'kind', 'audit', 'maxIndexBytes']);
    const s = auditFields(value.storage, ['backend', 'account', 'table', 'storeId', 'identity']);
    const scope = captureScope(value.scope); const kind = value.kind;
    if (kind !== 'ingress' && kind !== 'delivery') throw new ConfigurationError();
    const binding = resource(s, s.storeId, kind, scope);
    const storage = Object.freeze({ backend: 'table-v2' as const, account: binding.account, table: binding.table,
      storeId: s.storeId as string, identity: storageIdentity(s.identity) });
    if (kind === 'ingress') return Object.freeze({ storage, scope, kind, ...budgets(value) });
    if (value.audit !== undefined || value.maxIndexBytes !== undefined) throw new ConfigurationError();
    return Object.freeze({ storage, scope, kind });
  } catch { throw new ConfigurationError(); }
}

function captureScope(input: unknown): Readonly<IngressScope> {
  const scope = validateScope(auditFields(input, ['appId', 'tenantId', 'orkaBaseUrl', 'gatewayNamespace', 'gatewayName']));
  return parseScopeConfig({ TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, ORKA_BASE_URL: scope.orkaBaseUrl,
    ORKA_GATEWAY_NAMESPACE: scope.gatewayNamespace, ORKA_GATEWAY_NAME: scope.gatewayName });
}
function storageIdentity(input: unknown): StorageIdentityConfig {
  const value = auditFields(input, ['host', 'clientId']); const host = value.host; const clientId = value.clientId;
  if ((host !== 'imds' && host !== 'azure-container-apps') || typeof clientId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(clientId)) throw new ConfigurationError();
  return Object.freeze({ host, clientId: clientId.toLowerCase() });
}
function resource(s: Record<string, unknown>, storeId: unknown, kind: 'ingress' | 'delivery', scope: Readonly<IngressScope>) {
  if (s.backend !== 'table-v2') throw new ConfigurationError();
  return bindTable({ account: s.account as string, table: s.table as string, storeId: storeId as string,
    ...(kind === 'ingress' ? { kind, scope } : { kind, scope: { appId: scope.appId, tenantId: scope.tenantId } }) });
}
function budgets(s: Record<string, unknown>) {
  const a = auditConfig<2>({ passes: 2, record() {}, endPass() {}, finalize() {} }, s.audit as OwnedAuditBudget);
  return { audit: Object.freeze({ maxPages: a.maxPages, maxPageBytes: a.maxPageBytes, maxDurationMs: a.maxDurationMs, maxTrackingBytes: a.maxTrackingBytes }),
    maxIndexBytes: integer(s.maxIndexBytes, 1, 1024 * 1024 * 1024) };
}
function requiredNumber(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) throw new ConfigurationError();
  return integer(Number(value), 1, Number.MAX_SAFE_INTEGER);
}
