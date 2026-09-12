# Explicit managed-identity federation

This mode authenticates the **existing bot application** using a specifically
assigned user-assigned managed identity (UAMI) and an approved federated identity
credential (FIC) on that application. Keep the existing `TEAMS_APP_ID`, tenant,
Teams registration, channel and routing. The UAMI is not a replacement bot
registration. Client-secret and certificate modes remain available to other
operators; there is no automatic credential fallback or policy bypass.

## Qualification and operator prerequisites

Full token acquisition supports the fixed **Azure Linux VM / Azure Container
Instances (ACI) IMDS contract only**. The exact UAMI must already be assigned to
the approved host, in the same tenant as the existing bot application. An
authorized operator must have configured the application's FIC with:

- Issuer: `https://login.microsoftonline.com/<tenant-guid>/v2.0`.
- Subject: the UAMI's **principal/object ID**, not its client ID.
- Audience: `api://AzureADTokenExchange`.

App and tenant/FIC must refer to the same existing corporate identity in a real
deployment. Examples and tests here use synthetic GUIDs only. This mode does not
grant application roles, Teams installation rights, Graph/user permissions, or
consent. Those approvals and any tenant policies remain authoritative.

Azure Container Apps / App Service environment endpoints, AKS projected token
files, local Azure CLI login, system-assigned/default identity selection and
`DefaultAzureCredential` are **not supported**. Do not expose host IMDS to untrusted
code or unrelated principals: access to that identity is a privileged boundary.
A laptop can validate configuration and run acquisition-free setup, but cannot
prove host assignment or use its CLI login for outbound sends.

A bounded live Linux ACI test exercised the bundled Node 24.2.0 credential provider
and public SDK token decoder with the platform environment intact. It verified
MI-to-existing-app Bot Framework token issuance and cached app-token reuse: two
IMDS requests and one Entra exchange. This was **credential-provider qualification,
not deployment of the full gateway image**. Live Teams receive/send, persistent
storage and HTTPS hosting remain separate gates; offline Docker startup/replay
does not establish them.

## Configuration

Supply the existing bot `TEAMS_APP_ID` and `TEAMS_TENANT_ID`, plus:

| Variable | Requirement |
| --- | --- |
| `TEAMS_CREDENTIAL_MODE` | Exactly `managed-identity-federation` |
| `TEAMS_MANAGED_IDENTITY_CLIENT_ID` | Explicit UAMI client GUID; different from the bot app ID |
| `TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID` | Explicit UAMI principal/object GUID, matching the FIC subject |
| `TEAMS_CLIENT_SECRET` | Absent, not empty |
| `TEAMS_CERTIFICATE_FILE`, `TEAMS_PRIVATE_KEY_FILE` | Both absent, not empty |

Both MI IDs are required and compared canonically as GUIDs. Existing app/tenant
configuration representations and opaque Teams identities are preserved. Unknown
modes, partial/empty pairs and mixed credential fields fail closed. Other modes
reject the two `TEAMS_MANAGED_IDENTITY_*` variables, including empty values.

This mode also rejects the SDK's ambient `CLIENT_SECRET` and
`MANAGED_IDENTITY_CLIENT_ID`, and alternative-platform settings
`IDENTITY_ENDPOINT`, `MSI_ENDPOINT`, `MSI_SECRET` and `AZURE_FEDERATED_TOKEN_FILE`,
even when empty. The application does not clear them or infer another authentication
method. Linux ACI also injects `IDENTITY_HEADER` without an alternative endpoint;
that variable is tolerated, left untouched, and never read into configuration or
forwarded to IMDS, Entra or Teams. It does not select credentials or relax any of
the other checks. Use an approved environment.

For illustration only, these are **synthetic**, nonfunctional identities:

```sh
TEAMS_CREDENTIAL_MODE=managed-identity-federation \
TEAMS_MANAGED_IDENTITY_CLIENT_ID=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
npm start
```

Real serve still requires the reviewed app/tenant, routing allowlists, directional
Orka credentials, initialized private stores and externally managed HTTPS from
[the runtime guide](../README.md#run-durable-ingress). Never paste real credentials
in argv, logs, chat or source. Do not substitute either UAMI ID for a Teams sender,
recipient or conversation ID.

## Setup and containers

For [one-shot setup capture](setup-capture.md), supply the same three MI settings
in a clean bot/setup-only environment and run `npm run --silent setup:capture`.
No UAMI token is requested: structural preparation has no filesystem/network I/O,
and setup uses the SDK's public deny-only token callback without constructing a
CCA. Incoming authentication still requires both JWT verifications and captures
only the same six candidate strings. Setup cannot prove that IMDS, host assignment,
FIC or outbound app authentication works. Ingress-only serve also denies acquisition.

For the setup guide's Docker command, remove `--env TEAMS_CLIENT_SECRET` and add
these arguments before the image name, passing already supplied values:

```sh
--env TEAMS_CREDENTIAL_MODE
--env TEAMS_MANAGED_IDENTITY_CLIENT_ID
--env TEAMS_MANAGED_IDENTITY_PRINCIPAL_ID
```

There is no credential-file mount for this mode. Keep the setup entrypoint override
`--entrypoint node` with `/app/dist/setup/main.js`, private capture mount and
read-only/nonroot container restrictions. Normal serve uses the existing default
entrypoint and separate initialized storage. Actual outbound acquisition requires
that the qualified host/container can reach its assigned UAMI through fixed IMDS;
there is no configurable metadata endpoint or proxy escape hatch.

Default Kubernetes assets remain **client-secret mode**, unchanged. There is no
MI Kubernetes overlay, new cloud resource, persistent host or public HTTPS deployment
in this slice. ACI/Azure Files does not automatically satisfy POSIX/SQLite locking,
durability or exclusive-owner requirements. Hosting, persistent storage and HTTPS
qualification require a separate deployment design; do not infer them from readiness.

## Acquisition, cache and shutdown

Full mode lazily uses one MSAL 5.6.0 confidential client through the Teams SDK's
public `App({ token })` option, never the SDK managed-identity option. The callback
accepts only the public Bot Framework `.default` scope (or its singleton array)
and configured tenant. The SDK's selected public credentials are checked before
and after initialization; library `botToken` overrides are forbidden here.

Each eligible acquisition makes an unpooled native HTTP GET to
`169.254.169.254/metadata/identity/oauth2/token`, with `Metadata: true`, API version
`2018-02-01`, resource `api://AzureADTokenExchange`, and explicit `client_id`.
There is no body, environment endpoint/proxy, DNS discovery, redirect or retry.
The plaintext exception is confined to this fixed Azure link-local address.
Responses require complete UTF-8 JSON, at most 64 KiB, with 16 KiB header and
five-second overall limits. Settlement waits for the actual owned request to close.

The bounded canonical JWT syntax guard runs before assertion use. The payload must
have matching tenant (`tid`), UAMI principal (`sub`), exact tenant `/v2.0` issuer,
and a finite numeric `exp` more than ten seconds in the future. The audience may
be the requested URI or its documented public-cloud v2 resource GUID
`fb60f99c-7a34-4190-8149-302f77469936`; no other audience is accepted. The request and
FIC audience remain the URI. No unproven `azp`, `nbf`, or response metadata fields
are required. This decoding is a safety check of the trusted IMDS response, not
local signature verification: **Entra validates the assertion cryptographically**.

MSAL's public `clientAssertion` callback exchanges it through the existing fixed
public Entra HTTPS boundary: verified TLS, bundled metadata, disabled region
routing, generated correlation-query guard, no GET/discovery/proxy/redirect/retry,
five-second request deadline, bounded response and OAuth/JWT checks **before**
MSAL can cache it. Returned/cached token expiry and configuration/TLS usability
are checked again. Arbitrary MSAL and transport errors are discarded, not logged.
Raw assertions and app tokens stay in process memory only; MSAL may retain its
latest assertion. No immediate erasure or JavaScript string zeroization is promised.

**MSAL resolves the assertion before its final-token cache lookup.** Consequently,
every public CCA acquisition fetches a fresh IMDS assertion, even when the final
app token is cached: two sequential eligible calls produce **two IMDS GETs and one
Entra POST**. Only MSAL's existing in-memory final-token cache is used; there is no
extra gateway cache, private cache inspection or placeholder assertion. Azure IMDS
may have its own cache, outside this gateway's control.

The existing sender shares outstanding acquisition across concurrent removable
waiters. Two sequential five-second legs can exceed its nine-second send budget;
such a cold acquisition is pre-effect retryable with **no Teams POST**. Cancellation
or deadline removes the caller, not necessarily the underlying work: delayed IMDS
can still proceed to Entra, but can never cause a late Teams send. Shutdown drains
both actual legs and journal settlement before closing either store. No new queue,
silent retry, schema change or protocol change is introduced.

## Library tests

`prepareManagedIdentity(config)` returns only `assertUsable()` and one-use
`createToken(dependencies?)`. It snapshots structural identity; no private material
or MSAL object is exposed. `ReceiverDependencies.managedIdentity` accepts only
`imdsRequest` (native Node request boundary) and `entraNetwork` (public MSAL
`INetworkModule`) for trusted library tests. Neither is exposed by the CLI.

```sh
node --import tsx --test test/managed-identity-config.test.ts test/managed-identity-token.test.ts test/managed-identity-runtime.test.ts
npm run check
npm run test:container
```

Tests use synthetic IDs/assertions and real loopback HTTP, real MSAL, real SDK
credentials/authentication, SQLite and owned-request drain. They never use live
credentials or the legacy `botToken` override as MI integration proof.
