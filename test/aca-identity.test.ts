import assert from 'node:assert/strict';
import test from 'node:test';
import https from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { JsonWebToken, PUBLIC } from '@microsoft/teams.api';
import { prepareManagedIdentity } from '../src/auth/managed-identity.js';
import { assertAcaEnvironment } from '../src/auth/aca.js';
import { assertion, entraEndpoint, entraNetwork, miConfig } from './support/managed-identity.js';
import { syntheticAccessToken } from './support/certificate.js';
import { httpsFixture } from './support/ingress-https.js';
import { acaEnvironment, acaEndpoint, acaHeader, identityEnvironment, identityFixture } from './support/aca-identity.js';

const config = { ...miConfig, managedIdentityHost: 'azure-container-apps' as const };
const failure = { message: 'Managed identity token unavailable' };
const legacyEndpoint = 'https://unused.invalid/legacy';
const legacySecret = 'synthetic-unused-legacy-header';

for (const name of ['MSI_ENDPOINT', 'MSI_SECRET']) {
  test('ACA never reads or clears the unused legacy alias: ' + name, () => {
    let accessed = false;
    const env: NodeJS.ProcessEnv = {};
    Object.defineProperty(env, name, { enumerable: true,
      get() { accessed = true; throw new Error('Unexpected legacy alias read'); },
      set() { accessed = true; throw new Error('Unexpected legacy alias write'); } });
    assert.doesNotThrow(() => assertAcaEnvironment(env));
    assert.equal(accessed, false); assert.equal(Object.hasOwn(env, name), true);
  });
}

test('ACA local assertion rotates its private header and uses real fixed HTTPS Entra/MSAL exchange and final-token cache', async (t) => {
  acaEnvironment(t); identityEnvironment(t, { MSI_ENDPOINT: legacyEndpoint, MSI_SECRET: legacySecret });
  let issued = ''; let expectedHeader = acaHeader; let localContract = true; let bytes = 0; let posts = 0; let oauthContract = true;
  const local = await identityFixture(t, (req, res) => {
    const url = new URL(req.url!, acaEndpoint);
    localContract &&= req.method === 'GET' && req.headers['x-identity-header'] === expectedHeader && req.headers.metadata === undefined &&
      url.pathname === '/msi/token' && url.searchParams.size === 3 && url.searchParams.get('api-version') === '2019-08-01' &&
      url.searchParams.get('resource') === 'api://AzureADTokenExchange' && url.searchParams.get('client_id') === miConfig.managedIdentityClientId &&
      !JSON.stringify(req.headers).includes(legacySecret);
    req.on('data', (part: Buffer) => { bytes += part.length; });
    req.on('end', () => { issued = assertion(); res.end(JSON.stringify({ access_token: issued })); });
  });
  const finalToken = syntheticAccessToken();
  const entra = await httpsFixture(t, (req, res) => {
    posts++; const parts: Buffer[] = []; req.on('data', part => parts.push(Buffer.from(part)));
    req.on('end', () => {
      const body = new URLSearchParams(Buffer.concat(parts).toString());
      oauthContract &&= body.get('scope') === 'https://api.botframework.com/.default' && body.get('client_id') === miConfig.appId &&
        body.get('client_assertion') === issued && body.get('grant_type') === 'client_credentials' && !body.has('client_secret') &&
        !JSON.stringify(req.headers).includes(acaHeader) && !Buffer.concat(parts).toString().includes(acaHeader) && req.headers['x-identity-header'] === undefined &&
        !JSON.stringify(req.headers).includes(legacySecret) && !Buffer.concat(parts).toString().includes(legacySecret);
      res.end(JSON.stringify({ access_token: finalToken, token_type: 'Bearer', expires_in: 3600 }));
    });
  });
  const native = https.request; let requestCloses = 0; let socketCloses = 0;
  t.mock.method(https, 'request', (url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    assert.equal(url.href === entraEndpoint, true); assert.equal(options.agent, false);
    const req = native(new URL(entra.baseUrl), { ...options, ca: entra.ca, servername: 'localhost' }, callback);
    req.once('close', () => { requestCloses++; }); req.once('socket', socket => socket.once('close', () => { socketCloses++; })); return req;
  });
  const prepared = prepareManagedIdentity(config); assert.equal(JSON.stringify(prepared), '{}'); assert.equal(local.stats.calls, 0);
  const token = prepared.createToken({ acaRequest: local.request }); assert.equal(local.stats.calls, 0);
  const wrapped = new JsonWebToken(await token(PUBLIC.botScope)).toString();
  assert.equal(wrapped === finalToken, true); assert.equal(wrapped.includes(acaHeader), false);
  assert.equal(process.env.MSI_ENDPOINT === legacyEndpoint && process.env.MSI_SECRET === legacySecret, true);
  expectedHeader = 'synthetic-rotated-aca-header'; process.env.IDENTITY_HEADER = expectedHeader;
  identityEnvironment(t, { MSI_ENDPOINT: '', MSI_SECRET: '' });
  assert.equal(await token([PUBLIC.botScope], miConfig.tenantId) === finalToken, true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(localContract, true); assert.equal(oauthContract, true); assert.equal(bytes, 0); assert.equal(local.stats.calls, 2);
  assert.equal(posts, 1); assert.equal(requestCloses, 1); assert.equal(socketCloses, 1); local.drained();
  assert.equal(process.env.MSI_ENDPOINT === '' && process.env.MSI_SECRET === '', true);
  await assert.rejects(async () => token('https://storage.azure.com/.default'), failure);
  await assert.rejects(async () => token(PUBLIC.graphScope), failure);
  assert.equal(local.stats.calls, 2);
});

for (const endpoint of ['http://127.0.0.1/path', 'http://127.1.2.3:1234/path', 'http://169.254.1.2/path',
  'http://localhost:4321/path', 'http://[::1]/path', 'http://[fe80::1]/path', 'http://[febf::1]/path']) {
  test('supported local ACA endpoint is structural and I/O-free: ' + endpoint, (t) => {
    acaEnvironment(t); process.env.IDENTITY_ENDPOINT = endpoint;
    assert.doesNotThrow(() => prepareManagedIdentity(config));
  });
}
for (const [name, endpoint] of Object.entries({ missing: undefined, empty: '', https: 'https://127.0.0.1/path',
  public: 'http://8.8.8.8/path', private: 'http://10.0.0.1/path', dns: 'http://metadata.internal/path',
  suffix: 'http://localhost.example/path', credentials: 'http://user@127.0.0.1/path', query: 'http://127.0.0.1/path?',
  fragment: 'http://127.0.0.1/path#', shortIP: 'http://127.1/path', hexIP: 'http://0x7f000001/path',
  privateIPv6: 'http://[fc00::1]/path', publicIPv6: 'http://[2001:db8::1]/path', outsideLinkLocal: 'http://[fec0::1]/path',
  mapped: 'http://[::ffff:127.0.0.1]/path', whitespace: ' http://127.0.0.1/path', backslash: 'http://127.0.0.1/a\\b' })) {
  test('ACA rejects unsupported endpoint before any acquisition: ' + name, (t) => {
    acaEnvironment(t); identityEnvironment(t, { IDENTITY_ENDPOINT: endpoint, MSI_ENDPOINT: acaEndpoint, MSI_SECRET: acaHeader });
    assert.throws(() => prepareManagedIdentity(config), { message: 'Invalid managed identity credentials' });
  });
}
for (const name of ['AZURE_FEDERATED_TOKEN_FILE', 'CLIENT_SECRET', 'MANAGED_IDENTITY_CLIENT_ID']) {
  test('ACA refuses competing identity selection: ' + name, (t) => {
    acaEnvironment(t); identityEnvironment(t, { MSI_ENDPOINT: legacyEndpoint, MSI_SECRET: legacySecret, [name]: '' });
    assert.throws(() => prepareManagedIdentity(config));
  });
}

test('ACA pins endpoint before acquisition and never falls back to IMDS', async (t) => {
  acaEnvironment(t); const local = await identityFixture(t, (_req, res) => res.end(JSON.stringify({ access_token: assertion() })));
  const prepared = prepareManagedIdentity(config); process.env.IDENTITY_ENDPOINT = 'http://127.0.0.1:4231/changed';
  let fallback = 0; const token = prepared.createToken({ acaRequest: local.request, imdsRequest: () => { fallback++; throw new Error(); } });
  await assert.rejects(async () => token(PUBLIC.botScope), failure); assert.equal(local.stats.calls, 0); assert.equal(fallback, 0);
});

for (const header of [undefined, '', ' ', 'bad\r\nvalue', 'x'.repeat(8193), 'nonascii-\u00e9']) {
  test('ACA rejects invalid current header without exposing it', async (t) => {
    acaEnvironment(t); identityEnvironment(t, { MSI_ENDPOINT: acaEndpoint, MSI_SECRET: acaHeader });
    const prepared = prepareManagedIdentity(config); identityEnvironment(t, { IDENTITY_HEADER: header });
    const local = await identityFixture(t, (_req, res) => res.end('{}'));
    const token = prepared.createToken({ acaRequest: local.request });
    await assert.rejects(async () => token(PUBLIC.botScope), failure); assert.equal(local.stats.calls, 0);
  });
}

for (const variant of ['redirect', 'status', 'headers', 'body', 'encoding', 'utf8', 'BOM', 'JSON', 'trailing', 'array', 'error', 'truncated', 'timeout', 'dripping']) {
  test('ACA native failure is cause-free and drains request/socket: ' + variant, { timeout: 8000 }, async (t) => {
    acaEnvironment(t);
    const local = await identityFixture(t, (_req, res) => {
      if (variant === 'timeout') return;
      if (variant === 'dripping') { const timer = setInterval(() => res.write(' '), 20); res.once('close', () => clearInterval(timer)); return; }
      if (variant === 'redirect') { res.writeHead(302, { Location: 'http://other.invalid/' }); res.end(); return; }
      if (variant === 'status') { res.writeHead(500); res.end('synthetic-private-error'); return; }
      if (variant === 'headers') res.setHeader('X-Large', 'x'.repeat(17000));
      if (variant === 'body') { res.end('x'.repeat(65537)); return; }
      if (variant === 'encoding') res.setHeader('Content-Encoding', 'gzip');
      if (variant === 'utf8') { res.end(Buffer.from([255])); return; }
      if (variant === 'BOM') { res.end('\ufeff{}'); return; }
      if (variant === 'JSON') { res.end('{'); return; }
      if (variant === 'trailing') { res.end('{}{}'); return; }
      if (variant === 'array') { res.end('[]'); return; }
      if (variant === 'error') { res.end(JSON.stringify({ error: 'synthetic-private-error', access_token: assertion() })); return; }
      if (variant === 'truncated') { res.writeHead(200, { 'Content-Length': '1000' }); res.write('{'); res.destroy(); return; }
      res.end(JSON.stringify({ access_token: assertion() }));
    });
    let posts = 0; const token = prepareManagedIdentity(config).createToken({ acaRequest: local.request,
      entraNetwork: entraNetwork(async () => { posts++; throw new Error(); }) });
    const started = performance.now();
    await assert.rejects(async () => token(PUBLIC.botScope), (error: unknown) => error instanceof Error && error.message === failure.message && error.cause === undefined);
    assert.equal(local.stats.calls, 1); assert.equal(posts, 0); local.drained();
    if (variant === 'timeout' || variant === 'dripping') assert.ok(performance.now() - started >= 4900);
  });
}

test('ACA complete 64KiB response is accepted, but assertion principal remains bot-bound', async (t) => {
  acaEnvironment(t); let valid = true; let posts = 0;
  const local = await identityFixture(t, (_req, res) => {
    const body = JSON.stringify({ access_token: assertion(valid ? {} : { sub: miConfig.appId }) });
    res.end(body + ' '.repeat(65536 - Buffer.byteLength(body)));
  });
  const token = prepareManagedIdentity(config).createToken({ acaRequest: local.request, entraNetwork: entraNetwork(async () => {
    posts++; return { status: 200, headers: {}, body: { access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 } };
  }) });
  assert.equal(typeof await token(PUBLIC.botScope), 'string'); valid = false;
  await assert.rejects(async () => token(PUBLIC.botScope), failure); assert.equal(posts, 1); local.drained();
});

test('ACA localhost is pinned directly to IPv4 and preserves the exact escaped path without DNS/proxy selection', async (t) => {
  acaEnvironment(t); process.env.IDENTITY_ENDPOINT = 'http://localhost:4321/a%20b/token';
  identityEnvironment(t, { HTTP_PROXY: 'http://other.invalid:1', NODE_USE_ENV_PROXY: '1' });
  const local = await identityFixture(t, (_req, res) => res.end(JSON.stringify({ access_token: assertion() })));
  let selected = false;
  const token = prepareManagedIdentity(config).createToken({ acaRequest: (url, options, callback) => {
    selected = url.hostname === '127.0.0.1' && url.port === '4321' && url.pathname === '/a%20b/token' && options.agent === false;
    return local.request(url, options, callback);
  }, entraNetwork: entraNetwork() });
  assert.equal(typeof await token(PUBLIC.botScope), 'string'); assert.equal(selected, true); local.drained();
});
