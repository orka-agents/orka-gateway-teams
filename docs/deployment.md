# Deploy the personal Teams gateway

This is **deployment packaging, not a first-time live bootstrap or live demo**.
The supplied single-replica runtime uses the existing image CLI and persistent
stores. It installs neither Orka nor an ingress controller, cert-manager, a bot
registration, or an Agent. Local readiness does not validate Teams credentials.

## Gate 0 — trusted identities and operator authority

**STOP before normal initialization or runtime public exposure unless all required
inputs below are verified for the SAME bot, tenant, Teams channel registration,
and intended personal conversation.** Use independently trusted bindings from an
existing approved deployment, or the separate bounded
[authenticated setup-capture workflow](setup-capture.md) before normal initialization.
It requires approved bot credentials/installation and an operator-managed HTTPS
frontend, a freshly generated private challenge, and explicit review of exactly six
private candidate fields. Capture runs only on a host or explicitly overridden
container with host-mounted output, never the normal runtime/PVC. It performs no
Task, reply, automatic allowlist update or tenant action; live capture is not claimed
by synthetic tests.

Do not infer `28:<clientId>`, borrow IDs from another bot/environment, treat an AAD
object ID as `from.id`, use a proactive global URL as an inbound guarantee, capture
raw activities, enable auth bypass/first-request learning, or invent production
routes. The [identifiers guide][identifiers] says the
channel account address comes from the incoming activity's recipient field;
[proactive messaging][proactive] distinguishes fallback URLs from reply service URLs.

Registration permissions, acceptance of the existing client-secret identity mode,
and actual app installation remain operator prerequisites. A visible custom-upload
option alone does not prove them. An observed Azure CLI `AADSTS530084` policy block
is **not** authorization to change Conditional Access, consent, tenant settings,
or authentication methods. Do not retry login or use a workaround from this guide.
Never supply credentials in chat. Browser-led registration is a later authorized
operator action, using the Microsoft sources linked below.

### Complete input checklist

| Input | Exact use and source |
| --- | --- |
| Bot OAuth client / Microsoft App ID | `TEAMS_APP_ID`, valid GUID; also manifest `bots[0].botId`. **Not** necessarily the Teams package ID. |
| Tenant GUID | `TEAMS_TENANT_ID` and binding `match.accountId`; exact trusted tenant, no `common` or multi-tenant inference. |
| Bot credential | `teams-bot` Secret key `client-secret` → `TEAMS_CLIENT_SECRET`; existing runtime requires a client-secret **value**, not its ID. No new identity mode is added. |
| Verified bot recipient IDs | `TEAMS_RECIPIENT_IDS`, JSON array of exact allowed incoming `recipient.id` values, 1–100 entries. |
| Verified service base URLs | `TEAMS_SERVICE_URLS`, JSON array of exact canonical public-cloud HTTPS URLs, 1–100 entries. Match path case/trailing slash; no query/fragment/userinfo/nonstandard service port. |
| Verified sender IDs | Binding `senderPolicy.allowedSenderIds`: exact activity `from.id`, not display name, email, AAD ID or a guessed prefix. |
| Verified personal conversation | Binding `match.contextId`: exact conversation ID. **Required by the current Orka CRD**, not an optional wildcard. |
| Existing Orka HTTPS API base | `ORKA_BASE_URL`, including installation base path; real TLS frontend plus trusted CA. The normal Orka Service is HTTP: changing `http` to `https` does not provision TLS. |
| Stable Gateway target | Namespace `orka-system`, name `teams`; both enter the ingress DB's immutable scope. Keep its UID and Orka ledger stable. |
| Existing Agent | Binding `agentRef.name`, one permitted Agent in `orka-system`; confirm it can execute in the existing harness-v2 installation. |
| Directional Orka credentials | Two distinct RFC6750-compatible bearer values, at most 8192 characters: `teams-orka-inbound/token` → `ORKA_BEARER_TOKEN`; `teams-orka-outbound/token` → `ORKA_OUTBOUND_BEARER_TOKEN`. |
| Adapter TLS certificate/key | Operator-managed `teams-tls` Secret. SAN includes `teams-adapter.orka-system.svc`; also `teams-messages.orka-system.svc` when the public frontend verifies that upstream. |
| Adapter public CA | `teams-adapter-ca` ConfigMap key `ca.crt`, mounted into the app at `/etc/adapter-ca/ca.crt`; trust the same CA in the Orka controller and public frontend. Never mount the private key in the app. |
| Orka API CA, if private | Separate public CA ConfigMap/mount and existing `ORKA_CA_FILE` setting, described below. Otherwise Node system roots apply. |
| Public messaging route | Operator-managed public HTTPS endpoint ending exactly `/api/messages`, routing only to `teams-messages:443` over verified TLS. No ingress implementation is installed here. |
| Local filesystem storage | 2Gi filesystem PVC reference, suitable StorageClass/capacity and stable UID/GID 1000; private `teams` child directory. No network-filesystem/HA guarantee. |
| Images | Local unpublished `orka-gateway-teams:local` for evaluation; operator-published digest for production and both provisioning Jobs. Keep the supplied NGINX digest pinned. |
| Teams app metadata | Operator-assigned package GUID, developer name, genuine support/privacy/terms HTTPS URLs, and reviewed descriptions. No invented Orka legal policy URLs. |
| Teams icons | Operator-supplied `color.png` 192×192 and white transparent `outline.png` 32×32; artifacts and final ZIP only under ignored `bin/`. |

All scope/configuration input is nonsecret but can still identify people or tenants:
keep real values out of commits. Secret-manager output/private files must contain
**exact bytes without a trailing newline**. Never use shell tracing, token literals
in argv, `--from-literal` credentials, environment dumps, Secret YAML output, or
request-bearing logs. Kubernetes API/audit handling must also protect Secret bodies.

### First-installation order

The numbered sections group responsibilities, not permission to initialize before
identities exist. Obtain registration/installation authority and the approved bot
and HTTPS route first (the separately authorized operator work in Gate 4 may
therefore precede capture). Stop normal intake, perform host/container setup capture
when needed, privately review all six candidate identities, and close/drain capture
routing. Reconcile lost ACKs/provider retries before switching modes: capture has
no shared normal-runtime replay ledger. Then fill the private normal configuration
copies and complete the existing Orka/TLS/storage gates. Initialize new stores
**only after** that review. Use a new ordinary authorized message—not the setup
code—for separately approved live Task/reply validation.

## Gate 1 — existing Kubernetes and Orka prerequisites

The authoritative inspected Orka interfaces are at
[`55cb3d5` Gateway API types][orka-types], [endpoint resolution][orka-endpoint],
[directional authentication][orka-auth], [controller flags][orka-main], and
[operations/trust/retention guidance][orka-operations]. Use a compatible installed
version, with the GatewayClass/Gateway/GatewayBinding CRDs Established **before**
controller startup. This guide does not install or build Orka.

The existing controller must use `--controller-mode=harness-v2`,
`--watch-namespace=orka-system`, `--enforce-namespace-isolation=true`,
`--leader-elect=true`, and `--gateway-enabled=true` (gateway default is true, but
missing startup prerequisites can disable it). Its namespace/runtime admission
and persistent SQLite ledger must already be configured by its operator. Its Pod
must carry `orka.ai/network-role: controller` for the private NetworkPolicy path.
There is no automatic controller patch in these assets.

For a private adapter CA, the Orka operator must mount the **public CA** in the
controller and install it into system trust or set `SSL_CERT_DIR` to that mounted
CA directory, per [Orka operations][orka-operations]. Preserve other required
trust roots, roll the actual controller Deployment after trust changes, and wait
for that rollout. Determine its real name: Helm commonly uses `orka-controller`;
manifest installs use `orka-controller-manager`. Do not guess or disable TLS
verification. Orka API HTTPS provisioning is a separate inbound trust boundary.

For the following **operator** examples, use an explicitly approved kubeconfig,
not an implicit global context. Do not point them at a shared/unowned test scope:

```sh
k() { kubectl --kubeconfig /private/operator-owned.kubeconfig "$@"; }
k get namespace orka-system
k wait --for=condition=Established --timeout=60s crd/gatewayclasses.gateway.orka.ai
k wait --for=condition=Established --timeout=60s crd/gateways.gateway.orka.ai
k wait --for=condition=Established --timeout=60s crd/gatewaybindings.gateway.orka.ai
```

For the local kind fixture, use ONLY the separate [scoped verification](#scoped-verification)
commands below; never substitute the global kubeconfig or install a controller.

## Gate 2 — prepare a private customization and credentials

Build the locked Node 24.2.0 image from the repository root. Build context is
allowlisted; local files, credentials, tests and `bin/` are excluded.

```sh
docker build --tag orka-gateway-teams:local .
mkdir -p bin/teams-deployment
cp -R deploy bin/teams-deployment/deploy
mkdir -p bin/teams-deployment/teams-app
cp examples/teams-app/manifest.template.json bin/teams-deployment/teams-app/manifest.json
```

Edit **only the copy**, replacing all required inputs in `runtime/configmap.yaml`
and `orka/gatewaybinding.yaml`. Invalid GUID/URL placeholders and empty receiver
allowlists deliberately prevent unconfigured startup; they are not sample live
identities. Do not alter the two loopback listeners, storage paths or probe CLI.

For production, set the app image to the operator's actual
`registry/repository@sha256:<verified digest>` in the copied Deployment **and both
Jobs**; `orka-gateway-teams:local` is not a published image. A private registry may
require an independently managed imagePullSecret. Node/dependency versions remain
locked. Do not change the pinned NGINX digest to a floating tag.

### Layout and lifecycle

- `deploy/kustomization.yaml` is the **runtime-only entrypoint**. It includes
  `runtime/` and generates a hash-named ConfigMap from the existing `nginx.conf`.
  Keeping the entrypoint at this root avoids duplicated proxy config, symlinks,
  or disabling Kustomize's root loader. Do not apply `runtime/` alone.
- `storage/pvc.yaml`, `storage/prepare-job.yaml`, `storage/init-job.yaml` are
  **unlisted, separately invoked** provisioning assets. Ordinary runtime apply or
  cleanup cannot delete/reinitialize them.
- `orka/` examples are separate; no Orka objects/controller are installed by the
  runtime entrypoint. CA ConfigMaps and Secrets are operator-managed separately.
- No private material enters a ConfigMap generator/hash or the Teams ZIP.

Create Secrets from private files; the commands emit resource names, not values.
Use your secret manager instead if it supports the same references and metadata.
These are first-creation commands, not a rotation/reset procedure:

```sh
k -n orka-system create secret generic teams-bot --from-file=client-secret=/private/teams-client-secret
k -n orka-system create secret generic teams-orka-inbound --from-file=token=/private/orka-inbound-token
k -n orka-system create secret generic teams-orka-outbound --from-file=token=/private/orka-outbound-token
k -n orka-system label secret teams-orka-inbound gateway.orka.ai/inbound-auth=true
k -n orka-system annotate secret teams-orka-inbound gateway.orka.ai/gateway-name=teams
k -n orka-system label secret teams-orka-outbound gateway.orka.ai/outbound-auth=true
k -n orka-system annotate secret teams-orka-outbound gateway.orka.ai/gateway-name=teams
k -n orka-system annotate secret teams-orka-outbound gateway.orka.ai/adapter-endpoint=https://teams-adapter.orka-system.svc:443
k -n orka-system create secret tls teams-tls --cert=/private/adapter-tls.crt --key=/private/adapter-tls.key
k -n orka-system create configmap teams-adapter-ca --from-file=ca.crt=/private/adapter-ca.crt
```

The endpoint annotation is exact: `https://teams-adapter.orka-system.svc:443`,
without a trailing slash. The two token Secrets must remain distinct. Secret
opt-in labels are required; name binding is an annotation, and outbound additionally
binds to that exact resolved endpoint. Do not swap the directional values.

If the existing Orka API frontend has a private CA, create a separate ConfigMap:

```sh
k -n orka-system create configmap teams-orka-ca --from-file=ca.crt=/private/orka-api-ca.crt
```

Save the following as `bin/teams-deployment/deploy/runtime/orka-ca-patch.yaml`,
and add `patches: [{path: runtime/orka-ca-patch.yaml}]` to the copied root
`kustomization.yaml`. This uses the existing `ORKA_CA_FILE` interface, not a TLS
bypass. The bundle must contain only complete valid PEM certificates/whitespace.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: teams
  namespace: orka-system
spec:
  template:
    spec:
      containers:
        - name: app
          env:
            - {name: ORKA_CA_FILE, value: /etc/orka-ca/ca.crt}
          volumeMounts:
            - {name: orka-ca, mountPath: /etc/orka-ca, readOnly: true}
      volumes:
        - name: orka-ca
          configMap: {name: teams-orka-ca}
```

## Gate 3 — first storage provisioning, then runtime

Confirm the intended namespace/PVC ownership and an unused dedicated claim. Set an
appropriate local filesystem StorageClass in the copy if the default is unsuitable.
RWO is a portable reference, **not exclusive process ownership**; RWOP is an operator
option only with a supporting CSI driver. Keep one replica, `Recreate`, no HPA.

```sh
k create -f bin/teams-deployment/deploy/storage/pvc.yaml
k apply -f bin/teams-deployment/deploy/runtime/configmap.yaml
```

**Optional explicit storage-admin opt-in:** only on a NEW claim, separately approve
and run the preparation Job below. It runs as root with **only CHOWN** added to
otherwise dropped capabilities. It creates NEW `/storage/teams` with mode `0700`
and owner `1000:1000`; `mkdir` refuses an existing child. It never repairs existing
bytes, recurses over ownership/permissions, or runs as a Deployment initContainer.
Restricted clusters should have the storage administrator prepare the new private
directory instead; do not weaken Pod Security admission to run this optional Job.

```sh
k create -f bin/teams-deployment/deploy/storage/prepare-job.yaml
k -n orka-system wait --for=condition=Complete --timeout=120s job/teams-prepare
```

Do **not** add `fsGroup`: Kubernetes permission management can widen `0600` files
to `0660`, which the ingress store refuses. App and initializer mount only the
private `teams` subdirectory as `/data`. The proxy never mounts the PVC.

With the exact immutable scope confirmed, initialize once, without credentials:

```sh
k create -f bin/teams-deployment/deploy/storage/init-job.yaml
k -n orka-system wait --for=condition=Complete --timeout=120s job/teams-init
```

That nonroot Job runs `node /app/dist/ingress/main.js init` then
`node /app/dist/ingress/main.js init-delivery`, with `restartPolicy: Never` and
`backoffLimit: 0`. Both commands refuse existing stores. Any partial failure is a
**STOP and inspect** condition, not permission to delete files, repeat provisioning,
repair permissions, or adopt another scope. Normal startup never initializes.

Only after successful provisioning and all TLS/credential/identity gates:

```sh
k apply --dry-run=server -k bin/teams-deployment/deploy
k apply -k bin/teams-deployment/deploy
k -n orka-system rollout status deployment/teams --timeout=120s
k apply --dry-run=server -f bin/teams-deployment/deploy/orka
k apply -f bin/teams-deployment/deploy/orka
```

Get cluster-admin approval for the cluster-scoped GatewayClass; do not overwrite a
shared existing class with different capabilities. The class requires only
`inboundText`, `outboundText`, `senderIdentity`, `idempotentDelivery`: no threads,
explicit Sessions or allowed metadata keys. The binding uses exact tenant/context,
allowlisted sender, `session.mode: context-sender`, and `activeTurnBehavior: queue`.
The Gateway uses same-namespace selector-backed `teams-adapter`, Service port 443.

### Exposure, readiness, and operational limits

Both Services are ClusterIP on 443: `teams-messages` targets proxy 8443 and
`teams-adapter` targets proxy 8444. Node remains loopback-only at 3978/3979; neither
raw Node port is published. Public routing exposes **only** exact
`POST /api/messages` via the messages Service. Never publish the private V1 Service
or treat the public NGINX server as a general-purpose reverse proxy.

The NetworkPolicy permits public-front-end traffic on 8443 and private 8444 only
from Pods with `orka.ai/network-role: controller` **AND** namespace
`kubernetes.io/metadata.name: orka-system` in the same peer. Restrict 8443 sources
further to the operator's actual frontend topology when appropriate. Labels must
be controlled by trusted administrators. Policy requires an enforcing CNI; default
kind does **not** prove enforcement. Port access itself is not authorization.
Egress controls, public frontend limits/auth-preserving forwarding and TLS trust
are operator responsibilities; no provider endpoint/discovery override is added.

Both containers are nonroot/read-only, drop ALL capabilities, deny privilege
escalation, use RuntimeDefault seccomp and no ServiceAccount token. App UID/GID is
1000; proxy UID/GID is 101. Separate bounded memory `/tmp` volumes count against
memory limits. Tune the supplied finite CPU/memory budgets to measured load.
The TLS Secret is read-only, `0444`, mounted **only into the proxy**, which has no
PVC or application credentials. This enables UID101 readability without fsGroup;
0444 is not permission to make the Secret public through Kubernetes RBAC.

Readiness executes `node /app/dist/deployment/probe.js`: no secret in argv or
probe HTTP headers. It reads `POD_NAMESPACE`, the outbound bearer and public CA
in memory, verifies SAN `teams-adapter.<namespace>.svc` against loopback TLS 8444,
and requires exact healthy status within two seconds. It outputs nothing and
exits 0/1. The probe is not a cloud credential check; there is no aggressive
liveness restart loop.

Safe inspection (no Secret output or request logs):

```sh
k -n orka-system get pods -l app.kubernetes.io/name=orka-gateway-teams
k -n orka-system get gateways.gateway.orka.ai teams
k -n orka-system get gatewaybindings.gateway.orka.ai teams-personal
k -n orka-system exec deployment/teams -c app -- node /app/dist/deployment/probe.js
```

Gateway Ready additionally requires accepted class, resolved references, trusted
controller TLS and authenticated health/capabilities. Binding Ready additionally
requires its Agent and unambiguous routing. Local probe success is not either of
these controller conditions. Do not collect env dumps, Secret manifests, raw
request bodies/URLs/auth headers or raw SDK errors. App logs contain only fixed
lifecycle/error categories; proxy request-bearing logs are intentionally disabled.

NGINX bounds whole-header receipt at 10s. Body/client writes use 10s **inactivity**
limits; upstream connect is 2s, send inactivity 10s, read inactivity 15s. These
are separate phase limits, **not one end-to-end deadline**. Native absolute
request/deadline handling starts after forwarding. Buffering, transparent retries,
redirect rewriting and keepalive are disabled; body ceiling is 256KiB.

The 120s termination grace is a conservative **operational timeout**, not evidence
that all work drained. Quiesce public exposure and private delivery intake before
a planned stop; coordinate Orka delivery work, then wait for Pod termination.
Existing uncancellable SDK token acquisition can outlive HTTP deadlines and hold
shutdown. Kubernetes can eventually kill the process at the grace limit; do not
force-delete a Pod or detach/reassign its volume to work around an unconfirmed
owner. Verify node/process termination before any storage inspection or restore.

## Gate 4 — future authorized Teams registration and app package

These browser steps are based on the current official pages linked here; recheck
them before performing changes. They describe future operator work, **not actions
performed or permissions established by this repository**.

1. Under separately approved registration authority, use Microsoft's
   [Azure Bot registration guidance][registration] and existing single-tenant
   identity. Verify Microsoft App ID and tenant in its Configuration. Preserve
   the required client-secret mode only if your security owner accepts it:
   [Microsoft discourages client secrets in production][credentials] and
   recommends stronger credentials. This adapter does not yet implement those
   alternative identity modes; packaging does not make a security exception.
2. Per [bot settings][bot-settings], set the Azure Bot Configuration messaging
   endpoint to the operator's public HTTPS URL ending `/api/messages`. Per
   [Connect to Teams][connect-teams], configure its Microsoft Teams channel for
   the public-cloud environment. Do not enable calling or use a quickstart's
   unauthenticated playground mode. Registration alone does not discover Gate 0's
   identities; use trusted existing bindings or the separate reviewed setup capture.
3. Fill every `REQUIRED_...` field in the copied `manifest.json`. `id` is the Teams
   package GUID; `bots[0].botId` is the bot OAuth client GUID. Manifest schema is
   pinned to [1.30][manifest-schema], with `scopes: ["personal"]` only. No Graph,
   SSO, RSC, file, group, channel, calling or video permissions are requested.
   Provide real operator support/privacy/terms URLs and check developer-name and
   description bounds with the schema/Developer Portal validator.
4. Supply reviewed PNG artwork under `bin/teams-deployment/teams-app/`, per
   [Microsoft app package requirements][app-package]: 192×192 color and 32×32 white
   transparent outline. Verify dimensions/content and that the package contains
   only root `manifest.json`, `color.png`, `outline.png`. No credentials, certificates,
   SQLite files or private operator records belong in it. Validate the completed
   manifest against the pinned schema before creating the ZIP. For example, with
   the three reviewed files in place:

   ```sh
   cd bin/teams-deployment/teams-app
   zip ../teams-personal.zip manifest.json color.png outline.png
   ```

5. If organizational policy and installation authority are confirmed, follow
   [Upload your app][app-upload]: Teams **Apps → Manage your apps → Upload an app →
   Upload a custom app**, choose the ZIP, then add/open the personal app. Use
   [Developer Portal guidance][developer-portal] for package validation/management.
   [Custom app policies][custom-policies] remain administrator-owned: do not change
   policies, consent or tenant configuration to bypass a blocked upload.

No icons or ZIP are committed; `bin/` is gitignored and excluded from the Docker
context. An app upload or successful local health alone is not a verified binding,
live token acquisition or successful provider delivery.

### Planned live validation — only after all gates and separate authorization

Record outcomes, not raw activities, tokens, text or private identity dumps:

- Confirm Gateway and binding readiness with the actual Orka controller/Agent.
- Send an authorized personal message, observe one Orka task and one reply; send
  a follow-up and verify the intended context-sender Session continuation.
- Verify a separately approved nonallowlisted sender/context is denied before
  dispatch, without weakening production policy to run the test.
- Using an authorized replay facility, replay the same stable event/delivery
  identity; verify no duplicate provider effect and the same confirmed receipt.
  Do not fabricate new IDs as a retry mechanism.
- Quiesce exposure/delivery, drain, restart/remount the same PVC with stable Gateway
  UID/Orka ledger, then verify confirmed receipt replay and normal continuation.
- Verify denial/untrusted TLS/public V1 boundaries and cleanup behavior without
  collecting request-bearing logs. Ambiguous provider outcomes are terminal
  unknown, not automatic resend permission.

The full Orka conformance CLI hardcodes identities not established for this strict
saved-route receiver. It has **not** been proved against this deployment. Do not
claim full conformance, inject a reference-adapter route fixture, or alter runtime
auth/routing to obtain a green result.

## Pause, backup, and retirement are different operations

For an ordinary pause, quiesce the public route first, coordinate private Orka
delivery intake/drain, and scale only the adapter down:

```sh
k -n orka-system scale deployment/teams --replicas=0
```

Wait for all owners to stop; retain `teams-state`, both databases, the permanent
`delivery.sqlite.owner.sqlite` and all SQLite sidecars together. Keep UID/GID1000,
private modes, the Gateway **UID**, target Orka backend, retained reply routes and
Orka dedup ledger stable. Retention/reconciliation must cover late/manual replays.
Do not copy/open/close live SQLite inodes through ordinary filesystem APIs in the
owning process; use a coordinated stopped-store snapshot/backup plan, preserving
both adapter stores and consistent Orka/Kubernetes state. Rollbacks/loss can erase
dedup history: they are not automatically duplicate-safe recovery.

To resume the unchanged runtime after the same ownership checks, reapply the copied
runtime entrypoint. Do not re-run preparation/init. ConfigMap/Secret env changes
require a controlled restart; NGINX does not automatically reload rotated certs.
Coordinate directional-token changes with Orka, recheck trust/readiness, then
reopen exposure. No certificate hot-reload or credential-rotation automation is
provided here.

Permanent retirement is a **separate explicit authorization** after exposure is
closed, work drained, uncertain outcomes reconciled and retention obligations
settled. Back up required state and credential records securely before retiring
credentials, bot/app registrations, Gateway objects or volumes. Never delete a
shared namespace/resource group, run a broad `delete -k` including storage, or
recreate the Gateway to troubleshoot. Do not delete/re-enable the Teams channel as
a reset: [Microsoft warns][connect-teams] it generates new keys and invalidates
stored `29:xxx` and `a:xxx` IDs. Uninstalling a Teams package is not retirement of
Azure credentials, the controller ledger, or adapter storage.

## Scoped verification

Default `npm test` / `npm run check` require **no Docker or Kubernetes**. Node
24.2.0 and OpenSSL are the tested local toolchain. Select Node 24.2.0 on `PATH`
using your local toolchain manager; `node --version` must report `v24.2.0`.
Two additional gates are explicit:

```sh
npm run check
npm run test:container
```

`test:container` builds the image and runs the actual locked app/proxy with private
synthetic fixtures. It requires a local Linux Docker daemon, bridge access and
host UID1000, and fails if prerequisites are missing.

From this adapter worktree, the separately owned local kind cluster uses tag
`deployment`. Its operator owns creation/deletion. Never use global kubeconfig,
never delete the cluster here, and never install Orka/Go merely for this gate.
Set and export the required `KINDCTL` to the absolute path of the canonical wrapper
in your Orka checkout (replace the example path). Use it from this adapter worktree
for every cluster operation:

```sh
export KINDCTL=/absolute/path/to/orka/.agents/skills/kindctl/bin/kindctl
"$KINDCTL" load --tag deployment orka-gateway-teams:local
```

The proxy digest must also be available. With this Docker/kind combination, a
**digest-only untagged image import produced a broken containerd alias**. Give the
already verified digest a local tag for import, keeping the Deployment digest
unchanged:

```sh
docker pull nginxinc/nginx-unprivileged@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce
docker tag nginxinc/nginx-unprivileged@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce nginxinc/nginx-unprivileged:stable-alpine
"$KINDCTL" load --tag deployment nginxinc/nginx-unprivileged:stable-alpine
"$KINDCTL" exec --tag deployment -- npm run test:deployment
```

The deployment runner rejects missing, relative or non-executable `KINDCTL` before
running any command. It verifies that the current kubeconfig path and context match
that wrapper's `deployment` scope before cluster access. It requires that scoped
cluster, Node24.2.0, kubectl/Kustomize, OpenSSL, both images and the three existing
Orka Gateway CRDs; it **fails**, never
silently skips, if prerequisites are absent. It creates a new uniquely labelled
synthetic namespace only after proving it absent/empty. It never creates a real
Gateway/Agent/controller; Orka examples receive server dry-run schema validation
only. Actual Pods/PVCs test explicit provisioning/refusal, nonroot/read-only/TLS,
authentication/public V1 isolation, 0600 persistence and receipt replay across a
new Pod UID/remount. A receipt is seeded only via the public journal API while
**every** prior owner is confirmed stopped. Missing-owner mutation/restoration
likewise requires independent terminal Pod/container and inactive-controller proof.

Fixture script files use ConfigMap **file subPath** mounts, not symlink directory
projections, and emit fixed completion markers so an unexecuted helper cannot pass.
All credentials/IDs/text/receipts are synthetic and checked against captured Pod
logs without printing matches. Private files are outside the repository. The
runner deletes only its owned synthetic namespace/data after stopped-owner and
full resource-ownership inspection; on an unconfirmed failure it retains the
namespace/private directory (including a nonsecret ownership record), never
restores a held inode blindly. This destructive **test-only cleanup** is not the
production retirement procedure. No live provider POST, controller readiness,
full conformance, tenant action or NetworkPolicy enforcement is claimed.

[identifiers]: https://learn.microsoft.com/en-us/azure/bot-service/bot-service-resources-identifiers-guide?view=azure-bot-service-4.0
[proactive]: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages
[registration]: https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration?view=azure-bot-service-4.0
[bot-settings]: https://learn.microsoft.com/en-us/azure/bot-service/bot-service-manage-settings?view=azure-bot-service-4.0
[connect-teams]: https://learn.microsoft.com/en-us/azure/bot-service/channel-connect-teams
[credentials]: https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials
[manifest-schema]: https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json
[app-package]: https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/apps-package
[app-upload]: https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload
[custom-policies]: https://learn.microsoft.com/en-us/microsoftteams/teams-custom-app-policies-and-settings
[developer-portal]: https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/manage-your-apps-in-developer-portal
[orka-types]: https://github.com/orka-agents/orka/blob/55cb3d5232b4a9b697e72471e346c0a6493d4c21/api/gateway/v1alpha1/gateway_types.go
[orka-endpoint]: https://github.com/orka-agents/orka/blob/55cb3d5232b4a9b697e72471e346c0a6493d4c21/internal/gateway/endpoint.go
[orka-auth]: https://github.com/orka-agents/orka/blob/55cb3d5232b4a9b697e72471e346c0a6493d4c21/internal/gateway/auth.go
[orka-main]: https://github.com/orka-agents/orka/blob/55cb3d5232b4a9b697e72471e346c0a6493d4c21/cmd/main.go
[orka-operations]: https://github.com/orka-agents/orka/blob/55cb3d5232b4a9b697e72471e346c0a6493d4c21/website/docs/operations/gateways.md
