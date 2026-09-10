# Orka Teams gateway — offline contributor starter

This repository is the first slice of
[orka-agents/orka#549](https://github.com/orka-agents/orka/issues/549).
It supplies protocol types, deterministic event IDs, a conversion contract,
a working final/error card formatter, synthetic examples, and tests. It is not
yet a running Teams gateway.
There is no Teams listener, credential setup, Orka endpoint, or Kubernetes install.

## Local development

Use Node 24 LTS and npm. From the repository root:

```bash
npm ci
npm run check
```

Individual commands: `npm test`, `npm run typecheck`, `npm run build`.
Build output is written to ignored `dist/`.

## Contributor tasks

- [#550](https://github.com/orka-agents/orka/issues/550): implement the
  `ConvertActivity` contract in `src/teams/convert.ts`.
- [#551](https://github.com/orka-agents/orka/issues/551): implemented by
  `formatDelivery` in `src/teams/format.ts`, preserving the `FormatDelivery` contract.

The converter remains type-only; the formatter is callable and tested.
See [CONTRIBUTING.md](CONTRIBUTING.md) for input/output fixtures and ownership
boundaries. The broader gateway work in #549 remains unfinished.

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
They are references, not setup instructions for this offline repository. No
binary app icons, monorepo configuration, listener, or authentication bypass
were copied. This slice uses `@microsoft/teams.api` and `@microsoft/teams.cards`;
the unused `@microsoft/teams.apps` server dependency is deferred to integration.

## Roadmap and safety

The personal-chat converter comes next, followed by authenticated transport,
durable routing and delivery, conformance, and live Teams validation.
Shared-chat multiplayer collaboration is a later milestone. Buzz is an experience
reference, not a dependency or existing integration in this repository.

Orka requires idempotent delivery, including replay correlation. Provider recovery
when Teams accepts a send but its response is lost is unresolved. This starter
advertises no capabilities and does not claim to solve that problem.
