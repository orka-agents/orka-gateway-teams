# Orka Teams gateway — offline contributor starter

This repository is the first slice of
[orka-agents/orka#549](https://github.com/orka-agents/orka/issues/549).
It supplies protocol types, deterministic event IDs, conversion/formatting
contracts, synthetic examples, and tests. It is not yet a running Teams gateway.
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
- [#551](https://github.com/orka-agents/orka/issues/551): implement the
  `FormatDelivery` contract in `src/teams/format.ts`.

These modules currently export function types, not working conversion or
formatting functions. The tests cover the starter's helpers and examples only.
See [CONTRIBUTING.md](CONTRIBUTING.md) for input/output fixtures and ownership
boundaries. Neither child issue is completed by this starter.

## Card preview

```bash
npm run --silent preview:card -- final
npm run --silent preview:card -- error
```

Omitting the selection defaults to `final`. An unknown selection exits 1 with
`Usage: preview:card [final|error]` on stderr and no JSON on stdout. Successful
commands emit one card JSON object followed by a newline, with no npm banner.

Paste the emitted card JSON into https://adaptivecards.microsoft.com/designer
and inspect the title, wrapped body, paragraphs, list, code text, and Unicode.
This exports the card attachment's content, not the whole Teams activity.
The activity fixtures live in `test/fixtures/outgoing.ts`.
An optional local file can be saved under ignored `bin/`:

```bash
mkdir -p bin
npm run --silent preview:card -- final > bin/final-card.json
```

Only synthetic fixtures are used. Preview is not a live Teams validation.
If the designer cannot be accessed, record that limitation; JSON checks alone
are not a visual preview. The designer URL was HTTP-verified for this starter,
but visual preview was unavailable because no browser tool was available.

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

The personal-chat converter/card formatter come next, followed by authenticated
transport, durable routing and delivery, conformance, and live Teams validation.
Shared-chat multiplayer collaboration is a later milestone. Buzz is an experience
reference, not a dependency or existing integration in this repository.

Orka requires idempotent delivery, including replay correlation. Provider recovery
when Teams accepts a send but its response is lost is unresolved. This starter
advertises no capabilities and does not claim to solve that problem.
