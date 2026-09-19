# Library examples and card preview

These examples use synthetic fixtures and run from the repository root. They do
not configure a live gateway, authenticate a sender, or send a Teams message.
For API contracts and test requirements, see [CONTRIBUTING.md](../CONTRIBUTING.md).
For deployment, start with the [README](../README.md#getting-started).

- [Convert a verified personal message](#convert-a-verified-personal-message)
- [Format an already-validated delivery](#format-an-already-validated-delivery)
- [SQLite delivery journal example and limits](#local-durable-delivery-journal)
- [Preview an Adaptive Card](#card-preview)
- [SDK reference](#sdk-reference)

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
saved original envelope/key. See [durable ingress](runtime-reference.md#run-durable-ingress).

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
receipt is not proof. The integrated outbound sender prohibits hidden SDK retries
and redirect replay; direct journal callers must preserve the same restrictions.

### Journal operational limits

The filesystem/ownership rules below describe the synchronous **SQLite** journal
above. Table V2 has separate [nonexpiring ownership and clean-handover rules](table-runtime.md#operational-and-verification-boundary).

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

These outcomes are local domain states, **not new V1 response statuses**. The
journal itself is not an authentication or transport boundary. The full runtime
maps its outcomes to the existing [V1 responses](runtime-reference.md#authenticated-v1-api).
Teams acceptance with a lost
response remains uncertain; blocking a resend does not recover an unknown provider
correlation.
See [CONTRIBUTING.md](../CONTRIBUTING.md#delivery-journal-contract) for the API contract.

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
