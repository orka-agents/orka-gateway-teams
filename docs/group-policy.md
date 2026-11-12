# Group access policy library

The group-policy library evaluates access to registered Orkas by Entra group and
chat kind. It is not yet wired into `serve-registry`: existing Teams intake still
is refused without choosing a target. This library alone
does not enable self-service, enforce policy on live traffic, create Bindings or
send no-access replies.

## Operator policy snapshot

`readGroupPolicy(file, registry)` reads a bounded, operator-owned JSON file at
startup. `snapshotGroupPolicy(input, registry)` provides the equivalent library
boundary. Neither changes the registry format or target routing digest.

```json
{
  "schemaVersion": 1,
  "graphIdentityClientId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "policies": [
    {
      "schemaVersion": 1,
      "targetId": "platform",
      "frontAgent": "front",
      "rules": [
        {
          "groupId": "11111111-1111-4111-8111-111111111111",
          "chatKinds": ["personal", "groupChat"]
        }
      ]
    }
  ]
}
```

The target must already exist in the registry. `frontAgent` must equal that
target's registered front-agent name. Rules add grants; missing target policy,
empty rules or no matching group grants nothing. There is no wildcard or default
tenant access. Unknown fields, including `agents`, are rejected. Current Orka
cannot enforce different agent limits for each sender's request: these rules
control Orka access only, not delegation inside it.

The file is at most 256 KiB, contains at most 32 target policies and 256 total
rules, and uses UUID group/client IDs. UUID case is canonicalized; target IDs and
names are not repaired. Policy is immutable for a running owner. Policy, registry
or identity selection changes require stopping/draining the prior owner before
restarting; no hot reload is provided. Labels and bearer/CA changes do not become
routing identity changes through this policy.

## Identity and Graph

`createGraphIdentity(clientId)` selects an explicit ACA managed identity through
the existing confined local identity transport. Its fixed resource is
`https://graph.microsoft.com/`. It does not borrow bot or storage tokens, accept
client secrets, or expose an arbitrary audience/endpoint. Use a dedicated Graph
identity; the library does not add a refusal if its client ID equals another
purpose's identity. Identity creation, roles and admin consent remain operator
work, not actions performed by the gateway.

Graph requests use verified TLS and only
`POST https://graph.microsoft.com/v1.0/users/{objectId}/checkMemberGroups`, with
configured group IDs in batches of at most 20. This API checks transitive
membership. Application permissions are `User.ReadBasic.All` and
`GroupMember.Read.All`; hidden memberships additionally need `Member.Read.Hidden`.
Without that permission Graph may silently omit hidden groups. Omission never
grants access; the library cannot distinguish it from non-membership or detect
all server-side incompleteness. No extra permission is requested automatically.
See [Microsoft's membership contract](https://learn.microsoft.com/en-us/graph/api/directoryobject-checkmembergroups?view=graph-rest-1.0).

Responses may contain `value` and optional string `@odata.context`; continuations,
errors, unexpected fields, duplicates and unrequested group IDs fail the entire
lookup. All batches must complete successfully; a successful earlier batch alone
cannot grant or populate the cache. Redirects, retries and response-supplied URLs
are not followed. Each response is at most 64 KiB.

There is no Graph token cache: each uncached membership lookup acquires its own
token, then shares that token across its batches. ACA identity throttling can
therefore cause transient unavailability. The native identity transport is bounded
to five seconds and drains its request/socket even after caller cancellation.
Graph token acquisition and all batches share one caller-supplied monotonic
absolute deadline, capped at ten seconds for membership work. At most 32 actual
lookups/authorizations are admitted concurrently. Graph close cancels requests and
drains native request/socket work before closing the identity source.

## Request-local admission

Call `readPolicySubject(activity, tenantId)` only after the existing transport,
recipient, service, tenant and converter checks. It extracts the UUID AAD object
ID separately from persisted event data: personal `sender.id` remains Teams
`from.id`, shared protocol sender IDs remain unchanged. Missing/invalid AAD has no
fallback to a Teams ID. Unsupported/channel subjects grant nothing. Channels are unsupported in
multi-target mode.

Compose `createGroupAuthorizer(policy, membership)` with the snapshot and
`createGraphMembershipClient(identity)`. Call `authorize(subject, context,
optionalTargetId)` for every new activity, including duplicate commands and
same-target choices. Its only outcomes are:

- `eligible`: eligible target IDs/labels, never URLs, groups or credentials.
- `no-access`: generic text, `You don't have access to an Orka for this chat.`
  This covers no eligible target and unknown/ineligible choices. It authorizes no
  Orka Task or connection.
- `unavailable`, category `graph-unavailable`: failed, partial or expired lookup
  without usable complete cache, cancellation or exhausted capacity. This is a
  transient 503 outcome at future integration, not storage poison or denial.
  Graph 404 for an unknown/guest user also remains transient, not inferred denial.

Only complete successful membership results, including complete denials, are
cached in memory by tenant, object ID and policy digest. Cache age starts before
lookup and is strictly less than 60 seconds under both wall and monotonic clocks.
Clock regression invalidates cache and fails that evaluation closed. Capacity is
1,024 entries with least-recently-used eviction. No persistent roster or delegated
tool identity is created. An unexpired complete result can remain usable during
an outage; group removal stops new admission after this window plus directory
propagation. It does not cancel already accepted Tasks or reauthorize queued work.

The separate directory must reserve durable control routes/attempts before any
no-access, discovery or command reply. Its control sender must preserve replay and
unknown-send rules. Runtime integration must expose the existing handler deadline,
map Graph unavailability without poisoning storage, authorize before new durable
effects, and drain policy work before releasing stores. Those integrations are not
implemented here; do not send this text from an HTTP error handler. Synthetic
library tests do not establish live consent, Teams behavior or reachability.
