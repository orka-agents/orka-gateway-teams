# Coding-agent configuration example

This inactive example pairs a native Orka front with a Claude coding Agent.
The coder edits and tests; Orka's separate Workspace/Publisher pushes a branch.
The intended Teams flow then asks for approval before the gateway opens a PR.
**The gateway approval flow is not implemented by these files. Do not activate a
GatewayBinding for this example until that integration is available.**

`agents.json` is a Kubernetes List containing only two Agent templates. It is not
included in the default deployment, the `deploy/orka` directory or the app kit.
It creates no namespace, provider, Secret or Binding, and changes no running route.
JSON is valid YAML; keep multiline prompt text escaped inside the JSON strings.

## Limited evaluation, not a shared-user profile

The default native worker can read namespace Secrets and use broad coordination
tools. This example is only for a separately approved, single-owner test-tenant
evaluation with one throwaway repository, an expiring fine-grained publication
token and a dedicated Orka release/watch namespace. It is not a production
credential boundary. **Explicit effective tool selection is required before
anyone other than that owner uses the agent.**

Coordination injects the following tools even though `spec.tools` only opts into
`reply_in_conversation`; that list does not subtract or disable implicit tools:

- `delegate_task`, `wait_for_tasks`, `create_container_task`, `cancel_task`
- `send_message`, `check_messages`
- `create_pull_request`, `list_pull_requests`, `check_pr_review_marker`,
  `check_pull_request_ci`, `merge_pull_request`, `auto_merge_pull_request`
- `review_pull_request`, `post_review_comment`, `create_agent`, `delete_agent`,
  `update_plan`
- Legacy memory: `recall_memory`, `remember`, `propose_memory`, `search_transcript`

Autonomous coordination is off, so `request_approval` is not injected. The reply
tool is available only to eligible gateway roots. Individual calls still face
RBAC, credential and broker checks. The prompt's single-child, new-branch,
`createPR=false` and no-PR/merge instructions are **not enforced publication
policy**. A compromised front can read the publication token or change the coder.
The configured one-child concurrency limit is not a total delegation-attempt cap.

The controller reads namespace Secrets and the publisher receives credentials
through its operation-bound broker. The default worker can also reach co-located
publisher bearer/capability material, provider-proxy authentication, SCM egress,
artifact and signing secrets, and webhook TLS keys where enabled. That reaches
model spend and infrastructure authority beyond the throwaway repository.
Inventory actual ServiceAccounts, mounts, other workloads, namespace/cluster
administrators, Pod/exec authority, node/control-plane operators and backups before
loading any token; a chart alone is not the deployed reader inventory.

## Prepare a private operator copy

No live credentials or values belong in this repository. A later, separately
approved deployment must supply:

1. A dedicated Orka release and watch namespace, replacing
   `required-isolated-namespace` on both Agents. Do not place this in a shared
   release namespace. Keep the two distinct example Agent names, or update the
   front's allowed coder and prompt together if renaming them.
2. A native Provider and model for the front, replacing `required-native-provider`
   and `REQUIRED_NATIVE_MODEL`. Leave its `spec.runtime` absent: Orka creates a
   native AI root for that Agent, not a Claude runtime root. A later native-front
   Binding must not set `taskDefaults.agentRuntimeMaxTurns`; Orka rejects that
   runtime-only override for native AI Tasks.
3. A working Claude ACP model route, replacing `REQUIRED_CLAUDE_MODEL`. The coder
   has explicit `type: claude` and `contractVersion: orka.harness.v2`, with no
   `providerRef` or `runtimeRef`. `model.contextWindow` is optional for Claude.
4. A single disposable repository owned by the evaluator. Replace the two repo
   URLs and both `REQUIRED_BASE_BRANCH` values inside the front's prompt. Inspect
   push workflows, installed Apps and automation first: a pushed branch can run
   code with another credential before any PR approval.
5. The expiring repository token referenced by `required-repo-publish`. It needs
   contents-write and only necessary reads for that repository, not PR-write,
   workflow-write or administration. The same token reference covers read and
   publication operations through the publisher's operation broker, not a direct
   coder token setting. This is not a live proof of token absence in the workspace.
   Keep the gateway's PR credential separate and out of this namespace. Do not supply a
   forge credential to the front or coder and do not borrow a host's `gh` login.
6. Later gateway integration must supply an intended new branch derived from the
   saved request identity and independently check the child. No branch name is
   taken from chat history. An existing branch is failure, not overwrite or an
   automatic alternate name. This configuration alone does not supply that input.

The intended front delegates one 20-minute child inside the unchanged 30-minute
root budget. It repeats waits for that same child while `completed` is false;
a wait timeout is not terminal failure or permission to delegate again. It does
not enable automatic repair. The coder allows workspace
Read/Write/Edit/Bash/Glob/Grep for at most 30 turns. These instructions and defaults
are not a model-isolation boundary.

Use a matching immutable Orka controller/worker/runtime/publisher image set,
runtime pools, durable control storage and configured artifact/SCM services.
The provider proxy is disabled by default in Orka v0.3.0; a native Provider alone
does not enable Claude ACP. Enable and qualify the session-authenticated provider
route separately. This example follows the v0.3.0 Agent/runtime shape, but has
not been live-qualified. See the [deployment guide](../../docs/deployment.md) and
[ACA guide](../../docs/aca-deployment.md) for existing gateway prerequisites;
neither guide activates this coding example.

Before showing an approval card, the gateway still needs independent event/root/
child correlation, successful exact publication, a present empty `remoteBeforeSHA`,
matching commit SHAs, no Orka-created PR, and a GitHub head read. `VerifiedExact`
is not test or CI success. A changed branch can race with PR creation. Cards,
durable approval, one-use PR creation and uncertain-result recovery are later
integration work, not capabilities supplied by this manifest.

Revoke the publication token on completion or abort, then clean up only approved
owned resources. Secret deletion alone is not revocation. No cloud, credential,
Teams or cluster operation is authorized by copying these templates.
