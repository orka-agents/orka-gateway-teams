import type { DirectoryKey, DirectoryRecord, DirectoryRow, DirectoryTable } from '../../src/directory/types.js';

/** Independent conditional rows for deterministic lost/lying-ACK state-machine tests. */
export function memoryDirectoryTable() {
  const rows = new Map<string, DirectoryRow>(); let revision = 0;
  let writeMode: 'normal' | 'lost' | 'lie' = 'normal'; let writes = 0; let listFailure = false;
  const keyOf = (key: DirectoryKey) => JSON.stringify(key);
  const clone = <T>(value: T): T => structuredClone(value);
  const save = (key: DirectoryKey, value: DirectoryRecord) => {
    rows.set(keyOf(key), { key: clone(key), value: clone(value), row: keyOf(key), etag: `"${++revision}"`, timestamp: '2026-01-01T00:00:00Z' });
  };
  const table: DirectoryTable = {
    async get(key) { const row = rows.get(keyOf(key)); return row && clone(row); },
    async insert(key, value) { writes++; if (rows.has(keyOf(key))) return { kind: 'conflict' };
      if (writeMode !== 'lie') save(key, value); return { kind: writeMode === 'lost' ? 'uncertain' : 'ack' }; },
    async replace(key, etag, value) { writes++; if (rows.get(keyOf(key))?.etag !== etag) return { kind: 'conflict' };
      if (writeMode !== 'lie') save(key, value); return { kind: writeMode === 'lost' ? 'uncertain' : 'ack' }; },
    async list(_ctx, armedOnly, visit) { if (listFailure) throw new Error('incomplete page');
      const found = clone([...rows.values()].filter(r => !armedOnly || (r.value.kind === 'control' && r.value.state === 'armed')));
      if (visit) { for (const row of found) await visit(row); return []; } return found; },
    async close() {},
  };
  return { table, rows, save, mode(value: typeof writeMode) { writeMode = value; }, failList() { listFailure = true; }, writes: () => writes };
}
