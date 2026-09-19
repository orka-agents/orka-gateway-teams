# Orka gateway for Microsoft Teams

Send requests to [Orka](https://github.com/orka-agents/orka) from a Microsoft Teams
personal chat and receive the result in the same conversation.

The gateway connects a Teams bot to an existing Orka installation. It verifies
incoming messages, stores them durably, and forwards them to Orka. Orka runs the
configured Agent; the gateway sends its final result or error back as an Adaptive
Card. Follow-up messages can share an Orka Session through the configured Binding.

## Supported behavior

- **Personal text conversations.** The operator configures an Orka Binding for the
  approved sender and chat. Messages with attachments contribute only their text;
  attachments are not processed.
- **Final replies and errors.** Replies use a single text card. Long answers are
  shortened with a visible notice rather than split into multiple messages.
- **Durable admission and receipt replay.** The inbox retains accepted messages
  for relay to Orka; confirmed delivery receipts prevent duplicate Teams sends
  when Orka retries the same delivery.
- **Two storage options.** Local SQLite is the default. Azure Table V2 is selected
  explicitly for the Azure Container Apps deployment profile.

The runtime does **not** support group chats, channels, threaded replies, files,
streaming or interim messages, or approval buttons. An optional
[shared-room app package](docs/aca-deployment.md#opt-in-shared-room-package-packaging-only)
is available for installation testing; it does not enable shared-room runtime
support. Setup capture is also personal-chat only.

## Getting started

Choose a deployment guide and follow it from prerequisites through the first reply:

| Deployment | Storage | Guide |
| --- | --- | --- |
| Azure Container Apps | Azure Table V2 | [ACA setup and operations](docs/aca-deployment.md) — includes the profile used for the recorded live personal-chat evaluation |
| Kubernetes | SQLite on a persistent volume | [Kubernetes deployment](docs/deployment.md) — includes runtime manifests, storage provisioning, and Orka examples |

You will need:

- An existing Orka installation with a working Agent and provider.
- Permission to register and install the Teams bot/app in the intended tenant.
- The hosting, networking, storage, and credentials required by your chosen guide.

The deployment assets configure the gateway; they do not provision all supporting
infrastructure, register the bot, grant tenant permissions, or install Orka.
The ACA guide uses Table storage and managed identities—do not substitute the
SQLite environment-variable examples for that setup procedure.

Both guides cover app installation, establishing trusted chat identities,
initializing new stores, configuring the Orka Gateway and Binding, and activating
request/reply. [Setup capture](docs/setup-capture.md) collects candidate identities
for operator review; it does not authorize the sender or configure the Binding.

**Upgrading or restarting an existing deployment?** Use the guide's shutdown and
handover procedure. Do not repeat first-install initialization, delete stores to
make startup succeed, or replace an active storage owner.

## Using the chat

Once the operator has enabled request/reply, open the installed app's personal chat
and send a text request for the configured Agent. Successful replies appear as an
**Orka reply** card; a delivered error appears as **Orka could not complete the
request**. Send another message in the same chat to continue, using the Session
policy configured in Orka. The installation challenge is not part of normal use.

If a reply is missing, have the operator check the Gateway, Task, and provider
state before sending the request repeatedly: each new message can create a new
Task. See the [troubleshooting guide](docs/aca-deployment.md#if-setup-or-a-reply-fails).

## Configuration

Configuration is supplied through environment variables; the CLI does not load
`.env` files automatically. Use your deployment's secret manager, not committed
files or command-line arguments, for credentials.

- **Ingress-only is the default.** Full request/reply requires
  `OUTBOUND_ENABLED=true`, separately initialized delivery storage, and distinct
  adapter-to-Orka and Orka-to-adapter bearer tokens.
- **SQLite is the default storage backend.** Table deployments explicitly select
  `GATEWAY_STORAGE_BACKEND=table-v2` and provide the Table identities and budgets
  instead of SQLite paths.
- **Bot authentication is explicit.** Client-secret mode is the default;
  [certificate authentication](docs/certificate-auth.md) and
  [managed-identity federation](docs/managed-identity-auth.md) are separate options
  with their own hosting and identity requirements.

See the [runtime reference](docs/runtime-reference.md) for environment variables,
initialization commands, authenticated V1 endpoints, and operational limits.
The [Table runtime guide](docs/table-runtime.md) supplies the additional Table
configuration. The adapter implements `orka.gateway.v1`; Orka calls its protected
health, capability, and delivery endpoints in full request/reply mode.

## Operating safely

- **Use one storage owner.** SQLite needs an intact local persistent volume and
  a single instance. Table needs stable partitions and controlled clean handover;
  it does not support automatic crash takeover. Do not reset or repair stores by
  deleting their history or ownership records.
- **Do not assume exactly-once delivery.** A confirmed Teams receipt can be
  replayed. If Teams may have accepted a send but its receipt was lost, the gateway
  records an uncertain outcome and does not automatically resend it.
- **Protect data and endpoints.** Stores contain private message/identity data
  and retained delivery history. Expose listeners through HTTPS, restrict the
  outbound API, and keep message bodies and credentials out of access logs.
- **Readiness is local.** Healthy listeners and stores do not prove that provider
  credentials, Teams policy, or the Orka Agent work. Verify a real request and
  follow-up after deployment.

The [live validation report](docs/live-validation.md) records the evaluated
ACA/Table profile and its limits. It is evidence for that deployment, not a
blanket guarantee for every hosting or tenant configuration.

## Development

Use **Node 24 LTS**, npm, and OpenSSL (for synthetic test certificates). From the
repository root:

```bash
npm ci
npm run check
```

`check` runs type checking, the test suite, and the build. Tests use local fixtures;
they do not need live Teams/Azure credentials or a running Orka installation.
Build output goes to ignored `dist/`.

To generate an example card without deploying anything:

```bash
npm run --silent preview:card -- final
```

See [library examples and card preview](docs/library-examples.md) for converter,
formatter, and journal examples. [CONTRIBUTING.md](CONTRIBUTING.md) covers contracts,
focused tests, and the optional container, Kubernetes, and app-packaging checks.

## Documentation

| Topic | Reference |
| --- | --- |
| Deploy and operate | [Azure Container Apps](docs/aca-deployment.md) · [Kubernetes](docs/deployment.md) |
| Configure the runtime and HTTP API | [Runtime reference](docs/runtime-reference.md) · [Table runtime](docs/table-runtime.md) |
| Establish trusted chat identities | [Authenticated setup capture](docs/setup-capture.md) |
| Authenticate the bot | [Certificates](docs/certificate-auth.md) · [Managed-identity federation](docs/managed-identity-auth.md) |
| Understand storage internals | [Table kernel and delivery journal](docs/table-storage.md) · [Table inbox](docs/table-inbox.md) |
| Develop and test | [Contributing](CONTRIBUTING.md) · [Library examples](docs/library-examples.md) |
| Review deployment evidence | [Live validation](docs/live-validation.md) |
