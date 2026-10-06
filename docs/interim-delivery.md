# Messages while an Orka Task runs

The Teams gateway can deliver bounded progress updates and questions into the
originating personal chat, group chat or channel thread. This is opt-in full-mode
support, **off by default**, not token streaming or an approval/wait/resume API.
Final replies and errors retain their existing meaning and presentation.

## Enable only after the controller supports it

This additive `orka.gateway.v1` extension follows Orka
[`0e567418` protocol](https://github.com/orka-agents/orka/blob/0e567418/docs/development/gateway-protocol-v1.md)
and [ADR 0032](https://github.com/orka-agents/orka/blob/0e567418/docs/adr/0032-gateway-interim-delivery.md).
The older frozen adapter baseline remains the reference for unchanged V1 fields;
it is not the interim-extension reference. **Orka v0.2.0 is final/error-only.**
Older strict controllers reject an unknown capability field, even when false.

1. Follow the Orka operator's supported controller/CRD upgrade and backup procedure
   first. Do not infer database or Helm downgrade safety from this unchanged wire
   discriminator or the adapter's unchanged journal schemas.
2. Keep the gateway setting omitted or `false` during that upgrade. Confirm the
   supporting controller is running and the existing Gateway/Binding are ready.
3. With `OUTBOUND_ENABLED=true`, set the nonsecret environment variable
   `INTERIM_DELIVERY_ENABLED=true` on the normal gateway process. Only exact
   lowercase `true` and `false` are accepted. Omission defaults off; enabled
   configuration without outbound mode is rejected. Init commands do not enable it.
4. This setting is captured at startup: use your deployment's controlled process
   replacement, not a hot toggle. For Table, prove the old owner's actual drain,
   termination and clean release before a successor revision starts; replica count
   or Single revision mode alone is not fencing. Retain the same scope, IDs,
   partitions, routes, receipts and correlation history. **Do not reinitialize,
   reset or select a new store.**
5. Observe the authenticated capability response containing
   `capabilities.interimDelivery: true` and the controller's **current ready
   observation** of that capability before expecting message admission. Local
   listener readiness alone does not prove controller readiness or tool access.

Default deployment assets remain off. Kubernetes operators can add the variable
to their private runtime customization. The ACA renderer retains its fixed,
closed configuration profile: it has no interim JSON option. Add the environment
variable only to the reviewed operator-owned runtime template/container environment
as part of the same clean owner handover; do not apply a revision over a live owner.

Library composition uses `OutboundServerConfig.interimDelivery?: boolean` and
`createDeliveryDispatcher({ ..., interimDelivery?: boolean })`; both validate and
capture the boolean. Standalone users must give the listener and dispatcher the
same setting. `startReceiver` accepts it in its optional outbound composition;
`startIngressRuntime` propagates its validated outbound setting to both. An omitted
or explicit false setting **omits** the capability field entirely and denies new
message sends, while retaining historical receipt replay.

## Tool availability and delivery semantics

On the supporting Orka build, `reply_in_conversation` is a content-only native AI
worker/ACP broker tool for an authenticated gateway-origin Task whose tool and
transaction policies permit it. Native bootstrap must establish durable origin;
ordinary/delegated/container/compatibility-proxy Tasks do not gain the tool merely
from a prompt or gateway flag. ACP freezes policy before session creation: built-in
providers retain their defaults, while external profiles must explicitly include
the tool and match their registered/conformed policy. Existing frozen sessions are
not silently upgraded. Explicit denials and closed tool lists still apply.

Tool success means durable controller admission, **not Teams delivery**. It does
not finish or suspend the Task, write final/canonical Session history, or release
the active Session lock. The controller owns the per-Task lifetime quota (default
10), admission ordering before final/error, abandonment of failed/expired messages,
and prohibition on reviving a message behind later work. The adapter adds no
ordering ledger or active-answer routing.

Messages use the same closed delivery envelope, saved route, alias namespace and
provider receipt semantics as final/error deliveries, with `kind: "message"`.
Raw message text must be nonempty, not whitespace-only (including BOM-only),
well-formed Unicode, and at most **16384 UTF-8 bytes**, not characters. Cc controls
are rejected except TAB/LF/CR. The journal, snapshot and HTTP decoding boundaries
all enforce this bound; oversized input is refused, never silently truncated.
Terminal text remains bounded at 65536 UTF-8 bytes.

After valid input, the formatter measures the **complete 20 KiB JSON activity**,
including escapes, fallback, room attribution, continuation and channel reply root.
It may visibly shorten a valid message to fit, preserving grapheme prefixes. The
body otherwise preserves delivered text exactly. One Adaptive Card is sent, with
no duplicate ordinary activity text; fallback stays within 512 UTF-8 bytes.

Journal history precedes current capability and routing policy. A delivered message
replays its original receipt without sending again, even after final, after the
setting is disabled, or after an allowlist is removed. Changed text/kind under the
same identity conflicts. `inFlight` and uncertain outcomes remain authoritative;
unknown never becomes resend permission. A newly claimed message while disabled
is settled rejected before route lookup, correlation observation or provider work.
The low-level journals accept valid message kinds regardless of the runtime flag;
no schema, fingerprint version, marker, alias or receipt format changes are needed.

## Questions are a presentation convention, not an answer channel

The wire protocol has **no structured question marker**. To request a question
heading, the agent must explicitly begin message content with the case-sensitive
leading prefix `Question: ` (including the space). Such a message is titled
**Orka question**; other messages are titled **Orka update**. The prefix stays in
the delivered body. No metadata field, natural-language classification, question
mark heuristic or special answer semantics is invented. An arbitrary question
without that convention cannot be distinguished from an update by the adapter.

A person answers with a **normal follow-up** in the same chat or channel thread,
using the existing Binding's Session policy. Shared-room follow-ups still need a
bot **@mention** and an allowed sender; channels must keep the same reply root.
With group `context` or channel `thread` session mode and queued active turns, the
follow-up becomes the **next Task in the same Session**, queued while the current
Task runs. It is not injected into the running Task and does not resume a suspended
execution. The interim question itself is absent from canonical Session history,
so a next Task is not guaranteed to see it; the person should include enough
context in the follow-up. Room continuation wording remains only adapter-local
prior-origin evidence, not proof of answer delivery or history.

Routing a correlated answer to an active Task, recording question context in
canonical history, or defining a wait/resume lifecycle needs an Orka protocol and
execution-lifecycle change. There is no gateway workaround using approvals,
synthetic final replies, new wire fields, polling or a second answer queue.

## Disable and roll back safely

Pause new work first. **Settle or abandon outstanding message deliveries using the
supporting controller before disabling or rolling back**. Then set
`INTERIM_DELIVERY_ENABLED=false` (or omit it) through a clean gateway owner
handover, and confirm the field is omitted and the controller observes the current
capability withdrawal. Historical message receipts still replay. Disabling the
advertisement alone does not make retained pending message rows safe for an old
dispatcher: **never run an old dispatcher with pending messages**.

Only afterward consider an older controller, subject to its own CRD/database
rollback rules. Preserve adapter journals/routes/ownership and the Orka dedup
ledger; unchanged schemas do not prove behavioral downgrade safety. Shared-route
and correlation-reader rollback constraints also still apply; see
[shared rooms](shared-rooms.md#rollout-and-rollback) and
[Table owner handover](table-runtime.md#operational-and-verification-boundary).

## Verification boundaries

Synthetic tests cover exact/over-byte bounds, Unicode, unchanged terminal fixtures
and fingerprints, SQLite/Table aliases and fresh-handle receipt replay, HTTP
advertisement omission/enabling, selected runtimes on/off and shared-room evidence.
They do not prove live Teams rendering, tenant tool policy or controller readiness.

### Local controller and conformance qualification

The adapter was exercised against Orka main at
`0e567418ae20b4a11b5684eb42da47c1cdf1c92e` in a disposable kind cluster,
with controller/publisher images pinned by digest. A deterministic native worker
executed the production reply tool using its controller-created Pod identity.
The enabled case delivered an interim receipt while the Task remained Running,
replayed the tool call without another send, and then delivered final. The
unsupported-capability case delivered final only. Full conformance against this
adapter passed in both modes: three synthetic provider effects when enabled,
one when disabled, with duplicates suppressed.

The adapter used its real converter, runtime, SQLite stores and outbound API;
provider transport used the existing trusted library fixture seam. This is not
live Teams, a model-driven worker, live ACP execution, Table power-loss proof or
NetworkPolicy-enforcement qualification. Container acceptance and selected Table
runtime tests provide separate synthetic evidence. The owned cluster and local
registry were deleted after verification.

The pinned Orka full conformance checker probes messages **only when advertised**:
two distinct messages, duplicate receipt, final/duplicate, post-final message
replay, and an oversized-message rejection. It sends no message probes when off.
A private `--delivery-fixture` must use authorized retained routing for an event
not already terminal; with support on, one run can produce **three visible sends**.
Do not use `--reference-fixtures`, fake routing, weakened auth or live destinations
without approval. Readiness probes remain non-mutating. Conformance, container,
kind and live rollout results must be recorded separately from local tests.
