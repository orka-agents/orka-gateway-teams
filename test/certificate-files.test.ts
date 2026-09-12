import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { prepareCertificate, assertCredentialSeparation } from '../src/auth/certificate.js';
import { certificateFiles } from './support/certificate.js';

for (const mode of [0o600, 0o400]) test(`private matching RSA pair prepares a snapshot with public cert mode ${mode}`, (t) => {
  const f = certificateFiles(t); fs.chmodSync(f.config.certificateFile, mode);
  const prepared = prepareCertificate(f.config); prepared.assertUsable();
  assert.equal(JSON.stringify(prepared), '{}');
  fs.unlinkSync(f.config.certificateFile); fs.unlinkSync(f.config.privateKeyFile);
  prepared.assertUsable(); // No reread or descriptors retained after preparation.
});

for (const variant of ['key permissions', 'cert permissions', 'directory permissions', 'key symlink', 'cert symlink', 'directory symlink',
  'hardlink', 'directory file', 'fifo', 'oversize', 'empty', 'extra certificate', 'extra key', 'trailing garbage', 'invalid UTF8',
  'encrypted', 'mismatched', 'weak RSA', 'EC', 'future', 'expired'] as const) {
  test(`private pair rejects ${variant} with a fixed safe error`, (t) => {
    const f = certificateFiles(t, variant === 'weak RSA' ? 'rsa:1024' : variant === 'EC' ? 'ec:prime256v1' : 'rsa:2048');
    if (variant === 'key permissions') fs.chmodSync(f.config.privateKeyFile, 0o644);
    if (variant === 'cert permissions') fs.chmodSync(f.config.certificateFile, 0o644);
    if (variant === 'directory permissions') fs.chmodSync(f.directory, 0o755);
    if (variant === 'hardlink') fs.linkSync(f.config.privateKeyFile, join(f.directory, 'alias'));
    if (variant === 'key symlink' || variant === 'cert symlink') {
      const path = variant === 'key symlink' ? f.config.privateKeyFile : f.config.certificateFile;
      fs.renameSync(path, path + '.held'); fs.symlinkSync(path + '.held', path);
    }
    if (variant === 'directory symlink') {
      const path = join(f.directory, 'alias'); fs.symlinkSync(f.directory, path);
      f.config.privateKeyFile = join(path, 'private-key.pem'); f.config.certificateFile = join(path, 'certificate.crt');
    }
    if (variant === 'directory file') { fs.unlinkSync(f.config.privateKeyFile); fs.mkdirSync(f.config.privateKeyFile, { mode: 0o600 }); }
    if (variant === 'fifo') {
      // Metadata rejection must happen before any ordinary open (including SQLite aliases).
      const stat = fs.lstatSync; t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
        const result = stat(...args); if (args[0] === f.config.privateKeyFile) return { ...result, isFile: () => false, isDirectory: () => false };
        return result;
      });
    }
    if (variant === 'oversize') fs.writeFileSync(f.config.privateKeyFile, 'x'.repeat(65537));
    if (variant === 'empty') fs.writeFileSync(f.config.privateKeyFile, '');
    if (variant === 'extra certificate') fs.appendFileSync(f.config.certificateFile, fs.readFileSync(f.config.certificateFile));
    if (variant === 'extra key') fs.appendFileSync(f.config.privateKeyFile, fs.readFileSync(f.config.privateKeyFile));
    if (variant === 'trailing garbage') fs.appendFileSync(f.config.privateKeyFile, 'not a key');
    if (variant === 'invalid UTF8') fs.appendFileSync(f.config.certificateFile, Buffer.from([0xff]));
    if (variant === 'encrypted') {
      const key = createPrivateKey(fs.readFileSync(f.config.privateKeyFile));
      fs.writeFileSync(f.config.privateKeyFile, key.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'synthetic-only' }));
    }
    if (variant === 'mismatched') fs.writeFileSync(f.config.privateKeyFile, fs.readFileSync(certificateFiles(t).config.privateKeyFile));
    if (variant === 'future') t.mock.method(Date, 'now', () => f.certificate.validFromDate.getTime() - 1);
    if (variant === 'expired') t.mock.method(Date, 'now', () => f.certificate.validToDate.getTime());
    assert.throws(() => prepareCertificate(f.config), { message: 'Invalid certificate credentials' });
  });
}

test('PKCS1 is normalized privately; TLS and validity are rechecked on the snapshot', (t) => {
  const f = certificateFiles(t); const key = createPrivateKey(fs.readFileSync(f.config.privateKeyFile));
  fs.writeFileSync(f.config.privateKeyFile, key.export({ type: 'pkcs1', format: 'pem' }));
  const prepared = prepareCertificate(f.config); prepared.assertUsable();
  t.mock.method(Date, 'now', () => f.certificate.validToDate.getTime());
  assert.throws(() => prepared.assertUsable(), { message: 'Invalid certificate credentials' });
});

test('metadata for BOTH files precedes opens; changed descriptor or read snapshot fails closed', (t) => {
  const f = certificateFiles(t); const open = fs.openSync;
  fs.chmodSync(f.config.privateKeyFile, 0o644); let opens = 0;
  const spy = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => { opens++; return open(...args); });
  assert.throws(() => prepareCertificate(f.config)); assert.equal(opens, 0); spy.mock.restore();
  fs.chmodSync(f.config.privateKeyFile, 0o600);
  const read = fs.readSync;
  t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    const count = read(...args); fs.appendFileSync(f.config.privateKeyFile, '\n'); return count;
  });
  assert.throws(() => prepareCertificate(f.config), { message: 'Invalid certificate credentials' });
});

test('untrusted ancestor refuses before opening either credential', (t) => {
  const f = certificateFiles(t); const nested = join(f.directory, 'private'); fs.mkdirSync(nested, { mode: 0o700 });
  fs.renameSync(f.config.certificateFile, join(nested, 'certificate.crt'));
  fs.renameSync(f.config.privateKeyFile, join(nested, 'private-key.pem'));
  f.config.certificateFile = join(nested, 'certificate.crt'); f.config.privateKeyFile = join(nested, 'private-key.pem');
  fs.chmodSync(f.directory, 0o777);
  const open = t.mock.method(fs, 'openSync', () => { throw new Error('must not open'); });
  assert.throws(() => prepareCertificate(f.config)); assert.equal(open.mock.callCount(), 0);
});

test('opened descriptor identity is checked and closed on failure', (t) => {
  const f = certificateFiles(t); const stat = fs.fstatSync; const close = fs.closeSync; let closes = 0;
  t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
    const stamp = stat(...args); return Object.assign(Object.create(Object.getPrototypeOf(stamp)), stamp, { ino: Number(stamp.ino) + 1 });
  });
  t.mock.method(fs, 'closeSync', (fd: number) => { closes++; close(fd); });
  assert.throws(() => prepareCertificate(f.config), { message: 'Invalid certificate credentials' }); assert.equal(closes, 1);
});

for (const key of [false, true]) test(`rejects extra DER hidden inside a single ${key ? 'key' : 'certificate'} PEM block`, (t) => {
  const f = certificateFiles(t); const path = key ? f.config.privateKeyFile : f.config.certificateFile;
  const text = fs.readFileSync(path, 'utf8');
  const payload = text.split('\n').slice(1, -2).join('');
  const extra = Buffer.concat([Buffer.from(payload, 'base64'), Buffer.from([0])]).toString('base64');
  fs.writeFileSync(path, text.replace(payload.match(/.{1,64}/gu)!.join('\n'), extra));
  assert.throws(() => prepareCertificate(f.config), { message: 'Invalid certificate credentials' });
});

test('metadata-only separation rejects storage names, sidecars, owner inode aliases and same directory before reads', (t) => {
  const f = certificateFiles(t); const other = certificateFiles(t);
  const open = t.mock.method(fs, 'openSync', () => { throw new Error('must not open'); });
  assert.throws(() => assertCredentialSeparation(f.config, [join(f.directory, 'database.sqlite')]));
  const alias = join(other.directory, 'delivery.sqlite.owner.sqlite-wal'); fs.linkSync(f.config.privateKeyFile, alias);
  assert.throws(() => assertCredentialSeparation(f.config, [alias]));
  assertCredentialSeparation(f.config, [join(other.directory, 'unrelated.sqlite')]);
  assert.equal(open.mock.callCount(), 0);
});
