# Context-Fullness Visibility

Design for board tasks 6e9d9d77 ("Agents should be able to see their own context") and a44c58ba ("A visual context usage indicator"). Revised after Reviewer2's design review (2026-07-18).

## Status (2026-07-18): what landed vs follow-up

Nil greenlit a REDUCED scope for the first batch — the server-side core only. **Landed:**

- The per-agent in-memory snapshot with the race-safe commit protocol and the lifecycle matrix (§1 minus the WS broadcast, §4). Sampling at `turn_completed` (both engines) + Codex `usage_update`.
- `GET /api/agents/:id/context` (§2's endpoint) and its system-prompt recipe.
- `contextSampleInFlight` is wired (populated + identity-guard-cleared) but has no consumer yet — its consumer is the pre-send notice step.

**Follow-up tasks, NOT implemented (the sections below describing them are design reference for those tasks):**

- Task 50392514 — the injected 60%/85% auto-notices, including the outbound-envelope generalization (§2's notice mechanics, §2a).
- Task 27096236 — the UI indicator and the `AgentInfo.contextUsage` WS field (§3, and §1's "Broadcast" paragraph). Nil wants a battery-style icon; placement is unsolved (nav bar too crowded). The DeskUnit/desk-encoding idea is permanently dead.

Decisions resolved with the reduced scope: threshold values/notice policy are moot until 50392514; no snapshot persistence across server restarts is ACCEPTED for v1 — after a restart + resume, the snapshot repopulates at the end of the first completed turn of the resumed conversation. (Cheap seed-earlier option, not built: fire one `refreshContextUsage` when a Claude session is installed on wake/resume — the SDK control request can report the resumed transcript without waiting for a turn. Codex has no equivalent until its first `tokenUsage` notification.)

## Scope

**Context fullness** = how full the live context window is right now (prompt size of the last turn vs the model's window). This is a property of the current conversation.

**Non-goal:** token-usage/billing accounting (`accumulateSessionUsage`, `/isomux-usage`, the codex usage_update double-count bug da064080). That is cumulative spend, a different quantity that only grows. This design does not touch the usage-accounting pipeline; it only adds a parallel read path for fullness.

## What already exists

Most of the signal plumbing is already built for the boss-facing `/context` slash command:

- `BackendSession.getContextUsage(): Promise<ContextUsage | null>` (`server/backends/types.ts:233-252`) with `{model, totalTokens, maxTokens, percentage, categories?, memoryFiles?, systemPromptSections?, isAutoCompactEnabled?, autoCompactThreshold?}`.
- **Claude** (`server/backends/claude.ts:411`): control request to the SDK's `Query.getContextUsage()`. On-demand, rich breakdown, includes the auto-compact threshold. Returns null on error/not-ready.
- **Codex** (`server/backends/codex/adapter.ts:725-758`): no on-demand RPC; synthesized from the cached `last.*` breakdown + `modelContextWindow` of the most recent `thread/tokenUsage/updated` notification. Correctly uses `last` (prompt size of the last turn ≈ live context), not `total` (cumulative, would misreport). **Null until the first turn's notification arrives.**

What's missing: nothing pushes this anywhere. There's no server-side snapshot, no WS field, no agent-facing surface, no UI rendering outside the manual `/context` command.

## Design

### 1. Server-side snapshot (shared foundation for both tasks)

Per-agent in-memory state on `ManagedAgent`:

```ts
contextUsage: {
  model: string;            // labels the measured window (a stale pre-swap sample must not get relabeled)
  totalTokens: number;
  maxTokens: number;
  percentage: number;       // raw float from the backend, not rounded
  sampledAtMs: number;
  source: "turn_completed" | "usage_update" | "on_demand";
} | null;
contextGen: number;          // conversation-generation token, see §4
contextSampleSeq: number;             // monotonic sample-initiation counter (init 0, global across generations)
contextUsageCommittedSeq: number;     // seq of the last committed sample (init 0, global across generations)
contextSampleInFlight: Promise<void> | null;  // latest pending refresh, for §2's pre-send await
firedAgentThresholds: Set<number>;   // agent-facing notices fired this generation
firedUiThresholds: Set<number>;      // UI chat-notice fired this generation (separate audience, separate flag)
```

**Sampling points** (initiated from `processNormalizedEvent`, `server/agent-manager.ts`):

- On `turn_completed` (both engines, regardless of turn status — the backend reading reflects whatever landed in the transcript; the ownership guard below covers the pathological cases): start an async `getContextUsage()` refresh and stash its promise in `contextSampleInFlight`. `pendingTurn` still resolves synchronously — turn semantics don't change.
- On `usage_update` (Codex): also refresh — a free cache read. This is a freshness optimization only; notification timing relative to turn boundaries is not guaranteed by the event contract, so nothing may assume these arrive mid-turn (or at all).

**Sample commit protocol** (fixes async ownership + ordering): `processNormalizedEvent` is synchronous, so a fire-and-forget refresh can resolve after `/clear`, `/resume`, edit-fork, or a newer sample. At initiation (before any await, on the event-loop turn) capture:

```ts
const gen = managed.contextGen;
const sess = managed.session;          // object identity
const seq = ++managed.contextSampleSeq;
```

On resolve, commit only if `managed.contextGen === gen && managed.session === sess && seq > managed.contextUsageCommittedSeq`. Otherwise drop the result silently. Every reset bumps `contextGen` synchronously, before any await, so late resolutions from the old conversation can never repopulate the new one, and an older request can never overwrite a newer sample.

`contextSampleInFlight` ownership: with overlapping refreshes, an older promise's `finally` must not clear a newer promise from the slot — standard identity guard (`if (managed.contextSampleInFlight === ownPromise) managed.contextSampleInFlight = null`). A generation reset also synchronously nulls the slot (in addition to bumping `contextGen`), so the first send of a fresh conversation never spends its 500ms budget awaiting an old conversation's request; the orphaned request still self-discards via the gen/session checks.

**Commit side effects** (all in one place, server-authoritative): store snapshot → broadcast if changed → evaluate the **UI threshold only** (§3). The commit path never touches `firedAgentThresholds` — that set is evaluated and mutated exclusively by the pre-send step in `runAgentTurn`, at the moment it actually injects the block (§2). Otherwise a committed 85% sample would consume the agent notice before any outbound send existed to carry it. Threshold evaluation always uses the raw float, never throttled/rounded broadcast values.

Broadcast: extend `AgentInfo` (`shared/types.ts`) with an optional `contextUsage` field (same shape minus `source`) and emit `agent_updated` with `changes: { contextUsage }`. Cadence: every committed `turn_completed` / `on_demand` sample broadcasts (turn-boundary frequency is already low); only the Codex `usage_update` path is throttled, and on displayed values — broadcast when `model` or `maxTokens` changes, or when the integer percentage or displayed rounded token count changes.

### 2. Agent-facing surface (task 6e9d9d77)

**Endpoint:** `GET /api/agents/:id/context`, defined in `server/routes/table.ts` with the existing affordance pattern (`auth: cap("self:affordance", agentParamMustEqualTokenAgent)`, bearer `ISOMUX_AGENT_TOKEN`), handler alongside the other affordances. Behavior: attempt a live `session.getContextUsage()` (subject to the same commit protocol — it also refreshes the stored snapshot with `source: "on_demand"`); fall back to the stored snapshot; else unavailable.

Payload:

```jsonc
// available
{ "available": true, "model": "...", "totalTokens": 132400, "maxTokens": 200000,
  "percentage": 66.2, "sampledAtMs": 1789000000000 }
// not available
{ "available": false, "reason": "no_session" | "not_yet_measured" }
```

**Staleness semantics** (source-neutral, same story for both engines): the reading is the *latest backend sample* and may lag the in-flight turn — an agent calling this mid-turn (which is always, for its own turn) should treat it as "as of roughly the last turn boundary". We do NOT claim "live" anywhere. If implementation-time verification shows Claude's control request includes the active turn's growth, we can add a freshness marker later; the design doesn't depend on it.

**Automatic notices (the motivating example).** "Start wrapping up past 200k" in a system prompt can't work if the agent never looks, and agents won't reliably poll. So the server tells them, via a built-in step in `runAgentTurn` (`server/plugin-hooks.ts`) — core coordination behavior, deliberately NOT a plugin (no enable/disable coupling, not in plugin discovery or failure accounting):

- Runs after the previous turn's `afterTurn` gate, before backend send, with `checkCancelled()` after any await.
- First awaits `contextSampleInFlight` with a short bounded timeout (~500ms, tunable) so the notice reflects the just-finished turn instead of racing the fire-and-forget refresh. On timeout, proceeds with whatever snapshot is committed — a notice delayed by one turn beats delaying every send.
- If the raw percentage has reached a threshold not yet fired this generation, prepends one line to the outgoing envelope (§2a). If the first available sample already clears multiple thresholds (e.g. lands at 87%), only the HIGHEST newly-reached notice is emitted, and all thresholds ≤ it are marked fired.
- Thresholds: 60% (heads-up) and 85% (wrap up), matching the UI colors. Once per threshold per generation — after a compaction drop and re-cross there is no repeat (fired-set only resets with the generation).

```
[context check: 68% full — 136,000 / 200,000 tokens. Budget accordingly.]
[context check: 87% full — 174,000 / 200,000 tokens. Wrap up: finish or hand off current work; tell the boss a /clear is advisable.]
```

Notices ride the next outbound send only — never start a turn on their own, so idle agents cost nothing. Both absolute tokens and percentage are included so prompts keyed to absolute sizes ("200k") work on any window. ~30 tokens of overhead, at most twice per generation.

#### 2a. Outbound envelope generalization (edit-fork compatibility)

Problem: edit-to-fork matching (`agent-manager.ts:5761`, `cronjob-manager.ts:1801`) compares backend-recorded user content after `stripPluginPrefix()` against the unwrapped log `sdkText`. A built-in line prepended outside the plugin envelope would persist in the backend transcript and break edit matching on noticed turns (especially with zero plugins enabled, where nothing gets stripped at all).

Fix: generalize step 5 of `runAgentTurn` into a single outbound-envelope assembly where blocks come from built-ins and plugins and compose deterministically (built-ins first, then plugins in the existing sorted order). Built-in blocks get their own reserved delimiter — NOT a fake plugin id:

```
--- begin isomux: context-check ---
[context check: ...]
--- end isomux: context-check ---

--- begin plugin: foo ---
...
--- end plugin: foo ---

User message:
<sdkText>
```

`stripPluginPrefix` is superseded by `stripOutboundEnvelope`: accepts text opening with either `--- begin isomux: ` or `--- begin plugin: `; the boundary regex matches the full `--- end (isomux|plugin): <id> ---\n\nUser message:\n` closing shape. Old transcripts (plugin-only wraps) keep stripping identically — the plugin delimiter grammar is unchanged, strictly extended. Required tests: edit/fork round-trip for notice-only, plugin-only (regression), and notice+plugin turns.

**System prompt** (`server/system-prompt.ts`, after the affordances section): a short "How to check your context fullness" recipe (curl the GET endpoint, with the staleness caveat) plus one sentence explaining that `[context check: ...]` blocks are server-injected fullness notices to act on. Lives in the system prompt, not office memory, so it reaches every deployment.

### 3. UI indicator (task a44c58ba)

**Data:** the `AgentInfo.contextUsage` field over the existing `agent_updated` flow; `ui/store.tsx` already merges partial changes.

**Where:** LogView header (desktop and mobile), a compact pill next to the model badge showing the percentage as text (always visible — not tooltip-gated, so touch devices get the number for free) with color fill. Hidden while the snapshot is null. DeskUnit nametag stays untouched in v1 (already dense; possible follow-up).

**Colors** (existing theme vars, computed from the raw percentage):

| fullness | color | meaning |
|---|---|---|
| < 60% | `--text-muted` (dim) | fine, informational |
| 60–84% | `--orange` | plan around it |
| ≥ 85% | `--red` | wrap up / clear soon |

**Suggest actions, concretely:**

- Click/tap on the pill opens a small popover (focus-reachable; works on touch where hover doesn't exist): `Context: 132,400 / 200,000 tokens (66%) — as of last turn.` At orange/red it appends: `Consider asking the agent to wrap up, or /clear for a fresh session.` Desktop hover shows the same content as a tooltip.
- On first crossing ≥ 85% **per generation**, one ephemeral system notice in the chat: `Context is 87% full. Consider having the agent wrap up or summarize its state, then /clear.` Emitted server-side from the sample-commit path (`emitEphemeralLog`, same family as the session-swap indicator; not persisted into the transcript) — the server is the single authority, so multiple connected clients or reconnects cannot duplicate it. Tracked by `firedUiThresholds`, deliberately separate from the agent-facing fired-set: different audiences, and one firing must not suppress the other.
- No buttons in v1. A "Clear conversation" action in the popover is a natural v2 if the text nudge proves insufficient.

### 4. Lifecycle: conversation generation, not subprocess replacement

`replaceSession` is the wrong reset hook — it also serves same-conversation process changes (abort slow-path recovery, queue-watchdog recovery, privilege-token remint, model/effort restarts via auto-resume). The reset is tied to **conversation identity**: `contextGen` is bumped (and snapshot + both fired-sets cleared, `contextUsage: null` broadcast, all synchronously) at the *semantic* call sites where the transcript resets or switches. Rule: **preserve iff the same conversation transcript continues; reset iff it doesn't.**

| event | snapshot + fired thresholds |
|---|---|
| `/clear` / new conversation | reset |
| engine switch | reset |
| explicit `/resume`, same session id | preserve |
| explicit `/resume`, different session id | reset |
| cwd edit — Claude (session moves with cwd) | preserve |
| cwd edit — Codex (old thread abandoned) | reset |
| idle demote (dormant) / wake | preserve (fullness is a transcript property) |
| hot abort (in-place interrupt, no replacement) | preserve |
| abort slow-path replacement resuming same conversation | preserve |
| abort recovery falling back to a fresh blank session | reset |
| queue-watchdog recovery, same conversation resumed | preserve |
| queue-watchdog recovery, fresh fallback | reset |
| privilege token remint | preserve |
| model change (auto-resume, same conversation) | invalidate measurement only¹ |
| effort/permission/sandbox restart (auto-resume, same conversation) | preserve |
| edit-fork, success | reset |
| edit-fork, rollback | restore pre-fork snapshot + fired-sets (stashed before the fork attempt), not null |
| session stream death + auto-wake, same conversation | preserve |
| kill / revive | preserve iff revive resumes the same conversation, else reset |
| Claude auto-compact | no reset; next sample shows the drop; thresholds do not refire |
| server restart | in-memory state lost (v1): indicator empty, thresholds start clean, until the next turn |

¹ **Measurement invalidation, not a transcript reset:** a model change alters `maxTokens`, so a snapshot measured against the old window is not actionable for the UI or for automatic notices even with an honest `model` label. On model change: set `contextUsage = null`, null `contextSampleInFlight`, and discard any in-flight sample — but preserve `contextGen` and both fired-sets (the conversation continues; already-fired notices stay fired). The next completed turn repopulates the measurement.

**Unavailable signal:** Codex before its first turn, `modelContextWindow` null, session down — pill hidden, endpoint `available: false`, notices simply don't fire. Everything degrades to today's behavior.

## Doc surfaces (post-go, per internal-docs/documentation.md)

- `server/system-prompt.ts` — endpoint recipe + notice explanation (core part of the feature).
- `docs/features.md` — canonical inventory: indicator + agent self-check, a few lines.
- `api/chat.ts` SYSTEM_PROMPT feature list — one line.
- README/landing highlights: not headline-level; skip.
- `/help` (`server/command-handlers.ts`): mention the indicator alongside `/context` in tips if apt; no new command.

## Decisions needing Nil's sign-off (resolved — see Status)

1. Threshold values / notice cadence — deferred with task 50392514.
2. Auto-injected notices always-on vs opt-out — deferred with task 50392514.
3. UI placement — reworked under task 27096236 (battery-style icon, placement TBD; desk nametag permanently dead).
4. Snapshot not persisted across server restarts in v1 — ACCEPTED.

## Review log

- 2026-07-18 Reviewer2, first pass: approved product shape; requested design revision (async sample ownership/ordering, notice-vs-turn-boundary race, edit-fork envelope compatibility, source-neutral staleness, generation-based lifecycle, snapshot schema, threshold pinning, server-authoritative UI notice + touch accessibility). All incorporated.
- 2026-07-18 Reviewer2, second pass: **APPROVED** for design handoff and Nil's implementation gate, after spec clarifications (committed-seq field declared; in-flight-slot identity guard + reset nulling; threshold mutation authority split — commit path fires UI threshold only, `runAgentTurn` owns the agent-facing set; WS broadcast per turn-boundary sample with display-value throttling on the Codex usage_update path only; model change = measurement invalidation preserving generation and fired-sets). All incorporated.
- 2026-07-18 Reviewer2, implementation review (reduced server-core batch): REQUEST CHANGES on one P1 — failed edit-fork rollback restored the parent snapshot even when the parent session wasn't reinstalled. Fixed (gate the restore on `rollbackRestored`; keep null otherwise) + added a direct regression test. P3 copy corrected (features.md + api/chat.ts now say "latest backend sample, may lag the in-flight turn"). P3 lifecycle tests added for same-id-resume-preserve (+ old-session sample discarded by object identity) and different-id-resume-reset; the codex-cwd-abandon reset shares the identical `resetContextUsage` call covered via `/clear`.
