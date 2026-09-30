# Select the Table V2 runtime

The normal compiled CLI supports **explicit `table-v2` selection** for the V2
inbox and, when enabled, V2 delivery journal. SQLite remains the default, with
unchanged synchronous library APIs. This guide covers runtime selection; see
[Table storage](table-storage.md) and [inbox semantics](table-inbox.md) for the
persisted formats, bounds and failure rules.

Runtime selection is not provisioning, migration or HA. Explicit operator reclaim is a separate, audited command; `serve` never takes over an occupied owner. The separate
[ACA operator guide](aca-deployment.md) and [live report](live-validation.md)
record the evaluated identity/init/serve/personal-chat path without expanding those guarantees.
The physical Azure primary account/table and authorized UAMI access must already
exist. Application initialization creates logical partitions, **not tables or
accounts**. No Shared Key, SAS, connection string, endpoint override, ambient
credential chain or fallback is supported.

## Environment-only configuration

Build with Node 24 and `npm ci && npm run build`. The CLI does not load `.env` or
accept a configuration-file format. Supply credentials through the approved host
or secret manager, not argv, committed files or logs.

| Variable | Requirement / meaning |
| --- | --- |
| `GATEWAY_STORAGE_BACKEND` | Omitted or `sqlite` preserves SQLite; exactly `table-v2` selects Table. Empty/unknown values fail. |
| `TABLE_ACCOUNT`, `TABLE_NAME` | Explicit existing Azure primary account and physical table; resource casing is canonicalized to lowercase. |
| `TABLE_INGRESS_STORE_ID` | Explicit stable logical inbox identity for `init` / `serve`. |
| `TABLE_DELIVERY_STORE_ID` | Explicit stable logical delivery identity for `init-delivery` / outbound-enabled `serve`. |
| `TABLE_MANAGED_IDENTITY_CLIENT_ID` | Required explicit storage UAMI client GUID; never inherited from bot settings. |
| `TABLE_MANAGED_IDENTITY_HOST` | Required `imds` or `azure-container-apps`; no discovery/fallback. |
| `TABLE_AUDIT_MAX_PAGES` | Required positive safe integer: cumulative attempted inbox collection pages across both audit passes, including empty pages. Ceiling: `Number.MAX_SAFE_INTEGER`. |
| `TABLE_AUDIT_MAX_BYTES` | Required positive safe integer: cumulative inbox collection-response body bytes across both passes, including JSON/base64; maps to `maxPageBytes`. Ceiling: `Number.MAX_SAFE_INTEGER`. |
| `TABLE_AUDIT_MAX_DURATION_MS` | Required positive integer: admission-relative monotonic inbox audit budget, including queue wait. Ceiling: 2,147,483,647 ms. |
| `TABLE_AUDIT_MAX_TRACKING_BYTES` | Required positive integer: inbox audit cursor/hash/row tracking capacity, including growth overlap. Ceiling: 268,435,456 bytes (256 MiB). |
| `TABLE_MAX_INDEX_BYTES` | Required positive integer: inbox domain index budget. Ceiling: 1,073,741,824 bytes (1 GiB). |
| `TABLE_RECOVERY_EXPECTED_OWNER`, `TABLE_RECOVERY_EXPECTED_EPOCH` | Recovery commands only: the exact occupied owner UUID and positive epoch independently observed by the operator. Never guess or reuse values from an earlier attempt. |
| `TABLE_RECOVERY_ATTESTATION_DIGEST` | Recovery commands only: lowercase SHA-256 digest of an operator-held, private termination attestation. The attestation itself is never sent to Table or logged. |

All commands require the complete existing scope: `TEAMS_APP_ID`,
`TEAMS_TENANT_ID`, `ORKA_BASE_URL` (full HTTPS base including installation path),
`ORKA_GATEWAY_NAMESPACE`, `ORKA_GATEWAY_NAME`. Delivery derives its app/tenant
scope from that input. Logical IDs are never generated at startup or derived from
scope: partitions remain `v1_<kind>_<base64url(UTF8(storeId))>`. Both domains may
use one physical table and even equal IDs because kinds separate the partitions.
Keep scope, IDs, account/table, Gateway UID and Orka dedup ledger stable. Changing
scope does not silently adopt existing data or select a new logical store.

The budget values have **no default full-history profile**. An accepted numeric
configuration may still be too small to open retained history. For example,
tracking has an initial 80,926-byte reservation before growth. Separate M point
bodies, native buffers and SDK work are not included in collection body bytes;
index/tracking budgets are not heap/RSS measurements. See the exact
[audit meanings](table-storage.md#explicit-owned-streaming-audit) and
[inbox index accounting](table-inbox.md). Delivery keeps its existing complete
`scan()` limits (10,000 pages / 64 MiB by default and its existing caller deadline);
the inbox environment budgets do not enlarge them. Retention/caps are unchanged.

**Contradictions fail closed:** omit `INGRESS_DB` and `DELIVERY_DB` entirely in
Table mode, not empty strings or dummy paths. Conversely, all recognized
`TABLE_*` inputs above are refused in SQLite mode. Enabled directions always use
the selected backend; mixed SQLite/Table serving is not supported.

## Explicit initialization and serving

| Command | Inputs used beyond common Table identity/resource/full scope | Effect |
| --- | --- | --- |
| `node dist/ingress/main.js init` | Inbox ID and all five inbox audit/index values | Initialize only the empty inbox partition, then drain/close. |
| `node dist/ingress/main.js init-delivery` | Delivery ID | Initialize only the empty delivery partition, then drain/close. |
| `node dist/ingress/main.js serve` | Inbox ID/budgets, existing receiver/routing/bot credentials and Orka ingress bearer; enabled outbound additionally requires delivery ID and distinct outbound bearer/listener settings | Open/audit existing stores only; both audits complete before either listener. |
| `node dist/ingress/main.js recover-ingress` | Inbox ID, full scope, storage identity, audit/index budgets and three `TABLE_RECOVERY_*` values | Independently audit and conditionally reclaim **only** the occupied inbox. Does not listen or initialize. |
| `node dist/ingress/main.js recover-delivery` | Delivery ID, full scope, storage identity, audit/index budgets and three `TABLE_RECOVERY_*` values | Independently audit and conditionally reclaim **only** the occupied delivery store. Does not listen or initialize. |

Inbox initialization requires and validates all five audit/index values, but its
existing genesis audit uses the kernel's **30,000 ms** duration, not
`TABLE_AUDIT_MAX_DURATION_MS`. Normal `serve` opening applies the configured audit
duration. The genesis-audit duration is not a whole-command initialization deadline.

Equivalent commands are `npm run init:ingress`, `npm run init:delivery` and
`npm start`. Initialize each required partition **once**, explicitly. Both init
commands can share an environment containing the other's Table fields; they do
not use or initialize the other domain. Initializers need storage identity access
but **no bot credential, bot-token probe, directional Orka bearer or listener**.
For ingress-only `serve`, omit delivery ID and all outbound settings; set
`OUTBOUND_ENABLED` absent/`false`. Full mode uses `OUTBOUND_ENABLED=true` and the
[existing HTTP configuration](runtime-reference.md#enable-the-full-requestreply-runtime),
replacing `DELIVERY_DB` with `TABLE_DELIVERY_STORE_ID`.

Serve refuses missing, occupied, unsupported or incompletely initialized stores.
An occupied V2 owner reports `store-owned-requires-operator-recovery: occupied`
with a fixed ingress/delivery label; it does **not** claim that owner is alive,
wait for a lease, or retry automatically. `store-open-failed` reports a fixed
`missing`, `corrupt`, `incomplete`, `unresolved` or `unavailable` reason;
`listener-failed: ingress/outbound` identifies listener binding without
printing raw exceptions. `startup-cleanup-failed` means closure was not proven;
inspect persisted state rather than assuming ownership was released. Existing M
**or orphan data** causes init refusal, not adoption/reset. Interrupted or
refused initialization may already have committed: nonzero exit is not proof of
noncommit. Do not automatically retry, delete or roll back storage to get past
that failure.

### Manual owner reclaim

There is no lease in this release. To recover a stranded V2 owner, first stop
all old processes and prevent the old revision/Job from restarting; independently
verify physical termination. Record a private attestation and derive its
lowercase SHA-256 digest offline. Observe the **exact current** owner and epoch
using approved read-only Table inspection; set the three `TABLE_RECOVERY_*`
values privately (no shell tracing, raw attestation text, tokens or connection
strings in command arguments, output or checked-in files). Run one recovery
command for each blocked logical partition, only after confirming that the
same process cannot still own either store. A process still running can have a
provider request in flight, even though its later Table writes are ETag-fenced.

The command does a complete domain audit, then atomically replaces occupied
metadata with an owner-empty `recover` exit at the **same** epoch and creates a
separate, append-only audit row in that partition. It refuses a changed ETag,
owner, epoch, corrupt/incomplete audit, already empty owner, or unavailable
storage. An ambiguous response is **not** permission to rerun the command: use
read-only inspection to determine whether M and its audit row committed. The
command reports fixed `operator-recovery-failed` reasons: `already-unowned`,
`owner-or-epoch-mismatch`, `cancelled`, `audit-or-storage-failed`, or
`outcome-uncertain`. `already-unowned` on repeat adds no audit row; an
`outcome-uncertain` result requires inspection before any next action. The
next ordinary `serve` claim advances the epoch by one, verifies the recovery
receipt and domain disposition, then proceeds to listeners only after both
stores have passed their audits. Earlier-epoch delivery `sending` remains
logically unknown and is never resent; an uncertain ingress forwarding arm is
sealed/blocked, not requeued. A normal clean close does not require an operator
receipt. Reclaim cannot prove physical termination and cannot atomically cancel
an already submitted Teams/Orka call. Manual Table edits, re-init and changing
store IDs to bypass a blocked owner are unsupported.

SIGINT/SIGTERM are registered for asynchronous initialization and serve. Serving
shutdown inhibits intake, drains SDK/bot/provider/relay work and domain settlement,
closes both retained Table handles through reconciliation/release/native drain,
then closes the shared storage-token provider. Release can require a fresh token;
credentials must remain usable until stores finish. One close failure does not
skip the other. No successful initialized/stopped status is reported when required
work failed. A rejected close is not evidence that ownership was released.

## Separate-purpose storage and bot identity

Storage uses `TABLE_MANAGED_IDENTITY_*` directly for the sole scope
`https://storage.azure.com/.default`, translated to the fixed identity resource
`https://storage.azure.com/`. It does not use bot FIC/Entra exchange, reuse bot
tokens, or accept arbitrary resources. One private drainable provider serves both
stores: one cached token, one refresh, at most 32 actual callers, a 60-second early
margin and a maximum five-minute reuse window bounded by expiry. Replacement is
lazy on eligible acquisition; there is no eviction timer, so an idle provider may
retain an old token reference beyond that window. Close drops the cache after
actual work drains.
Native refresh has a five-second deadline. Cancellation does not fabricate drain
or cancel an eligible peer; close waits actual native request/socket completion.
No JavaScript zeroization guarantee is made.

The existing bot federation still requires explicit bot UAMI client **and
principal/object** IDs and an approved FIC. `TEAMS_MANAGED_IDENTITY_HOST` is
optional only in federation mode: omitted/`imds` preserves VM/ACI IMDS; explicit
`azure-container-apps` selects the new local host boundary. Assertion resource
`api://AzureADTokenExchange`, selected app/tenant and final Bot Framework scope
`https://api.botframework.com/.default` are unchanged. MSAL remains the final bot
token cache. See [managed-identity authentication](managed-identity-auth.md).

Separate provider/configuration purposes are mandatory; the same physical UAMI
**may be intentionally selected in both explicit client-ID fields**. Equality is
not inheritance or isolation. Least-privilege storage data access and host
assignment require separately authorized operator setup; management Contributor
is not Table data permission. Different IDs on a shared identity host do not
isolate mutually untrusted code with access to its identity endpoint.

## ACA supported local endpoint subset

Explicit `azure-container-apps` selection uses platform-provided
`IDENTITY_ENDPOINT` and rotating `IDENTITY_HEADER`, not incoming activity data or
public runtime config fields. The endpoint is validated and pinned before
ownership; a change later fails closed. The bounded nonempty header is read for
each refresh and goes **only** to the native local token service as
`X-IDENTITY-HEADER`. Neither private value appears in parsed config/status/logs or
is sent to Entra, Table or Teams. Requests use GET, API `2019-08-01`, one explicit
`client_id` and the fixed purpose resource.

Supported URLs are **HTTP only**, with no credentials, query or fragment: literal
IPv4 loopback (`127/8`) or link-local (`169.254/16`), literal IPv6 loopback (`::1`)
or link-local (`fe80::/10`), or `localhost` mapped directly to IPv4 loopback without
DNS. The platform path is preserved. Public/private-network DNS names, other
address ranges and other endpoint forms are refused. No proxy, redirect or retry;
responses are bounded to 64 KiB body / 16 KiB headers with actual request **and
socket** drain. Explicit ACA tolerates unused platform `MSI_ENDPOINT` and
`MSI_SECRET` aliases without reading, clearing or using them; they cannot replace
a missing or invalid canonical endpoint/header. IMDS still rejects those aliases.
`AZURE_FEDERATED_TOKEN_FILE` and bot SDK ambient-credential guards remain in force.
See the
[Microsoft REST contract](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity?tabs=http#rest-endpoint-reference).

This intentionally supports a local subset, **not every ACA endpoint form**.
The [recorded live evaluation](live-validation.md) exercised its actual endpoint,
assigned identities, FIC, Table access and Teams/Orka path. Other endpoint forms,
tenant policies and hosting configurations still need their own authorization and
validation; service atomicity, recovery and scale are not established by that smoke.
An unsupported form blocks qualification;
it is not permission to relax policy or fall back. No App Service/AKS token-file
or default-credential support is implied.

## Operational and verification boundary

Support **one writer with controlled clean handover** or explicit, audited
operator reclaim after verified termination. Occupied ownership, crashes,
failed audits and unclean releases do not trigger automatic takeover. Replica
count or ACA single-revision mode is not fencing; rolling revisions can overlap.
No scale-out, rolling-handover automation, lease, autonomous crash recovery,
force/reset or migration is provided. The checked-in Kubernetes package remains SQLite/client-secret; this
feature does not deploy or provision ACA or alter Kubernetes assets. The separate
[ACA profile renderer](aca-deployment.md) prepares operator-owned templates only.

The default offline test compiles the real source entrypoint into private output
before executing CLI init/serve commands. Native verified TLS/ACA fixtures exercise
both default JWT verifiers (including SDK wrong-key denial), actual storage and
bot federation/MSAL, authenticated Teams input, durable Orka receipt, saved-route
native provider send, duplicates and fresh-process replay after SIGTERM. Persisted
fixture maps are retained without reinitialization; native counters are checked
before forced cleanup. `npm run test:container` additionally runs this path in the
actual compiled nonroot/read-only image using a **test-only read-only preload
mount**, alongside the existing SQLite/proxy smoke checks. Default `npm test`
needs no Docker. These are small synthetic fixtures, not live Azure acceptance,
100,000-record, RSS, latency, physical-death or backup/rollback safety claims.
