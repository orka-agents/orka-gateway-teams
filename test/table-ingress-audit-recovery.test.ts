import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditInbox } from '../src/ingress/table-audit.js';
import { encode } from '../src/ingress/codec.js';
import { encodeState } from '../src/ingress/table-codec.js';
import { createTableKernelV2 } from '../src/storage/table/index.js';
import { code } from './support/owned-audit.js';
import { hash, ingressBinding, stamp } from './support/table-service.js';
import { inboxOwned, auditBudget, indexBudget, install, pair, wireData } from './support/table-ingress-audit.js';
import { armId, stateFixture, sealFixture } from './support/table-ingress.js';
import { mDigestV2 } from './support/table-v2.js';

for (const disposition of ['unarmed', 'uncertain', 'regression', 'prior-uncertain'] as const)
  for (const fault of [...(['none', 'fold', 'count', 'tamper', 'removal', 'exit', 'later-clean'] as const),
    ...(disposition === 'unarmed' ? ['coherent-removal' as const] : [])])
    test('persisted read-only recovery ' + disposition + ' / ' + fault, async t => {
      const { s, k } = await inboxOwned(t); const sealed = disposition !== 'unarmed';
      const state = stateFixture({ lastNow: 150, currentGeneration: sealed ? null : 1 });
      const seal = sealFixture(disposition === 'regression' ? {} : { reason: 'clock-uncertain', observation: null, epoch: 2 });
      await install(k, { state, pairs: [pair()], seals: sealed ? [seal] : [] }); await k.close();
      // Persisted examples only. No client can submit a recover operation.
      const original = s.rows.get('M')!; const oldEpoch = disposition === 'prior-uncertain' ? 3 : 2;
      const invocation = '55555555-5555-4555-8555-555555555555'; const originalMDigest = 'a'.repeat(64);
      let fold = hash(['orka-recovery-data-v2', original.Binding]); let count = 0;
      for (const [row, data] of [...s.rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) if (row !== 'M') {
        fold = hash(['orka-recovery-row-v2', fold, row, data.Digest]); count++;
      }
      if (fault === 'coherent-removal') {
        // Empty graph and state remain mutually consistent. Preserve the original
        // physical commitment so ONLY the full fold/count rejects the removal.
        state.records = 0; state.bodies = 0; state.currentGeneration = null;
        for (const row of [...s.rows.keys()]) if (row !== 'M') s.rows.delete(row);
      }
      const stateBase64 = encodeState(state).toString('base64');
      const result = { schema: 1, operation: 'operator-recovery', invocation, oldEpoch, originalMDigest,
        disposition: disposition === 'unarmed' || disposition === 'prior-uncertain' ? { kind: 'inbox-unarmed' } :
          { kind: 'inbox-clock-uncertain', armId, generation: 1, watermark: 150 },
        postStateDigest: hash(['orka-recovery-state-v2', original.Binding, stateBase64]),
        postDataDigest: fault === 'fold' ? 'b'.repeat(64) : hash(['orka-recovery-data-end-v2', fold, count]),
        dataRowCount: fault === 'count' ? count + 1 : count };
      const resultBase64 = encode(result).toString('base64');
      const exit = { kind: 'operator-recovery', oldOwner: '66666666-6666-4666-8666-666666666666', oldEpoch, invocation,
        originalMDigest, planDigest: 'c'.repeat(64),
        domainDispositionDigest: hash(['orka-inbox-recovery-v2', original.Binding, resultBase64]), operatorAttestationDigest: 'd'.repeat(64) };
      if (fault === 'exit') exit.domainDispositionDigest = 'e'.repeat(64);
      const clean = { kind: 'clean-release', oldOwner: exit.oldOwner, oldEpoch: oldEpoch + 1,
        invocation: '77777777-7777-4777-8777-777777777777', planDigest: 'c'.repeat(64) };
      const retained = fault === 'later-clean' ? clean : exit;
      const m = { ...original, Owner: '', Epoch: String(retained.oldEpoch), Invocation: retained.invocation,
        Operation: fault === 'later-clean' ? 'release' : 'recover', Plan: retained.planDigest,
        State: stateBase64, Result: resultBase64, Exit: encode(retained).toString('base64') };
      s.rows.set('M', stamp({ ...m, Digest: mDigestV2(m) }, 500));
      if (fault === 'removal') for (const row of [...s.rows.keys()]) if (row.startsWith('route_')) s.rows.delete(row);
      if (fault === 'tamper') {
        // Service URL is outside the full fingerprint. Keep local route/body
        // checks valid: only the complete recovery data commitment catches this.
        const row = [...s.rows.keys()].find(row => row.startsWith('route_'))!;
        const e = s.rows.get(row)!; const payload = JSON.parse(Buffer.from(String(e.B0), 'base64').toString());
        payload.route.serviceUrl = 'https://different.example.invalid/'; payload.routeDigest = hash(payload.route);
        s.rows.set(row, wireData(s, 'route', String(e.Id), encode(payload)));
      }
      const next = createTableKernelV2(ingressBinding, s.dependencies); await next.acquire();
      if (fault === 'none' || fault === 'later-clean') {
        const audited = await auditInbox(next, ingressBinding, auditBudget, indexBudget);
        assert.equal(audited.header.state.restartEpoch, 1); assert.equal(audited.header.metadata.epoch, retained.oldEpoch + 1);
        assert.equal(audited.index.diagnostics().events, 1); audited.dispose(); await next.close();
      } else {
        await assert.rejects(auditInbox(next, ingressBinding, auditBudget, indexBudget), code('unresolved'));
        await assert.rejects(next.close(), code('unresolved'));
      }
    });
