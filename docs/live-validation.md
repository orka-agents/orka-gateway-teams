# Live validation and V1 closeout

## Recorded personal-chat result — 2026-09-16

The operator and an allowed human completed the actual path:

**personal Teams message → ACA/Table V2 gateway → Orka Task → Codex through private
Vekil → Teams reply**.

- Gateway source: [`0715d9a`](https://github.com/orka-agents/orka-gateway-teams/commit/0715d9aaabf6d4680ff2c43ac52b6c93bbe1e7bf).
- Evaluated Orka source: [`97df4ea`](https://github.com/orka-agents/orka/commit/97df4eae54615ac8853de55a7a5dc77a6f2d1f1b).
- Both logical Table stores were initialized once through the real CLI, then
  opened by normal `serve`. Native ACA storage and bot federation were used.
- The installed personal app's authenticated capture was privately retrieved and
  human-confirmed. The Binding authorized only that sender and conversation.
- Orka Gateway `Ready`/`Connected` and GatewayBinding `Ready` were observed.
- The provider's health/readiness and model catalog succeeded. The Agent was
  configured for real `codex` execution with `gpt-5.5`, not a deterministic fixture.
- The first Task's phase, execution state and execution outcome were `Succeeded`;
  its actual ACP pool/session references were observed. The human confirmed the
  reply arrived in the same Teams chat.
- A follow-up Task also succeeded. Both Tasks had the **same Orka
  `spec.sessionRef.name`** and runtime-session identity; the human confirmed that
  the follow-up answer used the earlier request.

This report intentionally omits live tenant/app/person/conversation IDs, private
endpoints, challenges, prompts/replies, credentials and raw logs. Private operator
records retain correlation evidence. An attempted admin delivery-record read
returned `401`; its port-forward was closed and no authorization bypass was used.
Thus delivery is **human-confirmed**, not an independent admin-API receipt audit.

See [the reproducible ACA profile](aca-deployment.md) for installation, capture,
initialization, credential metadata, transitions and operator cleanup boundaries.
The live deployment was not restarted or reinitialized for this closeout.

## Existing acceptance evidence

[#549](https://github.com/orka-agents/orka/issues/549) remains the tracking issue.
[#550](https://github.com/orka-agents/orka/issues/550) and
[#551](https://github.com/orka-agents/orka/issues/551) are closed and their converter
and formatter are connected to the runtime. [Contributor instructions](../CONTRIBUTING.md)
name the APIs, paths and commands.

| Requirement | Evidence and boundary |
| --- | --- |
| Allowed personal request, final card, conversation continuity | Live flow above, including the follow-up and shared Orka Session |
| App/tenant verification, unsupported activity handling, no unauthorized Task | Existing registered-SDK/converter/ingress tests and Orka sender-policy tests; not a new live tenant/sender matrix |
| Durable inbound replay and completed/concurrent delivery replay | Existing journal, Table and compiled CLI/container tests, including restart fixtures; not a claim of live crash recovery |
| Temporary/permanent/uncertain send outcomes | Existing delivery state-machine, native sender and drain/ownership tests; uncertain sends suppress unsafe retry rather than claiming remote exactly-once |
| Setup/installation and live smoke documentation | Existing guides plus the ACA runbook and this sanitized report |
| Full stock gateway conformance CLI | **Executed, but not passing: fixture routing incompatibility below** |

Baseline `npm run check` on the evaluated gateway source passed **3712 tests**, type
checking and build. The previously completed container gate used synthetic native
services; those results are not substitutes for live delivery, recovery or HA.
New deployment/packaging tests validate the operator tooling, not Azure service
atomicity or production availability.

## Outstanding stock conformance result

The evaluated Orka `cmd/orka-gateway-conformance` was built from the source above
and run once in AKS against the real main gateway HTTPS origin. Its bearer came
from the outbound Secret via environment reference. TLS and the approved source-IP
restriction remained enabled, retries were zero, and **`--reference-fixtures`
was not used**. No gateway restart, store reinitialization or routing relaxation
was performed.

Actual result:

```text
exit code: 1
Passed: false
Message: delivery probe returned HTTP 400
```

The default CLI hardcodes `accountId`, `contextId` and `replyTarget` to
`"conformance"`. The Teams gateway requires its configured tenant and a retained
reply route; it correctly rejects this fake tenant before dispatch. At this source
version, the observed result means the preceding authenticated health/capability,
missing/bad-auth and oversized-request checks completed, but the first positive
idempotency delivery did not. The duplicate-delivery check was **not reached**.

Code-path inspection establishes that these rejected requests do not admit a
journal delivery or send a Teams message. Do not generalize that safety claim to
a modified payload with real routing information: positive delivery checks can
write records and send messages, and require explicit effect approval.

**Do not mark full conformance as passed or close #549 on this result.** Closing
that criterion requires an agreed way for the checker to use an authorized,
retained fixture route (or another explicitly agreed conformance contract), then
a successful run. This deployment/documentation change does not alter the core
checker, add a fake-route fallback, or relax adapter authentication.

## Not established by this evaluation

No new claims are made about HA, crash recovery, stale-owner takeover, large-store
capacity, a failure/restart matrix, corporate policy portability, or production
hardening parity. Table ownership remains fail-closed and non-expiring. Deployment
single-replica settings, cleanup attempts and timeouts do not grant release or
termination authority. Cloud resources remain billable until explicitly stopped;
operator-deferred shutdown is not a stopped-cluster result.
