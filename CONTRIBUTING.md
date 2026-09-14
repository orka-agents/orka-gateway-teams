# Contributing to the Teams gateway

This is the runnable personal-message request/reply runtime for
[#549](https://github.com/orka-agents/orka/issues/549), with ingress-only mode still
available. `convertActivity` ([#550](https://github.com/orka-agents/orka/issues/550)),
`formatDelivery` ([#551](https://github.com/orka-agents/orka/issues/551)), the separate
delivery journal, SDK-authenticated raw receiver, durable inbox/routes, HTTPS
Orka relay and opt-in authenticated V1 Teams sending are implemented.
No live credentials, Teams registration, provider sends or cluster setup are
needed for development/tests. Running serve requires explicit configured bot credentials
(default client secret, an approved private certificate pair, or explicit managed-identity
federation) and directional Orka secrets;
see [configuration and provisioning](README.md#run-durable-ingress).

## Development and checks

Use Node 24 LTS and npm. From the repository root:

```bash
npm ci
npm run check
```

`npm test` runs all runtime tests, including the real converter, formatter, preview
CLI, temporary-file/child-process journal tests, and real HTTP/RSA/JWKS/SQLite/HTTPS
ingress/outbound tests, including registered-SDK input through V1 reply and durable
receipt replay. OpenSSL is required for independent ephemeral synthetic app-auth
and TLS certificate fixtures;
private keys are never checked in or printed. Tests do not call live Teams/Orka.
For focused tests: `node --import tsx --test test/convert.test.ts` or
`node --import tsx --test test/format.test.ts`.
`npm run typecheck` is also mandatory: `test/contracts.typecheck.ts` checks the
public contracts and callable implementations, including non-message inputs and one-card/no-ordinary-text
constraints, and is not run by the runtime test command. `npm run check` runs
typecheck, runtime tests, and `npm run build`. Build output is in ignored `dist/`; optional preview files belong
in ignored `bin/`. Do not commit binaries, credentials, or generated output.

## Table kernel tests (library only)

See [Table storage boundaries](docs/table-storage.md). The kernel lives entirely in
`src/storage/table/`; the [V2 inbox](docs/table-inbox.md) lives under
`src/ingress/table-*.ts`. Both it and the explicit V1/V2 Table delivery journals remain
library-only; operator recovery execution and runtime selection are separate work.
Focused check: `node --import tsx --test test/table-*.test.ts`.
Tests exercise real public SDK/native HTTPS against an independently implemented
local service; they use no Azure resources or real credentials. Preserve raw
FULLmetadata validation, exact-M reconciliation, active-instrumentation privacy,
nonexpiring ownership and actual-work drain. SDK ACKs are not commit authority.
The separate V2 foreign-owner inspector must remain GET-only on every path, one-shot
and ownership-free, with exact supplied M fences and actual token/native/iterator
drain. Keep generic traversal mechanics shared without moving owned admission,
permission retirement, callback poison or FIFO publication into the helper.
`test/table-foreign-inspection*.test.ts` exercises native boundaries and zero-write
failure/close paths; its compile-contract file verifies strict synchronous visitors.
Envelope completion is not domain/cross-pass proof, recovery authority or termination.
Inbox changes must preserve the exact planner-byte refresh manifest, complete
body-free graph audit, independent queue/working ledgers and clock-before-restart
projection. Do not copy the V1 delivery wrapper's unconditional close bridge into an
armed inbox: unknown/possible arms or clock debt require invalidation before kernel
close. Closing may publish only private cleanup progress, never a grant or Ready.
Keep SQLite differential traces separate from the documented armed-crash adaptation;
small native fixtures and capacity arithmetic are not 100000-record/RSS qualification.

## Optional packaging gates

See [the deployment runbook](docs/deployment.md#scoped-verification) for exact
prerequisites and kindctl commands. Select Node 24.2.0 on `PATH` using your local
toolchain manager (`node --version` must report `v24.2.0`). From this adapter
worktree, set and export `KINDCTL` to the absolute path of the canonical wrapper in
your Orka checkout; replace the example path below. The deployment runner requires
an existing executable file and validates its scoped kubeconfig path and context
before cluster access.

```sh
npm run check
npm run test:container
export KINDCTL=/absolute/path/to/orka/.agents/skills/kindctl/bin/kindctl
"$KINDCTL" exec --tag deployment -- npm run test:deployment
```

The two smoke commands fail if prerequisites are absent; neither is part of default
`npm test`. Docker acceptance builds/runs the actual image and pinned proxy.
Deployment acceptance uses real Kustomize, server dry-run against installed Gateway
CRDs and synthetic Pods/PVC/TLS/restarts. It creates only a new owned namespace and
never installs Orka, touches global kubeconfig, or deletes the operator's cluster.

`test/deployment-ownership.test.ts` is offline behavioral coverage for failed or
incomplete termination proof. The real deployment fixture seeds receipts only via
the public journal API after all owners are stopped, and refuses owner-file
mutation/restoration while any Pod/container/controller could still own the store.
A CLI exit or successful scale/delete acknowledgement alone is not that proof.
`test/deployment-processes.test.ts` also runs offline, covering required wrapper
configuration, bounded log capture and all-follower cleanup after failures.
Fixture code uses a file subPath mount and explicit completion markers; a projected
ConfigMap symlink must not silently skip its main-module guard. Never turn fixture
routing or fault injection into production configuration.

Keep runtime assets under the `deploy/` root Kustomization and storage/init/Orka
objects outside its resource list. Do not add fsGroup, automatic DB initialization,
Secret content/hash generators, floating image versions or request logging. Legal
URLs, live identities, PNGs and ZIPs belong in operator-managed ignored artifacts,
not source. Synthetic readiness/replay is not live credentials, full conformance,
controller readiness or proof that the default kind CNI enforces NetworkPolicy.

## Setup capture boundaries

The separate [setup command and host/container guide](docs/setup-capture.md) uses
`src/setup/{config,artifact,server,main}.ts` and shared `src/auth/` credential
preparation. Setup does not perform provider sending or Orka admission, and the
six-field capture projection is independent of credential mode. `setup:capture` runs
`node dist/setup/main.js`; Docker requires an explicit entrypoint override.

- `parseSetupConfig(env)` and `validateSetupConfig(config)` return a frozen setup
  snapshot. No dummy allowlist is used for preflight. Actual candidate recipient
  and service values pass the unchanged `validateReceiverConfig` after selection.
- `startSetupCapture(config, authDependencies?, signal?)` returns
  `{port, done: Promise<void>, stop(): Promise<void>}`. Auth test dependencies are
  only `FetchKeys` and SDK `CloudEnvironment`, never a generic auth callback,
  provider factory or CLI override. Use the real shared RSA/JWKS fixture to prove
  **two independent verifications**, including SDK wrong-key refusal.
- `openSetupArtifact(config)` returns `{matches(text), publish(candidate, active),
  close()}`. Publication is synchronous and reserves once, with exclusive atomic
  hard-link publication and a final active fence. All descriptors/identities remain
  private; only proven-owned temps can be cleaned. Never open a runtime DB here.
- `SetupCandidate` has exactly six strings: `appId`, `tenantId`, `recipientId`,
  `serviceUrl`, `senderId`, `conversationId`. The writer explicitly projects them
  with a 4096-byte ceiling. No code/text/token/label/activity ID/reply target is saved.
- Success follows durability, response finish/disconnect, and SDK drain. Shutdown
  fences late callbacks and cannot await its own SDK request. Admission deadlines
  are not cancellable SDK I/O or hard-real-time filesystem guarantees.
- Challenge syntax cannot attest entropy/freshness/humanity: operators generate
  16 fresh random bytes privately for every attempt and manually review the result.
  Do not auto-configure allowlists or add Kubernetes capture/provisioning actions.

Focused tests (Node >=24, no patch-version requirement):

```sh
node --import tsx --test test/setup-config.test.ts test/setup-artifact.test.ts test/setup-server.test.ts test/setup-cli.test.ts
```

Tests use real private files, OS fault boundaries, actual SDK auth, concurrency and
late verification, and standalone CLI processes. Never assert private values in
actual/expected diffs or print child errors. The explicit container gate checks the
new compiled entrypoint with a host-only capture mount, expiry and auth refusal;
there is no production auth override and no live positive-capture claim.

## Certificate authentication boundaries

See [certificate authentication](docs/certificate-auth.md). `src/auth/credentials.ts`
owns the shared discriminated union/structural parser; `certificate.ts` snapshots
private matching RSA material into closures; `network.ts` confines native MSAL I/O.
`prepareReceiver(config, deps?).start(sink, outbound?)` is one-use, with no listener,
CCA or retained descriptor before start. Normal runtime performs metadata-only
storage/sidecar collision checks and prepares before Orka client/store opens.
Never reread credential files after SQLite ownership, add an already-validated
bypass, expose a prepared private key/MSAL object, or use the legacy `botToken`
seam as certificate integration proof.

Tests must exercise the real SDK public callback/selected credentials and pinned
MSAL 5.6.0 signing/cache, with synthetic key material only. `certificateNetwork`
is the public `INetworkModule` test seam, not a CLI endpoint override. Native HTTPS
must remain verified, bounded, fixed-destination, no GET/redirect/proxy/retry, and
settle actual work before sender drain. Discard every MSAL log, including non-PII
messages. Do not log decoded assertions, keys, tokens or raw OAuth errors. Setup
must validate files but deny token acquisition without constructing a CCA.

```sh
node --import tsx --test test/certificate-config.test.ts test/certificate-files.test.ts test/certificate-token.test.ts test/certificate-runtime.test.ts
```

No live Entra/Teams calls are part of these tests. The Docker gate covers compiled
certificate entrypoint/mount validation; default Kubernetes secret assets remain
unchanged and no certificate Kubernetes overlay is claimed.

## Managed-identity federation boundaries

See [managed-identity authentication](docs/managed-identity-auth.md). The shared
credential union includes explicit `managed-identity-federation` with required
UAMI client/principal GUIDs. `prepareManagedIdentity` is structural/no-I/O and
returns only `assertUsable()` and one-use `createToken(dependencies?)`. Preparation,
setup and ingress-only must never construct a CCA or acquire metadata/app tokens.

`app-token.ts` contains only the shared lazy CCA/cache logic extracted from the
certificate provider. Preserve all certificate APIs/errors. `imds.ts` owns the
fixed native link-local HTTP GET; Entra retains the existing confined verified
HTTPS network. `ReceiverDependencies.managedIdentity` exposes only `imdsRequest`
(native HTTP request) and `entraNetwork` (public MSAL `INetworkModule`) as trusted
library test seams, not endpoint/CLI overrides. No SDK managed-identity option,
private MSAL hooks, serialized-cache inspection or legacy `botToken` overrides.

MSAL resolves assertions before final-token cache lookup. Test the real public
callback: two eligible acquisitions mean **two IMDS GETs and one Entra POST** when
the final token is cached. Keep all assertions/tokens in memory and out of test
failure diffs. Validate only proven identity claims, including URI or public
resource GUID audience; do not invent mandatory optional IMDS fields. Entra owns
cryptographic verification. Test malformed pre-cache responses, actual request
close, singleflight, removable waiters, two-leg deadline/no-late-send and shutdown
before both stores close. No extra cache/retry queue or new dependency.

```sh
node --import tsx --test test/managed-identity-config.test.ts test/managed-identity-token.test.ts test/managed-identity-runtime.test.ts
```

The actual Docker gate also checks MI setup/config refusal and normal readiness/
receipt replay without acquisition. It does not live-qualify the Node provider on
Azure or provide persistent hosting/HTTPS. Default Kubernetes assets stay secret mode.

## Ingress implementation and test boundaries

- `src/ingress/config.ts` parses explicit nonsecret init scope or full serve config;
  invalid config never reaches listen. SDK environment defaults cannot silently
  select managed identity, another cloud or unauthenticated operation.
- `auth.ts` adds a strict public Bot Framework profile using `jsonwebtoken` and
  `node:crypto.createPublicKey`, never custom signature crypto. Cached source data
  associates endorsement with the **same actual key** verifying the signature.
  Cache misses cannot cause unbounded per-kid refreshes. Keep issuer/source fixed
  in production; do not add a test-JWKS environment variable.
- `http-adapter.ts` implements the public `IHttpServerAdapter`. The SDK registers
  `/api/messages`; the native listener parses bounded original JSON, applies the
  strict guard, and calls that registered handler. Node receive timeouts alone do
  not cover SDK processing: an absolute deadline plus request-local cancellation
  fences late callbacks, while shutdown drains outstanding handler promises.
  A fixed 32-handler budget is reserved before body retention; timed-out/disconnected
  handlers retain slots until actual authentication/admission/reconciliation drains.
  Saturation is transient 503, not storage poison. This adapter is shared with setup.
- `server.ts` supplies `App` with explicit credentials, public cloud, safe logger
  and `dangerouslyAllowUnauthenticatedRequests: false`. Its awaited
  `App.server.onRequest` callback replaces default activity/OAuth dispatch. Do not
  use `app.event(activity)` (not awaited) or `app.on(message)` (rehydrates missing
  fields) for durable admission. Check original recipient/service URL/body tenant;
  do not trust projected token.appId or JWT tid as body identity.
- Candidate conversion uses a new opaque UUID. `store.admit` synchronously commits
  inbox + minimal route before ACK; it returns the saved key for duplicates and
  retains the original envelope. The callback awaits admission, including an async
  sink used to test deferred commit. A fatal storage signal follows the fixed 503
  flush/disconnect, so shutdown does not preempt that response.
- `IngressPort` and `DeliveryJournalPort` are explicit async-compatible orchestration
  interfaces, not new backends. Public synchronous store/journal APIs and schemas
  remain unchanged. `createIngressPort` adapts an already-owned SQLite inbox using
  its same private connection: no reopened file/FD and no event-derived deadline.
  Async inbox claims require one-use `IngressForwardingGrant` revalidation plus a
  synchronous final `take` (owner/attempt, replay eligibility and quarantine).
  Relay checks readiness/cancellation after revalidation; finalization retires send
  permission synchronously. `Promise<IngressClaim>` alone is not an async port.
- Existing `store.ts`, `client.ts`, and `relay.ts` own persistence, verified Orka202
  receipts and fenced settlement. `main.ts` composes one serial loop, never a second
  retry implementation. Abort then await **both** SDK/admission and relay settlement
  before store close. Storage errors reject runtime completion and stop serving;
  never reinterpret them as network retry. Preserve Retry-After during cancellation.
- `logger.ts` discards arbitrary SDK arguments in every method/child regardless of
  environment log level. Only fixed application lifecycle categories reach stderr.
  Never log/echo requests, JWTs, secrets, SDK/transport errors or normalized text.

Focused command:

```bash
node --import tsx --test test/ingress-server.test.ts test/ingress-config.test.ts test/ingress-runtime.test.ts test/ingress-cli.test.ts
```

Tests use real RSA signatures, the actual SDK-registered route, loopback JWKS
through public cloud/I/O seams, real inbox files and the shared ephemeral HTTPS
Orka fixture. No mocked JWT verifier, no auth bypass, no deep private SDK imports.
The CLI never exposes those dependency seams. Cover missing/invalid lifetime and
issuer/audience/service URL, key endorsements/signature confusion, duplicate kids,
cache storms, wrong original body scope/channel, parser limits, deferred commit,
full/conflict/failure outcomes, original-envelope replay, cancellation/restart,
Retry-After, late SDK callbacks, fatal storage and log/response sentinels.

The persisted scope includes app, tenant, canonical Orka base and Gateway target.
Keep backend/Gateway UID/ledger stable and retention longer than the absolute
replay window. Quarantine preserves acknowledged text for investigation; terminal
logical removal is not secure erasure. Routes/tombstones remain indefinitely,
capacity backpressures, and no pruning/reset/redrive or HA claim exists. See
[operational limits](README.md#inbox-retention-and-operational-limits) before
changing scheduling, retention, route lifecycle or startup recovery.

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
| Ingress receiver/inbox/relay | request verification, app/tenant/recipient enforcement, durable original event + route, Orka admission | sender authorization, provider sends, outbound capabilities |
| Outbound listener/dispatcher/sender | separate bearer boundary, bounded V1 requests, journal-backed send/receipt replay | changing original ingress replay keys, recovering lost provider receipts |

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

The ingress caller creates a candidate opaque reply-target key; the inbox commits
only the winning original normalized envelope/route and replays it unchanged,
including across restart. Duplicate candidate conversion is only for local
fingerprint comparison, never replacement of stored routing/profile/key. Relaying
a reconverted duplicate with refreshed labels, timestamps or metadata can cause
Orka HTTP 409 even with the same stable event ID. Persistence/replay lookup belong
to the inbox, not the converter. The reply-target key refers to private routing
state; it is not a service URL or credential.

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
lease expiry is ambiguous, not retry permission. The integrated sender prohibits
hidden retries/redirect replay and never manufactures receipt IDs. The example
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

These are **local domain outcomes**, not new V1 delivery statuses. The dispatcher
maps them to the Telegram-compatible response/capability baseline. The journal
blocks ambiguous redrive but cannot recover a lost Teams receipt or atomically
commit SQLite and a remote send.

## Full-runtime boundaries and tests

See [full-mode configuration, API and limits](README.md#enable-the-full-requestreply-runtime).
Keep these ownership boundaries intact:

- `startReceiver(config, sink, dependencies?, outbound?)` preserves the SDK-only
  ingress route. Optional `outbound` is `{ journal, getRoute }`; optional returned
  `receiver.outbound` is the journal-backed `DeliveryDispatcher`, never a raw sender
  or token. `receiver.stop()` is idempotent and drains intake and the dispatcher.
- The receiver privately resolves the SAME App's PUBLIC `app.api.http.token` as a
  string, StringLike or `TokenFactory({})`, safely handling missing/throwing values.
  Do not import protected token managers, create a second App, or expose tokens.
  Ingress-only mode does not create a sender or acquire a bot token.
- `ReceiverDependencies.botToken` (public SDK `Token`) and `providerPost` are
  trusted **library-test-only** seams, alongside the existing auth fixtures. An
  explicit test token is assigned to `app.api.http.token` after construction,
  since constructor `clientSecret` wins over its token option. The closure still
  always reads that public property. CLI never supplies either seam; never add
  cloud/JWKS/token/proxy bypass environment variables.
- `startOutboundServer({host, port, bearerToken}, dispatcher, scope, isReady)`
  returns `{port, stop, failed}`. It owns a separate native HTTP listener, exact
  bearer-authenticated V1 paths, 256 KiB body / 16 KiB header limits, a ten-second
  absolute connection/request budget, remaining nine-second dispatch budget and
  32-handler preclaim backpressure. Auth precedes body/readiness. Safe responses
  reconstruct only V1 fields, never SDK errors, text, references or headers.
- Full `startIngressRuntime` keeps `.port`, `.stop()` and `.done`, adding optional
  `.outboundPort`. It validates config/TLS/CA/path aliases, opens BOTH stores before
  binding either listener, passes the owned inbox's `getRoute`, binds receiver then
  API, marks ready, then starts the unchanged serial relay. Never reopen the live
  exclusive inbox for routes. Failed second-store/bind startup drains and releases
  resources without initialization, deletion, reset or forwarding. Trusted library-only
  `IngressRuntimeDependencies` opening seams can defer owned ports, never select a
  backend from environment. Startup cancellation waits actual opening/initialization
  and suppresses late readiness/listening/relay; asynchronous close attempts both
  stores even if one rejects, only after both directions and reconciliation drain.
- Either storage poison marks unready and stops both directions. API fatal signals
  follow response finish/disconnect, not the failed write itself. Abort intake,
  provider and relay work, drain SDK authentication, bot-token work and settlement,
  THEN close both stores. Token acquisition is uncancellable through the public
  SDK API; one shared acquisition may outlive callers and hold shutdown pending,
  but its late continuation cannot POST.
- `snapshotDelivery` / `decodeDelivery` enforce external shape and Unicode/bounds
  without changing journal fingerprints. Claims and saved terminal outcomes precede
  current-route checks. New sends validate current allowlists, tenant/account,
  conversation/context, personal/nonthread scope; metadata is not routing.
- `createProviderSender` uses a fresh public SDK HTTP Client with the safe logger,
  explicit resolved token, exact formatter bytes (whole message <=20 KiB), saved
  HTTPS conversation URL and one POST. Preserve redirect=0, proxy=false, verified
  TLS, body/response limits and strict raw receipt decoding. Once handed to POST,
  invalid/non-2xx/lost responses or cancellation mean unknown unless a valid receipt
  wins first. Commit receipt before delivered. No activity-ID injection or hidden
  SDK enrichment/retry; unknown is never automatically resent/reset/repaired.
- Distinct directional credentials belong in Secrets, never events, Tasks, journal
  records, cards or reply keys. The local HTTP listeners need externally managed
  HTTPS and restricted access; no body/header access logging. Preserve the existing
  negative TLS tests and reject process-wide unsafe TLS settings in production.
- The capability is Telegram-compatible suppression/replay, not remote exactly-once
  or lost-receipt recovery. Retain routes/history beyond automatic attempts for
  manual retries. Orka's delivery call budget is 15s, default attempts ten, default
  expiry 24h and terminal retention 30d; neither store prunes its durable history.
  Keep one process/current local PV and stable backend/Gateway UID/dedup ledger.

Focused integration checks:

```bash
node --import tsx --test test/outbound-*.test.ts
npm run check
```

Use real SQLite and native HTTP/HTTPS, the shared ephemeral TLS fixture and actual
SDK verification/client transport. The trusted provider test wrapper may map the
intended saved HTTPS URL to loopback while asserting URL, body, auth and transport
flags; production never performs that mapping. Runtime tests cover full request/reply,
near-20 KiB wire output, aliases/conflicts/current policy, restart, caller cancellation,
late tokens, two-store ownership/unwind and fatal-after-flush. Observe actual client
receipt/committed state with bounded condition barriers, not fixture `res.end()` plus
an arbitrary sleep. Never print synthetic keys/tokens or commit fixture databases.

The production route model has no `conformance` alias. Orka's complete conformance
checker hardcodes mock identities; it needs an appropriate mock fixture and has not
been run against this production runtime. Wire fixtures and saved-route integration
are not live Teams/Orka, live token-service, network-filesystem or power-cut validation.

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
inbound authentication, transport and ingress/routing persistence are implemented.
Journal-backed Teams sending and authenticated outbound endpoints are implemented
in opt-in full mode. Container/Kubernetes packaging has separate synthetic gates;
full conformance and live Teams/Orka deployment validation remain separate work.
