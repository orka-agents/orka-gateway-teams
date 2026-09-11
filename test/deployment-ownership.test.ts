import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withStoppedOwners, type OwnershipSnapshot } from './support/deployment-smoke.js';

// A CLI acknowledgement/phase alone must never authorize mutation of the owner inode.
const stopped = (): OwnershipSnapshot => ({ namespaceUID: 'owned-uid', owner: 'owned-marker',
  controllers: [{ replicas: 0 }], pods: [{ metadata: { uid: 'pod-uid' }, spec: { containers: [{ name: 'app' }], restartPolicy: 'Never' },
    status: { phase: 'Failed', containerStatuses: [{ name: 'app', state: { terminated: { exitCode: 1 } } }] } }] });
for (const scenario of [
  'stopped', 'wrong namespace', 'wrong marker', 'desired replica', 'pending', 'running', 'missing status',
  'waiting', 'missing container', 'sidecar running', 'restartable',
] as const) {
  test(`owner mutation requires complete termination proof: ${scenario}`, async () => {
    const snapshot = stopped();
    switch (scenario) {
      case 'wrong namespace': snapshot.namespaceUID = 'other'; break;
      case 'wrong marker': snapshot.owner = 'other'; break;
      case 'desired replica': snapshot.controllers[0]!.replicas = 1; break;
      case 'pending': snapshot.pods[0]!.status.phase = 'Pending'; break;
      case 'running': snapshot.pods[0]!.status.phase = 'Running'; break;
      case 'missing status': snapshot.pods[0]!.status.containerStatuses = []; break;
      case 'waiting': snapshot.pods[0]!.status.containerStatuses![0]!.state = { waiting: {} }; break;
      case 'missing container': snapshot.pods[0]!.spec.containers.push({ name: 'proxy' }); break;
      case 'sidecar running': snapshot.pods[0]!.spec.initContainers = [{ name: 'sidecar' }];
        snapshot.pods[0]!.status.initContainerStatuses = [{ name: 'sidecar', state: { running: {} } }]; break;
      case 'restartable': snapshot.pods[0]!.spec.restartPolicy = 'Always'; break;
    }
    const directory = mkdtempSync(join(tmpdir(), 'teams-owner-proof-'));
    const original = join(directory, 'owner'); const held = join(directory, 'held');
    writeFileSync(original, 'synthetic bytes', { mode: 0o600 });
    let rejected = false;
    try {
      await withStoppedOwners('owned-uid', 'owned-marker', async () => snapshot, async () => renameSync(original, held));
    } catch { rejected = true; }
    try {
      assert.equal(rejected, scenario !== 'stopped');
      assert.equal(readFileSync(scenario === 'stopped' ? held : original, 'utf8') === 'synthetic bytes', true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('unavailable ownership inspection cannot authorize mutation', async () => {
  let mutated = false;
  await assert.rejects(withStoppedOwners('owned-uid', 'owned-marker', async () => { throw new Error('inspection unavailable'); }, async () => { mutated = true; }));
  assert.equal(mutated, false);
});
