# Subscription self-check proposal

Status: design only. Nil must approve before implementation. Task cdaf6ec6.
Source review: 2026-09-09, base commit 920a89c7. Line references below refer
to that base. This lane adds no subscription route and requires no restart.

## Route and access

Propose `GET /api/agents/:id/subscription`, with no body or query options.
Use exactly `cap("self:affordance", agentParamMustEqualTokenAgent)`, as the
context route does in `server/routes/table.ts:560`.
The agent sends its own bearer token. The guard requires agent scope, a
nonempty token agent id, and an exact match with `:id`
(`server/identity/guards.ts:268`). A different agent gets 403, including a
privileged agent. Browser users, remote user API tokens, cron runs and apps
cannot pass this guard. An unauthenticated request gets 401. Do not add an
owner override. Existing context HTTP tests pin own-token 200, cross-agent
403, browser-cookie 403 and no-identity 401
(`server/test-support/context-usage.test.ts:1039`).

An authorized request gets 200 even when allowance data is unavailable.
The route reads account usage; it does not send a prompt, create a session,
write a conversation entry, or change allowance. A provider read may update
the existing in-memory usage cache. Use `Cache-Control: no-store` on the
response. No account identifier, credential, environment path or raw provider
payload appears in the response.

## Proposed response

```ts
type SubscriptionSelfCheck = {
  available: boolean;
  provider: "claude" | "codex" | "opencode";
  reason: null | "not_yet_measured" | "no_session" |
    "provider_unavailable" | "refresh_failed" | "account_changed" |
    "identity_unverified";
  delivery: "provider" | "cache" | "none";
  checkedAtMs: number;
  sampledAtMs: number | null;
  observedAtMs: number | null;
  ageMs: number | null;
  plan: string | null;
  windows: {
    label: string;
    usedPercent: number;
    resetsAtMs: number | null;
    observedAtMs: number | null;
  }[];
  primaryIndex: number | null;
};
```

| Field | Source | Meaning and freshness |
| --- | --- | --- |
| `available` | Manager's committed, identity-valid sample | True only with at least one usable window. Cached data can be available. |
| `provider` | Current `AgentInfo.agentType` | Re-read after awaits, with the identity generation. |
| `reason` | Manager refresh outcome | Null for a successful current read, including an adapter cache read. Otherwise explains why no new data can be obtained. Available cached data can have a non-null reason. |
| `delivery` | Adapter observation metadata plus manager fallback | `provider` only if this check receives new provider data; `cache` if it serves already received data; `none` if no valid sample exists. This is not a promise of current provider state. |
| `checkedAtMs` | Server clock at response construction | When Isomux handled this request. Never the age origin. |
| `sampledAtMs` | Manager clock at successful sample commit | When the manager accepted the adapter answer. Preserve the timestamp for fallback; an adapter cache read can advance it. |
| `observedAtMs` | Adapter receipt metadata, added by the implementation | Oldest known receipt time among the returned plan and window fields. Null if any required provenance is unknown. It is an Isomux receipt time, not a provider measurement timestamp. |
| `ageMs` | `max(0, checkedAtMs - observedAtMs)` | Null when observation time is unknown. Repeated cache reads cannot make this smaller by assigning a new observation time. |
| `plan` | Normalized Claude `subscription_type` or Codex `planType` | Nullable even when windows exist. Track its receipt time internally for aggregate age. |
| `windows` | Existing provider normalization, with receipt metadata | All usable windows for the selected allowance, in adapter display order. Empty only when unavailable. No fabricated weekly row. See the scope question below. |
| `windows[].label` | Claude fixed/model-scoped label; Codex duration-derived label | Same labels as the current adapter. Track retained duration metadata so a sparse update cannot make the label appear newly observed. |
| `windows[].usedPercent` | Provider percentage | Finite, clamped to 0–100 at the adapter and wire boundary. This is usage, not remaining allowance or a token count. |
| `windows[].resetsAtMs` | Provider reset time converted to epoch milliseconds | Null if absent or invalid. Do not infer a reset from the window duration or polling time. |
| `windows[].observedAtMs` | Adapter field provenance | Oldest receipt time among that window's percentage, label metadata and non-null reset. Null if any contributing field lacks provenance. |
| `primaryIndex` | Existing `pickPrimaryWindow` | Index of the most-used window, not a filter on returned windows; null without a sample. |

Without a valid sample, `delivery` is `none`, all sample timestamps, age, plan
and primary index are null, and windows is empty. Do not return prior-account
data in any field. A normal cache answer has `available: true`,
`delivery: "cache"`; a failed refresh adds `reason: "refresh_failed"`.

### Observation provenance

The present `SubscriptionUsage` interface has no observation timestamp
(`server/backends/types.ts:300`). The manager stamps `Date.now()` each time it
commits a usage answer (`server/agent-manager.ts:3526`), even if the adapter
returned its cache. Therefore the existing `sampledAtMs` cannot establish data
freshness. Do not reuse it as `observedAtMs` or call it provider time.

Implementation must extend the internal adapter result, keeping the current
tri-state semantics. Claude records receipt time after a successful SDK reply;
its existing initiation timestamp remains the throttle clock. A cache return
keeps receipt time unchanged. Codex records receipt time on the initial read
and each push, separately for each field retained by the sparse merge.
The existing late-baseline rule still applies: the read must not replace a
push that overtook it. A recently received percentage does not refresh an old
reset or plan. Aggregating the oldest contributing field time gives a
conservative age; it does not claim every field was measured together.
No provider measurement timestamp is present in the normalized contract, so
this proposal does not expose one.

## Read path and cases

Reuse the manager's account generation and monotonic sequence checks. Add
an awaited self-check trigger to the same commit path, with one in-flight
refresh per agent. Read `managed.subscriptionUsage`, not only the UI copy:
`usage_update` can suppress a broadcast when the displayed values match.
Keep the current adapter throttle and push cache. A check must not require a
turn boundary, wake a released session or force a Codex network read when the
adapter already has data. Bound the endpoint's wait for a pending adapter call; after that deadline
serve the valid cache with `refresh_failed`. This is a proposed wait bound,
not a claim that both adapters already have a deadline. The implementation
plan must select and test the concrete deadline and late-result behavior
before landing.

| Case | Result |
| --- | --- |
| Active turn, session available | Attempt the adapter read immediately. Return new data with `delivery: provider`, or the adapter cache with `delivery: cache` and unchanged observation age. No wait for `turn_completed`. |
| Released/replaced session, valid same-account cache | Return available cache. With no session, reason is `no_session`. Replacement itself does not clear the account sample; a late result may commit only if generation and sequence still match. |
| Never measured or server restarted, no sample | With a session, try the adapter. Without a session return `not_yet_measured`; startup does not restore allowance data from disk. If an attempted read fails, return `refresh_failed`. |
| Provider/account authoritatively unavailable | Clear the old sample through the guarded commit path. Return `provider_unavailable`, empty windows and null sample fields. This also covers a successful response with no usable window. |
| Transient refresh failure or unknown answer | Preserve the valid same-account sample and its observation time. Return available cache with `refresh_failed`, or unavailable with that reason if there is no sample. Do not infer that a subscription has expired. |
| Account/provider changes while a read is pending | Clear synchronously, increment generation, and discard old-generation completions. Return `account_changed` until the new identity has a valid sample; never fall back to the old account. |
| Account identity cannot be verified after a possible change | Quarantine the old reading and return `identity_unverified`. A failed usage RPC alone is not a possible identity change. See identity gap below. |
| OpenCode | Return `provider_unavailable` without opening a session. Both current OpenCode adapter variants return unavailable (`server/backends/opencode/adapter.ts:201`, `:291`). Do not substitute token usage or cost for subscription allowance. |

Reason precedence: identity change/unverified identity first; known unsupported
provider next; failed/unknown attempted read next; no session with cache next;
otherwise no measurement. A successful identity-valid sample clears an earlier
reason. Store the last authoritative absence/identity reset reason separately
from the sample so a later no-session read does not hide what is known.

### Identity gap that must be closed

The current generation resets only on engine switch, cross-engine resume and
rollback (`server/agent-manager.ts:7472`, `:7690`, `:7712`). The code does not
prove that a same-engine CLI login or an environment credential change still
uses the same account. The filing's claim that account changes reset the cache
is too broad. Reusing these guards is necessary but insufficient for a promise
that prior-account data cannot leak.

Before implementation, specify an internal account binding: provider plus
environment source/revision plus provider-auth identity when available.
Invalidate both manager and adapter caches on a binding change, not just the
manager value. Carry that binding and generation with every in-flight read.
Never expose the binding in this endpoint. A changed credential source with
no confirmed account identity must return `identity_unverified`; fresh data
can become available once the provider confirms the new binding. Same-account
session release retains its sample. An external CLI login that Isomux does
not observe is a remaining limitation until the provider identity check is
defined. Do not claim this requirement is already satisfied by the code.

## Filing audit

| Filing claim | Verdict and source |
| --- | --- |
| Refresh on turn completion and usage updates | Correct: calls at `server/agent-manager.ts:3905` and `:4014`. The comment in `server/backends/types.ts:319` that says only turn boundaries is stale. |
| Cache survives session replacement/release | Correct for unchanged engine/account generation: `server/agent-manager.ts:3453` explicitly omits a session guard; `server/session-manager.ts:278` installs the pointer and `:556` releases it without changing allowance state. Allowance reset call sites are the three engine transitions listed above. |
| Fresh backend sampling needs a session | Manager sampling requires a session (`server/agent-manager.ts:3469`); that does not mean a network read is fresh. Adapter caches can answer it. |
| Unknown/failed reads preserve last sample | Correct: catch and unknown return before commit (`server/agent-manager.ts:3478`). |
| Authoritative unavailable clears | Correct with generation/sequence guards: `server/agent-manager.ts:3506`–`:3513`. |
| Provider/account identity changes reset | Correct for engine transitions only; same-engine account changes are not guarded by these call sites. See identity gap. |
| Cache starts empty after restart | Correct: restored managed records initialize usage null and counters zero (`server/agent-manager.ts:1942`); fresh spawn also does (`:4880`). |
| Codex pushed cache plus initial read fallback | Correct with qualification: `server/backends/codex/adapter.ts:1180` reads when the bucket map is empty. `:1243` single-flights but does not permanently suppress another empty-map read after settlement. Failed requests can retry. Push merge is at `:1593`. |
| Claude throttled SDK RPC | Correct: `server/backends/claude.ts:511`; 60-second initiation interval at `:355`, shared in-flight call at `:526`, failed RPC is not cached. A normalized unknown reply can be cached because only exceptions bypass `lastUsage`. |
| Existing sample timestamp might describe provider observation | It does not: manager commit time at `server/agent-manager.ts:3526`. Claude cached results and Codex bucket reads do not carry observation time today. |

## Window coverage and questions for Nil

The existing Claude adapter includes five-hour, weekly, weekly Opus, weekly
Sonnet and weekly model-scoped windows (`server/backends/claude.ts:342`,
`:419`). It excludes OAuth-app allowance and monetary overage on purpose
(`:335`). Codex selects one bucket (prefer `codex`, then legacy, then first)
at `server/backends/codex/adapter.ts:385`; normalization returns both primary
and secondary windows, longest first (`:464`). Thus "all provider windows"
cannot honestly mean every meter in the raw provider response while also
reusing the current normalized result unchanged.

Questions held for Nil, through PM, before implementation:

1. Approve this route proposal after the identity-binding and deadline details
   receive a concrete implementation plan. Same-engine account verification
   is required to satisfy the no-prior-account-data requirement.
2. Confirm that "all provider windows" means all windows for the agent's
   selected allowance, matching the UI. If it means all Codex meters or Claude
   OAuth/overage, a separate response-shape decision is needed. This proposal
   does not silently expand or truncate that scope.
3. Consider the user's separate suggestion for a public service-health
   endpoint that reveals only live/outage status. No public health endpoint
   is designed here. Office allowance data remains authenticated under the
   self-affordance guard.

## Implementation and documentation surfaces after approval

Runtime: backend result/provenance types and both supported adapters; manager
cache and identity guards; shared response type; route table and affordance
handler. Reuse the current UI allowance view, with its age source corrected
if observation metadata is shown there. No polling timer or persistent quota
file is proposed.

Docs: `server/system-prompt.ts` (own-token recipe and cached-age meaning),
`docs/developer-api.md` (auth and response), `docs/features.md` (self-check),
`api/chat.ts` (feature inventory), `ui/log-view/isomux-curl.ts` `ROUTE_LABELS`
and translated label if needed. Check `internal-docs/documentation.md`; no
headline, marketing site, personal site or resume change is needed.

Tests must cover the case table, exact context-route auth parity, all returned
windows, cached observation age under repeated reads, sparse Codex updates
and late baselines, Claude throttling, authoritative clears, sequence races,
both cache levels on identity change, and server restart. These are planned
tests, not claims of verification in this design-only lane.
