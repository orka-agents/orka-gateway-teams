# Orka Teams gateway — durable inbound slice

This repository implements the **inbound-only** slice of
[orka-agents/orka#549](https://github.com/orka-agents/orka/issues/549): an authenticated
Teams personal-message receiver, durable SQLite inbox/private reply routes, and a
serial HTTPS relay to Orka. It also supplies the pure converter, bounded card
formatter, separate delivery journal, synthetic examples, and tests.

This is **not a full Gateway-ready adapter**. There are no `/v1/health`,
`/v1/capabilities`, or `/v1/deliveries` endpoints, capability advertisements, Teams
sends, or Kubernetes installation. Normal Orka dispatch/readiness needs the later
outbound slice. Local tests are not live Teams/Orka execution or a complete demo.

## Local development

Use Node 24 LTS and npm. From the repository root:

```bash
npm ci
npm run check
```

Individual commands: `npm test`, `npm run typecheck`, `npm run build`.
Build output is written to ignored `dist/`.

## Run durable ingress

Build with `npm ci && npm run build`. Node 24 is required (`node:sqlite` currently
emits an experimental warning). Configure through environment variables; the CLI
does not automatically load `.env`. Never put credentials on command lines, in
source, or in committed files. Use a secret manager/Kubernetes Secrets for serve.

### Required configuration

| Variable | Meaning |
|---|---|
| `TEAMS_APP_ID` | Exact application/client GUID |
| `TEAMS_TENANT_ID` | Exact tenant GUID; no `common`/multi-tenant inference |
| `ORKA_BASE_URL` | HTTPS base URL, including any installation base path |
| `ORKA_GATEWAY_NAMESPACE`, `ORKA_GATEWAY_NAME` | Stable target Gateway |
| `INGRESS_DB` | Absolute new/existing ingress DB path; existing private parent directory |
| `TEAMS_CLIENT_SECRET` | Required for serve; no implicit managed identity fallback |
| `ORKA_BEARER_TOKEN` | Required adapter-to-Orka bearer for ingress POST only |
| `TEAMS_RECIPIENT_IDS` | Required JSON array of exact allowed bot recipient IDs |
| `TEAMS_SERVICE_URLS` | Required JSON array of exact allowed HTTPS service base URLs |

The first five rows (including both Gateway fields) suffice for `init`. Serve
requires all rows. Lists contain 1–100 explicit entries; no wildcards, first-request
learning, or inferred `28:` prefix. Obtain the bot recipient IDs and public-cloud
service URLs from your trusted deployment configuration, not unverified requests.
URL configuration normalizes hostname/encoding and adds a trailing slash; query,
fragment, userinfo and nonstandard **service** ports are refused. Orka may use a
custom HTTPS port. Incoming body and signed `serviceurl` must exactly match each
other and a configured canonical URL, including path case and trailing slash;
request input is never normalized/repaired to obtain a match.

| Optional variable | Default / bounds |
|---|---|
| `ORKA_CA_FILE` | Absolute PEM CA-bundle path; otherwise system TLS trust |
| `INGRESS_HOST` | `127.0.0.1`; explicit IPv4/IPv6 bind address |
| `INGRESS_PORT` | `3978`; integer 1–65535 |
| `INGRESS_MAX_PENDING` | `1000`; 1 through max records, includes blocked/forwarding bodies |
| `INGRESS_MAX_RECORDS` | `100000`; 1–100000, includes terminal tombstones/routes |
| `INGRESS_REPLAY_WINDOW_MS` | `86400000` (24h); 1–604800000 (7d) |

With the nonsecret scope configured, explicitly provision **once**:

```bash
npm run init:ingress
```

Then supply the remaining serve configuration and run:

```bash
npm start
```

Equivalent direct commands are `node dist/ingress/main.js init` and
`node dist/ingress/main.js serve`. Initialization refuses an existing file. Serve
requires an existing intact database for exactly the configured scope; it never
initializes, migrates, resets, or adopts one. Missing/invalid config, storage,
CA file, or listener binding causes a fixed safe error and nonzero exit. SIGINT
and SIGTERM stop admission, abort outbound I/O, await all in-flight SDK/admission
and relay settlement, then close the store. Storage failures stop the runtime,
not an infinite network-retry loop.

Expose only `POST /api/messages` through externally managed HTTPS. The default
listener is loopback HTTP, not a public TLS terminator. Configure your proxy with
bounded headers/body/deadlines, no request-body/auth-header access logs, and no
redirect/retry rewriting. Preserve authorization and original JSON. There are
no unauthenticated readiness endpoints. Orka TLS certificate/hostname checks stay
enabled; a custom CA changes trust roots, not verification. Custom CA files must
contain one or more valid PEM certificates separated only by whitespace; every
certificate and the complete bundle are validated before opening the inbox or
binding. Empty, malformed, truncated or partly valid bundles fail configuration.
`NODE_TLS_REJECT_UNAUTHORIZED=0` is refused at startup and on incoming requests,
including changes while authentication is in flight; the runtime never resets or
silently overrides that environment setting. The receiver makes no
Teams/Graph/OAuth sends or token acquisition calls. No unused Orka-to-adapter token
is configured until authenticated outbound endpoints exist.

### Authentication and admission

The pinned SDK public HTTP adapter invokes the **SDK-registered** route only after
supplemental verification. SDK JWT verification must also pass before its awaited
raw callback runs; the default activity/OAuth pipeline is not dispatched. Auth
bypass is explicitly false and cloud explicitly public, regardless of SDK env
variables. SDK logger/children discard every argument even under debug settings.
Only fixed lifecycle/error categories are logged; no activities, JWTs, credentials,
SDK error objects, sender labels, or request URLs are logged or echoed.

Supplemental `jsonwebtoken` RS256 verification uses the actual selected RSA JWK,
which must endorse `msteams`; exact issuer `https://api.botframework.com`, exact
app-ID audience (no aliases/arrays), finite required `exp`/`nbf`, SDK-compatible
300-second tolerance, and an exact signed `serviceurl` are enforced. Public keys
come only from `https://login.botframework.com/v1/.well-known/keys`: five-minute
cache, single-flight fetch, five-second deadline, 2 MiB document/1024-key limits,
ambiguous-kid rejection and failure cooldown. Unknown kids do not refresh a live
cache; legitimate key rotation can therefore backpressure authentication for up
to five minutes. There is no CLI test-JWKS URL or cloud/auth override.

HTTP accepts at most 256 KiB of uncompressed UTF-8 JSON and 16 KiB headers, with
absolute ten-second connection/request-processing deadlines and fixed parser
errors. SDK key I/O may outlive that transport deadline; late callbacks are fenced
from admission and tracked/drained on shutdown. Do not hard-kill graceful shutdown
merely because the client-facing deadline has elapsed.

The original body must identify the configured recipient, tenant and service URL
before conversion. JWT `appid`/`tid` are not body identity. The converter remains
the authoritative supported-personal-message filter; exact `from.id` remains
Orka's sender-allowlist candidate, not proof of humanity. Unsupported authenticated
activities explicitly return 200 ignored without storage. Invalid/wrong-scope
input gets 4xx. New event + minimal reply route commit atomically before 200;
duplicates reuse the saved original envelope/key, conflicts return 409, and
capacity/storage failures return 503. A disconnected or timed-out client may
still have a committed admission: retry the same original provider activity.

### Inbox retention and operational limits

- Separate schema/database from the delivery journal; one local-filesystem owner,
  no HA/network-filesystem support. Keep an intact/current persistent volume.
  Ingress uses its main SQLite connection's lifetime EXCLUSIVE lock, DELETE
  journal, EXTRA synchronization and private files. Do not read/open/close the
  live SQLite file through ordinary filesystem APIs in the owning process.
- Pending, forwarding and quarantined records contain **normalized text**, sender
  identity/optional label and the original envelope. Minimal private routes retain
  service URL, bot ID and personal conversation/tenant. Full raw activities,
  headers, tokens and credentials are never persisted. Protect the DB as private
  user content; don't put secrets into IDs or messages.
- A validated Orka 202 receipt is durable admission, **not Task completion**. Its
  accepted/duplicate/rejected/deadLettered outcome logically removes the active
  payload, retaining digest/receipt/tombstone/route indefinitely. Logical removal
  is not forensic erasure. Retain routes for late/manual outbound retries.
- Each record captures an absolute replay deadline. Expiry or clock regression
  quarantines and preserves its body; no automatic redrive, pruning, reset or
  deletion exists. Capacity produces backpressure before ACK. Monitor disk,
  process exit, 503s and retained-record growth; quarantine requires operator
  investigation, not database deletion.
- Network ambiguity retries the **same stored original event/key**, serially,
  with exponential backoff and unshortened Retry-After. Keep configured backend,
  Gateway **UID**, and Orka dedup ledger stable. Orka retention must exceed the
  replay window. V1 has no expected-UID fence here: Gateway recreation, ledger
  rollback, DB restore/loss or target replacement require quiescing/reconciliation,
  not a claim of backup-safe replay.

The next outbound slice uses the existing Telegram-compatible V1 outcome baseline.
Live registration, provider sends and a full end-to-end demo remain unvalidated.

## Contributor tasks

- [#550](https://github.com/orka-agents/orka/issues/550): implemented by
  `convertActivity` in `src/teams/convert.ts`, preserving the `ConvertActivity` contract.
- [#551](https://github.com/orka-agents/orka/issues/551): implemented by
  `formatDelivery` in `src/teams/format.ts`, preserving the `FormatDelivery` contract.

The converter and formatter are both callable and tested.
See [CONTRIBUTING.md](CONTRIBUTING.md) for input/output fixtures and ownership
boundaries. The broader gateway work in #549 remains unfinished.

## Convert a verified personal message

```ts
import { convertActivity } from './src/teams/convert.js';
import { personalMessage, conversionContext } from './test/fixtures/incoming.js';

// Offline synthetic example; a live caller must verify request, app and tenant first.
const result = convertActivity(personalMessage, conversionContext);
if (result.kind === 'accepted') {
  const event = result.event;
  // Candidate for Orka's stable sender-ID allowlist, not proof of a human sender.
  // The caller durably stores this original event and its opaque replyTarget for replay.
}
```

The pure converter accepts new Teams `message` activities in exact `personal`
conversations. It ignores notifications, edits/deletes/undeletes, event-marked
messages, groups/channels, explicit bots/skills, identifiable self messages, and
empty/whitespace-only text. Missing account roles are legitimate; neither a
missing role nor `role: 'user'` attests humanity. Sender authorization remains
Orka's stable-ID allowlist using exact `from.id`, never display name, AAD ID, or
ID-prefix heuristics. No authorization or network calls happen here.

At least one tenant claim (`channelData.tenant.id` or `conversation.tenantId`) is
required; every supplied claim must be well formed and exactly match configured
`tenantId`. Required IDs and the opaque reply-target key are nonempty, at most
256 UTF-8 bytes, and preserved without trimming or case/Unicode normalization.
Identity boundary whitespace is rejected. Optional display labels are bounded
before trimming; empty normalized labels are omitted. All consumed strings must
have well-formed Unicode and no Cc controls, except TAB/LF/CR in text. Text is
limited to 64 KiB UTF-8 and otherwise preserved exactly, including useful
whitespace and emoji. Whitespace follows Unicode `White_Space` (not JS `trim()`);
format characters such as ZWJ and FEFF are not blanket-rejected.

Only activity text is used, even with attachments. The event omits provider URLs,
timestamps, metadata and `threadId`, including when a personal message has
`replyToId`. The caller owns durable original-envelope/reply-target replay; do not
reconvert duplicates for relay using refreshed labels or routing. The receiver's
candidate conversion is reconciled atomically by the inbox; relay uses only the
saved original envelope/key. See [durable ingress](#run-durable-ingress).

Focused converter tests: `node --import tsx --test test/convert.test.ts`.

## Format an already-validated delivery

```ts
import { formatDelivery } from './src/teams/format.js';
import { finalDelivery } from './test/fixtures/outgoing.js';

const message = formatDelivery(finalDelivery);
```

The deterministic, non-mutating formatter returns one message with exactly one
Adaptive Card 1.4 attachment, distinct final/error titles, wrapped text, and no
ordinary activity text. It does not validate transport input or send messages.
Empty or whitespace-only answers get neutral completion/failure text. Nonempty
answers retain their whitespace, paragraphs, Markdown/code text, and Unicode;
there is no custom Markdown/HTML renderer.

The **complete serialized message** is at most 20 KiB of UTF-8 JSON, including
wrappers, fallback text, escaping, and any notice. This is the adapter's budget,
not a claimed Teams maximum. Oversized answers retain a grapheme-aligned prefix
and a separate visible shortening notice. Built-in `Intl.Segmenter` preserves
emoji sequences and combining accents. If even the first grapheme cannot fit,
the title and notice remain readable without a partial grapheme.

The plain-text fallback normalizes whitespace, is independently limited to 512
UTF-8 bytes, and indicates abbreviation. It is not a second message. A fallback
may be abbreviated even when the card body fits unchanged.

Focused formatter tests: `node --import tsx --test test/format.test.ts`.
Run `npm run check` for type contracts, all runtime tests, and the build.

## Local durable delivery journal

`src/delivery/journal.ts` exports `initializeDeliveryJournal`,
`openDeliveryJournal`, `DeliveryJournalError`, and their local TypeScript types.
Initialization is an explicit first-provisioning action, **not** startup fallback.
Normal open requires an intact, initialized store for the exact app and tenant.
It never initializes, adopts, migrates, deletes, resets or expires records.

Run this offline synthetic example from the repository root:

```bash
node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDeliveryJournal, openDeliveryJournal } from './src/delivery/journal.ts';
import { finalDelivery } from './test/fixtures/outgoing.ts';

const directory = mkdtempSync(join(tmpdir(), 'teams-journal-example-'));
const path = join(directory, 'delivery.sqlite');
const scope = { appId: 'app-fixture', tenantId: finalDelivery.accountId };
let journal;
try {
  initializeDeliveryJournal(path, scope); // Only for this new synthetic store.
  journal = openDeliveryJournal(path, scope);
  const result = journal.begin(finalDelivery);
  assert.equal(result.kind, 'claimed');
  if (result.kind !== 'claimed') throw new Error('Expected synthetic claim');
  // Synthetic receipt only: no Teams send happened in this example.
  const receipt = { kind: 'delivered', providerMessageId: 'provider-fixture-1' };
  assert.equal(journal.settle(result.claim, receipt), 'recorded');
  journal.close();
  journal = openDeliveryJournal(path, scope);
  assert.deepEqual(journal.begin({ ...finalDelivery, deliveryId: 'fresh-alias' }), receipt);
  console.log('Synthetic receipt replayed without another claim.');
} finally {
  journal?.close();
  rmSync(directory, { recursive: true, force: true }); // Synthetic temp files only.
}
JS
```

A `claimed` result is a durable reservation, not authorization or provider
acceptance. Only a successful committed claim permits the later caller to attempt
one send. Duplicates return `inFlight`, a saved terminal result, or `conflict` for
changed immutable input. Confirmed `delivered` receipts replay their exact provider
ID; `rejected` and `unknown` are permanent. Startup converts abandoned `sending`
records to `unknown`, **never to resend permission**. No clock, PID timeout, or
lease expiry reclaims them. `retryable` settlement requires actual proof of **no
provider effect**; timeout, cancellation, a generic 5xx, or an invalid/missing
receipt is not proof. The later sender must prohibit hidden SDK retries and
redirect replay; none of that sender behavior is implemented here.

### Journal operational limits

- One configured process, one app+tenant, one intact/current database on a trusted
  normal filesystem-backed persistent volume. No HA or shared/network-filesystem
  guarantee. Operationally enforce a single instance; separate copies are not
  coordinated.
- Use an absolute path with an existing parent directory. Final-path symlinks,
  directories and hard-linked main/ownership files are refused; parent-directory
  symlinks resolve to the same owner. Created files have mode `0600`.
- Ownership is a permanent `<path>.owner.sqlite` sidecar with an exclusive SQLite
  transaction held for the handle's lifetime. The OS releases the lock on process
  death. Never unlink or replace it, even after close. A missing sidecar also makes
  normal open fail. No stale-lock deletion is needed.
- Built-in `node:sqlite` emits its expected experimental warning on Node 24.2.0;
  do not globally suppress warnings. The journal uses one main connection,
  `DELETE` rollback journaling, `synchronous=EXTRA`, foreign keys and nonblocking
  busy handling, with required settings read back. Extension loading is disabled.
  DELETE avoids the bundled SQLite WAL-reset path; EXTRA also syncs rollback
  journal deletion's directory. Existing WAL stores are refused, not converted.
- Missing, unsupported, wrong-scope or corrupt stores fail closed. Database errors
  poison the current handle; close it and investigate. Reopening cannot make an
  ambiguous provider result safely resendable. Failed initialization leaves its
  files present instead of deleting or silently resetting them.
- Storage loss, rollback to an older backup, copying/restoring a journal or deliberate
  tampering can erase deduplication history. They are **not duplicate-safe redrive**.
  Backup discipline belongs to the operator; raw live-file copying is unsupported.
  Do not open/read/close either live SQLite file with ordinary filesystem APIs in
  the owning process: closing such a descriptor can release SQLite's POSIX locks.
- Scope, opaque IDs, versioned request digests, attempt/state and confirmed provider
  IDs are retained indefinitely. No full requests, text, metadata, routing records
  or credentials are stored. Digests support equality checks, not anonymization.
  Callers must not put secrets in identifiers or receipts. There is no TTL, reset,
  deletion or reconciliation API; growth and storage monitoring are operator work.

These outcomes are local domain states, **not new V1 response statuses**. This is
not a sender, authentication boundary, human attestation, transport deadline
implementation, or capability claim. Teams acceptance with a lost response remains
uncertain; blocking a resend does not recover an unknown provider correlation.
See [CONTRIBUTING.md](CONTRIBUTING.md#delivery-journal-contract) for the API contract.

Focused journal tests:
`node --import tsx --test test/delivery-journal.test.ts test/delivery-journal-process.test.ts`.

## Card preview

```bash
npm run --silent preview:card -- final
npm run --silent preview:card -- error
npm run --silent preview:card -- oversized
```

Omitting the selection defaults to `final`. An unknown selection exits 1 with
`Usage: preview:card [final|error|oversized]` on stderr and no JSON on stdout.
Successful commands run the real formatter on the selected synthetic delivery
and emit one card JSON object followed by a newline, with no npm banner.
`oversized` demonstrates shortening of a multibyte answer.

Paste the emitted card JSON into https://adaptivecards.microsoft.com/designer
and inspect the title, wrapped body, paragraphs, list, code text, and Unicode.
This exports the card attachment's content, not the whole Teams activity.
The activity fixtures live in `test/fixtures/outgoing.ts`.
An optional local file can be saved under ignored `bin/`:

```bash
mkdir -p bin
npm run --silent preview:card -- final > bin/final-card.json
```

Only synthetic fixtures are used. If the designer cannot be accessed, record
that limitation; JSON checks alone are not a visual preview. Local card
rendering is not live Teams validation.

## SDK reference

The structure is informed by Microsoft's
[Teams SDK TypeScript quickstart](https://microsoft.github.io/teams-sdk/typescript/getting-started/quickstart)
and its inspected upstream
[echo example](https://github.com/microsoft/teams.ts/tree/main/examples/echo)
([source](https://github.com/microsoft/teams.ts/blob/main/examples/echo/src/index.ts)).
They are references, not provisioning instructions. No binary app icons,
monorepo configuration, or authentication bypass were copied. API/cards/apps/common
are pinned at `2.0.16`. The receiver was checked against the public source at
[tag v2.0.16](https://github.com/microsoft/teams.ts/tree/8b017065c7dd2c8aec29be80c68086afbcf97bbd),
including `App.initialize`, `App.server.onRequest`, `IHttpServerAdapter`, service
JWT validation, public cloud configuration and `ILogger.child`. No private SDK
imports or legacy HttpPlugin are used.

## Roadmap and safety

Journal-backed Teams sending, authenticated outbound V1 endpoints, conformance,
and live Teams validation come next. Authenticated inbound transport and durable
routing/relay are implemented; they do not alone make a Gateway ready.
Shared-chat multiplayer collaboration is a later milestone. Buzz is an experience
reference, not a dependency or existing integration in this repository.

Orka requires idempotent delivery, including replay correlation. Provider recovery
when Teams accepts a send but its response is lost is unresolved. This inbound slice
advertises no capabilities and does not claim to solve that problem.
