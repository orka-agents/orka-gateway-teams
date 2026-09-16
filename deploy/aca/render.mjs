import { readFileSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// File-only preparation. This module never initializes stores, contacts Azure,
// obtains secrets, reads a capture, deploys, or authorizes a lifecycle transition.
const fail = () => { throw new Error('invalid-input'); };
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const namePattern = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u;
const nginxImage = 'nginxinc/nginx-unprivileged:stable-alpine@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce';
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail();
  return value;
}
function text(value, pattern, max = 2048) {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('REQUIRED') || !pattern.test(value)) fail();
  return value;
}
function opaqueId(value) {
  text(value, /^[^\p{Cc}\uD800-\uDFFF]+$/u, 256);
  if (Buffer.byteLength(value) > 256 || /^\p{White_Space}|\p{White_Space}$/u.test(value)) fail();
  return value;
}
function integer(value, max = Number.MAX_SAFE_INTEGER, min = 1) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}
function resourceId(value, provider, kind) {
  text(value, /^\/subscriptions\//u);
  const parts = value.split('/');
  if (parts.length !== 9 || parts[1] !== 'subscriptions' || !guidPattern.test(parts[2]) || parts[3] !== 'resourceGroups' ||
      parts[5] !== 'providers' || parts[6] !== provider || parts[7] !== kind) fail();
  text(parts[4], /^[A-Za-z0-9_-][A-Za-z0-9_.()-]{0,89}$/u);
  text(parts[8], /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u);
  return value;
}
function identityId(value) { return resourceId(value, 'Microsoft.ManagedIdentity', 'userAssignedIdentities'); }
function appName(value, fallback) {
  const name = value === undefined ? fallback : text(value, namePattern, 32);
  if (name.includes('--')) fail();
  return name;
}
function httpsUrl(value, service = false) {
  text(value, /^[^\\\s?#\p{Cc}\uD800-\uDFFF]+$/u);
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || value.split('/')[2].includes('@') ||
      (service && url.port)) fail();
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  if (url.href.length > 2048) fail();
  return url.href;
}
function cidr(value) {
  text(value, /^\d+(?:\.\d+){3}\/\d{1,2}$/u);
  const [ip, prefix] = value.split('/');
  if (!isIPv4(ip) || Number(prefix) < 1 || Number(prefix) > 32) fail();
  return value;
}
// ARM treats strings starting with '[' as expressions, including JSON allowlists.
function env(values) {
  return Object.entries(values).map(([name, raw]) => {
    const value = String(raw); return { name, value: value.startsWith('[') ? '[' + value : value };
  });
}
function probes(port, tcp = false) {
  return ['Startup', 'Readiness', 'Liveness'].map((type) => ({ type,
    ...(tcp ? { tcpSocket: { port } } : { httpGet: { path: '/healthz', port, scheme: 'HTTP' } }),
    initialDelaySeconds: type === 'Liveness' && !tcp ? 10 : 3, periodSeconds: 10, timeoutSeconds: 2,
    failureThreshold: type === 'Startup' ? (tcp ? 30 : 10) : 3, successThreshold: 1 }));
}
function secretVolume(name, secretRef, path) { return { name, storageType: 'Secret', secrets: [{ secretRef, path }] }; }
function botEnvironment(input) {
  const bot = object(input, ['appId', 'tenantId', 'clientId', 'principalId']);
  const appId = text(bot.appId, guidPattern); const clientId = text(bot.clientId, guidPattern);
  if (appId.toLowerCase() === clientId.toLowerCase()) fail();
  return { TEAMS_APP_ID: appId, TEAMS_TENANT_ID: text(bot.tenantId, guidPattern),
    TEAMS_CREDENTIAL_MODE: 'managed-identity-federation', TEAMS_MANAGED_IDENTITY_HOST: 'azure-container-apps',
    TEAMS_MANAGED_IDENTITY_CLIENT_ID: clientId, TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID: text(bot.principalId, guidPattern) };
}

export function render(stage, input) {
  if (!['setup', 'proxy', 'runtime'].includes(stage)) fail();
  const commonKeys = ['location', 'environmentId', 'gatewayAppName', 'proxyAppName'];
  const mainKeys = ['registryServer', 'identityResourceId', 'operatorAksEgressCidr', 'bot', 'image'];
  const config = object(input, [...commonKeys, ...(stage === 'proxy' ? [] : mainKeys),
    ...(stage === 'setup' ? ['timeoutMs'] : stage === 'runtime' ? ['table', 'orka', 'approvedRecipientId', 'approvedServiceUrl'] : [])]);
  const location = text(config.location, /^[a-z][a-z0-9]{1,31}$/u);
  const environmentId = resourceId(config.environmentId, 'Microsoft.App', 'managedEnvironments');
  const gatewayName = appName(config.gatewayAppName, 'orka-teams-gateway');
  const proxyName = appName(config.proxyAppName, 'orka-teams-public');
  if (gatewayName === proxyName) fail();
  const configuration = { activeRevisionsMode: 'Single' };
  // Single revision and one replica are NOT proof that a previous owner stopped.
  // ACA uses image non-root users and writable ephemeral /tmp (1777), not the
  // Kubernetes read-only-rootfs/tmpfs profile. No fsGroup/EmptyDir parity is claimed.
  const template = { containers: [], scale: { minReplicas: 1, maxReplicas: 1, rules: [] } };
  const app = { type: 'Microsoft.App/containerApps', apiVersion: '2025-07-01', name: stage === 'proxy' ? proxyName : gatewayName,
    location, identity: { type: 'None' }, properties: { environmentId, workloadProfileName: 'Consumption', configuration, template } };
  const document = { $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0', resources: [app] };
  if (stage === 'proxy') {
    const nginx = readFileSync(new URL('./nginx.conf', import.meta.url), 'utf8')
      .replace('proxy_pass http://orka-teams-gateway:3978;', `proxy_pass http://${gatewayName}:3978;`);
    configuration.secrets = [{ name: 'nginx-config', value: nginx }];
    configuration.ingress = { external: true, targetPort: 8080, transport: 'http', allowInsecure: false };
    template.containers = [{ name: 'proxy', image: nginxImage,
      command: ['nginx', '-c', '/etc/nginx/nginx.conf', '-g', 'daemon off;'], args: [],
      resources: { cpu: 0.25, memory: '0.5Gi' }, probes: probes(8081).slice(0, 2),
      volumeMounts: [{ volumeName: 'nginx-config', mountPath: '/etc/nginx' }] }];
    template.volumes = [secretVolume('nginx-config', 'nginx-config', 'nginx.conf')];
    return document;
  }
  const registry = text(config.registryServer, /^[a-z0-9]{5,50}\.azurecr\.io$/u);
  const image = text(config.image, /^[a-z0-9.-]+\/[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?@sha256:[0-9a-f]{64}$/u);
  if (!image.startsWith(registry + '/')) fail();
  const identity = identityId(config.identityResourceId);
  app.identity = { type: 'UserAssigned', userAssignedIdentities: { [identity]: {} } };
  configuration.identitySettings = [{ identity, lifecycle: 'Main' }];
  configuration.registries = [{ server: registry, identity }];
  configuration.ingress = { external: true, targetPort: 3979, transport: 'http', allowInsecure: false,
    ipSecurityRestrictions: [{ name: 'approved-orka-egress', action: 'Allow', ipAddressRange: cidr(config.operatorAksEgressCidr) }],
    additionalPortMappings: [{ external: false, targetPort: 3978, exposedPort: 3978 }] };
  const variables = botEnvironment(config.bot);
  const container = { name: stage === 'setup' ? 'setup' : 'gateway', image,
    command: ['node', stage === 'setup' ? '/app/aca-setup-supervisor.mjs' : '/app/dist/ingress/main.js'],
    args: stage === 'setup' ? [] : ['serve'], env: [], resources: { cpu: 0.5, memory: '1Gi' },
    probes: probes(stage === 'setup' ? 3980 : 3979, stage === 'runtime') };
  template.containers = [container];
  if (stage === 'setup') {
    container.env = env({ ...variables, SETUP_TIMEOUT_MS: integer(config.timeoutMs, 900000, 1000) });
    return document;
  }
  const table = object(config.table, ['account', 'name', 'ingressStoreId', 'deliveryStoreId', 'identityResourceId', 'clientId', 'audit']);
  const audit = object(table.audit, ['maxPages', 'maxBytes', 'maxDurationMs', 'maxTrackingBytes', 'maxIndexBytes']);
  const orka = object(config.orka, ['baseUrl', 'gatewayNamespace', 'gatewayName']);
  const storageIdentity = identityId(table.identityResourceId);
  if (storageIdentity !== identity) {
    app.identity.userAssignedIdentities[storageIdentity] = {};
    configuration.identitySettings.push({ identity: storageIdentity, lifecycle: 'Main' });
  }
  container.env = env({ ...variables, GATEWAY_STORAGE_BACKEND: 'table-v2',
    TABLE_ACCOUNT: text(table.account, /^[a-z0-9]{3,24}$/u), TABLE_NAME: text(table.name, /^[A-Za-z][A-Za-z0-9]{2,62}$/u),
    TABLE_INGRESS_STORE_ID: opaqueId(table.ingressStoreId), TABLE_DELIVERY_STORE_ID: opaqueId(table.deliveryStoreId),
    TABLE_MANAGED_IDENTITY_HOST: 'azure-container-apps', TABLE_MANAGED_IDENTITY_CLIENT_ID: text(table.clientId, guidPattern),
    TABLE_AUDIT_MAX_PAGES: integer(audit.maxPages), TABLE_AUDIT_MAX_BYTES: integer(audit.maxBytes),
    TABLE_AUDIT_MAX_DURATION_MS: integer(audit.maxDurationMs, 2147483647), TABLE_AUDIT_MAX_TRACKING_BYTES: integer(audit.maxTrackingBytes, 268435456),
    TABLE_MAX_INDEX_BYTES: integer(audit.maxIndexBytes, 1073741824),
    ORKA_BASE_URL: httpsUrl(orka.baseUrl), ORKA_GATEWAY_NAMESPACE: text(orka.gatewayNamespace, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
    ORKA_GATEWAY_NAME: text(orka.gatewayName, /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u),
    // Operator enters these only after protected manual capture review/confirmation.
    TEAMS_RECIPIENT_IDS: JSON.stringify([opaqueId(config.approvedRecipientId)]),
    TEAMS_SERVICE_URLS: JSON.stringify([httpsUrl(config.approvedServiceUrl, true)]),
    INGRESS_HOST: '0.0.0.0', INGRESS_PORT: '3978', OUTBOUND_ENABLED: 'true', OUTBOUND_HOST: '0.0.0.0', OUTBOUND_PORT: '3979',
    ORKA_CA_FILE: '/run/orka-ca/ca.crt' });
  container.env.push({ name: 'ORKA_BEARER_TOKEN', secretRef: 'orka-inbound' }, { name: 'ORKA_OUTBOUND_BEARER_TOKEN', secretRef: 'orka-outbound' });
  document.parameters = { orkaBearerToken: { type: 'secureString' }, orkaOutboundBearerToken: { type: 'secureString' }, orkaPublicCa: { type: 'string' } };
  configuration.secrets = [{ name: 'orka-inbound', value: "[parameters('orkaBearerToken')]" },
    { name: 'orka-outbound', value: "[parameters('orkaOutboundBearerToken')]" }, { name: 'orka-public-ca', value: "[parameters('orkaPublicCa')]" }];
  template.volumes = [secretVolume('orka-ca', 'orka-public-ca', 'ca.crt')];
  container.volumeMounts = [{ volumeName: 'orka-ca', mountPath: '/run/orka-ca' }];
  return document;
}

function main(args) {
  try {
    if (args.length !== 6) fail();
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i];
      if (!['--stage', '--config', '--out'].includes(key) || options[key] !== undefined || !args[i + 1]) fail();
      options[key] = args[i + 1];
    }
    const config = JSON.parse(readFileSync(options['--config'], 'utf8'));
    const document = render(options['--stage'], config);
    // Existing explicit output directory; exclusive creation refuses overwrite/reuse.
    // No stdout templates or diagnostic input values, even on filesystem failure.
    writeFileSync(join(options['--out'], `${options['--stage']}-app.arm.json`), JSON.stringify(document, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
  } catch {
    process.stderr.write('aca-render: invalid-input\n'); process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
