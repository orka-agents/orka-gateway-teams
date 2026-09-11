import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { validateSetupConfig } from './config.js';
import type { SetupConfig } from './config.js';

export interface SetupCandidate { appId: string; tenantId: string; recipientId: string; serviceUrl: string; senderId: string; conversationId: string }
export interface SetupArtifact {
  matches(text: unknown): boolean;
  publish(candidate: SetupCandidate, active: () => boolean): void;
  close(): void;
}

/** Owns only a dedicated capture directory, never a runtime/SQLite ownership file. */
export function openSetupArtifact(input: SetupConfig): SetupArtifact {
  let directoryFd: number | undefined;
  try {
    const config = validateSetupConfig(input); const directory = dirname(config.captureFile);
    const parent = trustedParent(directory); const challengeParent = trustedParent(dirname(config.challengeFile));
    absent(config.captureFile); // Metadata only: do not open/adopt any existing output, even a dangling link.
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    same(parent, fs.fstatSync(directoryFd));
    const expected = fs.lstatSync(config.challengeFile); privateFile(expected, false);
    const fd = fs.openSync(config.challengeFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let challenge: string;
    try {
      const opened = fs.fstatSync(fd); same(expected, opened); privateFile(opened, false);
      if (opened.size !== 43) fail();
      const bytes = Buffer.alloc(44); const size = fs.readSync(fd, bytes, 0, 44, 0);
      const after = fs.fstatSync(fd); same(opened, after); privateFile(after, false);
      same(after, fs.lstatSync(config.challengeFile));
      if (size !== 43 || after.size !== 43 || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail();
      challenge = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
      if (!/^orka-setup:[0-9a-f]{32}$/u.test(challenge)) fail();
    } finally { fs.closeSync(fd); }
    // Check both parents across the snapshot, even when input/output directories differ.
    same(challengeParent, trustedParent(dirname(config.challengeFile)));
    const ownedFd = directoryFd;
    const checkParent = () => { same(parent, trustedParent(directory)); same(parent, fs.fstatSync(ownedFd)); };
    checkParent(); absent(config.captureFile);
    let closed = false; let reserved = false;
    return {
      matches: (text) => !closed && typeof text === 'string' && text === challenge,
      publish(candidate, active) {
        if (closed || reserved) fail();
        reserved = true; // Synchronous reservation: no retry after any failure or ambiguous publication.
        let temp: string | undefined; let tempFd: number | undefined; let owned: Stats | undefined;
        let published = false; let linkAttempted = false;
        try {
          if (!active()) fail();
          const bytes = encode(candidate); checkParent(); absent(config.captureFile);
          temp = join(directory, `.capture-${randomBytes(16).toString('hex')}.tmp`);
          tempFd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          owned = fs.fstatSync(tempFd); privateFile(owned, true);
          fs.writeFileSync(tempFd, bytes); fs.fsyncSync(tempFd);
          const checkTemp = () => {
            const current = fs.fstatSync(tempFd!); same(owned!, current); privateFile(current, true);
            const named = fs.lstatSync(temp!); same(current, named); privateFile(named, true);
          };
          checkTemp(); checkParent();
          if (!active()) fail();
          linkAttempted = true; fs.linkSync(temp, config.captureFile); published = true;
          const final = fs.lstatSync(config.captureFile); same(owned, final); privateFile(final, true, 2);
          same(owned, fs.lstatSync(temp));
          fs.unlinkSync(temp); temp = undefined;
          fs.fsyncSync(ownedFd); checkParent();
          const durable = fs.lstatSync(config.captureFile); same(owned, durable); privateFile(durable, true);
        } catch {
          // A failed link can still have published. Preserve that evidence, including
          // the temp when publication/durability is ambiguous; never unlink the final.
          let unpublished = !published;
          if (linkAttempted && unpublished) {
            try { unpublished = fs.lstatSync(config.captureFile, { throwIfNoEntry: false }) === undefined; }
            catch { unpublished = false; }
          }
          if (unpublished && temp && owned) {
            try {
              checkParent(); const named = fs.lstatSync(temp); same(owned, named); privateFile(named, true);
              fs.unlinkSync(temp);
            } catch { /* No proven ownership: leave evidence for operator inspection. */ }
          }
          fail();
        } finally { if (tempFd !== undefined) closeFile(tempFd); }
      },
      close() { if (!closed) { closed = true; closeFile(ownedFd); } },
    };
  } catch {
    if (directoryFd !== undefined) { try { fs.closeSync(directoryFd); } catch { /* Preserve a fixed safe failure. */ } }
    return fail();
  }
}

function fail(): never { throw new Error('Setup capture failed'); }
function closeFile(fd: number): void { try { fs.closeSync(fd); } catch { fail(); } }
function same(expected: Stats, actual: Stats): void { if (expected.dev !== actual.dev || expected.ino !== actual.ino) fail(); }
function privateFile(stamp: Stats, writable: boolean, links = 1): void {
  const mode = stamp.mode & 0o7777;
  if (!stamp.isFile() || stamp.uid !== process.getuid?.() || stamp.nlink !== links ||
      (writable ? mode !== 0o600 : (mode & ~0o600) !== 0 || (mode & 0o400) === 0)) fail();
}
function absent(path: string): void { if (fs.lstatSync(path, { throwIfNoEntry: false }) !== undefined) fail(); }
function trustedParent(path: string): Stats {
  const uid = process.getuid?.(); if (uid === undefined) fail();
  const root = parse(path).root; let current = root; let result = fs.lstatSync(root);
  for (const part of ['', ...path.slice(root.length).split('/').filter(Boolean)]) {
    if (part) current = join(current, part);
    result = fs.lstatSync(current);
    const mode = result.mode & 0o7777;
    if (!result.isDirectory() || (result.uid !== 0 && result.uid !== uid) ||
        ((mode & 0o022) !== 0 && !(result.uid === 0 && (mode & 0o1000) !== 0))) fail();
  }
  if (result.uid !== uid || (result.mode & 0o7777) !== 0o700) fail();
  return result;
}
function encode(candidate: SetupCandidate): Buffer {
  const { appId, tenantId, recipientId, serviceUrl, senderId, conversationId } = candidate;
  const selected = { appId, tenantId, recipientId, serviceUrl, senderId, conversationId };
  if (Object.values(selected).some((value) => typeof value !== 'string' || !value || /\p{Cc}|[\uD800-\uDFFF]/u.test(value))) fail();
  const bytes = Buffer.from(JSON.stringify(selected) + '\n'); if (bytes.length > 4096) fail();
  return bytes;
}
