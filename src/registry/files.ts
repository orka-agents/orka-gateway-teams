import type { Stats } from 'node:fs';
import * as fs from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ConfigurationError } from '../ingress/config.js';

export function absoluteFile(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.length > 4096 || /\p{Cc}|[\uD800-\uDFFF]/u.test(value)) throw new ConfigurationError();
  return value;
}
/** One bounded no-follow snapshot; reject aliases and replacement during the read. */
export function readRegistryFile(path: string, limit: number, privateFile = true): string {
  let fd: number | undefined;
  try {
    absoluteFile(path); const parent = dirname(path); const directory = fs.lstatSync(parent);
    const trusted = (s: Stats) => (s.uid === process.getuid?.() || (!privateFile && s.uid === 0)) && (s.mode & 0o022) === 0;
    if (!directory.isDirectory() || fs.realpathSync(parent) !== parent || !trusted(directory)) throw new ConfigurationError();
    const before = fs.lstatSync(path);
    const check = (s: Stats) => {
      if (!s.isFile() || s.nlink !== 1 || s.size > limit || !trusted(s) || (privateFile && (s.mode & 0o077) !== 0)) throw new ConfigurationError();
    };
    check(before); fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    same(before, fs.fstatSync(fd)); const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size <= limit) { const n = fs.readSync(fd, bytes, size, limit + 1 - size, null); if (!n) break; size += n; }
    if (size > limit) throw new ConfigurationError();
    const after = fs.fstatSync(fd); check(after); same(before, after); same(after, fs.lstatSync(path)); same(directory, fs.lstatSync(parent));
    if (fs.realpathSync(parent) !== parent) throw new ConfigurationError();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } catch { throw new ConfigurationError(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function same(a: Stats, b: Stats): void {
  if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mode !== b.mode || a.uid !== b.uid || a.nlink !== b.nlink || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs) throw new ConfigurationError();
}
