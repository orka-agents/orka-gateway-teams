# Personal Teams chat on Azure Container Apps

This is the operator-managed ACA/Table V2 profile used for the
[recorded live request/reply and follow-up](live-validation.md). It is separate
from the existing SQLite/Kubernetes package. It does not provision Azure, deploy
Orka, register a bot, change tenant policy, initialize stores automatically, or
provide recovery/HA. Keep an operator ledger of resource names, image digests,
initialization executions, private capture locations and successful shutdowns.

**Do not apply these examples over a running gateway.** Table ownership is
non-expiring. One replica and Single revision mode do not fence an old process.
An unclean/occupied store blocks reopening; there is no reset/adoption/takeover
command in this workflow.

## 1. Resolve installation and infrastructure first

### Scope and operator tools

This guide starts with **existing infrastructure**, not an empty Azure subscription.
Arrange the resources and permissions below with your platform/tenant administrator
before executing deployment commands. Registration, network design, identity/RBAC
provisioning and Orka installation are prerequisites, not hidden steps performed by
the renderer. See [Orka's gateway operations guide][orka-gateways] for the Orka side.

Use a reviewed adapter checkout, Node 24.2.0 (the evaluated image version), npm,
Docker with Linux/amd64 builds, Azure CLI with the `containerapp` commands available,
and `kubectl` with a dedicated Orka-cluster kubeconfig. Python 3 and `curl` are used
by the optional local Teams packaging/validation path below. Authenticate Azure
CLI as your approved operator; do not use storage account keys or enable ACR admin
credentials as a shortcut. Never enable shell tracing (`set -x`) or CLI debug output
while handling credentials/capture artifacts.

Before starting a timed capture, confirm:

- One approved work/school tenant and bot application, its Microsoft Teams channel,
  and permission to install the personal Teams app. An Azure Bot registration
  alone does **not** create a Teams chat. Confirm custom upload or an approved
  administrator installation route; never work around blocked tenant policies.
- An ACA **Consumption** environment with VNet connectivity and peer encryption,
  an existing ACR, a physical Azure Table, and stable logical ingress/delivery
  store IDs. For the evaluated profile, storage shared keys were disabled and
  storage networking admitted the ACA subnet, not the public Internet.
- Explicit managed identities: registry pull permission, table-scoped data
  permission, and the bot's approved federation configuration. Bot and storage
  select `azure-container-apps` independently, even when they share a UAMI.
  Client ID and principal ID are different fields. See
  [managed identity](managed-identity-auth.md) and [Table runtime](table-runtime.md).
- Existing Orka with gateways enabled, a permitted Agent, and a working model
  provider. Complete any human provider login before the first real request.
  Never borrow developer-tool credentials for an Agent or provider proxy.
- A certificate-verified HTTPS Orka API endpoint reachable from ACA, its **public
  CA only**, and the AKS cluster's actual fixed outbound IPv4 CIDR. Record the exact
  canonical Orka base URL (including any installation path and trailing slash),
  Gateway namespace/name, app/tenant and store IDs before initialization.

The main app's managed HTTPS ingress targets V1 port **3979**, restricted to the
approved Orka egress CIDR. Additional TCP **3978 is internal only**. The separate,
identity-free public proxy exposes only exact `POST /api/messages`, forwarding to
that internal port. Its private health port is not exposed. No V1, capture files,
identity endpoint, request logs, buffering or transparent retries are added to
the public proxy.

ACA does not give this profile the Docker/Kubernetes read-only-rootfs and
capability-drop guarantees. It uses the image's non-root user and writable,
ephemeral root-owned sticky `/tmp`; no unverified EmptyDir ownership or `fsGroup`
assumption is made. Capture retention is ephemeral, not durable storage.

### Keep the three endpoints separate

| Address | Caller and purpose |
| --- | --- |
| Public proxy HTTPS origin + `/api/messages` | Teams → gateway; set this as the Azure Bot messaging endpoint |
| Main app HTTPS origin (no `/api/messages`) | Orka → gateway V1 API; use as Gateway `adapter.endpoint`, restricted to Orka's egress CIDR |
| Orka HTTPS API base URL | Gateway → Orka; immutable initialized scope, reachable from ACA with the trusted public CA |

The main app's internal port 3978 connects the public proxy to Teams ingress; it is
not a public V1 endpoint. For the runtime topology and observed boundaries, see the
[live report](live-validation.md).

### Operator values used in commands

Shell variables below are **not loaded automatically** from the JSON configuration.
Set them in your operator shell from your approved inventory; keep a consistent
copy in the private ledger. Replace all `REQUIRED_...` placeholders before use.
Never assign bearer tokens as command-line arguments.

| Values | Where they come from |
| --- | --- |
| `SUBSCRIPTION_ID`, `RESOURCE_GROUP`, `ENVIRONMENT_ID` | Target subscription, existing resource group and full ACA environment ARM resource ID |
| `ACR_NAME`, `REGISTRY_SERVER` | Existing registry name and its login server (for example, `exampleacr.azurecr.io`) |
| `IMAGE_TAG` | A unique tag for the reviewed build; deploy only its verified digest |
| `GATEWAY_APP_NAME`, `PROXY_APP_NAME` | Same names in both stage configs; defaults `orka-teams-gateway` / `orka-teams-public` |
| `STORAGE_IDENTITY_RESOURCE_ID`, `STORAGE_IDENTITY_CLIENT_ID` | Storage UAMI resource ID and client ID; not the bot application's ID |
| `BOT_APP_ID`, `TENANT_ID` | Registered bot OAuth app and approved tenant |
| `TABLE_ACCOUNT`, `TABLE_NAME`, `TABLE_INGRESS_STORE_ID`, `TABLE_DELIVERY_STORE_ID` | Existing physical Table and chosen stable logical store IDs |
| `ORKA_BASE_URL`, `GATEWAY_NAMESPACE`, `GATEWAY_NAME` | Canonical Orka API base URL and chosen Gateway identity; freeze before initialization |
| `INGRESS_INIT_JOB`, `DELIVERY_INIT_JOB` | Two distinct names for the one-time manual Jobs |
| `KUBECONFIG_PATH` | Dedicated kubeconfig for the existing Orka cluster; do not change the global context |

The build step defines `GATEWAY_IMAGE_TAG` and `SETUP_IMAGE_TAG`; after publishing,
you manually set `GATEWAY_IMAGE_BY_DIGEST` and `SETUP_IMAGE_BY_DIGEST` from the
registry output. Bot/pull identity IDs and the allowed Orka egress CIDR are entered
in the stage JSON examples below.

## 2. Prepare and install the Teams app

Create an ignored/private operator directory; do not edit the checked-in example
with live identities. From the adapter checkout:

```sh
umask 077
install -d -m 0700 bin/teams-operator
cp examples/teams-app/manifest.template.json bin/teams-operator/manifest.json
chmod 0600 bin/teams-operator/manifest.json
```

Fill every `REQUIRED_...` field. The package ID is the Teams app ID;
`bots[0].botId` is the registered bot's OAuth application ID. They may be equal,
but do not confuse either with the UAMI client/principal IDs. Keep personal scope
only. Supply operator-approved developer/support/privacy/terms URLs, not invented
legal policies. No bot secret, recipient ID, service URL, capture, bearer, or
storage configuration belongs in this package.

Supply reviewed `color.png` (192×192 RGB/RGBA) and `outline.png` (32×32 RGBA,
white artwork on a transparent background). The packaging helper accepts 8-bit,
non-interlaced PNGs. It checks header integrity/dimensions, **not decoded pixels or
visual design**. Images and ZIPs remain ignored operator artifacts.

Validate the completed manifest in the [Teams Developer Portal][validation], or
use the same optional local validator as the evaluation. These dependencies are
operator tools, not gateway runtime dependencies:

```sh
npm install --prefix bin/teams-validator --ignore-scripts --no-audit --no-fund \
  ajv@8.17.1 ajv-draft-04@1.0.0 ajv-formats@3.0.1
curl --fail --silent --show-error --location \
  https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json \
  --output bin/teams-operator/schema.json
node scripts/validate-teams-app.mjs \
  --manifest bin/teams-operator/manifest.json \
  --schema bin/teams-operator/schema.json --tools-dir bin/teams-validator
python3 scripts/package-teams-app.py \
  --manifest bin/teams-operator/manifest.json \
  --color bin/teams-operator/color.png --outline bin/teams-operator/outline.png \
  --output bin/teams-operator/teams-personal.zip
```

The validator uses JavaScript Unicode regex support: the Microsoft schema has
patterns that Python's standard `re` does not implement. The packager's own
checks are a narrow selected-profile preflight (personal by default), not full
schema validation. It packages exactly root `manifest.json`, `color.png`,
`outline.png`, and refuses to
overwrite an existing ZIP. Use a new output name for a revised artifact.

In Teams desktop/web, use **Apps → Manage your apps → Upload an app → Upload a
custom app**, select the ZIP, then **Add → Open**. Confirm the personal chat is
open **before** asking the user to send a timed challenge. If installation is
blocked, stop and use the organization's approved process. See [Microsoft's
upload instructions][upload].

### Opt-in shared-room package (packaging only)

The default template and commands above remain personal-only. For the shared-room
work tracked by [Orka #641](https://github.com/orka-agents/orka/issues/641), a separate
`examples/teams-app/manifest.shared-rooms.template.json` offers exactly `personal`,
`groupChat`, and `team` bot scopes. Copy it to a **new private operator directory**,
fill its placeholders, provide reviewed icons, and perform the same full manifest
validation before packaging:

```sh
python3 scripts/package-teams-app.py --profile shared-rooms \
  --manifest bin/teams-rooms-operator/manifest.json \
  --color bin/teams-rooms-operator/color.png \
  --outline bin/teams-rooms-operator/outline.png \
  --output bin/teams-rooms-operator/teams-shared-rooms.zip
```

`--profile personal` is equivalent to omitting the option. `--profile shared-rooms`
requires all three scopes, in any order, without duplicates; it does not rewrite
or widen the supplied manifest. A shared-room manifest is rejected by the default
profile. Both profiles reject RSC authorization and keep files, calling, video,
and notification-only operation disabled. Packaging still includes only the
reviewed manifest and two icons, with no overwrite or upload.

**A successful package is not shared-room runtime support or live validation.**
The current runtime and authenticated setup capture remain personal-only. Do not
roll out the shared-room package until the adapter implements bot-targeted
@mention filtering, room/thread routing, and explicit pilot-member allowlists.
Do not add read-all-message RSC permissions or sender policy `all` to bypass those
gates. The shared-room live result will be recorded separately in
[live validation](live-validation.md); the existing personal result is unchanged.

## 3. Build and render the fixed profiles

### Build and publish two images

From the reviewed adapter checkout, confirm the source commit with `git rev-parse
HEAD` and record it. With `ACR_NAME`, `REGISTRY_SERVER` and a unique `IMAGE_TAG` set:

```sh
az acr login --subscription "$SUBSCRIPTION_ID" --name "$ACR_NAME" --only-show-errors
GATEWAY_IMAGE_TAG="$REGISTRY_SERVER/orka/teams-gateway:$IMAGE_TAG"
SETUP_IMAGE_TAG="$REGISTRY_SERVER/orka/teams-setup:$IMAGE_TAG"
docker build --platform linux/amd64 --tag "$GATEWAY_IMAGE_TAG" .
docker push "$GATEWAY_IMAGE_TAG"
az acr repository show --subscription "$SUBSCRIPTION_ID" --name "$ACR_NAME" \
  --image "orka/teams-gateway:$IMAGE_TAG" --query digest --output tsv
```

Copy the returned `sha256:...` into `GATEWAY_IMAGE_BY_DIGEST`, in the form
`REGISTRY_SERVER/orka/teams-gateway@sha256:...`, and record it. This must refer to
the **ordinary gateway**, not a diagnostic/fixture image. Do not deploy the mutable
tag. Then build the setup derivative from that exact image:

```sh
docker build --platform linux/amd64 \
  --build-arg GATEWAY_IMAGE="$GATEWAY_IMAGE_BY_DIGEST" \
  --file deploy/aca/Dockerfile.setup --tag "$SETUP_IMAGE_TAG" deploy/aca
docker push "$SETUP_IMAGE_TAG"
az acr repository show --subscription "$SUBSCRIPTION_ID" --name "$ACR_NAME" \
  --image "orka/teams-setup:$IMAGE_TAG" --query digest --output tsv
```

Set `SETUP_IMAGE_BY_DIGEST` to the second image's fully qualified digest reference.
The derivative adds only the setup supervisor; normal operation uses the ordinary
gateway image. The proxy uses the checked-in public pinned stock NGINX image,
with no identity/ACR credentials.

### Create private setup and proxy configs

Save the following shapes as `bin/teams-operator/setup.json` and
`bin/teams-operator/proxy.json` using the private directory and umask established
above. JSON does **not** expand shell variables: enter the reviewed values
explicitly. The examples intentionally fail validation until placeholders are
replaced. In `setup.json`, use the verified `SETUP_IMAGE_BY_DIGEST` value:

```json
{
  "location": "REQUIRED_AZURE_REGION",
  "environmentId": "/subscriptions/REQUIRED_SUBSCRIPTION_ID/resourceGroups/REQUIRED_RESOURCE_GROUP/providers/Microsoft.App/managedEnvironments/REQUIRED_ENVIRONMENT",
  "gatewayAppName": "orka-teams-gateway",
  "proxyAppName": "orka-teams-public",
  "registryServer": "REQUIRED_REGISTRY.azurecr.io",
  "identityResourceId": "/subscriptions/REQUIRED_SUBSCRIPTION_ID/resourceGroups/REQUIRED_RESOURCE_GROUP/providers/Microsoft.ManagedIdentity/userAssignedIdentities/REQUIRED_BOT_AND_PULL_IDENTITY",
  "operatorAksEgressCidr": "REQUIRED_ORKA_EGRESS_IPV4_CIDR",
  "image": "REQUIRED_REGISTRY.azurecr.io/orka/teams-setup@sha256:REQUIRED_DIGEST",
  "bot": {
    "appId": "REQUIRED_BOT_APP_ID",
    "tenantId": "REQUIRED_TENANT_ID",
    "clientId": "REQUIRED_BOT_UAMI_CLIENT_ID",
    "principalId": "REQUIRED_BOT_UAMI_PRINCIPAL_ID"
  },
  "timeoutMs": 900000
}
```

The 15-minute capture window starts when the setup child starts, not when the human
opens Teams. Have the app installed and the operator/human ready first.

For `proxy.json`, use the same environment and app names, **without** image,
identity, bot or timeout fields:

```json
{
  "location": "REQUIRED_AZURE_REGION",
  "environmentId": "/subscriptions/REQUIRED_SUBSCRIPTION_ID/resourceGroups/REQUIRED_RESOURCE_GROUP/providers/Microsoft.App/managedEnvironments/REQUIRED_ENVIRONMENT",
  "gatewayAppName": "orka-teams-gateway",
  "proxyAppName": "orka-teams-public"
}
```

`deploy/aca/render.mjs` is **offline preparation only**. It reads an explicit
stage config, creates a single ARM template with mode 0600 in an existing output
directory, and refuses overwrite. It does not acquire credentials, read a capture,
make Azure requests, initialize a store, or authorize a transition.

```sh
node deploy/aca/render.mjs --stage setup \
  --config bin/teams-operator/setup.json --out bin/teams-operator
node deploy/aca/render.mjs --stage proxy \
  --config bin/teams-operator/proxy.json --out bin/teams-operator
```

Use separate stage configurations (unknown fields are rejected):

| Stage | Configuration |
| --- | --- |
| All | `location`, full ARM `environmentId`; optional `gatewayAppName`/`proxyAppName` default to `orka-teams-gateway`/`orka-teams-public` |
| Proxy | **Only** the common fields |
| Setup | Common fields + `registryServer`, `identityResourceId` for bot/pull UAMI, `operatorAksEgressCidr`, digest-pinned **setup** `image`, `bot` with `appId`, `tenantId`, `clientId`, `principalId`, and `timeoutMs` (1000–900000) |
| Runtime | The full [example configuration](../deploy/aca/config.example.json), with digest-pinned **ordinary gateway** `image`; no `timeoutMs` |

Runtime configuration contains manually approved routing identities and must
remain private. Complete every placeholder and use numeric audit budgets. The
renderer emits JSON allowlists with ARM literal escaping; do not remove the extra
leading `[` from those template strings. It attaches a separately selected storage
identity if different from the bot/pull identity.

## 4. Capture the installed personal chat

Apply the setup template, then the proxy template with resource-group ARM
**Incremental** deployments. Neither template provisions the environment:

```sh
az deployment group create --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" --mode Incremental \
  --template-file bin/teams-operator/setup-app.arm.json
az deployment group create --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" --mode Incremental \
  --template-file bin/teams-operator/proxy-app.arm.json
```

Setup listens on internal 3978 only. Its HTTP3980 probes indicate **supervisor
liveness**, not successful capture or valid provider credentials. All three probe
types are explicit: the live attempt suffered `ProbeFailure` until liveness was
pointed at 3980 instead of the intentionally closed V1 port. Failed and successful
capture artifacts are held until the operator explicitly stops the supervisor.

Read only the needed app metadata to locate the deployed revision and managed
HTTPS hostname (run for each app name as needed):

```sh
az containerapp show --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" --name "$GATEWAY_APP_NAME" \
  --query '{revision:properties.latestRevisionName,fqdn:properties.configuration.ingress.fqdn}' \
  --output json
```

Use the **proxy** hostname for the bot messaging endpoint and the **main app**
hostname for Orka V1. Do not use `--show-secrets` or dump the entire configuration
into a support report. These metadata fields do not prove readiness or capture.

Record the exact revision and replica. Through the authorized ACA console
(`az containerapp exec --command /bin/sh`, selecting that revision, replica and
container `setup`), privately inspect:

- `/tmp/orka-teams-setup/status`: require `child-running` before sending.
- `/tmp/orka-teams-setup/challenge`: copy privately to the intended human.
- `/tmp/orka-teams-setup/candidate.json`: retrieve privately after `child-closed-ok`.

The directory is 0700; files are 0600, UID/GID 1000. Preserve private permissions
on the operator copy. No capture HTTP endpoint is provided. Do not log the console
stream or paste the challenge/candidate into issue comments. If automating console
retrieval, distinguish shell prompts from file contents, and keep tokens/raw output
out of logs. A CLI connection/exit code is not successful artifact retrieval.

Verify public proxy routing and missing-JWT rejection, then point the approved
Azure Bot's messaging endpoint at the proxy's exact HTTPS `/api/messages` URL.
Record its **previous value** for restoration. Ask the human to send the fresh
challenge verbatim in the installed personal chat before expiration. No Agent
reply is expected for this setup message.

After success, retrieve the candidate **before stopping its replica**. Confirm all
six values against the intended app, tenant, bot, person and personal chat; human
confirmation is required. The renderer does not consume this file or create policy.
If capture expired/failed, inspect and preserve any candidate before retiring the
attempt. A fresh attempt needs a fresh container/private directory and nonce—never
reuse a previous challenge or delete an ambiguous capture.

## 5. Initialize each logical store once

After the prerequisite checks and manual capture/identity review in steps 1–4,
initialize new stores.
**Skip this step entirely for existing initialized stores.** Create two distinct
manual ACA Jobs using the ordinary gateway image and the same environment,
identity and registry permissions. No secret value belongs in initialization arguments.

After assigning the operator's public configuration variables, create the ingress
initializer:

```sh
az containerapp job create --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" --name "$INGRESS_INIT_JOB" \
  --environment "$ENVIRONMENT_ID" --trigger-type Manual \
  --replica-timeout 180 --replica-retry-limit 0 \
  --replica-completion-count 1 --parallelism 1 --cpu 0.5 --memory 1Gi \
  --mi-user-assigned "$STORAGE_IDENTITY_RESOURCE_ID" \
  --registry-server "$REGISTRY_SERVER" --registry-identity "$STORAGE_IDENTITY_RESOURCE_ID" \
  --image "$GATEWAY_IMAGE_BY_DIGEST" --command node \
  --args /app/dist/ingress/main.js init \
  --env-vars GATEWAY_STORAGE_BACKEND=table-v2 \
    TABLE_ACCOUNT="$TABLE_ACCOUNT" TABLE_NAME="$TABLE_NAME" \
    TABLE_INGRESS_STORE_ID="$TABLE_INGRESS_STORE_ID" \
    TABLE_MANAGED_IDENTITY_HOST=azure-container-apps \
    TABLE_MANAGED_IDENTITY_CLIENT_ID="$STORAGE_IDENTITY_CLIENT_ID" \
    TEAMS_APP_ID="$BOT_APP_ID" TEAMS_TENANT_ID="$TENANT_ID" \
    ORKA_BASE_URL="$ORKA_BASE_URL" ORKA_GATEWAY_NAMESPACE="$GATEWAY_NAMESPACE" \
    ORKA_GATEWAY_NAME="$GATEWAY_NAME" \
    TABLE_AUDIT_MAX_PAGES=4096 TABLE_AUDIT_MAX_BYTES=16777216 \
    TABLE_AUDIT_MAX_DURATION_MS=120000 TABLE_AUDIT_MAX_TRACKING_BYTES=8388608 \
    TABLE_MAX_INDEX_BYTES=8388608
```

Here the storage identity also needs ACR pull permission. If using a distinct pull
identity, attach it too and select it explicitly for registry authentication.
For the **separate delivery Job**, use a different job name and argument
`init-delivery`; replace `TABLE_INGRESS_STORE_ID` with `TABLE_DELIVERY_STORE_ID` and
omit only the five audit/index settings. **Keep all three Orka scope variables**:
the CLI parses the common scope even though the delivery partition binding uses
only app/tenant. Keep the physical Table, explicit storage identity and ordinary
image unchanged.

Before each `az containerapp job start`, record a one-time execution intent. Start
each Job **once**, record its execution name, and require actual execution
`Succeeded` with no retries. Do not treat successful Job creation or a timeout as
successful initialization. On an ambiguous/failed execution, stop: no blind rerun,
reset, reinitialization, migration, or replacement store ID. See the exact
[CLI requirements](table-runtime.md#explicit-initialization-and-serving).

These audit values were used for the small live evaluation, not a capacity or
latency guarantee. Record the chosen scope/budgets and carry them into runtime.

## 6. Bind the chat and switch once to normal runtime

Use [the Orka examples](../deploy/orka/) in the actual gateway namespace, with the
existing Agent. Select the public **main app** HTTPS origin for `adapter.endpoint`,
not the Teams-only proxy. Orka validates direct endpoints as public HTTPS; do not
weaken SSRF checks to use ACA-internal DNS.

Create **two distinct** bearer Secrets through the operator's protected secret
manager/stdin workflow. Do not put bearer values in argv, logs or tracked files.
Preserve the required metadata from the [existing secret setup](deployment.md):

| Secret | Required metadata |
| --- | --- |
| Adapter → Orka | label `gateway.orka.ai/inbound-auth=true`; annotation `gateway.orka.ai/gateway-name` = exact Gateway name |
| Orka → adapter | label `gateway.orka.ai/outbound-auth=true`; same name annotation; annotation `gateway.orka.ai/adapter-endpoint` = exact resolved main HTTPS origin **without trailing slash** |

Set Gateway `inboundAuthRef` and `outboundAuthRef` to those distinct Secrets. Create
one `GatewayBinding`: exact tenant `match.accountId`, confirmed personal
`match.contextId`, `senderPolicy.mode: allowlist` with that sender only,
`session.mode: context-sender`, `activeTurnBehavior: queue`, and the chosen Agent.
Do not infer permission from a display name or the existence of a capture file.

Quiesce setup intake/retries, require actual setup child closure, and retain the
retrieved private artifact. Deactivate the exact setup revision and verify its
replicas have gone before transitioning. A control-plane deactivation acknowledgement
alone is not process termination proof.

### Complete the runtime config without mixing identities

Copy the [runtime example](../deploy/aca/config.example.json) into your private
operator directory; do not overwrite an existing configuration:

```sh
cp -n deploy/aca/config.example.json bin/teams-operator/runtime.json
chmod 0600 bin/teams-operator/runtime.json
```

Replace every placeholder, including all five audit budgets with JSON **numbers**,
not quoted strings. Use the same immutable initialized scope/store IDs and the
verified **ordinary** `GATEWAY_IMAGE_BY_DIGEST` (not the setup image). Runtime has
no `timeoutMs`. Carry over the same app names, environment and bot/pull identity.
If storage uses another UAMI, provide its separate resource ID and client ID in
`table`; do not silently substitute a different identity.

Manually map the reviewed capture as follows; never paste the complete capture
into the renderer config or an Orka Task:

| Capture field | Destination / check |
| --- | --- |
| `appId`, `tenantId` | Must match the approved `bot.appId` / `bot.tenantId`; tenant also matches Binding `match.accountId` |
| `recipientId` | Runtime `approvedRecipientId`: the **bot's** Teams recipient identity, not the human sender |
| `serviceUrl` | Runtime `approvedServiceUrl`: the approved Teams HTTPS service URL |
| `senderId` | Binding sender allowlist: the **human's** stable Teams sender ID |
| `conversationId` | Binding `match.contextId`: the confirmed personal chat |

Render only after the manual mapping and scope checks:

```sh
node deploy/aca/render.mjs --stage runtime \
  --config bin/teams-operator/runtime.json --out bin/teams-operator
```

Supply ARM parameters through the operator's protected parameter/secret-manager
workflow, never literal credential-bearing argv:

- `orkaBearerToken` (`secureString`): exactly the inbound Secret's token.
- `orkaOutboundBearerToken` (`secureString`): exactly the distinct outbound token.
- `orkaPublicCa` (`string`): public CA PEM only, not a private key.

The template contains references to these parameters, not their values. Keep any
filled parameter file private/outside version control. The expected shape is:

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "orkaBearerToken": { "value": "REQUIRED_EXISTING_INBOUND_SECRET_TOKEN" },
    "orkaOutboundBearerToken": { "value": "REQUIRED_DISTINCT_OUTBOUND_SECRET_TOKEN" },
    "orkaPublicCa": { "value": "REQUIRED_PUBLIC_CA_PEM_WITH_JSON_ESCAPED_NEWLINES" }
  }
}
```

This is a **shape only**, not deployable credentials. Use your protected workflow
to populate the two existing Secret values and JSON-encode the public CA PEM
(newlines as `\n`); no private key belongs here. ARM `secureString` protects the
parameter's handling, not plaintext files on your workstation. Create the filled
file with mode 0600 inside a 0700 directory **before writing values**, do not print
it, and retain/remove it according to your secret-handling policy.

For example, pass that private file by filename:

```sh
az deployment group create --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" --mode Incremental \
  --template-file bin/teams-operator/runtime-app.arm.json \
  --parameters @/private/operator/runtime-parameters.json --output none
```

The normal image starts `serve`, never `init`. Both existing stores must open/audit
before listeners. All three normal probes use TCP3979; authenticated HTTP V1
probes belong to Orka. Confirm the new replica is ready, then require Gateway
`Ready`/`Connected` and GatewayBinding `Ready`. Missing Secret labels/annotations
block references without rotating credentials. The public proxy remains unchanged.

## 7. Demonstrate and operate

### First request and follow-up

With the normal replica, Gateway and Binding Ready and the provider authenticated,
have the approved human open the installed app's personal chat. For a harmless
conversation check, ask it to remember a made-up word for this conversation, then
ask for that word in a second message. This checks conversation context, not a
durable-memory feature. Use requests appropriate for the configured Agent.

Expect one **Orka reply** card for each successful Task, or an **Orka could not
complete the request** card for a failed Task. No streaming output is expected.
Do not send the setup challenge again; normal messages are new requests.

The operator should confirm the real Task succeeded and both Tasks'
`spec.sessionRef.name` match. Use the intended Task names and safe projections:

```sh
kubectl --kubeconfig "$KUBECONFIG_PATH" --namespace "$GATEWAY_NAMESPACE" \
  get tasks "$FIRST_TASK_NAME" "$FOLLOWUP_TASK_NAME" \
  -o 'custom-columns=NAME:.metadata.name,PHASE:.status.phase,SESSION:.spec.sessionRef.name'
```

`FIRST_TASK_NAME` and `FOLLOWUP_TASK_NAME` are the actual Orka Task names for the
two requests, obtained from your authorized Orka view. Do not invent them or dump
full Task bodies/status, raw activities, prompts, tokens or transcripts. Have the
human confirm both cards arrived in the same chat and the follow-up used context.

### If setup or a reply fails

| Symptom | Check first | Do not do |
| --- | --- | --- |
| Teams upload/install is unavailable | Tenant custom-app policy and approved administrator installation route | Bypass tenant policy or start timed capture before the chat exists |
| `aca-render: invalid-input` | Stage-specific allowed keys, unresolved placeholders, numeric budgets, digest-pinned image, existing private output directory and whether the output already exists | Add unrelated stage fields or overwrite an existing template blindly |
| Setup is live but no candidate appears | Exact revision/replica, `child-running`, correct bot proxy endpoint, fresh unexpired challenge, then `child-closed-ok` and private candidate retrieval | Interpret HTTP3980 health or console exit status as capture success |
| Gateway or Binding is not Ready | Distinct Secret references and metadata, exact main HTTPS origin, trusted CA, approved Orka egress IP, Agent and sender policy | Point V1 at the Teams-only proxy, disable TLS/SSRF/auth checks, or rotate tokens speculatively |
| No Task appears | Normal runtime active rather than setup; approved tenant/sender/chat and supported nonempty personal text | Repeatedly send new messages before diagnosing admission; they can create new Tasks |
| Task fails or no reply arrives | Authorized Task phase, provider readiness/login, gateway readiness and safe delivery state | Treat an uncertain send as permission to retry or resend |
| Store opening/initialization is blocked | Recorded initialization execution, exact immutable scope/IDs and actual previous-owner shutdown evidence | Rerun init, reset stores, change store IDs, or redeploy over an active owner |

See [identity setup](managed-identity-auth.md), [Table lifecycle](table-runtime.md)
and [gateway operations][orka-gateways] for deeper diagnosis. Keep error evidence
bounded and private; do not gather raw request-bearing logs for convenience.

### Conformance and shutdown are separate operations

[Live evidence and conformance results](live-validation.md) separate the passing
authorized-fixture check from the historical unconfigured-route rejection. Use the
Orka checker's explicit `--delivery-fixture` only with approved retained routing
values; it sends a real test reply and repeats the same request. If namespace
isolation blocks fixture access, obtain a separately authorized namespace-scoped
read-only export rather than disabling the guard or borrowing elevated credentials.
Do not use `--reference-fixtures`, a fake tenant/route fallback, or weakened auth
to manufacture a conformance pass.

Before ending an evaluation: inhibit intake/restore the previous bot endpoint,
quiesce Orka delivery, drain/close the actual gateway owners and prove termination
before any replacement or infrastructure stop. Retain journals, receipts, identity
material and private captures according to approved policy. Do not treat cleanup
attempts, Pod deletion requests, replica counts or timeouts as release proof.

No cleanup script deletes a shared resource group or resets Table data. Remove the
Teams demo app through **Apps → Manage your apps** when authorized. Cloud resources
remain billable until explicitly stopped/deleted; resolve platform stop blockers
without disabling Orka admission/webhooks as a shortcut. If a stop is refused,
report that the cluster is still running, not stopped.

## Offline checks

```sh
npm run check
npm run test:app-package   # optional packaging gate; Python 3 required
```

The ACA tests cover renderer/profile contracts and supervisor lifecycle using
synthetic inputs; the existing container gate still tests the ordinary runtime.
No test uploads a Teams app, provisions Azure, or proves crash recovery/HA.

[orka-gateways]: https://github.com/orka-agents/orka/blob/main/website/docs/operations/gateways.md
[upload]: https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload
[validation]: https://dev.teams.microsoft.com/tools/store-validation
