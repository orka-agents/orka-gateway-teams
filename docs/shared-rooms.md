# Shared Teams rooms

The runtime accepts explicitly invoked text requests in `groupChat` and `channel`
conversations and returns **final replies or errors** as one Adaptive Card.
[Bounded interim updates/questions](interim-delivery.md) are separately opt-in and
require a supporting controller. No token streaming, active-Task answer routing,
approval buttons, files or attachment extraction is provided. Existing personal
chats and their sender identities remain unchanged.

## Installation and authorization

Before enabling shared intake, obtain tenant/app installation authority, enable
the bot's Teams channel and install the reviewed app in the intended group/team.
The optional [shared-room app package](aca-deployment.md#opt-in-shared-room-package-packaging-only)
uses personal/groupChat/team scopes without RSC permissions. The default package
and setup challenge remain personal-only; setup does not discover or authorize
shared room membership. Installation is not sender authorization. Do not alter
tenant policies or request RSC/Graph access as a workaround.

Use exact operator-reviewed tenant, conversation, bot recipient and service URL
values. Orka owns authorization: use `senderPolicy.mode: allowlist` with explicit
pilot AAD object IDs, **never `all`**. A group or thread Session deliberately
shares the Agent's conversation among allowed participants. Review audience,
Agent access and retained history before opening intake; the adapter does not
check membership, attest humanity or supply a history-management policy.

Shared activities must contain a bounded mention entity targeting the validated
incoming `recipient.id`, with exact mention text present in the message. Only the
bot's mention text is removed; other participants' mentions remain. Missing bot
mentions are ignored. Malformed, overlapping or contradictory mention evidence
is refused rather than guessed.

## Identity and thread mapping

| Teams input | Normalized event / retained route |
| --- | --- |
| Tenant claims | `accountId`, exact configured tenant |
| Exact `conversation.id` | `contextId` and retained send destination, without rewriting |
| Personal `from.id` | Personal `sender.id`, unchanged |
| Shared `from.aadObjectId` | Shared `sender.id` and saved requester ID |
| Validated `from.name` | Optional saved requester label, not authorization |
| Channel root | `threadId` and measured outbound activity `replyToId` |

Existing personal bindings **do not migrate** to AAD IDs. A shared binding uses
AAD object IDs, not `from.id`, display names or email addresses.

For channels, a terminal `;messageid=<root>` suffix in `conversation.id` supplies
the root; an explicit `replyToId` must match it. Without that suffix, a supplied
`replyToId` is the root, otherwise the new root activity's own `activity.id` is
used. Empty/malformed roots, multiple/nonterminal suffixes and disagreements are
refused. `channelData.channel.id` is neither the conversation nor a guessed root.
Group chats omit `threadId`, regardless of personal-style reply metadata.

The **whole exact conversation ID**, even when thread-scoped, remains the context
and URL input. The gateway sends one verified HTTPS POST to
`/v3/conversations/{encoded exact conversation.id}/activities`, with
`body.replyToId` equal to the saved channel root. This matches the pinned Teams
SDK's `ConversationActivityClient.reply`; there is no alternate endpoint,
channel-wide rewrite, activity-ID injection, hidden normalization or retry.

### Synthetic Binding examples

These are non-live examples for an existing Gateway/Agent. Replace every identity
with independently verified values and inspect the installed Orka CRD before
applying. Do not create overlapping bindings or infer wildcard room matching.

```yaml
apiVersion: gateway.orka.ai/v1alpha1
kind: GatewayBinding
metadata:
  name: teams-pilot-group
  namespace: orka-system
spec:
  gatewayRef: {name: teams}
  agentRef: {name: pilot-agent}
  match:
    accountId: 11111111-1111-4111-8111-111111111111
    contextId: "19:synthetic-pilot-group"
  senderPolicy:
    mode: allowlist
    allowedSenderIds:
      - 33333333-3333-4333-8333-333333333333
      - 44444444-4444-4444-8444-444444444444
  session: {mode: context}
  activeTurnBehavior: queue
---
apiVersion: gateway.orka.ai/v1alpha1
kind: GatewayBinding
metadata:
  name: teams-pilot-thread
  namespace: orka-system
spec:
  gatewayRef: {name: teams}
  agentRef: {name: pilot-agent}
  match:
    accountId: 11111111-1111-4111-8111-111111111111
    contextId: "19:synthetic-pilot-channel@thread.skype;messageid=synthetic-root"
    threadId: synthetic-root
  senderPolicy:
    mode: allowlist
    allowedSenderIds:
      - 33333333-3333-4333-8333-333333333333
      - 44444444-4444-4444-8444-444444444444
  session: {mode: thread}
  activeTurnBehavior: queue
```

A thread-session Binding requires the Gateway to advertise the adapter's
`threads: true`; the GatewayClass may additionally require that capability.
`explicitSessions` stays false. The example thread binding is
for **one exact context/root**, not all threads in a channel. Orka derives the
Session and queues normal follow-ups; a message does not resume a running Task.

## Requester and continuation presentation

A shared card says `Asked by <saved label>`, escaping Markdown metacharacters so
the name cannot become a link or emphasis. Without a name it says
`Asked by an allowed participant`. Provider/AAD requester IDs are not printed.
The winning per-event route supplies the label, not the latest room participant.
The optional formatter context is adapter-local; it does not change the V1
request, text, metadata, journal fingerprints or receipts. The complete activity,
including labels, continuation and `replyToId`, stays within 20 KiB UTF-8 JSON;
fallback is at most 512 bytes and truncation preserves grapheme prefixes.

`Continuing the room's conversation` means only that this adapter has previously
observed a **different `originatingEventId` for the same scoped `sessionRef`**.
Scope includes app, tenant/account, exact room/context, normalized thread and
Session namespace/name. It is not an authoritative Session incarnation, turn
count, successful display, Task completion or assertion about Orka history.
Neither sender changes nor event counts nor room context alone establish it.
Missing `sessionRef` or correlation storage yields no continuation wording.

One immutable first-origin record is retained per scoped Session. Repeating that
first origin remains non-continuation even after another origin was observed.
A fresh authorized delivery observes locally before token/provider work; later
token failure or cancellation can leave evidence without a displayed card.
Durable terminal/alias receipt replay precedes **any** route/policy/correlation
read and never observes again.

Correlation records contain SHA256 identifier digests only, never message text,
labels, tokens or credentials. Deterministic digests are equality projections,
not encryption/anonymization. Records are retained indefinitely, with no pruning,
expiry, migration, repair or reset. The hard ceiling is **100000 scoped Sessions**
per store; libraries may lower it for tests, never raise it. At capacity, new
Sessions backpressure as `retryableError` before provider send; existing Session
observations and receipt replay still work. Existing Table audit/page/byte/time
budgets can limit operational capacity earlier; small tests do not qualify
100000-record startup/RSS or power-loss behavior.

## Optional SQLite evidence store

SQLite rooms remain operational without continuation wording when `CORRELATION_DB`
is omitted or its configured main file has not been provisioned. This safe absence
is not inferred session continuity. Ingress-only needs no correlation store.
Table V2 uses the existing delivery journal's separate observation port and
partition: no extra Table store, credential, token provider or partition.
Table mode rejects `CORRELATION_DB` instead of ignoring it.

To enable SQLite continuation wording, first disable intake/delivery and drain every owner.
Provision a **new separate** path in an existing private directory, using only
nonsecret `TEAMS_APP_ID`, `TEAMS_TENANT_ID`, and `CORRELATION_DB` configuration:

```sh
node dist/ingress/main.js init-correlation
```

Then configure the same absolute `CORRELATION_DB` alongside full-mode
`DELIVERY_DB` and `INGRESS_DB`. Serve **never initializes** a main file or permanent
`<CORRELATION_DB>.owner.sqlite`. Mount/provision these files on the same qualified
private persistent storage with current UID ownership and preserve their SQLite
sidecars. Kubernetes's existing initializer Job does not provision this optional
store: supply a separately reviewed explicit provisioning/mount customization;
do not add an automatic Deployment initializer or broaden permissions.

Path preflight checks names, canonical aliases and existing inodes across all
configured databases, ownership files, SQLite sidecars and credential files
before acquiring any live SQLite owner. An existing corrupt, busy, unsupported,
foreign-scope or incompletely provisioned correlation store fails startup with a
fixed safe category; it never silently degrades to missing evidence. The sidecar
opens/audits before live inbox/journal ownership and before listeners. This new,
pre-release sidecar requires the exact current schema, including a strict
`WITHOUT ROWID` sessions table and immutable-key insertion guards. Earlier
provisional sidecars are rejected as corrupt, without migration or repair;
existing inbox and delivery journal schemas remain unchanged. Runtime
shutdown drains observations, receiver/API, token/provider and relay work before
closing all stores, attempting every close even if another fails. Never inspect
live SQLite bytes with an ordinary descriptor in the owning process.

## Rollout and rollback

Disable shared bindings/intake and drain before any rollout or downgrade. Retain
receipts, routes, ownership and correlation history; do not delete/reset records
to make an older binary start. No migration or rewriting of old data is needed:
old personal journal schemas/fingerprints/receipts remain valid.

An older SQLite runtime ignores the independent correlation sidecar when it is
not configured, but **cannot read newly persisted shared routes**. Keep an
upgraded reader if historical mixed stores remain. Sidecar independence is not a
safe binary-only rollback of the inbox.

Older Table adapters reject unknown `control_session:` records and shared routes
at startup/audit. They fail closed and may require tested operator recovery
because ownership is non-expiring. **Binary-only rollback is unsafe once new
session records or shared routes have committed.** No invented cleanup/deletion
workflow makes that safe. Preserve the upgraded reader and use the documented
[Table ownership/handover rules](table-runtime.md#operational-and-verification-boundary).

Synthetic tests cover SDK-authenticated shared intake, actual native HTTPS thread
bodies, bounded cards, SQLite/Table observation, alias replay and clean restart.
They do not establish live group/channel installation, tenant permission,
provider rendering, conformance or power-loss qualification. Existing
[live evidence](live-validation.md) is personal-chat evidence only.

Mapping reference: Microsoft's [channel and group conversations](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations).
