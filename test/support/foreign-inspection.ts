import assert from 'node:assert/strict';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { TestContext } from 'node:test';
import { createTableForeignInspectorV2, createTableKernelV2 } from '../../src/storage/table/index.js';
import type { ForeignOwnerFenceV2 } from '../../src/storage/table/index.js';
import { ingressBinding, tableBinding, tableService } from './table-service.js';

/** A real owner installs M; only the separate inspector channel is counted below. */
export async function foreign(t: TestContext, kind: 'delivery' | 'ingress' = 'delivery') {
  const binding = structuredClone(kind === 'delivery' ? tableBinding : ingressBinding);
  const s = await tableService(t, kind, 2); const owner = createTableKernelV2(binding, s.dependencies);
  await owner.initialize(); await owner.acquire();
  const record = await owner.read('M');
  if (!record || record.value.kind !== 'metadata') throw new Error('Fixture metadata missing');
  const m = record.value;
  const expected: ForeignOwnerFenceV2 = { initId: m.initId, initDigest: m.initDigest, owner: m.owner, epoch: m.epoch, mDigest: m.digest, etag: record.etag };
  const stats = { gets: 0, nonGets: 0, tokens: 0 }; const before = s.stats.writes;
  const dependencies = { token: async (...args: Parameters<typeof s.dependencies.token>) => { stats.tokens++; return s.dependencies.token(...args); },
    request: ((url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
      if (options.method === 'GET') stats.gets++; else stats.nonGets++;
      return s.dependencies.request!(url, options, callback);
    }) as typeof https.request };
  t.after(() => { assert.equal(stats.nonGets, 0); });
  const create = () => createTableForeignInspectorV2(binding, dependencies, expected);
  const unchanged = () => { assert.equal(s.stats.writes, before); assert.equal(stats.nonGets, 0); };
  return { s, owner, binding, expected, dependencies, stats, before, create, unchanged };
}
