import assert from 'node:assert/strict';
import test from 'node:test';
import { createGraphIdentity } from '../src/auth/graph-identity.js';
import { acaEnvironment, acaHeader, identityEnvironment, identityFixture } from './support/aca-identity.js';
import { deferred } from './support/ingress-auth.js';

const client = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resource = 'https://graph.microsoft.com/';
const context = () => ({ signal: new AbortController().signal, deadline: performance.now() + 10000 });
function envelope(change: Record<string, unknown> = {}) {
  return { access_token: 'synthetic-graph+/==', token_type: 'Bearer', resource, expires_on: Math.floor(Date.now() / 1000) + 3600, client_id: client, ...change };
}
test('Graph uses explicitly selected ACA identity and fixed resource, snapshots ID and rereads header', async t => {
  acaEnvironment(t); let expected = acaHeader; let matched = true;
  const local = await identityFixture(t, (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    matched &&= url.searchParams.get('resource') === resource && url.searchParams.get('client_id') === client && url.searchParams.get('api-version') === '2019-08-01' && req.headers['x-identity-header'] === expected;
    res.end(JSON.stringify(envelope()));
  });
  const source = createGraphIdentity(client.toUpperCase(), { request: local.request }); t.after(() => source.close());
  assert.equal(local.stats.calls, 0); assert.equal(await source.token(context()), 'synthetic-graph+/==');
  expected = 'synthetic-rotated'; identityEnvironment(t, { IDENTITY_HEADER: expected });
  assert.equal(await source.token(context()), 'synthetic-graph+/=='); assert.equal(matched, true); local.drained();
  await source.close(); await assert.rejects(source.token(context()), { message: 'Graph token unavailable' });
});
for (const [name, change] of Object.entries({
  missing: { access_token: undefined }, empty: { access_token: '' }, badToken: { access_token: 'bad token' },
  oversized: { access_token: 'x'.repeat(8193) }, type: { token_type: 'bearer' }, resource: { resource: 'https://storage.azure.com/' },
  missingResource: { resource: undefined }, expiry: { expires_on: 1 }, badExpiry: { expires_on: 'tomorrow' },
  client: { client_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, privateError: { error: 'private-sentinel' },
})) test(`Graph token rejects ${name} without leaking or caching failure`, async t => {
  acaEnvironment(t); const local = await identityFixture(t, (_req, res) => res.end(JSON.stringify(envelope(change))));
  const source = createGraphIdentity(client, { request: local.request });
  try { for (let n = 0; n < 2; n++) await assert.rejects(source.token(context()), { message: 'Graph token unavailable' }); local.drained(); assert.equal(local.stats.calls, 2); }
  finally { await source.close(); }
});
test('Graph selection refuses invalid UUID and ambient source changes before acquisition', async t => {
  acaEnvironment(t); assert.throws(() => createGraphIdentity('auto'));
  const local = await identityFixture(t, (_req, res) => res.end(JSON.stringify(envelope())));
  const source = createGraphIdentity(client, { request: local.request });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(source.token({ ...context(), signal: abort.signal }));
  await assert.rejects(source.token({ ...context(), deadline: performance.now() - 1 }));
  identityEnvironment(t, { IDENTITY_ENDPOINT: 'http://127.0.0.1/changed' });
  await assert.rejects(source.token(context())); assert.equal(local.stats.calls, 0); await source.close();
});
test('Graph identity holds actual acquisition until native request/socket drain and fences late results', async t => {
  acaEnvironment(t); const gate = deferred<void>(); const reached = deferred<void>();
  const local = await identityFixture(t, async (_req, res) => { reached.resolve(); await gate.promise; res.end(JSON.stringify(envelope())); });
  const source = createGraphIdentity(client, { request: local.request });
  const abort = new AbortController(); const pending = assert.rejects(source.token({ ...context(), signal: abort.signal }));
  await reached.promise; abort.abort(); let stopped = false;
  const closing = source.close().then(() => { stopped = true; });
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false); assert.equal(local.stats.requestCloses, 0);
    await assert.rejects(source.token(context())); gate.resolve(); await pending; await closing; local.drained();
  } finally { gate.resolve(); await source.close(); }
});
