import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { IngressStoreError, openIngressStore } from '../../src/ingress/store.js';
import { expectedEvent } from '../fixtures/incoming.js';

const [mode, path, scopeJSON] = process.argv.slice(2);
assert.ok(path && scopeJSON);
const scope = JSON.parse(scopeJSON);
function finish(message: object) { process.send!(message, () => process.disconnect()); }
try {
  if (mode === 'sqlite-probe') {
    const db = new DatabaseSync(path);
    try { db.exec('BEGIN EXCLUSIVE; COMMIT'); finish({ kind: 'opened' }); }
    finally { db.close(); }
  } else {
    const store = openIngressStore(path, scope);
    if (mode === 'claim') {
      const claim = store.claim(); assert.ok(claim);
      process.send!({ kind: 'claimed', claim });
      process.on('message', (message) => {
        if (message === 'complete') {
          assert.equal(store.complete(claim, { status: 'accepted', eventId: 'gev-fixture', state: 'Accepted' }), true);
          process.send!({ kind: 'completed' });
        } else if (message === 'exit') { store.close(); process.disconnect(); }
        else if (message === 'exit-without-close') process.exit(0);
      });
    } else {
      assert.equal(store.scope.tenantId, expectedEvent.accountId);
      store.close(); finish({ kind: 'opened' });
    }
  }
} catch (error) {
  if (error instanceof IngressStoreError) finish({ kind: 'error', code: error.code });
  else if (error instanceof Error && 'errcode' in error && error.errcode === 5) finish({ kind: 'error', code: 'busy' });
  else throw error;
}
