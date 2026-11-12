import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiverConfig, scope } from './ingress-auth.js';
import type { FixtureHooks } from './ingress-https.js';
import { storageClientId, tableRuntimeConfig } from './table-runtime.js';

export function registryInput(count = 2) {
  return { schemaVersion: 1 as const, directoryTable: 'Directory', targets: Array.from({ length: count }, (_, i) => i === 0 ? 'primary' : i === 1 ? 'tools' : `target-${i}`).map(id => {
    const config = tableRuntimeConfig({ ...scope, ...(id === 'primary' ? {} : { orkaBaseUrl: 'https://tools.example.invalid/' }) });
    config.receiver = { ...receiverConfig }; config.storage.backend = 'table-v3';
    config.storage.ingressStoreId = `${id}-inbox`; config.storage.deliveryStoreId = `${id}-delivery`;
    config.bearerToken = `ingress-${id}`; config.outbound!.bearerToken = `callback-${id}`;
    return { id, label: id, gatewayUid: 'gateway-uid', frontAgent: { namespace: 'default', name: 'front' },
      kubernetesBaseUrl: 'https://kubernetes.example.invalid/', kubernetesTokenFile: '/missing/token.json', config };
  }) };
}
export function registryFixture(t: FixtureHooks) {
  const directory = mkdtempSync(join(tmpdir(), 'registry-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = registryInput();
  const manifest = { schemaVersion: 1, targets: input.targets.map(target => {
    const ingressTokenFile = join(directory, `${target.id}-ingress`); const callbackTokenFile = join(directory, `${target.id}-callback`);
    writeFileSync(ingressTokenFile, target.config.bearerToken, { mode: 0o600 });
    writeFileSync(callbackTokenFile, target.config.outbound!.bearerToken, { mode: 0o600 });
    return { id: target.id, label: target.label, ...target.config.scope, appId: undefined, tenantId: undefined,
      gatewayUid: target.gatewayUid, frontAgent: target.frontAgent, ingressStoreId: target.config.storage.ingressStoreId,
      deliveryStoreId: target.config.storage.deliveryStoreId!, ingressTokenFile, callbackTokenFile,
      kubernetesBaseUrl: target.kubernetesBaseUrl, kubernetesTokenFile: target.kubernetesTokenFile };
  }) };
  const path = join(directory, 'registry.json'); const save = () => writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 }); save();
  const env = { ORKA_GROUP_POLICY_FILE: join(directory, 'group-policy.json'), ORKA_REGISTRY_FILE: path, GATEWAY_STORAGE_BACKEND: 'table-v3', OUTBOUND_ENABLED: 'true',
    TEAMS_APP_ID: scope.appId, TEAMS_TENANT_ID: scope.tenantId, TEAMS_CLIENT_SECRET: receiverConfig.clientSecret,
    TEAMS_RECIPIENT_IDS: JSON.stringify(receiverConfig.recipientIds), TEAMS_SERVICE_URLS: JSON.stringify(receiverConfig.serviceUrls),
    TABLE_ACCOUNT: 'example123', TABLE_NAME: 'journal', TABLE_DIRECTORY_TABLE: 'Directory', TABLE_MANAGED_IDENTITY_HOST: 'azure-container-apps', TABLE_MANAGED_IDENTITY_CLIENT_ID: storageClientId,
    TABLE_AUDIT_MAX_PAGES: '100', TABLE_AUDIT_MAX_BYTES: '10485760', TABLE_AUDIT_MAX_DURATION_MS: '30000',
    TABLE_AUDIT_MAX_TRACKING_BYTES: '1048576', TABLE_MAX_INDEX_BYTES: '16777216' };
  return { directory, manifest, env, save };
}
