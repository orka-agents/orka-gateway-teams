# Teams SSO and account custody

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

This provides sign-in and custody, **not delegated tool execution in Orka**.
Browser fallback/callback, authorization-code cache renewal, task grants and
GitHub linking are not implemented. The exchange card deliberately has no dead
browser sign-in button. A failed SSO exchange requires a fresh request/card;
there is no browser workaround in this version. Group targeting and silent-card
behavior still need live validation with the installed Teams client.

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

## Lifetime, restart and disconnect

Challenges expire after ten minutes. The exchange owner is persisted before
OBO; an interrupted exchange cannot be silently resumed by a new process.
Access tokens are encrypted durably. SSO assertions stay only in process memory,
for at most ten minutes or their own expiry, with bounded cache eviction. They
are not a durable refresh credential. After restart, an expired access token
needs fresh SSO. There is no unattended-renewal promise for OBO.

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
not roll back against that directory. Preserve the account key, Tables and V3
history; do not delete/reset stores as a rollback or duplicate-delivery workaround.
