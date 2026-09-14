import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditV2Startup } from '../src/delivery/table-codec.js';
import { createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import { bindTable, decodeRecordV2 } from '../src/storage/table/codec.js';
import { code } from './support/table-delivery.js';
import { recoveryHistory } from './support/table-delivery-v2.js';
import { tableBinding } from './support/table-service.js';
import { changedM2, nextOwner, wireM2 } from './support/table-v2.js';

for (const operation of ['mutate', 'barrier', 'release'] as const) test(`V2 startup audit refuses valid lifecycle ${operation} that is not a fresh owned acquisition`, () => {
  const raw = changedM2(wireM2(operation === 'release' ? '' : nextOwner, 2), { Operation: operation,
    State: Buffer.from('{"journal":"teams-delivery","schema":1,"fingerprint":1}').toString('base64'),
    Result: Buffer.from('{"schema":1,"operation":"initialize"}').toString('base64') });
  const record = decodeRecordV2(bindTable(tableBinding), Buffer.from(JSON.stringify(raw)));
  assert.throws(() => auditV2Startup(bindTable(tableBinding), [record]), code('corrupt'));
});

for (const damage of ['epoch', 'missing', 'tag', 'noncanonical', 'digest', 'same-owner'] as const)
  test(`V2 malformed recovery Exit ${damage} refuses before acquisition writes`, async t => {
    const { s } = await recoveryHistory(t); const m = s.rows.get('M')!;
    const exit = JSON.parse(Buffer.from(String(m.Exit), 'base64').toString());
    if (damage === 'epoch') exit.oldEpoch++;
    if (damage === 'tag') exit.kind = 'clean-release';
    if (damage === 'digest') exit.domainDispositionDigest = 'invalid';
    const text = damage === 'missing' ? '' : (damage === 'noncanonical' ? ' ' : '') + JSON.stringify(exit);
    const change = damage === 'same-owner' ? { Owner: exit.oldOwner, Epoch: String(Number(m.Epoch) + 1), Operation: 'acquire' } : {};
    s.rows.set('M', changedM2(m, { ...change, Exit: Buffer.from(text).toString('base64') }, 95000));
    const before = s.stats.writes; const saved = JSON.stringify(s.rows.get('M'));
    const j = createTableDeliveryJournalV2(tableBinding, s.dependencies);
    await assert.rejects(j.open(), code('corrupt')); await j.close().catch(() => undefined);
    assert.equal(s.stats.writes, before); assert.equal(JSON.stringify(s.rows.get('M')) === saved, true);
  });

test('V2 authority changed after acquisition cannot establish a startup boundary or release', async t => {
  const { s } = await recoveryHistory(t); let confirmation = false;
  s.controls.hook = e => {
    if (s.rows.get('M')!.Operation === 'acquire' && e.req.method === 'GET') {
      if (confirmation) s.rows.set('M', changedM2(s.rows.get('M')!, { Operation: 'barrier' }, 95001));
      confirmation = true;
    }
    e.reply();
  };
  const j = createTableDeliveryJournalV2(tableBinding, s.dependencies); const before = s.stats.writes;
  await assert.rejects(j.open(), code('unavailable')); await assert.rejects(j.close(), code('unavailable'));
  assert.equal(s.stats.writes - before, 1); assert.equal(s.rows.get('M')!.Owner !== '', true);
});
