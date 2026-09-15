import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
import type { ImdsRequest } from '../../src/auth/imds.js';

const environments = new WeakMap<TestContext, Map<string, string | undefined>>();
export function identityEnvironment(t: TestContext, values: Record<string, string | undefined>) {
  let originals = environments.get(t);
  if (!originals) {
    originals = new Map(); environments.set(t, originals);
    const saved = originals;
    t.after(() => { for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    } });
  }
  for (const [name, value] of Object.entries(values)) {
    if (!originals.has(name)) originals.set(name, process.env[name]);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
export const acaEndpoint = 'http://localhost:4231/msi/token';
export const acaHeader = 'synthetic-private-aca-header';
export function acaEnvironment(t: TestContext) {
  identityEnvironment(t, { IDENTITY_ENDPOINT: acaEndpoint, IDENTITY_HEADER: acaHeader });
}

/** Only destination mapping is replaced: actual native request AND socket closes are counted. */
export async function identityFixture(t: TestContext, listener: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = http.createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const native = http.request;
  const stats = { calls: 0, requestCloses: 0, sockets: 0, socketCloses: 0, contract: true };
  const request: ImdsRequest = (url, options, callback) => {
    stats.calls++;
    stats.contract &&= options.method === 'GET' && options.agent === false && options.maxHeaderSize === 16384 &&
      url.protocol === 'http:' && ['127.0.0.1', '169.254.169.254', '[::1]', '[fe80::1]'].includes(url.hostname);
    const req = native(new URL(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`), options, callback);
    req.once('close', () => { stats.requestCloses++; });
    req.once('socket', socket => { stats.sockets++; socket.once('close', () => { stats.socketCloses++; }); });
    return req;
  };
  return { request, stats, drained() {
    assert.equal(stats.contract, true); assert.equal(stats.requestCloses, stats.calls);
    assert.equal(stats.socketCloses, stats.sockets); assert.equal(stats.sockets, stats.calls);
  } };
}
