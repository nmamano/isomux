# isomux-memory: design

> Status: spec, Reviewer3 signed off. Awaiting Nil's final read.
> Working name: `isomux-memory`. Replaces `isomux-mem0` (which gets deprecated).

## 1. Motivation

Isomux agents need **durable cross-agent memory with category-aware reconciliation**: facts the boss tells one agent should surface to other agents at the right scope, and the system needs to dedup / update / retract them sensibly across that scope.

The previous plugin (`isomux-mem0`) wraps mem0/oss as the memory engine. After two rounds of design work with the reviewer, we converged on the position that **extraction, categorization, and reconciliation are one cognitive step** for this product: the decision that emits memory mutations needs both the category taxonomy and the relevant existing memories across candidate categories at the moment of decision. Mem0's `Memory.add()` runs extraction internally with a locked output schema and a single-filter dedup, so every wrapper design pays for splitting one step into two (pre-classify, post-classify, or N-parallel-add). The workarounds accumulate; they don't compose; the 5-agents-same-fact case is a concrete failure of any wrapper.

This document specifies a from-scratch plugin that owns the unified step.

## 2. Goals and non-goals

### Goals (v1)

- Four memory categories as first-class: `agent`, `boss`, `room`, `office`.
- Single LLM call per turn for extract + categorize + reconcile.
- Native ADD / UPDATE / NONE per fact, scoped to the fact's category.
- `beforeTurn` retrieval as structured four-section prefix mirroring the prompt hierarchy.
- Telemetry off. History off. Apache-2.0 attribution to mem0 for adapted prompt material.

### Non-goals (v1)

- Alternate vector stores. Qdrant only.
- Hybrid search (BM25, entity boosts, score fusion). Pure vector search.
- DELETE events. ADD / UPDATE / NONE only; explicit retraction deferred to v2.
- Migration of records from `isomux_mem0`. Fresh collection.
- Manual operator markers (e.g. `[remember:office]`). Categorizer is the only decision surface.
- Cloud mode. OSS only.
- BYO embedder/LLM provider beyond the configured defaults (OpenAI embedder, Anthropic Claude extractor). Ollama path is a stretch goal.
- Per-fact provenance UI / inspector. Provenance is stored but not surfaced.

## 3. Privacy model — read first

**Cross-boss isolation is no longer enforced by the storage layer.** Three of the four categories are cross-boss visible by design:

- `agent` — facts about / by an agent, visible to anyone talking to that agent.
- `room` — facts about a room/project, visible to anyone in that room.
- `office` — facts about the whole office, visible to everyone.

Only `boss` category is scoped to a single boss (`user_id` only, no agent or room id).

The privacy boundary therefore lives in the **categorizer** — the LLM call that decides where each extracted fact goes. The extraction prompt must encode the routing rules explicitly:

> Anything personal, private, sensitive, or specific to the speaking boss → `boss` category. Anything about the agent's work that any collaborator should know → `agent` category. Anything about a room/project/team → `room` category. Anything **non-sensitive and safe across all bosses, agents, and rooms** in this office → `office` category. **Default to `boss` (most private) when uncertain and the speaking boss is attributed.** When the speaking boss is unattributed (`ctx.userId` is null, e.g. agent-to-agent messages) **and the categorizer is uncertain, emit `NONE` rather than escalate to room/office/agent** — agent-to-agent traffic should not produce silent cross-scope writes.

This is load-bearing. The eval set (§9) must include adversarial cases where the categorizer is tested on private content to verify it routes correctly.

**Note on enforcement layering:** the categorizer chooses the visibility category, but the **plugin assigns identity deterministically** from `ctx` based on that category (see §6 step 6a). The LLM never picks `agent_id`, `user_id`, or `room_id` values — it only chooses a category label, and identity falls out from `ctx` per the category invariants in §4.2. Invariant validation runs after deterministic assignment, not on the raw LLM output.

## 4. Schema

### 4.1 Record shape

Each record in Qdrant carries:

```
{
  // Identity (per category invariant — see 4.2)
  category:    "agent" | "boss" | "room" | "office"
  agent_id?:   string   // set iff category=agent
  user_id?:    string   // set iff category=boss
  room_id?:    string   // set iff category=room
                         // — none set for category=office

  // Memory content
  text:        string   // the extracted fact, self-contained
  text_hash:   string   // md5 of normalized text, for exact-dupe short-circuit

  // Provenance — captured at the originating turn; preserved across UPDATE/NONE
  source_agent_id:   string         // the agent whose turn produced this fact
  source_user_id:    string | null  // the boss who spoke (null if unattributed)
  source_room_id:    string         // the room of the source turn
  source_session_id: string | null  // SDK session id (null on first turn before system_init)
  created_at:        string         // ISO8601 — never mutated after first write
  updated_at:        string         // ISO8601 — bumped on UPDATE only (text changed)
  last_confirmed_at: string         // ISO8601 — bumped on UPDATE and NONE (still relevant)
}
```

**Provenance update behavior on UPDATE/NONE:** the `source_*` fields and `created_at` are **preserved from the original write**. They identify where the fact came from, not where it was last seen. Only `updated_at` (UPDATE) and `last_confirmed_at` (UPDATE and NONE) are bumped. If we later want "where was this fact last restated," that's a v2 addition (e.g. `last_source_session_id`) — out of scope for v1.

**v1 source-id scope:** the isomux plugin context (`PluginTurnContext` in the v0 plugin contract) exposes `sessionId` but does **not** expose a stable turn id or message id. So v1 stores only `source_session_id`. A turn id / message id would land naturally if the plugin contract adds them; for now, the session is the finest granularity available.

Provenance fields are stored but never used for retrieval filtering in v1 — they're for inspection, future telemetry, and potential v2 features (graduation policy, contradiction resolution, restatement-count-based promotion).

### 4.2 Category invariants (enforced at write)

| Category | Required identity | Forbidden identity |
|---|---|---|
| `agent`  | `agent_id` | `user_id`, `room_id` |
| `boss`   | `user_id`  | `agent_id`, `room_id` |
| `room`   | `room_id`  | `agent_id`, `user_id` |
| `office` | — (none)   | `agent_id`, `user_id`, `room_id` |

Validation runs at write. A record violating its category's invariant is rejected at the plugin boundary — never written.

Reviewer3 question on whether agent memories survive room moves: **yes, by construction**. Agent-tier records have no `room_id`. An agent's working state follows the agent across any room move.

### 4.3 Category naming note

Internally, the four category strings are `agent`, `boss`, `room`, `office`. Externally (in the extraction prompt and the `beforeTurn` prefix shown to the model), category names are deliberately verbose and unambiguous: "this agent's working memory," "this boss's preferences," "this room's context," "office-wide knowledge."

The label `office` is documented (in this doc, in the README, in the prompt) as **office-wide across all bosses, agents, and rooms**. Reviewer3 had flagged this naming as ambiguous; we keep `office` as the internal identifier but pair it everywhere with the explicit "across all bosses" gloss.

## 5. Extraction prompt — specification

We adapt mem0/oss's `ADDITIVE_EXTRACTION_PROMPT` (Apache-2.0, source attributed in the file header and a `NOTICE` file at the repo root). The adaptation:

1. **Replaces the output schema** with `{text, category, event, linked_memory_id}` per fact. The LLM emits category only; identity (`agent_id` / `user_id` / `room_id`) is assigned by the plugin from `ctx` per §6 step 6a — never by the model.
2. **Adds explicit category definitions and routing rules** (the privacy paragraph in §3 is the core).
3. **Pre-loads existing memories from all four categories** as context (the prompt sees what's already stored in each scope when reconciling).

### 5.1 Inputs the prompt receives

- The current turn's user message and assistant message.
- Existing memories pulled from all four scopes relevant to this turn (fanout described in §6.2).
- Identity context: the agent's name and id; the boss's username (if attributed); the room's name and id; the office's owner if applicable.
- Observation date and current date (for resolving relative time references).

### 5.2 Output schema

```json
{
  "memory": [
    {
      "text": "...",                       // fact text, self-contained
      "category": "agent|boss|room|office",
      "event": "ADD" | "UPDATE" | "NONE",
      "linked_memory_id": "uuid | null"    // see rules below
    }
  ]
}
```

`linked_memory_id` rules per event:

- `event=ADD` → MUST be `null` or omitted. The LLM is creating a new fact, no link exists.
- `event=UPDATE` → MUST be the id of an existing record (UUID from the prompt's existing-memory pool). The link names the record to mutate.
- `event=NONE` → MUST be the id of an existing record. `NONE` means "this exchange restates an existing fact; bump its `last_confirmed_at` only" — without a link, `NONE` is meaningless.

The LLM does **NOT** emit `agent_id`, `user_id`, or `room_id`. The plugin assigns identity deterministically post-extraction based on the chosen category (§6 step 6a).

**Validation layering:**

- **Envelope-level (top-level JSON malformed, schema parse fails, missing `memory` array):** entire turn's write dropped, no partial application. Structured log to `~/.isomux/logs/plugins.jsonl`.
- **Item-level (envelope valid but one item violates category/event/link rules):** that item dropped, other valid items in the same turn proceed. One structured log entry per dropped item.

This distinction (envelope vs item) matters: a single bad item should not destroy a turn's worth of good extractions, but a fundamentally broken response should not be partially trusted.

### 5.3 What's removed from mem0's prompt

- DELETE event (not supported in v1).
- Entity linking and `attributed_to` field (out of scope).
- The "Last k Messages" cross-turn context (we run with one turn's exchange, same as mem0/oss under `disableHistory: true`).
- The "Recently Extracted Memories" deduplication aid (we don't have a session-scoped recent-extractions table).

### 5.4 What's added

- Category taxonomy with explicit routing rules and privacy framing.
- Identity context block (agent / boss / room / owner names — for the LLM's situational awareness only; the model still doesn't emit IDs).
- Output schema with category + event + link fields per fact (no identity fields; assignment is post-extraction per §6 step 6a).

## 6. afterTurn flow

```
1. Skip if turn status != "completed" or assistantText is empty.
2. Build query embedding from ctx.originalText + assistantText.
3. Fanout existing-memories lookup (parallel, 4 Qdrant searches):
     a. agent scope: filter { category: "agent", agent_id: ctx.agentId }, topK=10
     b. boss scope:  filter { category: "boss",  user_id: ctx.userId },   topK=10
        (skip if ctx.userId is null)
     c. room scope:  filter { category: "room",  room_id: ctx.roomId },   topK=10
     d. office scope: filter { category: "office" },                       topK=10
4. Build extraction prompt with identity context + the four existing-memory pools.
5. Single Anthropic Claude Haiku call. Validate response against envelope schema (§5.2).
     - Envelope invalid → drop entire turn's write, log, return.
6. For each emitted memory in the valid envelope:
     6a. **Deterministic identity assignment** based on the LLM-chosen category:
            agent  → set agent_id  = ctx.agentId  (drop item if ctx.agentId is null — should never happen)
            boss   → set user_id   = ctx.userId   (drop item if ctx.userId is null; categorizer should not have emitted in this case)
            room   → set room_id   = ctx.roomId
            office → no identity fields
         Other identity fields explicitly absent.
     6b. **Item-level invariant validation** (post-assignment): the assembled record matches §4.2's required-/forbidden-identity rules. Failure → drop item, log.
     6c. **Event/link sanity:**
            ADD    with linked_memory_id present     → drop item, log.
            UPDATE with linked_memory_id absent      → drop item, log.
            NONE   with linked_memory_id absent      → drop item, log.
            UPDATE/NONE link NOT present in the prompt's existing-memory pool (i.e. the LLM named a uuid we didn't show it) → treat as hallucinated (see step 6d).
            UPDATE/NONE link is in the prompt pool but its category/scope does NOT match the emitted category → drop item, log (no cross-scope mutation; the model is not authorized to move records across categories in v1).
     6d. **Hallucinated/missing-link handling:**
            UPDATE with link not-in-prompt-pool OR not-in-Qdrant → downgrade to ADD with new uuid. Log. (Deliberate choice: may create occasional dupes, but catches the case where the model named a stale or fabricated id; semantic dedup against topK plus the step 6e hash short-circuit still tends to suppress most.)
            NONE   with link not-in-prompt-pool OR not-in-Qdrant → drop item, log. (Do NOT downgrade — NONE means "already represented" and a missing/fabricated link contradicts that claim.)

         **Authority boundary:** the model can only reconcile against records we showed it. It cannot discover write targets by guessing UUIDs that happen to exist in Qdrant. The prompt-pool check is the enforcement; the Qdrant existence check that follows catches stale prompt-pool ids (e.g. a record deleted between fanout and write).
     6e. **Exact-duplicate short-circuit (storage-level, not topK-dependent):** compute text_hash = md5(normalize(text)). For event=ADD, scroll Qdrant with filter { category, identity-fields-per-category, text_hash } and if a record exists, downgrade to NONE pointing at that record's id. This is cheap (indexed payload lookup), deterministic, and guards exact dupes even when the existing record fell outside the topK pool the LLM saw.
7. Single batched Qdrant write per event type:
     - ADDs:    Qdrant insert with the record shape from §4.1.
     - UPDATEs: Qdrant update of linked_memory_id (text, text_hash, updated_at, last_confirmed_at).
     - NONEs:   Qdrant update of linked_memory_id (last_confirmed_at only).
```

### 6.1 Identity defaults

- `agent_id`: always present from ctx.agentId.
- `user_id`: ctx.userId; null when the speaking boss is unattributed (e.g. agent-to-agent messages). In that case the `boss` scope is skipped at fanout and the categorizer is instructed to not emit `boss`-category facts.
- `room_id`: ctx.roomId; always present.

### 6.2 Why all four scopes are pulled, not just the categorizer's eventual choice

The categorizer needs **relevant candidates** from all four pools at decision time, or it can't make UPDATE/NONE decisions across categories. If the boss restates "use Spanish in this room" via Agent 2 after Agent 1 already wrote the room-tier fact, the categorizer must SEE that existing room-tier candidate (assuming it ranks in topK by vector similarity) to choose NONE (or UPDATE) over ADD.

Important caveats:

- The four pools are **topK vector samples**, not exhaustive scope contents. The fanout makes normal restatements resolve correctly — when the existing fact is semantically similar enough to be in topK, the LLM sees it and reconciles. It is NOT a mathematical guarantee against duplicates across categories.
- **Exact duplicates** are additionally guarded by the storage-level `text_hash` short-circuit in step 6e — that path runs regardless of topK ranking, so a verbatim repeat is caught even if vector similarity put it outside the pool.
- Paraphrases that fall outside topK can still slip through as duplicates; this is acceptable for v1 and is the dedup ceiling Reviewer3's spec sets. Hybrid search and richer dedup are explicit v2 work.

## 7. beforeTurn flow

```
1. Build query embedding from ctx.originalText.
2. Fanout retrieval (parallel, 4 Qdrant searches, each with topK_PER_CATEGORY=3):
     a. category=agent, agent_id=ctx.agentId
     b. category=boss,  user_id=ctx.userId  (skip if userId is null)
     c. category=room,  room_id=ctx.roomId
     d. category=office
3. If a per-category search fails, log structured error and use empty list for that category. Other categories' results still surface.
4. Apply deterministic allocation up to MAX_TOTAL=8:
     - First pass: reserve 2 slots per category (8 total). Each category contributes up to its top-2 (by vector score).
       Categories with fewer than 2 hits — including categories skipped entirely (e.g. `boss` when ctx.userId is null) —
       leave their unused slots in a free pool.
     - Second pass: fill the free pool by taking remaining candidates (positions 3 from each category) in deterministic
       hierarchy order (office → room → boss → agent), one at a time, until MAX_TOTAL or pools exhausted.
     - This guarantees agent-tier never starves under broad office context, and per-tier ordering is deterministic for
       a given query (no hash-ordering surprises).
5. Format as a hierarchically-ordered prefix (office → room → boss → agent), each non-empty section as:
       Relevant facts retrieved from memory:

       ### Office-wide
       - <text>
       - ...

       ### Room "Isomux Dev"
       - <text>
       - ...

       ### Boss "Nil"
       - <text>
       - ...

       ### Agent "Isomuxer3" (your own working memory)
       - <text>
       - ...
   Sections with zero facts are omitted entirely (no empty headers).
6. Return as promptPrefix; the host's hook bus wraps in --- begin plugin: isomux-memory --- delimiters.
```

### 7.1 Why hierarchical order (office first)

The agent reads top-to-bottom; office-wide context primes its frame, room-tier context narrows it, boss-tier personalizes, agent-tier supplies own working notes. Matches the system-prompt hierarchy (office prompt → room prompt → agent custom instructions).

### 7.2 Retrieval failure handling

Per-category failures degrade gracefully — if office-scope Qdrant search times out, the agent still sees room/boss/agent. A single total Qdrant outage logs and produces no prefix; the turn proceeds without injected memory.

## 8. Failure modes (explicit)

| Failure | Behavior |
|---|---|
| Anthropic extractor returns non-JSON or envelope-schema fails | Entire turn's write dropped (envelope-level). Structured log entry. |
| Anthropic timeout or rate-limit (no response) | Entire turn's write dropped. Log with provider error code. |
| Envelope valid but individual item has invalid `category` or `event` enum | That item dropped, other valid items proceed. Log per dropped item. |
| Item-level invariant fails (post-identity-assignment shape mismatch — e.g. `boss` category emitted but `ctx.userId` is null) | Item dropped, other items proceed. Log. |
| Item-level event/link sanity fails (ADD with link, UPDATE without link, NONE without link) | Item dropped, other items proceed. Log. |
| `linked_memory_id` exists but its category/scope does NOT match the emitted category | Item dropped, other items proceed. Log. (Explicit no-cross-scope-update guarantee.) |
| `UPDATE` with `linked_memory_id` not in the prompt pool OR not in Qdrant | Downgrade to ADD with fresh uuid. Log. (Per §6 step 6d. Treats hallucinated UUIDs and stale prompt-pool ids identically.) |
| `NONE` with `linked_memory_id` not in the prompt pool OR not in Qdrant | Item dropped, other items proceed. Log. (Do NOT downgrade; `NONE` without a valid link is contradictory.) |
| One Qdrant write fails inside the batch | Partial write logged with attempted ids. Other writes proceed. No in-loop retry. Turn doesn't fail. |
| Qdrant collection missing or bootstrap failure | beforeTurn produces no prefix; afterTurn skips write entirely. Log on first encounter per process. |
| One per-category Qdrant search fails at beforeTurn | That section omitted. Other sections present. Log. |
| All Qdrant unreachable | beforeTurn produces no prefix; afterTurn skips write entirely. Both log. |
| Embedding API fails | beforeTurn / afterTurn abort at the embedding step; log; turn proceeds without memory operation. |

All errors route to `~/.isomux/logs/plugins.jsonl` via the isomux hook bus. None block the turn.

## 9. Eval set (built before prompt iteration)

15–25 synthetic turns to tune the categorizer against during implementation. Each entry: `{ context: {agent, boss, room}, user_message, assistant_message, expected_extractions: [{text_fragment, category}] }`. Categories covered:

| # | Scenario | Tests |
|---|---|---|
| 1 | Boss preference (writing style) | boss-category routing |
| 2 | Boss preference (tooling) | boss-category routing |
| 3 | Room convention (project uses Bun) | room-category routing |
| 4 | Room norm (always run prettier) | room-category routing |
| 5 | Office norm (no em-dashes) | office-category routing |
| 6 | Office fact (the office uses systemd-user services) | office-category routing |
| 7 | Agent working state (mid-refactor) | agent-category routing |
| 8 | Agent working state (debugging X) | agent-category routing |
| 9 | Contradiction → UPDATE existing boss-tier | UPDATE semantics |
| 10 | Restate existing room fact → NONE | NONE semantics |
| 11 | Duplicate across two agents (5-agents test) | cross-category dedup |
| 12 | Mixed-tier turn (boss preference + agent working note) | multi-fact extraction at multiple tiers |
| 13 | Boss says something private (API key) | privacy routing — must land at boss, not agent |
| 14 | Boss says something ambiguous (could be agent or boss) | default-to-boss when uncertain |
| 15 | Office-tier restatement → NONE on existing | NONE + office scope |
| 16 | Agent restates own working note | NONE + agent scope |
| 17 | Unattributed turn (userId null) | boss scope skipped, no boss-tier emission |
| 18 | Empty extraction (no facts) | clean no-op |
| 19 | Sensitive content marked as non-personal | adversarial privacy test |
| 20 | Cross-room user statement ("in our other room we use X") | room scope correctness — should NOT write to current room |
| 21 | Unattributed turn with private content (userId null) | privacy fallback — must emit NONE, not boss/office/agent |
| 22 | Office-looking but boss-private (e.g. "For my agents, never mention X about my company") | privacy edge — boss-category despite collective phrasing |
| 23 | Category-move attempt (existing boss-tier "use Spanish" + new "use Spanish only in Isomux Dev") | category boundary — emit room-category ADD, leave existing boss-tier untouched (no silent cross-category mutation in v1) |
| 24 | Exact-hash duplicate outside retrieval topK | storage-level dedup — verbatim repeat after topK cutoff must short-circuit to NONE via step 6e |

(Final count and exact scenarios refined during prompt-iteration phase; this is the minimum.)

## 10. Migration

**Fresh start.** New Qdrant collection (default name: `isomux_memory`). The existing `isomux_mem0` collection's 52 points are bootstrap-quality with no category provenance; not worth a Haiku reclassification pass.

`isomux-mem0` repo gets a deprecation notice in its README pointing to `isomux-memory`. The plugin entry in `office-config.json` switches at cutover; no parallel run.

**Rollback path.** Because the new plugin writes to a fresh collection and the old `isomux_mem0` collection is untouched at cutover, operational rollback is low-risk: revert the `enabledPlugins` entry in `office-config.json` from `isomux-memory` back to `isomux-mem0`, restart isomux. The old plugin and its data are unaffected. New-collection records can stay or be dropped via Qdrant; they don't poison anything else.

Optional bridge (not v1): a config flag could enable read-only `isomux_mem0` fallback in `beforeTurn`. Deferred unless an operational need arises.

## 11. Attribution

The extraction prompt adapts material from [mem0ai/mem0](https://github.com/mem0ai/mem0) under Apache-2.0. The exact upstream source is pinned to the version we adapted:

- Upstream file: [`mem0-ts/src/oss/src/prompts/index.ts`](https://github.com/mem0ai/mem0/blob/ts-v3.0.3/mem0-ts/src/oss/src/prompts/index.ts) at tag `ts-v3.0.3`
- Constants we adapt: `ADDITIVE_EXTRACTION_PROMPT` (system prompt) and `generateAdditiveExtractionPrompt` (user-prompt builder); we replace `AdditiveExtractionSchema` with our four-category schema.

The plugin repo includes:

- `NOTICE` at the root crediting mem0ai/mem0 with this exact upstream reference.
- A header comment in the prompt source file marking the sections lifted-as-is, lifted-and-modified, and authored-fresh.

## 12. Open questions / out of scope

- **Hybrid search** (BM25 + entity boosts). Deferred until retrieval-quality complaints arise.
- **DELETE events**. Deferred; needs explicit contradiction/removal evidence model.
- **Cloud-mode parity**. Out of scope; this plugin is OSS-only.
- **Graduation policy** (fact repeated by multiple agents → promote tier). Not in v1.
- **Cross-turn extraction context**. Same `disableHistory: true` situation as `isomux-mem0`. Bun-native history store is future work.
- **Provenance-driven UI**. Stored but not surfaced. Future inspector UI deferred.
- **Per-agent or per-boss enable/disable**. The isomux plugin contract doesn't support it yet; office-wide enable only.

## 13. Implementation footprint estimate

| Area | LOC est |
|---|---|
| Qdrant client (REST) + collection bootstrap | ~100 |
| Embedder wrapper (OpenAI default; Ollama stretch) | ~80 |
| Extraction prompt + Anthropic call + schema validation | ~150 |
| Reconciliation logic (ADD/UPDATE/NONE) + invariant validation | ~150 |
| Retrieval fanout + formatting | ~100 |
| Identity, config, hooks (beforeTurn/afterTurn entry points) | ~120 |
| Smoke test (live, opt-in) | ~150 |
| README, NOTICE, this doc | (already drafted) |
| **Total** | **~850 LOC** |

3–5 focused engineering days. Bottleneck is prompt iteration against the eval set.

## 14. Review status

| Reviewer | Status | Notes |
|---|---|---|
| Reviewer3 | **Signed off** on the spec (2026-05-26) after round 2. Round 1: 10 precision issues, all folded in. Round 2: 3 final fixes (stale identity wording in §5/§5.4, linked_memory_id authority scoped to prompt pool not just Qdrant, provenance fields + UPDATE/NONE preservation rule), all folded in. One non-blocking implementation note also folded in: §7 allocator treats skipped categories' reserved slots as immediately free. |
| Nil (owner) | Approved pivot, confirmed §3 privacy model, confirmed §4 schema (agent only `agent_id`, etc.). Pending: read of final spec. |
