# Authenticated, one-shot Teams setup capture

Use this **separate command** when an approved bot installation does not yet have
trusted exact personal-chat routing identities. It saves a **candidate**, not an
authorization decision. It never creates an Orka Task, opens runtime databases,
acquires a bot/user token, sends a Teams reply, or updates an allowlist. Normal
receiver authentication and mandatory recipient/service allowlists are unchanged.
No Kubernetes capture workflow is provided; output stays in a private host folder.
Synthetic tests do not establish live Teams/Orka compatibility or tenant authority.

## Prerequisites and boundaries

- The operator must already have approval for the bot/application, exact tenant,
  the selected client-secret, certificate or managed-identity-federation credential
  mode, Teams channel, installation and intended personal chat. A custom-upload
  option or successful local listener is not proof of these.
  This command does not register/install apps, change tenant policy/consent, use
  Graph, or work around blocked authentication. See [deployment Gate 0](deployment.md#gate-0--trusted-identities-and-operator-authority).
- Provide an approved, externally managed **HTTPS** messaging frontend ending in
  exact `POST /api/messages`. Preserve Authorization and original JSON; disable
  request-body/auth-header access logs, transparent retries and redirects. Restrict
  all other paths. The Node listener is HTTP, **not public TLS**; do not expose it
  directly to the Internet. Proxy trust, limits and upstream transport are operator
  prerequisites, not provisioned by capture.
- Stop/quiesce the normal receiver and its public route before routing to setup.
  Never run capture alongside normal intake for the same bot. Do not mount the
  normal runtime PVC, Orka credentials, or initialized stores into capture.
- Use a trusted local filesystem: a **new dedicated directory**, owned by the
  process UID, mode `0700`, with trusted nonsymlink ancestry. Ancestors must be
  root/current-UID owned and not group/world writable; root-owned sticky `/tmp`
  is supported. Challenge and output parents must each meet the private-directory
  rule. Symlink components, hard-linked input, FIFOs and unsafe modes are refused.
  This is not confinement against root/same-UID adversaries or a guarantee for
  network filesystems, power loss, or hostile mount changes.

## Prepare a fresh attempt privately

Build with Node >=24: `npm ci && npm run build`. Use a fresh shell/process
containing only bot credentials and setup settings, not a reused normal runtime
environment. The CLI does not load `.env` automatically. Supply these through a
secret manager or protected local environment workflow; never paste values into
chat, shell history, tracing, tickets, or committed files:

| Required variable | Meaning |
| --- | --- |
| `TEAMS_APP_ID` | Exact bot OAuth application/client GUID |
| `TEAMS_TENANT_ID` | Exact tenant GUID, no `common` inference |
| `TEAMS_CLIENT_SECRET` | Bot client-secret value, not its ID, in default/explicit `client-secret` mode only |
| `SETUP_CHALLENGE_FILE` | Absolute path to the new private challenge file |
| `SETUP_CAPTURE_FILE` | Absolute path to an **absent** candidate JSON file |

| Optional variable | Default / bounds |
| --- | --- |
| `SETUP_HOST` | `127.0.0.1`; explicit IPv4/IPv6 address |
| `SETUP_PORT` | `3978`; integer 1–65535 |
| `SETUP_TIMEOUT_MS` | `600000` (10 minutes); 1000–900000 (15 minutes) |

For explicit certificate mode, omit `TEAMS_CLIENT_SECRET` entirely and set
`TEAMS_CREDENTIAL_MODE=certificate`, `TEAMS_CERTIFICATE_FILE` and
`TEAMS_PRIVATE_KEY_FILE`. The matching private pair is validated before the
artifact opens, in a separate dedicated credential directory. Capture uses a
deny-only SDK token callback and never constructs an MSAL client or tests tenant
authentication. See [certificate files and host/Docker configuration](certificate-auth.md),
including ambient SDK secret/managed-identity refusal. The commands below show
legacy secret mode; use that guide's mount/env substitutions for certificate mode.

For explicit [managed-identity federation](managed-identity-auth.md), omit secret
and certificate settings and supply `TEAMS_CREDENTIAL_MODE=managed-identity-federation`,
`TEAMS_MANAGED_IDENTITY_CLIENT_ID` and `TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID`.
Optional `TEAMS_MANAGED_IDENTITY_HOST=azure-container-apps` uses the
[explicit local platform contract](table-runtime.md#aca-supported-local-endpoint-subset);
omitted/`imds` preserves VM/ACI behavior. Preparation is structural only, with no
credential files. Setup uses the same deny-only callback and does not contact
IMDS/ACA or construct a CCA. It cannot prove
host UAMI assignment, FIC acceptance or outbound acquisition. The six-field
artifact and dual incoming JWT verification remain unchanged.

CLI rejects `ORKA_*`, `INGRESS_*`, `OUTBOUND_*`, `DELIVERY_DB`,
`TEAMS_RECIPIENT_IDS` and `TEAMS_SERVICE_URLS`, even when empty/disabled. Do not
copy a normal serve environment and remove only its database path.
`NODE_TLS_REJECT_UNAUTHORIZED=0` is refused, including changes during verification.
There is no CLI/cloud/JWKS/auth bypass or managed-identity fallback.

Choose a NEW absolute path beneath your existing trusted parent (replace the
operator path below). Generate **16 random bytes afresh for every attempt** using
Node crypto, writing directly to a new `0600` file—never stdout or a code literal
in argv. This preparation refuses an existing directory/file rather than repairing
or overwriting it:

```sh
node --input-type=module -e '
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
try {
  const directory = "/private/teams-setup-attempt";
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(directory + "/challenge", "orka-setup:" + randomBytes(16).toString("hex"), { mode: 0o600, flag: "wx" });
} catch {
  console.error("Private setup preparation failed"); process.exitCode = 1;
}'
```

`/private` here is an **operator-supplied existing trusted parent**, not a directory
created by this guide. Do not reuse the example attempt name after a failed run.
The challenge is exactly 43 ASCII bytes: `orka-setup:` and 32 lowercase hex digits,
with **no newline**. That format alone cannot prove entropy or freshness; the
operator's new cryptographic generation is essential. Never reuse an old code.
Read the file in a trusted **local editor**, not terminal output, and keep the code
private except for manually sending it in the intended Teams chat below. Do not
put credentials or other secrets into that chat.

## Host command

After privately supplying the bot identity and selected credential settings, select the private paths:

```sh
SETUP_CHALLENGE_FILE=/private/teams-setup-attempt/challenge \
SETUP_CAPTURE_FILE=/private/teams-setup-attempt/candidate.json \
npm run --silent setup:capture
```

Only fixed lifecycle messages reach stderr; stdout is empty. Wait for
`teams-setup: listening`, then manually send **exactly the fresh code** as a new
plain-text message in the intended bot's **personal** Teams chat. No trimming,
case folding, mention removal, substring matching or stale-code acceptance occurs.
Unsupported authenticated messages and wrong codes get a fixed `200 ignored`
and write nothing. Missing roles are legitimate candidates; explicit bots/skills,
self messages, edits/invokes and group/channel chats are not selected.

Both the strict public Bot Framework JWT guard **and independent SDK verification**
must pass before selection. The configured tenant must be asserted in the body,
every supplied tenant must agree, and the raw channel must be `msteams`. The actual
recipient and signed service URL must fit the unchanged normal receiver policy.
A valid SDK signature and challenge correlation do not prove humanity, ownership
of an unknown recipient mapping, or that the configured credential can acquire a token.
There is no health endpoint or provider reply; the HTTP ACK is not an Orka admission.

Wait for `teams-setup: saved` and exit **0**. That means the private candidate is
durably published and SDK work drained. `teams-setup: failed` and nonzero exit cover
configuration/startup errors, expiry, cancellation and filesystem failures, without
printing paths, code, raw errors, tokens or identities. SIGINT/SIGTERM stop intake
and drain; they do not force exit. The window bounds admission, not uncancellable
SDK key I/O or blocking filesystem calls. Do not mistake a client timeout for a
drained process.

## Container alternative — host-mounted output

Build the existing image; it already includes the compiled setup entrypoint:

```sh
docker build --tag orka-gateway-teams:local .
```

Use the same freshly prepared host directory. It and its challenge must be owned
by **UID1000**, matching the image, with `0700`/`0600` modes. If your host UID is
not 1000, have the authorized operator provision a NEW appropriately owned folder;
do not widen permissions or recursively repair/chown existing data. No runtime
PVC, normal configuration, Orka Secrets or TLS private key enters this container.

Override the image's normal ingress entrypoint explicitly. Replace the mount's
operator-owned host path; `--env NAME` passes already privately supplied bot
variables without putting their values in argv:

```sh
docker run --rm --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --mount type=bind,src=/private/teams-setup-attempt,dst=/capture \
  --publish 127.0.0.1:3978:3978 \
  --env TEAMS_APP_ID --env TEAMS_TENANT_ID --env TEAMS_CLIENT_SECRET \
  --env SETUP_HOST=0.0.0.0 --env SETUP_PORT=3978 \
  --env SETUP_CHALLENGE_FILE=/capture/challenge \
  --env SETUP_CAPTURE_FILE=/capture/candidate.json \
  --entrypoint node orka-gateway-teams:local /app/dist/setup/main.js
```

The host port remains loopback; route to it only from the approved HTTPS frontend.
If that frontend is elsewhere, the operator must supply a protected verified
upstream topology rather than publicly publishing raw Node HTTP. Do not use the
normal V1 service, normal runtime probe, database init commands, a restart policy,
or a Kubernetes Job with an unretrievable `emptyDir`. Host-mounted output survives
container removal. Wait for listening, send the exact code, and wait for saved/exit
as above. Do not use `docker inspect` environment dumps or collect raw request logs.

## Inspect the candidate, then configure normal operation

After exit, open `candidate.json` in a trusted local editor. It contains **only six
strings**: `appId`, `tenantId`, `recipientId`, `serviceUrl`, `senderId`,
`conversationId`. No text/code, activity ID, display label, timestamp, token,
header, reply target or full activity is retained.

Verify all six values against the intended bot, tenant, person and personal chat;
challenge correlation is only evidence for operator review. Then update **private
copies** of the existing receiver/Orka configuration:

- `appId` / `tenantId` must agree with the already trusted bot configuration.
- `recipientId` → an explicit entry in `TEAMS_RECIPIENT_IDS`.
- `serviceUrl` → an explicit canonical entry in `TEAMS_SERVICE_URLS`; keep exact
  path case/trailing slash, no query/userinfo/nonstandard service port.
- `senderId` → Orka binding `senderPolicy.allowedSenderIds`, not a display/AAD ID.
- `tenantId` / `conversationId` → binding `match.accountId` / `match.contextId`.
  The existing Orka CRD **requires contextId**; it is not a wildcard.

Nothing is automatically authorized or applied. Close/quiesce setup routing,
confirm capture has fully exited, reconcile pending transport retries, and only
then proceed with [the existing normal deployment gates](deployment.md), including
explicit first-time storage initialization after identity review. For an existing
runtime, never reinitialize its stores. Registration/installation prerequisites
may need to be completed with separate approval **before** capture, rather than
following the numbered deployment gates as a blind execution script.

Do not reuse the challenge message for normal Task validation. A lost HTTP ACK or
provider replay can cross the mode switch and reach the normal receiver; there is
no shared replay ledger with capture. Quiesce/reconcile those messages before
normal intake, then use a **new ordinary authorized message** for separately
approved live Task/reply validation. This guide does not claim that validation.

## Publication and failure handling

Capture reserves at most one candidate. It snapshots the private challenge once;
changing that file during a run does not select a new code. The writer exclusively
creates a same-directory `0600` temp, writes only the six-field projection (maximum
4096 UTF-8 bytes), fsyncs it, checks the active deadline/request and directory/file
identities, and hard-links it to the absent final name **without overwrite**. It
then unlinks only its proven-owned temp and fsyncs the directory. Normal success
leaves a regular current-UID `0600` file with one hard link, before the positive ACK.

An existing output—including a dangling symlink, hard link or directory—is refused
before listening without reading/adopting its bytes. Do not overwrite, delete or
repair a previous candidate to make startup pass. Failure after publication or an
ambiguous filesystem result preserves evidence, possibly both final and temp;
nonzero exit does **not** prove no file was published. A deadline/cancellation can
race publication or lose the ACK; a committed file is never erased to hide that.
Inspect privately, stop and investigate, and use a **new directory and new code**
for any separately approved retry. There is no reset, recapture, cleanup/adoption
API or hard-real-time filesystem guarantee.
