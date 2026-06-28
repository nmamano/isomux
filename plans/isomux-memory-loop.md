# Isomux Memory loop — standing orders + slice handoffs

Re-read this file at the start of every iteration. [why: conversations compact, files don't]

Owner/human: **Nil**. Reviewer (plan-gate + diff-gate): **Reviewer3** = `agent-1779193515618-0wxo` (Isomux Review room, gpt-5.5).
Design doc (authoritative): `internal-docs/isomux-memory-design.md`.
Working location: **directly on main** (no worktree — Nil's call). Stage only my own paths; if a file I need has another agent's uncommitted changes, STOP and tell Nil.

## North star

Agents write durable, attributed facts about people/projects/environment/rules to four shared scopes via REST and auto-receive the relevant ones in their system prompt as a _notes-not-policy_ layer; humans curate the same facts as plain text next to each scope's prompt field. Filesystem-based markdown, greppable, human-editable, no vector store. The novel capability is **cross-agent shared memory** — do not dilute that into agent-only memory.

## Process per slice

plan → **Reviewer3 plan-gate (review BEFORE coding)** → implement → run always-run gates → **Reviewer3 diff-gate (review the diff BEFORE commit)** → on sign-off, ONE focused commit (Nil granted per-slice commit autonomy on main, after Reviewer3 sign-off). **Push is always manual — never push.** Never start slice N+1 before slice N is committed. Author the next slice's PICKUP only after the current commits, folding in what it taught.

## Gates per slice

Always-run (cheap, deterministic, zero quota/network/keys):

- `bun test` — full suite green + the new tests for this slice
- `bunx tsc --noEmit` — clean (was clean at baseline)
- `bun run lint` — clean
- `bun run format:check` — only right before commit (Prettier; do NOT `format:write` before human review)

Env-gated / opt-in (Nil sign-off each run; NOT load-bearing for correctness — T1 carries this feature):

- `bun run test:live` (T3, burns subscription quota) — SKIPPED unless Nil asks.
- Playwright curation smoke (no quota, slow) — run ONCE at the end (Nil: "playwright at the end").

Evidence surface = persisted `.md` files under the temp `ISOMUX_HOME` + REST response/envelopes + the exact assembled prompt string. NEVER judge by a UI render or pane. A bug a gate finds gets a regression test at the right layer in the same slice. Gates are never weakened to pass — fix in-slice or queue the decision.

## Standing rails (prohibitions — verbatim)

- NEVER touch the live `~/.isomux/memory` or live `~/.isomux` state in tests. Every test instance gets its own `ISOMUX_HOME` temp dir (the harness preload + `assertSafeToDelete` already enforce this).
- NEVER repoint `~/isomux-active` or restart the `isomux` systemd service without Nil's explicit in-message approval.
- NEVER push. Per-slice commits on main are allowed (after Reviewer3 sign-off); pushing is not.
- Authority is ALWAYS derived from the authenticated caller (token/cookie). `author`, `date`, `id` are server-assigned; NEVER trust them from the request body.
- NEVER expose the boss-memory filesystem path in the system prompt (design §2/§6). Boss reads happen via the REST endpoint affordance only.
- NEVER weaken a gate to make a slice pass.
- One slice at a time; one focused commit per slice; never two slices in flight.
- Stage only my own paths (`git add <path>`, never `git add -A`) — five other agents share main.

## Authority model (Nil's simplification of design §4 — permissive, restraint via prompt)

- Any authenticated caller (agent token OR user cookie) may READ and WRITE any scope and any scopeId, **including any boss**. No per-scope permission gates. Restraint lives in the system-prompt affordance, not in code.
- The TWO things still enforced structurally (the rails): (1) author+date provenance is server-stamped from the caller's identity, never from the body; (2) **auto-load** injects a boss's notes only into that boss's own agents' prompts (auto-load uses the agent's manager `userId` = `managed.info.username` → user id), so one boss's notes don't bleed into another's context — but _writes_ about any boss stay open.
- `scopeId` is a TARGET selector (which file), not an authority claim. Boss writes: explicit `scopeId` targets that boss; omitted → default to caller's own/manager userId. **Agent with a null manager userId + omitted boss scopeId → 400** (never create `bosses/null.md`).
- All `scopeId`s: strict identifier regex + reject path traversal (`../`, slash, encoded slash); validate the target id EXISTS for `agent`/`room`/`boss` (office has no id).
- Naming everywhere (code/tests/UI/docs): **"boss-scoped memory"** / "boss context memory", NEVER "private boss memory" — the wording must match the actual (non-confidential, same-OS-user) behavior.
- **Design-doc sync (Reviewer3 pin):** update `internal-docs/isomux-memory-design.md` §2/§3 in the boss slice family (3c) or 3i so boss memory reads as _context-scoped for auto-load, not read-private over REST_ — otherwise someone later "fixes" the GET route back to self-only.

## Capabilities & decided implementation choices (me + Reviewer3, Nil FYI'd)

- New first-class capabilities `memory:read` / `memory:write` on USER + AGENT sets; resource guard is plain `authenticated`. Do NOT fold memory under `office:read`.
- Storage in a leaf module `server/memory-store.ts`, deps only `STATE_ROOT`/fs/path + INJECTED date + id generator (deterministic tests).
- Hard text validation: single line, no embedded newline, trimmed, non-blank.
- Atomic writes: `appendFile` + ensure parent dirs; human textarea rewrites = temp file + rename.
- Loader resolves tombstones/supersedes and suppresses superseded/retracted lines (3d) — not just appends markers.
- Truncation (3f) is by active-line FILE ORDER, newest-first; dates are provenance, not an ordering key.
- Dedup (3e) returns the matched id on rejection so the agent understands why.
- Q1: keep raw `grep` for non-private scopes AND provide REST `GET` for all scopes. Q3: identical dedup threshold across scopes to start.
- Caps (chars, newest-first, one central tested constant): **office 2500 · room 3500 · agent 5000 · boss 5000**. Over-cap loads what fits + appends a "Not all memories fit. Consider suggesting the boss to trim them." line.

## Line format (design §1)

```
- <!-- mem:ID --> [<author>, <YYYY-MM-DD>] <self-contained fact>
```

Supersede: `- <!-- mem:NEWID supersedes:OLDID --> [author, date] <fact>`. Retract/tombstone: a marker line targeting OLDID (exact syntax settled at the 3d plan-gate). ID = short stable token (design example `ab12cd`); generate, check in-file collision; injectable for tests.

## Slice plan (tick on commit)

- [x] 3a TRACER — `server/memory-store.ts` (parse/serialize/append, id-gen) + `POST`/`GET /api/memory` AGENT scope + `memory:*` caps + routes registered + auto-load `agents/<id>.md` as attributed layer + minimal "How to use memory" affordance + negative prompt assertion (notes-not-policy present, no boss path).
- [x] 3b — room + office scopes (write/read/auto-load), blast-radius framing in affordance.
- [x] 3c — boss scope (server-stamped provenance, scopeId target rules incl. null-manager→400, auto-load = manager boss only, path redaction). Update design doc §2/§3. Also folded in cross-agent agent-scope (full permissive) + design-doc §4/§9 sync.
- [ ] 3d — `PATCH`/`DELETE` supersede/tombstone + loader resolution (suppress superseded/retracted).
- [ ] 3e — write-time dedup guard (exact/fuzzy, reject/merge, return matched id).
- [ ] 3f — size caps + over-cap trim notice (active-line order, newest-first).
- [ ] 3g — human curation: id self-heal re-stamp on save (server) + office prompt modal surface.
- [ ] 3h — human curation: room settings / edit-agent / user-management surfaces.
- [ ] 3i — affordance finalization + doc updates (documentation.md surfaces, AGENTS.md, docs/features.md, testing-guide traceability row, design doc marked implemented) + Playwright curation smoke once.

## Deferred / parked (do-not-pick-up)

- Boss-curated pinning, proposal/promotion queue, vector/RAG over the files (design §8). Out of scope.
- T3 live smoke — skipped unless Nil asks.
- Parked-for-Nil decisions queue: (none open — all Phase-1 questions resolved).

## Resources (key files, APIs, evidence surfaces, house patterns)

- Design: `internal-docs/isomux-memory-design.md`. Doc surfaces to keep current: `internal-docs/documentation.md`.
- Prompt assembly: `server/system-prompt.ts` — `buildSystemPrompt(...)` pure fn; affordances are inline template literals; layer order baseline→privileged→manager(+memberPrompt)→office→room→custom. Add memory affordance in baseline; add auto-load layer at the end. Call site: `server/agent-manager.ts` `createSession` (~2675) + `server/command-handlers.ts` (~572, `/isomux-system-prompt`).
- Route table: `server/routes/table.ts` (`defineRoute`, `cap(capability, guard)`, `authenticated`). Handlers: `server/routes/handlers/<name>.ts` returning `ok/created/noContent/fail`. Register in `server/index.ts` `buildExecutorDeps` (~1210) via `register(memoryHandlers({...}))`.
- Identity/caps: `server/identity/index.ts` (`Identity`, `Capability`, `USER_CAPABILITIES`, `AGENT_CAPABILITIES`). Auth: `server/auth-middleware.ts`.
- State root: `server/config.ts` `STATE_ROOT` (honors `ISOMUX_HOME`).
- Test harness: `server/test-support/harness.ts` (`startTestServer`, `seedOwner`/`seedMember`, `http`, assert files under `stateRoot`). Agent token: `mintAgentToken(agentId, ownerUserId)` from `server/identity/tokens.ts`. Mirror `server/test-support/routes-tasks-rest.test.ts` for `routes-memory-rest.test.ts`. Prompt tests: T0 against `buildSystemPrompt`.
- Contract shapes: `shared/contract-shapes.ts`. UI surfaces: `ui/components/{OfficePromptModal,RoomSettingsModal,EditAgentDialog,UserManagementModal}.tsx`.
- Baseline (all clean): `bun test` 852/0, `bunx tsc --noEmit` 0, `bun run lint` 0.

## Stop conditions

Completion of all slices; OR 3 consecutive gate failures on the same slice with no fix path (→ queue for Nil, stop cleanly); OR a hard block needing a Nil-only decision with nothing else unblocked (→ queue, stop); OR Nil says stop; OR rate limits. On stop: no further wakeups, leave a summary table (slice → commit → what landed) + the parked queue.

---

## SLICE-3a PICKUP — authored now

**Baseline:** HEAD at slice start = the commit that adds this file.
**Goal:** the smallest end-to-end vertical: an agent writes a fact to its own agent scope via REST, it lands in `<ISOMUX_HOME>/memory/agents/<agentId>.md` as a provenance-stamped, id-tagged line, and on the next session start that line is injected into the agent's system prompt as an attributed _notes-not-policy_ layer. Plus a minimal "How to use memory" affordance.

**Scope of 3a (keep it thin):** AGENT scope only. No room/office/boss. No PATCH/DELETE. No dedup. No caps. Register the `/api/memory` routes + `memory:*` capabilities NOW (even though only agent-scope handlers exist) so guard/capability tests pin the surface early.

**Load-bearing mechanics (the traps):**

- Author provenance server-stamped from the token (agent name), date injected for tests — NEVER from body (mirror tasks' `createdBy` behavior-change test).
- `POST /api/memory {scope:"agent", scopeId?, factType, text}`: for agent scope, target is the caller's own agentId; if `scopeId` given it must equal the caller's agentId (own file only in 3a). Validate text: single line, no newline, trimmed, non-blank → else 400.
- id generation: short stable token, in-file collision check, injectable generator.
- Auto-load: read `agents/<id>.md`, inject after the custom-instructions layer as a clearly-framed attributed block ("shared context & observations, attributed — notes, not policy"). File missing → inject nothing (no error).
- Negative invariant (start it now): assembled prompt contains the memory line + notes-not-policy framing, and contains NO `~/.isomux/memory/bosses` / boss path string.
- Path safety from day one: strict id regex on any `scopeId`, reject traversal.

**Acceptance criteria (evidence-based):**

- T0: `buildSystemPrompt` with a memory string injects the attributed layer at the right position; without it, nothing changes; never emits a boss path.
- T0: `memory-store` round-trips — append produces a correctly-formatted line; parse reads it back; id is stable; injected date/id are deterministic.
- T1 (`routes-memory-rest.test.ts`, mirror tasks): unauth `POST`/`GET /api/memory` → 401 `unauthenticated`; agent-token `POST` appends to `agents/<id>.md` under `stateRoot` with server-stamped author=agent name; body-supplied author/date/id ignored; `GET` returns the agent's lines; writing another agent's id → rejected; text with embedded newline → 400; traversal `scopeId` → rejected.
- All always-run gates green.

**Decide-with-Reviewer3 at the 3a plan-gate:** exact id length/charset + collision strategy; exact wording of the attributed auto-load header + the minimal affordance; whether `factType` is validated against the taxonomy in 3a or just stored; GET response shape (raw lines vs structured objects).

**Locked (do not relitigate in 3a):** permissive authority model; `memory:*` capabilities; leaf `memory-store.ts`; filesystem layout; line format; "boss-scoped" naming; caps deferred to 3f.

**Resources:** as in the Resources section above; primary references `server/system-prompt.ts`, `server/test-support/routes-tasks-rest.test.ts`, `server/routes/handlers/tasks.ts`, `server/identity/index.ts`.

## SLICE-3b PICKUP — authored after 3a (ec92ed1)

**What 3a taught (fold in):**

- `server/memory-store.ts` is ALREADY scope-agnostic: `filePath()` handles office/room/agent/boss; read/append/renderForPrompt take `(scope, scopeId)`. 3b is mostly handler authority + auto-load wiring, not new storage.
- The "deliberate rejection of unsupported paths" pattern works and is tested; 3b drops `unsupported_scope` for room/office, KEEPS it for boss (until 3c).
- `authorFor` already resolves agent OR user display name → USER callers are first-class for room/office in 3b.
- `buildSystemPrompt` currently takes ONE `autoLoadedMemory` string (agent only). 3b must inject office + room + agent together → the signature/threading is the main design question.
- Strict 6-hex id grammar + path-traversal scopeId guard are in place and reused.
- Diff-gate caught a real bug (newline checked after trim). Validate raw input BEFORE normalizing.

**Baseline:** ec92ed1.
**Goal:** room + office scopes end to end. Any authenticated caller (agent OR user) may write/read room and office via REST; an agent's session prompt auto-loads office.md + its room's file + its own agent file (boss deferred to 3c). Demo: agent A writes a room fact → agent B in the same room sees it next prompt; an office fact appears for every agent.

**Load-bearing mechanics (traps):**

- Authority stays permissive (Nil): NO room-access gate on writes/reads. But VALIDATE the target exists (Reviewer3 pin): room requires an existing roomId; office has no id. Inject a `roomExists` check.
- scopeId: room → required, strict-id + must exist (404 room_not_found; malformed → 400 invalid_scope_id). office → no scopeId. agent → unchanged. boss → still unsupported_scope until 3c.
- USER callers now supported for room/office (drop unsupported_caller there).
- Auto-load threading: combine office + room + agent into the memory layer; refactor buildSystemPrompt (likely take a prebuilt combined string assembled by agent-manager in order). Keep the no-boss-path invariant + baseline byte-identity when all empty.
- Affordance: expand to room + office; add office blast-radius framing.

**Acceptance (evidence-based):**

- T1: agent-token AND user-cookie POST room fact → rooms/<roomId>.md; GET returns it; office → office.md. Nonexistent room → 404; malformed → 400. boss scope → still unsupported_scope.
- T0: prompt auto-loads office+room+agent in the memory layer; no boss path; baseline byte-identical when all empty; deterministic order.
- Store-level two-agent test: A writes room fact, B's renderForPrompt for that room includes it (no LLM).
- All always-run gates green.

**Decide-with-Reviewer3 at the 3b plan-gate:** (1) buildSystemPrompt memory signature — one combined string vs structured per-scope; scope sub-headers vs flat. (2) room/office writes validate existence only (no access gate)? confirm. (3) office scopeId provided → ignore or 400. (4) keep agent scope 3a-restricted (own file) or open cross-agent now? (5) office blast-radius wording.

**Locked (don't relitigate):** permissive authority; memory:\* caps; line format; "boss-scoped" naming; boss deferred to 3c; caps deferred to 3f.

## SLICE-3c PICKUP — authored after 3b (57703d1)

**What 3b taught (fold in):**

- `resolveTarget` extends cleanly per scope: a boss branch mirrors the room branch (safe scopeId + existence) plus the omitted-scopeId-defaults logic. Reuse the `roomExists`-style injected existence check (`userExists`).
- `renderForPromptMulti` already takes an arbitrary ref list — just add a boss ref in agent-manager/command-handlers; no signature change.
- The existence-check + "deliberate error for unsupported" patterns are settled; 3c FLIPS boss from `unsupported_scope` to supported (update those two tests).
- Prettier reformats on save; format only changed files AFTER sign-off.

**Baseline:** 57703d1.
**Goal:** boss-scoped memory end to end. Any authenticated caller may write/read any boss's file via REST (permissive); an agent auto-loads ONLY its manager boss's notes (so one boss's notes never bleed into another's prompt); the prompt never exposes a boss filesystem path. Demo: a boss preference recorded to the current boss's file; a second boss's file untouched; the agent's prompt shows its manager boss's lines only.

**Load-bearing mechanics (traps):**

- boss branch in resolveTarget: explicit scopeId → safe + must EXIST (`userExists`) else 400 invalid_scope_id / 404 user_not_found; omitted scopeId → default to `identity.userId` (caller's own/manager user); **agent with null manager userId + omitted boss scopeId → 400** (never `bosses/null.md`, Reviewer3 pin). No access gate — any authenticated caller (incl. cross-boss writes).
- Auto-load: agent-manager adds a boss ref ONLY for the agent's manager (`managed.info.username` → userId); no manager → omit. Other bosses' notes never auto-load. Boss notes from one boss must not appear in another boss's agents' prompts.
- Affordance: add a boss curl example + the caveat "boss memory is auto-loaded only for that boss's agents; it is not a confidentiality boundary in this office." NEVER print the boss filesystem path.
- Naming: "boss-scoped memory" / "boss context memory", never "private".
- DESIGN-DOC SYNC: update internal-docs/isomux-memory-design.md §2/§3 — boss reads are context-scoped for auto-load, NOT read-private over REST (any authenticated caller can GET any boss). Pin the intentional exposure with a test.

**Acceptance (evidence-based):**

- T1: agent POST boss (omitted scopeId) → manager boss file; user POST boss (omitted) → own file; explicit other-boss scopeId → that file (permissive, pinned). Nonexistent boss → 404; malformed → 400. Agent with null manager + omitted → 400. GET ?scope=boss&scopeId=<otherBoss> succeeds for any authenticated caller (pin intentional exposure). body author/date/id ignored.
- T0/store: an agent owned by BossA auto-loads BossA boss lines, NOT BossB. Prompt still emits no boss PATH.
- All always-run gates green.

**Decide-with-Reviewer3 at the 3c plan-gate:** (1) boss default scopeId = identity.userId, null → 400 — confirm. (2) auto-load = manager boss only; no manager → omit — confirm. (3) boss GET open to any authenticated caller, pinned — confirm. (4) nonexistent boss error code (`user_not_found` vs `boss_not_found`). (5) affordance boss wording + non-confidentiality caveat. (6) the cross-agent agent-scope deferral — fold the agent-scope full-permissive target (drop 403, add `agentExists`, omitted→own) into 3c to complete the permissive model, or schedule for 3i? (7) design-doc §2/§3 edit in 3c (lean) vs 3i.

**Locked (don't relitigate):** permissive authority; memory:\* caps; line format; "boss-scoped" naming; caps deferred to 3f; PATCH/DELETE deferred to 3d.

### SLICE-3c PLAN-GATE: APPROVED by Reviewer3 — implement on resume (dev paused by Nil)

Resolved decisions + pins to implement exactly:

1. **boss default:** omitted scopeId → `identity.userId`; if that is null → 400 `invalid_scope_id`. If `identity.userId` is non-null but no longer resolves to a user → 404 `user_not_found` before read/write. Explicit scopeId bypasses default, targets that boss if it exists.
2. **auto-load:** manager boss only. Use the STABLE manager `userId` (`managed.info.userId`) if that field exists; only fall back to `getUserByName(managed.info.username)` if not, and document the fallback. No manager userId → omit the boss ref entirely. Label `Boss "<display name>"`; never a path. [impl check on resume: confirm whether AgentInfo carries `userId` or only `username`.]
3. **boss GET open to any authenticated caller** — pin with tests for BOTH an agent token and a user cookie reading ANOTHER boss's file (intentional exposure).
4. **nonexistent boss → 404 `user_not_found`** (selector is a userId; validation is `userExists`).
5. **affordance wording (avoid "current boss"):** `Boss-scoped memory: omit scopeId to write your manager/own boss context, or pass scopeId to target another boss. Boss memory is auto-loaded only for that boss's agents; it is not a confidentiality boundary in this office.` Then a curl with omitted scopeId. No filesystem path; keep the no-boss-path prompt test.
6. **FOLD cross-agent agent-scope into 3c** (remove the temporary exception): agent token omitted scopeId → own agent id; USER cookie omitted scopeId → 400 `invalid_scope_id` (no own agent); explicit scopeId → any authenticated caller may read/write if the agent exists; malformed → 400 `invalid_scope_id`; safe-but-nonexistent → 404 `agent_not_found`. Flip the old other-agent 403 test to SUCCESS (asserts it writes `agents/<other>.md`). Inject an `agentExists` dep. Do NOT leave `unsupported_caller` for user-cookie explicit agent reads/writes — users may target an explicit agent id.
7. **design-doc sync (same commit):** update internal-docs/isomux-memory-design.md §2/§3 AND §4 (drop the old restrictive authority table + "current boss only" text) AND skim §9 for stale wording. Doc must say: REST read/write is authenticated + target-existence gated; boss scope is context-scoped for auto-load, NOT REST-private; provenance is server-stamped; auto-load is manager-boss only.

Additional test pins: null-manager+omitted boss → 400 and NO `bosses/null.md`, same agent with explicit valid boss scopeId succeeds; body author/date/id ignored for boss writes; BossA-owned agent auto-loads BossA not BossB and vice-versa (store/render test, production ref order); affordance has boss REST guidance + caveat but no `memory/bosses`/`bosses/` path; `GET ?scope=boss` omitted-default works for user + manager-agent, explicit other-boss GET works for any authenticated caller.

## SLICE-3d…3i PICKUP — authored when the prior slice commits (fold in what it taught)
