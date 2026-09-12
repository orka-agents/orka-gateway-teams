import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import https from 'node:https';
import type { RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import test from 'node:test';
import type { TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { JsonWebToken, PUBLIC } from '@microsoft/teams.api';
import { ConfidentialClientApplication } from '@azure/msal-node';
import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from '@azure/msal-node';
import { prepareCertificate } from '../src/auth/certificate.js';
import { createCertificateNetwork, validateOAuthSuccess } from '../src/auth/network.js';
import { certificateFiles, syntheticAccessToken } from './support/certificate.js';
import { deferred, tenantId } from './support/ingress-auth.js';
import { httpsFixture } from './support/ingress-https.js';

const endpoint = `${PUBLIC.loginEndpoint}/${tenantId}/oauth2/v2.0/token`;
const success = () => ({ access_token: syntheticAccessToken(), token_type: 'Bearer', expires_in: 3600 });
function network(post: (url: string, options?: NetworkRequestOptions) => Promise<NetworkResponse<unknown>>): INetworkModule {
  return { sendGetRequestAsync: async () => { throw new Error('Unexpected discovery'); },
    sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) => post(url, options) as Promise<NetworkResponse<T>> };
}
function restoreEnv(t: TestContext, name: string, value: string): void {
  const before = process.env[name]; process.env[name] = value;
  t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
}

test('real MSAL PS256 assertion and fixed scope/tenant use bundled metadata despite hostile region, then reuse MSAL cache', async (t) => {
  const f = certificateFiles(t); let calls = 0; const response = success();
  const observed = { url: false, scope: false, grant: false, noSecret: false, signature: false, issuer: false, subject: false, audience: false, thumbprint: false, noLegacy: false };
  restoreEnv(t, 'MSAL_FORCE_REGION', 'hostile-region');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not use default fetch'); });
  const token = prepareCertificate(f.config).createToken(network(async (url, options) => {
    calls++; observed.url = url === endpoint;
    const body = new URLSearchParams(options?.body); observed.scope = body.get('scope') === PUBLIC.botScope;
    observed.grant = body.get('grant_type') === 'client_credentials'; observed.noSecret = !body.has('client_secret');
    const assertion = body.get('client_assertion');
    try {
      // MSAL TimeUtils rounds seconds; jsonwebtoken floors them. Allow that
      // one-second boundary in fixture verification, not in production token checks.
      const claims = jwt.verify(assertion!, f.certificate.publicKey, { algorithms: ['PS256'], complete: true, clockTolerance: 1 });
      observed.signature = typeof claims !== 'string' && claims.header.alg === 'PS256';
      observed.issuer = typeof claims.payload !== 'string' && claims.payload.iss === f.config.appId;
      observed.subject = typeof claims.payload !== 'string' && claims.payload.sub === f.config.appId;
      observed.audience = typeof claims.payload !== 'string' && claims.payload.aud === endpoint;
      observed.thumbprint = typeof claims !== 'string' && claims.header['x5t#S256'] === createHash('sha256').update(f.certificate.raw).digest('base64url');
      observed.noLegacy = typeof claims !== 'string' && !('x5t' in claims.header) && !('x5c' in claims.header);
    } catch { /* Assertion/claims never enter assertion failure output. */ }
    return { status: 200, headers: {}, body: response };
  }));
  assert.equal(await token(PUBLIC.botScope) === response.access_token, true);
  for (const [name, valid] of Object.entries(observed)) assert.equal(valid, true, name);
  assert.equal(await token([PUBLIC.botScope], f.config.tenantId) === response.access_token, true); assert.equal(calls, 1);
  for (const [scope, tenant] of [[PUBLIC.graphScope, undefined], [[PUBLIC.botScope, PUBLIC.botScope], undefined],
    [[], undefined], [PUBLIC.botScope, 'common'], [PUBLIC.botScope, '']] as [string | string[], string | undefined][]) {
    await assert.rejects(async () => token(scope, tenant), { message: 'Certificate token unavailable' });
  }
  assert.equal(calls, 1);
});

test('malformed three-part token rejects before real MSAL caching, then recovers through network and SDK wrapping', async (t) => {
  const f = certificateFiles(t); let calls = 0; const response = success();
  const token = prepareCertificate(f.config).createToken(network(async () => {
    calls++; return { status: 200, headers: {}, body: calls === 1 ? { ...response, access_token: 'a.b.c' } : response };
  }));
  await assert.rejects(async () => token(PUBLIC.botScope), { message: 'Certificate token unavailable' });
  assert.equal(calls, 1);
  for (let delivery = 0; delivery < 2; delivery++) {
    let wrapped = false;
    try { wrapped = new JsonWebToken(await token(PUBLIC.botScope)).toString() === response.access_token; }
    catch { /* Neither SDK decode errors nor token contents enter assertion output. */ }
    assert.equal(wrapped, true); assert.equal(calls, 2);
  }
});

for (const part of ['header', 'payload', 'signature'] as const) {
  for (const [name, segment] of [
    ['empty', ''], ['invalid length', 'a'], ['invalid trailing length', 'e30aa'],
    ['noncanonical pad bits', 'e31'], ['noncanonical two-character pad bits', '_x'],
    ['padding', 'e30='], ['standard base64 alphabet', '+w'], ['slash alphabet', '/w'],
    ['whitespace', 'e30\n'], ['extra segment', 'e30.e30'],
  ]) {
    test(`OAuth token syntax rejects ${part} ${name}`, () => {
      const parts = { header: 'e30', payload: 'e30', signature: '_w', [part]: segment };
      const access_token = [parts.header, parts.payload, parts.signature].join('.');
      assert.throws(() => validateOAuthSuccess({ ...success(), access_token }), { message: 'Certificate token unavailable' });
    });
  }
}

for (const part of ['header', 'payload'] as const) {
  for (const [name, bytes] of [
    ['invalid UTF8 inside JSON string', Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')])],
    ['truncated UTF8', Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xe2, 0x82]), Buffer.from('"}')])],
    ['overlong UTF8', Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')])],
    ['UTF8 surrogate', Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('"}')])],
    ['UTF8 BOM', Buffer.from('\ufeff{}')], ['invalid JSON', Buffer.from('{')],
    ['trailing JSON', Buffer.from('{}{}')], ['trailing comma', Buffer.from('{"value":1,}')],
    ['null', Buffer.from('null')], ['array', Buffer.from('[]')], ['string', Buffer.from('"value"')],
    ['number', Buffer.from('1')], ['boolean', Buffer.from('true')],
  ] as const) {
    test(`OAuth token syntax rejects ${part} ${name}`, () => {
      const parts = { header: 'e30', payload: 'e30', signature: '_w', [part]: bytes.toString('base64url') };
      const access_token = [parts.header, parts.payload, parts.signature].join('.');
      assert.throws(() => validateOAuthSuccess({ ...success(), access_token }), { message: 'Certificate token unavailable' });
    });
  }
}

for (const [name, header, payload] of [
  ['empty objects without required claims', '{}', '{}'],
  ['Unicode object strings', '{"label":"café"}', '{"app_displayname":"日本語"}'],
  ['JSON whitespace and nested values', ' \n{}\t', '{"nested":{"values":[null,true,1]}}\r\n'],
  ['opaque algorithm and claims', '{"alg":"synthetic"}', '{"iss":"synthetic","aud":"other","tid":"other"}'],
] as const) {
  test(`OAuth token syntax permits ${name} and public SDK wrapping`, () => {
    const access_token = [Buffer.from(header).toString('base64url'), Buffer.from(payload).toString('base64url'), '_w'].join('.');
    let compatible = false;
    try {
      const body = validateOAuthSuccess({ ...success(), access_token });
      const wrapped = new JsonWebToken(access_token);
      compatible = body.access_token === access_token && wrapped.toString() === access_token &&
        (name !== 'Unicode object strings' || wrapped.appDisplayName === '日本語');
    } catch { /* Keep parser errors and synthetic payloads out of test output. */ }
    assert.equal(compatible, true);
  });
}

for (const [size, signature, accepted] of [[8191, 'AA', true], [8192, 'AAA', true], [8193, 'AAAA', false]] as const) {
  test(`OAuth token syntax enforces the ${size}-character boundary with canonical segments`, () => {
    const payload = Buffer.from(JSON.stringify({ padding: 'x'.repeat(6124) })).toString('base64url');
    const access_token = ['e30', payload, signature].join('.');
    assert.equal(access_token.length, size);
    const body = { ...success(), access_token };
    if (!accepted) assert.throws(() => validateOAuthSuccess(body), { message: 'Certificate token unavailable' });
    else {
      let compatible = false;
      try { compatible = validateOAuthSuccess(body).access_token === access_token && new JsonWebToken(access_token).toString() === access_token; }
      catch { /* Keep parser errors and synthetic payloads out of test output. */ }
      assert.equal(compatible, true);
    }
  });
}

for (const invalid of [{ status: 302 }, { status: 201 }, { body: { error: 'synthetic-private-response' } },
  { body: { expires_in: 0 } }, { body: { expires_in: Infinity } }, { body: { expires_in: '3600garbage' } },
  { body: { access_token: '' } }, { body: { access_token: 'not-jwt' } }, { body: { access_token: 'x'.repeat(8193) } },
  { body: { token_type: 'PoP' } }, { body: { ext_expires_in: -1 } }, { body: { refresh_in: 'bad' } },
  { body: { scope: PUBLIC.graphScope } }, { body: { client_info: {} } }]) {
  test(`invalid OAuth response ${Object.keys(invalid.body ?? invalid).join(',')} is rejected before MSAL cache`, async (t) => {
    const f = certificateFiles(t); let calls = 0;
    const token = prepareCertificate(f.config).createToken(network(async () => {
      calls++; return { status: invalid.status ?? 200, headers: {}, body: { ...success(), ...invalid.body } };
    }));
    await assert.rejects(async () => token(PUBLIC.botScope), { message: 'Certificate token unavailable' });
    await assert.rejects(async () => token(PUBLIC.botScope), { message: 'Certificate token unavailable' });
    assert.equal(calls, 2);
  });
}

for (const mode of ['expired pending', 'TLS pending', 'expired cached', 'TLS cached', 'invalid result expiry'] as const) {
  test(`validity fences ${mode} including after actual MSAL work`, async (t) => {
    const f = certificateFiles(t); const gate = deferred<void>(); const reached = deferred<void>(); let calls = 0;
    const token = prepareCertificate(f.config).createToken(network(async () => {
      calls++; reached.resolve(); await gate.promise; return { status: 200, headers: {}, body: success() };
    }));
    if (mode === 'invalid result expiry') {
      const acquire = ConfidentialClientApplication.prototype.acquireTokenByClientCredential;
      t.mock.method(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential', async function(this: ConfidentialClientApplication, ...args: Parameters<typeof acquire>) {
        const result = await acquire.apply(this, args); return result ? { ...result, expiresOn: new Date(NaN) } : result;
      });
    }
    const pending = Promise.resolve(token(PUBLIC.botScope)); void pending.catch(() => {}); await reached.promise;
    if (mode.endsWith('cached')) { gate.resolve(); await pending; }
    if (mode.startsWith('expired')) t.mock.method(Date, 'now', () => f.certificate.validToDate.getTime());
    if (mode.startsWith('TLS')) restoreEnv(t, 'NODE_TLS_REJECT_UNAUTHORIZED', '0');
    gate.resolve();
    await assert.rejects(mode.endsWith('cached') ? async () => token(PUBLIC.botScope) : pending, { message: 'Certificate token unavailable' });
    assert.equal(calls, 1);
  });
}

test('malformed token responses cannot enter cache; valid optional fields do not require Entra account fields', async (t) => {
  for (const body of [null, [], { ...success(), expires_in: NaN }, { ...success(), expires_in: 604801 },
    { ...success(), expires_on: '0' }, { ...success(), not_before: '9000000000000' }]) {
    let calls = 0; const f = certificateFiles(t);
    const token = prepareCertificate(f.config).createToken(network(async () => { calls++; return { status: 200, headers: {}, body }; }));
    for (let i = 0; i < 2; i++) await assert.rejects(async () => token(PUBLIC.botScope));
    assert.equal(calls, 2);
  }
  const f = certificateFiles(t); const body = { ...success(), expires_in: '3600', ext_expires_in: '3600', refresh_in: '1800', scope: PUBLIC.botScope };
  const token = prepareCertificate(f.config).createToken(network(async () => ({ status: 200, headers: {}, body })));
  assert.equal(await token(PUBLIC.botScope) === body.access_token, true);
});

async function mapHttps(t: TestContext, listener: Parameters<typeof httpsFixture>[1], trust = true, servername = 'localhost') {
  const fixture = await httpsFixture(t, listener); const request = https.request; let calls = 0;
  t.mock.method(https, 'request', (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    calls++; assert.equal(url.href, endpoint); assert.equal(options.method, 'POST'); assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.maxHeaderSize, 16384);
    // Public native HTTP seam only: no production endpoint or CA override exists.
    return request(new URL(fixture.baseUrl), { ...options, servername, ...(trust ? { ca: fixture.ca } : {}) }, callback);
  });
  return { calls: () => calls };
}

test('native network uses verified unpooled HTTPS with bounded OAuth success and refuses GET/other URL before HTTP', async (t) => {
  restoreEnv(t, 'HTTPS_PROXY', 'http://127.0.0.1:1'); restoreEnv(t, 'NODE_USE_ENV_PROXY', '1');
  const fixture = await mapHttps(t, (req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end(JSON.stringify(success())); }); });
  const client = createCertificateNetwork(tenantId);
  const result = await client.sendPostRequestAsync(endpoint, { body: 'synthetic=fixture' }); assert.equal(result.status, 200);
  await assert.rejects(client.sendGetRequestAsync(endpoint));
  await assert.rejects(client.sendPostRequestAsync(endpoint + '?other', { body: 'synthetic=fixture' }));
  assert.equal(fixture.calls(), 1);
});

test('native request/body/header bounds refuse before I/O; inclusive 64 KiB response remains valid', async (t) => {
  const fixture = await mapHttps(t, (req, res) => {
    req.resume(); req.on('end', () => { const text = JSON.stringify(success()); res.end(text + ' '.repeat(65536 - Buffer.byteLength(text))); });
  });
  const client = createCertificateNetwork(tenantId);
  for (const options of [{ body: '' }, { body: 'x'.repeat(65537) }, { body: 'x', headers: { 'X-Large': 'x'.repeat(16385) } }]) {
    await assert.rejects(client.sendPostRequestAsync(endpoint, options));
  }
  assert.equal(fixture.calls(), 0);
  assert.equal((await client.sendPostRequestAsync(endpoint, { body: 'x'.repeat(65536) })).status, 200);
  assert.equal(fixture.calls(), 1);
});

test('native overall deadline includes an unfinished TLS handshake', { timeout: 8000 }, async (t) => {
  const server = createServer((socket) => { socket.on('error', () => {}); socket.resume(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = https.request;
  t.mock.method(https, 'request', (_url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) =>
    request(new URL(`https://127.0.0.1:${address.port}/`), options, callback));
  const started = performance.now();
  await assert.rejects(createCertificateNetwork(tenantId).sendPostRequestAsync(endpoint, { body: 'synthetic=fixture' }));
  assert.ok(performance.now() - started >= 4900);
});

for (const variant of ['untrusted TLS', 'wrong SAN', 'redirect', 'HTTP error', 'too large', 'headers', 'invalid UTF8', 'invalid JSON', 'invalid OAuth', 'invalid JWT', 'truncated', 'timeout', 'dripping'] as const) {
  test(`native network rejects ${variant}, settles actual work and never retries`, { timeout: 9000 }, async (t) => {
    const fixture = await mapHttps(t, (req, res) => {
      req.resume(); req.on('end', () => {
        if (variant === 'timeout') return;
        if (variant === 'dripping') { const timer = setInterval(() => res.write(' '), 30); res.once('close', () => clearInterval(timer)); return; }
        if (variant === 'redirect') { res.writeHead(302, { Location: endpoint }); res.end(); return; }
        if (variant === 'HTTP error') { res.writeHead(500); res.end('{}'); return; }
        if (variant === 'too large') { res.end('x'.repeat(65537)); return; }
        if (variant === 'headers') res.setHeader('X-Large', 'x'.repeat(17000));
        if (variant === 'invalid UTF8') { res.end(Buffer.from([0xff])); return; }
        if (variant === 'invalid JSON') { res.end('{'); return; }
        if (variant === 'invalid OAuth') { res.end(JSON.stringify({ ...success(), expires_in: 0 })); return; }
        if (variant === 'invalid JWT') { res.end(JSON.stringify({ ...success(), access_token: 'a.b.c' })); return; }
        if (variant === 'truncated') { res.writeHead(200, { 'Content-Length': '1000' }); res.write('{'); res.destroy(); return; }
        res.end(JSON.stringify(success()));
      });
    }, variant !== 'untrusted TLS', variant === 'wrong SAN' ? 'wrong.invalid' : 'localhost');
    const client = createCertificateNetwork(tenantId); const started = performance.now();
    await assert.rejects(client.sendPostRequestAsync(endpoint, { body: 'synthetic=fixture' }), { message: 'Certificate token unavailable' });
    assert.equal(fixture.calls(), 1); if (variant === 'timeout' || variant === 'dripping') assert.ok(performance.now() - started >= 4900);
  });
}
