# Server Refactor: Master Design

Status: design proposal. All design decisions are locked; this document is the single source of truth. Two artifacts are intentionally NOT in this document and will each be produced in a dedicated session: (1) the full server API spec (contract-first, done first), and (2) the ordered step-by-step implementation plan. This doc consolidates what turned out to be one architecture across three threads:

1. Client/server seam: a clean, testable core of command-semantic operations under thin transports. The office stays as the single client.
2. Full, introspectable REST API: every capability reachable via REST; WS reserved for the live event stream.
3. Testing strategy: the safety net that lets us do 1 and 2 (merged in from the former `testing-strategy.md`).

## Scope

The metaphor-agnostic genericization (rename rooms to groups, extract an `officeLayout`, split a standalone reference-client "skin", uncap room membership) is DEFERRED. There is no second client on the roadmap, so genericization was speculative. We keep the office metaphor everywhere ("room", "desk"), keep desk and layout server-stored as today, and get architectural clarity from clean module boundaries, the REST contract, and an extracted projection/ACL service, not from a vocabulary purge. The deferred pieces are tracked as a follow-up.

Memory is also out of scope. The cascade is prompt plus env only. The existing mem0 memory plugin must keep working across every phase; that is a compatibility invariant, pinned by a test.

Note on naming: earlier drafts used the labels "A1" (the centralized projection/ACL service, today implicit in the per-WebSocket fanout) and "B3" (migrating `agent.room` from a mutable array index to a stable room id). Those labels are retired in favor of "projection/ACL service" and "stable room IDs".

## The architecture (the center)

A tested core of command-semantic operations, each declaring `{ required capability, side-effects it owns, the observable signal(s) it emits and to which audience, or non-observable }`, sitting on clean primitives (rooms plus per-user ACL plus the already-clean backend seam), under thin transports (REST for commands and queries, WS for the live event stream only).

- Client/server seam: the core is cleanly separated from office presentation; the office remains the single client.
- Full REST API: a thin REST transport over the core; WS shrinks to the live event stream.
- Testing: characterize the core first (the safety net), then TDD the new core and transports.

The first implementation deliverable is the full API spec (contract-first), not endpoints.

## Decided

### Scope, cascade, prompt

- Office metaphor stays; genericization, skin, and memory are deferred (see Scope).
- Hierarchy is fixed levels office (global) then room then agent, plus an orthogonal per-user ownership axis: the owning user's `memberPrompt` and a manager-identity section, keyed by user, not by the containment tree.
- `buildSystemPrompt` stays as the current explicit concatenation (baseline, then manager-identity plus `memberPrompt`, then office, then room, then agent). No generic N-source fold: its only motivation was a group layer and a memory axis, both gone. Desk vocabulary does not appear in the prompt builder today and stays out.
- The cascade is prompt plus env only. Env keeps its existing single fold (`buildEnvForUserId`: process.env, then office env file, then user env file, user wins). Memory is out; mem0 plugin compatibility is an invariant with a test.

### Identity, auth, capabilities

- Per-agent bearer tokens, separate from user tokens, with no owner inheritance (no confused deputy). A token resolves to an identity: agent-scope tokens carry `{ agentId, userId, scope: "agent" }`; user tokens carry the user identity and role. Authorization uses that identity's capabilities. An external client is browser-equivalent for whatever identity its token carries; there is no separate narrow automation tier, because the narrowness comes from the agent identity being narrow.
- Two capability scopes, by identity. A USER token is browser-equivalent (everything that user can do in the UI). An AGENT token is exactly today's loopback surface and no more: agent-to-agent message as itself, task create/claim/update, and the self affordances (read-file, diff, edit-file, terminal-command) on its own chat. It cannot spawn or kill, touch room/user/office settings, mint invites, or mutate cronjobs. Tokens carry an explicit capability set so it can grow additively later (capability-lattice expansion is a follow-up).
- Token delivery: agent tokens are delivered via env (`ISOMUX_AGENT_TOKEN`), reusing the existing per-agent env-injection path. Not prompts, not a signing helper.
- Zero-setup local dev is non-negotiable and preserved. Humans claim owner tokenlessly and get a cookie; agents receive their token automatically via env injection (no minting). If Claude Code or Codex work locally, isomux works locally with no setup. The documented agent curl snippets gain an `Authorization: Bearer $ISOMUX_AGENT_TOKEN` header, which resolves from the agent's own shell env.
- No loopback bypass: reads and writes both require identity (cookie or token). This closes the concrete vulnerability that `senderAgentId` on `POST /agents/:id/message` is today unauthenticated and spoofable by anything on loopback, including any agent (an agent can run curl). The message endpoint enforces `token.agentId === senderAgentId`. Server-internal calls use direct function calls, not unauthenticated localhost HTTP.
- Token lifecycle and secrecy: agent tokens are high-entropy opaque secrets; only a hash or token id is persisted, never the raw token. They are generated and rotated on spawn/revive, and revoked on kill/delete (and on session retirement where applicable). They are never sent over WS, and never appear in prompts, log entries, errors, or diffs. Redaction is covered by tests.

### Attribution (tasks)

- `createdBy` is derived from the token (the caller's display identity: agent name, or the human's name on a user token); not the request body.
- The owning-user attribution (`username`) is derived from the token's `userId`; not the body, so the boss cannot be spoofed.
- `assignee` comes from the body (free choice); assignment is a label that grants and uses no authority.
- None of this requires elevated privilege; the caller only names itself.

### ACL and visibility

- Rule-based owner visibility (owners see all rooms, computed) plus explicit grants for member access. This removes the `create_room` owner fan-out (today every room creation appends the new roomId to every owner's `allowedRooms` and `notifRooms`).
- Split "access" (rule or grant; security) from "view preference" (which accessible rooms I am showing and in what order; non-security; server-stored, syncs across devices).
- Per-user room ORDER folds into view-preference. Reordering touches only your own preference: no global `_rooms` mutation, no agent renumbering, no `rooms_reordered` broadcast. It is always allowed (you are editing your own view), so the current `if (!sessionHasFullRoomAccess) break` gate on `reorder_rooms` is deleted. This is a deliberate behavior change (today's global, owner-only reorder becomes per-user, always allowed): characterize the old behavior, then replace it.
- Default ordering: one canonical creation-order sequence is the default; new rooms append at the end of each user's order; a brand-new user defaults to creation order; users reorder freely.
- `notifRooms` is a subset of shown, which is a subset of accessible. You can never be pinged by a room you cannot see or cannot access. `notifRooms` stays an editable subset of your shown rooms (preserving "visible but silent"). Revoking access or hiding a room auto-drops it from `notifRooms`. `notifRooms` stops being auto-synced on room creation (that sync only fed the materialized owner visibility being deleted).
- Migration: members' `allowedRooms` migrate to access grants verbatim; owners drop `allowedRooms` as an access input (rule equals all) and seed their view-preference from their current `allowedRooms` so no view shifts on upgrade.
- `defaultRoomId` is a view preference (the user's default landing and spawn-view room). It must be accessible and shown, and is clamped on access revoke or room hide, like `notifRooms`. All preference writes (view-preference, order, `notifRooms`, `defaultRoomId`) must not leak hidden-room existence: inaccessible or unknown room ids are ignored or rejected with a generic response, never a specific exists-but-hidden error.

### State model: stable room IDs

- Replace the mutable `agent.room` array index with a stable room id. This removes the agent-record renumbering that `closeRoom`/`reorderRooms` do today (rewriting every agent's index).
- Persistence: flatten so each `PersistedAgent` carries an explicit stable `roomId` (matching the in-memory and wire shape, removing the on-load derive step). Migration is small because user references (`allowedRooms`/`notifRooms`/`defaultRoomId`) are already id-based.
- Wire: move off dense per-recipient numeric room indices to id-keyed maps. This is the one client-coordinated breaking change. Since we own the only client, ship server and UI in one coordinated deploy (a single restart), with no dual-shape compatibility shim. The coordinated UI change includes client/device-state migration: existing local/device state that references numeric `agent.room` (selected/default/notif rooms, UI references) is discarded or safely remapped, so stale numeric room values cannot produce broken or misleading UI.

### Transport, contract, events

- Full REST: all commands and queries become REST. WS is reserved for the live event stream (log, thinking, tool, approval, terminal IO, presence) and the interactive terminal only.
- Contract-first, enforced by code: a single typed route table where each route declares `{ method, path, requiredCapability, resourceGuard, requestSchema, responseSchema, emits }`. Authorization is two-stage and both stages are declared, not hand-written in handlers: (1) the dispatcher checks the coarse `requiredCapability` from the token before the handler runs; (2) a declared `resourceGuard` expresses object-level authorization, subject binding, and ACL policy, enforced centrally or by the core op. Guards are named, reusable policies such as `agentParamMustEqualTokenAgent`, `requiresRoomAccess(agentId)`, `cronjobOwnerOrOfficeOwner`, and `selfOrOwner`, each backed by contract tests. This keeps both coarse and object-level authz out of handler bodies (no scattered checks like the `reorder_rooms` gate). Handlers are typed against their schemas (a mismatch fails to compile). The route table REPLACES the roughly 949-line `dispatchCommand` switch (one source of truth, no parallel switch). The API spec doc stays in lockstep with this table.
- Core ops at the command-semantic level (`createRoom`/`closeRoom`/`updateUser` allowedRooms, and so on) own their compound side effects.
- WS-command strangler: expand (the REST endpoint and the still-living WS command both delegate to ONE shared core op; the WS handler becomes a thin shim, so there is no behavior-drift window), then migrate the UI to REST, then contract (delete the WS command and its bespoke response, such as `settings_save_response`, `cwd_validation`, `agent_save_response`).
- One wire stream, plural audiences. The wire is already one WebSocket per client. Audience is a declared, first-class attribute of each event TYPE, held in a single typed event registry (each event type declares its audience strategy, one of `all`, `owners`, `room-ACL`, `recipient-scoped`, `by-user`, `none`, plus its projection function). This is event-level, not merely route metadata, because many sensitive events have no owning HTTP route: backend stream events, terminal IO, presence, scheduler-fired cronjob events, auth expiry/revocation, and subprocess lifecycle. Route `emits` references event ids in that registry. A single emit helper is the only path to the wire, and contract tests enumerate the event union, assert each type's audience, and forbid raw `ws.send`/`broadcast` outside the dispatcher. `all` is classified as rare and explicitly reviewed (it is the easiest leak class). A single dispatcher applies the matching fan-out from the declaration; the fan-out strategies stay plural because they encode real security contracts. Concretely, `session_revoked` and `invite_revoked` carry owner-only token prefixes, usernames, expiry, and user-agent strings and must go owners-only (a plain broadcast would leak them); cronjob events are office-wide; agent and room events are room-ACL projected; invites/sessions lists are recipient-scoped (owner sees all, member sees own). This removes the former auth-events special-case (they become `audience: owners`) and folds non-observable into `audience: none`. Every externally-visible mutation declares its audience; the contract test asserts it.
- Double-signal: HTTP is the per-caller outcome; the WS broadcast is shared state. The UI is echo-authoritative: it applies state from the broadcast and uses HTTP only for ack, error, ids, and navigation. Combined with id-keyed entity state, this neutralizes the event-before-response race without per-event op-ids (the HTTP response is the caller's outcome signal). Note: this double-signal already exists today for the loopback HTTP endpoints such as `POST /agents/:id/message`; the refactor generalizes it to every mutation.
- Idempotency is centralized at the transport layer, not per-endpoint. A mutating POST may carry an `Idempotency-Key`; central middleware keys the cache by `(identity, method, route, key)` and stores a request-body hash, with a short in-memory TTL. A repeat with the same key and a matching request replays the cached response; the same key with a different body returns a conflict, so a key reused across endpoints or with a changed body cannot replay the wrong response. The key is optional per request (present means retry-protected), so agents and curl are not forced to send one. Today's `clientMessageId` unifies into this.
- Ordering: the client awaits dependent calls (no server sequence numbers). Trichotomy: independent calls run concurrent; dependent-sequential calls await; dependent-atomic calls become one compound endpoint.

### Tasks and cronjobs

- Tasks stay a global shared board, token-authed, with attribution derived from the token as described above and `assignee` from the body.
- Cronjobs are owned by their creator and run with the creator's env. Edit, delete, and run-now are restricted to the owner-user plus office owners. Cronjob metadata is office-wide read. Run-transcript exposure to human users is an accepted known leak for now (transcripts can contain the creator's secrets; restricting transcript reads to the owner-user plus office owners is a follow-up). Two rails hold now, with contract tests: AGENT tokens cannot read cronjob transcripts (transcript reads are not in the agent capability set), and the new REST surface grants user tokens no broader transcript access than today's browser.

### Dependency injection and module shape

- Full DI for testability. Convert `agent-manager.ts` and `cronjob-manager.ts` from singleton function-modules (module-level `eventHandler`/`officeState`, exported functions) into instantiable units. Inject all three collaborators at construction via a `ManagerDeps` bundle: the backend resolver, the event sink (today the global `onEvent`/`eventHandler` setter), and the `officeState` instance. A production factory wires today's defaults; the manager instance owns its deps (do not thread deps through every function). This gives true test isolation and lets the projection/ACL harness observe emitted events deterministically without racing a module-global. The backend seam (`getBackend`, roughly 19 call sites) flows through the injected resolver, making `FakeBackend` injectable into both managers.

### Infrastructure prereq: configurable state root

- Persistence is homedir-hardcoded (`~/.isomux`) across roughly 20 files and 79 references with no config-root abstraction. Introduce a single config module for the state root (an `ISOMUX_HOME`-style override). Default to `~/.isomux` so production behavior is byte-for-byte unchanged; tests redirect to a temp dir. A cleanup guard refuses destructive cleanup unless the target realpath-resolves under the OS temp dir (symlink-safe) and always refuses the real `~/.isomux`. This ships as its own standalone, independently-tested commit.

## Review gates

These are gates, not open decisions:

- A Reviewer4 security pass on the final token/auth design and on the audience declarations (a mis-declared audience is a leak) before implementation.
- A focused security review of the rule-based ACL during implementation (a mistake there is a security hole, not a bug).
- A holistic Reviewer1 review of this document before approval.

## Testing strategy

### Why now

The two deepest pieces of this refactor are the projection/ACL service (today the per-session ACL projection lives implicitly in the per-WebSocket fanout) and stable room IDs (migrating `agent.room` from a mutable array index to a stable id). Both are cross-cutting and invariant-heavy, so we want a behavioral safety net in place before touching them. isomux currently has tests only at the Claude backend adapter seam (`claude.test.ts`, `claude.session.test.ts`, `claude.v1-adapter.test.ts`, `plugin-hooks.test.ts`); the orchestrator, OfficeState, persistence, projection, and the WS/REST surface are untested.

### Principles

1. Test behavior through public interfaces, not implementation. Tests must survive the refactor, so they assert observable behavior at public boundaries (WS messages, REST responses, persisted files), never private internals.
2. Two modes, two jobs. Characterization tests for the existing server freeze its current externally visible behavior (the refactor safety net; writing imagined behavior is wrong here). TDD red-green-refactor for the new code the refactor introduces (projection service, REST contract, token auth, stable room IDs).
3. README as a coverage map, not a mandate. Goal: every README feature has at least one behavioral test of its critical mechanism at the lowest deterministic tier, prioritizing refactor-adjacent features. Tracked via the traceability matrix.
4. Avoid horizontal slicing. Do not write all tests up front against speculation. Characterization tests are grounded by observation; new-code tests follow red-green-refactor.

### LLM-call policy (test tiers)

Default `bun test` (CI, PR, pre-commit) makes zero LLM calls.

| Tier | LLM? | What | When |
|---|---|---|---|
| T0 pure/unit | none | pure functions: prompt assembly, diff summary, fork-chain assembly, usage math, projection helpers | always |
| T1 integration (FakeBackend + non-backend harnesses) | none | the main tier: orchestrator/queue/fork/persistence/OfficeState, plus auth/projection/presence/route harnesses; real temp FS, in-process server | always |
| T2 adapter contract | none (replay) | real Claude/Codex adapters translate recorded/curated event streams correctly | always; refresh on SDK bumps |
| T3 live smoke | yes, a few | real-subscription end-to-end; assert invariants only (turn completes, a tool runs, resume works, topic non-empty and at most 8 words), never exact text | opt-in only |

T3 is gated behind an env flag plus a separate `test:live` script, run manually or nightly, serial, on cheap models. Never in CI or pre-commit.

### Test seams

`FakeBackend` (implements the `Backend` interface, scripts `NormalizedEvent`s) is the main deterministic engine for T1, because the Backend seam is already clean and metaphor-free and the projection/stable-id work sits above it. It is injected via the `ManagerDeps` DI described in Decided. It is not the only seam; the following surfaces are not below Backend and need focused harnesses:

- Auth/session/invite/token: cookie auth, token auth, owner/member roles, origin/CSRF where practical, session revocation, the now-removed loopback bypass. Token lifecycle (generate/rotate on spawn/revive, revoke on kill/delete) and redaction (the token never appears in prompts, logs, errors, diffs, or over WS). Object-level guards (`agentParamMustEqualTokenAgent`, `requiresRoomAccess`, `cronjobOwnerOrOfficeOwner`, `selfOrOwner`). AGENT tokens cannot read cronjob transcripts.
- Projection/fanout: multi-WebSocket tests with different users and access grants, not a single in-process client. The event registry: every event type has a declared audience and projection, a single emit helper is the only wire path, and no raw `ws.send`/`broadcast` exists outside the dispatcher. Preference writes (view-preference/order/notifRooms/defaultRoomId) never leak hidden-room existence.
- Presence: its own `connectionId` map and recipient-specific room remapping.
- Terminal/PTY: narrow fake/stubbed terminal-deps test for routing/ACL; real PTY only opt-in/local.
- Editor/file/upload/read-file/diff affordances: HTTP routes plus FS helpers; test visibility/auth and path safety explicitly.
- Cronjobs: own manager/persistence/transcript/manual-run/edit surface; `FakeBackend` injected via the same `ManagerDeps` DI.
- Safety hooks / plugin hooks / env loading: pre/post orchestration and prompt/env assembly. Includes a mem0-plugin compatibility test pinning that plugin pre/post hooks fire and their injected content reaches the prompt.
- Codex App Server subprocess lifecycle: adapter contract plus opt-in live/subprocess smoke, not part of the main net.

### Infrastructure prerequisites

1. Configurable state root, plus a cleanup guard (see Decided: Infrastructure prereq). Do this carefully or tests will mix real `~/.isomux` state with temp state.
2. `ManagerDeps` DI so `FakeBackend`, the event sink, and `officeState` are injectable into both `AgentManager` and `CronjobManager`. The entire T1 tier depends on this.
3. An in-process server harness that can connect multiple authenticated users/sockets against temp state.
4. `package.json` scripts: `test` (no LLM) versus `test:live` (gated).

### Flagship test: onboarding / fresh install

The highest-priority characterization-plus-TDD target, sequenced right after config-root and DI land. On a fresh install the welcome agents must spawn correctly across the three backend-availability states:

- Fresh-install T1: empty temp `ISOMUX_HOME`, boot, assert the welcome-agent seed (one Opus, one Codex) is created and spawn is attempted.
- Backend not installed: binary missing, the agent surfaces "backend not configured", no crash.
- Backend installed but not logged in: `detectAuthError` fires, the "needs sign-in" state and login instructions surface.
- Backend logged in: normal events, the welcome agent completes its first turn.
- Optional opt-in T3 live smoke for the real logged-in happy path.

### Projection / ACL characterization checklist (capture before stable room IDs)

This is the highest-value net for both the projection/ACL service and stable room IDs. Freeze current behavior for:

- Two users with overlapping but non-identical access connect simultaneously; `full_state` rooms are filtered and `agent.room` is dense per recipient.
- A hidden-room agent emits `log_entry`/`slash_commands`/`terminal_output`/session list; the restricted user never receives it.
- Moving an agent visible-to-hidden, hidden-to-visible, visible-to-visible triggers the right refresh/replay and no stale transcript loss.
- Room close/reorder with restricted users: dense indices remap, visible agents stay correct, presence is rebroadcast, logs/slash commands replay where expected. (Reorder behavior is changing to per-user; characterize the old global behavior first, then replace.)
- Owner with hidden rooms: main view respects access, owner-only `all_rooms_list` stays unfiltered. (Owner visibility becomes rule-based; this confirms the materialized-to-computed migration preserves behavior.)
- `create_room` under the new model: the creator sees it, owners see it by rule (no fan-out), other members do not until granted.
- `update_user` allowedRooms by an owner pushes a projected `full_state` to that user's existing sockets and clamps presence if access was revoked.
- Killed-agent summaries are filtered by `lastRoomId` before the cap; revive requires access to both the target room and `lastRoomId`.
- `list_sessions`/load logs for hidden agents do not leak ids/topics/timestamps.
- `presence_update` from a restricted user uses that user's dense visible index, stores the global `roomId`, and emits recipient-specific indices.
- Agent-to-agent `POST /agents/:id/message` identity lookup does not become a room/ACL leak when one agent is in a hidden room.

### Persistence and migration tests

- Round-trip: write then load agents/users/tasks/cronjobs; assert shape and field preservation.
- Existing load-time migrations (for example `modelFamily`/`agentType` backfill, per-room envFile strip).
- Stable-room-IDs migration: today `agents.json` nests `PersistedAgent`s under rooms and `agent.room` is derived on load, not persisted. The new shape flattens so each agent carries an explicit stable `roomId`. Seed pre-migration persisted state with room ids referenced in users (`allowedRooms`/`notifRooms`/`defaultRoomId`) and killed-agent summaries; assert the post-migration flattened shape. Migration bugs are likely and expensive.

### API contract tests before implementation

The full API spec (a separate deliverable, written first) is the contract: every resource, its method, its required capability, its request/response shape, and the audience of any event it emits. Tests are TDD'd against that spec, and the typed route table enforces it in code (validation plus types). This doubles as the refactor's contract-first deliverable.

### Test-net build order (dependencies, not the implementation plan)

These are ordering constraints for standing up the test net, not the overall implementation plan (that is a separate deliverable):

1. Configurable state root plus cleanup guard.
2. `ManagerDeps` DI (FakeBackend, event sink, officeState) into `AgentManager` and `CronjobManager`.
3. In-process server harness with multiple authenticated users/sockets and temp state.
4. Flagship onboarding/fresh-install test.
5. Projection/ACL characterization (highest-value net).
6. Persistence/migration characterization.
7. Queue/resume/fork/usage tests.
8. Route-level tests for tasks/cronjobs/uploads/settings/recentCwds/auth policy.
9. Adapter fixtures (hand-curated, minimized), then opt-in live smoke. Build a recorder only when fixture refresh becomes painful.

UI E2E (Playwright) stays thin: browser connects, renders projected state, performs a core command. The server harness carries the combinatorics.

### Resolved policy edge (loopback affordances)

Today's loopback affordance endpoints (agent-to-agent `/message`, `/diff`, `/read-file`, `/edit-file`, `/terminal-command`) are trusted local IPC. Resolution: there is no loopback bypass in the end state. These endpoints become part of the authenticated surface; agents authenticate with their auto-injected `ISOMUX_AGENT_TOKEN` (zero setup), and the message endpoint enforces `token.agentId === senderAgentId`. Tests cover that an unauthenticated loopback request is rejected and that a token-authed agent cannot spoof another agent's identity.

### Traceability matrix (seed)

Columns: README claim, risk tier, deterministic test path, live/manual coverage.

| README claim | tier | deterministic test path | live/manual |
|---|---|---|---|
| Onboarding / fresh install (welcome agents spawn across not-installed / not-logged-in / logged-in) | T1 (+opt-in T3) | fresh-install harness: temp ISOMUX_HOME, welcome-agent seed, FakeBackend per backend state | T3 live logged-in happy path |
| Multi-provider (mix Claude + Codex) | T2/T3 | adapter contract fixtures per backend | T3 smoke per provider |
| Subscription auth (works if CLI works) | T3 | env-detect unit; login-instructions unit | T3 manual login |
| Agents message each other (queue) | T1 | FakeBackend: POST /message enqueues; coalescing order | - |
| Shared task board | T1 | route + OfficeState task CRUD; attribution from token | - |
| Hierarchical system prompts | T0 | prompt assembly office/room/agent layering | - |
| Custom commands | T1 | slash_commands surfaced to client | - |
| Collaborate in conversations (multi-user) | T1 | multi-socket mixed human/agent queue | - |
| Live presence (ghosts) | T1 | presence harness: connectionId map, recipient indices | - |
| Invite-link access | T1 | auth harness: mint/accept/consume/expire | - |
| Self-hosted reachable / real-time | T1 | full_state on connect + delta sync | - |
| Mobile UI | manual | - | visual |
| Visual office / animated characters / skeuomorphic / themes | manual | - | visual |
| Auto-generated topic | T1/T3 | endpoint returns non-empty, at most 8 words (mechanism) | T3 quality spot-check |
| Terminal | T1 | routing/ACL with stubbed PTY | opt-in real PTY |
| Editor | T1 | editor_open/save/external-change routes + path safety | - |
| Diff tool | T0/T1 | diff summary unit + POST /diff route | - |
| Voice-to-text / TTS | manual | - | browser manual |
| Cron jobs | T1 | CronjobManager + FakeBackend: schedule/fire/run transcript/manual-run | - |
| Image/PDF attachments | T0/T1 | buildUserMessage attachment inlining (exists: `server/backends/claude.ts`) + upload route | - |
| Conversation branching | T1 | fork-chain assembly + usage accounting | - |
| Notifications | T1 | turnHadHumanInput gating (mechanism) | - |
| Pre-tool-call safety hooks | T0/T1 | hook blocks dangerous commands | - |
| Plugin system (incl. mem0 memory) | T1 | plugin pre/post turn hooks; mem0 injected content reaches the prompt | - |

## Implementation deliverables (not sequenced here)

The detailed ordered step-by-step plan and the full server API spec are SEPARATE deliverables, each produced in its own dedicated session. Two fixed points:

- Contract-first: the full API spec is the first deliverable. Write it and iron it out before transport implementation.
- Config-root ships first as a standalone, independently-tested improvement (it unblocks the test net and has zero production behavior change).

Major workstreams (unordered; to be sequenced in the planning session): config-root plus cleanup guard; full DI (`ManagerDeps`) plus FakeBackend injection; in-process multi-user/multi-socket harness; flagship onboarding test; projection/ACL plus persistence/migration characterization; the API spec plus contract tests; REST transport via the typed route table (strangler per command); rule-based ACL plus view-preference (including per-user room order) plus notifRooms; stable room IDs plus id-keyed wire (one coordinated deploy); audience-declared one-stream events; centralized idempotency.

## Follow-ups (to file at the end of the planning session)

1. Skin / metaphor-agnostic core (existing task f48a9d52): the room-to-group rename, `officeLayout` extraction, desk-as-skin, uncapping the 8-per-room limit, and the reference-client skin. Revisit when a second client is real.
2. Capability-lattice expansion: grow the agent token's capability set additively as agent permissions broaden.
3. Cronjob run-transcript visibility: restrict transcript reads to the owner-user plus office owners (metadata stays office-wide read). Until then it is an accepted known leak, held in check by the agent-token and no-broader-than-browser rails noted in Decided.
4. Feature-plugin architecture: features own their REST endpoints and their agent-facing prompt snippet; the core stays agnostic; the office composes them. This removes the manual sync between feature behavior and the "How to..." prompt sections. The typed route table is its foundation; the cheap now-step is grouping routes into feature modules so prompt docs can later attach to a feature rather than to each route.
