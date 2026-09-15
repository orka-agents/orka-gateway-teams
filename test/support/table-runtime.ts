import assert from 'node:assert/strict';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { TestContext } from 'node:test';
import type { IngressScope } from '../../src/ingress/types.js';
import type { TableServeConfig } from '../../src/ingress/runtime-config.js';
import type { TableDependencies } from '../../src/storage/table/types.js';
import { httpsFixture } from './ingress-https.js';
import { identityFixture, acaEnvironment, acaHeader } from './aca-identity.js';
import { assertion, miConfig } from './managed-identity.js';
import { syntheticToken, tableService } from './table-service.js';

export const storageClientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export function tableRuntimeConfig(scope: Readonly<IngressScope>): TableServeConfig {
  return { scope, receiver: { ...miConfig, managedIdentityHost: 'azure-container-apps' }, bearerToken: 'synthetic-ingress-bearer',
    policy: { maxPending: 100, maxRecords: 100, replayWindowMs: 86400000 },
    storage: { backend: 'table-v2', account: 'example123', table: 'journal', ingressStoreId: 'stable', deliveryStoreId: 'stable',
      identity: { host: 'azure-container-apps', clientId: storageClientId },
      audit: { maxPages: 100, maxPageBytes: 10485760, maxDurationMs: 30000, maxTrackingBytes: 1048576 }, maxIndexBytes: 16777216 },
    outbound: { host: '127.0.0.1', port: 0, bearerToken: 'synthetic-outbound-bearer' } };
}

/** Native proxy only: each URL or multipart body chooses its OWN kind partition.
 * Both independent Table oracles still enforce the same physical account/table. */
export async function runtimeTableService(t: TestContext, scope: Readonly<IngressScope>) {
  const inbox = await tableService(t, 'ingress', 2, scope);
  const delivery = await tableService(t, 'delivery', 2, scope);
  const stats = { requests: 0, requestCloses: 0, sockets: 0, socketCloses: 0,
    forwarded: 0, forwardCloses: 0, forwardSockets: 0, forwardSocketCloses: 0, contract: true };
  const native = https.request;
  const router = await httpsFixture(t, async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks); const path = decodeURIComponent(req.url ?? '');
      const partitions = new Set([...path.matchAll(/PartitionKey(?:=| eq )'([^']+)'/gu)].map(match => match[1]!));
      for (const match of body.toString().matchAll(/"PartitionKey"\s*:\s*"([^"]+)"/gu)) partitions.add(match[1]!);
      const partition = [...partitions][0];
      const service = partition === 'v1_ingress_c3RhYmxl' ? inbox : partition === 'v1_delivery_c3RhYmxl' ? delivery : undefined;
      if (partitions.size !== 1 || !service) throw new Error('Invalid fixture partition');
      stats.forwarded++;
      const forward = native(new URL(req.url!, service.fixture.baseUrl), { method: req.method, headers: req.headers,
        agent: false, rejectUnauthorized: true, ca: service.fixture.ca, servername: 'localhost' }, response => {
        res.writeHead(response.statusCode!, response.headers); response.pipe(res);
        response.on('error', () => res.destroy());
      });
      forward.once('close', () => stats.forwardCloses++);
      forward.once('socket', socket => { stats.forwardSockets++; socket.once('close', () => stats.forwardSocketCloses++); });
      forward.on('error', () => res.destroy()); forward.end(body);
    } catch { stats.contract = false; res.destroy(); }
  });
  const request = ((url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
    stats.requests++;
    stats.contract &&= url.origin === 'https://example123.table.core.windows.net' && options.agent === false && options.rejectUnauthorized === true;
    const req = native(new URL(url.pathname + url.search, router.baseUrl), { ...options, hostname: '127.0.0.1', ca: router.ca, servername: 'localhost' }, callback);
    req.once('close', () => stats.requestCloses++);
    req.once('socket', socket => { stats.sockets++; socket.once('close', () => stats.socketCloses++); });
    return req;
  }) as NonNullable<TableDependencies['request']>;
  return { inbox, delivery, request, stats, drained() {
    assert.equal(stats.contract, true); assert.equal(inbox.stats.violation || delivery.stats.violation, false);
    assert.equal(stats.requests, stats.requestCloses); assert.equal(stats.sockets, stats.socketCloses);
    assert.equal(stats.forwarded, stats.forwardCloses); assert.equal(stats.forwardSockets, stats.forwardSocketCloses);
  } };
}

/** Fixed-purpose ACA fixture for the REAL storage provider and bot federation. */
export async function runtimeIdentity(t: TestContext, expirySeconds = 3600) {
  acaEnvironment(t);
  const calls = { storage: 0, bot: 0, contract: true };
  const fixture = await identityFixture(t, (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    calls.contract &&= req.headers['x-identity-header'] === acaHeader && url.pathname === '/msi/token' && url.searchParams.get('api-version') === '2019-08-01';
    const resource = url.searchParams.get('resource');
    if (resource === 'https://storage.azure.com/') {
      calls.storage++; calls.contract &&= url.searchParams.get('client_id') === storageClientId;
      res.end(JSON.stringify({ access_token: syntheticToken, resource, token_type: 'Bearer',
        client_id: storageClientId, expires_on: Math.floor(Date.now() / 1000) + expirySeconds }));
    } else if (resource === 'api://AzureADTokenExchange') {
      calls.bot++; calls.contract &&= url.searchParams.get('client_id') === miConfig.managedIdentityClientId;
      res.end(JSON.stringify({ access_token: assertion() }));
    } else { calls.contract = false; res.writeHead(400); res.end(); }
  });
  return { ...fixture, calls, drained() { assert.equal(calls.contract, true); fixture.drained(); } };
}
