import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { JsonWebToken, PUBLIC } from '@microsoft/teams.api';
import { prepareManagedIdentity } from '../src/auth/managed-identity.js';
import { assertion, entraEndpoint, entraNetwork, imdsFixture, miConfig } from './support/managed-identity.js';
import { syntheticAccessToken } from './support/certificate.js';
import { deferred } from './support/ingress-auth.js';

const failure = { message: 'Managed identity token unavailable' };
function environment(t: TestContext, name: string, value: string) {
  const before = process.env[name]; process.env[name] = value;
  t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
}

test('real CCA uses selected IMDS assertion each acquisition, including final-token cache hits, without forwarding the ACI header', async (t) => {
  const header = 'synthetic-unused-aci-header'; environment(t, 'IDENTITY_HEADER', header);
  let issued = ''; let bodyBytes = 0; let metadata = false; let get = false; let calls = 0; let headerForwarded = false;
  const imds = await imdsFixture(t, (req, res) => {
    headerForwarded ||= JSON.stringify(req.headers).includes(header) || (req.url ?? '').includes(header);
    metadata = req.headers.metadata === 'true'; get = req.method === 'GET';
    req.on('data', (bytes: Buffer) => { bodyBytes += bytes.length; });
    req.on('end', () => { issued = assertion({ marker: imds.calls() }); res.end(JSON.stringify({ access_token: issued })); });
  });
  environment(t, 'MSAL_FORCE_REGION', 'hostile-region'); environment(t, 'HTTP_PROXY', 'http://127.0.0.1:1');
  environment(t, 'NODE_USE_ENV_PROXY', '1');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No fetch/default credential chain'); });
  const response = { access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 };
  const observed = { endpoint: false, app: false, scope: false, grant: false, assertion: false, type: false, noSecret: false, noPlatformHeader: false };
  const clients = new Set<ConfidentialClientApplication>(); const acquire = ConfidentialClientApplication.prototype.acquireTokenByClientCredential;
  t.mock.method(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential', function(this: ConfidentialClientApplication, ...args: Parameters<typeof acquire>) {
    clients.add(this); return acquire.apply(this, args);
  });
  const prepared = prepareManagedIdentity(miConfig);
  assert.equal(JSON.stringify(prepared), '{}'); assert.equal(imds.calls(), 0); assert.equal(clients.size, 0);
  const token = prepared.createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork(async (url, options) => {
    calls++; const body = new URLSearchParams(options?.body);
    observed.endpoint = url === entraEndpoint; observed.app = body.get('client_id') === miConfig.appId;
    observed.scope = body.get('scope') === PUBLIC.botScope; observed.grant = body.get('grant_type') === 'client_credentials';
    observed.assertion = body.get('client_assertion') === issued;
    observed.type = body.get('client_assertion_type') === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
    observed.noSecret = !body.has('client_secret'); observed.noPlatformHeader = !JSON.stringify(options).includes(header);
    return { status: 200, headers: {}, body: response };
  }) });
  assert.equal(clients.size, 0); assert.equal(imds.calls(), 0);
  assert.equal(await token(PUBLIC.botScope) === response.access_token, true);
  assert.equal(await token([PUBLIC.botScope], miConfig.tenantId) === response.access_token, true);
  assert.equal(imds.calls(), 2); assert.equal(imds.closed(), 2); assert.equal(calls, 1); assert.equal(clients.size, 1);
  for (const [name, valid] of Object.entries(observed)) assert.equal(valid, true, name);
  assert.equal(metadata, true); assert.equal(get, true); assert.equal(bodyBytes, 0);
  assert.equal(headerForwarded, false); assert.equal(process.env.IDENTITY_HEADER === header, true);
  for (const [scope, tenant] of [[PUBLIC.graphScope, undefined], [[PUBLIC.botScope, PUBLIC.botScope], undefined],
    [[], undefined], [PUBLIC.botScope, 'common'], [PUBLIC.botScope, '']] as [string | string[], string | undefined][]) {
    await assert.rejects(async () => token(scope, tenant), failure);
  }
  assert.equal(imds.calls(), 2); assert.throws(() => prepared.createToken());
});

for (const audience of ['api://AzureADTokenExchange', 'fb60f99c-7a34-4190-8149-302f77469936']) {
  test(`proven exchange audience ${audience} permits absent unproven optional claims/metadata`, async (t) => {
    const imds = await imdsFixture(t, (_req, res) => res.end(JSON.stringify({ access_token: assertion({ aud: audience,
      sub: miConfig.managedIdentityPrincipalId.toUpperCase() }) })));
    const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork() });
    let wrapped = false; try { wrapped = typeof new JsonWebToken(await token(PUBLIC.botScope)).toString() === 'string'; } catch { /* No token diffs. */ }
    assert.equal(wrapped, true); assert.equal(imds.calls(), 1);
  });
}

for (const [name, claims] of [
  ['wrong tenant', { tid: miConfig.appId }], ['missing tenant', { tid: undefined }], ['non-string tenant', { tid: 1 }],
  ['wrong principal', { sub: miConfig.managedIdentityClientId }], ['missing principal', { sub: undefined }], ['non-string principal', { sub: [] }],
  ['wrong issuer', { iss: `https://login.microsoftonline.com/${miConfig.appId}/v2.0` }], ['v1 issuer', { iss: `https://sts.windows.net/${miConfig.tenantId}/` }],
  ['issuer trailing slash', { iss: `https://login.microsoftonline.com/${miConfig.tenantId}/v2.0/` }], ['missing issuer', { iss: undefined }],
  ['wrong resource GUID', { aud: miConfig.appId }], ['wrong audience', { aud: PUBLIC.botScope }], ['array audience', { aud: ['api://AzureADTokenExchange'] }],
  ['missing audience', { aud: undefined }], ['expired', { exp: 1 }], ['missing expiry', { exp: undefined }], ['string expiry', { exp: '9999999999' }],
  ['serialized nonfinite expiry', { exp: Infinity }], ['null expiry', { exp: null }],
] as const) test(`invalid IMDS ${name} halts before Entra and is never cached`, async (t) => {
  const imds = await imdsFixture(t, (_req, res) => res.end(JSON.stringify({ access_token: assertion(claims) }))); let calls = 0;
  const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork(async () => {
    calls++; throw new Error('Must not exchange');
  }) });
  for (let i = 0; i < 2; i++) await assert.rejects(async () => token(PUBLIC.botScope), failure);
  assert.equal(imds.calls(), 2); assert.equal(imds.closed(), 2); assert.equal(calls, 0);
});

test('JWT numeric overflow is a nonfinite expiry, not an indefinitely valid assertion', async (t) => {
  const payload = JSON.stringify({ tid: miConfig.tenantId, sub: miConfig.managedIdentityPrincipalId,
    iss: `https://login.microsoftonline.com/${miConfig.tenantId}/v2.0`, aud: 'api://AzureADTokenExchange', exp: 'overflow' }).replace('"overflow"', '1e999');
  const imds = await imdsFixture(t, (_req, res) => res.end(JSON.stringify({ access_token: ['e30', Buffer.from(payload).toString('base64url'), 'c3ludGhldGlj'].join('.') })));
  let posts = 0;
  const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest,
    entraNetwork: entraNetwork(async () => { posts++; throw new Error('No exchange'); }) });
  await assert.rejects(async () => token(PUBLIC.botScope), failure); assert.equal(imds.calls(), 1); assert.equal(posts, 0);
});

for (const offset of [9, 10, 11]) test(`assertion requires strictly more than ten seconds lifetime: ${offset}`, async (t) => {
  const now = 1900000000000; t.mock.timers.enable({ apis: ['Date'], now });
  const imds = await imdsFixture(t, (_req, res) => res.end(JSON.stringify({ access_token: assertion({ exp: now / 1000 + offset }) })));
  let posts = 0;
  const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork(async () => {
    posts++; return { status: 200, headers: {}, body: { access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 } };
  }) });
  if (offset > 10) assert.equal(typeof await token(PUBLIC.botScope), 'string');
  else await assert.rejects(async () => token(PUBLIC.botScope), failure);
  assert.equal(posts, offset > 10 ? 1 : 0);
});

for (const [name, value] of [['missing', {}], ['array', []], ['null', null], ['wrong type', { access_token: 1 }],
  ['malformed JWT', { access_token: 'a.b.c' }], ['noncanonical JWT', { access_token: 'e31.e30._w' }],
  ['oversized JWT', { access_token: 'x'.repeat(8193) }], ['error alongside token', { error: 'synthetic-private-error', access_token: assertion() }]] as const) {
  test(`IMDS response ${name} never reaches OAuth`, async (t) => {
    const imds = await imdsFixture(t, (_req, res) => res.end(JSON.stringify(value))); let posts = 0;
    const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork(async () => { posts++; throw new Error(); }) });
    await assert.rejects(async () => token(PUBLIC.botScope), failure); assert.equal(imds.calls(), 1); assert.equal(posts, 0);
  });
}

test('malformed OAuth is refused before MSAL cache and recovers with another fresh IMDS assertion', async (t) => {
  const imds = await imdsFixture(t); let calls = 0;
  const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork(async () => {
    calls++; return { status: 200, headers: {}, body: { access_token: calls === 1 ? 'a.b.c' : syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 } };
  }) });
  await assert.rejects(async () => token(PUBLIC.botScope), failure);
  for (let i = 0; i < 2; i++) assert.equal(typeof await token(PUBLIC.botScope), 'string');
  assert.equal(imds.calls(), 3); assert.equal(calls, 2);
});

test('a cached final token cannot bypass a newly invalid IMDS assertion', async (t) => {
  let valid = true; let posts = 0;
  const imds = await imdsFixture(t, (_req, res) => res.end(JSON.stringify({ access_token: assertion(valid ? {} : { sub: miConfig.appId }) })));
  const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork(async () => {
    posts++; return { status: 200, headers: {}, body: { access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 } };
  }) });
  assert.equal(typeof await token(PUBLIC.botScope), 'string'); valid = false;
  await assert.rejects(async () => token(PUBLIC.botScope), failure);
  assert.equal(imds.calls(), 2); assert.equal(posts, 1);
});

test('configured app/tenant representations remain frozen while GUID claims compare canonically and issuer paths stay exact', async (t) => {
  const appId = 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD'; const tenantId = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
  let issuer = `https://login.microsoftonline.com/${tenantId.toLowerCase()}/v2.0`; let posts = 0;
  const imds = await imdsFixture(t, (_req, res) => res.end(JSON.stringify({ access_token: assertion({ tid: tenantId,
    sub: miConfig.managedIdentityPrincipalId.toUpperCase(), iss: issuer }) })));
  const token = prepareManagedIdentity({ ...miConfig, appId, tenantId }).createToken({ imdsRequest: imds.imdsRequest,
    entraNetwork: entraNetwork(async (url, options) => {
      posts++; assert.equal(url, `https://login.microsoftonline.com/${tenantId.toLowerCase()}/oauth2/v2.0/token`);
      assert.equal(new URLSearchParams(options?.body).get('client_id') === appId, true);
      return { status: 200, headers: {}, body: { access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 } };
    }) });
  assert.equal(typeof await token(PUBLIC.botScope, tenantId), 'string');
  await assert.rejects(async () => token(PUBLIC.botScope, tenantId.toLowerCase()), failure);
  issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  await assert.rejects(async () => token(PUBLIC.botScope, tenantId), failure);
  assert.equal(imds.calls(), 2); assert.equal(posts, 1);
});

test('final token expiry refreshes through fresh IMDS and Entra, with no extra gateway cache', async (t) => {
  const now = 1900000000000; t.mock.timers.enable({ apis: ['Date'], now });
  const imds = await imdsFixture(t); let posts = 0;
  const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork(async () => {
    posts++; return { status: 200, headers: {}, body: { access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 } };
  }) });
  const first = await token(PUBLIC.botScope); t.mock.timers.setTime(now + 3601000);
  assert.equal(await token(PUBLIC.botScope) !== first, true); assert.equal(imds.calls(), 2); assert.equal(posts, 2);
});

for (const leg of ['IMDS', 'Entra', 'cached']) for (const setting of ['NODE_TLS_REJECT_UNAUTHORIZED', 'IDENTITY_ENDPOINT', 'CLIENT_SECRET']) {
  test(`${setting} changing during ${leg} fails closed`, async (t) => {
    const gate = deferred<void>(); const reached = deferred<void>(); let posts = 0;
    const imds = await imdsFixture(t, async (_req, res) => {
      if (leg === 'IMDS') { reached.resolve(); await gate.promise; }
      res.end(JSON.stringify({ access_token: assertion() }));
    });
    const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork(async () => {
      posts++; reached.resolve(); if (leg === 'Entra') await gate.promise;
      return { status: 200, headers: {}, body: { access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 } };
    }) });
    const pending = Promise.resolve(token(PUBLIC.botScope)); void pending.catch(() => {}); await reached.promise;
    if (leg === 'cached') await pending;
    environment(t, setting, setting === 'NODE_TLS_REJECT_UNAUTHORIZED' ? '0' : ''); gate.resolve();
    await assert.rejects(leg === 'cached' ? async () => token(PUBLIC.botScope) : pending, failure);
    assert.equal(posts, leg === 'IMDS' ? 0 : 1); assert.equal(imds.calls(), 1);
  });
}

for (const variant of ['redirect', 'HTTP error', 'too large', 'headers', 'encoding', 'invalid UTF8', 'BOM', 'invalid JSON', 'trailing JSON', 'truncated', 'timeout', 'dripping']) {
  test(`native IMDS rejects ${variant}, closes actual request and never retries`, { timeout: 8000 }, async (t) => {
    const imds = await imdsFixture(t, (_req, res) => {
      if (variant === 'timeout') return;
      if (variant === 'dripping') { const timer = setInterval(() => res.write(' '), 30); res.once('close', () => clearInterval(timer)); return; }
      if (variant === 'redirect') { res.writeHead(302, { Location: 'http://other.invalid/' }); res.end(); return; }
      if (variant === 'HTTP error') { res.writeHead(500); res.end('synthetic-private-error'); return; }
      if (variant === 'too large') { res.end('x'.repeat(65537)); return; }
      if (variant === 'headers') res.setHeader('X-Large', 'x'.repeat(17000));
      if (variant === 'encoding') res.setHeader('Content-Encoding', 'gzip');
      if (variant === 'invalid UTF8') { res.end(Buffer.from([0xff])); return; }
      if (variant === 'BOM') { res.end('\ufeff{}'); return; }
      if (variant === 'invalid JSON') { res.end('{'); return; }
      if (variant === 'trailing JSON') { res.end('{}{}'); return; }
      if (variant === 'truncated') { res.writeHead(200, { 'Content-Length': '1000' }); res.write('{'); res.destroy(); return; }
      res.end(JSON.stringify({ access_token: assertion() }));
    });
    let posts = 0; const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest,
      entraNetwork: entraNetwork(async () => { posts++; throw new Error('No exchange'); }) });
    const started = performance.now(); await assert.rejects(async () => token(PUBLIC.botScope), failure);
    assert.equal(imds.calls(), 1); assert.equal(imds.closed(), 1); assert.equal(posts, 0);
    if (variant === 'timeout' || variant === 'dripping') assert.ok(performance.now() - started >= 4900);
  });
}

test('native IMDS accepts inclusive 64KiB complete response, ignoring optional metadata', async (t) => {
  const imds = await imdsFixture(t, (_req, res) => {
    const text = JSON.stringify({ access_token: assertion() }); res.end(text + ' '.repeat(65536 - Buffer.byteLength(text)));
  });
  const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork() });
  assert.equal(typeof await token(PUBLIC.botScope), 'string'); assert.equal(imds.closed(), 1);
});

for (const variant of ['elapsed', 'invalid clock']) test(`native IMDS checks ${variant} even before a timeout callback can run`, async (t) => {
  const actualNow = performance.now.bind(performance); let offset = 0;
  t.mock.method(performance, 'now', () => variant === 'invalid clock' && offset ? NaN : actualNow() + offset);
  const imds = await imdsFixture(t, (_req, res) => { offset = 5001; res.end(JSON.stringify({ access_token: assertion() })); });
  let posts = 0;
  const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest,
    entraNetwork: entraNetwork(async () => { posts++; throw new Error('No late exchange'); }) });
  await assert.rejects(async () => token(PUBLIC.botScope), failure);
  assert.equal(imds.calls(), 1); assert.equal(imds.closed(), 1); assert.equal(posts, 0);
});

test('invalid wall clock fails before IMDS rather than accepting an unprovable expiry', async (t) => {
  const imds = await imdsFixture(t); const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork() });
  t.mock.method(Date, 'now', () => NaN);
  await assert.rejects(async () => token(PUBLIC.botScope), failure); assert.equal(imds.calls(), 0);
});

test('prepared MI freezes caller identities before acquisition and has no filesystem dependency', async (t) => {
  const config = { ...miConfig }; const imds = await imdsFixture(t);
  const prepared = prepareManagedIdentity(config); config.appId = miConfig.managedIdentityClientId;
  config.tenantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; config.managedIdentityPrincipalId = config.tenantId;
  const token = prepared.createToken({ imdsRequest: imds.imdsRequest, entraNetwork: entraNetwork() });
  assert.equal(typeof await token(PUBLIC.botScope), 'string'); assert.equal(imds.calls(), 1);
});

test('native synchronous request error is private and is not retried', async () => {
  let calls = 0;
  const token = prepareManagedIdentity(miConfig).createToken({ imdsRequest: () => { calls++; throw new Error('synthetic-private-transport'); }, entraNetwork: entraNetwork() });
  await assert.rejects(async () => token(PUBLIC.botScope), failure); assert.equal(calls, 1);
});
