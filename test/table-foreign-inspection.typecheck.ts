import { createTableForeignInspectorV2 } from '../src/storage/table/index.js';
import type { ForeignOwnerFenceV2, ForeignInspectionBudget, ForeignInspectionOptions, ForeignInspectionVisitorV2,
  OwnedAuditBudget, OwnedAuditOptions, OwnedAuditVisitor, OwnedAuditVisitorV2, TableBinding, TableDependencies } from '../src/storage/table/index.js';

const visitor: ForeignInspectionVisitorV2 = { passes: 2, record() {}, endPass() {}, finalize() {} };
// @ts-expect-error Async record is not synchronous undefined.
const asyncRecord: ForeignInspectionVisitorV2 = { ...visitor, async record() {} };
// @ts-expect-error Async endPass is not synchronous undefined.
const asyncEnd: ForeignInspectionVisitorV2 = { ...visitor, async endPass() {} };
// @ts-expect-error Async finalize is not synchronous undefined.
const asyncFinal: ForeignInspectionVisitorV2 = { ...visitor, async finalize() {} };
// @ts-expect-error Values cannot be silently discarded.
const valueRecord: ForeignInspectionVisitorV2 = { ...visitor, record() { return 1; } };
// @ts-expect-error Values cannot be silently discarded.
const valueEnd: ForeignInspectionVisitorV2 = { ...visitor, endPass() { return 1; } };
// @ts-expect-error Values cannot be silently discarded.
const valueFinal: ForeignInspectionVisitorV2 = { ...visitor, finalize() { return 1; } };
function receiver(this: { passes: 1 | 2 }): undefined {}
// @ts-expect-error No visitor receiver is supplied.
const receiverRecord: ForeignInspectionVisitorV2 = { ...visitor, record: receiver };
// @ts-expect-error No visitor receiver is supplied.
const receiverEnd: ForeignInspectionVisitorV2 = { ...visitor, endPass: receiver };
// @ts-expect-error No visitor receiver is supplied.
const receiverFinal: ForeignInspectionVisitorV2 = { ...visitor, finalize: receiver };
// @ts-expect-error Contextual receiver is void.
const contextual: ForeignInspectionVisitorV2 = { ...visitor, record() { return void this.passes; } };
function contracts(binding: TableBinding, dependencies: TableDependencies, expected: Readonly<ForeignOwnerFenceV2>,
  budget: OwnedAuditBudget, options: OwnedAuditOptions, v2: OwnedAuditVisitorV2, v1: OwnedAuditVisitor) {
  const b: ForeignInspectionBudget = budget; const o: ForeignInspectionOptions = options;
  const i = createTableForeignInspectorV2(binding, dependencies, expected);
  const result: Promise<void> = i.inspect(v2, b, o);
  const status: Readonly<{ lifecycle: 'new' | 'inspecting' | 'completed' | 'failed' | 'closing' | 'closed'; ownership: 'none'; pending: 0 | 1 }> = i.status();
  const close: Promise<void> = i.close();
  // @ts-expect-error Metadata V1 cannot enter the V2 inspector.
  i.inspect(v1, b);
  // @ts-expect-error No ownership acquisition.
  i.acquire();
  // @ts-expect-error No client capability.
  i.client;
  // @ts-expect-error No write capability.
  i.mutate();
  // @ts-expect-error No normal owner kernel.
  i.kernel;
  // @ts-expect-error Status is immutable.
  status.ownership = 'none';
  void [result, close, status];
}
void [contracts, asyncRecord, asyncEnd, asyncFinal, valueRecord, valueEnd, valueFinal,
  receiverRecord, receiverEnd, receiverFinal, contextual];
