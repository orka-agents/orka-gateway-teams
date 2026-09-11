# Contributing to the offline Teams starter

This is the offline foundation for [#549](https://github.com/orka-agents/orka/issues/549),
not a deployable adapter. The personal-message converter for
[#550](https://github.com/orka-agents/orka/issues/550) is implemented as `convertActivity`.
The bounded final/error formatter for [#551](https://github.com/orka-agents/orka/issues/551)
is implemented here as `formatDelivery`. A local SQLite delivery journal is also
implemented; there is still no sender or delivery endpoint.
No credentials, Teams registration, sends, or cluster setup are needed.

## Development and checks

Use Node 24 LTS and npm. From the repository root:

```bash
npm ci
npm run check
```

`npm test` runs all runtime tests, including the real converter, formatter, preview
CLI, and temporary-file/child-process journal tests.
For focused tests: `node --import tsx --test test/convert.test.ts` or
`node --import tsx --test test/format.test.ts`.
`npm run typecheck` is also mandatory: `test/contracts.typecheck.ts` checks the
public contracts and callable implementations, including non-message inputs and one-card/no-ordinary-text
constraints, and is not run by the runtime test command. `npm run check` runs
typecheck, runtime tests, and `npm run build`. Build output is in ignored `dist/`; optional preview files belong
in ignored `bin/`. Do not commit binaries, credentials, or generated output.

## Incoming fixture and event identity

`test/fixtures/incoming.ts` contains the executable SDK `MessageActivity`,
`conversionContext`, and this independent expected wire event. It is a synthetic
example; the real converter is tested against this independent expected value:

```json
{
  "protocolVersion": "orka.gateway.v1",
  "externalEventId": "teams:v1:a4e643cbbb0d029bc04f9432b734fd0d0af2e1aa33002e05ef9b74fcc0bc0a98",
  "eventType": "text",
  "accountId": "11111111-1111-4111-8111-111111111111",
  "contextId": "19:fixture-personal",
  "sender": { "id": "29:fixture-person", "displayName": "Example Person" },
  "text": "Summarize this project.\n\nこんにちは 🧑🏽‍💻",
  "replyTarget": "rt_fixture_personal_1"
}
```

The SDK activity has `id: fixture-message-1`, `from.id: 29:fixture-person`,
`conversation.id: 19:fixture-personal`, and `conversation.conversationType: personal`.
The configured tenant, `conversation.tenantId`, and `channelData.tenant.id` all
match `11111111-1111-4111-8111-111111111111`. Its `serviceUrl` is
`https://teams-service.example.invalid/` and stays outside the normalized event.
Personal chats omit `threadId`.

`src/teams/ids.ts` implements this exact event ID formula:

```text
teams:v1: + SHA-256 hex of UTF-8 JSON.stringify(['teams-event-v1', tenantId, conversationId, activityId])
```

The prefix is literal; the hash is lowercase hexadecimal. Preserve identity case
and content. Sender is not part of that event tuple: changing sender under an
existing provider message identity is a conflicting replay, not a new event.
The ID helper hashes already-validated identities; it does not validate raw
activity fields or enforce their bounds. `convertActivity` validates before calling it.

## Exact extension contracts

From `src/teams/convert.ts`:

```ts
import type { Activity } from '@microsoft/teams.api';
import type { EventEnvelope } from '../protocol/types.js';

export interface ConversionContext {
  tenantId: string;
  replyTarget: string;
}

export type ConversionResult =
  | { kind: 'accepted'; event: EventEnvelope }
  | { kind: 'ignored'; reason: 'unsupported-activity' | 'unsupported-conversation' | 'bot-message' | 'empty-text' }
  | { kind: 'invalid'; reason: 'missing-identity' | 'tenant-mismatch' | 'invalid-field' | 'field-too-large' };

export type ConvertActivity = (
  activity: Readonly<Activity>,
  context: Readonly<ConversionContext>,
) => ConversionResult;
```

From `src/teams/format.ts` (the result is the message, not a result union):

```ts
import type { IMessageActivityInput } from '@microsoft/teams.api';
import type { IAdaptiveCard } from '@microsoft/teams.cards';
import type { DeliveryRequest } from '../protocol/types.js';

export const MAX_OUTGOING_MESSAGE_BYTES = 20 * 1024;

export type OutgoingTeamsMessage = IMessageActivityInput & {
  text?: '';
  attachments: [{
    contentType: 'application/vnd.microsoft.card.adaptive';
    content: IAdaptiveCard;
  }];
};

export type FormatDelivery = (delivery: Readonly<DeliveryRequest>) => OutgoingTeamsMessage;
```

The converter exports `convertActivity: ConvertActivity`; see the
[converter usage example](README.md#convert-a-verified-personal-message).
The formatter exports `formatDelivery: FormatDelivery`; use it on an
already-validated `DeliveryRequest`:

```ts
import { formatDelivery } from './src/teams/format.js';
import { finalDelivery } from './test/fixtures/outgoing.js';

const message = formatDelivery(finalDelivery);
```

Conversion must not mutate its activity/context; formatting is deterministic
and does not mutate its already-validated delivery. SDK types are not runtime
validation. In particular, SDK `attachment.content?: any` is not a card typing or
validation boundary: type card content separately as `IAdaptiveCard`, as the
fixtures do, and retain the narrowed `OutgoingTeamsMessage` contract.

| Layer | Owns | Does not own |
|---|---|---|
| #550 converter | supported-type checks, tenant/field validation, stable normalized event | auth, inbox, reply-target creation, network |
| #551 formatter | final/error/empty text, wrapping, Unicode-safe truncation and 20 KiB message budget | destination, auth, send, retry, persistence |
| Delivery journal | durable local claims, immutable identity/alias checks, fenced settlement and receipt replay | auth, routing, provider calls, retries, endpoints |
| Integration caller | request verification, app/tenant enforcement, persisted routing/envelope replay, endpoints and journal-backed sending | asking a converter to create new replay keys |

### Converter acceptance and caller replay

Authenticate the provider request and enforce the intended app and tenant before
conversion. SDK types and transport verification do not validate all activity fields.
The converter requires exact `type: 'message'`, `channelId: 'msteams'` and
`conversation.conversationType: 'personal'`. A supplied `isGroup` must be boolean;
`true` excludes even a contradictory personal conversation. Notifications, joins,
edits/deletes/undeletes and nonpersonal conversations are ignored. Any supplied
nonempty `channelData.eventType` marks an unsupported event, not a new message;
malformed discriminators return `invalid`. Personal `replyToId` is neither an edit
marker nor an output `threadId`.

Missing `from.role` is normal in documented personal-message payloads, as is a
missing `conversation.tenantId`. An otherwise valid role-less message is an eligible
**candidate**, not an attested human message. Explicit `bot`/`skill` roles,
`from.type: 'bot'`, and matching `from.id`/`recipient.id` are excluded. Unknown or
malformed supplied roles are invalid. No display-name, AAD-ID or ID-prefix heuristic
establishes identity or humanity. `sender.id` is exactly `from.id`; Orka's stable-ID
allowlist owns sender authorization. Recipient identity, if supplied, is validated
and compared exactly for self detection. Missing recipient identity is allowed and
is not affirmative human proof; unused recipient metadata is not validated.

At least one of `channelData.tenant.id` and `conversation.tenantId` must be supplied.
Either alone, or both matching, is valid. Every supplied claim is validated and must
exactly equal configured `tenantId`; a matching claim cannot mask another malformed
or conflicting claim. Missing or empty required identities yield `missing-identity`;
supplied wrong types (including null) and malformed fields yield `invalid-field`;
oversized fields yield `field-too-large`; well-formed tenant disagreements yield
`tenant-mismatch`. Errors use only fixed reasons, never raw input or credentials.
Unsupported activities can be ignored before their unused fields are examined.

Required provider IDs (tenant, conversation, activity and sender), tenant claims,
and the opaque reply-target key are nonempty and at most 256 UTF-8 bytes. They are
preserved exactly: no case folding, UUID/prefix grammar, trimming, Unicode
normalization or truncation. Boundary Unicode `White_Space` is rejected so Orka's
normalization cannot change identity. Unlike JavaScript `trim()`, Go whitespace
includes U+0085 (NEL), but not U+FEFF. NEL is also a forbidden Cc control.

An optional display name must be a string of at most 256 UTF-8 bytes **before**
trimming. Validate raw Unicode/controls first, trim boundary `White_Space`, then
omit an empty label. Useful nonempty text is preserved exactly and bounded at
64 KiB UTF-8; missing/empty/`White_Space`-only text is ignored. All consumed strings
must have well-formed Unicode (no lone UTF-16 surrogates) and no Cc controls, with
TAB/LF/CR allowed only in text. Format characters, including ZWJ and FEFF, remain
valid; this is not a blanket category-C rejection.

Only `activity.text` is consumed, even with attachments. Attachment-only messages
are ignored; attachment contents and unrelated metadata are never inspected,
extracted or downloaded. Accepted envelopes contain only the fixed protocol/event
discriminators, stable event ID, account/context/sender, text and reply-target key.
They omit timestamps, metadata, thread IDs, service URLs and conversation references.

The wire discriminator is exactly `orka.gateway.v1`; unknown wire fields are not
forward-compatible extensions. Bounds in `src/protocol/types.ts` are UTF-8 limits:
256 KiB request, 64 KiB text, 256-byte identities, 32 metadata entries with 256-byte
keys/values, and 64 KiB adapter response. Metadata must also be allowed by the
GatewayClass. These types/constants alone do not enforce runtime validation.

The integration caller creates and persists the opaque reply-target key and the
original normalized envelope, then replays both unchanged for redelivery,
including across restart. Do not reconvert a duplicate with refreshed routing,
profile/display-name, occurrence/receipt timestamps, or metadata fields: those
changes can cause Orka HTTP 409 even with the same stable event ID. Persistence
and replay lookup belong to the caller, not the converter. The reply-target key
refers to private routing state; it is not a service URL or credential.

## Outgoing fixture and formatter acceptance

`test/fixtures/outgoing.ts` provides independent synthetic delivery and message
examples. Expected final/error cards remain literal fixtures, not generated by
the formatter; tests compare the real output against them. This is the complete
`finalMessage` JSON:

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "content": {
        "type": "AdaptiveCard",
        "version": "1.4",
        "fallbackText": "Orka reply: Project summary - Review open issues - Run `npm test` こんにちは 🧑🏽‍💻",
        "body": [
          {
            "type": "TextBlock",
            "text": "Orka reply",
            "weight": "Bolder",
            "wrap": true
          },
          {
            "type": "TextBlock",
            "text": "Project summary\n\n- Review open issues\n- Run `npm test`\n\nこんにちは 🧑🏽‍💻",
            "wrap": true
          }
        ]
      }
    }
  ]
}
```

It has one Adaptive Card attachment and no ordinary activity `text`, avoiding a
duplicate plain-text reply. The contract permits absent or empty activity text;
these fixtures omit it. `fallbackText` is a short nonempty summary for hosts that
cannot render the card, not a second activity message. It normalizes whitespace
and is independently bounded to 512 UTF-8 bytes, including an abbreviation suffix
when needed. It preserves whole graphemes even if the first answer grapheme is
too large for this smaller budget.

The same file's `errorDelivery` and `errorMessage` show a generic error with no
task/session references. `DeliveryRequest.taskRef` and `.sessionRef` are optional;
formatting must not depend on their presence or expose internal references.

Measure `Buffer.byteLength(JSON.stringify(message), 'utf8')` against
`MAX_OUTGOING_MESSAGE_BYTES` (20 KiB) for the **entire message**, including attachment
wrappers, card structure, fallback text, and JSON escaping—not just the answer or
card content. This is the adapter's budget, not a claimed Teams maximum.

The formatter keeps fitting nonempty body text unchanged, including leading,
trailing, and interior whitespace. Empty or whitespace-only final text becomes
`Orka finished without a text reply.`; empty error text becomes
`This request could not be completed.` The titles distinguish successful replies
from errors, including generic errors without task/session references.

For oversized text, a measured binary search chooses a fitting grapheme prefix
using built-in `Intl.Segmenter`. Each candidate includes the complete activity,
fixed bounded fallback, and a separate wrapped subtle `Reply shortened to fit the
message limit.` TextBlock. The retained body stays an exact prefix; emoji, ZWJ
sequences, and combining accents are not split. A first grapheme that cannot fit
leaves an empty body plus the readable title and notice. The fallback also signals
shortening, even if whitespace normalization made its own text short enough.
Text is not parsed or re-rendered as Markdown/HTML: host support determines how
Markdown and code text display, and shortening can leave an open Markdown fence.

`test/format.test.ts` exercises these behaviors, exact/just-over message boundaries,
long lines, paragraphs, lists, code, Unicode, JSON escapes, giant graphemes,
independently bounded fallback, deterministic output, and frozen inputs. The
formatter does not copy routing, task/session references, or metadata into cards.

For real formatter card JSON from synthetic deliveries, run:

```bash
npm run --silent preview:card -- final
npm run --silent preview:card -- error
npm run --silent preview:card -- oversized
```

The last selection uses the protocol-bounded multibyte `oversizedDelivery` fixture
to demonstrate actual shortening. Follow the [README preview steps](README.md#card-preview).
The export omits the message envelope; JSON assertions and HTTP access to the
designer do not establish visual rendering. Local card rendering is not live
Teams compatibility validation.

## Delivery journal contract

Import these local types and functions from `src/delivery/journal.ts`:

```ts
import type { DeliveryRequest } from './src/protocol/types.js';

export interface JournalScope { appId: string; tenantId: string }
export interface DeliveryClaim { idempotencyId: string; attemptId: string }
export type TerminalOutcome =
  | { kind: 'delivered'; providerMessageId: string }
  | { kind: 'rejected' }
  | { kind: 'unknown' };
export type DeliveryOutcome = TerminalOutcome | { kind: 'retryable' };
export type BeginDeliveryResult =
  | { kind: 'claimed'; claim: DeliveryClaim }
  | { kind: 'inFlight' }
  | { kind: 'conflict' }
  | TerminalOutcome;
export type SettlementResult = 'recorded' | 'unchanged' | 'stale';
export interface DeliveryJournal {
  begin(request: Readonly<DeliveryRequest>): BeginDeliveryResult;
  settle(claim: Readonly<DeliveryClaim>, outcome: Readonly<DeliveryOutcome>): SettlementResult;
  close(): void;
}
export function initializeDeliveryJournal(path: string, scope: Readonly<JournalScope>): void;
export function openDeliveryJournal(path: string, scope: Readonly<JournalScope>): DeliveryJournal;
```

Use [the runnable synthetic example and operational limits](README.md#local-durable-delivery-journal).
Initialization exclusively provisions a new store; never use it as a fallback for
missing/corrupt storage on startup. Normal open requires the initialized main file
and permanent ownership sidecar. A live owner is acquired **before** main database
validation or recovery. Only then, after brand/schema/integrity/scope/row validation,
are abandoned `sending` records changed to terminal `unknown` in one transaction.
There is no automatic migration, repair, import, lease expiry, pruning or reset.

`begin` validates the consumed known wire shape and hashes a versioned deterministic
encoding with SHA-256. The digest includes app/tenant, protocol version, stable ID,
origin, task/session references, kind, account/context/thread/reply key, complete
text and sorted metadata. `deliveryId` is normalized to `idempotencyId` in that
encoding, allowing a fresh delivery alias for the same immutable logical operation.
Absent/empty metadata and absent/empty thread are equivalent. Removing a reference
or changing useful whitespace, metadata values, Unicode composition or identity
case is significant. Inputs are never mutated and canonical plaintext is never
persisted. The caller still owns validated, immutable request snapshots and
GatewayClass metadata policy; these internal checks are not transport validation.

Both identifiers occupy one unique alias namespace. Resolving either to another
logical stable ID, resolving the two to different operations, or changing the
digest returns `conflict`, not a cached success. Compatible alias insertion and
send reservation are committed atomically; a claim is returned only after COMMIT
succeeds. A locked or failed write cannot leak a claim or partial admission.
One main SQLite connection is used; no provider work occurs in a transaction.

Required identities, scopes, reference components and provider receipts are
nonempty, bounded to 256 UTF-8 bytes and preserved exactly. Boundary Unicode
`White_Space`, Cc controls and lone surrogates are rejected, not repaired. Text
permits empty strings and TAB/LF/CR, with the existing 64 KiB UTF-8 bound. Metadata
permits up to 32 string entries: nonempty identity-like keys and string values of
at most 256 UTF-8 bytes, without Cc controls or lone surrogates. Empty/whitespace
metadata values are preserved. Optional fields must be omitted rather than set to
`undefined` or `null`; explicit empty thread/metadata are supported. Partial refs,
unknown keys, arrays, non-string values and accessor/non-data objects are refused.
This journal neither persists routing references nor authorizes a destination.

| Current state | `begin` | Matching current `settle` |
|---|---|---|
| New operation | Commit `sending`, return fresh claim | — |
| `sending` | `inFlight` | Confirmed receipt → `delivered`; definite no-effect permanent rejection → `rejected`; definite no-effect temporary failure → `ready`; ambiguity → `unknown` |
| `ready` | Commit `sending` with a new attempt | Identical `retryable` → `unchanged`; other result → `stale` |
| `delivered`, `rejected`, `unknown` | Saved terminal outcome | Identical stored result → `unchanged`; any rewrite → `stale` |

An old attempt always returns `stale` after rotation; it cannot overwrite the new
attempt or make a terminal record ready. `settle` returns `recorded` only for a
committed transition. **Only actual proof of no provider effect permits
`retryable`.** A timeout, cancellation, generic 5xx, missing/invalid receipt or
lease expiry is ambiguous, not retry permission. The future sender must prohibit
hidden retries/redirect replay and must not manufacture receipt IDs. The example
and process tests use explicitly synthetic IDs, not observed Teams receipts.

`DeliveryJournalError.code` is one of `invalid-input`, `missing`, `exists`, `busy`,
`scope-mismatch`, `unsupported-schema`, `corrupt`, `unavailable`, or `closed`.
Messages are fixed and never interpolate request values. Native `Error.cause` is
private diagnostic context, not a transport/log payload. Input rejection does not
poison the handle; a database/integrity/file-identity failure does. After such a
failure, close and investigate instead of retrying a provider call. `close` is
idempotent, releases the main handle before the owner and never unlinks files;
methods on a closed object fail without reopening.

Tests use real SQLite files, external SQLite locks and child-process IPC milestones.
SIGKILL after a committed claim recovers `unknown`; SIGKILL after receipt persistence
replays the original synthetic ID. A failed same-process competing open must not
release ownership to another process. Never use ordinary filesystem reads/closes
on a live SQLite main/ownership file in its owning process: this can release POSIX
locks. Privacy-byte checks close journals first. Raw live-file copying/backup is
unsupported; restored or rolled-back history is not duplicate-safe. Filesystem
power-loss guarantees and operator backup discipline are not proved by SIGKILL tests.
No binaries, DB files or production fault-injection hooks belong in the repository.

These are **local domain outcomes**, not V1 delivery responses or an
`idempotentDelivery` capability. The journal blocks ambiguous redrive but cannot
recover a lost Teams receipt or atomically commit SQLite and a remote send.

## Future integration boundaries

These are requirements for later integration, not features of this starter:

- Keep provider request verification enabled and enforce the intended app and
  tenant before calling the converter. Persist durable ingress admission before
  acknowledging provider work; do not rely on an in-memory inbox across restart.
- Use separate directional credentials: adapter-to-Orka ingress and
  Orka-to-adapter requests use different Secrets. Never log credentials or embed
  them in events, Tasks, delivery records, cards, or reply-target keys.
- Configured gateway transport requires HTTPS. Authenticate all adapter endpoints:
  `GET /v1/health`, `GET /v1/capabilities`, and `POST /v1/deliveries`.
  Normalized ingress goes to `POST /api/v1/gateways/{namespace}/{name}/events`;
  durable admission is not task completion. This starter implements none of these.
- Resolve an opaque routing key to persisted private provider routing; do not ask
  the formatter to select destinations or make network calls.
- Integrate the local delivery journal with an authenticated sender. Its aliases
  bind **both** `deliveryId` and `idempotencyId`; confirmed receipt replay returns
  the original provider message correlation without another send. A stable ID or
  process-local map alone is insufficient, and ambiguous outcomes still cannot
  supply a lost provider correlation.
- Account for the 15-second delivery call budget, ten attempts, 24-hour default
  event/delivery expiry, and retention that covers manual retries as well as the
  automatic window (Orka's default terminal retention is 30 days). Do not discard
  deduplication/routing state merely because automatic attempts have ended.
- Teams accepting a send whose response is lost is an unresolved uncertain-send
  case. Recovery needs a provider guarantee or upstream contract decision before
  claiming V1 compatibility or `idempotentDelivery`; this starter advertises no
  capabilities and does not solve that problem.

Keep tenant/account, conversation/context, thread, and sender identities separate.
Sender authorization uses Teams `from.id`, not email, display name, or another user
ID system. `context-sender` is personal deployment policy, not converter code.
Shared `context`/`thread` sessions need later invocation, audience, history, and
membership design. Buzz is an experience reference only: it implies no CLI,
group-chat work, dependency, or existing integration here.

## Frozen protocol references

The starter follows Orka at `0c8ab6fb`:

- [Protocol source](https://github.com/orka-agents/orka/blob/0c8ab6fb/internal/gateway/protocol/types.go)
- [Normative adapter protocol and security contract](https://github.com/orka-agents/orka/blob/0c8ab6fb/docs/development/gateway-protocol-v1.md)

[#549](https://github.com/orka-agents/orka/issues/549) tracks the unfinished broader
gateway. The bounded converter in [#550](https://github.com/orka-agents/orka/issues/550)
and formatter in [#551](https://github.com/orka-agents/orka/issues/551) are implemented;
transport, ingress/routing persistence, journal-backed sending, authentication
and live Teams validation remain future work.
