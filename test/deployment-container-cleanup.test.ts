import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkMissingOwner } from './support/container-smoke.js';

// Exercise real file movement with only the Docker CLI boundary replaced. No
// daemon failure is induced, and no synthetic owner bytes enter assertion output.
for (const scenario of [
  { name: 'expected stopped exit one', code: 1, before: 'exited false false 1', after: 'exited false false 1', passes: true, restores: true, stops: 0 },
  { name: 'CLI exit one while container still runs', code: 1, before: 'running true false 0', after: 'exited false false 137', passes: false, restores: true, stops: 1 },
  { name: 'Docker client timeout', code: -1, before: 'running true false 0', after: 'exited false false 137', passes: false, restores: true, stops: 1 },
  { name: 'unexpected container exit zero', code: 1, before: 'exited false false 0', after: 'exited false false 0', passes: false, restores: true, stops: 1 },
  { name: 'stop acknowledges but container still runs', code: -1, before: 'running true false 0', after: 'running true false 0', passes: false, restores: false, stops: 1 },
  { name: 'stop and inspect cannot confirm termination', code: -1, before: 'running true false 0', after: '', passes: false, restores: false, stops: 1 },
  { name: 'restarting container is not stopped proof', code: 1, before: 'exited false true 1', after: 'exited false true 1', passes: false, restores: false, stops: 1 },
  { name: 'launch throws before returning its client result', code: null, before: 'running true false 0', after: 'exited false false 137', passes: false, restores: true, stops: 1 },
] as const) test(`missing-owner fixture: ${scenario.name}`, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-owner-cleanup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const owner = join(directory, 'delivery.sqlite.owner.sqlite'); const held = join(directory, 'owner.held');
  const privateValue = randomUUID(); writeFileSync(owner, privateValue, { mode: 0o600 });
  const containerName = 'owned-missing-owner'; let stopped = false; let stops = 0; let inspected = 0;
  let restoredBeforeProof = false; let wrongContainer = false; let confirmedTermination = false;
  const passed = await checkMissingOwner(directory, containerName, async () => {
    assert.equal(existsSync(owner), false); assert.equal(existsSync(held), true);
    if (scenario.code === null) throw new Error(privateValue);
    return { code: scenario.code, stdout: '', stderr: '' };
  }, async (args) => {
    if (args.at(-1) !== containerName) { wrongContainer = true; return { code: -1, stdout: '', stderr: '' }; }
    restoredBeforeProof ||= existsSync(owner) || !existsSync(held);
    if (args[0] === 'stop') { stops++; stopped = true; return { code: scenario.after ? 0 : -1, stdout: '', stderr: '' }; }
    if (args[0] === 'inspect') {
      inspected++; const state = stopped ? scenario.after : scenario.before;
      confirmedTermination ||= /^exited false false \d+$/u.test(state);
      return { code: state ? 0 : -1, stdout: state, stderr: '' };
    }
    throw new Error('Unexpected Docker boundary operation');
  }).then(() => true, () => false);
  restoredBeforeProof ||= existsSync(owner) && !confirmedTermination;
  assert.equal(restoredBeforeProof, false);
  assert.equal(existsSync(owner), scenario.restores); assert.equal(existsSync(held), !scenario.restores);
  assert.equal(passed, scenario.passes); assert.equal(stops, scenario.stops);
  assert.equal(inspected > 0, true); assert.equal(wrongContainer, false);
  assert.equal(readFileSync(scenario.restores ? owner : held, 'utf8') === privateValue, true);
});
