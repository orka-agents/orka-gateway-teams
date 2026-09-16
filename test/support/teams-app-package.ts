import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../../scripts/package-teams-app.py', import.meta.url));
const template = readFileSync(new URL('../../examples/teams-app/manifest.template.json', import.meta.url), 'utf8');
const fault = fileURLToPath(new URL('teams-app-package-fault.py', import.meta.url));
function png(size: number, alpha = true): Buffer {
  function chunk(name: string, value: Buffer): Buffer {
    const bytes = Buffer.concat([Buffer.from(name), value]);
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4); length.writeUInt32BE(value.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, bytes, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(size * (1 + size * (alpha ? 4 : 3))))), chunk('IEND', Buffer.alloc(0))]);
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'teams-app-package-'));
  const manifest = JSON.parse(template);
  manifest.id = '11111111-1111-4111-8111-111111111111';
  manifest.bots[0].botId = '22222222-2222-4222-8222-222222222222';
  manifest.developer = { name: 'Example', websiteUrl: 'https://example.com/', privacyUrl: 'https://example.com/privacy', termsOfUseUrl: 'https://example.com/terms' };
  writeFileSync(join(directory, 'color.png'), png(192, false));
  writeFileSync(join(directory, 'outline.png'), png(32));
  const output = join(directory, 'personal.zip');
  return { directory, manifest, output, run(failureMode?: 'write' | 'verify' | 'interrupt-write' | 'interrupt-verify') {
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    return spawnSync('python3', [...(failureMode ? [fault, script, failureMode] : [script]), '--manifest', join(directory, 'manifest.json'), '--color', join(directory, 'color.png'),
      '--outline', join(directory, 'outline.png'), '--output', output], { encoding: 'utf8', timeout: 15000 });
  }, close() { rmSync(directory, { recursive: true, force: true }); } };
}

for (const invalid of ['unknown-option', 'missing-value', 'missing-required'] as const) {
  test(`Teams package sanitizes ${invalid} diagnostics without creating output`, () => {
    const f = fixture();
    try {
      const args = [script, '--manifest', join(f.directory, 'manifest.json'), '--color', join(f.directory, 'color.png'),
        '--outline', join(f.directory, 'outline.png'), '--output', f.output];
      if (invalid === 'unknown-option') args.push('--unrecognized', 'SYNTHETIC_OPERATOR_ARGUMENT');
      if (invalid === 'missing-value') args.pop();
      if (invalid === 'missing-required') args.splice(3, 4);
      const result = spawnSync('python3', args, { encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 2); assert.equal(result.stdout, '');
      assert.equal(result.stderr === '{"packaged": false, "reason": "invalid input or output unavailable"}\n', true,
        'argument errors must use only the fixed diagnostic');
      assert.throws(() => readFileSync(f.output));
    } finally { f.close(); }
  });
}
test('Teams package help remains a successful explicit action', () => {
  const result = spawnSync('python3', [script, '--help'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes('--manifest'), true);
  assert.equal(result.stdout.includes('--output'), true);
});

test('Teams package contains only the three named public files', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.directory, 'unrelated-private-file'), 'not-package-input');
    const result = f.run(); assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.packaged, true);
    assert.deepEqual(report.files, ['manifest.json', 'color.png', 'outline.png']);
    assert.equal(readFileSync(f.output).includes(Buffer.from('unrelated-private-file')), false);
  } finally { f.close(); }
});
for (const invalid of ['group', 'placeholder', 'credentials', 'extra-field', 'wrong-size', 'missing-alpha', 'bad-header']) {
  test(`Teams package rejects ${invalid} before creating an archive`, () => {
    const f = fixture();
    try {
      if (invalid === 'group') f.manifest.bots[0].scopes = ['team'];
      if (invalid === 'placeholder') f.manifest.id = 'REQUIRED_TEAMS_PACKAGE_GUID';
      if (invalid === 'credentials') f.manifest.developer.websiteUrl = 'https://user:password@example.com/';
      if (invalid === 'extra-field') f.manifest.privateCapture = {};
      if (invalid === 'wrong-size') writeFileSync(join(f.directory, 'color.png'), png(32));
      if (invalid === 'missing-alpha') writeFileSync(join(f.directory, 'outline.png'), png(32, false));
      if (invalid === 'bad-header') writeFileSync(join(f.directory, 'color.png'), Buffer.alloc(40));
      const result = f.run(); assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stderr).packaged, false);
      assert.throws(() => readFileSync(f.output));
    } finally { f.close(); }
  });
}
for (const mode of ['write', 'verify', 'interrupt-write', 'interrupt-verify'] as const) {
  test(`Teams package removes only its own incomplete output after ${mode} failure`, () => {
    const f = fixture();
    try {
      const result = f.run(mode); assert.equal(result.status, 0);
      const outcome = JSON.parse(result.stdout);
      assert.equal(outcome.raised, true); assert.equal(outcome.outputExists, false);
      assert.equal(outcome.interrupted, mode.startsWith('interrupt-'));
    } finally { f.close(); }
  });
}
test('Teams package never overwrites an existing output artifact', () => {
  const f = fixture();
  try {
    const original = Buffer.from('existing artifact'); writeFileSync(f.output, original);
    assert.equal(f.run().status, 1);
    assert.equal(readFileSync(f.output).equals(original), true);
  } finally { f.close(); }
});
