# Azure Table storage — library only

`src/storage/table/index.ts` exposes a bounded protocol/codec/ownership kernel.
`src/delivery/table-journal.ts` implements explicit V1 and V2 delivery journals on that kernel.
`src/ingress/table-store.ts` implements the [V2 inbox](table-inbox.md), with a
body-free two-pass domain audit and durable handoff arm. None is **a selectable
runtime backend**. SQLite remains the only shipped runtime backend. There is no Table CLI,
configuration selector, identity provider, Azure provisioning, recovery command,
lease, takeover, migration, deletion, pruning or hosting integration here.

## Library contract

`createTableKernel(binding, dependencies, limits?)` constructs a handle
**synchronously, without I/O**. Keep that handle even if a later operation rejects.
An ambiguous acquisition must not disappear behind a rejected asynchronous opener.
`createTableKernelV2(binding, dependencies, limits?)` provides the same operations
with explicitly pinned metadata format 2. The original factory remains V1; neither
factory detects, upgrades or falls back to the other's metadata format. Format is
not a binding or limits option, and both use the same partition identity.

The binding is one of:

- `{account, table, storeId, kind: 'ingress', scope: {appId, tenantId,
  orkaBaseUrl, gatewayNamespace, gatewayName}}`
- `{account, table, storeId, kind: 'delivery', scope: {appId, tenantId}}`

Account/table resource casing is canonicalized to lowercase; logical IDs and all
scope bytes remain unchanged and pass the existing pure scope validators. The
partition is `v1_<kind>_<base64url(UTF8(storeId))>`, **not derived from current scope**.
Changing scope does not silently select fresh storage. Scope and resource identity
are also covered by each envelope's digest. A table must already exist.

The trusted dependency `token(scope, {signal, deadline})` receives exactly
`https://storage.azure.com/.default`; `deadline` uses `performance.now()`'s monotonic
clock. It returns a bounded bearer token string. There is no bot-token reuse,
default credentials, token cache/cycler, challenge refresh or fallback. Providing
and authorizing a real per-purpose storage identity is later integration work.
The optional native HTTPS `request` dependency is a **library-test seam**, not an
environment endpoint override or production TLS bypass.

| Operation | Meaning |
|---|---|
| `status()` | Fixed local lifecycle, ownership certainty and pending count/input bytes; no I/O, tokens, IDs, state or ownership authority granted. |
| `initialize(options?)` | Explicitly scan an empty partition, then create only M with empty domain state/result. Existing M or orphan data is never adopted/reset. |
| `acquire(options?)` | Read M, require owner-empty, increment the checked epoch, conditionally install a fresh private owner UUID, and reconcile. Leaves ownership **unready**. Never initializes. |
| `read(keyOrM, options?)` | Raw validated point read. Owned healthy reads validate M's exact fence; unowned/poisoned reads are diagnostic, not permission to write. |
| `scan(options?)` | Owned, serialized whole-partition generic envelope audit, with exact M before/after checks. Returns the complete bounded snapshot or rejects; never returns a partial audit. |
| `auditOwned(visitor, budget, options?)` | Owned, serialized one/two-pass streaming envelope audit with explicit cumulative budgets and actual-drain completion. No complete record array or domain projection. |
| `mutate({input, keys}, planner, options?)` | Snapshot bounded input/typed keys before queueing. Under serialization, read authoritative M and the requested rows, synchronously plan, copy/validate the plan, submit once, then reconcile. Requires a completed envelope audit. |
| `close()` | Stop intake, remove queued/unissued work, drain actual active work and reconciliation, attempt healthy positively-owned release, and drain local transport even on failure. Idempotent: repeated calls return the same promise/result. |
| `invalidate()` | Irreversible domain-audit failure. Stops future mutations and successful active completion, prevents clean release, but does not bypass actual work/transport drain on close. |

Initialization deliberately has no domain-state argument. Explicit domain initializers
can recognize empty genesis and establish their initial state through an ordinary
owned mutation after the generic envelope audit, before exposing domain readiness.
This does not permit adoption or reset of existing storage.

A typed key is `{type, id}`. Ingress permits `event`, `route`, `control`; delivery
permits `delivery`, `alias`, `control`. IDs are nonempty, well-formed Unicode,
<=256 UTF-8 bytes with no Cc controls or boundary Unicode whitespace. Physical
rows use `<type>_<canonical-base64url(UTF8(id))>`; `M` is reserved. No caller can
supply raw SDK entities, wildcard ETags, a mutation UUID, upsert, merge or delete.

The synchronous trusted planner receives independent `{input, state, records}`
snapshots, including exact per-record ETags. It returns only
`{state: Uint8Array, result: Uint8Array, actions}`. An action is
`{kind: 'create', key, payload}` or `{kind: 'replace', key, payload, etag}`.
Planners must perform **no I/O or asynchronous work**; Promise/thenable outputs are
invalid and never submit. The kernel does not own work a misbehaving planner starts
outside this contract. Caller/planner buffers cannot change an already queued plan.

Mutation outcomes are `{kind: 'committed', result: Buffer}` or
`{kind: 'cancelled'}` (a positively confirmed cancellation barrier). Neither is a
provider-send grant. A caller abort/deadline may reject before internal resolution;
a later commit is reconciled but cannot return a second result or permission.
Domain journals own semantic interpretation, deduplication, references/counters,
recovery and final forwarding/send eligibility. **Envelope-audited is not domain
ready**, and does not establish an application's readiness.

`TableError.code` has fixed values/messages: `invalid-input`, `corrupt`, `missing`,
`exists`, `busy`, `unavailable`, `incomplete`, `unresolved`, `not-submitted`,
`unready`, `closed`. Errors contain no raw SDK/native cause, request, response,
body, token or service error text. Saturation/queued cancellation is transient
`not-submitted`, not corruption. Missing tables are not empty partitions: only a
validated service `EntityNotFound` 404 is point absence; `TableNotFound`, unknown
or contradictory error classifications fail closed.

## Persisted envelopes and service metadata

Version-one M includes immutable binding bytes, initialization UUID/digest, an
explicit owner-empty string or owner UUID, monotonic safe-integer epoch, private
invocation UUID/operation/plan digest, domain state/result bytes, last-release
receipt and an envelope digest. Binding, state, result and receipt use explicit
`Edm.Binary`; epoch uses canonical `Edm.Int64`. The release receipt binds the old
owner, epoch, release invocation and plan. Acquisition, ordinary mutations and
barriers preserve it. Domain payloads live in separate version-one data envelopes
with typed original ID, length, chunk count, digest and contiguous B0..B3 chunks.
Digests cover binding and **all application fields**, excluding service-generated
Timestamp, ETags and informational metadata annotations.

V1 M decoding also enforces kernel lifecycle relationships, not just field types and
digests. Epoch zero is empty genesis or a cancelled-first-acquire barrier; an
initialize operation must retain its exact initialization invocation/plan. Owned
positive epochs permit acquire/mutate/barrier, with no receipt at epoch one and an
immediately preceding, different-owner release receipt thereafter. Owner-empty
positive epochs permit only release/barrier with a same-epoch receipt. Release
invocation/plan must match that receipt; barriers retain prior state and receipt.

### Opt-in V2 metadata foundation

Only M becomes `V=2`. It replaces Binary `Release` with Binary `Exit`, and uses
`orka-init-v2` / `orka-m-v2` initialization/metadata digest domains. Binding, row
keys and all data envelopes remain V1. Mixed Release/Exit fields are rejected.
Existing V1 types, bytes, decoder rules and default factory behavior are unchanged.

V2 exports `MetadataV2`, `StoredRecordV2`, `PlannerViewV2`, `PlannerV2` and the tagged
`ExitReceipt` union. `MetadataV2.exit` is `undefined` before the first exit; otherwise
it is one of these closed shapes (shown in exact wire property order):

- `{kind: 'clean-release', oldOwner, oldEpoch, invocation, planDigest}`
- `{kind: 'operator-recovery', oldOwner, oldEpoch, invocation, originalMDigest,
  planDigest, domainDispositionDigest, operatorAttestationDigest}`

Exit encoding is canonical UTF-8 JSON in canonical Binary, at most 1,024 decoded
bytes. UUIDv4, positive safe epochs, lowercase SHA256 digests, exact property order
and JSON roundtrip are required. No raw attestation or operator identity is stored.

Genesis and first acquisition have no Exit. Later acquisitions require a preceding
same-initialization exit at E−1 with a different owner, and preserve it exactly.
Owned mutations/barriers preserve Exit. Owner-empty release requires a matching
same-epoch clean receipt; a persisted `recover` requires a matching same-epoch
recovery receipt. An unowned positive barrier preserves either exit kind at E.
Normal acquisition still refuses any occupied owner and epoch overflow.

Only a matching **clean** receipt can prove a late normal close after successor
acquisition. A recovery tag cannot satisfy that proof even when its owner, epoch,
invocation and plan fields match. Superseded proof remains unresolved. The same
bounded scan, queue, exact-ETag barriers, invalidation and actual drain apply.

Recovery-shaped metadata is supported for reading/validation and subsequent normal
acquisition only. The normal transport refuses `recover` writes. This is **not an
operator recovery implementation**: no recovery handle, foreign-owner inspection,
recovery writer or runtime selector is provided. The V2 inbox can validate retained
recovery results and their complete graph/data commitments. The explicit V2
delivery factory below validates the exact retained snapshot's recovery commitment
at startup only. Neither reader authorizes or executes recovery.

Reads request `application/json;odata=fullmetadata`. The raw decoder runs **before
SDK normalization**, detecting fatal UTF-8/BOM errors, decoded duplicate JSON keys,
aliases/unknown properties, incorrect EDM types, noncanonical base64, missing or
partial chunks, mismatched physical/logical keys, scope and digests. Numeric tokens
in the closed wire/receipt grammar must be canonical nonnegative safe integers:
decimal points, exponents, negative zero and unsafe integers are refused before
JSON projection can erase their physical type or precision. Epoch remains a
canonical string and opaque domain bytes remain Binary. It handles
real service Timestamp values (including seven fractional digits), Timestamp's
supported annotation, per-row `odata.etag`, and bounded documented `odata.type`,
`odata.id`, `odata.editLink`/the documentation's `odata.editlink` spelling, and
response-level `odata.metadata`. Both edit-link aliases together are rejected.
Informational metadata URI strings are never followed or used as authority.
Point header/body ETags must agree; a page-level ETag is **not** compared with each
row's ETag. Missing required Timestamp/row ETag is never fabricated. Ambiguous
consumed response headers and non-JSON read bodies are refused.

The official payload matrix explicitly says `nometadata` omits property annotations
and row ETags; `minimalmetadata` also omits row ETags. The earlier local adapter
probe's small no-metadata envelope is not the production wire schema.

Official service references:

- [Payload format and full-metadata examples](https://learn.microsoft.com/en-us/rest/api/storageservices/payload-format-for-table-service-operations)
- [Query Entities](https://learn.microsoft.com/en-us/rest/api/storageservices/query-entities)
- [Table data model and limits](https://learn.microsoft.com/en-us/rest/api/storageservices/understanding-the-table-service-data-model)
- [Query timeout and pagination](https://learn.microsoft.com/en-us/rest/api/storageservices/query-timeout-and-pagination)
- [Table service error codes](https://learn.microsoft.com/en-us/rest/api/storageservices/table-service-error-codes)

## M authority, uncertainty and cleanup truth

Ownership is nonexpiring. Every submitted mutation, acquisition, barrier and release
conditionally replaces M using the **exact original ETag**, together with its data
actions in one partition. Initialization is the sole create-only exception. The
kernel allocates private invocation UUIDs; it never resubmits an original write.

Every write gets mandatory raw M readback regardless of SDK success/failure:

1. The exact expected M digest confirms this invocation's commit.
2. The unchanged original M/ETag permits **one** cancellation barrier using that
   original ETag, preserving original ownership/domain state/result/receipt.
3. Lost barrier ACK or 412 requires another raw read. Exact expected M still wins;
   exact barrier M confirms cancellation. The barrier is not blindly retried.
4. Missing M, unexpected foreign state, corrupt metadata or exhausted reconciliation
   fails unresolved and poisons writes. Absence/status alone never proves cancellation.

Lost initialization ACK can be confirmed only by its immutable initialization
stamp, including after later legitimate transitions. It never creates a
cancellation tombstone. A failed acquire can leave `ownership: 'possible'`.
Release expects **owner-empty**, not the releasing owner. If a new owner has
already advanced M, the exact preserved last-release receipt can still prove the
old owner's release. A missing/superseded receipt cannot.

Close releases only healthy positively-owned state after work drains; poison or
unconfirmed acquisition forbids release writes. It still attempts local transport
drain. **A rejected close is not evidence that ownership was released**: inspect
local certainty and investigate persisted state without assuming takeover is safe.
A confirmed release cancellation similarly leaves the owner installed and makes
close reject. There is no force/recovery API. Crash recovery and an operator's
independent proof of old-process termination remain deferred; neither local close,
a fixture, nor an orchestration stop acknowledgement proves physical termination.

## Bounds and work tracking

| Bound | Standard profile / hard envelope bound |
|---|---|
| Logical pending operations | 96 (supports inbox 32 + route 32 + relay 1); configurable 1..1024 |
| Retained caller input/key bytes | 32 MiB; configurable from 1 byte to 256 MiB |
| One caller input / read-key list | 256 KiB / 99 distinct typed keys |
| Domain state / result | 64 KiB each |
| Binding / release or Exit receipt | 16 KiB / 1 KiB |
| Data payload | 4 contiguous binary chunks, each <=64 KiB, total <=256 KiB |
| Transaction | <=100 actions **including exactly one M**; one partition, distinct rows |
| Multipart request | Conservative pre-SDK budget plus <=4 MiB actual serialized UTF-8 bytes before auth/native write |
| Native response / headers | <=512 KiB / 16 KiB; no decompression |
| Caller deadline | 30 s default, configurable 1..300,000 ms (also per call) |
| Reconciliation cleanup phase | Separate 30 s default, configurable 1..300,000 ms; outlives caller cancellation |
| Reconciliation | At most 4 raw reads by default (configurable 2..16) and one barrier write |
| Legacy `scan()` | 10,000 one-entity pages / 64 MiB raw bytes by default; configurable finite limits |
| Continuation | <=2048 ASCII characters per service component, <=8192 opaque SDK token characters |

Fixed layouts have at most 13 custom properties on M and 10 on data, safely below
252 custom / 255 total. Binary is accounted decoded, strings/property names in
UTF-16 for logical entity size: these layouts remain below 300 KiB, well below
1 MiB. This is not a general arbitrary-entity size calculator. The pre-SDK wire
budget reserves 8192 bytes per action plus base64 binary lengths and padding;
actual wire bytes are checked again. It deliberately may reject a near-service-
limit plan early, rather than confuse JSON length with logical entity size.

Admission is synchronous and finite: no hidden queue of waiters. Queued aborts are
removed once; issued work keeps its slot and retained-input accounting through
actual token/native work and cleanup/readback, even when its caller has expired.
Internal reconciliation consumes the same slot, not a second external admission.
Active SDK serialization, response parsing, plan and audit copies are **separately
bounded**; pending-input bytes are not a total heap measurement.

Each scan starts a new public SDK iterator, consumes one page, then returns that
iterator. The original partition filter remains fixed. Empty continuation pages
are consumed, cycles/nonprogress are refused, and token history consists of bounded
fixed-length hashes. A row-only continuation that the public SDK cannot represent
fails incomplete rather than pretending end-of-data. Cancelled/exhausted scans
leave owned handles unready, never partially audited. Retained history/startup
cost can grow without bound operationally; this profile may eventually refuse a
full audit and requires a later retention/operational decision.

A close release can require its initial read/write phase plus its separate cleanup
reconciliation phase. Deadlines fence late work and destroy requests; they are not
hard-real-time scheduler guarantees. Native request **and socket close** are awaited.
The trusted token callback is also awaited even after cancellation: a callback
that never settles can permanently prevent drain. There is no timeout-as-drain
escape hatch or claim of owning arbitrary work created by external callbacks.

## Explicit owned streaming audit

Both explicit handles expose `auditOwned(visitor, budget, options?): Promise<void>`.
V1 uses `OwnedAuditVisitor` / `StoredRecord`; V2 uses the separate
`OwnedAuditVisitorV2` / `StoredRecordV2`. The closed visitor has `passes: 1 | 2`,
`record(pass, record)`, `endPass(pass)` and `finalize()` callbacks. Inputs must be
plain/null-prototype objects with own enumerable data descriptors; all callbacks,
required budget scalars and optional settings are validated and snapshotted before
admission. Invalid configuration does not retire existing permission or do I/O.

All four `OwnedAuditBudget` fields are required positive safe integers:

| Field | Meaning / engineering ceiling |
|---|---|
| `maxPages` | Attempted collection requests across all passes, including empty pages; <=`Number.MAX_SAFE_INTEGER` |
| `maxPageBytes` | Complete collection-response body bytes, including JSON/base64 overhead, across all passes; <=`Number.MAX_SAFE_INTEGER` |
| `maxDurationMs` | Admission-relative monotonic eligibility, including queue wait; <=2,147,483,647 ms |
| `maxTrackingBytes` | Kernel cursor/hash/row representation capacity and growth overlap; <=256 MiB |

There is **no default audit profile** and no domain index allocation option.
A valid profile can be too small to complete even a small history. Totals use
subtraction-before-addition checks and never reset between passes. This new method
does not inherit the legacy `scan()` aggregate ceilings or `callTimeoutMs`.
`OwnedAuditOptions` accepts only an optional native `signal` and
`requestTimeoutMs` (default 30,000; 1..300,000 ms). Each request uses the earlier
of its own deadline and the admission deadline. M point bodies are excluded from
`maxPageBytes`: a successful audit performs exactly **2 × passes** point reads,
each <=512 KiB, in addition to the collection body allowance. Headers/TLS/socket
overhead are not body counters. The audit-only native page gate checks before
retaining a chunk beyond `min(512 KiB, remainingPageBytes)`, aborts and drains,
and preserves `incomplete` through SDK/iterator cleanup. It never decodes a
budget-truncated body. A final received chunk/socket buffering can exceed the
abort threshold; this is not exact network billing.

A job starts only with healthy positive ownership, retiring any prior generic
permission. It freezes private owner/epoch/ETag/digest for every pass. Each pass
performs a **separate** before-M read, serial traversal, `endPass`, and separate
after-M read. Traversal requires one matching M, strictly increasing row keys and
no continuation cycles. Empty continuation pages continue; no prefetch occurs.
`finalize` runs only after all passes. Every delivered record, payload and receipt
is an independent copy, not authoritative kernel state.

Callbacks are trusted synchronous non-I/O code returning exactly `undefined`;
public V1/V2 callback return types enforce this rather than discarding results as
`void`. The kernel snapshots function references and invokes them unbound, with
`undefined` as the receiver; it does not retain or bind the original visitor.
The callback signatures declare `this: void`. Use closures or arrow functions for
state rather than depending on a visitor receiver. Callbacks must not return or
throw Promises, or start asynchronous work. Runtime checks remain necessary for
JavaScript, unsafe casts and arbitrary throws.
Other returns and exceptions poison the handle. Defensive rejection handling for
ordinary returned, thrown and cross-realm native Promises is **best-effort**: the
intrinsic reaction avoids instance `.then` getters, but still runs constructor/
species machinery and assumes safe constructor/species and relevant intrinsics.
Nothing is awaited or assimilated.

Audit poisoning is separate from process-level rejection handling. For example,
an already-rejected native Promise with a nonconfigurable throwing `constructor`
getter can prevent rejection-handler registration. The audit rejects `unresolved`,
poisons and cannot publish envelope-audited permission or clean-release ownership,
but the Promise may remain unhandled and trigger process diagnostics (potentially
including its private rejection reason) or termination. This boundary is **not a
sandbox or universal Promise containment guarantee**; do not use untrusted callbacks.

Throwing the exact exported unique-symbol
`OWNED_AUDIT_BUDGET_EXHAUSTED` is the sole benign domain-allocator exhaustion
signal; throwing `TableError('incomplete')` is **not** that signal. Same-kernel
queued operations and `close()` synchronously throw and latch invalidation during
a callback, even if the visitor catches the error. Only `status()` and
`invalidate()` are allowed. Arbitrary domain allocations or secret asynchronous
work started by trusted callbacks are outside kernel resource accounting.

### Tracking charge proof

`audit-tracking.ts` reserves a fixed **80,860 bytes** at job start, before any
collection receive, plus its hash-table capacity:

- Old accepted cursor: `2 × (8192 + 2048 + 2048) = 24,576` bytes.
- Incoming SDK cursor: `2 × (10976 + 2048 + 2048) = 30,144` bytes. The pinned
  SDK creates base64 of JSON `{nextPartitionKey,nextRowKey}` before the client
  checks token length. Each permitted 2048-character printable ASCII component
  can double from JSON quote/backslash escaping; with 39 syntax bytes this is
  `2 × (2048 + 2048) + 39 = 8231` JSON bytes, then
  `4 × ceil(8231 / 3) = 10976` base64 characters. The accepted/retained token limit
  remains **8192**; an oversized incoming token still poisons, without further
  requests. Old-plus-incoming cursor reservation is **54,720 bytes**, including
  both UTF-16 token/header representations.
- Reusable, unpooled hash input: `3 × 8192 = 24,576` bytes, enough UTF-8 storage
  for the maximum token's UTF-16 code units; a 32-byte digest and 128 bytes for
  the temporary 64-character hex digest. Total hash scratch **24,736 bytes**.
- Two unpooled last-row buffers: `2 × 2 × (8 + 1 + 342) = 1,404` bytes, covering
  old/new overlap for the longest typed row (`delivery_` plus encoded identity).

The open-addressed SHA256 set is a single unpooled `Buffer.alloc(33 × C)`:
one explicit occupancy byte and 32 digest bytes per bucket, power-of-two capacity
and load <=1/2. All-zero hashes are ordinary occupied entries. Initial `C=2`
requires **66** more bytes: 80,926 total. Doubling from C to 2C must first fit
**33 × (C + 2C)** in the remaining ledger, not just the steady-state capacity.
The old buffer reference is dropped before releasing that reservation. For the
first growth, the total required is **81,058** (80,860 + 198), not 80,992.
Probes and rehash loops check eligibility. Pass boundaries clear/reuse existing
capacity; pages and body totals remain cumulative.

This is a conservative representation/capacity proof, **not guessed JS Set/Map
entry sizes, measured heap/RSS or a guarantee of immediate GC**. The one-page,
one-record, native response, SDK and short-lived single SHA256 context working
sets remain separately bounded; no hash context or decoded record is retained
per cursor. There is no unbudgeted per-row cross-pass map.

### Failure and publication boundary

Audit uses a discriminated job in the existing FIFO, not another queue. An active
abort, timeout, invalidation or close stops later requests/callbacks but retains
its promise and work slot until token/native/socket/iterator work actually settles.
The audit-specific native abort subscription resists an earlier caller listener's
`stopImmediatePropagation()`, without invoking caller signal getter/method
overrides. The subscription is disposed on actual completion or queued removal;
legacy cancellation is unchanged.
Never-started caller cancellation/close removes the queued audit immediately with
`not-submitted`; admission deadline exhaustion is `incomplete`. The kernel does
not close itself or its client to manufacture audit drain. A never-settling token
callback can prevent audit and external close from finishing indefinitely.

Budgets, sentinel exhaustion, active caller cancellation/close and ordinary
nonprogress give `incomplete`; per-request timeout/transport alone gives
`unavailable`. Healthy known ownership may later release after drain and fresh
exact authority proof. Observed corruption, missing/duplicate/mismatching M,
authority drift, invalidation and callback violations sticky-poison with
`unresolved`, overriding a prior benign failure even after late drain. No extra
reads are fetched after cancellation to make accounting symmetric. Legacy
poisoned diagnostic reads and early caller rejection remain unchanged.

Envelope-audited is published only at the final eligible FIFO completion, after
finalization and actual drain. An audit-specific deferred pump handoff lets the
**direct promise completion continuation** run before the next FIFO mutation;
new admissions cannot bypass that handoff. Legacy-only scheduling is unchanged.
This is not an indefinitely frozen snapshot for arbitrary later asynchronous
continuations. Future domain callers must serialize their own operations and
synchronously recheck eligibility before publishing a private projection. Stable
M alone does not establish cross-pass row membership, ETag/digest consistency,
domain graph correctness or application Ready; those are domain visitor duties.
The [inbox auditor](table-inbox.md#persisted-layout-and-complete-audit) implements
those graph checks, while its store separately owns startup and forwarding eligibility.

## SDK and qualification boundaries

Pinned `@azure/data-tables` 13.3.2 handles entity/EDM serialization, exact-condition
requests, multipart assembly, URLs and public paging. The owned wrapper handles
one-shot storage auth, verified fixed-primary native HTTPS, bounds, raw validation,
privacy, admission, audit and reconciliation. Public pipeline controls remove HTTP
retry, bearer cycler/challenge, proxy, redirect, decompression, HTTP logging and HTTP
tracing policies. High-level SDK instrumentation remains active; production does not
change global tracing/logging. No private SDK hooks or REST implementation is used.

Batch ACK content is bounded then discarded, not parsed for commit authority.
Detailed inner-status/Content-ID diagnostics are intentionally unavailable.
**SDK success spans are not domain commit metrics.** Only exact M reconciliation
can support journal outcomes; operational metrics remain future work.

Focused checks, using Node >=24 and OpenSSL for ephemeral local TLS fixtures:

```sh
node --import tsx --test test/table-*.test.ts
npm run check
```

Tests use the production kernel and real public SDK over native verified HTTPS.
Independent fixture code parses actual multipart bodies and applies exact
conditions to its own state; it never uses production transition/codec functions
as its commit oracle. Tests cover FULLmetadata, malformed/raw responses, native
TLS/drain, active instrumentation privacy controls, bounds/backpressure, complete
scans and lost-ACK/owner/barrier races. They do **not** contact Azure or use real
credentials. Azure atomicity, primary-read consistency and service acceptance are
document-backed assumptions exercised by a scripted local service, **not live
Azure qualification** or physical-death proof. Delivery-domain audit coverage is
described below; [inbox-domain coverage](table-inbox.md#resource-and-qualification-boundaries)
is documented separately. The generic kernel does not interpret journal payloads.

## Delivery journal contract

Import `createTableDeliveryJournal` (V1) or `createTableDeliveryJournalV2` (V2)
from `src/delivery/table-journal.ts`. Both take a delivery binding, the same trusted
Table dependencies, and optional limits:
`{maxPending, maxPendingBytes, kernel: Partial<TableLimits>}`. Construction is
synchronous and I/O-free. Both return a retained handle satisfying
`DeliveryJournalPort`; neither alters the synchronous SQLite public APIs. Format
is pinned privately at construction, not selected by binding, limits or stored data.

| Factory / stored metadata | Behavior |
|---|---|
| V1 / M1 | Existing format, bytes, limits and normal behavior. |
| V2 / M2 with V1 data envelopes | Supported after complete startup validation. |
| V1 / M2 or V2 / M1 | Reject before acquisition writes; no migration or fallback. |
| Explicit initialize / existing M or orphan rows | Refuse; no adoption/reset. |
| Normal open / bare or partial genesis | Refuse; only the successful initializer handle may install the marker. |

```ts
const initializer = createTableDeliveryJournalV2(binding, dependencies);
await initializer.initialize(); // installs schema-one domain marker, then closes
const journal = createTableDeliveryJournalV2(binding, dependencies);
try {
  await journal.open();
  const begin = await journal.begin(request);
  // Only a current claimed outcome can proceed through ordinary dispatch checks.
} finally {
  await journal.close(); // keep and drain the handle even when open rejects
}
```

- `initialize()` is explicit and single-use: generic initialize, acquire, full
  scan, domain marker mutation, then drained release. Only this path accepts empty
  genesis, with no other rows and first acquisition epoch one. Use a **fresh**
  handle for open. Failed partial initialization stays present; there is no reset,
  resume, adoption, migration or reinitialization path.
- `open()` acquires unready, scans every retained envelope, validates the complete
  domain graph and captures the current epoch before publishing readiness.
  V2 additionally verifies any operator-recovery commitment at this fresh-acquire
  boundary. Concurrent close cannot publish late readiness. Keep the handle after
  rejection: cleanup drains locally but may still leave possible or confirmed ownership.
- `begin(request)` validates and hashes synchronously, then queues **only** the
  three-field `RequestIdentity` (delivery ID, stable ID, digest). No outgoing text,
  metadata, route, message or request body is queued or persisted by this journal.
- `settle(claim, outcome)` synchronously validates and copies its inputs before
  queueing. Valid opaque non-UUID public attempts return stale, not invalid-input;
  only stored attempts must be UUIDv4.
- `close()` synchronously retires readiness, removes never-issued queued work and
  awaits active journal work, startup and kernel drain. It is idempotent and
  preserves the same close promise. Safe errors attach no raw SDK/native cause.
- `status()` is local and I/O-free: lifecycle, pending snapshot count/bytes and
  nested kernel lifecycle/ownership certainty/count/bytes. It contains no IDs,
  tokens, receipts or payload. It is not storage authority or termination proof.

Begin preserves SQLite's shared alias namespace and ordering. It discovers the
requested aliases, then supplies at most **seven** unique keys to one M-fenced
mutation: those aliases, their target operations and self-aliases, and the
requested operation. The planner rereads/verifies discovery and validates all
these targets before checking conflict. Drift or domain corruption poisons the
kernel instead of retrying lookup or returning a harmless conflict. Conflicts
write no alias/operation. Compatible in-flight/terminal replays still add fresh
aliases. Fresh and ready operations get new attempts. The largest transaction is
M, one operation and two aliases; same-ID aliases collapse atomically.

Settlement requires the exact attempt. Only sending transitions once; repeated
same state/receipt is unchanged, all other terminal/old attempts are stale. On a
new ownership epoch, old sending is **logically unknown**, without rewriting any
data rows. The same old claim plus unknown is unchanged; late receipts/retryable
outcomes are stale. Ready and recorded terminals survive restart. There is no
bulk recovery, index, cleanup counter or manual recovery hook.

### Delivery payloads and audit

All domain bytes pass the kernel's strict UTF-8/raw JSON grammar (including decoded
key duplicates and canonical numeric lexemes) and closed domain validation:

- M.state: `{journal: 'teams-delivery', schema: 1, fingerprint: 1}`.
- `delivery(stableId)`: `{schema: 1, fingerprint: 1, digest, attemptId,
  attemptEpoch, state, providerMessageId}`. States are ready/sending/delivered/
  rejected/unknown; receipt is non-null exactly for delivered. Epoch is positive,
  safe and no later than the current ownership epoch.
- `alias(identifier)`: `{schema: 1, idempotencyId}` targeting a stable operation.
- M.result: schema-one initialize, begin (identity and result) or settle (claim,
  outcome and result) record. Only safe IDs/digest/claim/receipt/status are retained.
  Historical results are validated, **never** interpreted as current send grants.

Full audit validates M.state/result, every operation, every alias (including
unrelated ones), target existence and each operation's correct self-alias. It
rejects unsupported control rows, orphan graphs, invalid identities/digests/
UUIDs, future epochs and receipt/state mismatches before readiness. Recognizable
unsupported domain versions report `unsupported-schema`. Other domain corruption
reports `corrupt`; generic kernel corruption is not guessed from an `unresolved`
error. A mismatched Table binding reports `corrupt`, unlike SQLite's separate
`scope-mismatch`. Domain failures invalidate the kernel even when a synchronous
planner exception would otherwise be normalized to `invalid-input`.

### V2 delivery recovery reader and startup release guard

V2 changes only metadata lifecycle/envelopes, not delivery marker, result, operation
or alias schemas. Opening preserves exact accepted state/result and physical data
bytes, including valid historical JSON whitespace. There is no recovery-tagged
delivery result. Old physical sending remains physically sending and becomes
logically unknown; a recovery fixture does not grant resend permission.

After its private kernel freshly acquires, the V2 wrapper requires owned `acquire`
metadata with current epoch exactly `Exit.oldEpoch + 1` (or epoch one without Exit).
It fully validates the ordinary graph and retained result, then, for an
`operator-recovery` Exit only, computes this commitment using SHA256 of UTF-8
`JSON.stringify(value)`:

```text
B = canonical binding bytes, base64
h = digest(['orka-recovery-data-v2', B])
for each physical data row in strictly increasing row-key order:
  h = digest(['orka-recovery-row-v2', h, rowKey, envelopeDigest])
D = digest(['orka-recovery-data-end-v2', h, count])
expected = digest(['orka-delivery-recovery-v2', B,
  exactStateBase64, exactResultBase64, D, count, 'epoch-restart'])
```

All data rows contribute, including unrelated operation/alias subgraphs. M, ETags
and timestamps do not. A mismatch refuses readiness and invalidates release. The
fold reuses the complete bounded scan; it does not serialize a second giant graph.
Absent/clean Exits need no recovery hash but still require complete startup audit.

**This check is startup-only, not an invariant of historical Exit versus current
content.** Later legitimate begin/settle may change rows and M.result while retaining
the old Exit. They are not compared with that stale commitment. A later clean close
replaces the validated recovery Exit; another open audits the current graph without
requiring a superseded historical receipt. An owned barrier can describe later
mutated content, not necessarily the snapshot committed by a historical recovery
Exit. Matching a digest proves consistency, not operator authority, physical death,
protection against restored history or an everlasting audit ledger.

Before acquisition can submit, V2 establishes a startup-proof obligation. Only a
complete successful domain audit, or the same successful initializer's complete
epoch-one empty-genesis proof, discharges it. On failed/incomplete startup or close
during acquisition/scanning, the wrapper **synchronously invalidates before its
first kernel close** while that obligation remains. This prevents cleanup from
replacing an unchecked recovery Exit with a clean receipt. Late work cannot restore
readiness or erase invalidation. Close still retains actual token, request,
reconciliation and native drain; it is not a timeout-as-completion escape hatch.
Closing a never-started handle is harmless. Successfully validated startup can
release normally; V1 startup cleanup behavior is unchanged.

**Availability consequence:** an interrupted V2 startup can retain an installed
owner and block ordinary reopening even when the incomplete scan never established
whether a recovery Exit existed. A failed close is not release evidence. There is
no automatic takeover, reset, recovery executor or runtime configuration here.

Delivery deliberately retains legacy `scan()` limits (10,000 pages / 64 MiB by
default and the existing caller deadline), not the inbox's streaming/index audit.
A complete valid history may exceed those operational budgets and fail to open.
This slice does not qualify full-capacity history, RSS, latency or live Azure use.

### Delivery queue and timeout bridge

The journal has its **own FIFO**, since a begin uses several kernel calls. Standard
limits are 96 active-plus-queued operations and 32 MiB of retained snapshot bytes.
Configurable ranges are 1 to 1024 operations and 1 byte to 256 MiB, respectively.
Kernel budgets remain independent.
Snapshot-byte accounting is not a measurement of all transient codec/SDK memory.
Saturation returns typed `busy` without enqueueing or poisoning the journal.
Pure caller validation fails synchronously before queueing and also does not poison.
The existing dispatcher still treats **any** journal error as fatal; this is not
new nonfatal dispatcher backpressure. Its ordinary HTTP concurrency cap is 32.

Kernel caller timeout is not port completion. On an admitted operation failure the
journal immediately retires readiness and stops submissions, then awaits
**kernel.close**, including actual token/native work and reconciliation, before
rejecting the active port promise or releasing its journal slot. It never awaits
its own close from inside that operation (which would self-deadlock). Positively
reconciled healthy cleanup may release; uncertainty/domain corruption cannot.
Never-settling trusted token work can indefinitely hold operation and shutdown.

Both delivery factories run public SQLite differential traces (independent attempt
mapping), lost begin/receipt ACKs, both original/barrier orders, queued old-writer
fencing, full graph corruption and 103 old sends with zero recovery data writes.
Actual kernel caller timers are exercised while token, reconciliation and native
destruction remain held. Sender/dispatcher tests use the real Teams SDK and native
HTTPS with a trusted fixture-only POST mapping (production route validation still
forbids explicit service ports); provider counts stay one for receipt/late-receipt
and zero for pre-effect late-token or timed-out begin. Child fixtures retain Table
service state across **controlled close/reopen handover** and demonstrate busy
exclusion, unknown recovery and receipt replay, not physical crash recovery or a
production worker-isolation architecture. Active recording instrumentation retains
its positive leakage controls and exercises the production journal while asserting
private request fields never enter wire entities or M.results. Shared hostile
exception tests exercise both factories with safe known-code mappings, cause-free
fallback and zero unintended I/O. V2-specific reader fixtures cover independent
literal recovery vectors, exact-byte padding, coherent unrelated-subgraph deletion,
malformed Exits, startup-only comparison, incomplete scan release bypasses and
held acquisition/token/native-close drain. These fixtures read recovery-shaped
histories; they neither execute recovery nor establish termination authority.
