# Runtime configuration and operations reference

For a first deployment, follow the [Azure Container Apps guide](aca-deployment.md)
or the [Kubernetes guide](deployment.md). This reference covers the common HTTP
runtime and default SQLite configuration. Azure Table deployments also require the
[Table runtime configuration](table-runtime.md); do not use SQLite paths for them.
Run the commands below from the repository root.

- [Ingress configuration and initialization](#run-durable-ingress)
- [Authentication and admission](#authentication-and-admission)
- [Inbox retention and operational limits](#inbox-retention-and-operational-limits)
- [Request/reply configuration](#enable-the-full-requestreply-runtime)
- [Authenticated V1 API and delivery behavior](#authenticated-v1-api)

## Run durable ingress

Build with `npm ci && npm run build`. Node 24 is required (`node:sqlite` currently
emits an experimental warning). Configure through environment variables; the CLI
does not automatically load `.env`. Never put credentials on command lines, in
source, or in committed files. Use an approved secret manager for serve; the
shipped Kubernetes assets use Kubernetes Secrets in default client-secret mode.

Certificate mode supports host/Docker serve and setup capture. See
[certificate authentication](certificate-auth.md) for strict private-file
ownership, read-only mounts, rotation, scoped MSAL authentication, and the **not
provided/verified** Kubernetes private-copy overlay. There is no implicit managed
identity or federation fallback; local certificate validation is not tenant acceptance.

Explicit [managed-identity federation](managed-identity-auth.md) supports a
specifically assigned UAMI federated to the existing bot application, using the
fixed Azure Linux VM/ACI IMDS contract or explicit ACA supported-local-subset
transport. The [recorded ACA evaluation](live-validation.md) exercised the
actual identity path and personal-chat round trip, not every hosting/policy variant.
Setup is acquisition-free;
full outbound use requires qualified hosting and an approved FIC. No App Service,
AKS token-file, local Azure CLI or default-identity fallback is provided.

### Required configuration

The storage-path instructions below describe default SQLite. For Table use the
[Table runtime guide](table-runtime.md): set `GATEWAY_STORAGE_BACKEND=table-v2`,
provide explicit Table identities/budgets and storage UAMI settings, and omit both
SQLite DB variables. All existing HTTP, scope, routing and directional credentials
still apply; Table selection is not automatic initialization or recovery.

| Variable | Meaning |
|---|---|
| `TEAMS_APP_ID` | Exact application/client GUID |
| `TEAMS_TENANT_ID` | Exact tenant GUID; no `common`/multi-tenant inference |
| `ORKA_BASE_URL` | HTTPS base URL, including any installation base path |
| `ORKA_GATEWAY_NAMESPACE`, `ORKA_GATEWAY_NAME` | Stable target Gateway |
| `INGRESS_DB` | Absolute new/existing ingress DB path; existing private parent directory |
| `TEAMS_CLIENT_SECRET` | Required only in default/explicit `client-secret` mode; absent in other modes |
| `TEAMS_CREDENTIAL_MODE` | Optional `client-secret` (default), explicit `certificate`, or explicit `managed-identity-federation` |
| `TEAMS_CERTIFICATE_FILE`, `TEAMS_PRIVATE_KEY_FILE` | Required only in certificate mode; private matching PEM pair, absent in other modes |
| `TEAMS_MANAGED_IDENTITY_CLIENT_ID`, `TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID` | Required only in managed-identity-federation mode; explicit UAMI client and principal GUIDs, absent in other modes |
| `TEAMS_MANAGED_IDENTITY_HOST` | Federation only: omitted/`imds` preserves VM/ACI; explicit `azure-container-apps` uses the supported local platform endpoint |
| `ORKA_BEARER_TOKEN` | Required adapter-to-Orka bearer for ingress POST only |
| `TEAMS_RECIPIENT_IDS` | Required JSON array of exact allowed bot recipient IDs |
| `TEAMS_SERVICE_URLS` | Required JSON array of exact allowed HTTPS service base URLs |

The first five rows (including both Gateway fields) suffice for `init`. Serve
requires all required noncredential settings and exactly one credential set:
`TEAMS_CLIENT_SECRET` for default/explicit client-secret mode, or both PEM file
settings with explicit `TEAMS_CREDENTIAL_MODE=certificate`, or both UAMI GUIDs with
explicit `TEAMS_CREDENTIAL_MODE=managed-identity-federation`. Optional settings remain
optional. Lists contain 1–100 explicit entries; no wildcards, first-request
learning, or inferred `28:` prefix. Obtain the bot recipient IDs and public-cloud
service URLs from trusted deployment configuration or operator-reviewed
[authenticated setup capture](setup-capture.md), never unverified requests.
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
silently overrides that environment setting. In ingress-only mode the receiver
makes no Teams/Graph/OAuth sends or bot-token acquisition calls. Outbound sending
requires the explicit full-mode configuration below.

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
errors. At most 32 ingress handlers retain bodies or await authentication/admission;
saturation returns fixed transient HTTP 503 before body retention. These slots remain
occupied after timeout/disconnect until actual work completes, independently of the
durable inbox capacity. SDK key I/O may outlive that transport deadline; late callbacks
are fenced from admission and tracked/drained on shutdown. Do not hard-kill graceful shutdown
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

- For default SQLite: separate schema/database from the delivery journal; one
  local-filesystem owner, no HA/network-filesystem support. Keep an intact/current persistent volume.
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

## Enable the full request/reply runtime

For default SQLite, provision both databases explicitly; do not delete/reset one
to make startup pass.
Table mode instead uses the [same commands with explicit logical IDs](table-runtime.md#explicit-initialization-and-serving)
against an already-existing physical table, without either SQLite path.
With the nonsecret app/tenant/Orka/Gateway scope above and an absolute `DELIVERY_DB`
path configured, run once:

```bash
npm run init:delivery
```

This is `node dist/ingress/main.js init-delivery`. It requires no credentials or
listener and does not require `INGRESS_DB`; if supplied, that path must be distinct.
It provisions the unchanged app+tenant delivery journal and permanent ownership
sidecar, refusing existing data. Provision ingress separately with `init:ingress`.

Add these variables to the existing serve configuration and use the same `npm start`:

| Variable | Full-mode requirement / default |
|---|---|
| `OUTBOUND_ENABLED` | Exactly `true` to enable; absent or `false` means ingress-only |
| `DELIVERY_DB` | Absolute, separately provisioned journal path |
| `ORKA_OUTBOUND_BEARER_TOKEN` | Required Orka-to-adapter bearer, **different** from `ORKA_BEARER_TOKEN` |
| `OUTBOUND_HOST` | `127.0.0.1`; explicit IPv4/IPv6 bind address |
| `OUTBOUND_PORT` | `3979`; integer 1–65535 |

All outbound fields must be absent when disabled. Invalid booleans, partial config,
identical directional tokens and path collisions (including canonical aliases and
ownership/SQLite sidecars) fail closed, not silently fall back to ingress-only.
Bearers are nonempty RFC6750-shaped values bounded at 8192 characters; do not log
or put them on command lines. Both stores open before either listener binds. A
second-store/listener failure attempts to close both stores without deleting records
or starting the relay. Table ownership may remain occupied after an incomplete
startup audit; cleanup is not release evidence. Ingress `.port` and `/api/messages`
remain unchanged.

### Authenticated V1 API

The separate outbound listener accepts only these exact method/path pairs. All
three require `Authorization: Bearer <secret>`; scheme casing is ignored, value
casing is not. Duplicate/malformed/missing headers, Teams JWTs and crossed
adapter-to-Orka credentials are denied before body processing or readiness checks.
Expose this listener only through deployment-managed HTTPS with restricted network
access. Do not publish either loopback HTTP listener directly to the Internet.

- `GET /v1/health`: HTTP 200 with exactly `{"status":"ok"}` when locally ready.
- `GET /v1/capabilities`: HTTP 200 with the following exact advertisement:

```json
{
  "protocolVersion": "orka.gateway.v1",
  "adapterName": "orka-gateway-teams",
  "adapterVersion": "0.0.0",
  "capabilities": {
    "inboundText": true,
    "outboundText": true,
    "threads": false,
    "senderIdentity": true,
    "explicitSessions": false,
    "idempotentDelivery": true
  }
}
```

- `POST /v1/deliveries`: strict V1 `DeliveryRequest`, uncompressed UTF-8 JSON only.
  HTTP 200 domain results are `delivered` with the exact `providerMessageId`, or
  `retryableError` / `nonRetryableError` with fixed safe messages. No provider error,
  request text, header, metadata or task/session reference is echoed.
- Until both listeners and stores initialize, health/capabilities and new claims
  are unavailable (503). Invalid body is 400, body overflow 413, unsupported
  encoding/media type 415; errors are fixed-safe `nonRetryableError` bodies.
  Authentication failures are 401; unknown method/path pairs are 404, not aliases.

Headers are bounded at 16 KiB, request bodies at 256 KiB, text at 64 KiB, identities
at 256 UTF-8 bytes, metadata at 32 bounded entries. The absolute connection/request
budget is ten seconds, including headers/body/token/provider work. Dispatch gets
at most nine seconds and less when body/header receipt consumed the budget,
reserving settlement margin. At most 32 delivery handlers are admitted; excess
work gets HTTP 200 `retryableError` **before claiming**, not a provider attempt.

The dispatcher first commits a claim or replays durable history, then resolves the
saved opaque reply key through the already-owned inbox. Fresh sends must match
current service/recipient allowlists, tenant/account, personal conversation/context
and nonthread policy. Metadata/references never select a destination. Confirmed
receipts replay even after routing policy changes; changed immutable input is a
conflict. There is no production `conformance` routing shortcut. Orka's checker
supports `--delivery-fixture` with an explicitly authorized retained route; its
default mock identities remain unsuitable for this receiver. The
[fixture-enabled live check passed](live-validation.md#authorized-fixture-conformance--2026-09-16)
without changing the saved-route model or enabling reference fault fixtures.

A private closure resolves the **same SDK App's public token factory** only when a
new authorized send needs it. A fresh SDK HTTP client sends the exact bounded card
message to the saved HTTPS conversation URL: one POST, no redirects, proxy/retry
inheritance or activity-ID injection, verified TLS, and bounded raw receipts.
Only valid synchronous 200/201 receipt IDs confirm success. Receipt commit precedes
`delivered`; a caller disconnect does not erase a received, settled receipt.

This is Telegram-compatible suppression/replay, **not provider exactly-once**.
Before provider dispatch, token failure/cancellation may retry. After dispatch,
timeout, cancellation, network loss, non-2xx or invalid/missing receipt is terminal
`unknown`, exposed as `nonRetryableError`. Startup converts abandoned sends to
unknown. Unknown is never automatically resent, expired, reset or repaired; a lost
Teams receipt cannot be reconstructed. Keep one writer, a stable Orka target/
Gateway UID/ledger, and retained routes/history. Default SQLite requires one
intact/current writable local PV; Table V2 instead requires stable existing Table
partitions and [controlled clean handover](table-runtime.md#operational-and-verification-boundary),
not a writable SQLite path or crash takeover.

Runtime orchestration awaits storage opening, admission, claims, route lookup,
settlement and closing. SQLite remains the default and its public store APIs
remain synchronous; explicit Table V2 uses asynchronous stores without SQLite
paths. An inbox claim acknowledgement is not forwarding permission: the owned
store rechecks the exact attempt, replay deadline and quarantine
immediately before the one-use Orka handoff. Cancellation during startup drains
late opening/initialization without publishing readiness or starting the relay.

SIGINT/SIGTERM or either storage poison stops both directions: mark unready, stop
intake, abort API/provider/relay work, drain SDK callbacks, token acquisition and
all settlement, then close **both** stores and, in Table mode, the storage-token
provider last. Fatal storage signals follow the fixed
HTTP response flush/disconnect. Public SDK bot-token acquisition cannot be
cancelled: at most one acquisition is outstanding, late completion cannot POST,
and shutdown waits for it. A stuck acquisition can therefore hold graceful
shutdown beyond the HTTP deadline. Never mistake client timeout for drained I/O.
Production has no CLI/env cloud, token-factory, provider-proxy or TLS bypass seam.

Automated tests exercise native HTTP/HTTPS, actual SDK signatures/client transport,
SQLite/Table, concurrent replay, cancellation and controlled clean restart without
contacting live Teams or Orka. The [live validation report](live-validation.md)
separately records the evaluated ACA/Table deployment; it does not qualify every
hosting variant. Network-filesystem and power-cut validation are not claimed.
