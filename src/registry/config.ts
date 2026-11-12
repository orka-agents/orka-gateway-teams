import { createHash } from 'node:crypto';
import { ConfigurationError } from '../ingress/config.js';
import type { TableServeConfig } from '../ingress/runtime-config.js';
import { parseRuntimeConfig, snapshotTableServeConfig } from '../ingress/runtime-config.js';
import { auditFields } from '../storage/table/audit.js';
import { absoluteFile, readRegistryFile } from './files.js';

export interface RegistryTarget {
  id: string; label: string; gatewayUid: string; frontAgent: Readonly<{ namespace: string; name: string }>;
  kubernetesBaseUrl: string; kubernetesTokenFile: string; kubernetesCaFile?: string;
  config: TableServeConfig; readonly identityDigest?: string;
}
export interface RegistryConfig { schemaVersion: 1; directoryTable?: string; targets: readonly RegistryTarget[] }
const perTarget = ['ORKA_BASE_URL', 'ORKA_GATEWAY_NAMESPACE', 'ORKA_GATEWAY_NAME', 'ORKA_BEARER_TOKEN', 'ORKA_OUTBOUND_BEARER_TOKEN', 'ORKA_CA_FILE', 'TABLE_INGRESS_STORE_ID', 'TABLE_DELIVERY_STORE_ID'];
const metadataKeys = ['id', 'label', 'gatewayUid', 'frontAgent', 'kubernetesBaseUrl', 'kubernetesTokenFile', 'kubernetesCaFile'];

export function canonicalKubernetesUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/u.test(value)) throw new ConfigurationError();
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.href !== value) throw new ConfigurationError();
  return value;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value || /\p{Cc}|[\uD800-\uDFFF]/u.test(value)) throw new ConfigurationError();
  return value;
}
function component(value: unknown): string {
  const name = text(value, 253);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(name)) throw new ConfigurationError();
  return name;
}
function targetMetadata(input: Record<string, unknown>, config: TableServeConfig): Omit<RegistryTarget, 'config'> {
  const id = text(input.id, 63); if (!/^[a-z][a-z0-9-]*$/u.test(id)) throw new ConfigurationError();
  const agent = auditFields(input.frontAgent, ['namespace', 'name']);
  const frontAgent = Object.freeze({ namespace: component(agent.namespace), name: component(agent.name) });
  if (frontAgent.namespace !== config.scope.gatewayNamespace) throw new ConfigurationError();
  return { id, label: text(input.label), gatewayUid: text(input.gatewayUid), frontAgent,
    kubernetesBaseUrl: canonicalKubernetesUrl(input.kubernetesBaseUrl), kubernetesTokenFile: absoluteFile(input.kubernetesTokenFile),
    ...(input.kubernetesCaFile === undefined ? {} : { kubernetesCaFile: absoluteFile(input.kubernetesCaFile) }) };
}
/** Public library boundary: callers cannot combine different shared identities or listeners. */
export function snapshotRegistry(input: RegistryConfig): RegistryConfig {
  try {
    const root = auditFields(input, ['schemaVersion', 'directoryTable', 'targets']);
    const directoryTable = root.directoryTable === undefined ? undefined : text(root.directoryTable, 63);
    if (directoryTable !== undefined && !/^[A-Za-z][A-Za-z0-9]{2,62}$/u.test(directoryTable)) throw new ConfigurationError();
    if (root.schemaVersion !== 1 || !Array.isArray(root.targets) || !root.targets.length || root.targets.length > 32) throw new ConfigurationError();
    const ids = new Set<string>(); const inboxes = new Set<string>(); const deliveries = new Set<string>(); const tokens = new Set<string>();
    let shared: string | undefined;
    const targets = root.targets.map(item => {
      const raw = auditFields(item, [...metadataKeys, 'config', 'identityDigest']);
      const config = snapshotTableServeConfig(raw.config as TableServeConfig);
      if (config.storage.backend !== 'table-v3' || !config.outbound || config.scope.orkaBaseUrl !== (raw.config as TableServeConfig).scope.orkaBaseUrl) throw new ConfigurationError();
      const metadata = targetMetadata(raw, config); const { scope, storage, receiver, policy, outbound } = config;
      if (directoryTable?.toLowerCase() === storage.table.toLowerCase()) throw new ConfigurationError();
      const common = JSON.stringify([receiver, policy, storage.account, storage.table, storage.identity, storage.audit, storage.maxIndexBytes,
        outbound.host, outbound.port, outbound.interimDelivery, outbound.meetingDrafts]);
      if (shared !== undefined && shared !== common) throw new ConfigurationError(); shared = common;
      for (const [set, value] of [[ids, metadata.id], [inboxes, storage.ingressStoreId], [deliveries, storage.deliveryStoreId!],
        [tokens, config.bearerToken], [tokens, outbound.bearerToken]] as const) {
        if (set.has(value)) throw new ConfigurationError(); set.add(value);
      }
      const identityDigest = createHash('sha256').update(JSON.stringify(['teams-target-v1', scope.appId, scope.tenantId, metadata.id,
        scope.orkaBaseUrl, metadata.kubernetesBaseUrl, scope.gatewayNamespace, scope.gatewayName, metadata.gatewayUid,
        metadata.frontAgent.namespace, metadata.frontAgent.name])).digest('hex');
      return Object.freeze({ ...metadata, config, identityDigest });
    });
    return Object.freeze({ schemaVersion: 1, ...(directoryTable === undefined ? {} : { directoryTable }), targets: Object.freeze(targets) });
  } catch { throw new ConfigurationError(); }
}
export function parseRegistryConfig(env: NodeJS.ProcessEnv): RegistryConfig {
  try {
    const captured = { ...env };
    if (captured.GATEWAY_STORAGE_BACKEND !== 'table-v3' || captured.OUTBOUND_ENABLED !== 'true' || perTarget.some(k => captured[k] !== undefined)) throw new ConfigurationError();
    const root = auditFields(JSON.parse(readRegistryFile(absoluteFile(captured.ORKA_REGISTRY_FILE), 256 * 1024, false)), ['schemaVersion', 'targets']);
    if (!Array.isArray(root.targets) || !root.targets.length || root.targets.length > 32) throw new ConfigurationError();
    const targets = root.targets.map(item => {
      const raw = auditFields(item, [...metadataKeys, 'orkaBaseUrl', 'gatewayNamespace', 'gatewayName', 'ingressStoreId', 'deliveryStoreId', 'ingressTokenFile', 'callbackTokenFile', 'orkaCaFile']);
      const parsed = parseRuntimeConfig({ ...captured, ORKA_BASE_URL: text(raw.orkaBaseUrl, 4096), ORKA_GATEWAY_NAMESPACE: text(raw.gatewayNamespace),
        ORKA_GATEWAY_NAME: text(raw.gatewayName), TABLE_INGRESS_STORE_ID: text(raw.ingressStoreId), TABLE_DELIVERY_STORE_ID: text(raw.deliveryStoreId),
        ORKA_BEARER_TOKEN: readRegistryFile(absoluteFile(raw.ingressTokenFile), 16384).trim(),
        ORKA_OUTBOUND_BEARER_TOKEN: readRegistryFile(absoluteFile(raw.callbackTokenFile), 16384).trim(),
        ...(raw.orkaCaFile === undefined ? {} : { ORKA_CA_FILE: absoluteFile(raw.orkaCaFile) }) }, 'serve');
      if (!('storage' in parsed) || parsed.scope.orkaBaseUrl !== raw.orkaBaseUrl) throw new ConfigurationError();
      return { ...targetMetadata(raw, parsed), config: parsed };
    });
    return snapshotRegistry({ schemaVersion: root.schemaVersion as 1, directoryTable: text(captured.TABLE_DIRECTORY_TABLE, 63), targets });
  } catch { throw new ConfigurationError(); }
}
