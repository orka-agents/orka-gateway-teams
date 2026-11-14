# Operator-managed Orka registry

`node dist/ingress/main.js serve-registry` runs one Teams bot with separate
Table V3 inboxes, delivery journals, callback bearers and relay loops for registered
Orkas. Multi-target mode means `serve-registry`, even with only one registered
Orka. Existing `serve` modes (SQLite, Table V2 and Table V3) are unchanged.

There is no default or legacy target. Personal/group senders first see eligible
Orkas and choose with `use <targetId>`. Even one eligible Orka requires a choice.
The first eligible member's group-chat choice is permanent and shared; each later
sender still needs access. Discovery and commands create no Task. After connection,
send the request again. Unknown/ineligible choices and denied senders receive only
`You don't have access to an Orka for this chat.` through a durable control send.
Channels receive generic HTTP 409 without a Task or Teams reply.

Every admitted request and every queued event's relay gets fresh Gateway, Agent,
Binding identity/readiness and overlap checks. No membership lookup is repeated
for already accepted events. A reserved connection needs a fresh same-target
`use` command to resume provisioning; ordinary input returns HTTP 503. Switching
is unsupported. No Kubernetes operation happens at startup unless queued work
triggers relay after readiness.

## Manifest and environment

Set `ORKA_REGISTRY_FILE` to an absolute, canonical path to an operator-owned JSON
file. Its owner and parent-directory owner must be the runtime user or root;
neither may be group/world writable. Readable mode 0644 is allowed for the
manifest, which contains no bearer values. It has a closed schema (unknown keys, including `agents`, are rejected),
version 1, at most 32 targets and at most 256 KiB. For example:

```json
{
  "schemaVersion": 1,
  "targets": [{
    "id": "platform",
    "label": "Platform",
    "orkaBaseUrl": "https://orka.example.invalid/",
    "gatewayNamespace": "default",
    "gatewayName": "teams",
    "gatewayUid": "expected-gateway-uid",
    "frontAgent": { "namespace": "default", "name": "front" },
    "ingressStoreId": "platform-inbox",
    "deliveryStoreId": "platform-delivery",
    "ingressTokenFile": "/run/orka/platform-ingress",
    "callbackTokenFile": "/run/orka/platform-callback",
    "kubernetesBaseUrl": "https://kubernetes.example.invalid/",
    "kubernetesTokenFile": "/run/orka/platform-kubernetes.json"
  }]
}
```

Optional per-target `orkaCaFile` and `kubernetesCaFile` select PEM CA bundles;
otherwise system trust applies. All file references are absolute and canonical.
Orka URLs must have their canonical trailing slash. Kubernetes URLs are HTTPS
origins with a trailing slash, without credentials, query, fragment or path prefix.
The front Agent must be in the Gateway namespace. IDs match
`[a-z][a-z0-9-]{0,62}`. Labels are display values, not routing keys, and
must fit 256 UTF-8 bytes for directory control replies.

Ingress and callback files contain only their bearer (an outer newline is allowed),
not JSON. Each is a regular, single-link private file owned by the runtime user
(mode 0600 or stricter), bounded to 16 KiB, under an owned directory not writable
by group or others. Symlinks and aliased parent paths are rejected. Directional
bearers must be distinct across every slot. No credential belongs in the manifest.
SSO-enabled targets also require `taskPassTokenFile`, a separate private
controller credential; non-SSO targets omit it. It must differ from every other
controller/ingress/callback bearer. See [root Task tools](delegated-auth.md#root-task-tools)
for the controller configuration, pass routes and fixed Work IQ arguments.

Use the existing shared bot, listener, policy and Table environment settings from
the [runtime reference](runtime-reference.md) and [Table guide](table-runtime.md):
`GATEWAY_STORAGE_BACKEND=table-v3`, `OUTBOUND_ENABLED=true`, `TEAMS_*`,
`INGRESS_HOST/PORT`, `INGRESS_MAX_*`, `INGRESS_REPLAY_WINDOW_MS`,
`OUTBOUND_HOST/PORT`, `INTERIM_DELIVERY_ENABLED`, `MEETING_DRAFTS_ENABLED`,
`TABLE_ACCOUNT`, `TABLE_NAME`, `TABLE_MANAGED_IDENTITY_*`, `TABLE_AUDIT_*`
and `TABLE_MAX_INDEX_BYTES`. All slots share one storage account, table and identity.
`TABLE_DIRECTORY_TABLE` is additionally required by `serve-registry`: an ASCII
letter followed by 2–62 ASCII letters/digits, distinct from `TABLE_NAME`
case-insensitively. The directory uses the same account and identity, but its
own table, not a third V3 domain. Also set `ORKA_GROUP_POLICY_FILE` to an absolute
path to the startup-only [group-policy JSON](group-policy.md). Invalid/missing
policy fails before store ownership. The manifest format is unchanged.
Do not also set `ORKA_BASE_URL`, `ORKA_GATEWAY_NAMESPACE`, `ORKA_GATEWAY_NAME`,
`ORKA_BEARER_TOKEN`, `ORKA_OUTBOUND_BEARER_TOKEN`, `ORKA_CA_FILE`,
`TABLE_INGRESS_STORE_ID` or `TABLE_DELIVERY_STORE_ID`: those come from each target.
SQLite paths, recovery and upgrade inputs remain invalid for Table serving.

## Storage and handover

Initialize **new** slots explicitly, once per domain, using the existing
`node dist/ingress/main.js init` and `init-delivery` commands. For those commands,
supply that target's `ORKA_BASE_URL`, `ORKA_GATEWAY_NAMESPACE`,
`ORKA_GATEWAY_NAME`, `TABLE_INGRESS_STORE_ID` and `TABLE_DELIVERY_STORE_ID` alongside
the shared app, tenant, Table V3 storage and audit configuration. Initialization
does not consume `ORKA_REGISTRY_FILE`; it retains the existing command contracts.
Never initialize, reset or repair stores through `serve-registry`.

**Before upgrading an existing registry environment**, the operator must create
an empty, distinct directory table and set `TABLE_DIRECTORY_TABLE`. Serving never
creates that table. Missing configuration fails before ownership; a missing,
unreadable or corrupt table prevents every slot from starting, including retained
relays and callbacks. Directory startup failures use the existing fixed
`lease-transition-uncertain` diagnostic. Single-target `serve` needs no directory.

Preserve each target's exact app/tenant/Orka/Gateway scope and both stable store
IDs when reopening retained history. Inbox IDs must be unique among inboxes;
delivery IDs must be unique among journals. The two domains may use the same
ID because their partition kinds differ. Existing V2 data requires the separate
audited V3 upgrade procedure, not reinitialization.

Stop and actually drain the previous owner before switching commands or editing
registration, CA or startup credentials. A lease timeout alone is not proof of
drain. One replica owns every configured store (2N leases); all must open and audit
before directory recovery and readiness. Directory opening retires inherited
armed control sends under combined V3 authority before any listener starts, using
`TABLE_AUDIT_MAX_DURATION_MS` from the start of directory opening. Recovery makes
bounded durable progress; see [directory recovery](directory.md#control-receipts-and-uncertainty).
Shared token capacity covers all 64 domains plus four directory callers at 32 targets;
independent lease revalidation reads run in parallel, retaining the all-target
failure boundary. Any unsafe or busy store prevents startup. Any lease loss or
storage poison stops every slot. An unreachable Orka only delays its own relay;
no work moves between targets. Listener, SDK, token, provider and relay work drains
before the directory closes; its actual work drains before any V3 store releases
ownership. The shared storage token provider closes last. Directory startup and
drain cover live admission, control sends and relay preflight. Preflight requires
an exact provisioned directory row and target digest. Work without that evidence
uses no-effect retry/backoff and eventually the existing replay expiry; there is
no import, automatic adoption or bypass. Such work never moves to another target.

The routing digest hashes the versioned app/tenant/target/Orka/Kubernetes/Gateway
and front-Agent tuple. Changing those fields requires explicit history
reconciliation, not reassignment. Labels and credential/CA paths or values do not
change it. Registration does not verify a live Gateway UID or Agent at startup; admission
and per-event relay checks do so before use.

Four complete admission/preflight operations share directory capacity without a
queue, retaining their places through control settlement. Excess admission returns
HTTP 503; excess preflight uses no-effect retry/backoff. Relay preflight has a
two-second deadline because its owned grant temporarily holds that inbox's FIFO.
A failed preflight retires the grant before retry settlement, never an Orka handoff.
Other targets keep independent loops. Target checks coalesce on paused recovery
and start at most once per second after a target-paused or credential-expiring
failure. Joiners retain their own cancellation/deadline and check their exact
connections after successful shared recovery. A failed shared recovery gives
joiners a transient refusal/backoff too. Binding conflicts do not set a target
pause; these checks remain bounded by caller/native limits and relay backoff,
including Gateway/Agent mismatches reported under that category. A disconnected
caller does not set a target pause. Fresh successful target checks clear the pause. Fixed categories are
`target-paused`, `graph-unavailable`, `credential-expiring` and `binding-conflict`,
coalesced by configured target rather than logging requests or private identities.

## Callback paths

Every target uses `/targets/<id>/v1/deliveries`,
`/targets/<id>/v1/health` and `/targets/<id>/v1/capabilities`, authenticated
with that target's distinct callback bearer. Unprefixed delivery/health/capabilities routes are not registered
in multi-target mode. SSO-enabled registries separately expose the unprefixed
`/v1/task-passes` and `/v1/task-tools/workiq` routes with controller/pass-only
authentication; callback bearers cannot use those routes. Configure each Orka's
callback base accordingly. These are on the shared outbound listener, not the
SDK's `/api/messages` listener. A slot's bearer cannot authorize another slot's
path. Authentication precedes body parsing, readiness and storage; unknown paths
return authenticated 404 without storage access. Delivery bodies cannot select a
slot. The existing 32-active-delivery budget is listener-wide, not per target.

## Standalone Kubernetes transport

`createKubernetesReader` in `src/registry/kubernetes.ts` remains a standalone
library, also used by live admission and per-event relay preflight. It has no
background token-renewal loop. Existing
`getGateway(signal?)`, `getAgent(signal?)` and `listBindings(signal?)` callers
remain supported. Methods also accept `{signal, deadline, allowed}` to borrow a
caller's absolute monotonic deadline and combined authority. At most four native
calls run concurrently; excess calls fail without queuing.

`getBinding(name, context)` reads a fixed namespaced resource (404 means absent).
`createBinding(object, context)` makes one POST of at most 64 KiB to the fixed
Binding collection. Its ACK/conflict/uncertain result is not commit proof; the
[provisioning library](directory.md#binding-provisioning-library) always GETs and
checks the object afterward. It never follows redirects or retries writes.
HTTPS is verified; GET responses are bounded to 1 MiB and requests to ten seconds
or the supplied earlier deadline. Lists stop at 100 pages and 10,000 Bindings.
Continuation values are encoded into the fixed resource path; response URLs
never receive a token. `close()` aborts and drains actual requests.

Before every request (including each list page), it rereads a protected regular JSON
file of at most 16 KiB containing exactly `{ "token": "...", "expiresAt": "..." }`.
Expiry is the issued UTC timestamp, not the requested token lifetime. Operations
stop five minutes before expiry with `credential-expiring`. An unreadable,
malformed, public, expired or missing file fails closed without cached fallback.
An operator atomically replaces it with a privately issued valid token and its
returned expiry; the next read uses the replacement without restart. The reader
cannot issue tokens, change roles or renew access. Endpoint/CA changes still need
a drained restart. No live token issuance, revocation or Teams walk is established
by synthetic tests.
