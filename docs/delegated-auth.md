# Teams sign-in and account custody

Registry mode can require the sender to sign in before admitting work. Discovery
and `use <target>` need no Work IQ consent. Without the configuration below,
existing admission is unchanged. The plain `serve` command does not enable SSO.

A connected chat sends an OAuth exchange card when the sender has no usable
account. Group cards target that sender's Teams recipient; they never fall back
to a room-wide send. The authenticated `signin/tokenExchange` invoke must carry
an explicit matching channel-data tenant. Its signed access token must have the
gateway audience, tenant issuer, `access_as_user` scope, valid lifetime and the
same tenant/object ID as the activity sender. It is not an ID token. These checks
precede OBO and persistent exchange effects.

OBO requests only `api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask` through the
configured managed identity's federated client assertion. Bot Connector and
storage credentials remain separate. Sign-in success asks the sender to send
their request again; it never starts the earlier request. Repeated invokes do
not repeat a completed exchange. Cards and completion messages use durable
send reservations; uncertain sends are not automatically repeated.

With a configured browser origin, personal chat offers a private sign-in card.
Group chat first attempts sender SSO on its targeted OAuth card, with a private
sign-in button when SSO or consent fails. Without that origin, the SSO-only card
is unchanged. Root Tasks can query Work IQ through the gateway with an Orka
controller that supports [gateway task passes](https://github.com/orka-agents/orka/blob/8724b86afb88cbf5a12292483e86d45d00ccd694/docs/gateway-task-passes.md).
Child Tasks and native workers are not supported. GitHub account linking is an
optional, separate flow below, with named GitHub tools on supported root ACP Tasks. Group targeting,
silent-card behavior, browser sign-in and Work IQ still need live validation;
offline fixtures do not establish that the installed Teams client or provider works.

## Operator configuration

Use `serve-registry` with V3 storage, group policy and the connection directory.
The bot credential mode must be `managed-identity-federation`; no OAuth client
secret is accepted for the Microsoft path. Supply all four settings together:

| Setting | Meaning |
| --- | --- |
| `SSO_ACCOUNT_TABLE` | Existing Azure Table, distinct from the directory and V3 table |
| `SSO_KEY_FILE` | Absolute private file containing 64 lowercase hex characters (32 bytes), optionally followed by a newline |
| `SSO_API_URI` | The exposed gateway API resource URI, beginning `api://` |
| `SSO_CONNECTION_NAME` | OAuth-card connection name, using letters, digits, dot, underscore or hyphen |
| `SSO_PUBLIC_ORIGIN` | Optional canonical HTTPS origin such as `https://signin.example.com`, with no trailing slash, path, credentials, query, fragment or explicit port |

Provision the Table and mount a randomly generated encryption key separately
from storage. Keep the key stable across restarts. The key file and its parent
must pass the same ownership/no-follow checks as other private registry files;
the file must be owner-only. It is read once before datastore ownership.
This command neither creates the Table nor changes app registrations, federation,
Teams preauthorization, consent, manifests or deployments. Configure the app's
v2 access tokens, exposed scope and matching manifest separately.

Account rows are scoped by app, tenant, Microsoft object ID and Work IQ provider.
AES-256-GCM binds ciphertext to its partition, row, schema and generation.
Conditional writes and exact read-back protect publication; an ACK is not proof
that a write won. Registry mode remains a single writer under the existing
combined V3 authority; account storage adds no independent failover owner.
There is no automatic key rotation or historical-key fallback. A missing/wrong
key or unavailable/corrupt Table fails closed, not into another identity.

## Private browser fallback

Register exactly `<SSO_PUBLIC_ORIGIN>/oauth/callback` as the app's Web redirect
URI and route that origin to this receiver. The Microsoft browser endpoints are
`GET /signin?challenge=<id>` and `POST /oauth/callback`. Neither is available
without the origin setting. Shipped proxies forward these fixed paths; the
receiver still refuses them until configured. Request Host/forwarded headers and browser input
never select the callback destination. The gateway makes no registration edits.

The card carries only the challenge link. Opening it repeatedly prepares the
same encrypted state, nonce and PKCE verifier without consuming the attempt,
so a link preview cannot burn it. The authorization request uses S256,
`response_mode=form_post`, `openid profile offline_access` and the delegated
Work IQ scope. App authentication uses federation, not a client secret.

The callback consumes state with a conditional write before redeeming a code.
It checks the original sender, exact conversation and sign-in control, current
policy and Binding, then validates the signed ID token's issuer, audience,
expiry, tenant, nonce and sender object ID before saving tokens. A different
room member cannot link their account through someone else's card. A browser
attempt can supersede failed/in-flight SSO, but cannot take over a committing
or completed sign-in. Publication is fenced before changing account tokens.

Duplicate callbacks never redeem again. Consent refusal also consumes the
attempt; send the request again for a new card. Expired, interrupted or uncertain
attempts are not retried automatically. A successful page and best-effort
sender notification ask for a resend; no earlier request becomes work. Browser
sign-in results use fixed text, no-store/no-referrer headers and no credentials.
Early global overload/timeout refusals use the receiver's generic JSON response.
Public browser handlers borrow only a small bounded share of receiver capacity.
Partial completion counts as success only with an unexpired credential saved by
that exact challenge, not merely an older renewable account. Once publication is
confirmed, a slow or uncertain notification cannot turn browser success into a
408. The notification remains bounded and drains before receiver shutdown.

## Optional GitHub account linking

With the settings below, send `link github` in an authorized connected personal
or group chat. Its targeted sign-in card first verifies the same Microsoft
sender using the existing signed-ID-token/nonce flow and Work IQ consent.
That temporary Microsoft token result is discarded: linking GitHub never
changes the sender's Work IQ account. Only then does the same browser continue
to the gateway-owned GitHub App's web authorization flow with S256 PKCE and
`offline_access`. GitHub App permissions, not OAuth `repo` scopes, govern access.

| Setting | Meaning |
| --- | --- |
| `GITHUB_CLIENT_ID` | GitHub App client ID (not the App ID) |
| `GITHUB_CLIENT_SECRET_FILE` | Absolute private mounted file containing the GitHub App client secret, optionally followed by a newline |

Supply both settings together, in addition to the complete SSO configuration
and `SSO_PUBLIC_ORIGIN`. The secret file uses the checked registry-file boundary
(owner-only, no symlinks/hardlinks, trusted parent) and is read before ownership.
It must differ from the account encryption key and every directional/controller
credential. The config snapshot contains only its path, not its contents.
`GITHUB_CLIENT_SECRET` is not accepted. No installation-token key is used.
Absence of GitHub settings preserves Microsoft-only behavior.

The only additional browser endpoint is `GET /github/callback`. Both shipped
proxies forward its success and denial query strings and browser cookie, while
retaining their existing path/method restrictions. The callback requires the
one-use encrypted state plus browser binding established before leaving for Microsoft.
The initial `__Host-github-ms` cookie is random, Secure, HttpOnly, Path=/,
SameSite=None (required for Entra's cross-site form POST), and expires within ten
minutes. Only its digest is stored with the attempt. Missing, wrong, or another
browser's cookie is rejected before state consumption or Microsoft redemption;
old unbound attempts fail closed. Same-browser repeat starts reuse the binding.
After Microsoft proof the continuation uses a separate `__Host-github-link` cookie (Secure, HttpOnly, SameSite=Lax, Path=/, at most ten minutes).
Missing/wrong cookies cannot consume the state. Correct callbacks consume it
conditionally before token redemption, including consent denial. A verified
continuation can survive a drained restart with its original browser cookie;
a consumed attempt never redeems again. No Host header or browser parameter
chooses a provider, callback destination or arbitrary redirect.

Authenticated `GET https://api.github.com/user` supplies the immutable numeric
GitHub user ID; login and email are not identity. The encrypted provider-specific
account stores that ID, access/refresh tokens and both expiries together. Relink
publishes a new generation; successful refresh atomically rotates the whole pair
at the same generation after verifying the same ID. Before an external refresh,
a durable renewal marker retires permission to reuse that refresh token. Expired
refresh credentials, invalid/revoked responses, uncertainty or a retained marker
invalidate the generation; no spent token is automatically retried. Disconnect
or a newer link always fences old publication. Send `disconnect github` to clear
only this provider; duplicate disconnects never clear Work IQ.

**Operator setup and later live check:** Create a GitHub App with
expiring user access tokens, Web callback URL
`<SSO_PUBLIC_ORIGIN>/github/callback`, and a separately mounted client secret.
Install it only for selected repositories, with Metadata, Contents and Issues
read access initially. Leave the webhook inactive and **Request user authorization
(OAuth) during installation** disabled: ordinary installation/setup callbacks are
not this linking flow. No webhook secret, installation-token private key or new
Microsoft tenant setting is required by this flow. Keep the existing Microsoft
Web callback `<SSO_PUBLIC_ORIGIN>/oauth/callback`.

Then, using the actual Teams client/browser or popup, verify targeted cards,
Microsoft sender mismatch refusal, same cookie-jar continuity across Microsoft
and GitHub, successful link/relink, denial and disconnect. Offline HTTP/HTTPS
fixtures prove only synthetic protocol behavior, not live provider or Teams UX.
Enable the named tools below only on supported root ACP Tasks. Keep Issues read
unless enabling `github-create-issue`, which needs Issues write; enable Pull requests
write only for `github-create-pull-request`. Contents write is not needed: this
implementation never creates branches or writes files. App permission changes and
real GitHub writes require operator setup and a live check, not just offline fixtures.

**Rollback:** drain armed GitHub control sends before reverting to binaries
unaware of the new provider reply kinds. Older directory codecs cannot read
retained GitHub controls, even after drain; use a compatible binary for that
directory rather than deleting/resetting it. Work IQ account/challenge keys and
parsing remain unchanged. Older binaries ignore separate GitHub account rows,
but cannot serve their callbacks or clear a retained renewal marker. New mixed-provider
grant fields and encrypted write records also require a compatible reader. Drain/reconcile
pending Tasks and writes before changing versions; never reset an uncertain reservation.

## Root Task tools

Every SSO-enabled registry target requires `taskPassTokenFile`, a separate private
controller credential file with the same ownership checks as ingress/callback
files. Its bearer must be 1–4096 ASCII characters from letters, digits,
`._~+/-` and optional trailing `=`. All controller, ingress and callback bearers
must differ across all targets. Non-SSO registries do not accept this field.
Configure Orka's controller-only credential file with the target Gateway UID,
this bearer and the operator-pinned gateway HTTPS origin. It is not the delivery
bearer and must not be backed by storage worker service accounts can read.
Rotation requires a drained restart at both ends.

Admission saves an encrypted grant before admitting work. It binds the sender,
Work IQ account generation, target routing identity, event and `workiq` tool.
With GitHub configured, the same Work IQ-owned grant also freezes the GitHub
generation and all four supported GitHub tool names. Generation0 means unlinked:
a mixed-tool Agent can still use Work IQ, but that Task cannot adopt a later
GitHub link. A positive frozen GitHub generation must remain usable for issuance
and calls. GitHub calls select only that sender's original generation; no parallel
provider grant, other user's credential or installation token is substituted.
The reference also includes the winning inbox candidate's opaque reply target.
Redelivery gets a fresh candidate and cannot give an older stored event new
authority; the relay always uses the preserved original candidate. Grant lookup
finishes before the inbox's final forwarding eligibility check and synchronous
native handoff. Library callers must use an `IngressPort` for delegated clients;
`createIngressPort` adapts an already-owned SQLite store. The legacy synchronous
claim interface is refused before claiming or looking up delegated authority.
Only the Orka wire request becomes `eventType: delegatedText` with nonsecret
`metadata.gatewayGrantRef`; the V3 inbox format stays unchanged. Allow that key
in the GatewayClass. Old queued events without grants are permanently blocked,
not adopted into delegated authority. Drain or reconcile pending work before
enabling this mode, disabling SSO, or changing the target routing identity.
An older controller rejects delegated events; there is no plain-text fallback.

On the shared outbound listener, `POST /v1/task-passes` authenticates only the
particular target's controller bearer. The body is exactly:

```json
{"protocolVersion":"orka.gateway.v1","grantRef":"<event-reference>","namespaceUID":"<namespace-uid>","gatewayUID":"<gateway-uid>","taskUID":"<task-uid>","tools":["workiq"],"deadline":"2026-01-01T12:00:00Z"}
```

The controller's first binding is trusted without independent Kubernetes reads.
Namespace, Gateway and Task UIDs, tool set and deadline freeze durably; a changed
binding is refused with `grant-binding-conflict`. Restart permits only the same
binding and generation. Pass replies contain only `pass` and `expiresAt`; random
passes live in process memory, last at most five minutes or the earlier deadline,
and can be used once. Restart discards every pass.

`POST /v1/task-tools/workiq` accepts only that pass as bearer, never a controller
or callback credential. Name the Orka Tool `workiq`, set
`http.gatewayTaskPass: true` and its fixed HTTPS URL to
`<gateway-origin>/v1/task-tools/workiq`; do not configure other auth or headers.
Arguments are closed JSON:

```json
{"question":"What meetings do I have today?","location":{"timeZoneOffset":-480,"timeZone":"America/Los_Angeles"}}
```

`question` is nonempty and at most 32768 UTF-8 bytes. `location` is optional;
include it for time-sensitive questions, with an IANA time zone and integer
UTC offset in minutes from -840 through 840. Arguments cannot choose a sender,
credential, destination, headers or provider conversation. Successful output is
`{"text":"..."}` from completed Work IQ text artifacts only. Other states,
unsupported responses and transport failures return fixed `tool-unavailable`;
unusable account generations return `signin-required`.

Each call checks the frozen grant and current account generation, renews only
that account when possible, and revalidates owner authority before native send.
Tokens stay inside the gateway. The destination is fixed to
`https://workiq.svc.cloud.microsoft/a2a/`, using A2A 1.0 `SendMessage` and the
sender's delegated token ([Work IQ API](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/api-overview)).
There are no automatic provider retries, redirects or shared provider contexts;
uncertain responses are not resent. Work IQ remains read-only. GitHub writes use
the durable reservation below and do not bypass Orka's approvals.

Task calls share the outbound listener's 32-handler limit and ten-second absolute
budget, including account reads, lease checks and refresh. Work IQ may exceed that
budget in practice; no live latency result is established. Internal account and
tool concurrency limits may return a fixed refusal rather than queue work.

Orka checks that the root Task is still Running with the same UID and gateway
origin before requesting and sending a pass. Completion and cancellation prevent
new calls through those controller gates, not an independent gateway revocation
channel. Already-started calls may finish. The gateway independently enforces
expiry, frozen deadline, generation, single use and process restart. A compromised
controller can exercise its target's grants; child attenuation is not available.
Accounts and grants borrow the same combined registry V3 owner authority, not a
new failover lease. Shutdown drains tool/provider work before closing that store.

## Named GitHub tools and approved writes

Each Tool must use its exact name and fixed gateway endpoint, with
`spec.http.gatewayTaskPass: true` and no other authentication or headers:

| Tool name | `spec.brokeredToolClass` | `spec.http.url` suffix | Closed arguments |
| --- | --- | --- | --- |
| `github-read-file` | `read` | `/v1/task-tools/github-read-file` | `owner`, `repo`, `path`, optional `ref` |
| `github-list-issues` | `read` | `/v1/task-tools/github-list-issues` | `owner`, `repo`, optional `state` (`open`, `closed`, `all`) |
| `github-create-issue` | `write` | `/v1/task-tools/github-create-issue` | `owner`, `repo`, `title`, optional `body` |
| `github-create-pull-request` | `write` | `/v1/task-tools/github-create-pull-request` | `owner`, `repo`, `title`, `head`, `base`, optional `body` |

For example, the create-issue Tool's spec contains:

```yaml
brokeredToolClass: write
http:
  gatewayTaskPass: true
  url: https://gateway.example/v1/task-tools/github-create-issue
```

Configure the Agent's `spec.coordination.approvalRequiredTools` with **both**
`github-create-issue` and `github-create-pull-request`. In the referenced Orka
version that field is honored only with `spec.coordination.enabled: true` and
`spec.coordination.autonomous: true`. Keep those controller-side approval settings
with the reviewed Agent configuration. The gateway trusts that controller's
approved operation; it does not receive or independently verify an approval flag.
The ordinary Agent tool set may include `workiq` and all four GitHub tools together.
There is no requirement to split providers across Agents. Configure only the
reviewed tools and retain the controller-only pass credential boundary above.

All endpoints are HTTPS POST at the operator-pinned gateway origin. The gateway
uses fixed `api.github.com` REST operations, encoded repository/path segments,
a bounded first issues page (30 items), and no redirects or automatic retries.
REST response bodies are capped at1MiB before projection; OAuth and user-identity
responses retain their64KiB cap.
File reads return only UTF8 text up to32KiB; non-UTF8, directory and larger responses
are refused. Lists return only number/title/state/fixed GitHub URL. Writes return
only number and fixed GitHub URL, wrapped in the existing `{"text":"..."}` result.
PR creation requires already existing head/base branches; same-organization
cross-repository PRs needing `head_repo` are outside this closed argument set.
Owner/repo are bounded ASCII repository components; path is at most1024 UTF8 bytes,
title/ref/head/base256 bytes, and body16KiB. Bodies permit TAB/CR/LF; other controls,
unknown fields and identity/credential/URL/header arguments are refused.

The controller's unique `Idempotency-Key` header identifies each reviewed write.
It is not a JSON argument. The gateway preserves its non-control UTF8 bytes
(up to256), including multibyte keys, and hashes them with the grant reference
and tool. A canonical arguments digest prevents changing arguments under the
same key. Before external POST, an encrypted conditional CREATE reserves the
operation; only its exact winning readback grants one send. A reserved record
means uncertain by default and never permits another POST, including after
restart, transport failure, API5xx, deadline or failed result publication.
Only a durably confirmed, sanitized done result may be returned again without
another POST, after current authority/generation checks. Changed arguments refuse.

Missing/duplicate/invalid operation headers and proven pre-effect argument errors
may return4xx. Write storage lookup failures, prior reservations, revocation of a
possibly used operation, transport uncertainty and lost completion proof return
fixed503/408, never a false no-effect403. This matters because Orka treats other
4xx responses as proven no-effect. Rejected authentication on either named write
URL also returns503, even with no task service available; it grants no access and
cannot prove that an earlier operation had no effect. Read and issuance auth
failures retain401. A single-use pass is not the write replay
ledger: the durable operation key remains authoritative across fresh passes and
process restart. An uncertain operation needs operator reconciliation, not a new
key or an automatic retry. Calls recheck owner, frozen generations, pass expiry
and Task deadline before native handoff. Under the single owner, per-account
mutation guards synchronously fence both providers through native handoff,
including a mutation already pending when the guards register. Selected acquisition
CAS-pins its account row; under the registered guards the other required provider
is also conditionally pinned at the same usable generation, without refreshing
credentials. A late UNKNOWN older conditional write then loses its ETag or is
observed before handoff. Pin conflict or unreconciled uncertainty refuses this call without
automatic retry, a bounded availability tradeoff under concurrency. Sequential
Table reads alone cannot provide that fence; this is not distributed instantaneous
revocation beyond the existing single-owner scope. A provider401 compare-and-invalidates
only the rejected access token's same-generation revision, not a rotated pair.

Output guards cover both providers' access/refresh tokens, the GitHub client
secret, controller/directional credentials and the current pass. Tokens, raw
arguments and provider errors never enter the write record's plaintext fields or
Task output. Reservations/results are encrypted with the existing account key;
retained operation history has no pruning/reset command. Started external calls
may finish despite cancellation; an unknown outcome is not permission to resend.

## Lifetime, restart and disconnect

Challenges expire after ten minutes. The exchange owner is persisted before
OBO; an interrupted exchange cannot be silently resumed by a new process.
Access tokens are encrypted durably. SSO assertions stay only in process memory,
for at most ten minutes or their own expiry, with bounded cache eviction. They
are not a durable refresh credential. After restart, an expired access token
needs fresh SSO unless the account has a browser authorization-code cache.
Browser access and refresh tokens are encrypted in that same account document,
not an MSAL serialized cache. Expired access can renew after restart using the
stored refresh token; rotation is published atomically against the original
account revision. Same-generation SSO preserves an existing browser refresh token.
There is no unattended-renewal promise for an SSO-only OBO account.

Caches become unusable after thirty idle days. Access updates idle time;
expiry is logical, not physical erasure of old Table versions/backups. Operators
own backup retention and secure storage disposal. Challenges, frozen Task grants and generation
tombstones are retained; there is no pruning/reset command.

Send `disconnect` from an authorized personal/group chat to erase the current
credential cache and advance its durable generation. Repeated delivery of that
same message does not repeat the operation. In-flight refreshes publish only
against their original account revision, so disconnect or a newer completion
wins. `invalid_grant` conditionally clears that revision and advances generation;
transient errors do not erase a newer sign-in. Unusable credentials return
`signin-required`, never another sender's account or replayed work. Calls already
started elsewhere may finish; Teams sign-out is not dependable revocation.

Application logs contain fixed categories, never OAuth errors, credentials,
identities or tool content. No tokens enter normalized events, directory control
records or Task envelopes. Platform/access logging needs separate operator review.

**Rollback:** once delegated control records exist, older gateway versions cannot
read their new reply kinds and may stop with a directory corruption error. Do
not roll back against that directory. Browser challenge fields and refresh-token
cache fields also cannot be read by SSO-only binaries: they report account
corruption and may fail ingress. Do not roll back those binaries against extended
account rows. Preserve the account key, Tables and V3
history; do not delete/reset stores as a rollback or duplicate-delivery workaround.
