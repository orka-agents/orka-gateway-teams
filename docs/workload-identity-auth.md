# AKS workload identity

Set `TEAMS_CREDENTIAL_MODE=workload-identity` to exchange an AKS projected
service-account token directly for a Bot Framework token. This mode supports
normal serve and authenticated setup capture. It uses the existing fixed,
verified Entra HTTPS transport and the SDK's public token callback. It never
uses node IMDS, an Azure CLI login, or an ambient credential chain.

## Identity and configuration

For an Azure Bot with app type **UserAssignedMSI**, `TEAMS_APP_ID` is the
user-assigned managed identity's client ID. The bot, identity and
`TEAMS_TENANT_ID` must agree. Configure a federated credential on that identity
with the exact AKS OIDC issuer, subject
`system:serviceaccount:<namespace>:<service-account>`, and sole audience
`api://AzureADTokenExchange`. Give the gateway its own Kubernetes service
account; it needs no Kubernetes API permissions for bot authentication.

An application registration that explicitly permits the same direct AKS trust
can also use this mode. Tenant policy must accept its federated credential.
Do not exchange a workload-federated identity token for a separate bot
application token: Entra rejects that chained exchange with `AADSTS700231`.
The existing [managed-identity federation mode](managed-identity-auth.md) uses
VM/ACI/ACA-issued identity tokens and remains a separate option.

| Variable | Workload identity requirement |
| --- | --- |
| `TEAMS_CREDENTIAL_MODE` | Exactly `workload-identity` |
| `TEAMS_APP_ID` | The client ID registered on the Azure Bot |
| `TEAMS_TENANT_ID` | The exact tenant GUID |
| `AZURE_FEDERATED_TOKEN_FILE` | Absolute normalized path to the projected token |
| `TEAMS_WORKLOAD_IDENTITY_ISSUER` | Exact public AKS issuer, including its trailing slash; its tenant must match |
| `TEAMS_WORKLOAD_IDENTITY_SUBJECT` | Exact Kubernetes service-account subject |

Omit `TEAMS_CLIENT_SECRET`, certificate settings, and all
`TEAMS_MANAGED_IDENTITY_*` settings. Mixed credentials fail closed, even when
empty. If the Azure webhook supplies `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` or
`AZURE_AUTHORITY_HOST`, they must match the explicit client, tenant and public
authority `https://login.microsoftonline.com/`. SDK secret/managed-identity
variables, IMDS/ACA endpoint variables and Azure secret/certificate variables
are refused. Changing those variables after preparation also fails closed.

## Projected volume

AKS OIDC must be enabled and its exact issuer trusted by the identity's
federated credential. The workload identity webhook can project the token;
an explicit Kubernetes `serviceAccountToken` projection also works. This
fragment shows the explicit projection to add to an operator's private copy
of the Kubernetes Deployment:

```yaml
spec:
  template:
    spec:
      serviceAccountName: teams
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
      containers:
        - name: app
          env:
            - name: TEAMS_CREDENTIAL_MODE
              value: workload-identity
            - name: AZURE_FEDERATED_TOKEN_FILE
              value: /var/run/teams-identity/token
            # Supply TEAMS_APP_ID, TEAMS_TENANT_ID and the exact issuer/subject
            # through the existing nonsecret runtime ConfigMap.
          volumeMounts:
            - name: bot-identity
              mountPath: /var/run/teams-identity
              readOnly: true
      volumes:
        - name: bot-identity
          projected:
            defaultMode: 0400
            sources:
              - serviceAccountToken:
                  path: token
                  audience: api://AzureADTokenExchange
                  expirationSeconds: 3600
```

Remove the client-secret environment entry from the copied Deployment. Use
UID 1000 for every container in this Pod, including its nginx sidecar, so
kubelet can assign the projected token to that UID. Do not add `fsGroup`:
the SQLite directory must retain its existing private ownership and modes.
Mount the identity volume only in the app container. Keep storage
provisioning in the separate Jobs, without identity mounts.

The token must be a current-UID-owned, regular, single-link file of at most
8192 bytes, mode `0400` or `0600`. Resolved directories must be owned by root
or the process UID and not group/world writable, except root-owned sticky
temporary directories. Kubernetes's `..data` symlinks are supported inside
the selected mount; a token symlink that escapes it is rejected. Do not copy
the token into SQLite storage, capture output, a Secret, logs or source.
Outbound SQLite startup checks token metadata before either store opens and
rejects database/sidecar inode aliases or storage inside the identity mount.

The file is resolved and read on each token acquisition, including MSAL
final-token cache hits. Atomic projection rotation is supported; no projected
assertion cache is kept. Issuer, subject, exchange audience, expiry and
not-before claims are checked before sending the assertion to the fixed
tenant token endpoint. Entra verifies the signature and federated trust.
Invalid files or claims never fall back to another authentication method.

## Setup and verification

[Setup capture](setup-capture.md) uses the same explicit identity settings,
but its deny-only SDK callback never opens the token file or acquires an
outbound token. Ingress-only serve has the same acquisition-free behavior.
The setup command still verifies incoming Bot Framework JWTs independently
and through the SDK, and saves only the six candidate identity fields.
It cannot prove outbound credentials work.

Before normal serving, separately verify that a Pod with the selected
service account can acquire a Bot Framework token for the registered bot.
Never print the projected or acquired token. Then follow the existing
identity-review, private SQLite, HTTPS and directional Orka credential
requirements in the [deployment guide](deployment.md). Local readiness or
token issuance alone does not prove a Teams message/reply round trip.
Use SQLite with this mode. Azure Table's existing storage identity modes
require IMDS/ACA environments and refuse the projected-token environment.

Microsoft references: [AKS workload identity](https://learn.microsoft.com/en-us/azure/aks/workload-identity-overview),
[federated trust configuration](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust),
[Azure Bot identity types](https://learn.microsoft.com/en-us/azure/bot-service/abs-quickstart),
and [chained federation error](https://login.microsoftonline.com/error?code=700231).
