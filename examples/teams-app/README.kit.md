# Orka Teams app kit @@VERSION@@

Each team registers its own bot and deploys a gateway against its own Orka cluster.
A published Teams app points at one bot/cluster; tenant-wide catalog publishing is
not the intended installation path for this kit. This archive is **not** an
uploadable app: complete the placeholders and build your own ZIP.

Requires Python 3 for packaging; Node 24 and npm for optional local schema
validation. No bot secret, tenant ID, chat identity, service URL or gateway
configuration belongs in the Teams package. Keep completed manifests and ZIPs in
a private operator directory, never in a public source checkout.

## 1. Register your bot and prepare deployment

Register your own **single-tenant Azure Bot**, record its Microsoft app ID, and
enable its Microsoft Teams channel. Follow the prerequisites in your chosen guide:

- [Azure Container Apps](https://github.com/@@REPOSITORY@@/blob/v@@VERSION@@/docs/aca-deployment.md)
- [Kubernetes](https://github.com/@@REPOSITORY@@/blob/v@@VERSION@@/docs/deployment.md)

GHCR is the published registry. This release contains linux/amd64 images:

```sh
GATEWAY_IMAGE_BY_DIGEST='@@GATEWAY_IMAGE@@'
SETUP_IMAGE_BY_DIGEST='@@SETUP_IMAGE@@'
docker pull "$GATEWAY_IMAGE_BY_DIGEST"
docker pull "$SETUP_IMAGE_BY_DIGEST"
```

Use these immutable references, also listed in `image-digests.txt`, instead of
building the two images yourself. The release owner must make both GHCR packages
publicly readable; an anonymous pull must succeed before installation. Do not use
mutable version tags for deployment. Kubernetes can pull public GHCR directly;
configure the ordinary gateway image, not the setup derivative, in its runtime.
Do not repeat store initialization on an existing deployment.

### Team-owned ACR when required

If your hosting or policy requires ACR, import each public GHCR digest into **your
team's own ACR**. The existing ACA renderer specifically requires ACR and a
managed-identity pull assignment; it does not accept GHCR directly. There is no
project-owned ACR. With your own subscription and ACR selected, for example:

```sh
SUBSCRIPTION_ID='<your subscription ID>'
ACR_NAME='<your ACR name>'
az acr import --subscription "$SUBSCRIPTION_ID" --name "$ACR_NAME" \
  --source "$GATEWAY_IMAGE_BY_DIGEST" --image 'orka/teams-gateway:@@VERSION@@'
az acr import --subscription "$SUBSCRIPTION_ID" --name "$ACR_NAME" \
  --source "$SETUP_IMAGE_BY_DIGEST" --image 'orka/teams-setup:@@VERSION@@'

# Verify both destination manifests independently; do not just trust import success.
GATEWAY_DIGEST=$(az acr repository show --subscription "$SUBSCRIPTION_ID" \
  --name "$ACR_NAME" --image 'orka/teams-gateway:@@VERSION@@' --query digest --output tsv)
SETUP_DIGEST=$(az acr repository show --subscription "$SUBSCRIPTION_ID" \
  --name "$ACR_NAME" --image 'orka/teams-setup:@@VERSION@@' --query digest --output tsv)
test "$GATEWAY_DIGEST" = "${GATEWAY_IMAGE_BY_DIGEST##*@}" || exit 1
test "$SETUP_DIGEST" = "${SETUP_IMAGE_BY_DIGEST##*@}" || exit 1
REGISTRY_SERVER=$(az acr show --subscription "$SUBSCRIPTION_ID" \
  --name "$ACR_NAME" --query loginServer --output tsv)
GATEWAY_IMAGE_BY_DIGEST="$REGISTRY_SERVER/orka/teams-gateway@$GATEWAY_DIGEST"
SETUP_IMAGE_BY_DIGEST="$REGISTRY_SERVER/orka/teams-setup@$SETUP_DIGEST"
```

If either digest differs, stop and investigate; do not substitute a mutable tag or
skip verification. Record the resulting ACR references and use them in the ACA
stage config and pull-identity procedure. The release records GHCR references;
your deployment records the verified references in your own registry.
[Microsoft's import guide](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-import-images)
explains import permissions and network restrictions. Use approved tenant/registry
access; do not add credentials to the kit.

**Prepare hosting now, but do not start timed setup capture yet.** Install the app
and ready the participant first, then follow the deployment guide's capture,
manual identity review, initialization and activation gates.

## 2. Complete, package and validate your app

Choose `manifest.template.json` for personal chat, or
`manifest.shared-rooms.template.json` for personal/groupChat/team scopes:

```sh
umask 077
mkdir operator
cp manifest.template.json operator/manifest.json
# For shared rooms, copy manifest.shared-rooms.template.json instead.
```

Fill **every** `REQUIRED_...` value in the copy: a Teams app GUID, your registered
bot app ID, developer name, and your approved support/privacy/terms HTTPS URLs.
The app GUID and bot app ID may be equal but are separate fields; neither is a
managed-identity principal ID. Review the name/description for your deployment.
The shared template's root `supportsChannelFeatures: "tier1"` is needed for
Developer Portal channel installation; it grants no RSC permissions.

The included generic ring icons are original placeholder artwork: `color.png` is
192×192; `outline.png` is white on transparent at 32×32. Review them or replace
with your team's approved non-interlaced 8-bit RGB/RGBA artwork (outline RGBA).
The packager checks PNG headers, not decoded pixels or visual design.

```sh
BOT_APP_ID='<your registered bot app ID>'
python3 package-teams-app.py --bot-id "$BOT_APP_ID" --profile personal \
  --manifest operator/manifest.json --color color.png --outline outline.png \
  --output operator/teams-app.zip
# Use --profile shared-rooms for the shared template.
```

`--bot-id` is required, including for older invocations. It must match the
completed manifest. The packager never fills placeholders, widens scopes, rewrites
reviewed manifest bytes, overwrites an existing ZIP, or uploads anything. The ZIP
contains only root `manifest.json`, `color.png`, and `outline.png`.

Validate in the [Teams Developer Portal](https://dev.teams.microsoft.com/apps),
or perform optional local full-schema validation before upload:

```sh
npm install --prefix operator/validator --ignore-scripts --no-audit --no-fund \
  ajv@8.17.1 ajv-draft-04@1.0.0 ajv-formats@3.0.1
curl --fail --silent --show-error --location \
  https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json \
  --output operator/schema.json
node validate-teams-app.mjs --manifest operator/manifest.json \
  --schema operator/schema.json --tools-dir operator/validator
```

Local schema acceptance does not prove Developer Portal acceptance, installation
permissions or runtime readiness. Use a new ZIP filename for each reviewed change.

## 3. Upload before timed capture

In Teams desktop/web, select **Apps → Manage your apps → Upload an app → Upload a
custom app** and choose your ZIP. Alternatively, import the ZIP in the Teams
Developer Portal and use **Preview in Teams**. Review the app in the intended
personal/group/team context. See
[Microsoft's custom-upload instructions](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload).

If your tenant blocks custom upload, stop and use its approved process. Never
change tenant policy or request extra permissions as a workaround.

Only **after installation and participant readiness**, start the timed setup
capture from the deployment guide. Capture is personal-chat only; manually
confirm the candidate identities before authorizing anything. Package/upload,
capture and authorization are separate steps.

## 4. Bind the intended conversations and activate

Follow the guide to connect the gateway to your own Orka, create each Binding,
then activate and verify a real request/reply and follow-up.

- **Shared rooms:** create a Binding for each exact verified tenant/conversation
  (and channel root where required), with `senderPolicy.mode: all`; omit
  `match.senderId` and `allowedSenderIds`. Teams membership is the access boundary,
  including guests/federated participants. Review the whole room's audience,
  Agent access and shared history; the gateway does not query membership.
  [Shared-room setup and rollback](https://github.com/@@REPOSITORY@@/blob/v@@VERSION@@/docs/shared-rooms.md)
  covers bot mentions, thread identity and Session policy.
- **Personal chats:** the current Orka model still needs a separate Binding for
  each person's exact conversation/sender. This kit does not remove that limit or
  change authorization. See [Orka #736](https://github.com/orka-agents/orka/issues/736).

Installing the app alone does not grant access to Orka. Keep one storage owner and
follow the guide's shutdown/handover procedure for upgrades. Existing personal
live evidence is not a qualification of every shared-room or hosting variant.
