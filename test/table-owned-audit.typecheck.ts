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

void [v1, v2, explicit1, explicit2, asyncRecord1, asyncEndPass1, asyncFinalize1, asyncRecord2, asyncEndPass2, asyncFinalize2,
  valueRecord1, valueEndPass1, valueFinalize1, valueRecord2, valueEndPass2, valueFinalize2];
