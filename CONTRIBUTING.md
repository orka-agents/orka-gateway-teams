# Contributing to the offline Teams starter

This is the offline foundation for [#549](https://github.com/orka-agents/orka/issues/549),
not a deployable adapter. The converter belongs to
[#550](https://github.com/orka-agents/orka/issues/550) and the formatter to
[#551](https://github.com/orka-agents/orka/issues/551). Neither is implemented here.
No credentials, Teams registration, sends, or cluster setup are needed.

## Development and checks

Use Node 24 LTS and npm. From the repository root:

```bash
npm ci
npm run check
```

`npm test` is the child issues' test command. `npm run typecheck` is also mandatory:
`test/contracts.typecheck.ts` checks the type-only contracts and is not run by the
runtime test command. `npm run check` runs typecheck, runtime tests, and
`npm run build`. Build output is in ignored `dist/`; optional preview files belong
in ignored `bin/`. Do not commit binaries, credentials, or generated output.

## Incoming fixture and event identity

`test/fixtures/incoming.ts` contains the executable SDK `MessageActivity`,
`conversionContext`, and this independent expected wire event. It is a synthetic
example, not output from a converter implementation:

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
activity fields or enforce their bounds. That validation remains #550's work.

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

These are callable type signatures, not exported callable implementations.
Conversion must not mutate its activity/context; formatting must be deterministic
and must not mutate its already-validated delivery. SDK types are not runtime
validation. In particular, SDK `attachment.content?: any` is not a card typing or
validation boundary: type card content separately as `IAdaptiveCard`, as the
fixtures do, and retain the narrowed `OutgoingTeamsMessage` contract.

| Layer | Owns | Does not own |
|---|---|---|
| #550 converter | supported-type checks, tenant/field validation, stable normalized event | auth, inbox, reply-target creation, network |
| #551 formatter | final/error/empty text, wrapping, Unicode-safe truncation and 20 KiB message budget | destination, auth, send, retry, persistence |
| Integration caller | request verification, app/tenant enforcement, persisted routing/envelope replay, endpoints and delivery ledger | asking a converter to create new replay keys |

### Converter acceptance and caller replay

Authenticate transport before conversion, but transport verification does not
validate all activity fields. #550 must ignore typing, edits/deletes, bot messages,
unsupported conversations, and empty text. Use attachment text only; do not download
attachments. Missing, wrong, or oversized fields return a safe `invalid` result
using the declared reasons, without exposing raw input or credentials.

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
examples, not formatter results. This is the complete `finalMessage` JSON:

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "content": {
        "type": "AdaptiveCard",
        "version": "1.4",
        "fallbackText": "Orka reply: project summary.",
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
cannot render the card, not a second activity message.

The same file's `errorDelivery` and `errorMessage` show a generic error with no
task/session references. `DeliveryRequest.taskRef` and `.sessionRef` are optional;
formatting must not depend on their presence or expose internal references.

Measure `Buffer.byteLength(JSON.stringify(message), 'utf8')` against
`MAX_OUTGOING_MESSAGE_BYTES` (20 KiB) for the **entire message**, including attachment
wrappers, card structure, fallback text, and JSON escaping—not just the answer or
card content. The existing fixtures are bounded examples, not a truncation
implementation.

#551 acceptance tests must cover empty final/error text, long lines, paragraphs,
lists, code, emoji, non-English text, escape-heavy JSON, and many multibyte
characters. Require deterministic non-mutating output, wrapped text, Unicode-safe
truncation with visible shortening, and the full serialized 20 KiB bound. These
are child acceptance criteria, not tests this starter claims to implement.

For fixture-only card JSON, run `npm run --silent preview:card -- final` or
`npm run --silent preview:card -- error`. Follow the [README preview steps](README.md#card-preview).
The export omits the message envelope; JSON assertions and HTTP access to the
designer do not establish visual rendering or live Teams compatibility.

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
- Maintain a durable delivery ledger idempotent by **either** `deliveryId` or
  `idempotencyId`. A replay must return the original provider message correlation
  without another send. A stable ID or process-local map alone is insufficient.
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

[#549](https://github.com/orka-agents/orka/issues/549) tracks the broader gateway;
[#550](https://github.com/orka-agents/orka/issues/550) and
[#551](https://github.com/orka-agents/orka/issues/551) own the next implementations.
This starter does not close any of those issues.
