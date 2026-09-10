import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { IAdaptiveCard } from '@microsoft/teams.cards';
import { formatDelivery, MAX_OUTGOING_MESSAGE_BYTES } from '../src/teams/format.js';
import { finalMessage, errorMessage, oversizedDelivery } from './fixtures/outgoing.js';

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

test('oversized preview exports a genuinely shortened formatter card', () => {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/preview-card.ts', 'oversized',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  const card: IAdaptiveCard = JSON.parse(result.stdout);
  assert.deepEqual(card, formatDelivery(oversizedDelivery).attachments[0].content);
  assert.equal(card.type, 'AdaptiveCard');
  assert.equal(card.body?.length, 3);
  const answer = card.body?.[1];
  const notice = card.body?.[2];
  assert.ok(answer?.type === 'TextBlock');
  assert.ok(notice?.type === 'TextBlock');
  assert.ok(oversizedDelivery.text.startsWith(answer.text));
  assert.ok(answer.text.length < oversizedDelivery.text.length);
  assert.match(answer.text, /こんにちは 🧑🏽‍💻/u);
  assert.match(notice.text, /shorten/i);
  const message = {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(message), 'utf8') <= MAX_OUTGOING_MESSAGE_BYTES);
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
  assert.equal(invalid.stderr, 'Usage: preview:card [final|error|oversized]\n');
});
