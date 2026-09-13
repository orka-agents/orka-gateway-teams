/** Library-only storage kernel. Not an ingress/delivery journal or a selectable runtime backend. */
export { createTableKernel } from './owner.js';
export { DEFAULT_LIMITS, TableError } from './types.js';
export type { CallOptions, DataAction, DataKey, DataRecord, DataType, Metadata, MutationInput, MutationResult,
  Plan, Planner, PlannerView, StoredRecord, TableBinding, TableDependencies, TableErrorCode, TableLimits } from './types.js';
export type TableKernel = ReturnType<typeof import('./owner.js').createTableKernel>;
