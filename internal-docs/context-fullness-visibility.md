# Context-Fullness Visibility

Design for board tasks 6e9d9d77 ("Agents should be able to see their own context") and a44c58ba ("A visual context usage indicator"). Revised after Reviewer2's design review (2026-07-18).

## Status (2026-07-18): what landed vs follow-up

Nil greenlit a REDUCED scope for the first batch - the server-side core only. **Landed:**

- The per-agent in-memory snapshot with the race-safe commit protocol and the lifecycle matrix (§1 minus the WS broadcast, §4). Sampling at `turn_completed` (all backends) + Codex `usage_update`.
- `GET /api/agents/:id/context` (§2's endpoint) and its system-prompt recipe.
- **Task 50392514 (2026-07-18 batch 2)** - the injected 50%/75% auto-notices (§2's notice mechanics) + the outbound-envelope generalization (§2a). `contextSampleInFlight` now has its consumer: the pre-send notice step in `runAgentTurn` awaits it with a ~500ms bound. Added `ManagedAgent.firedAgentThresholds` (reset with the generation, restored on edit-fork rollback, preserved on model change). `stripPluginPrefix` → `stripOutboundEnvelope` (accepts `isomux:` and `plugin:` blocks; plugin-only transcripts strip identically). Notice text uses a plain hyphen, not an em dash (Nil's prose rule). The fired-set is mutated ONLY by the send path at send-accept time (after `session.send` resolves, so a failed/swapped send never burns a notice) - the commit path never touches it. The UI `firedUiThresholds` set is deliberately NOT added yet (belongs to task 27096236).

- **Task 27096236 (SHIPPED 2026-07-18)** - the battery indicator + the `AgentInfo.contextUsage` WS field (§3, and §1's "Broadcast" paragraph). Shipped as an inline-SVG battery in the LogView header right cluster, **always showing the percentage** (Nil's pick over the quiet-below-threshold variant). Metaphor **revised per Nil to a phone battery = UNUSED context**: it shows the *remaining* %, drains as context fills, with color still driven by fullness (near-full context = low battery = red). The % is stacked under the SVG and shows on mobile too; to make header room, the model+engine badge moved onto its own line under the agent name and the `R{n}:{desk}` tag was removed. The popover copy dropped the "as of last turn" phrasing. NOTE: §3 and the placement proposal below predate these revisions (they describe the old fullness metaphor, the quiet-below-threshold default, and the "as of last turn" copy) - kept as design history, not current behavior.

- **Task 0b12423b (SHIPPED 2026-07-18)** - the server-authoritative boss-facing ephemeral chat notice (`firedUiThresholds`, §3's deferred piece). **Revised per Nil's task description: fires at BOTH bands** (first crossing of 50%, then 75% - the original §3 text said ≥75% only), matching the agent-notice thresholds. One ephemeral system line per band per generation, emitted from the sample-commit path (`maybeEmitUiContextNotice` in `commitContextSample`, via `emitEphemeralLog` - same family as the session-swap indicator; the single server authority means reconnects/multiple clients cannot duplicate it; not persisted, gone on server restart like the snapshot itself). Copy (same at every band, Nil's wording): `Context is NN% full. Consider starting to wrap up. You can use /clear (for a new session) or /handoff (to continue this one with fresh context).` If the first committed sample already clears both bands, only the highest emits a line and both are consumed. `firedUiThresholds` is deliberately SEPARATE from `firedAgentThresholds` (one audience firing never suppresses the other) but shares its lifecycle: reset with the generation (`resetContextUsage`), restored on edit-fork rollback (gated on `rollbackRestored`, like the sibling set), preserved on model change. Both audiences share the `CONTEXT_NOTICE_THRESHOLDS` constant (now exported from `plugin-hooks.ts`). Also fixed in this batch: the system-prompt recipe still said ~60%/~85% (missed by the 34f4d47 threshold change); now ~50%/~75%.

- **Task 73a23f7c (2026-08-16)** - the 50 band is now size-gated. `CONTEXT_NOTICE_THRESHOLDS` became `CONTEXT_NOTICE_BANDS` (`{pct, minWindowTokens}`): the 50 band carries `minWindowTokens: 500_000`, the 75 band 0. A band whose `minWindowTokens` exceeds the snapshot's reported `maxTokens` is skipped by both audiences (agent-facing `pickContextThreshold`, boss-facing `maybeEmitUiContextNotice`). Rationale (Nil): on Codex's ~250k window the 50% notice fires within a few turns of normal work and is noise; the 75 wrap-up band stays useful at any size. Keyed on the reported window size, NOT the backend, so it self-adjusts if window sizes change (a small-window Claude model, e.g. Sonnet's 200k, skips the 50 band too; a future 1M Codex window gets it back). The UI battery color bands are unchanged (color at 50-74% is display-only, not a notice).

With this, everything in this design is implemented.

Decisions resolved with the reduced scope: threshold values/notice policy are moot until 50392514; no snapshot persistence across server restarts is ACCEPTED for v1 - after a restart + resume, the snapshot repopulates at the end of the first completed turn of the resumed conversation. (Cheap seed-earlier option, not built: fire one `refreshContextUsage` when a Claude session is installed on wake/resume - the SDK control request can report the resumed transcript without waiting for a turn. Codex has no equivalent until its first `tokenUsage` notification.)

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

- On `turn_completed` (all backends, regardless of turn status - the backend reading reflects whatever landed in the transcript; the ownership guard below covers the pathological cases): start an async `getContextUsage()` refresh and stash its promise in `contextSampleInFlight`. `pendingTurn` still resolves synchronously - turn semantics don't change.
- On `usage_update` (Codex): also refresh - a free cache read. This is a freshness optimization only; notification timing relative to turn boundaries is not guaranteed by the event contract, so nothing may assume these arrive mid-turn (or at all).

**Sample commit protocol** (fixes async ownership + ordering): `processNormalizedEvent` is synchronous, so a fire-and-forget refresh can resolve after `/clear`, `/resume`, edit-fork, or a newer sample. At initiation (before any await, on the event-loop turn) capture:

```ts
const gen = managed.contextGen;
const sess = managed.session;          // object identity
const seq = ++managed.contextSampleSeq;
```

On resolve, commit only if `managed.contextGen === gen && managed.session === sess && seq > managed.contextUsageCommittedSeq`. Otherwise drop the result silently. Every reset bumps `contextGen` synchronously, before any await, so late resolutions from the old conversation can never repopulate the new one, and an older request can never overwrite a newer sample.

`contextSampleInFlight` ownership: with overlapping refreshes, an older promise's `finally` must not clear a newer promise from the slot - standard identity guard (`if (managed.contextSampleInFlight === ownPromise) managed.contextSampleInFlight = null`). A generation reset also synchronously nulls the slot (in addition to bumping `contextGen`), so the first send of a fresh conversation never spends its 500ms budget awaiting an old conversation's request; the orphaned request still self-discards via the gen/session checks.

**Commit side effects** (all in one place, server-authoritative): store snapshot → broadcast if changed → evaluate the **UI threshold only** (§3). The commit path never touches `firedAgentThresholds` - that set is evaluated and mutated exclusively by the pre-send step in `runAgentTurn`, at the moment it actually injects the block (§2). Otherwise a committed 75% sample would consume the agent notice before any outbound send existed to carry it. Threshold evaluation always uses the raw float, never throttled/rounded broadcast values.

Broadcast: extend `AgentInfo` (`shared/types.ts`) with an optional `contextUsage` field (same shape minus `source`) and emit `agent_updated` with `changes: { contextUsage }`. Cadence: every committed `turn_completed` / `on_demand` sample broadcasts (turn-boundary frequency is already low); only the Codex `usage_update` path is throttled, and on displayed values - broadcast when `model` or `maxTokens` changes, or when the integer percentage or displayed rounded token count changes.

### 2. Agent-facing surface (task 6e9d9d77)

**Endpoint:** `GET /api/agents/:id/context`, defined in `server/routes/table.ts` with the existing affordance pattern (`auth: cap("self:affordance", agentParamMustEqualTokenAgent)`, bearer `ISOMUX_AGENT_TOKEN`), handler alongside the other affordances. Behavior: attempt a live `session.getContextUsage()` (subject to the same commit protocol - it also refreshes the stored snapshot with `source: "on_demand"`); fall back to the stored snapshot; else unavailable.

Payload:

```jsonc
// available
{ "available": true, "model": "...", "totalTokens": 132400, "maxTokens": 200000,
  "percentage": 66.2, "sampledAtMs": 1789000000000 }
// not available
{ "available": false, "reason": "no_session" | "not_yet_measured" }
```

**Staleness semantics** (source-neutral, same story for every backend): the reading is the *latest backend sample* and may lag the in-flight turn - an agent calling this mid-turn (which is always, for its own turn) should treat it as "as of roughly the last turn boundary". We do NOT claim "live" anywhere. If implementation-time verification shows Claude's control request includes the active turn's growth, we can add a freshness marker later; the design doesn't depend on it.

**Automatic notices (the motivating example).** "Start wrapping up past 200k" in a system prompt can't work if the agent never looks, and agents won't reliably poll. So the server tells them, via a built-in step in `runAgentTurn` (`server/plugin-hooks.ts`) - core coordination behavior, deliberately NOT a plugin (no enable/disable coupling, not in plugin discovery or failure accounting):

- Runs after the previous turn's `afterTurn` gate, before backend send, with `checkCancelled()` after any await.
- First awaits `contextSampleInFlight` with a short bounded timeout (~500ms, tunable) so the notice reflects the just-finished turn instead of racing the fire-and-forget refresh. On timeout, proceeds with whatever snapshot is committed - a notice delayed by one turn beats delaying every send.
- If the raw percentage has reached a threshold not yet fired this generation, prepends one line to the outgoing envelope (§2a). If the first available sample already clears multiple thresholds (e.g. lands at 87%), only the HIGHEST newly-reached notice is emitted, and all thresholds ≤ it are marked fired.
- Thresholds: 50% (heads-up) and 75% (wrap up), matching the UI colors. Once per threshold per generation - after a compaction drop and re-cross there is no repeat (fired-set only resets with the generation).

```
[context check: 68% full - 136,000 / 200,000 tokens. Budget accordingly.]
[context check: 87% full - 174,000 / 200,000 tokens. Wrap up: finish or hand off current work; tell the boss a /clear is advisable.]
```

Notices ride the next outbound send only - never start a turn on their own, so idle agents cost nothing. Both absolute tokens and percentage are included so prompts keyed to absolute sizes ("200k") work on any window. ~30 tokens of overhead, at most twice per generation.

#### 2a. Outbound envelope generalization (edit-fork compatibility)

Problem: edit-to-fork matching (`agent-manager.ts:5761`, `cronjob-manager.ts:1801`) compares backend-recorded user content after `stripPluginPrefix()` against the unwrapped log `sdkText`. A built-in line prepended outside the plugin envelope would persist in the backend transcript and break edit matching on noticed turns (especially with zero plugins enabled, where nothing gets stripped at all).

Fix: generalize step 5 of `runAgentTurn` into a single outbound-envelope assembly where blocks come from built-ins and plugins and compose deterministically (built-ins first, then plugins in the existing sorted order). Built-in blocks get their own reserved delimiter - NOT a fake plugin id:

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

`stripPluginPrefix` is superseded by `stripOutboundEnvelope`: accepts text opening with either `--- begin isomux: ` or `--- begin plugin: `; the boundary regex matches the full `--- end (isomux|plugin): <id> ---\n\nUser message:\n` closing shape. Old transcripts (plugin-only wraps) keep stripping identically - the plugin delimiter grammar is unchanged, strictly extended. Required tests: edit/fork round-trip for notice-only, plugin-only (regression), and notice+plugin turns.

**System prompt** (`server/system-prompt.ts`, after the affordances section): a short "How to check your context fullness" recipe (curl the GET endpoint, with the staleness caveat) plus one sentence explaining that `[context check: ...]` blocks are server-injected fullness notices to act on. Lives in the system prompt, not office memory, so it reaches every deployment.

### 3. UI indicator (task a44c58ba)

**Data:** the `AgentInfo.contextUsage` field over the existing `agent_updated` flow; `ui/store.tsx` already merges partial changes.

**Where:** LogView header (desktop and mobile), a compact pill next to the model badge showing the percentage as text (always visible - not tooltip-gated, so touch devices get the number for free) with color fill. Hidden while the snapshot is null. DeskUnit nametag stays untouched in v1 (already dense; possible follow-up).

**Colors** (existing theme vars, computed from the raw percentage):

| fullness | color | meaning |
|---|---|---|
| < 50% | `--text-muted` (dim) | fine, informational |
| 50–74% | `--orange` | plan around it |
| ≥ 75% | `--red` | wrap up / clear soon |

**Suggest actions, concretely:**

- Click/tap on the pill opens a small popover (focus-reachable; works on touch where hover doesn't exist): `Context: 132,400 / 200,000 tokens (66%) - as of last turn.` At orange/red it appends: `Consider asking the agent to wrap up, or /clear for a fresh session.` Desktop hover shows the same content as a tooltip.
- (SHIPPED revised, task 0b12423b - fires at BOTH bands, 50% then 75%; see Status.) On first crossing ≥ 75% **per generation**, one ephemeral system notice in the chat (final copy: same wording at every band, see Status). Emitted server-side from the sample-commit path (`emitEphemeralLog`, same family as the session-swap indicator; not persisted into the transcript) - the server is the single authority, so multiple connected clients or reconnects cannot duplicate it. Tracked by `firedUiThresholds`, deliberately separate from the agent-facing fired-set: different audiences, and one firing must not suppress the other.
- No buttons in v1. A "Clear conversation" action in the popover is a natural v2 if the text nudge proves insufficient.

### 4. Lifecycle: conversation generation, not subprocess replacement

`replaceSession` is the wrong reset hook - it also serves same-conversation process changes (abort slow-path recovery, queue-watchdog recovery, privilege-token remint, model/effort restarts via auto-resume). The reset is tied to **conversation identity**: `contextGen` is bumped (and snapshot + both fired-sets cleared, `contextUsage: null` broadcast, all synchronously) at the *semantic* call sites where the transcript resets or switches. Rule: **preserve iff the same conversation transcript continues; reset iff it doesn't.**

| event | snapshot + fired thresholds |
|---|---|
| `/clear` / new conversation | reset - on BOTH implementations: `newConversation` (API route / menu action / engine switch) AND the typed `/clear`//`/reset`//`/new` slash-command handler in `command-handlers.ts`, a separate replaceSession-based path that originally missed the reset (fixed 2026-07-18) |
| engine switch | reset |
| explicit `/resume`, same session id | preserve |
| explicit `/resume`, different session id | reset |
| cwd edit - Claude (session moves with cwd) | preserve |
| cwd edit - Codex (old thread abandoned) | reset |
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

¹ **Measurement invalidation, not a transcript reset:** a model change alters `maxTokens`, so a snapshot measured against the old window is not actionable for the UI or for automatic notices even with an honest `model` label. On model change: set `contextUsage = null`, null `contextSampleInFlight`, and discard any in-flight sample - but preserve `contextGen` and both fired-sets (the conversation continues; already-fired notices stay fired). The next completed turn repopulates the measurement.

**Unavailable signal:** Codex before its first turn, `modelContextWindow` null, session down - pill shows its unknown state (always-visible shell + "?" in a ghost color; changed from pill-hidden per Nil 2026-07-18), endpoint `available: false`, notices simply don't fire.

## Doc surfaces (post-go, per internal-docs/documentation.md)

- `server/system-prompt.ts` - endpoint recipe + notice explanation (core part of the feature).
- `docs/features.md` - canonical inventory: indicator + agent self-check, a few lines.
- `api/chat.ts` SYSTEM_PROMPT feature list - one line.
- README/landing highlights: not headline-level; skip.
- `/help` (`server/command-handlers.ts`): mention the indicator alongside `/context` in tips if apt; no new command.

## Decisions needing Nil's sign-off (resolved - see Status)

1. Threshold values / notice cadence - deferred with task 50392514.
2. Auto-injected notices always-on vs opt-out - deferred with task 50392514.
3. UI placement - reworked under task 27096236 (battery-style icon, placement TBD; desk nametag permanently dead).
4. Snapshot not persisted across server restarts in v1 - ACCEPTED.

## Battery indicator - placement proposal (task 27096236) - SHIPPED (revised; see Status)

NOTE: SHIPPED (revised) - see the Status section for what actually landed (phone-battery = remaining %, always-show %, LogView header right cluster). The proposal below is kept as design history and predates those revisions. It resolved the one open question that blocked the build: **where does the indicator live?** Nil's direction: a phone-battery icon that shows the percentage (token counts on hover at most) and shifts color as it fills. Ruled out already: the desk sprite / DeskUnit nametag encoding (permanently dead).

### Fixed decisions (independent of placement)

- **Render the battery as inline SVG, never a Unicode glyph.** iOS Safari emoji-renders certain Unicode symbols (🔋 and the battery/▶/★ family) and overrides CSS color - which would defeat the whole "color shifts as it fills" point. A hand-drawn SVG (rounded-rect shell + a proportional fill rect + a small terminal nub) is ~15 lines and fully color-controllable. (Same class of gotcha recorded in Nil's memory about iOS auto-emoji rendering.)
- **Color bands = the notice thresholds**, computed from the raw float percentage so the icon and the injected notices agree: `< 50%` → `--text-muted` (dim, informational), `50–74%` → `--orange`, `≥ 75%` → `--red`. Vars live in `ui/themes.ts`.
- **Label + hover.** Percentage shown as text next to the fill (rounded integer). Hover/tap tooltip: `132,400 / 200,000 tokens (66%) - as of last turn.` Touch has no hover, so the tooltip must also open on tap (a tiny popover), not hover-only.
- **Hidden while unavailable** (snapshot null / `available:false`): no icon at all, not an empty shell.

### Candidate placements

**A. LogView header, right cluster (inline with the model label).** `ui/log-view/LogView.tsx` desktop header ~L1876–1930 (right before the model-family label at L1906 / the Codex backend badge), mobile header ~L1640–1700.
- *Pros:* This is where `/context` conceptually lives and where a human already scans for run metadata (model, cwd, state). At-a-glance without opening a popover. Reuses the existing metadata strip - no new surface.
- *Cons:* This strip is the single most contested space in the app; a container query already hides action labels below 1199px. A battery + `%` is ~34px, narrower than a text pill but still additive. Needs a narrow-width rule (icon-only, drop the `%`) and, on mobile's 2-row header, likely belongs on the cwd row, not the name row.

**B. Message composer, top-right of the input box.** The send/compose area at the bottom of LogView.
- *Pros:* Roomy - the composer row has slack the header doesn't. It sits exactly where the "is there room for another message?" decision is made, so the signal is adjacent to the action it informs. Naturally full-width on mobile, so no 2-row squeeze.
- *Cons:* Invisible while the human is scrolled up reading history. Divorced from the other run metadata (model/cwd/state all live in the header), so two places to look. Composer already carries attachment chips + queued-message chips; not empty either.

**C. Header, "quiet until it matters" (a rendering variant of A).** Same slot as A, but below 50% the battery renders ghosted and icon-only (no `%` number); it only surfaces the number + color band once it crosses into orange.
- *Pros:* Removes the crowding objection almost entirely - for the majority of a conversation's life the footprint is a single dim ~12px glyph, and it grows into a labeled chip precisely when it's worth reading.
- *Cons:* Partially conflicts with Nil's "show %" - a human who wants the number at 40% won't see it without hovering. It's a real taste tradeoff, not a dominated option, which is why it's listed separately.

### Recommendation

Home it in the **LogView header right cluster (A)**, rendered with **C's quiet-until-it-matters behavior as the default** - dim icon-only under 50%, expanding to icon + `%` + color in the orange/red bands. That keeps the contested header strip calm at rest, honors "color shifts as it fills," and puts the number front-and-center exactly when it's actionable (which is also when the injected notices fire, so the two agree). Mobile: place it on the cwd row, icon-only, tap for the token popover.

The one genuine call left for Nil is the A-vs-C tension: **always show the `%` (pure A), or keep it quiet below 50% (A+C).** Everything else above is settled. If Nil prefers the number always visible, drop the C behavior and add the narrow-width icon-only rule instead. Composer (B) is the fallback only if the header truly can't absorb even the quiet form.

### Data path / WS push field needed (to be built with the UI, NOT in this batch)

The snapshot already exists server-side (task 50392514 batch). What's missing for the UI:

- **`AgentInfo.contextUsage?`** (`shared/types.ts`, the `AgentInfo` interface ~L293) - optional, snapshot shape **minus `source`**: `{ model: string; totalTokens: number; maxTokens: number; percentage: number; sampledAtMs: number }`. Absent/null ⇒ pill shows the unknown state ("?"), not hidden (changed 2026-07-18).
- **Broadcast from the sample-commit path** (`commitContextSample` in `server/agent-manager.ts`): emit `agent_updated` with `changes: { contextUsage }` whenever a committed sample changes displayed values. Per §1: broadcast every committed `turn_completed` / `on_demand` sample (turn-boundary cadence is already low); throttle ONLY the Codex `usage_update` path, and on *displayed* values (integer percentage / rounded token count / model / maxTokens change). Reset paths already null the snapshot; they broadcast an **explicit `contextUsage: null`** so the pill clears - never `undefined`, which `JSON.stringify` drops from the WS event, leaving the client's spread-merge holding the previous conversation's stale reading (bug fixed 2026-07-18).
- **Store:** none. `ui/store.tsx`'s `agent_updated` reducer (~L344) already merges partial `changes` via `{ ...a, ...action.changes }`, so a new field surfaces to components automatically.
- **Optional server-authoritative UI notice** (§3): SHIPPED separately as task 0b12423b (both bands, not just ≥75% - see Status). Tracked by the separate `firedUiThresholds` set, different audience from the agent-facing set.

## Review log

- 2026-07-18 Reviewer2, first pass: approved product shape; requested design revision (async sample ownership/ordering, notice-vs-turn-boundary race, edit-fork envelope compatibility, source-neutral staleness, generation-based lifecycle, snapshot schema, threshold pinning, server-authoritative UI notice + touch accessibility). All incorporated.
- 2026-07-18 Reviewer2, second pass: **APPROVED** for design handoff and Nil's implementation gate, after spec clarifications (committed-seq field declared; in-flight-slot identity guard + reset nulling; threshold mutation authority split - commit path fires UI threshold only, `runAgentTurn` owns the agent-facing set; WS broadcast per turn-boundary sample with display-value throttling on the Codex usage_update path only; model change = measurement invalidation preserving generation and fired-sets). All incorporated.
- 2026-07-18 Reviewer2, implementation review (reduced server-core batch): REQUEST CHANGES on one P1 - failed edit-fork rollback restored the parent snapshot even when the parent session wasn't reinstalled. Fixed (gate the restore on `rollbackRestored`; keep null otherwise) + added a direct regression test. P3 copy corrected (features.md + api/chat.ts now say "latest backend sample, may lag the in-flight turn"). P3 lifecycle tests added for same-id-resume-preserve (+ old-session sample discarded by object identity) and different-id-resume-reset; the codex-cwd-abandon reset shares the identical `resetContextUsage` call covered via `/clear`.
