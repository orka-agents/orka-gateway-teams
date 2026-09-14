import type { OwnedAuditVisitor, OwnedAuditVisitorV2 } from '../src/storage/table/index.js';

// Compile-only: contextual no-return inference and explicit undefined are valid.
const v1: OwnedAuditVisitor = { passes: 1, record() {}, endPass() {}, finalize() {} };
const v2: OwnedAuditVisitorV2 = { passes: 2, record() {}, endPass() {}, finalize() {} };
const explicit1: OwnedAuditVisitor = { passes: 1, record() { return undefined; }, endPass() { return undefined; }, finalize() { return undefined; } };
const explicit2: OwnedAuditVisitorV2 = { passes: 2, record() { return undefined; }, endPass() { return undefined; }, finalize() { return undefined; } };

// Each callback must reject async implementations, not silently discard a Promise.
// @ts-expect-error V1 record must return exactly undefined, not Promise<void>.
const asyncRecord1: OwnedAuditVisitor = { ...v1, async record() {} };
// @ts-expect-error V1 endPass must return exactly undefined, not Promise<void>.
const asyncEndPass1: OwnedAuditVisitor = { ...v1, async endPass() {} };
// @ts-expect-error V1 finalize must return exactly undefined, not Promise<void>.
const asyncFinalize1: OwnedAuditVisitor = { ...v1, async finalize() {} };
// @ts-expect-error V2 record must return exactly undefined, not Promise<void>.
const asyncRecord2: OwnedAuditVisitorV2 = { ...v2, async record() {} };
// @ts-expect-error V2 endPass must return exactly undefined, not Promise<void>.
const asyncEndPass2: OwnedAuditVisitorV2 = { ...v2, async endPass() {} };
// @ts-expect-error V2 finalize must return exactly undefined, not Promise<void>.
const asyncFinalize2: OwnedAuditVisitorV2 = { ...v2, async finalize() {} };

// @ts-expect-error V1 record must not silently discard a value.
const valueRecord1: OwnedAuditVisitor = { ...v1, record() { return 1; } };
// @ts-expect-error V1 endPass must not silently discard a value.
const valueEndPass1: OwnedAuditVisitor = { ...v1, endPass() { return 1; } };
// @ts-expect-error V1 finalize must not silently discard a value.
const valueFinalize1: OwnedAuditVisitor = { ...v1, finalize() { return 1; } };
// @ts-expect-error V2 record must not silently discard a value.
const valueRecord2: OwnedAuditVisitorV2 = { ...v2, record() { return 1; } };
// @ts-expect-error V2 endPass must not silently discard a value.
const valueEndPass2: OwnedAuditVisitorV2 = { ...v2, endPass() { return 1; } };
// @ts-expect-error V2 finalize must not silently discard a value.
const valueFinalize2: OwnedAuditVisitorV2 = { ...v2, finalize() { return 1; } };

// Contextual methods cannot assume the snapshotted callback retains its visitor receiver.
// @ts-expect-error V1 record has no visitor receiver.
const thisRecord1: OwnedAuditVisitor = { ...v1, record() { return void this.passes; } };
// @ts-expect-error V1 endPass has no visitor receiver.
const thisEndPass1: OwnedAuditVisitor = { ...v1, endPass() { return void this.passes; } };
// @ts-expect-error V1 finalize has no visitor receiver.
const thisFinalize1: OwnedAuditVisitor = { ...v1, finalize() { return void this.passes; } };
// @ts-expect-error V2 record has no visitor receiver.
const thisRecord2: OwnedAuditVisitorV2 = { ...v2, record() { return void this.passes; } };
// @ts-expect-error V2 endPass has no visitor receiver.
const thisEndPass2: OwnedAuditVisitorV2 = { ...v2, endPass() { return void this.passes; } };
// @ts-expect-error V2 finalize has no visitor receiver.
const thisFinalize2: OwnedAuditVisitorV2 = { ...v2, finalize() { return void this.passes; } };

function requiresReceiver(this: { passes: 1 | 2 }): undefined {}
// @ts-expect-error V1 record cannot require a receiver supplied by the kernel.
const receiverRecord1: OwnedAuditVisitor = { ...v1, record: requiresReceiver };
// @ts-expect-error V1 endPass cannot require a receiver supplied by the kernel.
const receiverEndPass1: OwnedAuditVisitor = { ...v1, endPass: requiresReceiver };
// @ts-expect-error V1 finalize cannot require a receiver supplied by the kernel.
const receiverFinalize1: OwnedAuditVisitor = { ...v1, finalize: requiresReceiver };
// @ts-expect-error V2 record cannot require a receiver supplied by the kernel.
const receiverRecord2: OwnedAuditVisitorV2 = { ...v2, record: requiresReceiver };
// @ts-expect-error V2 endPass cannot require a receiver supplied by the kernel.
const receiverEndPass2: OwnedAuditVisitorV2 = { ...v2, endPass: requiresReceiver };
// @ts-expect-error V2 finalize cannot require a receiver supplied by the kernel.
const receiverFinalize2: OwnedAuditVisitorV2 = { ...v2, finalize: requiresReceiver };

function receiverless(this: void): undefined {}
const noReceiver1: OwnedAuditVisitor = { passes: 1, record: receiverless, endPass: receiverless, finalize: receiverless };
const noReceiver2: OwnedAuditVisitorV2 = { passes: 2, record: receiverless, endPass: receiverless, finalize: receiverless };
// Lexically captured state remains valid: the runtime does not rebind arrow functions.
class LexicalCollector {
  count = 0;
  visitor1: OwnedAuditVisitor = { ...v1, record: () => { this.count++; } };
  visitor2: OwnedAuditVisitorV2 = { ...v2, record: () => { this.count++; } };
}

void [v1, v2, explicit1, explicit2, asyncRecord1, asyncEndPass1, asyncFinalize1, asyncRecord2, asyncEndPass2, asyncFinalize2,
  valueRecord1, valueEndPass1, valueFinalize1, valueRecord2, valueEndPass2, valueFinalize2,
  thisRecord1, thisEndPass1, thisFinalize1, thisRecord2, thisEndPass2, thisFinalize2,
  receiverRecord1, receiverEndPass1, receiverFinalize1, receiverRecord2, receiverEndPass2, receiverFinalize2,
  noReceiver1, noReceiver2, LexicalCollector];
