import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { finalMessage, errorMessage } from './fixtures/outgoing.js';

test('preview exports only the selected synthetic card', () => {
  for (const [name, expected] of [
    ['final', finalMessage], ['error', errorMessage],
  ] as const) {
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', 'scripts/preview-card.ts', name,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected.attachments[0].content);
    assert.ok(result.stdout.endsWith('\n'));
  }
});

test('preview defaults to final and rejects an unknown selection', () => {
  const defaultResult = spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/preview-card.ts',
  ], { encoding: 'utf8' });
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(defaultResult.stderr, '');
  assert.deepEqual(JSON.parse(defaultResult.stdout), finalMessage.attachments[0].content);
  assert.ok(defaultResult.stdout.endsWith('\n'));
  const invalid = spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/preview-card.ts', 'unknown',
  ], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'Usage: preview:card [final|error]\n');
});
