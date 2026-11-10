/** Library-only storage kernel. Not an ingress/delivery journal or a selectable runtime backend. */
export { createTableKernel, createTableKernelV2, createTableKernelV3 } from './owner.js';
export { createTableForeignInspectorV2 } from './inspection.js';
export { DEFAULT_LIMITS, OWNED_AUDIT_BUDGET_EXHAUSTED, TableError } from './types.js';
export type { CallOptions, DataAction, DataKey, DataRecord, DataType, Metadata, MutationInput, MutationResult,
  Plan, Planner, PlannerView, StoredRecord, TableBinding, TableDependencies, TableErrorCode, TableLimits,
  CleanReleaseExit, OperatorRecoveryExit, ExitReceipt, MetadataV2, RecordValueV2, StoredRecordV2, PlannerViewV2, PlannerV2,
  OwnedAuditBudget, OwnedAuditOptions, OwnedAuditVisitor, OwnedAuditVisitorV2, OwnedAuditVisitorV3,
  MetadataV3, StoredRecordV3, PlannerViewV3, LeaseValue, LeaseClock, LeaseAuthority, TableLeaseDependencies,
  ForeignOwnerFenceV2, ForeignInspectionBudget, ForeignInspectionOptions, ForeignInspectionVisitorV2 } from './types.js';
export type TableKernel = ReturnType<typeof import('./owner.js').createTableKernel>;
export type TableKernelV2 = ReturnType<typeof import('./owner.js').createTableKernelV2>;
export type TableKernelV3 = ReturnType<typeof import('./owner.js').createTableKernelV3>;
