import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareStorageIdentity } from '../src/auth/storage-identity.js';
import { acaEnvironment, acaHeader, identityEnvironment, identityFixture } from './support/aca-identity.js';
import { deferred } from './support/ingress-auth.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { StorageIdentityConfig } from '../src/auth/storage-identity.js';

const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scope = 'https://storage.azure.com/.default';
const unavailable = (error: unknown) => error instanceof Error && error.message === 'Storage token unavailable' && error.cause === undefined;
const opaque = 'synthetic-opaque-storage-token+/==';
function context() { return { signal: new AbortController().signal, deadline: performance.now() + 10000 }; }
function envelope(change: Record<string, unknown> = {}) {
  return { access_token: opaque, token_type: 'Bearer', resource: 'https://storage.azure.com/', expires_on: Math.floor(Date.now() / 1000) + 3600, client_id: clientId, ...change };
}

for (const host of ['imds', 'azure-container-apps'] as const) test('fixed storage UAMI acquisition treats tokens as opaque: ' + host, async (t) => {
  if (host === 'azure-container-apps') acaEnvironment(t);
  let valid = true; let bodyBytes = 0;
  const local = await identityFixture(t, (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    valid &&= url.searchParams.size === 3 && url.searchParams.get('client_id') === clientId && url.searchParams.get('resource') === 'https://storage.azure.com/' &&
      url.searchParams.get('api-version') === (host === 'imds' ? '2018-02-01' : '2019-08-01') &&
      url.pathname === (host === 'imds' ? '/metadata/identity/oauth2/token' : '/msi/token') &&
      (host === 'imds' ? req.headers.metadata === 'true' && req.headers['x-identity-header'] === undefined :
        req.headers.metadata === undefined && req.headers['x-identity-header'] === acaHeader);
    req.on('data', (part: Buffer) => { bodyBytes += part.length; }); req.on('end', () => res.end(JSON.stringify(envelope())));
  });
  const input = { host, clientId: clientId.toUpperCase() }; const prepared = prepareStorageIdentity(input);
  input.clientId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.equal(JSON.stringify(prepared), '{}'); assert.equal(local.stats.calls, 0); prepared.assertUsable();
  const dependencies = { request: local.request }; const provider = prepared.createProvider(dependencies);
  dependencies.request = () => { throw new Error('Mutable dependency must not be reread'); };
  assert.equal(local.stats.calls, 0);
  try {
    assert.equal(await provider.token(scope, context()) === opaque, true); assert.equal(valid, true); assert.equal(bodyBytes, 0);
    local.drained(); assert.throws(() => prepared.createProvider());
  } finally { await provider.close(); }
  await assert.rejects(provider.token(scope, context())); await provider.close();
});

for (const [name, change] of [
  ['missing token', { access_token: undefined }], ['empty token', { access_token: '' }], ['nonstring token', { access_token: 1 }],
  ['token whitespace', { access_token: 'bad token' }], ['token control', { access_token: 'bad\r\ntoken' }],
  ['token bound', { access_token: 'a'.repeat(8193) }], ['non-Bearer', { token_type: 'bearer' }], ['missing type', { token_type: undefined }],
  ['resource slash', { resource: 'https://storage.azure.com' }], ['bot resource', { resource: 'api://AzureADTokenExchange' }],
  ['missing resource', { resource: undefined }], ['wrong identity', { client_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
  ['nonstring identity', { client_id: 12 }], ['missing expiry', { expires_on: undefined }], ['expired', { expires_on: 1 }],
  ['unbounded expiry', { expires_on: Infinity }], ['non-epoch expiry', { expires_on: 'tomorrow' }], ['null expiry', { expires_on: null }],
  ['error metadata', { error: 'synthetic-private-error' }],
] as const) test('storage envelope rejects ' + name + ' and never caches failure', async (t) => {
  acaEnvironment(t); const local = await identityFixture(t, (_req, res) => res.end(JSON.stringify(envelope(change))));
  const provider = prepareStorageIdentity({ host: 'azure-container-apps', clientId }).createProvider({ request: local.request });
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(provider.token(scope, context()), unavailable);
    assert.equal(local.stats.calls, 2); local.drained();
  } finally { await provider.close(); }
});

for (const variant of ['opaque', 'JWT-looking', 'no client ID', 'string expiry', 'uppercase client ID', 'max token']) {
  test('storage envelope accepts ' + variant + ' without bot claim policy', async (t) => {
    const issued = variant === 'JWT-looking' ? 'a.b.c' : variant === 'max token' ? 'a'.repeat(8192) : opaque;
    const local = await identityFixture(t, (_req, res) => res.end(JSON.stringify(envelope({ access_token: issued,
      ...(variant === 'no client ID' ? { client_id: undefined } : {}),
      ...(variant === 'uppercase client ID' ? { client_id: clientId.toUpperCase() } : {}),
      ...(variant === 'string expiry' ? { expires_on: String(Math.floor(Date.now() / 1000) + 3600) } : {}) }))));
    const provider = prepareStorageIdentity({ host: 'imds', clientId }).createProvider({ request: local.request });
    try { assert.equal(await provider.token(scope, context()) === issued, true); local.drained(); }
    finally { await provider.close(); }
  });
}

for (const [name, value] of Object.entries({ missing: undefined, unknown: { host: 'auto', clientId }, missingHost: { clientId },
  missingClient: { host: 'imds' }, emptyClient: { host: 'imds', clientId: '' }, badClient: { host: 'imds', clientId: 'system' },
  endpointOverride: { host: 'imds', clientId, endpoint: 'http://127.0.0.1/' } })) {
  test('invalid storage selection is rejected before ownership: ' + name, () => {
    assert.throws(() => prepareStorageIdentity(value as StorageIdentityConfig), { message: 'Invalid storage identity credentials' });
  });
}

test('storage host snapshot rejects an unknown first selection instead of rereading into IMDS', () => {
  let reads = 0;
  const input = { clientId, get host() { return ['unsupported', 'azure-container-apps', 'imds'][reads++]; } } as unknown as StorageIdentityConfig;
  assert.throws(() => prepareStorageIdentity(input), { message: 'Invalid storage identity credentials' });
  assert.equal(reads, 1);
});

test('storage host snapshot prepares the first explicit ACA selection without rereading', (t) => {
  acaEnvironment(t); let reads = 0;
  const prepared = prepareStorageIdentity({ clientId, get host() { return reads++ === 0 ? 'azure-container-apps' : 'imds'; } });
  prepared.assertUsable(); assert.equal(reads, 1);
});

test('storage scope, caller eligibility and invalid clocks fail before native acquisition', async (t) => {
  const local = await identityFixture(t, (_req, res) => res.end(JSON.stringify(envelope())));
  const provider = prepareStorageIdentity({ host: 'imds', clientId }).createProvider({ request: local.request });
  try {
    for (const invalid of ['https://storage.azure.com/', 'https://api.botframework.com/.default', '', ['https://storage.azure.com/.default']]) {
      await assert.rejects(provider.token(invalid as typeof scope, context()), unavailable);
    }
    const abort = new AbortController(); abort.abort();
    for (const invalid of [{ signal: abort.signal, deadline: performance.now() + 1000 }, { ...context(), deadline: performance.now() },
      { ...context(), deadline: NaN }, { ...context(), deadline: Infinity }]) await assert.rejects(provider.token(scope, invalid), unavailable);
    const clock = t.mock.method(Date, 'now', () => NaN);
    await assert.rejects(provider.token(scope, context()), unavailable); clock.mock.restore();
    assert.equal(local.stats.calls, 0);
  } finally { await provider.close(); }
});

for (const [lifetime, advance, calls] of [[3600, 299999, 1], [3600, 300000, 2], [120, 59999, 1], [120, 60000, 2], [60, 0, 2], [1, 1000, 2]] as const) {
  test(`storage cache lifetime ${lifetime}s after ${advance}ms uses ${calls} refreshes`, async (t) => {
    const now = 1900000000000; t.mock.timers.enable({ apis: ['Date'], now });
    const local = await identityFixture(t, (_req, res) => res.end(JSON.stringify(envelope({ expires_on: Date.now() / 1000 + lifetime }))));
    const provider = prepareStorageIdentity({ host: 'imds', clientId }).createProvider({ request: local.request });
    try {
      assert.equal(await provider.token(scope, context()) === opaque, true); t.mock.timers.setTime(now + advance);
      assert.equal(await provider.token(scope, context()) === opaque, true); assert.equal(local.stats.calls, calls); local.drained();
    } finally { await provider.close(); }
  });
}

test('cache checks monotonic residence even if the wall clock stands still', async (t) => {
  const actualNow = performance.now.bind(performance); let offset = 0;
  t.mock.method(performance, 'now', () => actualNow() + offset);
  const local = await identityFixture(t, (_req, res) => res.end(JSON.stringify(envelope())));
  const provider = prepareStorageIdentity({ host: 'imds', clientId }).createProvider({ request: local.request });
  try {
    await provider.token(scope, context()); offset = 300001; await provider.token(scope, context()); assert.equal(local.stats.calls, 2); local.drained();
  } finally { await provider.close(); }
});

for (const setting of ['IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET', 'AZURE_FEDERATED_TOKEN_FILE', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
  test('storage cache does not waive current source checks: ' + setting, async (t) => {
    acaEnvironment(t); const local = await identityFixture(t, (_req, res) => res.end(JSON.stringify(envelope())));
    const provider = prepareStorageIdentity({ host: 'azure-container-apps', clientId }).createProvider({ request: local.request });
    try {
      await provider.token(scope, context()); identityEnvironment(t, { [setting]: setting === 'NODE_TLS_REJECT_UNAUTHORIZED' ? '0' : '' });
      await assert.rejects(provider.token(scope, context()), unavailable); assert.equal(local.stats.calls, 1);
    } finally { await provider.close(); }
  });
}

for (const expiry of ['cancellation', 'deadline']) test(`storage singleflight keeps independent ${expiry} and 32 actual caller reservations until drain`, { timeout: 8000 }, async (t) => {
  acaEnvironment(t); const reached = deferred<void>(); const gate = deferred<void>();
  const local = await identityFixture(t, async (_req, res) => { reached.resolve(); await gate.promise; res.end(JSON.stringify(envelope())); });
  const provider = prepareStorageIdentity({ host: 'azure-container-apps', clientId }).createProvider({ request: local.request });
  const abort = new AbortController(); const first = provider.token(scope, { ...context(), signal: abort.signal,
    ...(expiry === 'deadline' ? { deadline: performance.now() + 50 } : {}) });
  const firstRejected = assert.rejects(first, unavailable); await reached.promise;
  const survivors = Array.from({ length: 31 }, () => provider.token(scope, context()));
  let settled = false; void firstRejected.then(() => { settled = true; });
  try {
    if (expiry === 'cancellation') abort.abort();
    await sleep(70); assert.equal(settled, false); assert.equal(local.stats.calls, 1); assert.equal(local.stats.requestCloses, 0);
    for (let i = 0; i < 40; i++) await assert.rejects(provider.token(scope, context()), unavailable);
    assert.equal(local.stats.calls, 1); gate.resolve(); await firstRejected;
    for (const result of await Promise.all(survivors)) assert.equal(result === opaque, true);
    local.drained(); assert.equal(await provider.token(scope, context()) === opaque, true); assert.equal(local.stats.calls, 1);
  } finally { gate.resolve(); await provider.close(); }
});

for (const variant of ['deadline', 'close', 'source changed', 'late envelope']) {
  test('storage retains actual work across ' + variant + ' and never publishes an ineligible result', { timeout: 8000 }, async (t) => {
    acaEnvironment(t); const reached = deferred<void>(); const gate = deferred<void>();
    const local = await identityFixture(t, async (_req, res) => {
      reached.resolve(); await gate.promise; res.end(JSON.stringify(envelope(variant === 'late envelope' ? { expires_on: 1 } : {})));
    });
    const provider = prepareStorageIdentity({ host: 'azure-container-apps', clientId }).createProvider({ request: local.request });
    const pending = provider.token(scope, { ...context(), ...(variant === 'deadline' ? { deadline: performance.now() + 50 } : {}) });
    const rejected = assert.rejects(pending, unavailable); await reached.promise;
    let stopped = false; let stopping: Promise<void> | undefined;
    try {
      if (variant === 'close') stopping = provider.close().then(() => { stopped = true; });
      if (variant === 'source changed') process.env.IDENTITY_ENDPOINT = 'http://127.0.0.1/changed';
      await sleep(70); assert.equal(local.stats.requestCloses, 0); assert.equal(stopped, false);
      if (stopping) await assert.rejects(provider.token(scope, context()), unavailable);
      gate.resolve(); await rejected; await stopping; local.drained();
    } finally { gate.resolve(); await provider.close(); }
  });
}

test('storage close waits a timed-out real native request and socket, without caller cancellation aborting it', { timeout: 8000 }, async (t) => {
  const reached = deferred<void>(); const local = await identityFixture(t, () => { reached.resolve(); });
  const provider = prepareStorageIdentity({ host: 'imds', clientId }).createProvider({ request: local.request });
  const abort = new AbortController(); const pending = provider.token(scope, { ...context(), signal: abort.signal });
  const rejected = assert.rejects(pending, unavailable); await reached.promise; abort.abort();
  const started = performance.now(); let closed = false; const closing = provider.close().then(() => { closed = true; });
  await sleep(30); assert.equal(closed, false); assert.equal(local.stats.requestCloses, 0);
  await rejected; await closing; assert.ok(performance.now() - started >= 4900); local.drained();
});

test('storage header rotation is read on refresh, not pinned or carried in the cache', async (t) => {
  acaEnvironment(t); const now = 1900000000000; t.mock.timers.enable({ apis: ['Date'], now });
  let currentHeader = acaHeader; let matched = true;
  const local = await identityFixture(t, (req, res) => {
    matched &&= req.headers['x-identity-header'] === currentHeader; res.end(JSON.stringify(envelope()));
  });
  const provider = prepareStorageIdentity({ host: 'azure-container-apps', clientId }).createProvider({ request: local.request });
  try {
    await provider.token(scope, context()); currentHeader = 'synthetic-rotated-storage-header'; process.env.IDENTITY_HEADER = currentHeader;
    await provider.token(scope, context()); assert.equal(local.stats.calls, 1);
    t.mock.timers.setTime(now + 300000); await provider.token(scope, context());
    assert.equal(local.stats.calls, 2); assert.equal(matched, true); local.drained();
  } finally { await provider.close(); }
});

for (const name of ['IDENTITY_ENDPOINT', 'MSI_ENDPOINT', 'MSI_SECRET', 'AZURE_FEDERATED_TOKEN_FILE']) {
  test('storage IMDS refuses alternate environment source: ' + name, (t) => {
    identityEnvironment(t, { [name]: '' }); assert.throws(() => prepareStorageIdentity({ host: 'imds', clientId }));
  });
}

test('storage IMDS never reads or forwards the unused ACI header', async (t) => {
  identityEnvironment(t, { IDENTITY_HEADER: 'synthetic-unused-aci-header' });
  let privateHeaderAbsent = true;
  const local = await identityFixture(t, (req, res) => {
    privateHeaderAbsent &&= !JSON.stringify(req.headers).includes('synthetic-unused-aci-header') && req.headers['x-identity-header'] === undefined;
    res.end(JSON.stringify(envelope()));
  });
  const provider = prepareStorageIdentity({ host: 'imds', clientId }).createProvider({ request: local.request });
  try { await provider.token(scope, context()); assert.equal(privateHeaderAbsent, true); local.drained(); }
  finally { await provider.close(); }
});

test('storage synchronous native failure releases admission only after failure and allows a fresh attempt', async () => {
  let calls = 0;
  const provider = prepareStorageIdentity({ host: 'imds', clientId }).createProvider({ request: () => { calls++; throw new Error('synthetic-private-error'); } });
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(provider.token(scope, context()), unavailable);
    assert.equal(calls, 2);
  } finally { await provider.close(); }
});

for (const kind of ['elapsed', 'nonfinite']) test('storage rejects a native response after ' + kind + ' monotonic deadline without waiting for timer dispatch', async (t) => {
  const actualNow = performance.now.bind(performance); let changed = false;
  t.mock.method(performance, 'now', () => changed ? (kind === 'elapsed' ? actualNow() + 5001 : NaN) : actualNow());
  const local = await identityFixture(t, (_req, res) => { changed = true; res.end(JSON.stringify(envelope())); });
  const provider = prepareStorageIdentity({ host: 'imds', clientId }).createProvider({ request: local.request });
  try { await assert.rejects(provider.token(scope, context()), unavailable); local.drained(); }
  finally { await provider.close(); }
});
