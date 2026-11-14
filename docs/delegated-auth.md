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
controller that supports [gateway task passes](https://github.com/orka-agents/orka/blob/a48944de19c91b4c36dbaa0b04aab12fc9117eab/docs/gateway-task-passes.md).
Child Tasks, native workers and GitHub linking are not supported. Group targeting,
silent-card behavior, browser sign-in and Work IQ still need live validation;
offline fixtures do not establish that the installed Teams client or provider works.

## Operator configuration

Use `serve-registry` with V3 storage, group policy and the connection directory.
The bot credential mode must be `managed-identity-federation`; no OAuth client
secret is accepted for this path. Supply all four settings together:

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
URI and route that origin to this receiver. The only browser endpoints are
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
uncertain responses are not resent. These query tools do not add a write/replay
ledger or bypass Orka's approvals. Future write tools need durable reservation
before the provider effect and must never replay uncertain writes.

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
