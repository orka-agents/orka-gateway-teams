import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableKernel } from '../src/storage/table/owner.js';
import { deferred, eventually, stamp, syntheticToken, tableBinding, tableService } from './support/table-service.js';

const code = (e: unknown) => e instanceof Error && 'code' in e && e.code === 'unresolved' && !('cause' in e);
const input = { input: Buffer.alloc(0), keys: [] };
const plan = () => ({ state: Buffer.from('state'), result: Buffer.from('result'), actions: [] });
test('existing poisoned-kernel diagnostic reads remain available without write authority', async t => {
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies);
  await k.initialize(); await k.acquire(); await k.scan();
  await k.mutate(input, () => ({ ...plan(), actions: [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload: Buffer.from('payload') }] }));
  s.rows.get('delivery_aXRlbQ')!.Digest = '0'.repeat(64);
  await assert.rejects(k.read({ type: 'delivery', id: 'item' }), code);
  assert.equal((await k.read('M'))?.value.kind, 'metadata');
  await assert.rejects(k.mutate(input, plan), code); await assert.rejects(k.close(), code);
  assert.notEqual(s.rows.get('M')?.Owner, '');
});
test('invalidating held initialization page prevents the later direct create', async t => {
  const s = await tableService(t); const gate = deferred(); let held = false;
  s.controls.hook = async e => { if (!held && e.req.method === 'GET') { held = true; await gate.promise; } e.reply(); };
  const k = createTableKernel(tableBinding, s.dependencies);
  const rejected = assert.rejects(k.initialize(), code);
  await eventually(() => held); k.invalidate();
  let closed = false; const close = assert.rejects(k.close(), code).then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(closed, false); assert.equal(k.status().pending, 1);
  gate.resolve(); await rejected; await close;
  assert.equal(s.stats.writes, 0); assert.equal(s.rows.size, 0);
  assert.equal(s.stats.requests, s.stats.socketCloses);
});
for (const boundary of ['initialize', 'acquire', 'mutate', 'release', 'barrier'] as const) {
  test(`invalidation revokes held ${boundary} write token permission but awaits actual drain`, async t => {
    const s = await tableService(t); const gate = deferred<string>();
    let hold = false; let heldSignal: AbortSignal | undefined; let heldTokens = 0; let returnedTokens = 0;
    const k = createTableKernel(tableBinding, { ...s.dependencies, token: async (...args) => {
      if (hold) {
        hold = false; heldSignal = args[1].signal; heldTokens++;
        const token = await gate.promise; returnedTokens++; return token;
      }
      return s.dependencies.token(...args);
    } });
    if (boundary !== 'initialize') await k.initialize();
    if (boundary !== 'initialize' && boundary !== 'acquire') { await k.acquire(); await k.scan(); }
    const writes = s.stats.writes; const before = structuredClone(s.rows.get('M')); let originalDropped = false;
    s.controls.hook = e => {
      if (boundary === 'barrier' && e.actions[0]?.entity.Operation === 'mutate') {
        originalDropped = true; e.res.destroy(); return;
      }
      if (e.req.method === 'GET' && (['initialize', 'acquire', 'release'].includes(boundary) || originalDropped) && !heldSignal) hold = true;
      e.reply();
    };
    let grants = 0; let closed = false; let cleanRelease = false;
    const operation = boundary === 'initialize' ? k.initialize() : boundary === 'acquire' ? k.acquire() : boundary === 'release' ? k.close() :
      k.mutate(input, () => {
        if (boundary === 'mutate') hold = true;
        return { ...plan(), actions: [{ kind: 'create', key: { type: 'delivery', id: 'item' }, payload: Buffer.from('payload') }] };
      });
    const outcome = operation.then(() => { grants++; }, e => { assert.ok(code(e)); });
    await eventually(() => !!heldSignal); k.invalidate(); const synchronouslyAborted = heldSignal!.aborted;
    const close = k.close().then(() => { closed = true; cleanRelease = true; }, e => { assert.ok(code(e)); closed = true; });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(closed, false); assert.equal(returnedTokens, 0); assert.equal(grants, 0);
    assert.equal(k.status().pending, boundary === 'release' ? 0 : 1);
    gate.resolve(syntheticToken); await outcome; await close;
    assert.equal(s.stats.writes - writes, boundary === 'barrier' ? 1 : 0);
    assert.deepEqual(s.rows.get('M'), before); assert.equal(s.rows.has('delivery_aXRlbQ'), false);
    assert.equal(synchronouslyAborted, true); assert.equal(grants, 0); assert.equal(cleanRelease, false);
    assert.equal(heldTokens, 1); assert.equal(returnedTokens, 1); assert.equal(k.status().pending, 0);
    assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
    t.diagnostic(`held/returned tokens: ${heldTokens}/${returnedTokens}; grants: ${grants}; clean release: ${cleanRelease}; post-invalidation writes: 0`);
  });
}

test('invalidation during committed release readback rejects close after drain without denying the release', async t => {
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies);
  await k.initialize(); await k.acquire(); await k.scan();
  const gate = deferred(); let held = false; let finished = false;
  s.controls.hook = async e => {
    if (!held && e.req.method === 'GET' && s.rows.get('M')?.Operation === 'release') { held = true; await gate.promise; }
    e.reply();
  };
  const close = k.close(); assert.equal(k.close(), close);
  const outcome = close.then(() => 'resolved', e => code(e) ? 'unresolved' : 'other').then(value => { finished = true; return value; });
  await eventually(() => held); assert.equal(s.rows.get('M')?.Owner, '');
  k.invalidate(); await new Promise(r => setTimeout(r, 20)); assert.equal(finished, false);
  gate.resolve(); assert.equal(await outcome, 'unresolved');
  assert.equal(k.status().lifecycle, 'closed'); assert.equal(k.status().ownership, 'none');
  assert.equal(s.rows.get('M')?.Owner, ''); assert.equal(k.close(), close);
  assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
});

test('late committed transition cannot restore old-fence authority to poisoned diagnostic reads', async t => {
  const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies);
  await k.initialize(); await k.acquire(); await k.scan();
  const gate = deferred(); let held = false;
  s.controls.hook = async e => {
    if (!held && e.req.method === 'GET' && s.rows.get('M')?.Operation === 'mutate') { held = true; await gate.promise; }
    e.reply();
  };
  const rejected = assert.rejects(k.mutate(input, plan), code);
  await eventually(() => held); k.invalidate(); gate.resolve(); await rejected; delete s.controls.hook;
  s.rows.set('M', stamp(s.rows.get('M')!, 90002));
  const diagnostic = await k.read('M'); assert.equal(diagnostic?.etag, 'W/"90002"'); assert.equal(diagnostic?.value.kind, 'metadata');
  const writes = s.stats.writes;
  await assert.rejects(k.mutate(input, plan), code); await assert.rejects(k.acquire(), code);
  await assert.rejects(k.initialize(), code); await assert.rejects(k.scan(), code); await assert.rejects(k.close(), code);
  assert.equal(s.stats.writes, writes); assert.notEqual(s.rows.get('M')?.Owner, '');
});

for (const boundary of ['idle', 'planner', 'read', 'reconciliation'] as const) {
  test(`domain invalidation is sticky at ${boundary}, drains without grant or release`, async t => {
    const s = await tableService(t); const k = createTableKernel(tableBinding, s.dependencies);
    await k.initialize(); await k.acquire(); await k.scan();
    const gate = deferred(); let held = false; let drained = false; const writes = s.stats.writes;
    if (boundary === 'read' || boundary === 'reconciliation') s.controls.hook = async e => {
      if (!held && e.req.method === 'GET' && (boundary === 'read' || s.rows.get('M')?.Operation === 'mutate')) {
        held = true; await gate.promise;
      }
      e.reply();
    };
    if (boundary === 'idle') k.invalidate();
    const mutation = k.mutate(input, () => { if (boundary === 'planner') k.invalidate(); return plan(); });
    const rejected = assert.rejects(mutation, code);
    if (boundary === 'read' || boundary === 'reconciliation') { await eventually(() => held); k.invalidate(); }
    const close = k.close(); const closed = assert.rejects(close, code).then(() => { drained = true; });
    if (held) { await new Promise(r => setTimeout(r, 20)); assert.equal(drained, false); assert.equal(k.status().pending, 1); }
    gate.resolve(); await rejected; await closed;
    assert.equal(k.status().ownership, 'owned'); assert.notEqual(s.rows.get('M')?.Owner, '');
    assert.equal(s.stats.writes - writes, boundary === 'reconciliation' ? 1 : 0);
    assert.equal(s.stats.requests, s.stats.socketCloses); assert.equal(k.status().pending, 0);
  });
}
