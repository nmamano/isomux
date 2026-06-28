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
- [x] 3d — `PATCH`/`DELETE` supersede/tombstone + loader resolution (suppress superseded/retracted).
- [x] 3e — write-time dedup guard (normalized-exact + Jaccard 0.9, 409 reject, return matched id).
- [x] 3f — size caps + over-cap trim notice (active-line order, newest-first).
- [x] 3g — human curation: id self-heal re-stamp on save (server) + office prompt modal surface.
- [x] 3h — human curation: office-raw route migration + room settings surface. (split surface-by-surface)
- [x] 3h2 — human curation: edit-agent surface.
- [x] 3h3 — human curation: user-management surface (boss scope).
- [x] 3i — wrap-up: affordance finalization (edit/retract + dedup note) + internal docs (design-doc IMPLEMENTED banner, testing-guide traceability row). PARKED FOR NIL: user-facing copy (docs/features.md + chatbot, his voice/approval), Playwright smoke (no e2e infra — build-or-waive), live build:ui+restart verification.

> **LOOP COMPLETE (deterministic scope).** All slices 3a–3i committed; suite green (973 tests, 0 fail; tsc + lint clean). The loop's autonomous work is done. PARKED-FOR-NIL queue (human-only, never decided in the loop): (1) user-facing feature copy — docs/features.md + api/chat.ts chatbot, Nil's voice, needs his approval; (2) Playwright curation smoke — no e2e infra in repo, build-as-own-slice vs waive (Reviewer3 leans waive given T0/T1); (3) live manual verification — needs `bun run build:ui` + `systemctl --user restart isomux` (Nil-gated).

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

## SLICE-3d PICKUP — authored after 3c (91aa26d)

**What 3c taught (fold in):**

- `resolveTarget` now serves all four scopes and is the shared GET/POST entry; 3d's PATCH/DELETE should reuse the same scope/scopeId target resolution to locate the FILE.
- **Ids are unique only WITHIN a file** (append collision-checks per file), so `:id` alone cannot locate a line — PATCH/DELETE must also carry scope + scopeId to pick the file.
- The parser/grammar is strict (`LINE_RE` = `mem:[0-9a-f]{6}`); 3d is the deferred GRAMMAR gate for supersede/tombstone tokens. Extend the grammar + add a resolver; keep round-trip + "never write malformed id" invariants.
- Existence-gated permissive model + server-stamped provenance are settled; PATCH/DELETE follow the same posture (any authenticated caller; author/date/id server-stamped on the new supersede/tombstone line).
- New routes need route-table entries + `SPEC_ROUTE_CONTRACT` rows + handler registration (the contract test pins the exact opId set).

**Baseline:** 91aa26d.
**Goal:** edit + retract a fact by its stable id, append-only (never in-place rewrite), and have the loader STOP surfacing superseded/retracted lines. Demo: PATCH a fact → old line suppressed, new text auto-loads; DELETE a fact → it stops auto-loading; the raw file retains full provenance.

**Load-bearing mechanics (traps):**

- Grammar extension (append-only): supersede = a normal fact line carrying an extra token, `- <!-- mem:NEW supersedes:OLD --> [author, date] <new text>`; tombstone = a control line, `- <!-- mem:NEW tombstones:OLD --> [author, date] (retracted)`. Both get their own fresh id (provenance/audit). Extend `LINE_RE`/parse to capture the optional `supersedes:`/`tombstones:` target.
- Resolver in read/parse: collect the set of suppressed ids (every OLD referenced by supersedes/tombstones); the RESOLVED ACTIVE set = lines whose id is not suppressed AND that are not tombstone control lines. Handles chains (NEW2 supersedes NEW1 supersedes OLD → only NEW2). `read()`/GET return the resolved active set; the raw file keeps everything; `renderForPrompt*` use the resolved set.
- PATCH/DELETE locate the file via required scope + scopeId (reuse resolveTarget), then require OLD id to be present+active in that file (else 404). `:id` malformed → 400.
- Append the new supersede/tombstone line via the store (id-gen + collision guard reused). Never rewrite in place.
- New routes: `PATCH /api/memory/:id` (memory.update), `DELETE /api/memory/:id` (memory.delete), cap `memory:write`, emits []. Add SPEC rows + register handlers.

**Acceptance (evidence-based):**

- T0 store: supersede-after-fact (old suppressed, new active), tombstone-after-fact (target gone, control line not rendered), supersede chain, resolver leaves unrelated lines intact; raw file still contains all lines.
- T1 REST: PATCH/DELETE require scope+scopeId (missing/malformed → 400), unknown id in target file → 404, auth wall (401), cross-file id isolation (same id in another file untouched), permissive (any authenticated caller), author/date server-stamped on the new line.
- T0 prompt/render: a superseded/retracted line no longer appears in renderForPrompt(Multi).
- All always-run gates green.

**Decide-with-Reviewer3 at the 3d plan-gate:** (1) require scope+scopeId on PATCH/DELETE to locate the file (id not globally unique) — confirm. (2) grammar token names (`supersedes:`/`tombstones:`) + tombstone body `(retracted)` + each gets a fresh id — confirm. (3) read()/GET return the RESOLVED active set (raw retained on disk); settings textarea (3g) reads raw separately — confirm. (4) PATCH = append supersede w/ new text; DELETE = append tombstone — confirm. (5) require OLD id present+active else 404 — confirm. (6) emits [] (UI reads on open; no event yet) — confirm.

**Locked (don't relitigate):** permissive authority; memory:\* caps; "boss-scoped" naming; caps deferred to 3f; append-only provenance (supersede/tombstone, never in-place rewrite).

## SLICE-3e PICKUP — authored after 3d (fff4ad8)

**What 3d taught (fold in):**

- Two read views exist now: `read()` = resolved ACTIVE set, `readRaw()` = all conforming entries. Dedup MUST match against the ACTIVE set (a superseded/tombstoned line should not block a re-add).
- Store methods centralize logic well (supersede/tombstone); put the match logic in the store too (testable + reusable), let the handler decide reject vs merge.
- The fail() envelope is `{error:{code,message}}` with an optional detail arg — that's where the matched id rides.
- New behavior on memory.create only; PATCH supersede is a targeted edit (exempt).

**Baseline:** fff4ad8.
**Goal:** a write-time dedup guard — the design's one non-prompt guardrail (§4.3, §6). On `POST /api/memory`, a cheap match against the same scope's ACTIVE set rejects an obvious restatement and returns the matched id, so an over-eager agent can't slowly pollute a shared scope with near-duplicate lines. Demo: POST a fact, POST a trivially-reworded restatement → 409 naming the existing id.

**Load-bearing mechanics (traps):**

- Match against `read(scope, scopeId)` (ACTIVE), not raw. Normalize before compare: trim, lowercase, collapse internal whitespace, strip trailing punctuation.
- Exact-after-normalize is the cheap deterministic core; add a simple fuzzy (token-set Jaccard ≥ a single central THRESHOLD constant, identical across scopes per Q3) so reworded restatements are caught. Keep it deterministic (no LLM).
- Store: `findDuplicate(scope, scopeId, text): MemoryItem | null` (first active match). Handler `memory.create`: on a hit → 409 `duplicate_memory`, detail carries the matched id (+ text) so the agent understands why. No silent merge in v1 (merge deferred).
- Dedup is POST-create only. PATCH/DELETE unaffected. Boss/agent/room/office all use the same threshold.
- A bug the guard finds in tests gets a regression test (per loop rules).

**Acceptance (evidence-based):**

- T0 store: exact dup, normalized dup (case/whitespace/trailing-punct), fuzzy near-dup ≥ threshold matched, distinct fact below threshold NOT matched, a dup of a SUPERSEDED line is allowed (active-set only), match is per-scope/per-file.
- T1 REST: POST dup → 409 duplicate_memory with the matched id in the response; first write still 201; PATCH is exempt (can supersede with text equal to another line); cross-scope same text is not a dup.
- All always-run gates green.

**Decide-with-Reviewer3 at the 3e plan-gate:** (1) reject (409 + matched id), no silent merge in v1 — confirm vs merge-return-existing. (2) matching = normalized-exact + token-Jaccard ≥ THRESHOLD (one constant, identical across scopes) — confirm the metric + starting threshold, or exact-only for v1. (3) dedup on POST create only; PATCH exempt — confirm. (4) error shape: 409 `duplicate_memory`, matched id in `detail` — confirm. (5) normalization rules — confirm (esp. strip-trailing-punct).

**Locked (don't relitigate):** permissive authority; memory:\* caps; append-only; "boss-scoped" naming; caps deferred to 3f.

## SLICE-3f PICKUP — authored after 3e (80c10b1)

**What 3e taught (fold in):**

- Central tested constants work well (DEDUP_THRESHOLD). Add `MEMORY_CAPS` the same way, and make caps INJECTABLE into the store (like genId/today) so tests use tiny fixtures instead of baking 2500 etc (Reviewer3 pin).
- `read()` returns the ACTIVE set in file order; "newest" = end of file (append order). Caps operate on the active set only.
- Caps belong in `renderForPrompt`/`renderForPromptMulti` (the auto-load path). GET /api/memory uses `read()` and stays UNCAPPED.

**Baseline:** 80c10b1.
**Goal:** per-scope injected-size caps with deterministic, visible degradation (design §3). When a scope's active memory fits, the whole file loads; when it exceeds the cap, auto-load keeps the NEWEST lines that fit and appends a trim notice — so growth degrades predictably and nudges curation. Demo: overfill a scope past its cap → prompt shows the newest lines + the notice, oldest dropped.

**Load-bearing mechanics (traps):**

- `MEMORY_CAPS: Record<MemoryScope, number>` = office 2500 / room 3500 / agent 5000 / boss 5000 (chars). Central exported constant; injectable via MemoryStoreDeps.caps (default MEMORY_CAPS).
- Cap measured against the joined RAW active lines (each `m.raw`, newline-joined) — the actual injected bytes.
- Over cap: select newest-first (walk from file end), accumulate until the next line would exceed the cap, then restore FILE ORDER for presentation and append the notice. Notice text (exact, design §3): "Not all memories fit. Consider suggesting the boss to trim them."
- Caps in renderForPrompt (per-scope lookup) → renderForPromptMulti gets per-scope caps for free. GET stays uncapped.
- Dates are provenance, never an ordering key — order is file/append order.

**Acceptance (evidence-based):**

- T0 store (tiny injected caps): under-cap → all lines, no notice; over-cap → newest kept + notice, oldest dropped, survivors in file order; per-scope caps differ (office stricter than agent); exact notice text; renderForPromptMulti applies caps per scope.
- Edge: a single line longer than the cap → notice alone (decide at gate).
- GET /api/memory remains uncapped (returns all active even past cap).
- All always-run gates green.

**Decide-with-Reviewer3 at the 3f plan-gate:** (1) measure cap against raw line bytes incl. the mem:ID comment — confirm. (2) selection newest-first, presentation restored to file order, notice appended — confirm presentation order. (3) single-line-over-cap → notice alone — confirm edge. (4) caps injectable (tiny fixtures) + central MEMORY_CAPS — confirm. (5) caps auto-load only, GET uncapped — confirm. (6) exact notice text — confirm.

**Locked (don't relitigate):** permissive authority; append-only; "boss-scoped" naming; cap numbers (Nil-set: 2500/3500/5000/5000).

## SLICE-3g PICKUP — authored after 3f (4516dc5)

**What earlier slices taught (fold in):**

- Memory lives in `~/.isomux/memory/*.md` (the store), NOT in office-config.json. The settings `memory` field is RAW TEXT handed to the store; do not persist memory in office-config.
- `atomicWriteFileSync` (temp+rename) exists in server/persistence.ts; the store appends today — add an atomic whole-file overwrite for the rewrite path.
- Office settings PUT (`/api/office/settings`, opId office.setSettings) is OWNER-ONLY (`cap("office:admin", officeOwner)`). Riding it for SAVE makes office memory curation inherit the prompt field's exact permissions (Nil's rule), and keeps the destructive rewrite (the append-only EXCEPTION) human/owner-gated — agents never reach it.
- Office prompt reaches the client via the all-audience `office_settings_updated` event + initial office state; memory is a separate store, so don't thread it through that event.

**Baseline:** 4516dc5. **This is the first UI slice.** Playwright smoke is deferred to 3i; 3g's evidence is the store + REST/handler tests (UI verified by build + manual).

**Goal:** a human edits office memory as raw markdown in the office settings modal, next to the prompt; on save the server re-stamps ids and overwrites office.md. Demo: open office settings → see raw office.md lines → add a line without an id, edit/remove others → save → office.md has the kept lines verbatim, the new line stamped with a fresh id + [savingUser, today], removed lines gone.

**Load-bearing mechanics (traps):**

- Store: `readRawText(scope, scopeId): string` (verbatim file, "" if missing). `rewriteFromText(scope, scopeId, text, author, today?): MemoryItem[]` — per non-empty trimmed line: if `parseMemoryLine` succeeds (valid existing mem line incl supersede/tombstone) KEEP VERBATIM (preserves id+provenance+relations, even if the human edited the text — design's accepted tradeoff); else stamp a fresh collision-checked id + `[author, today]`. Whole-file ATOMIC overwrite (temp+rename). Empty text → empty file. This is the explicit APPEND-ONLY EXCEPTION (human curation only).
- LOAD: new `GET /api/memory/raw?scope=&scopeId=` (opId memory.raw, cap memory:read) → `{ text }`. Modal fetches on open. (Raw, not the active GET, so superseded/tombstone lines show for full transparency.)
- SAVE: `OfficeSettingsReq` gains `memory?: string | null`. office.setSettings handler: when memory !== undefined, call a `rewriteOfficeMemory(text, authorName)` dep (author = attributionFor(identity).createdBy, the owner's name). Memory is NOT added to office-config persistence or the broadcast event.
- UI: OfficePromptModal gets a memory textarea (same owner-only readOnly gate as the prompt). On open, GET raw → setMemory; handleSave includes `memory` in the PUT.

**Acceptance (evidence-based):**

- T0 store: rewriteFromText keeps valid existing lines verbatim (id/provenance/relations preserved incl an edited-text line keeping its old id), stamps id-less lines with author+today, drops removed lines, atomic overwrite, empty→empty, id collisions across kept+new avoided. readRawText returns verbatim / "" for missing.
- T1 REST: GET /api/memory/raw returns the verbatim file text (incl superseded lines); office settings PUT with `memory` re-stamps office.md (assert file contents + that a new line got a 6-hex id + [Owner, date]); office settings PUT still works without `memory` (unchanged); auth — non-owner PUT still blocked (inherits office:admin); raw GET requires identity (401 wall).
- All always-run gates green. (UI textarea: manual + build; no deep UI unit test unless cheap via the apiFetch/store harness.)

**Decide-with-Reviewer3 at the 3g plan-gate:** (1) SAVE rides the office settings PUT (memory field → rewriteFromText), auth inherits owner-only — confirm vs a dedicated rewrite endpoint. (2) LOAD via new `GET /api/memory/raw` {text} vs threading through the office projection — confirm. (3) rewriteFromText keep-verbatim-if-valid (edited text keeps old id+provenance per design) — confirm. (4) malformed mem-tag line → treat as new text (stamped) vs reject — decide. (5) new-line author = saving user's display name, date = today — confirm. (6) test depth for the UI textarea (store+REST only vs add a store/apiFetch UI test) — confirm.

**Locked (don't relitigate):** memory in memory/\*.md (not office-config); rewrite is the human-only append-only exception; "boss-scoped" naming; Playwright deferred to 3i.

## SLICE-3h PICKUP — authored after 3g (0e97eb2)

**What 3g taught (fold in):**

- The store is surface-agnostic: `readRawText` + `rewriteFromText` + `validateRewriteLines` already work for any scope. 3h is wiring three more surfaces, no new store logic.
- 3g's office pattern is the template: pre-validate memory → apply settings → rewrite; UI loads raw on open, disables the field until loaded, omits memory from the PUT until load succeeds.
- The existing per-surface guards (`roomParam`, `agentParam`, `selfOrOwner`) read PATH params, so a single `/api/memory/raw?scope=&scopeId=` can't reuse them. Path-based raw routes that mirror each settings path reuse the guards exactly.

**Baseline:** 0e97eb2.
**Goal:** the same memory textarea on the room settings, edit-agent, and user-management surfaces, each inheriting that surface's existing permissions.

**Surface map (save endpoint / auth / memory scope):**

- Room → `PUT /api/rooms/:roomId/settings`, `cap("room:manage", roomParam)`, RoomSettingsReq. Scope `room`, scopeId = roomId.
- Agent → `PATCH /api/agents/:id`, `cap("agent:manage", agentParam)`, EditAgentReq. Scope `agent`, scopeId = agentId.
- User → `PATCH /api/users/:username`, `cap(["user:self","user:admin"], selfOrOwner)`, UserUpdateReq. **Scope `boss`, scopeId = the user's userId** (handler resolves username→userId; the memory scope is "boss", not "user").

**Load-bearing mechanics (traps):**

- SAVE rides each settings endpoint: add `memory?: string|null` to RoomSettingsReq / EditAgentReq / UserUpdateReq; each handler pre-validates (validateMemory) → applies its existing settings → rewriteFromText(scope, scopeId, memory, authorName). Auth inherits per-surface automatically. The user handler maps username→userId and writes the `boss` scope.
- Raw LOAD: path-based raw routes mirroring each settings path so the existing guards apply: `GET /api/rooms/:roomId/memory/raw` (roomParam), `GET /api/agents/:id/memory/raw` (agentParam), `GET /api/users/:username/memory/raw` (selfOrOwner; resolves to boss/userId). Each returns `{ text }` via readRawText.
- 3g's office raw is `GET /api/memory/raw?scope=office` (query-based). DECIDE: keep it (minor inconsistency) vs migrate to `GET /api/office/memory/raw` for a uniform path-based scheme (tiny migration: one route + the OfficePromptModal fetch URL).
- UI: replicate 3g's textarea + load-on-open + disabled-until-loaded + omit-until-loaded in RoomSettingsModal, EditAgentDialog, UserManagementModal.

**Acceptance (evidence-based):**

- T1 per surface: raw GET returns verbatim text under the right guard (and is REJECTED for a caller lacking that surface's access — e.g. a non-member room raw read, a non-self/non-owner user raw read); settings save with `memory` re-stamps the right file (rooms/<id>.md, agents/<id>.md, bosses/<userId>.md); settings-validation-fail → memory untouched; malformed → 400 invalid_memory_line + lineNumber.
- build:ui bundles; all always-run gates green.

**Decide-with-Reviewer3 at the 3h plan-gate:** (1) SAVE rides each settings endpoint (memory field per req) — confirm. (2) raw LOAD = path-based per-surface routes reusing roomParam/agentParam/selfOrOwner — confirm; AND keep office query-route vs migrate to /api/office/memory/raw for consistency. (3) user surface ↔ boss scope, scopeId=userId (username→userId in handler + route) — confirm. (4) one slice for all three surfaces (symmetric) vs split (e.g. room+agent, then user) — your call on size.

**Locked (don't relitigate):** memory in memory/\*.md; rewrite = human-only append-only exception; "boss-scoped" naming; Playwright deferred to 3i.

## SLICE-3h2 PICKUP — agent surface (after 3h room cut, 22f3986)

**What the room cut taught:** the per-surface pattern is settled — settings handler pre-validates memory → applies its op → rewriteFromText(scope, scopeId, ...); raw read = path route reusing the surface's guard; UI loads raw on open, resets on id change, disables until loaded, omits until loaded. Agent reuses all of it; the only new wrinkles are in EditAgentDialog (a large component) and the memory-only edit path.

**Baseline:** 22f3986.
**Goal:** the memory textarea on the edit-agent dialog (EDIT mode only — a not-yet-spawned agent has no id/file), inheriting agent:manage.

**Load-bearing mechanics (traps):**

- `EditAgentReq` += `memory?: string|null` (it's `Partial<Pick<AgentInfo,...>>`; memory is NOT an AgentInfo field, so add via `& { memory?: string|null }`).
- `agents.update` handler: EXTRACT memory from the body and delete it BEFORE `malformedAgentFields(b)` and `deps.edit(id, b)` (memory isn't an agent field). Pre-validate memory → `deps.edit` → on edit success, `rewriteFromText("agent", id, memory, author)`. Malformed → 400 invalid_memory_line + lineNumber.
- MEMORY-ONLY edit: after stripping memory, `b` may be empty. Confirm `deps.edit(id, {})` is a no-op success returning the agent; if the core rejects an empty edit, skip `deps.edit` when no agent fields remain and return the current agent. (Verify at implementation; the memory-only test pins it.)
- Raw read: `GET /api/agents/:id/memory/raw`, `cap("agent:manage", agentParam("id"))` → `{ text: readRawText("agent", id) }`.
- EditAgentDialog (EDIT mode): load raw on open + reset on agent-id change + disable until loaded + omit until loaded (room-cut pattern). Two agent-specific pins: (1) INCLUDE memory in the dirty/hasChanges check so a memory-only save actually PATCHes; (2) when memory is included, make the save RESPONSE-DRIVEN — await the PATCH and surface invalid_memory_line BEFORE closing (today non-restarting edits are fire-and-forget/optimistic-close; a destructive rewrite must not be).

**Acceptance:** T1 — agent raw GET (manager verbatim / no-access 403 if cheap / 401); agent settings PATCH with memory re-stamps agents/<id>.md; memory-only PATCH succeeds + writes; edit validation failure (invalid cwd) with memory present leaves memory untouched; malformed → 400 + lineNumber. build:ui. UI manual.

**Decide-with-Reviewer3:** (1) memory in EDIT mode only (spawn excluded) — confirm. (2) memory-only edit handling (no-op edit vs skip-edit) — confirm after I verify deps.edit({}). (3) response-driven only when memory included, else keep fire-and-forget — confirm.

## SLICE-3h3 PICKUP — user-management surface (boss scope), after 3h2 (ac6f7c5)

**What 3h2 taught:** the per-surface pattern is fully settled (pre-validate → apply settings/update → rewrite; raw path route reusing the surface guard; UI load-on-open + reset-on-id-change + disable-until-loaded + dirty-only-after-load + response-driven when memory included; verify the no-op update path for memory-only). Watch for duplicate deps in the interface AND the wiring.

**Baseline:** ac6f7c5. **The wrinkle:** the user-management surface edits a user by USERNAME, but the memory scope is **boss**, keyed by stable **userId**. Resolve username→userId once and operate on `boss`/userId; never key memory by username.

**Load-bearing mechanics (traps):**

- `UserUpdateReq` += `memory?: string|null`.
- `users.update` handler: extract memory; STRIP it from `changes` before `malformedUserUpdate(changes)` + `deps.update` (memory isn't a user-record field). Pre-validate memory → `deps.update({username, changes})` → on success rewrite by the UPDATED record's STABLE id: `deps.rewriteBossMemoryByUserId(r.user.id, memory, author)`. Malformed → 400 invalid_memory_line + lineNumber. Memory-only update works (verified `deps.update` no-ops empty changes and returns the user).
- **IMPLEMENTED (Reviewer3 correction):** key the rewrite off `r.user.id`, NOT the request username — a rename+memory PATCH renames the record first, after which the old username no longer resolves. `rewriteBossMemoryByUserId(userId, text, author)` dep (index) = `memoryStore.rewriteFromText("boss", userId, text, author)`. The raw GET resolves username→userId only for READING (no mutation, so current username is fine).
- Raw read: `GET /api/users/:username/memory/raw` (opId memory.rawUser), `cap(["user:self","user:admin"], selfOrOwner)`. memory.ts handler: `const userId = deps.userIdForUsername(username); if (!userId) return fail(404,"user_not_found"); return ok({text: readRawText("boss", userId)})`. Add `userIdForUsername` to MemoryDeps + wire it. (Never call readRawText("boss", null) — that would read bosses/null.md.)
- UserManagementModal: add a memory textarea to the per-user edit (match the existing memberPrompt edit shape — it may edit one selected user at a time). Load raw for the edited user's username on selection/open, reset on username change, disable until loaded, include in dirty only after load, response-driven if memory included.

**Acceptance:** T1 — user raw GET (self verbatim / owner verbatim / non-self-non-owner 403 via selfOrOwner / 401); user PATCH memory writes bosses/<userId>.md (NOT username); memory-only PATCH works; update validation fail (invalid envFile) + memory present → memory untouched; malformed → 400 + lineNumber, no user-field change. build:ui. UI manual.

**Decided (all approved):** (1) boss scope, scopeId = stable userId. (2) save strips memory before malformedUserUpdate + deps.update; pre-validate → update → rewrite by `r.user.id`. (3) raw route selfOrOwner + 404 on unresolved. (4) memory-only update no-op confirmed. (5) memory textarea placed next to Profile Prompt.

## SLICE-3i PICKUP — wrap-up (after 3h3, 8ac01a8)

**State:** all behavior + all 4 curation surfaces committed and green (973 tests). 3i is the wrap-up. SPLIT into a DETERMINISTIC subset (done this slice) and a PARKED-FOR-NIL queue (his voice / his cost decisions — never decided in the loop).

**Baseline:** 8ac01a8.

**DETERMINISTIC subset (this slice — affordance + internal/engineering docs only):**

- **Affordance finalized** (server/system-prompt.ts "How to use memory"): added the operational one-liner for edit/retract (PATCH/DELETE by mem:id; scopeId required for room/agent/boss, omitted for office) + the dedup 409 behavior. no-boss-path invariant + T0 assertions stay green.
- **internal-docs/isomux-memory-design.md**: STATUS: IMPLEMENTED banner (slices 3a–3i).
- **internal-docs/testing-guide.md**: traceability-matrix row; caps are noted as a STORE/RENDER concern (read()/GET uncapped); the verbatim raw curation routes are PER-SURFACE + permission-inheriting, NOT the general permissive /api/memory.

**PARKED FOR NIL (do NOT do in the loop — these need Nil):**

- **User-facing feature copy** — `docs/features.md` (canonical inventory) and `api/chat.ts` chatbot `Full Feature List` are written in Nil's voice; `internal-docs/documentation.md` requires Nil's approval before any copy change. Draft a capability-focused memory entry (no impl mechanism) and get his sign-off before applying. README/landing: NOT headline-level for this wrap-up (Reviewer3). `AGENTS.md`: not needed (the system-prompt affordance is the agent-facing surface). Never touch `CLAUDE.md`.
- **Playwright curation smoke** — repo has NO e2e infra; building it adds a browser-test dependency. Reviewer3's call: WAIVE (rely on the strong T0/T1 coverage + manual UI verification) unless Nil explicitly approves building it as its own slice. Recorded as deferred in the testing-guide. If Nil approves: isolated temp ISOMUX_HOME (NEVER live ~/.isomux), built UI, chrome headless, assert via fresh API/file read.
- **Live manual verification** — the memory fields are committed but only render after `bun run build:ui` + `systemctl --user restart isomux` (restart interrupts every agent; Nil-gated). Offer it.

**Rails reminder:** doc-only changes still go through Reviewer3 diff-gate + one focused commit. Nil-voice copy needs Nil's approval first.
