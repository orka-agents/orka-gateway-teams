import { auditConfig, auditFields, containCallbackPromise, signalAborted, subscribeAuditAbort } from './audit.js';
import type { AuditConfig } from './audit.js';
import { runAuditTraversal } from './audit-traversal.js';
import { OwnedTableClient } from './client.js';
import type { WorkContext } from './client.js';
import type { AnyStoredRecord } from './format.js';
import { bindTable, etag, fail, hex, initializationDigestV2, integer, uuid } from './codec.js';
import { OWNED_AUDIT_BUDGET_EXHAUSTED, TableError } from './types.js';
import type { BoundTable, ForeignOwnerFenceV2, ForeignInspectionBudget, ForeignInspectionOptions, ForeignInspectionVisitorV2,
  TableBinding, TableDependencies } from './types.js';

type Lifecycle = 'new' | 'inspecting' | 'completed' | 'failed' | 'closing' | 'closed';

function snapshot(binding: TableBinding, expected: Readonly<ForeignOwnerFenceV2>): { binding: BoundTable; expected: ForeignOwnerFenceV2 } {
  const b = auditFields(binding, ['account', 'table', 'storeId', 'kind', 'scope']);
  b.scope = auditFields(b.scope, b.kind === 'ingress' ? ['appId', 'tenantId', 'orkaBaseUrl', 'gatewayNamespace', 'gatewayName'] : ['appId', 'tenantId']);
  const bound = bindTable(b as TableBinding);
  const f = auditFields(expected, ['initId', 'initDigest', 'owner', 'epoch', 'mDigest', 'etag']);
  const fence = { initId: uuid(f.initId), initDigest: hex(f.initDigest), owner: uuid(f.owner),
    epoch: integer(f.epoch, 1, Number.MAX_SAFE_INTEGER), mDigest: hex(f.mDigest), etag: etag(f.etag) };
  if (fence.initDigest !== initializationDigestV2(bound, fence.initId)) fail();
  return { binding: bound, expected: fence };
}

/** Retained, one-shot V2 envelope observation. No ownership or Table mutation capability. */
export function createTableForeignInspectorV2(binding: TableBinding, dependencies: TableDependencies, expected: Readonly<ForeignOwnerFenceV2>) {
  let captured: ReturnType<typeof snapshot>; let client: Pick<OwnedTableClient<2>, 'read' | 'page' | 'close'>;
  try {
    // Canonical identity and exact fence are private before ANY dependency reflection.
    captured = snapshot(binding, expected); client = new OwnedTableClient(captured.binding, dependencies, 2);
  } catch { throw new TableError('invalid-input'); }
  const fence = captured.expected;
  let lifecycle: Lifecycle = 'new'; let pending: 0 | 1 = 0; let consumed = false; let callback = false;
  let controller: AbortController | undefined; let deadline = 0; let failure: TableError | undefined;
  let operation: Promise<void> | undefined; let closing: Promise<void> | undefined;

  const latch = (code: 'incomplete' | 'unavailable' | 'unresolved') => {
    if (code === 'unresolved' || !failure) failure = new TableError(code);
    if (!closing && lifecycle !== 'closed') lifecycle = 'failed';
    controller?.abort();
  };
  const contradiction = (): never => { latch('unresolved'); throw new TableError('unresolved'); };
  const guardCallback = () => { if (callback) contradiction(); };
  const check = () => {
    if (closing || controller!.signal.aborted || performance.now() >= deadline) latch('incomplete');
    if (failure) throw failure;
  };
  const request = (config: AuditConfig): WorkContext => {
    check(); return { signal: controller!.signal, deadline: Math.min(deadline, performance.now() + config.requestTimeoutMs) };
  };
  const matches = (record: AnyStoredRecord | undefined): boolean => !!record && record.row === 'M' && record.value.kind === 'metadata' &&
    record.value.initId === fence.initId && record.value.initDigest === fence.initDigest && record.value.owner === fence.owner &&
    record.value.epoch === fence.epoch && record.value.digest === fence.mDigest && record.etag === fence.etag;
  const call = (fn: (this: void, ...args: never[]) => undefined, ...args: unknown[]) => {
    check(); let result: unknown; callback = true;
    try {
      try { result = Reflect.apply(fn, undefined, args); }
      catch (error) {
        if (error === OWNED_AUDIT_BUDGET_EXHAUSTED) { latch('incomplete'); throw new TableError('incomplete'); }
        try { containCallbackPromise(error); } finally { contradiction(); }
      }
      if (result !== undefined) { try { containCallbackPromise(result); } finally { contradiction(); } }
    } finally { callback = false; }
    check();
  };
  return {
    inspect(visitor: ForeignInspectionVisitorV2, budget: ForeignInspectionBudget, options?: ForeignInspectionOptions): Promise<void> {
      guardCallback();
      if (closing) return Promise.reject(new TableError('closed'));
      let config: AuditConfig;
      try { config = auditConfig<2>(visitor, budget, options); } catch { return Promise.reject(new TableError('invalid-input')); }
      // Descriptor reflection can synchronously close the handle before admission.
      if (closing) return Promise.reject(new TableError('closed'));
      if (consumed) return Promise.reject(new TableError('not-submitted'));
      consumed = true; pending = 1; lifecycle = 'inspecting'; controller = new AbortController(); deadline = performance.now() + config.maxDurationMs;
      const timer = setTimeout(() => latch('incomplete'), config.maxDurationMs);
      const removeAbort = config.signal ? subscribeAuditAbort(config.signal, () => latch('incomplete')) : () => {};
      if (config.signal && signalAborted(config.signal)) latch('incomplete');
      operation = Promise.resolve().then(async () => {
        try {
          await runAuditTraversal(config, {
            check,
            authority: async () => {
              const current = await client.read('M', request(config));
              if (!matches(current)) contradiction(); check();
            },
            page: (cursor, allowance) => client.page(request(config), cursor, allowance),
            matches, contradiction, exhaust: () => latch('incomplete'),
            record: (pass, record) => call(config.record, pass, record), endPass: pass => call(config.endPass, pass),
          });
          call(config.finalize); check();
        } catch (error) {
          if (error instanceof TableError && (error.code === 'corrupt' || error.code === 'unresolved')) latch('unresolved');
          else {
            try { check(); } catch { /* Preserve the safe cancellation latch, not raw transport detail. */ }
            if (!failure) latch(error instanceof TableError && error.code === 'incomplete' ? 'incomplete' : 'unavailable');
          }
        }
      }).then(() => {
        // Only actual traversal/token/native/iterator completion drops the reservation.
        // Recheck here too: finalizer microtasks may have cancelled or closed this handle.
        try { check(); } catch { /* Failure is already latched. */ }
        clearTimeout(timer); removeAbort(); pending = 0;
        if (!closing) lifecycle = failure ? 'failed' : 'completed';
        if (failure) throw failure;
      });
      return operation;
    },
    status() { return Object.freeze({ lifecycle, ownership: 'none' as const, pending }); },
    close(): Promise<void> {
      guardCallback();
      if (closing) return closing;
      lifecycle = 'closing';
      closing = Promise.resolve(operation).catch(() => {}).then(async () => {
        // This is transport drain only; never normal-owner close/release.
        try { await client.close(); } catch { throw new TableError('unavailable'); }
        finally { lifecycle = 'closed'; }
      });
      if (pending) latch('incomplete');
      return closing;
    },
  };
}
