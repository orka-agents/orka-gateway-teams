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
is unchanged. This provides sign-in and custody, **not delegated tool execution
in Orka**. Task grants and GitHub linking are not implemented. Group targeting,
silent-card behavior and the browser flow still need live validation with the
installed Teams client; offline checks are not a live qualification.

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
that exact challenge, not merely an older renewable account.

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
own backup retention and secure storage disposal. Challenges and generation
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
