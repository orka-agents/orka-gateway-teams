# Explicit certificate authentication

Both normal serve and one-shot setup capture support an explicitly selected,
single-tenant **application certificate**. Client-secret mode remains the default.
This is not managed identity, federation, Graph/user authentication, or a tenant
policy exception. Keep the existing bot registration, app ID, tenant and channel.
An authorized operator must approve the credential method and register the
**public certificate only** with that same application. Local validation does not
prove tenant acceptance, registration permissions, or successful live sending.

This certificate authenticates the application to Entra. It is **not** the HTTPS
certificate for `/api/messages`, the outbound V1 frontend, or Orka. Never reuse a
TLS private key or mount the frontend's TLS private key into the application.

## Configuration

Supply the existing `TEAMS_APP_ID` and `TEAMS_TENANT_ID` GUIDs, plus:

| Variable | Certificate mode |
| --- | --- |
| `TEAMS_CREDENTIAL_MODE` | Exactly `certificate`; omission means client-secret mode |
| `TEAMS_CERTIFICATE_FILE` | Absolute, normalized path to one PEM X.509 certificate |
| `TEAMS_PRIVATE_KEY_FILE` | Absolute, normalized path to its unencrypted RSA PEM private key |
| `TEAMS_CLIENT_SECRET` | Must be **absent**, not empty |

In default or explicit `client-secret` mode, `TEAMS_CLIENT_SECRET` remains required
and both file variables must be absent. Unknown modes, partial pairs, mixed
credentials, empty values and ambiguous paths fail closed. Certificate mode also
rejects the SDK's ambient `CLIENT_SECRET` and `MANAGED_IDENTITY_CLIENT_ID`, even
empty. Explicit app/tenant configuration overrides SDK app/tenant defaults; the
runtime checks the SDK's public selected credentials before listening. Never
substitute a dummy secret or clear environment variables inside the application.

## Private files and lifecycle

Use a **fresh dedicated directory**, separate from capture and runtime storage,
owned by the process UID at mode `0700`. Both files must be regular, current-UID
owned, single-link files: private key `0600`, public certificate `0600` or `0400`.
Every ancestor must be a nonsymlink directory owned by root or the process UID,
not group/world writable (root-owned sticky `/tmp` is supported). Symlinks,
hardlinks, FIFOs, devices and oversized files are refused before ordinary opens.
Both files must be in the same dedicated directory, at most 64 KiB each.

Have an authorized credential workflow provision a matching RSA pair of at least
2048 bits (3072 bits is a reasonable new-key choice), with explicit validity and
rotation ownership. A short-lived self-signed development application certificate
can be appropriate **if approved by the tenant**; it need not chain to a public
HTTPS CA. This guide neither generates real credentials nor uploads them. Upload
only the public certificate through the separately approved registration workflow;
never upload, paste, print, commit, or bundle the private key. Keep backups and
access control in the approved secret-management system, not repository artifacts.

Inputs are strict UTF-8 PEM, one certificate and one unencrypted PKCS8 or PKCS1
private key, with only whitespace outside the block. Encrypted keys, PFX, EC,
weak/mismatched RSA, malformed/trailing payloads, noncanonical key encodings,
not-yet-valid and expired certificates are refused. File metadata, no-follow
opened descriptor identity, size and modification stamps are checked across the
snapshot. No paths are repaired or permissions widened by the application.

Normal startup checks credential/database/owner/journal/WAL/SHM name and inode
collisions using **metadata only**, then snapshots the pair before creating the
Orka client or opening either SQLite store. All credential descriptors close in
preparation. Setup snapshots and validates the pair before opening its artifact,
but uses a deny-only SDK token callback: no MSAL client or token request is needed
to capture. Capture still cannot prove that the application credential works.

There is no hot reload. Provision a fresh pair privately, register the new public
certificate with appropriate overlap, drain the runtime, and restart against the
new files before expiry. Replacing files does not rotate an already-running
process. Validity and TLS verification are checked before and after every token
acquisition, including cached results; an expired snapshot cannot keep sending.
No private-key zeroization is promised for JavaScript/MSAL strings. These checks
are not protection against root/same-UID adversaries, hostile mount changes,
network-filesystem semantics or arbitrary process-memory access.

## Host

Build with Node >=24: `npm ci && npm run build`. Supply credentials/settings through
your approved private environment workflow, never command-line secret values.
For example, after provisioning the private directory and existing nonsecret
scope, routing allowlists, directional Orka credentials and stores:

```sh
TEAMS_CREDENTIAL_MODE=certificate \
TEAMS_CERTIFICATE_FILE=/private/teams-app-auth/certificate.crt \
TEAMS_PRIVATE_KEY_FILE=/private/teams-app-auth/private-key.pem \
npm start
```

For setup use the same three certificate settings with `npm run --silent
setup:capture`, in a **separate clean environment** containing only bot/setup
settings. Follow the [setup guide](setup-capture.md) for a new private challenge,
separate capture directory, HTTPS frontend, authenticated capture and manual
six-field review. No normal databases or Orka credentials belong in setup.

## Docker

The image runs as UID/GID `1000:1000`. Have the authorized operator provision the
fresh credential directory/files for UID1000 without recursively changing existing
data. Mount the directory read-only **only into the app**, separately from the
writable runtime/capture directory. Never widen permissions or add `fsGroup` to
make a secret projection pass validation.

For setup, use the setup guide's Docker command but **remove**
`--env TEAMS_CLIENT_SECRET` and add these arguments before the image name:

```sh
--mount type=bind,src=/private/teams-app-auth,dst=/credentials,readonly
--env TEAMS_CREDENTIAL_MODE=certificate
--env TEAMS_CERTIFICATE_FILE=/credentials/certificate.crt
--env TEAMS_PRIVATE_KEY_FILE=/credentials/private-key.pem
```

Keep its explicit `--entrypoint node` and `/app/dist/setup/main.js`, read-only root,
capability restrictions, private writable capture mount and loopback port. For
normal serve, use the same read-only credential mount/settings with the default
image entrypoint, existing privately supplied serve environment and separately
initialized writable runtime mount. Container file variables must use container
paths, not host paths. Preserve the approved HTTPS frontends and private V1 route;
certificate authentication does not secure exposed raw HTTP ports.

`npm run test:container` exercises the actual compiled certificate setup entrypoint
with private host mounts, safe expiry and mixed/invalid credential refusal, as well
as the unchanged default client-secret normal runtime. These are isolated synthetic
tests, not tenant registration, live bot-token acquisition or Teams sending.

## Kubernetes qualification

The checked-in Kubernetes assets **remain client-secret mode**. Their `teams-bot`
Secret reference and default environment are unchanged. A standard projected
Kubernetes Secret uses symlink/ownership/mode conventions incompatible with this
strict loader; simply changing environment variables or mounting that projection
is insufficient.

A certificate deployment requires a separately reviewed operator overlay that
removes `TEAMS_CLIENT_SECRET` and any ambiguous SDK credentials, provisions a fresh
private UID1000 `0700` directory with regular single-link `0600` key and private
certificate files using an approved initializer or compatible CSI private-copy
workflow, and mounts that directory read-only into only the app. The copy source
must not remain accessible to unrelated containers. Preserve startup ordering,
rotation/restart, storage ownership, RBAC and network restrictions. No such overlay
is supplied or Kubernetes-certificate deployment verified here; do not infer that
an arbitrary projection, CSI driver or readiness result satisfies these rules.

## Token and library boundaries

Normal full mode lazily creates one pinned MSAL 5.6.0 confidential client. MSAL
signs PS256 assertions using the computed SHA-256 DER thumbprint (`x5t#S256`) and
owns the in-memory cache. The public SDK `App.token(scope, tenantId?)` callback
allows only `https://api.botframework.com/.default` (or a singleton array) and the
configured tenant; no Graph or caller-selected authority is accepted.

Bundled public metadata and explicit `DisableMsalForceRegion` avoid discovery and
ambient region routing. Only a POST to the fixed public tenant token endpoint is
permitted: native verified HTTPS, no connection pool/proxy/redirect/retry, 5-second
overall budget, 64 KiB response/request and 16 KiB header bounds. The SDK-generated
correlation query is checked and removed before native I/O. Bounded UTF-8 JSON
OAuth success, bearer/JWT shape and expiry are checked before MSAL caching; returned
and cached expiry is checked again. All MSAL logs and raw transport errors are
discarded. Startup failure cannot expose PEM, assertions, tokens or response bodies.

The existing sender shares token acquisition, removes cancelled/deadlined waiters,
fences late sends, and drains actual acquisition before either store closes. A
local deadline is not a hard-real-time guarantee against event-loop/OS stalls.

Library callers can use `prepareReceiver(config, dependencies?).start(sink,
outbound?)` exactly once. Prepare before their arbitrary sink owns SQLite and use
a dedicated credential directory; only normal runtime knows and checks all its
storage paths. `startReceiver` remains the validating direct-call wrapper, not an
already-validated bypass. Trusted tests may inject the public `INetworkModule`
through `certificateNetwork`; there is no production endpoint, region, clock,
cloud/auth CLI override, or legacy `botToken` override in certificate mode.
