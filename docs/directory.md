# Connection directory

The directory is a separate Azure Table storage domain for personal and group
chat connections and control replies. It is not an inbox, a delivery journal or
a third V3 kernel domain. The storage library does not start a listener, admit an
Orka Task or send a Teams message. The separate provisioning library below can
create and check Bindings, but is not wired into serving yet.

## Identity and permanent choice

Connections are keyed by authenticated app, tenant and **exact** conversation ID.
Do not trim, case-fold or strip a context suffix. Channels are unsupported in multi-target mode and do not enter this
directory's command parser.

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
patch or delete is used. Every connection uses a deterministic name and requires
these ownership markers; there is no offline import or foreign-Binding adoption.

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

## Live integration

The subsequent live integration owns current-policy handler wiring, directory
startup/drain, calling the Binding provisioner, recurring relay readiness/overlap
checks, transient HTTP outcome mapping, and actual control sends
through the shared confined Teams sender. The directory library alone does not
make self-service connection available.
