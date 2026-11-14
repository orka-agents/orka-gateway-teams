import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import https from 'node:https';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { grantReference } from '../src/accounts/grants.js';
import { createAccountStore } from '../src/accounts/store.js';
import { createGitHub } from '../src/accounts/github.js';
import { createDelegatedAuth, WORK_IQ_SCOPE } from '../src/auth/delegated.js';
import { NativeAdapter } from '../src/ingress/http-adapter.js';
import { snapshotRegistry } from '../src/registry/config.js';
import { createRegistryAdmission } from '../src/registry/admission.js';
import { openDirectory } from '../src/directory/store.js';
import { bindingName } from '../src/directory/codec.js';
import type { PolicyAdmission } from '../src/policy/admission.js';
import type { AdmissionContext } from '../src/ingress/server.js';
import type { ProviderResult } from '../src/outbound/types.js';
import type { ReplyRoute } from '../src/ingress/types.js';
import { binding, context, deferred, directoryFixture } from './support/directory-table.js';
import { githubFixture } from './support/github.js';
import { httpsFixture } from './support/ingress-https.js';
import { imdsFixture, miConfig } from './support/managed-identity.js';
import { registryInput } from './support/registry.js';
import { memoryDirectoryTable } from './support/directory-memory.js';
import { expectedEvent } from './fixtures/incoming.js';

const oid = 'abcdef12-abcd-4abc-8abc-abcdefabcdef'; const origin = 'https://signin.example.invalid';
const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
async function setup(t: test.TestContext, chatKind: 'personal' | 'groupChat' = 'personal') {
  const table = await directoryFixture(t); let allowed = true;
  const authority = { allowed: () => allowed, revalidate: async () => allowed, lost: new AbortController().signal };
  const accountBinding = { ...binding, appId: miConfig.appId, tenantId: miConfig.tenantId };
  const accounts = createAccountStore(accountBinding, Buffer.alloc(32, 7), table.dependencies, authority);
  const githubAccounts = createAccountStore(accountBinding, Buffer.alloc(32, 7), table.dependencies, authority, Date.now, 'github');
  t.after(() => Promise.all([accounts.close(), githubAccounts.close()]));
  const remote = await githubFixture(t); const github = createGitHub({ clientId: 'Iv1.synthetic', clientSecret: 'CLIENT_PRIVATE', publicOrigin: origin }, { request: remote.request }); t.after(() => github.close());
  const imds = await imdsFixture(t); let msNonce = ''; let msOid = oid; let msPosts = 0;
  const microsoft = await httpsFixture(t, async (req, res) => {
    const chunks: Buffer[] = []; for await (const b of req) chunks.push(Buffer.from(b)); msPosts++;
    const form = new URLSearchParams(Buffer.concat(chunks).toString()); assert.equal(form.get('redirect_uri'), origin + '/oauth/callback'); assert.ok(form.get('code_verifier'));
    const id_token = jwt.sign({ tid: miConfig.tenantId, oid: msOid, aud: miConfig.appId,
      iss: `https://login.microsoftonline.com/${miConfig.tenantId}/v2.0`, nonce: msNonce, exp: Math.floor(Date.now() / 1000) + 3600 }, signing.privateKey, { algorithm: 'RS256', keyid: 'github-chain' });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: 'MS_ACCESS_PRIVATE', refresh_token: 'MS_REFRESH_PRIVATE', token_type: 'Bearer', expires_in: 3600, scope: WORK_IQ_SCOPE, id_token }));
  });
  const request = ((url: URL, options: https.RequestOptions, cb: Parameters<typeof https.request>[2]) => {
    assert.equal(url.href, `https://login.microsoftonline.com/${miConfig.tenantId}/oauth2/v2.0/token`);
    return https.request(new URL(url.pathname, microsoft.baseUrl), { ...options, hostname: '127.0.0.1', servername: 'localhost', ca: microsoft.ca }, cb!);
  }) as typeof https.request;
  const auth = createDelegatedAuth(miConfig, { request, managedIdentity: { imdsRequest: imds.imdsRequest }, fetchKeys: async () => new Response(JSON.stringify({ keys: [
    { ...signing.publicKey.export({ format: 'jwk' }), kid: 'github-chain', use: 'sig', alg: 'RS256' } ] })) }); t.after(() => auth.close());
  const config = snapshotRegistry(registryInput(1)); const target = config.targets[0]!; const scope = { appId: miConfig.appId, tenantId: miConfig.tenantId };
  const memory = memoryDirectoryTable(); const directory = await openDirectory(memory.table, context()); t.after(() => directory.close());
  const connection = { schema: 1 as const, kind: 'conn' as const, scope, conversationId: expectedEvent.contextId, chatKind, targetId: target.id,
    identityDigest: target.identityDigest!, bindingName: bindingName(scope, expectedEvent.contextId, target.identityDigest!), state: 'reserved' as const };
  const evidence = { namespace: 'default', name: connection.bindingName, uid: 'uid', generation: 1, spec: {} };
  await directory.markProvisioned(await directory.reserveConnection(connection, context()), evidence, context());
  let policy: PolicyAdmission = { kind: 'eligible', targets: [{ id: target.id, label: target.label }] }; let work = 0;
  let outcome: ProviderResult = { kind: 'delivered', providerMessageId: 'receipt' }; const sent: string[] = []; const logs: string[] = [];
  const sink = createRegistryAdmission({ config, directory, authority, active: () => allowed,
    delegated: { accounts, auth, apiUri: 'api://gateway', connectionName: 'workiq', publicOrigin: origin }, github: { accounts: githubAccounts, auth: github },
    authorizer: { authorize: async () => policy }, log: category => logs.push(category),
    slots: [{ target, inbox: { admit: async () => { work++; return { kind: 'accepted', replyTarget: 'rt' }; } }, provisioner: { check: async () => evidence, reconcile: async () => evidence } }] });
  sink.bindControlSender({ send: async (_route, message) => { sent.push(JSON.stringify(message)); return outcome; } });
  const routeBase = { serviceUrl: target.config.receiver.serviceUrls[0]!, channelId: 'msteams' as const, bot: { id: '28:fixture-app', role: 'bot' as const } };
  const route: ReplyRoute = chatKind === 'groupChat' ? { ...routeBase,
    conversation: { id: expectedEvent.contextId, tenantId: miConfig.tenantId, conversationType: 'groupChat' }, requester: expectedEvent.sender } :
    { ...routeBase, conversation: { id: expectedEvent.contextId, tenantId: miConfig.tenantId, conversationType: 'personal' } };
  const run = (text: string, activityId: string = randomUUID(), changed: Partial<AdmissionContext> = {}) => sink.admit({ ...expectedEvent, text }, route,
    { ...context(), activityId, commandText: text, subject: { tenantId: miConfig.tenantId, objectId: oid, chatKind }, delegatedTenant: true,
      controlRecipient: { id: '29:fixture-person', ...(chatKind === 'groupChat' ? { isTargeted: true as const } : {}) }, ...changed });
  const adapter = new NativeAdapter(async () => false, sink.browser); adapter.registerRoute('POST', '/api/messages', async () => ({ status: 200 }));
  const port = await adapter.listen('127.0.0.1', 0); t.after(() => adapter.stop()); const root = `http://127.0.0.1:${port}`;
  const start = async () => {
    assert.equal((await run('link github')).kind, 'accepted'); const card = JSON.parse(sent.at(-1)!);
    const url = new URL(card.attachments[0].content.buttons[0].value); const challenge = url.searchParams.get('challenge')!;
    const response = await fetch(root + url.pathname + url.search, { redirect: 'manual' }); await response.text(); assert.equal(response.status, 302);
    const ms = new URL(response.headers.get('location')!); msNonce = ms.searchParams.get('nonce')!; return { challenge, ms };
  };
  const proof = async (ms: URL) => {
    const response = await fetch(root + '/oauth/callback', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state: ms.searchParams.get('state')!, code: 'MS_CODE_PRIVATE' }).toString() }); await response.text(); return response;
  };
  const finish = async (state: string, cookie?: string, error = false) => {
    const response = await fetch(root + '/github/callback?' + new URLSearchParams({ state, ...(error ? { error: 'access_denied', error_description: 'PRIVATE' } : { code: 'GH_CODE_PRIVATE' }) }),
      { headers: cookie ? { cookie } : {}, redirect: 'manual' }); const text = await response.text(); assert.doesNotMatch(text, /PRIVATE/); return response;
  };
  return { ...remote, root, adapter, accounts, githubAccounts, directory, sent, logs, run, start, proof, finish, sink,
    work: () => work, msPosts: () => msPosts, wrongSender: () => { msOid = miConfig.appId; }, wrongNonce: () => { msNonce = 'wrong'; },
    revoke: () => { allowed = false; }, policy: () => { policy = { kind: 'no-access', text: '' }; }, outcome: (value: ProviderResult) => { outcome = value; } };
}

test('admission freezes all five tools with unlinked0 and duplicate admission cannot adopt a later GitHub link', async t => {
  const f = await setup(t); const ch = await f.accounts.challenge({ objectId: oid }, expectedEvent.contextId, 'workiq', context());
  await f.accounts.claim(ch, context()); await f.accounts.complete(ch, { accessToken: 'MS_ACCESS_PRIVATE', expiresAt: Date.now() + 600000 }, context());
  assert.equal((await f.run('work', 'event')).kind, 'accepted'); assert.equal(f.work(), 1);
  const target = snapshotRegistry(registryInput(1)).targets[0]!;
  const ref = grantReference(target.config.scope, target, expectedEvent.externalEventId, expectedEvent.replyTarget!);
  const grant = await f.accounts.getGrant(ref, context()); assert.equal(grant?.githubGeneration, 0); assert.equal(grant.tools.length, 5);
  const { ms } = await f.start(); const proof = await f.proof(ms);
  const state = new URL(proof.headers.get('location')!).searchParams.get('state')!; const cookie = proof.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await f.finish(state, cookie)).status, 200);
  assert.equal((await f.run('work', 'event')).kind, 'conflict'); assert.equal(f.work(), 1);
  assert.deepEqual(await f.accounts.getGrant(ref, context()), grant);
});

test('native same-browser Microsoft proof then GitHub /user links only GitHub; old work never starts', async t => {
  const f = await setup(t, 'groupChat'); const subject = { objectId: oid };
  const workiq = await f.accounts.challenge(subject, expectedEvent.contextId, 'workiq', context()); await f.accounts.claim(workiq, context());
  await f.accounts.complete(workiq, { accessToken: 'OLD_MS_ACCESS', expiresAt: Date.now() + 600000 }, context());
  const { ms } = await f.start(); assert.equal(f.requests.length, 0); assert.equal(f.work(), 0);
  assert.deepEqual(JSON.parse(f.sent[0]!).recipient, { id: '29:fixture-person', isTargeted: true });
  const proof = await f.proof(ms); assert.equal(proof.status, 302); assert.equal(f.msPosts(), 1);
  const github = new URL(proof.headers.get('location')!); assert.equal(github.origin + github.pathname, 'https://github.com/login/oauth/authorize');
  const setCookie = proof.headers.get('set-cookie')!;
  assert.match(setCookie, /^__Host-github-link=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=[1-9][0-9]{0,2}$/);
  const state = github.searchParams.get('state')!; const cookie = setCookie.split(';')[0]!;
  assert.equal((await f.finish(state)).status, 400); assert.equal((await f.finish(state, '__Host-github-link=' + 'x'.repeat(43))).status, 400);
  assert.equal(f.requests.length, 0);
  const done = await f.finish(state, cookie); assert.equal(done.status, 200); assert.match(done.headers.get('set-cookie')!, /Max-Age=0/);
  assert.deepEqual(await f.githubAccounts.inspect(subject, context()), { generation: 2, linked: true });
  assert.match(f.sent.at(-1)!, /Send your request again/);
  assert.deepEqual(await f.accounts.acquire(subject, 1, async () => { assert.fail(); }, context()), { kind: 'token', accessToken: 'OLD_MS_ACCESS' });
  assert.equal((await f.finish(state, cookie)).status, 400); assert.equal(f.requests.length, 2); assert.equal(f.work(), 0);
  assert.doesNotMatch(JSON.stringify({ sent: f.sent, logs: f.logs }), /PRIVATE|ghu_|ghr_|verifier|nonce/);
});
for (const reason of ['sender', 'nonce', 'policy', 'owner']) test(`Microsoft ${reason} refusal never contacts GitHub`, async t => {
  const f = await setup(t); const { ms } = await f.start();
  if (reason === 'sender') f.wrongSender(); if (reason === 'nonce') f.wrongNonce(); if (reason === 'policy') f.policy(); if (reason === 'owner') f.revoke();
  assert.equal((await f.proof(ms)).status, 400); assert.equal(f.requests.length, 0);
  assert.equal((await f.githubAccounts.inspect({ objectId: oid }, context()).catch(() => ({ linked: false }))).linked, false);
});
test('eligible link command is targeted and durable; missing sender/tenant/recipient, denial and uncertain sends cannot create old work', async t => {
  const f = await setup(t);
  for (const changed of [{ delegatedTenant: false }, { subject: { tenantId: miConfig.tenantId, chatKind: 'personal' as const } }])
    assert.equal((await f.run('link github', randomUUID(), changed)).kind, 'conflict');
  assert.equal(f.sent.length, 0); f.outcome({ kind: 'unknown' });
  assert.equal((await f.run('link github', 'uncertain')).kind, 'accepted'); assert.equal((await f.run('link github', 'uncertain')).kind, 'duplicate');
  assert.equal(f.sent.length, 1); assert.equal(f.work(), 0); f.policy(); await f.run('link github'); assert.equal(f.work(), 0);
});
test('duplicate ready GitHub disconnect selects its own provider even at matching generations', async t => {
  const f = await setup(t); const subject = { objectId: oid };
  const w = await f.accounts.challenge(subject, expectedEvent.contextId, 'ms', context()); await f.accounts.claim(w, context());
  await f.accounts.complete(w, { accessToken: 'MS', expiresAt: Date.now() + 600000 }, context());
  // Both providers are generation1 before reservation: the old duplicate branch
  // would otherwise erase Work IQ using the GitHub control's matching generation.
  await f.githubAccounts.challenge(subject, expectedEvent.contextId, 'pre-disconnect', context());
  f.outcome({ kind: 'retryable' }); await f.run('disconnect github', 'disconnect');
  assert.deepEqual(await f.githubAccounts.inspect(subject, context()), { generation: 2, linked: false });
  assert.equal((await f.accounts.inspect(subject, context())).linked, true);
  f.outcome({ kind: 'delivered', providerMessageId: 'receipt' }); await f.run('disconnect github', 'disconnect');
  assert.deepEqual(await f.accounts.inspect(subject, context()), { generation: 1, linked: true }); assert.equal(f.work(), 0);
});
for (const invalidate of ['denial', 'disconnect', 'policy', 'owner']) test(`GitHub callback ${invalidate} consumes safely without publishing`, async t => {
  const f = await setup(t); const { ms } = await f.start(); const proof = await f.proof(ms); assert.equal(proof.status, 302);
  const state = new URL(proof.headers.get('location')!).searchParams.get('state')!; const cookie = proof.headers.get('set-cookie')!.split(';')[0]!;
  if (invalidate === 'disconnect') await f.githubAccounts.disconnect({ objectId: oid }, context());
  if (invalidate === 'policy') f.policy(); if (invalidate === 'owner') f.revoke();
  assert.equal((await f.finish(state, cookie, invalidate === 'denial')).status, 400); assert.equal(f.requests.length, 0);
  assert.equal((await f.finish(state, cookie)).status, 400); assert.equal(f.requests.length, 0);
});
test('disconnect while native GitHub request is held fences publication', async t => {
  const f = await setup(t); const { ms } = await f.start(); const proof = await f.proof(ms);
  const state = new URL(proof.headers.get('location')!).searchParams.get('state')!; const cookie = proof.headers.get('set-cookie')!.split(';')[0]!;
  const entered = deferred(); const release = deferred(); f.behavior((_req, res) => { entered.resolve(); void release.promise.then(() => res.end('{}')); });
  const pending = f.finish(state, cookie); await entered.promise; await f.githubAccounts.disconnect({ objectId: oid }, context()); release.resolve();
  assert.equal((await pending).status, 400); assert.equal((await f.githubAccounts.inspect({ objectId: oid }, context())).linked, false);
});
test('GET callback rejects aliases, duplicates, unknown parameters and ambiguous cookies before effects', async t => {
  const f = await setup(t);
  for (const path of ['/github/callback', '/github/callback?state=s&code=c&code=d', '/github/callback?state=s&code=c&error=e',
    '/github/callback?state=s&code=c&url=https://evil', '//github/callback?state=s&code=c', '/github/callback/?state=s&code=c',
    '/github/callback?state=s&code=' + 'x'.repeat(17000)]) {
    const response = await fetch(f.root + path); assert.ok(response.status >= 400); await response.text();
  }
  assert.equal(f.requests.length, 0); assert.equal(f.msPosts(), 0);
});
