import { createHash } from 'node:crypto';
import type { PageCursor } from './client.js';
import { TableError } from './types.js';

const BUCKET_BYTES = 33; // One explicit occupancy byte, then all 32 digest bytes (including zero).
const CURSOR_BYTES = 2 * (8192 + 2048 + 2048); // Retained/accepted token limit is unchanged.
// The pinned public SDK encodes JSON {nextPartitionKey,nextRowKey} BEFORE its
// token reaches our 8192-character check. Printable quotes/backslashes double;
// two maximal components plus 39 syntax bytes produce 10976 base64 characters.
const INCOMING_TOKEN_CHARS = 4 * Math.ceil((2 * (2048 + 2048) + 39) / 3);
const INCOMING_CURSOR_BYTES = 2 * (INCOMING_TOKEN_CHARS + 2048 + 2048);
const HASH_INPUT_BYTES = 3 * 8192; // Worst UTF-8 bytes per UTF-16 code unit, including replacement of lone surrogates.
const ROW_BYTES = 2 * (8 + 1 + 342); // Longest typed key: delivery_<base64url of <=256 UTF-8 identity bytes>.
// Reserve old request + new SDK cursor BEFORE receiving a page; fixed scratch and
// old/new row overlap are retained for the whole audit. This is a representation
// ledger, not guessed V8 object sizes, measured heap/RSS, or immediate-GC credit.
const FIXED_BYTES = CURSOR_BYTES + INCOMING_CURSOR_BYTES + HASH_INPUT_BYTES + 32 + 2 * 64 + 2 * ROW_BYTES;

/** Internal fixed-width SHA256 set. No per-entry JS collection or pooled slabs. */
export class CursorHashes {
  private buckets: Buffer;
  private count = 0;
  constructor(private readonly maxBytes: number, private readonly check: () => void) {
    check(); if (maxBytes < 2 * BUCKET_BYTES) throw new TableError('incomplete');
    this.buckets = Buffer.alloc(2 * BUCKET_BYTES);
  }
  private slot(buckets: Buffer, digest: Buffer, start = 0): number {
    const capacity = buckets.length / BUCKET_BYTES;
    let index = digest.readUInt32LE(start) & (capacity - 1);
    for (;;) {
      this.check(); const offset = index * BUCKET_BYTES;
      if (buckets[offset] === 0) return offset;
      let same = true;
      for (let i = 0; i < 32; i++) if (buckets[offset + 1 + i] !== digest[start + i]) { same = false; break; }
      if (same) return offset; index = (index + 1) & (capacity - 1);
    }
  }
  add(digest: Buffer): boolean {
    let offset = this.slot(this.buckets, digest);
    if (this.buckets[offset] === 1) return false;
    if (this.count >= this.buckets.length / BUCKET_BYTES / 2) {
      // Reserve BOTH capacities before allocating. No release while old is still
      // referenced, including during eligibility checks and rehash probes.
      let old: Buffer | undefined = this.buckets;
      const nextBytes = old.length * 2;
      if (nextBytes > this.maxBytes - old.length) throw new TableError('incomplete');
      this.check(); const next = Buffer.alloc(nextBytes);
      for (let i = 0; i < old.length; i += BUCKET_BYTES) {
        this.check(); if (old[i] === 0) continue;
        const slot = this.slot(next, old, i + 1); next[slot] = 1; old.copy(next, slot + 1, i + 1, i + BUCKET_BYTES);
      }
      this.buckets = next; old = undefined;
      // Only the new capacity remains reserved; the next growth uses its length.
      offset = this.slot(this.buckets, digest);
    }
    this.buckets[offset] = 1; digest.copy(this.buckets, offset + 1, 0, 32); this.count++; return true;
  }
  clear(): void { this.check(); this.buckets.fill(0); this.count = 0; this.check(); }
}

export class AuditTracking {
  private readonly hashes: CursorHashes;
  private readonly input: Buffer;
  private readonly digest: Buffer;
  private previous: Buffer;
  private incoming: Buffer;
  private previousLength = 0;
  constructor(maxBytes: number, private readonly check: () => void) {
    check(); if (maxBytes < FIXED_BYTES) throw new TableError('incomplete');
    this.hashes = new CursorHashes(maxBytes - FIXED_BYTES, check);
    this.input = Buffer.alloc(HASH_INPUT_BYTES); this.digest = Buffer.alloc(32);
    this.previous = Buffer.alloc(ROW_BYTES); this.incoming = Buffer.alloc(ROW_BYTES);
  }
  cursor(cursor: PageCursor): boolean {
    this.check();
    const length = this.input.write(cursor.token, 'utf8');
    // One short-lived native SHA256 context, not one retained context per cursor.
    // Hex output (64 UTF-16 code units) is charged alongside the 32-byte digest.
    const hex = createHash('sha256').update(this.input.subarray(0, length)).digest('hex');
    this.digest.write(hex, 'hex'); return this.hashes.add(this.digest);
  }
  row(row: string): void {
    this.check(); const length = this.incoming.write(row, 'utf16le');
    // Typed row keys are ASCII, so their UTF16LE byte ordering is identical.
    if (this.previousLength && this.previous.compare(this.incoming, 0, length, 0, this.previousLength) >= 0) throw new TableError('incomplete');
    const old = this.previous; this.previous = this.incoming; this.incoming = old; this.previousLength = length;
  }
  clear(): void { this.hashes.clear(); this.previousLength = 0; }
}
