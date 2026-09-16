import type { ServerResponse } from 'node:http';
import { TableClient } from '@azure/data-tables';
import type { TestContext } from 'node:test';
import type { PipelineRequest } from '@azure/core-rest-pipeline';
import { boundBytes, hash, partition, stamp } from './table-service.js';

export const code = (want: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === want &&
  e.message === `Table storage: ${want}` && !('cause' in e) && !('request' in e) && !('response' in e);
export function genericMissing(res: ServerResponse) {
  res.writeHead(404, { 'content-type': 'application/json', 'x-ms-error-code': 'ResourceNotFound' });
  res.end(JSON.stringify({ 'odata.error': { code: 'ResourceNotFound', message: { lang: 'en-US', value: 'synthetic missing entity' } } }));
}
export function wireData() {
  return stamp({ PartitionKey: partition, RowKey: 'delivery_aXRlbQ', V: 1, T: 'delivery', Id: 'item', Length: 3, Count: 1,
    B0: 'YWJj', 'B0@odata.type': 'Edm.Binary', Digest: hash(['orka-data-v1', boundBytes.toString('base64'), 'delivery', 'item', 'YWJj']) }, 41);
}
/** Inject malformed serialized query requests via the public SDK pipeline, not
 * production hooks or a replacement HTTP client. The native fence must deny them. */
export function alterPointQuery(t: TestContext, change: (request: PipelineRequest) => void) {
  const list = TableClient.prototype.listEntities;
  t.mock.method(TableClient.prototype, 'listEntities', function (this: TableClient, ...args: Parameters<typeof list>) {
    this.pipeline.addPolicy({ name: 'pointQueryFixture', async sendRequest(request, next) { change(request); return next(request); } }, { phase: 'Serialize' });
    return list.apply(this, args);
  });
}
/** Wrap only the public iterator lifecycle; requests, serialization and decoding
 * still execute the real SDK and native HTTPS client. */
export function observePointIterator(t: TestContext, cleanup: () => Promise<void> = async () => {}) {
  const stats = { next: 0, returns: 0, closed: 0 };
  const list = TableClient.prototype.listEntities;
  t.mock.method(TableClient.prototype, 'listEntities', function (this: TableClient, ...args: Parameters<typeof list>) {
    const entities = list.apply(this, args); const byPage = entities.byPage.bind(entities);
    entities.byPage = options => {
      const iterator = byPage(options); const next = iterator.next.bind(iterator); const done = iterator.return?.bind(iterator);
      iterator.next = async (...values) => { stats.next++; return next(...values); };
      iterator.return = async value => { stats.returns++; const result = await done!(value); stats.closed++; await cleanup(); return result; };
      return iterator;
    };
    return entities;
  });
  return stats;
}
