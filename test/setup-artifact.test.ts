import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { openSetupArtifact } from '../src/setup/artifact.js';
import { setupFiles } from './support/setup.js';

const candidate = { appId: 'app', tenantId: 'tenant', recipientId: 'bot', serviceUrl: 'https://example.invalid/', senderId: 'person', conversationId: 'chat' };
const fields = ['appId', 'conversationId', 'recipientId', 'senderId', 'serviceUrl', 'tenantId'];

test('private writer snapshots exact challenge and exclusively publishes only six bounded fields at 0600/nlink1', (t) => {
  const { config, challenge, directory } = setupFiles(t); const writer = openSetupArtifact(config); t.after(() => writer.close());
  assert.equal(writer.matches(challenge), true); assert.equal(writer.matches(challenge + '\n'), false);
  assert.equal(writer.matches(challenge.toUpperCase()), false);
  fs.writeFileSync(config.challengeFile, 'changed'); assert.equal(writer.matches(challenge), true);
  assert.deepEqual(fs.readdirSync(directory), ['challenge']);
  const extra = { ...candidate, text: challenge, token: 'not-output' }; writer.publish(extra, () => true);
  const saved = JSON.parse(fs.readFileSync(config.captureFile, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), fields);
  assert.equal(fields.every((field) => saved[field] === candidate[field as keyof typeof candidate]), true);
  const stamp = fs.lstatSync(config.captureFile); assert.equal(stamp.mode & 0o777, 0o600); assert.equal(stamp.nlink, 1);
  assert.equal(stamp.isFile(), true); assert.equal(stamp.uid, process.getuid!());
  assert.deepEqual(fs.readdirSync(directory).sort(), ['candidate.json', 'challenge']);
  assert.throws(() => writer.publish(candidate, () => true), { message: 'Setup capture failed' });
  writer.close(); writer.close();
});

for (const variant of ['newline', 'uppercase', 'short', 'invalid utf8', 'long', 'mode', 'execute', 'unreadable', 'hardlink', 'symlink', 'directory', 'fifo'] as const) {
  test(`challenge refuses ${variant} without a publication`, async (t) => {
    const { config, challenge, directory } = setupFiles(t);
    if (variant === 'newline') fs.writeFileSync(config.challengeFile, challenge + '\n');
    if (variant === 'uppercase') fs.writeFileSync(config.challengeFile, challenge.toUpperCase());
    if (variant === 'short') fs.writeFileSync(config.challengeFile, challenge.slice(1));
    if (variant === 'invalid utf8') fs.writeFileSync(config.challengeFile, Buffer.alloc(43, 0xff));
    if (variant === 'long') fs.writeFileSync(config.challengeFile, 'a'.repeat(100000));
    if (variant === 'mode') fs.chmodSync(config.challengeFile, 0o640);
    if (variant === 'execute') fs.chmodSync(config.challengeFile, 0o700);
    if (variant === 'unreadable') fs.chmodSync(config.challengeFile, 0o200);
    if (variant === 'hardlink') fs.linkSync(config.challengeFile, join(directory, 'alias'));
    if (['symlink', 'directory', 'fifo'].includes(variant)) {
      fs.unlinkSync(config.challengeFile);
      if (variant === 'symlink') fs.symlinkSync(join(directory, 'absent'), config.challengeFile);
      if (variant === 'directory') fs.mkdirSync(config.challengeFile);
      if (variant === 'fifo') {
        const { execFileSync } = await import('node:child_process'); execFileSync('mkfifo', [config.challengeFile]);
      }
    }
    assert.throws(() => openSetupArtifact(config), { message: 'Setup capture failed' });
    assert.equal(fs.existsSync(config.captureFile), false);
  });
}

for (const variant of ['file', 'dangling symlink', 'hardlink', 'directory'] as const) {
  test(`existing output ${variant} is refused without reading its bytes`, (t) => {
    const { config, directory } = setupFiles(t);
    if (variant === 'file') fs.writeFileSync(config.captureFile, 'preserve', { mode: 0o600 });
    if (variant === 'dangling symlink') fs.symlinkSync(join(directory, 'absent'), config.captureFile);
    if (variant === 'hardlink') fs.linkSync(config.challengeFile, config.captureFile);
    if (variant === 'directory') fs.mkdirSync(config.captureFile);
    let opened = false; const open = fs.openSync;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => { if (args[0] === config.captureFile) opened = true; return open(...args); });
    assert.throws(() => openSetupArtifact(config), { message: 'Setup capture failed' }); assert.equal(opened, false);
    assert.equal(fs.lstatSync(config.captureFile).isSymbolicLink(), variant === 'dangling symlink');
  });
}

test('private parent and every ancestor must be nonsymlink trusted directories', (t) => {
  const { config, directory } = setupFiles(t);
  fs.chmodSync(directory, 0o750); assert.throws(() => openSetupArtifact(config)); fs.chmodSync(directory, 0o700);
  const unsafe = join(directory, 'unsafe'); fs.mkdirSync(unsafe, { mode: 0o777 }); fs.chmodSync(unsafe, 0o777);
  const child = join(unsafe, 'child'); fs.mkdirSync(child, { mode: 0o700 });
  assert.throws(() => openSetupArtifact({ ...config, captureFile: join(child, 'out') }));
  const alias = join(directory, 'alias'); fs.symlinkSync(directory, alias);
  assert.throws(() => openSetupArtifact({ ...config, captureFile: join(alias, 'out') }));
});

test('challenge opened inode must match metadata preflight', (t) => {
  const { config, challenge } = setupFiles(t); const open = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === config.challengeFile) { fs.renameSync(config.challengeFile, config.challengeFile + '.old'); fs.writeFileSync(config.challengeFile, challenge, { mode: 0o600 }); }
    return open(...args);
  });
  assert.throws(() => openSetupArtifact(config)); assert.equal(fs.existsSync(config.captureFile), false);
});

test('separate challenge parent replacement cannot hide behind an unchanged opened file inode', (t) => {
  const { config, directory } = setupFiles(t);
  const inputDirectory = join(directory, 'input'); fs.mkdirSync(inputDirectory, { mode: 0o700 });
  const challengeFile = join(inputDirectory, 'challenge'); fs.renameSync(config.challengeFile, challengeFile);
  const read = fs.readSync;
  t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    const result = read(...args);
    fs.renameSync(inputDirectory, inputDirectory + '-held'); fs.symlinkSync(inputDirectory + '-held', inputDirectory);
    return result;
  });
  let opened: ReturnType<typeof openSetupArtifact> | undefined;
  try { assert.throws(() => { opened = openSetupArtifact({ ...config, challengeFile }); }, { message: 'Setup capture failed' }); }
  finally { opened?.close(); }
});

for (const variant of ['inactive', 'too large', 'directory replaced', 'output raced', 'fsync file', 'link failed', 'link ambiguous', 'fsync directory', 'temp replaced'] as const) {
  test(`publication ${variant} fails closed, preserves evidence, and cannot recapture`, (t) => {
    const { config, directory } = setupFiles(t); const writer = openSetupArtifact(config); t.after(() => writer.close());
    const sync = fs.fsyncSync; const link = fs.linkSync;
    if (variant === 'directory replaced') {
      fs.renameSync(directory, directory + '-old'); t.after(() => fs.rmSync(directory + '-old', { recursive: true, force: true })); fs.mkdirSync(directory, { mode: 0o700 });
    }
    if (variant === 'output raced') fs.writeFileSync(config.captureFile, 'preserve', { mode: 0o600 });
    if (variant === 'fsync file' || variant === 'fsync directory') t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (fs.fstatSync(fd).isDirectory() === (variant === 'fsync directory')) throw new Error('private fault'); sync(fd);
    });
    if (variant === 'link failed' || variant === 'link ambiguous') t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
      if (variant === 'link ambiguous') link(...args); throw new Error('private fault');
    });
    if (variant === 'temp replaced') t.mock.method(fs, 'fsyncSync', (fd: number) => {
      sync(fd); if (!fs.fstatSync(fd).isFile()) return;
      const name = fs.readdirSync(directory).find((name) => name !== 'challenge')!;
      fs.renameSync(join(directory, name), join(directory, 'held')); fs.writeFileSync(join(directory, name), 'preserve', { mode: 0o600 });
    });
    assert.throws(() => writer.publish({ ...candidate, ...(variant === 'too large' ? { senderId: 'x'.repeat(4096) } : {}) }, () => variant !== 'inactive'), { message: 'Setup capture failed' });
    assert.throws(() => writer.publish(candidate, () => true));
    if (variant === 'output raced') assert.equal(fs.readFileSync(config.captureFile, 'utf8') === 'preserve', true);
    else assert.equal(fs.existsSync(config.captureFile), variant === 'link ambiguous' || variant === 'fsync directory');
    if (['inactive', 'too large', 'fsync file', 'link failed'].includes(variant)) assert.deepEqual(fs.readdirSync(directory), ['challenge']);
    if (variant === 'temp replaced') assert.equal(fs.readdirSync(directory).length, 3);
  });
}

for (const boundary of ['publish close', 'directory close'] as const) {
  test(`writer ${boundary} failure is fixed-safe and preserves published evidence`, (t) => {
    const { config } = setupFiles(t); const writer = openSetupArtifact(config);
    const close = fs.closeSync;
    t.mock.method(fs, 'closeSync', (fd: number) => {
      const directory = fs.fstatSync(fd).isDirectory(); close(fd);
      if (directory === (boundary === 'directory close')) throw new Error('private close failure');
    });
    if (boundary === 'publish close') {
      assert.throws(() => writer.publish(candidate, () => true), { message: 'Setup capture failed' }); writer.close();
    } else {
      writer.publish(candidate, () => true); assert.throws(() => writer.close(), { message: 'Setup capture failed' }); writer.close();
    }
    assert.equal(fs.existsSync(config.captureFile), true);
  });
}

test('synchronous publication fence cannot reenter the writer for a second candidate', (t) => {
  const { config } = setupFiles(t); const writer = openSetupArtifact(config); t.after(() => writer.close());
  writer.publish(candidate, () => {
    assert.throws(() => writer.publish(candidate, () => true), { message: 'Setup capture failed' }); return true;
  });
  assert.equal(fs.statSync(config.captureFile).nlink, 1);
});

test('active fence is checked after file sync immediately before linking', (t) => {
  const { config, directory } = setupFiles(t); const writer = openSetupArtifact(config); t.after(() => writer.close());
  let active = true; const sync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', (fd: number) => { sync(fd); active = false; });
  assert.throws(() => writer.publish(candidate, () => active));
  assert.deepEqual(fs.readdirSync(directory), ['challenge']);
});
