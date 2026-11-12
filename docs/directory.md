# Connection directory

The directory is a separate Azure Table storage domain for personal and group
chat connections and control replies. It is not an inbox, a delivery journal or
a third V3 kernel domain. The storage library does not start a listener, admit an
Orka Task or send a Teams message. The separate provisioning library below can
create and check Bindings, but is not wired into serving yet.

## Identity and permanent choice

Connections are keyed by authenticated app, tenant and **exact** conversation ID.
Do not trim, case-fold or strip a context suffix. Channels stay on their existing
operator-bound path and must not enter this directory's command parser.

After mention removal, `parseUseCommand` trims outer whitespace and recognizes
only a whole message of the form `use <targetId>`, with one ASCII space and a
lowercase target ID. Extra arguments, uppercase IDs and punctuation are not that
command. The handler must still distinguish unknown/ineligible target IDs and
return the generic no-access outcome; parsing grants no access.

The first successful conditional connection reservation fixes its target ID,
routing identity digest and deterministic Binding name. A same-target retry may
resume monotonic provisioning. Another target or a changed routing digest cannot
replace the choice. There is no switch, unbind, deletion or history-migration API.
A reserved row is not a ready connection; a provisioned row is progress evidence,
not current Binding readiness or permission to forward.

## Control receipts and uncertainty

Discovery and no-access replies need a route and reservation even before there
is a connection. These live in the directory, never in an arbitrary target's
inbox. A receipt records a bounded typed reply descriptor, minimal authenticated
Teams route, activity identity and replay fingerprint. It does not retain input
message text, credentials, a group roster or target endpoints. A digest of input
content still permits guessing low-entropy inputs; storage access must remain
restricted. No retention sweep or rollback to an older reader is promised.

Control sends follow these durable states:

```text
ready -> armed -> delivered | rejected | unknown
           |
           +-> ready  (proved no remote effect only)
```

Each arm records a fresh attempt ID and owner ID. Settlement is conditional on
that exact attempt. A successful Table write response is not enough: exact
readback establishes the saved result. A handed-off send without a valid receipt
is unknown and cannot be automatically repeated. Connection truth survives a
lost notification.

Before allowing sends, opening the directory converts inherited armed attempts
to terminal unknown. A foreign-owner arm found later is treated the same way.
Late old-owner receipts cannot reverse that terminal result. Recovery traverses
bounded pages; malformed rows, repeated continuations, exhausted budgets or a
failed page leave opening incomplete. This is not a general message queue or a
replacement for actual prior-owner termination and drain.

## Caller obligations

The live runtime must authenticate the Teams request and validate its exact
app, tenant, recipient, conversation and service route before directory access.
It must resolve current Graph policy before any new connection or control-send
effect, including duplicate commands and same-target choices. A saved receipt
never restores revoked access or authorizes displaying formerly eligible targets.
Only eligible target IDs and labels may enter a discovery descriptor.

Build control fingerprints with `controlFingerprint(scope, conversationId,
activityId, senderId, text, desiredTargetDigest)` from the validated converter
text, before command parsing. It binds exact scope, sender, content and desired
target; do not substitute a hash of only the command kind or only its text.

Pass a finite monotonic deadline, cancellation signal and combined V3 authority
at the library boundary. Recheck authority after awaited work and immediately
before remote handoff. The directory's conditional write cannot fence a Teams
POST. Drain actual identity work, native requests and sockets before releasing
stores or the shared storage token provider. Directory integrity failure must
make the combined process unready; a Graph or target outage must not poison
healthy storage.

The transport permits at most four concurrent operations and uses fixed,
verified Azure Table HTTPS destinations. A write and its confirming readback
are separate operations. If local saturation interrupts an arm's readback,
that activity can remain armed until restart and then become unknown without
being sent; a fresh activity can ask again. Live integration should bound whole
directory operations to avoid this contention. A terminal old-owner receipt
racing startup recovery can make opening fail once; retrying opening preserves
the terminal result. It does not follow redirects or remote
pagination URLs. The runtime must budget these callers alongside all 2N V3
domains when it lends the existing storage token provider.

## Binding provisioning library

`createBindingProvisioner(target, client)` in `src/directory/provision.ts` consumes
an already-reserved connection and the registered target's confined Kubernetes
client. `reconcile(connection, context)` returns current `BindingEvidence`;
the caller then uses `markProvisioned`. `check(connection, context)` requires a
provisioned row and never creates anything. Neither method reserves a choice,
changes a row, starts a Task or sends a notification. Serving does not call either
method yet; self-service still requires live integration.

New Bindings use the existing deterministic `bindingName` helper, exact tenant
and conversation, the registered Gateway/front Agent, priority zero, all senders,
and personal `context-sender` or group `context` Session mode. Ownership markers
are `gateway.orka.ai/teams-target-digest` (the routing digest) and
`gateway.orka.ai/teams-gateway-uid` (the registered Gateway UID). No ownerReference,
patch or delete is used. Imported rows instead pin their saved UID, generation
and complete spec, preserving sender, Session, priority and retry settings without
adding ownership markers.

Every operation checks the current Gateway UID and front Agent name/namespace,
and lists all Bindings for that exact Gateway/account/context, including unready
or sender/thread-restricted overlaps. A foreign overlap is a conflict regardless
of priority. An absent reserved Binding permits one deterministic POST; success,
409 and lost responses all require GET readback and exact spec/ownership checks.
A missing or changed provisioned Binding is never recreated or adopted.

Gateway and Binding readiness require `status.ready: true` and top-level
`status.observedGeneration` equal to `metadata.generation`, as defined by Orka's
Gateway API at `b136a20ed57cf2bfe2ac0a34e5886e14a918beb4`. Reconciliation waits
for readiness with cancellable reads within the caller's original deadline, at
most ten seconds. Before returning, it repeats overlap and Gateway checks.
A later `check` performs fresh checks rather than trusting saved progress.

The caller supplies cancellation, an absolute monotonic deadline and combined
lease authority, owns client close/drain, and rechecks authority before publishing
connection readiness or forwarding. A late received create can leave an unused
deterministic Binding; cancellation cannot undo it. Fixed failures are
`target-paused`, `binding-conflict` or `credential-expiring`; live HTTP mapping,
coalesced/rate-limited recovery and operator diagnostics remain caller work.

Checks are not atomic with Orka ingress or other Binding writers. While serving,
only this provisioner may write the registered Gateway's Bindings; operators must
stop and drain before routing edits. Synthetic HTTPS tests do not establish real
RBAC, controller reconciliation, concurrent-writer safety or a Teams walk.

## Offline legacy import

An import is an operator procedure while serving is **stopped and drained**.
The importer cannot prove that a different process or host has stopped. A lease
timeout alone does not permit mixed routing configurations.

Use a separately precreated directory table in the same storage account. Never
reuse the target inbox/delivery table. Table creation, identity/role changes and
Azure deployment are operator actions, not importer side effects.

Run after building, with the normal protected registry/storage environment:

```sh
TABLE_DIRECTORY_TABLE=ConnectionDirectory node dist/directory/main.js import /protected/reviewed-export.json
```

The command writes only a fixed success line to stdout. Invalid configuration,
conflicts or incomplete work produce a fixed diagnostic on stderr and a nonzero
exit status. Each invocation has a 30-second total budget. Point reads and
confirmation are serial, so the format's 1,000-entry ceiling is not a throughput
promise. Split a large reviewed export into smaller disjoint batches if it
cannot finish preflight within that budget; keep each row's import ID stable.
A batch that inserted a valid prefix can be rerun idempotently.
SIGINT/SIGTERM cancels and drains work; a failed/partial import can be rerun. No input prompt, Kubernetes call or automatic table creation occurs.

The export is a JSON object with `schemaVersion: 1` and a nonempty `connections`
array (at most 1,000 entries, entire file at most 256 KiB). Each entry has exactly
`appId`, `tenantId`, `conversationId`, `chatKind`, `targetId`, `identityDigest`,
`importId` and `binding`. The latter contains exactly `namespace`, `name`, `uid`,
`generation` and the complete Kubernetes `spec`. `chatKind` is `personal` or
`groupChat`; `importId` is the operator's stable export-lineage identifier, not
a provisioner ownership marker. Obtain the routing digest from the validated
registry snapshot, not by guessing it.

The export identifies each personal/group chat by app, tenant and exact context,
and includes its registered target ID/routing digest, Binding namespace, name,
UID, generation, full spec and import lineage. Validate the entire document and
preflight existing rows before inserting anything. Duplicate chat identities,
wrong targets, mismatched Gateway/account/context or conflicting existing rows
must fail without replacement. Byte-equivalent canonical rows are idempotent.
A concurrent conflict can leave a valid imported prefix; rerunning reconciles
that prefix and never overwrites it.

Imported lineage is distinct from provisioner ownership. Preserve the full
existing sender/session/priority rules, including negative priorities. Do not
fabricate a provisioner marker on an existing Kubernetes object. Before use, the
live runtime must GET and compare its UID/spec, current observed-generation
readiness and overlaps. A saved import is not that check.

Run the compiled importer only in the approved IMDS or Azure Container Apps
identity environment with access to the existing protected registry and
credential files. Registry parsing requires the normal registry/storage
configuration and referenced ingress/callback files; this is not a workstation
login flow. No real credentials are needed for the synthetic tests.

The subsequent live integration owns current-policy handler wiring, directory
startup/drain, calling the Binding provisioner, recurring relay readiness/overlap
checks, transient HTTP outcome mapping, and actual control sends
through the shared confined Teams sender. The directory library alone does not
make self-service connection available.
