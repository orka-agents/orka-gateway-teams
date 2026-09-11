import assert from 'node:assert/strict';
import { DeliveryJournalError, openDeliveryJournal } from '../../src/delivery/journal.js';
import { finalDelivery } from '../fixtures/outgoing.js';

const [mode, path] = process.argv.slice(2);
assert.ok(path && mode);
const scope = { appId: mode === 'wrong-scope' ? 'wrong-app' : 'app-fixture', tenantId: finalDelivery.accountId };

function finish(message: object) {
  process.send!(message, () => process.disconnect());
}

try {
  const journal = openDeliveryJournal(path, scope);
  if (mode === 'probe' || mode === 'wrong-scope') {
    journal.close();
    finish({ kind: 'opened' });
  } else {
    const result = journal.begin(finalDelivery);
    assert.equal(result.kind, 'claimed');
    if (result.kind !== 'claimed') throw new Error('expected fixture claim');
    const receipt = { kind: 'delivered', providerMessageId: 'provider-child-fixture' } as const;
    if (mode === 'receipt') {
      assert.equal(journal.settle(result.claim, receipt), 'recorded');
      process.send!({ kind: 'receipt', receipt });
    } else {
      process.send!({ kind: 'claimed', claim: result.claim });
    }
    process.on('message', (message) => {
      if (message === 'settle') {
        assert.equal(journal.settle(result.claim, receipt), 'recorded');
        process.send!({ kind: 'receipt', receipt });
      } else if (message === 'exit') {
        journal.close();
        process.disconnect();
      } else if (message === 'exit-without-close') {
        process.exit(0);
      } else {
        throw new Error('unknown worker test command');
      }
    });
  }
} catch (error) {
  if (!(error instanceof DeliveryJournalError)) throw error;
  finish({ kind: 'error', code: error.code });
}
