# Table inbox — V2 contract

`createTableIngressStore` in `src/ingress/table-store.ts` implements the asynchronous
`IngressPort` on the explicitly V2 [Table kernel](table-storage.md). The compiled
CLI supports [explicit Table V2 runtime selection](table-runtime.md), including a
purpose-specific storage identity provider. SQLite remains the default; its
synchronous APIs, schemas and relay behavior are unchanged.

There is no automatic initialization/adoption, V1 migration, lease, pruning,
operator recovery command, HA promise or Azure hosting integration. The Table
delivery journal has explicit V1 and V2 factories; the selected runtime uses V2,
which validates retained recovery commitments at startup only. Crash recovery
remains separate work. The runtime does not provision Azure resources or establish
live identity/service qualification.

## Construction and lifecycle

The factory is synchronous and performs no I/O:

```ts
import { createTableIngressStore } from './src/ingress/table-store.js';

const store = createTableIngressStore(binding, dependencies, {
  audit: explicitlyChosenAuditBudget,
  maxIndexBytes: explicitlyChosenIndexBudget,
});
```

The example's binding, dependencies and budgets must be supplied by the caller;
it is not a deployment profile. The binding requires `kind: 'ingress'` and the
complete immutable app/tenant/Orka URL/Gateway scope. Resource and logical identity
rules, fixed storage token scope and trusted dependency boundaries are documented
in [Table storage](table-storage.md#library-contract).

| Option | Contract |
|---|---|
| `audit` | Required `OwnedAuditBudget`: explicit positive page, collection-byte, duration and tracking budgets; no default full-history profile |
| `maxIndexBytes` | Required positive accounted-index capacity, at most 1 GiB; an insufficient valid budget fails incomplete |
| `policy` | Existing ingress policy/defaults: 1000 retained bodies, 100000 retained events, one-day replay window; existing limits unchanged |
| `now` | Trusted synchronous `(this: void) => number`, default `Date.now`; unbound, no Promises or asynchronous work |
| `maxPending`, `maxPendingBytes` | Separate domain work ledger; defaults/ceilings 96 and 32 MiB, configurable downward |
| `kernel` | Existing kernel limits; its independent ledger and hard bounds are unchanged |

Keep the handle even when startup rejects. It exposes frozen `scope`, `status()`,
`initialize()`, `open()` and memoized `close()`, plus the port methods below.
Status contains only local lifecycle/counters and safe kernel/index diagnostics;
it is neither persisted authority nor proof that an old process has terminated.

- **Initialize explicitly, once.** Only the same handle that successfully created
  kernel genesis and acquired epoch one may install the inbox marker. A private
  two-pass audit requires M alone, empty state/result and no preceding Exit.
  Initialization does not sample the clock and closes its handle on success.
- **Open with a fresh handle.** Acquire unready, audit the complete retained graph,
  refuse every uncleared arm, then durably process the clock before preparing the
  new restart epoch. Any created seal is confirmed and refreshed before Ready.
- **Never adopt partial history.** Normal open refuses bare genesis. Repeating
  initialization does not resume, reset or repair a failed initialization.
- **Close on every path.** It stops intake and permissions synchronously, drains
  actual work, and releases only when arm/clock obligations are positively clear.
  A rejected close is not release evidence. Do not delete an owner or retry with a
  different store identity to bypass that failure.

The complete audit has its own explicit long-duration budget. Startup's subsequent
clock/restart mutation gets a fresh short phase. Ordinary work includes queue wait
in its short deadline; mutation and all row refreshes share that deadline. The
resolved kernel call timeout supplies short phase/request budgets. Reconciliation
and actual drain can outlive eligibility; a trusted token callback that never
settles can prevent shutdown indefinitely.

## Port behavior

The handle implements `admit`, `claimForForwarding`, `complete`, `retry`, `block`
and `getRoute`. There is deliberately **no raw asynchronous `claim()` bypass**.
Argument-taking methods snapshot synchronously rather than retaining caller objects
in suspended frames. Validation/intake failures may throw synchronously; admitted
work returns a Promise. Errors are cause-free `TableError` instances with the
existing closed codes. `not-submitted` backpressure is distinct from a persisted
admission result of `full`.

- Admission checks an existing event/fingerprint first, preserving its original
  reply target and route on duplicate; then target conflict, then capacity and
  clock-regression restrictions. Fresh records have contiguous insertion order.
- Every executing mutating call processes the clock, including duplicate, conflict,
  full, stale and empty-claim outcomes. `getRoute` never samples it. There is no
  optimization that silently skips empty-poll clock writes.
- Selection uses effective pending state and received/insertion order. Retry keeps
  attempt evidence and clamps its next-attempt time; completion records the receipt
  and removes only the body. Explicit block reasons remain conflict, invalid-event
  and redirect. Stale settlements still process the clock.
- Routes and event identities remain retained and immutable. Blocked/quarantined
  bodies still consume capacity. Reducing today's policy never truncates history
  or makes an otherwise valid retained graph invalid.
- After **controlled clean release and reacquisition**, old physical forwarding
  projects to pending without a bulk rewrite. Expiry/quarantine takes precedence.
  A process crash does not itself allow reacquisition: occupied ownership remains
  blocked.

## Persisted layout and complete audit

The inbox uses V2 M and V1 data envelopes in the existing ingress partition:

| Row | Identity and content |
|---|---|
| `event` | External event ID; canonical event/body digest/fingerprint, immutable reply target, state, times, attempt/epoch, insertion/generation and receipt/reason |
| `route` | Opaque reply target; reverse external event ID and canonical private route/digest |
| `control` | `generation:<ordinal>`; immutable nonempty generation seal with frozen watermark, observation, epoch and reason |
| M.state | Closed inbox marker, event/body counters, clock high-water mark, prepared restart epoch, current generation and optional handoff arm |
| M.result | Closed retained decision and state commitment; not a record of caller success, a successful `take()` or a POST |

Domain payload ceilings are 140 KiB per event, 16 KiB per route and 1 KiB per seal;
ordinary state/result are at most 4 KiB each. The recovery-result reader is limited
to 1 KiB. The actual kernel transaction/wire fences remain in force.

`auditInbox` runs one owned job with two streamed passes. It validates every
canonical payload and local digest, exact membership/ETag/envelope-digest/timestamp
across passes, route/event bijections, complete insertion/generation intervals,
counts/body charges, epochs and arm/attempt relationships. The second pass checks
full V1 fingerprints using real indexed bot/conversation evidence and immutable
scope. Terminal text has been removed: its historical text/fingerprint cannot be
reconstructed, so the existing receipt/digest-syntax/reference boundary remains.

Retained decisions are evaluated at their saved domain epoch, not a later kernel
acquisition epoch. Recovery-shaped fixtures additionally require the complete
ordered physical-data fold/count and the prescribed state/result/Exit commitments.
A later clean Exit may replace the old recovery receipt without changing domain
bytes; an old Exit is not misused as a commitment to a newer ordinary result.
Reading this representation supplies **no recovery execution authority**.

The auditor returns a private projection, **not Ready or forwarding permission**.
Its bounded header is borrowed under an explicit metadata credit; the owning audit
result must remain alive until its header/index references are dropped and disposed.
Its M snapshot becomes historical after subsequent mutations. The store uses current
index state and fresh kernel fencing, never that old header as current M authority.

## Confirmed publication

Planning rereads required rows and verifies current M state, presence/absence and
indexed versions. Expected row digests and prepared index changes derive from the
**exact private planner payload bytes**, before physical submission. SDK ACK
metadata does not supply new ETags.

After confirmed commit, each changed row receives one healthy owned read—currently
M/row/M, three point requests. Key, digest, exact payload and domain validation must
match the prepared change before adopting its new version. All changed rows are
staged before a single synchronous index publication. M-only mutations still need
confirmation/publication but no Data refresh. A confirmed write followed by failed
refresh is never replayed; readiness stops and actual work drains.

## Durable arm and final synchronous handoff

A claim durably records forwarding **and** an arm bound to the owner epoch,
generation, insertion ordinal and attempt UUID before exposing a grant. One frame
holds the inbox's FIFO position and reserved work capacity until finalization:

1. Await the grant's serialized `revalidate()`; it cannot revive retired permission.
2. Invoke the one-use synchronous `take()` directly before the POST, with no await
   in between. It captures one clock observation and can only revoke eligibility.
3. Call synchronous, idempotent `retire()` on every path. Retirement/consumption
   schedules an owned finalizer; it does not wait for the provider response.
4. The finalizer commits the captured observation and clears the arm atomically,
   then completes refresh/publication before any later ordinary queued clock.

The existing relay already follows this sequence. A failed/invalid final clock
sample is debt, **not** unsampled retirement. One validated matching settlement may
withdraw permission synchronously and use reserved continuation space; it executes
after finalization with its own clock. Refused admission retains nothing and changes
no grant. The store holds no reverse reference to the resolved grant Promise or
caller-owned claim body merely to retain its work credit.

Close may finish confirmed **private cleanup-only** publication—for example, a claim
whose commit preceded close but whose refresh was still running—so it can clear the
arm through a coherent index. It exposes no Ready, grant or ordinary success and
starts no new ordinary work. Unknown/possible arming, an uncleared arm, a failed
armed-handoff sample, an unflushed observation or corruption invalidates the kernel
**before** its drain/close, preventing a fabricated clean release. Interrupted startup
with unknown arm state also takes this conservative path. Caller/runtime ownership
of actual Orka HTTP drain remains separate from store close.

An ordinary clock callback failure during open, claim, admission or settlement occurs
before that operation submits a domain mutation or exposes new forwarding permission.
It retires readiness; if the arm is positively known clear and no earlier handoff
clock debt remains, the store may drain and release cleanly. Such a pre-submission
failure does not create final-handoff debt by itself.

### Accepted armed-crash availability tradeoff

Unlike SQLite's synchronous transactional clock update, a crash can occur after
arming but before a final synchronous observation is durably flushed. The timestamp
may be unknowable. Normal opening refuses the arm; this slice has no executable
operator recovery.

The reviewed future recovery disposition preserves terminal/explicit-block/sealed
and proved-deadline reasons, but quarantines otherwise-active records in the armed
generation as `clock-uncertain`, retaining their bodies, routes and capacity charge.
This can affect unselected records and a crash before sampling actually began. It is
an intentional availability sacrifice, not SQLite-equivalent timestamp durability,
exactly-once delivery or automatic retry permission. Future recovery still requires
external confirmation of old-owner termination and prevented restart; a receipt or
orchestrator acknowledgement is not programmatic physical-death proof.

## Resource and qualification boundaries

The body-free index uses 4096-byte event slots, 512-byte seal slots, exact-identity
Buffer hash maps and numeric ordinal/generation arrays. It reserves capacity before
allocation and counts old/new growth overlap. It retains no event bodies, full routes,
service URLs, complete StoredRecords or per-event object maps.

At the structural maximum, conservative simultaneous backing growth plus the 4 MiB
working reservation is **875.5 MiB**, below the 1 GiB accounted-index ceiling. This
is arithmetic and small-fixture allocation evidence, **not** a 100000-record run or
an RSS/heap/native allocator guarantee. Working subquotas remain metadata 64 KiB,
scratch 2304 KiB, frame 1 MiB, delta 512 KiB and derived keys 64 KiB. Store and index
copies share those quotas; the domain queue and kernel queue remain independent.
Fixed handle configuration and trusted dependency implementations are distinct from
record-index accounting. Credits remain held through actual use and drain.

Finite budgets can reject valid history without truncating it. With N events and S
seals there are `2N + S + 1` physical rows. At N=S=100000, two one-row-per-page passes
require at least **600002 nonempty collection pages plus four M point reads**; empty
pages add work. A body-free index does not remove that scan cost or establish an
operational budget. Selection is O(N), with no qualified scheduler-latency promise.

Tests exercise the actual kernel/public SDK over verified local HTTPS, public SQLite
differential traces, bounded maximum-input traces, more-than-100-row logical quarantine,
provider request counts, controlled handover, killed armed-child refusal, lost ACKs,
conditional barriers, budget edges and held token/request/socket drain. They do not
contact Azure or use real credentials. The inspected string-allocation evidence is
for Node 24.2.0, not a blanket engine guarantee for future Node releases. No live
Azure durability, ACA readiness, corporate Teams/Orka execution or full-capacity
performance qualification is claimed.
