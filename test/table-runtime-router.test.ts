import assert from 'node:assert/strict';
import https from 'node:https';
import test from 'node:test';
import { scope } from './support/ingress-auth.js';
import { httpsFixture } from './support/ingress-https.js';
import { runtimeTableService } from './support/table-runtime.js';
import { syntheticToken } from './support/table-service.js';

function sendTarget(fixture: { baseUrl: string; ca: Buffer }, target: string): Promise<{ status: number | undefined; timedOut: boolean }> {
  return new Promise(resolve => {
    let status: number | undefined; let timedOut = false; let requestClosed = false; let socketClosed = true;
    const finish = () => {
      if (!requestClosed || !socketClosed) return;
      clearTimeout(timer); resolve({ status, timedOut });
    };
    // Supply the raw HTTP request-target through path, without URL normalization.
    const req = https.request({ hostname: '127.0.0.1', port: new URL(fixture.baseUrl).port,
      path: target, method: 'GET', agent: false, ca: fixture.ca, servername: 'localhost', rejectUnauthorized: true,
      headers: { host: 'example123.table.core.windows.net', authorization: `Bearer ${syntheticToken}`,
        connection: 'close', accept: 'application/json;odata=fullmetadata' } }, response => {
      status = response.statusCode; response.on('error', () => req.destroy()); response.resume();
    });
    const timer = setTimeout(() => { timedOut = true; req.destroy(); }, 5000);
    req.once('socket', socket => { socketClosed = false; socket.once('close', () => { socketClosed = true; finish(); }); });
    req.on('error', () => {});
    req.once('close', () => { requestClosed = true; finish(); }); req.end();
  });
}

for (const kind of ['ingress', 'delivery'] as const) {
  const path = `/journal(PartitionKey='v1_${kind}_c3RhYmxl',RowKey='M')`;
  for (const form of ['absolute', 'network-path', 'backslash-authority'] as const) {
    test(`Table router rejects ${form} authority before forwarding ${kind}`, async t => {
      const tables = await runtimeTableService(t, scope);
      let connections = 0;
      // Any attempted escape targets only this owned listener, never an external host.
      const other = await httpsFixture(t, (_req, res) => { res.writeHead(204); res.end(); });
      other.server.on('connection', () => { connections++; });
      const authority = `127.0.0.1:${new URL(other.baseUrl).port}`;
      const target = form === 'absolute' ? `https://${authority}${path}` :
        form === 'network-path' ? `//${authority}${path}` : `/\\${authority}${path}`;
      const result = await sendTarget(tables.fixture, target);
      assert.equal(result.timedOut, false);
      assert.equal(result.status, undefined);
      assert.equal(tables.stats.forwarded, 0, 'rejected target must not open a forward request');
      assert.equal(connections, 0, 'rejected target must not connect to another owned listener');
      assert.equal(tables.stats.forwardSockets, 0);
      assert.equal(tables.inbox.rows.size + tables.delivery.rows.size, 0);
    });
  }
  test(`Table router preserves origin-form point reads for ${kind}`, async t => {
    const tables = await runtimeTableService(t, scope);
    const result = await sendTarget(tables.fixture, path);
    assert.equal(result.timedOut, false); assert.equal(result.status, 404);
    assert.equal(tables.stats.forwarded, 1);
    assert.equal(tables[kind === 'ingress' ? 'inbox' : 'delivery'].stats.reads, 1);
    assert.equal(tables[kind === 'ingress' ? 'delivery' : 'inbox'].stats.reads, 0);
    tables.drained();
  });
}
