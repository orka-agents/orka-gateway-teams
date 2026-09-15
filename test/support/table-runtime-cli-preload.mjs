// Test-only native destination mapping. Never included in the production image.
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Capture BEFORE patching; both default and named native imports must be mapped.
const nativeHttp = http.request;
const nativeHttps = https.request;
const nativeFetch = globalThis.fetch;
const settings = JSON.parse(readFileSync(new URL('./native-settings.json', import.meta.url), 'utf8'));
const stats = { requests: 0, requestCloses: 0, sockets: 0, socketCloses: 0, unexpected: 0,
  table: 0, identity: 0, entra: 0, orka: 0, provider: 0, strictKeys: 0, sdkKeys: 0 };
const keysUrl = 'https://login.botframework.com/v1/.well-known/keys';
function tracked(req) {
  stats.requests++;
  req.once('close', () => stats.requestCloses++);
  req.once('socket', socket => { stats.sockets++; socket.once('close', () => stats.socketCloses++); });
  return req;
}
function argumentsFor(args, protocol) {
  const first = args[0];
  if (first instanceof URL || typeof first === 'string') return { url: new URL(first),
    options: typeof args[1] === 'object' ? args[1] : {}, callback: typeof args[1] === 'function' ? args[1] : args[2] };
  return { url: new URL(`${protocol}//${first.hostname ?? first.host}${first.port ? ':' + first.port : ''}${first.path ?? '/'}`),
    options: first, callback: args[1] };
}
function denied() { stats.unexpected++; throw new Error('Unexpected fixture destination'); }
function mappedHttps(args, fetcher) {
  const { url, options, callback } = argumentsFor(args, 'https:');
  let kind;
  if (url.origin === 'https://example123.table.core.windows.net') kind = 'table';
  else if (url.href === settings.entraEndpoint) kind = 'entra';
  else if (url.origin === 'https://orka.example.invalid') kind = 'orka';
  else if (url.origin === 'https://teams-service.example.invalid') kind = 'provider';
  else if (url.href === keysUrl) kind = fetcher === 'strict' ? 'strictKeys' : 'sdkKeys';
  else return denied();
  stats[kind]++;
  const target = kind === 'table' ? settings.table : settings.services;
  const destination = new URL(url.pathname + url.search, target.baseUrl);
  // Preserve actual methods, bodies, production headers, cancellation and agents.
  // Only network destination/trust and a JWKS fixture discriminator change.
  const headers = { ...options.headers, host: url.host,
    ...(kind.endsWith('Keys') ? { 'x-fixture-verifier': kind } : {}) };
  return tracked(nativeHttps(destination, { ...options, hostname: '127.0.0.1', host: '127.0.0.1',
    port: destination.port, path: destination.pathname + destination.search, headers,
    ca: target.ca, servername: 'localhost', rejectUnauthorized: true }, callback));
}
https.request = (...args) => mappedHttps(args);
http.request = (...args) => {
  const { url, options, callback } = argumentsFor(args, 'http:');
  if (url.origin !== new URL(settings.identity).origin || url.pathname !== '/msi/token') return denied();
  stats.identity++;
  return tracked(nativeHttp(url, options, callback));
};
// Node fetch does not use https.request. Map only the exact fixed JWKS resource;
// production strict-auth parsing, endorsement, claims and RS256 checks still run.
globalThis.fetch = (input, options = {}) => {
  if (String(input) !== keysUrl) { void nativeFetch; return denied(); }
  return new Promise((resolve, reject) => {
    const req = mappedHttps([new URL(keysUrl), { method: 'GET', headers: options.headers,
      signal: options.signal, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', () => reject(new Error('Fixture keys unavailable')));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    }], 'strict');
    req.on('error', () => reject(new Error('Fixture keys unavailable'))); req.end();
  });
};
syncBuiltinESMExports();
// Natural process quiescence, not a timer, forced exit or cleanup-created drain.
process.once('beforeExit', () => process.stderr.write(`table-cli-native: ${JSON.stringify(stats)}\n`));
