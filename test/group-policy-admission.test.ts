import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { createGroupAuthorizer, NO_ACCESS_TEXT, readPolicySubject } from '../src/policy/admission.js';
import { snapshotGroupPolicy } from '../src/policy/config.js';
import type { GraphMembershipClient } from '../src/policy/graph.js';
import { convertActivity } from '../src/teams/convert.js';
import { conversionContext, expectedEvent, personalMessage } from './fixtures/incoming.js';
import { registryInput } from './support/registry.js';
import { deferred } from './support/table-service.js';

const tenantId = conversionContext.tenantId;
const objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const groupA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const groupB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const context = () => ({ signal: new AbortController().signal, deadline: performance.now() + 10000 });
const subject = () => ({ tenantId, objectId, chatKind: 'personal' as const });
function policy() { return snapshotGroupPolicy({ schemaVersion: 1, graphIdentityClientId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', policies: [
  { schemaVersion: 1, targetId: 'primary', frontAgent: 'front', rules: [{ groupId: groupA, chatKinds: ['personal', 'groupChat'] }] },
  { schemaVersion: 1, targetId: 'tools', frontAgent: 'front', rules: [{ groupId: groupB, chatKinds: ['groupChat'] }] },
] }, registryInput()); }
function fixture(t: test.TestContext) {
  let calls = 0; let groups: readonly string[] = [groupA]; let fail = false; let gate: Promise<void> | undefined; let closed = false; let honorAbort = true;
  const membership: GraphMembershipClient = { async lookup(id, requested, ctx) {
    calls++; assert.ok(id); assert.deepEqual(requested, [groupA, groupB]);
    if (gate) await gate;
    if (fail || (honorAbort && ctx.signal.aborted) || closed) throw new Error('private-error-sentinel'); return groups;
  }, async close() { closed = true; } };
  const authorizer = createGroupAuthorizer(policy(), membership); t.after(() => authorizer.close());
  return { authorizer, membership, ignoreCancellation() { honorAbort = false; }, calls: () => calls, groups(value: readonly string[]) { groups = value; }, fail() { fail = true; }, hold(value: Promise<void>) { gate = value; } };
}
test('current AAD subject is separate from unchanged personal Teams sender bytes', () => {
  const activity = structuredClone(personalMessage); Object.assign(activity.from!, { aadObjectId: objectId });
  const before = JSON.stringify(activity);
  assert.deepEqual(readPolicySubject(activity, tenantId), subject());
  assert.deepEqual(convertActivity(activity, conversionContext), { kind: 'accepted', event: expectedEvent });
  assert.equal(JSON.stringify(activity), before);
});
for (const [name, change] of Object.entries({
  missing: (a: any) => { delete a.from.aadObjectId; }, malformed: (a: any) => { a.from.aadObjectId = '../users'; },
  noFromFallback: (a: any) => { a.from.id = objectId; a.from.aadObjectId = null; },
  channel: (a: any) => { a.conversation.conversationType = 'channel'; },
  groupContradiction: (a: any) => { a.conversation.isGroup = true; },
})) test(`subject ${name} cannot grant or call Graph`, async t => {
  const f = fixture(t); const activity = structuredClone(personalMessage); Object.assign(activity.from!, { aadObjectId: objectId }); change(activity);
  assert.deepEqual(await f.authorizer.authorize(readPolicySubject(activity, tenantId), context()), { kind: 'no-access', text: NO_ACCESS_TEXT }); assert.equal(f.calls(), 0);
});
test('authorization returns only eligible IDs/labels and generic denial for unknown or ineligible choice', async t => {
  const f = fixture(t); const target = policy().targets[0]!;
  assert.deepEqual(await f.authorizer.authorize(subject(), context()), { kind: 'eligible', targets: [{ id: target.id, label: target.label }] });
  for (const id of ['tools', 'unknown', '../users']) assert.deepEqual(await f.authorizer.authorize(subject(), context(), id), { kind: 'no-access', text: NO_ACCESS_TEXT });
  assert.equal(f.calls(), 1);
});
test('additive grants apply only to current chat kind, independently for later senders in a connected group', async t => {
  const f = fixture(t); f.groups([groupA, groupB]);
  assert.equal((await f.authorizer.authorize(subject(), context(), 'tools')).kind, 'no-access');
  const current = { ...subject(), chatKind: 'groupChat' as const };
  const allowed = await f.authorizer.authorize(current, context()); assert.equal(allowed.kind, 'eligible');
  if (allowed.kind === 'eligible') assert.deepEqual(allowed.targets.map(t => t.id), ['primary', 'tools']);
  f.groups([]); const other = { ...current, objectId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
  assert.equal((await f.authorizer.authorize(other, context(), 'primary')).kind, 'no-access'); assert.equal(f.calls(), 2);
});
for (const denial of [false, true]) test(`complete ${denial ? 'denial' : 'positive'} cache lasts strictly less than 60 seconds`, async t => {
  const realMono = performance.now.bind(performance); let offset = 0; t.mock.method(performance, 'now', () => realMono() + offset);
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start }); const f = fixture(t); if (denial) f.groups([]);
  const first = await f.authorizer.authorize(subject(), context());
  offset = 59000; t.mock.timers.setTime(start + 59000); assert.deepEqual(await f.authorizer.authorize(subject(), context()), first); assert.equal(f.calls(), 1);
  offset = 60000; t.mock.timers.setTime(start + 60000); await f.authorizer.authorize(subject(), context()); assert.equal(f.calls(), 2);
});
test('reverse completion never extends an older complete grant past its original 60-second window', async t => {
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start });
  const old = deferred<readonly string[]>(); const recent = deferred<readonly string[]>(); let calls = 0;
  const membership: GraphMembershipClient = { lookup: async () => ++calls === 1 ? old.promise : calls === 2 ? recent.promise : [], close: async () => {} };
  const authorizer = createGroupAuthorizer(policy(), membership); t.after(() => authorizer.close());
  const first = authorizer.authorize(subject(), context());
  t.mock.timers.setTime(start + 1000); const second = authorizer.authorize(subject(), context());
  recent.resolve([]); assert.equal((await second).kind, 'no-access');
  old.resolve([groupA]); assert.equal((await first).kind, 'eligible');
  t.mock.timers.setTime(start + 59999); assert.equal((await authorizer.authorize(subject(), context())).kind, 'eligible');
  t.mock.timers.setTime(start + 60000); assert.equal((await authorizer.authorize(subject(), context())).kind, 'no-access'); assert.equal(calls, 3);
});
test('failed complete lookup is unavailable, never denial or a cached partial result', async t => {
  const f = fixture(t); f.fail();
  for (let n = 0; n < 2; n++) assert.deepEqual(await f.authorizer.authorize(subject(), context()), { kind: 'unavailable', category: 'graph-unavailable' });
  assert.equal(f.calls(), 2);
});
for (const clock of ['wall', 'monotonic']) test(`${clock} regression invalidates cache without a grant`, async t => {
  let wall = Date.now(); const realMono = performance.now.bind(performance); let offset = 0;
  t.mock.method(Date, 'now', () => wall); t.mock.method(performance, 'now', () => realMono() + offset);
  const f = fixture(t); await f.authorizer.authorize(subject(), context());
  if (clock === 'wall') wall -= 1000; else offset = -1000;
  assert.equal((await f.authorizer.authorize(subject(), context())).kind, 'unavailable');
});
for (const variant of ['cancel', 'deadline', 'close']) test(`${variant} fences late membership and close drains actual authorization`, async t => {
  const f = fixture(t); const gate = deferred(); f.hold(gate.promise); const abort = new AbortController();
  const pending = f.authorizer.authorize(subject(), { signal: abort.signal, deadline: performance.now() + (variant === 'deadline' ? 1 : 10000) });
  let stopped = false;
  try {
    if (variant === 'cancel') { f.ignoreCancellation(); abort.abort(); }
    const closing = variant === 'close' ? f.authorizer.close().then(() => { stopped = true; }) : undefined;
    if (variant === 'deadline') await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    gate.resolve(); assert.equal((await pending).kind, 'unavailable'); await closing;
  } finally { gate.resolve(); await f.authorizer.close(); }
});
test('current eligibility is checked even when complete cache is available; tenant and object keys cannot alias', async t => {
  const f = fixture(t); await f.authorizer.authorize(subject(), context()); const abort = new AbortController(); abort.abort();
  assert.equal((await f.authorizer.authorize(subject(), { ...context(), signal: abort.signal })).kind, 'unavailable');
  assert.equal((await f.authorizer.authorize({ ...subject(), tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, context())).kind, 'no-access');
  f.groups([]); assert.equal((await f.authorizer.authorize({ ...subject(), objectId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }, context())).kind, 'no-access');
  assert.equal(f.calls(), 2);
});
test('cache eviction is bounded at 1024 complete identities', async t => {
  const f = fixture(t);
  for (let n = 0; n < 1025; n++) await f.authorizer.authorize({ ...subject(), objectId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}` }, context());
  await f.authorizer.authorize({ ...subject(), objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000000' }, context()); assert.equal(f.calls(), 1026);
});
test('completed authorizations retain bounded memory with one live authorizer', async () => {
  const script = `
    import { createGroupAuthorizer } from './src/policy/admission.ts';
    const policy = { tenantId: '${tenantId}', graphIdentityClientId: '${objectId}', digest: 'memory-test', groupIds: [], targets: [] };
    const authorizer = createGroupAuthorizer(policy, { lookup: async () => [], close: async () => {} });
    const subject = { tenantId: policy.tenantId, objectId: '${objectId}', chatKind: 'personal' };
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const sample = async () => { await tick(); global.gc(); await tick(); global.gc(); return process.memoryUsage().heapUsed; };
    const churn = async () => { for (let n = 0; n < 30000; n++) await authorizer.authorize(subject, { signal: new AbortController().signal, deadline: performance.now() + 10000 }); };
    await churn(); const before = await sample(); await churn(); const after = await sample();
    await authorizer.close(); process.stdout.write(JSON.stringify({ retained: after - before }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', script]);
  const sample = JSON.parse(stdout); assert.ok(sample.retained < 3 * 1024 * 1024, `Retained ${sample.retained} bytes after completed calls`);
});
test('32 actual pending authorizations reserve capacity until drain, closed authorizer refuses new work', async t => {
  const f = fixture(t); const gate = deferred(); f.hold(gate.promise);
  const pending = Promise.all(Array.from({ length: 32 }, () => f.authorizer.authorize(subject(), context())));
  try {
    assert.equal((await f.authorizer.authorize(subject(), context())).kind, 'unavailable'); assert.equal(f.calls(), 32);
    gate.resolve(); assert.equal((await pending).every(r => r.kind === 'eligible'), true); await f.authorizer.close();
    assert.equal((await f.authorizer.authorize(subject(), context())).kind, 'unavailable'); assert.equal(f.calls(), 32);
  } finally { gate.resolve(); await f.authorizer.close(); }
});
