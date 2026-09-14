import { chargeAuditWork } from './audit.js';
import type { AuditConfig } from './audit.js';
import { AuditTracking } from './audit-tracking.js';
import type { AuditPageAllowance, PageCursor, RawPage } from './client.js';
import type { AnyStoredRecord, MetadataFormat } from './format.js';
import { MAX_RESPONSE_BYTES, TableError } from './types.js';

export function snapshotRecord(record: AnyStoredRecord | undefined): AnyStoredRecord | undefined {
  if (!record) return undefined;
  const value = record.value;
  if (value.kind === 'data') return { ...record, value: { ...value, payload: Buffer.from(value.payload) } };
  const buffers = { state: Buffer.from(value.state), result: Buffer.from(value.result) };
  return 'release' in value ? { ...record, value: { ...value, ...buffers, release: Buffer.from(value.release) } } :
    { ...record, value: { ...value, ...buffers, exit: value.exit ? { ...value.exit } : undefined } };
}

/** Mechanics only: callers retain admission, authority policy, callback guards and publication. */
interface TraversalHooks {
  check(): void;
  authority(): Promise<void>;
  page(cursor: PageCursor | undefined, allowance: AuditPageAllowance): Promise<RawPage<MetadataFormat>>;
  matches(record: AnyStoredRecord): boolean;
  contradiction(): never;
  exhaust(): void;
  record(pass: 1 | 2, record: AnyStoredRecord): void;
  endPass(pass: 1 | 2): void;
}
export async function runAuditTraversal(config: AuditConfig, hooks: TraversalHooks): Promise<void> {
  const tracking = new AuditTracking(config.maxTrackingBytes, hooks.check);
  let pages = 0; let size = 0;
  for (const pass of config.passes === 1 ? [1] as const : [1, 2] as const) {
    tracking.clear(); await hooks.authority(); let cursor: PageCursor | undefined; let control = false;
    for (;;) {
      hooks.check();
      if (config.maxPageBytes - size < 1) throw new TableError('incomplete');
      pages = chargeAuditWork(pages, 1, config.maxPages);
      const page = await hooks.page(cursor, { maxBytes: Math.min(MAX_RESPONSE_BYTES, config.maxPageBytes - size), exhaust: hooks.exhaust });
      const record = page.records[0];
      // Observed M contradictions precede an already-latched benign cancellation.
      if (record?.row === 'M') { if (control || !hooks.matches(record)) hooks.contradiction(); control = true; }
      if (!page.cursor && !control) hooks.contradiction();
      hooks.check(); size = chargeAuditWork(size, page.size, config.maxPageBytes);
      if (record) { tracking.row(record.row); hooks.record(pass, snapshotRecord(record)!); }
      if (!page.cursor) break;
      if (!tracking.cursor(page.cursor)) throw new TableError('incomplete'); cursor = page.cursor;
    }
    hooks.endPass(pass); await hooks.authority();
  }
}
