# Teams meeting drafts

An opt-in structured `reply_in_conversation` message can show one **Open in Teams**
button for the current personal or group chat. It opens Teams' meeting composer;
**nothing is scheduled or sent by the gateway**. People review attendees and use
Teams Scheduling Assistant to choose and confirm the final time. There is no
calendar availability lookup, Graph/directory access, new Entra permission, RSC
permission, per-user attendee allowlist or new dependency.

## Controller first, gateway flag second

This additive `orka.gateway.v1` feature requires the typed tool, transport,
controller/worker and CRD support from [Orka #810](https://github.com/orka-agents/orka/pull/810).
The unchanged protocol discriminator does not make older readers compatible.
Older strict controllers reject unknown capability fields, even `false`.

1. Follow the supported Orka controller/worker/CRD upgrade and backup procedure
   first, with meeting drafts still disabled on the gateway. Confirm the running
   controller and worker support the typed contract and the existing Gateway and
   Binding are ready. A prompt alone does not grant tool or transaction policy;
   existing sealed ACP profiles/sessions are not silently upgraded.
2. On the normal gateway process, require `OUTBOUND_ENABLED=true` and
   `INTERIM_DELIVERY_ENABLED=true`, then set `MEETING_DRAFTS_ENABLED=true`.
   Only exact lowercase `true` and `false` are accepted. Omission defaults off;
   enabling without outbound plus interim fails before store ownership/listening.
   Init commands do not enable the feature.
3. Use a controlled process replacement: settings are captured at startup, not
   hot toggles. Prove the prior owner's actual work drained and its ownership
   released before starting a successor, particularly with Table. Preserve the
   same scope, store IDs, partitions, routes, journals and correlation history;
   never reinitialize/reset stores to enable the feature.
4. Confirm the authenticated `/v1/capabilities` response adds
   `capabilities.meetingDrafts: true` and the controller's **current ready
   observation** includes it. Omitted/false settings omit the field entirely.
   Local listener readiness is not controller readiness or tool availability.

Default deployment assets stay off; the ACA renderer's closed profile has no
meeting-draft option. Add the nonsecret variable only to a separately reviewed
operator-owned runtime environment during a clean owner handover. No deployment,
Agent or Binding change is included here.

SQLite and Table use the same flag validation and receiver composition.
Standalone library composition must pass matching `meetingDrafts?: boolean`
settings to `startOutboundServer` and `createDeliveryDispatcher`; `true` requires
`interimDelivery: true` on both. `startReceiver` accepts these in its outbound
options. `startIngressRuntime` propagates its validated snapshot to both sides.

## Typed contract and immutable delivery

The tool keeps its required ordinary `content` and may add a closed `meetingDraft`:

- `subject`: nonempty, at most 200 UTF-8 bytes;
- `agenda`: 1–5 nonempty items, at most 256 UTF-8 bytes each;
- `durationMinutes`: integer 1–480, default 30 before metadata projection;
- `attendees`: `{mode: "everyone"}` or `{mode: "named", names: [...]}` with
  1–10 full display names, each nonempty and at most 128 UTF-8 bytes;
- optional `preferredWindow`: nonempty, at most 256 UTF-8 bytes;
- optional `suggestedStart`: a valid concrete ISO timestamp with explicit UTC
  offset (or `Z`). The end is calculated from the duration in that fixed offset.

Draft strings must be well-formed Unicode without Cc controls. Unknown properties,
email/UPN names, destinations, URLs, cards and directory/member IDs are not allowed.
Oversized/invalid fields are rejected, never sanitized or truncated. Tool success
means durable Orka admission, not Teams delivery or meeting creation. Existing
policy, per-Task quota, ordering and final/error semantics still apply.

The controller derives these stable metadata keys, not arbitrary model metadata:

| Key | Value |
| --- | --- |
| `meeting.version` | `1` |
| `meeting.subject` | Exact subject |
| `meeting.durationMinutes` | Canonical decimal duration, including the default |
| `meeting.attendees` | `everyone` or `named` |
| `meeting.agenda.0` through `.4` | Contiguous agenda items starting at zero |
| `meeting.name.0` through `.9` | Contiguous names for named mode only |
| `meeting.preferredWindow` | Optional exact preference |
| `meeting.suggestedStart` | Optional explicit-offset timestamp |

The gateway independently decodes this projection, refusing unknown `meeting.*`
keys, gaps, wrong versions, contradictory modes and invalid/bounded values. The
maximum projection is 21 keys within V1's 32-entry metadata limit. Ordinary text
is not parsed for meeting instructions, and structured drafts are only accepted
on interim `kind: "message"`. Draft metadata participates in the existing
immutable delivery fingerprint: changing a draft under the same identity conflicts.
No new journal schema, marker or fingerprint version is introduced.

## Private, current-chat attendee resolution

For a **new authorized claim**, the gateway uses only the already saved route:
current tenant, bot recipient, allowed HTTPS service URL and exact conversation ID
must match. There is no user-selected destination. It lazily obtains the same
receiver SDK App's bot token and GETs
`/v3/conversations/{encoded exact conversation.id}/pagedMembers`. TLS is verified;
redirects, environment proxies and hidden retries are disabled. One response is
bounded to **256 KiB and 1000 records**. An unexpected continuation token,
duplicate record identity or malformed page cannot prove a complete chat roster.

The installed bot and non-person/bot accounts are excluded. Personal chat must
prove exactly one current person. `everyone` requires a usable UPN for every
selected person. Named mode requires each requested name to uniquely match a full
current display name (case-insensitive, surrounding whitespace ignored); no
partial/fuzzy/directory match is used. Duplicate selected UPNs are deduplicated.
Valid guest UPNs, including their `#EXT#` spelling, remain eligible. Missing UPNs
never fall back to `email`.

Roster-derived UPNs/addresses exist only in per-attempt gateway memory and the
outgoing Teams button URL. They **never reach model prompts, tool receipts,
protocol metadata, journal records, saved routes, local storage, logs, errors or
telemetry**. Roster-derived email-looking display labels are hidden. User-typed
text is outside this roster-privacy boundary. The outgoing link necessarily
shares attendees with Teams and people able to inspect/copy the card; treat that
as part of the chat's audience/privacy review, not as address-free delivery.

## Link, presentation and safe failure

The fixed destination is `https://teams.microsoft.com/l/meeting/new`. Subject,
comma-separated UPNs and agenda are encoded with `encodeURIComponent` (`%20`
spaces, `%2B` positive offsets). Concrete suggestions include start and computed
end; untimed drafts include neither time query. There is **no duration query
parameter**. Duration/window are visible suggestions; duration-only drafts have
**no guarantee** that the Teams composer will prefill a matching duration.

The entire encoded URL must fit **2048 characters**. This is a local safety
policy, not a Microsoft guaranteed maximum or cross-client compatibility claim.
The complete UTF-8 JSON activity is measured against **20 KiB**, including card,
fallback, room attribution and channel reply root. One Adaptive Card 1.4 is sent,
without duplicate ordinary activity text; fallback is at most 512 bytes. Structured
subject, agenda, requested names and time suggestions are never silently shortened.

Channels do **zero roster GETs** and show a visible no-action draft under the same
claim, preserving the saved reply root. Unsupported scope, permanent GET failures
(including 401/403), incomplete/invalid roster, outsiders, ambiguous names, missing
or invalid selected UPNs, and URL/card overflow likewise show a no-action card.
No partial recipient list/link is substituted. If auxiliary roster display names
make the card overflow, their entire preview is explicitly omitted with the full
count preserved; every structured draft field remains visible. Meeting-flag
withdrawal alone yields a no-action card for a fresh otherwise-authorized message.
An invalid/foreign route or withdrawn interim capability permits **no send**.

Historical journal receipt/uncertainty replay comes **first**, even after flags
or allowlists change: no roster GET and no second provider POST. Token or transient
GET failure is pre-effect retryable under the original claim. GET and send share
one at-most-nine-second dispatch budget; no separate queue, roster cache or retry
loop is added. Token acquisition is singleflight and uncancellable SDK work is
actually drained. Shutdown fences late GET/POST continuations and drains actual
roster/token/provider work before either store closes. Once handed to POST,
existing unknown/lost-receipt semantics are unchanged: uncertainty is never resend
permission.

## Withdrawal and qualification

Pause new draft intake and **settle or explicitly abandon pending drafts with the
supporting controller before withdrawing capability or downgrading**. The
controller rechecks `meetingDrafts` at dispatch. Then cleanly replace the gateway
with the flag false/omitted and confirm the controller observes its withdrawal.
Never run old readers/dispatchers against pending meeting metadata. Preserve
historical journals and routes; unchanged storage schemas are not downgrade proof.
The [interim withdrawal](interim-delivery.md#disable-and-roll-back-safely),
[shared-reader rollback](shared-rooms.md#rollout-and-rollback) and
[Table handover](table-runtime.md#operational-and-verification-boundary) constraints
also apply.

The roster is a **static draft-time snapshot**, not click-time revalidation. Each
clicker may open their own composer; repeated/multiple clicks are not scheduling
idempotency. Membership, permissions and availability may change before a click.
Synthetic tests exercise verified native GET/POST, bounded/private roster handling,
closed decoding, no-action states, SQLite/Table receipt replay, cancellation and
actual-work ownership drain. They do not qualify live Teams rendering, tenant
policy, controller readiness or desktop/web/mobile/guest composer behavior.

With separate approval for a live check, inspect the composer **without sending**
first on desktop and web, including multiple clickers. Check the full subject,
agenda, attendee list and explicit-offset start/end; test untimed duration/window
behavior separately. Mobile and guests need their own qualification. Do not claim
any invitation was sent or meeting scheduled merely because the button opened.
