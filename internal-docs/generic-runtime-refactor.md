# Server Refactor: Master Design

Status: ready to implement. All design decisions are locked; this document is the single source of truth. The full server API spec (contract-first) is captured below as the **Server API Spec** section, and the ordered, phased plan that sequences it into implementation is captured in the **Implementation plan** section. This doc consolidates what turned out to be one architecture across three threads:

1. Client/server seam: a clean, testable core of command-semantic operations under thin transports. The office stays as the single client.
2. Full, introspectable REST API: every capability reachable via REST; WS reserved for the live event stream.
3. Testing strategy: the safety net that lets us do 1 and 2.

## The architecture (the center)

A tested core of command-semantic operations, each declaring `{ required capability, side-effects it owns, the observable signal(s) it emits and to which audience, or non-observable }`, sitting on clean primitives (rooms plus per-user ACL plus the already-clean backend seam), under thin transports (REST for commands and queries, WS for the live event stream only).

- Client/server seam: the core is cleanly separated from office presentation; the office remains the single client.
- Full REST API: a thin REST transport over the core; WS shrinks to the live event stream.
- Testing: characterize the core first (the safety net), then TDD the new core and transports.

The first deliverable was the full API spec (contract-first), not endpoints; implementation then follows the phased **Implementation plan** below.

## Decided

### Scope, prompt, and env

- Office metaphor stays; genericization and skin are deferred (Follow-up 1); memory is out of scope.
- Hierarchy is fixed levels office (global) then room then agent, plus an orthogonal per-user ownership axis: the owning user's `memberPrompt` and a manager-identity section, keyed by user, not by the containment tree.
- `buildSystemPrompt` stays as the current explicit concatenation (baseline, then manager-identity plus `memberPrompt`, then office, then room, then agent). No generic N-source fold: its only motivation was a group layer and a memory axis, both gone. Desk vocabulary does not appear in the prompt builder today and stays out.
- Prompt and env are an agent's only layered, multi-source inputs: the prompt per the hierarchy above, and env via the existing single fold (`buildEnvForUserId`: process.env, then office env file, then user env file, user wins). There is no memory layer; the existing mem0 plugin must keep working (a compatibility invariant, pinned by a test).

### Identity, auth, capabilities

- Per-agent bearer tokens, separate from user tokens, with no owner inheritance (no confused deputy). A token resolves to an identity: agent-scope tokens carry `{ agentId, userId, scope: "agent" }`; user tokens carry the user identity and role. Authorization uses that identity's capabilities. An external client is browser-equivalent for whatever identity its token carries; there is no separate narrow automation tier, because the narrowness comes from the agent identity being narrow.
- Three capability scopes, by identity. A USER token is browser-equivalent (everything that user can do in the UI). An AGENT token is exactly today's loopback surface and no more: agent-to-agent message as itself, task create/claim/update, and the self affordances (read-file, diff, edit-file, terminal-command) on its own chat. It cannot spawn or kill, touch room/user/office settings, mint invites, or mutate cronjobs. A RUN token is the cron-run analogue of an agent token: minted per cronjob run (rotated per run, revoked when the run ends) and carrying only the self affordances bound to its `{ cronjobId, runId }`, so a fresh cron run's in-flight read-file/diff authenticates as the run rather than relying on a loopback bypass. Tokens carry an explicit capability set so it can grow additively later (capability-lattice expansion is a follow-up).
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

- Rule-based owner access (owners have access to all rooms, computed) plus explicit grants for member access. Access is the security input only, not forced visibility: owners can still hide rooms from their own view via view-preference, like anyone else. This removes the `create_room` owner fan-out (today every room creation appends the new roomId to every owner's `allowedRooms` and `notifRooms`).
- Split "access" (rule or grant; security) from "view preference" (which accessible rooms I am showing and in what order; non-security; server-stored, syncs across devices).
- Per-user room ORDER folds into view-preference. Reordering touches only your own preference: no global `_rooms` mutation, no agent renumbering, no `rooms_reordered` broadcast. It is always allowed (you are editing your own view), so the current `if (!sessionHasFullRoomAccess) break` gate on `reorder_rooms` is deleted. This is a deliberate behavior change (today's global, owner-only reorder becomes per-user, always allowed): characterize the old behavior, then replace it.
- Default ordering: one canonical creation-order sequence is the default; new rooms append at the end of each user's order; a brand-new user defaults to creation order; users reorder freely.
- `notifRooms` is a subset of shown, which is a subset of accessible. You can never be pinged by a room you cannot see or cannot access. `notifRooms` stays an editable subset of your shown rooms (preserving "visible but silent"). Revoking access or hiding a room auto-drops it from `notifRooms`. `notifRooms` stops being auto-synced on room creation (that sync only fed the materialized owner access being deleted).
- Migration: members' `allowedRooms` migrate to access grants verbatim; owners drop `allowedRooms` as an access input (rule equals all) and seed their view-preference from their current `allowedRooms` so no view shifts on upgrade.
- `defaultRoomId` is a view preference (the user's default landing and spawn-view room). It must be accessible and shown, and is clamped on access revoke or room hide, like `notifRooms`. All preference writes (view-preference, order, `notifRooms`, `defaultRoomId`) must not leak hidden-room existence: inaccessible or unknown room ids are ignored or rejected with a generic response, never a specific exists-but-hidden error.

### State model: stable room IDs

- Replace the mutable `agent.room` array index with a stable room id. This removes the agent-record renumbering that `closeRoom`/`reorderRooms` do today (rewriting every agent's index).
- Persistence: flatten so each `PersistedAgent` carries an explicit stable `roomId` (matching the in-memory and wire shape, removing the on-load derive step). Migration is small because user references (`allowedRooms`/`notifRooms`/`defaultRoomId`) are already id-based.
- Wire: move off dense per-recipient numeric room indices to id-keyed maps. This is the one client-coordinated breaking change. We own the clients, so ship server, the production UI, and the `demo-server`/demo client (a second consumer of the numeric room wire) in one coordinated deploy (a single restart), with no dual-shape compatibility shim. The coordinated UI change converts every `agent.room` consumer to `roomId` and resets/remaps the in-memory room selection (`currentRoom`). Durable device prefs (`defaultRoomId`/`notifRooms`) are already id-based and need no migration, so the only numeric room state to clear is the in-memory selection index; stale numeric room values cannot produce broken or misleading UI.

### Transport, contract, events

- Full REST: all commands and queries become REST. WS is reserved for the live event stream (log, thinking, tool, approval, terminal IO, presence) and the interactive terminal only.
- Contract-first, enforced by code: a single typed route table where each route declares `{ method, path, requiredCapability, resourceGuard, requestSchema, responseSchema, emits }`. Authorization is two-stage and both stages are declared, not hand-written in handlers: (1) the dispatcher checks the coarse `requiredCapability` from the token before the handler runs; (2) a declared `resourceGuard` expresses object-level authorization, subject binding, and ACL policy, enforced centrally or by the core op. Guards are named, reusable policies such as `agentParamMustEqualTokenAgent`, `requiresRoomAccess(agentId)`, `cronjobOwnerOrOfficeOwner`, and `selfOrOwner`, each backed by contract tests. This keeps both coarse and object-level authz out of handler bodies (no scattered checks like the `reorder_rooms` gate). Handlers are typed against their schemas (a mismatch fails to compile). The route table REPLACES the roughly 1,940-line `dispatchCommand` switch (one source of truth, no parallel switch). The API spec doc stays in lockstep with this table.
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

- Full DI for testability. Convert `agent-manager.ts` and `cronjob-manager.ts` from singleton function-modules (module-level `eventHandler`/`officeState`, exported functions) into instantiable units whose collaborators are injected at construction (a production factory wires today's defaults; the instance owns its deps, so they are not threaded through every function). `AgentManager` takes a `ManagerDeps` bundle: the backend resolver, the event sink (today the global `onEvent`/`eventHandler` setter), and the `officeState` instance. `CronjobManager` does not own `officeState`, so it takes a smaller `CronjobManagerDeps`. That smaller bundle must still inject every collaborator it actually uses (the backend resolver, its own event sink, env/user resolution, run persistence, and a clock/scheduler seam for deterministic schedule-firing tests); a smaller bundle is not a license to keep reading users, env, or time through module globals. This gives true test isolation and lets the projection/ACL harness observe emitted events deterministically without racing a module-global. The backend seam (`getBackend`, ~16 invocations) flows through the injected resolver, making `FakeBackend` injectable into both managers.

### Infrastructure prereq: configurable state root

- Persistence is homedir-hardcoded (`~/.isomux`) across ~15 state-path sites in ~13 modules (each inlining its own `ISOMUX_DIR`), with no config-root abstraction. Introduce a single config module for the state root (an `ISOMUX_HOME`-style override). Default to `~/.isomux` so production behavior is byte-for-byte unchanged; tests redirect to a temp dir. A cleanup guard refuses destructive cleanup unless the target realpath-resolves under the OS temp dir (symlink-safe) and always refuses the real `~/.isomux`. This ships as its own standalone, independently-tested commit.

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

`FakeBackend` (implements the `Backend` interface, scripts `NormalizedEvent`s) is the main deterministic engine for T1, because the Backend seam is already clean and metaphor-free and the projection/stable-id work sits above it. It is injected through the constructor DI described in Decided (`ManagerDeps` into `AgentManager`, `CronjobManagerDeps` into `CronjobManager`). It is not the only seam; the following surfaces are not below Backend and need focused harnesses:

- Auth/session/invite/token: cookie auth, token auth, owner/member roles, origin/CSRF where practical, session revocation, the now-removed loopback bypass. Token lifecycle (generate/rotate on spawn/revive, revoke on kill/delete) and redaction (the token never appears in prompts, logs, errors, diffs, or over WS). Object-level guards (`agentParamMustEqualTokenAgent`, `requiresRoomAccess`, `cronjobOwnerOrOfficeOwner`, `selfOrOwner`). AGENT tokens cannot read cronjob transcripts.
- Projection/fanout: multi-WebSocket tests with different users and access grants, not a single in-process client. The event registry: every event type has a declared audience and projection, a single emit helper is the only wire path, and no raw `ws.send`/`broadcast` exists outside the dispatcher. Preference writes (view-preference/order/notifRooms/defaultRoomId) never leak hidden-room existence.
- Presence: its own `connectionId` map and recipient-specific room remapping.
- Terminal/PTY: narrow fake/stubbed terminal-deps test for routing/ACL; real PTY only opt-in/local.
- Editor/file/upload/read-file/diff affordances: HTTP routes plus FS helpers; test visibility/auth and path safety explicitly.
- Cronjobs: own manager/persistence/transcript/manual-run/edit surface; `FakeBackend` injected via `CronjobManager`'s own `CronjobManagerDeps` (backend resolver, event sink, env/user resolution, run persistence, clock/scheduler seam).
- Safety hooks / plugin hooks / env loading: pre/post orchestration and prompt/env assembly. Includes a mem0-plugin compatibility test pinning that plugin pre/post hooks fire and their injected content reaches the prompt.
- Codex App Server subprocess lifecycle: adapter contract plus opt-in live/subprocess smoke, not part of the main net.

### Infrastructure prerequisites

1. Configurable state root, plus a cleanup guard (see Decided: Infrastructure prereq). Do this carefully or tests will mix real `~/.isomux` state with temp state.
2. Constructor DI so `FakeBackend`, the event sink, and collaborators are injectable: `ManagerDeps` (backend resolver, event sink, `officeState`) into `AgentManager`, and `CronjobManagerDeps` (backend resolver, event sink, env/user resolution, run persistence, clock/scheduler seam; no `officeState`) into `CronjobManager`. The entire T1 tier depends on this.
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
- Owner with hidden rooms: main view respects access, owner-only `all_rooms_list` stays unfiltered. (Owner access becomes rule-based; this confirms the materialized-to-computed migration preserves behavior.)
- `create_room` under the new model: the creator has access, owners have access by rule (no fan-out), other members do not until granted.
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

The full API spec (the first deliverable, captured below in the **Server API Spec** section) is the contract: every resource, its method, its required capability, its request/response shape, and the audience of any event it emits. Tests are TDD'd against that spec, and the typed route table enforces it in code (validation plus types). This doubles as the refactor's contract-first deliverable.

### Test-net build order (dependencies, not the implementation plan)

These are ordering constraints for standing up the test net, not the overall implementation plan (that is the **Implementation plan** section below):

1. Configurable state root plus cleanup guard.
2. Constructor DI: `ManagerDeps` (FakeBackend, event sink, officeState) into `AgentManager`, and `CronjobManagerDeps` (FakeBackend, event sink, env/user resolution, run persistence, clock/scheduler seam) into `CronjobManager`.
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

## Server API Spec

The typed route table plus the event registry that together replace the ~1,940-line `dispatchCommand` switch and the ad-hoc HTTP handlers. Everything here is enforced in code (a route declares `{ opId, method, path, requiredCapability, resourceGuard, requestSchema, responseSchema, emits }`; an event declares `{ id, audience, projectionKey, payload }`) and pinned by contract tests. The spec and the table stay in lockstep: a route whose `emits` references an event id not in the registry, or a handler whose types do not match its schemas, fails to compile or fails a contract test.

It is a contract, not an implementation plan: it says what each surface is, who may call it, what it returns, and what it emits — not the order in which to build it (that is the **Implementation plan** section below).

### Conventions

- **Transport rule.** Persistent mutations and request/response queries are REST under `/api`. Live, interactive, or ephemeral transport messages stay on the WebSocket. This is the precise form of "full REST": the WS is not a command bus, but it is still the home of the live event stream (outbound) and of three inbound exceptions — interactive terminal IO, `presence_update` (ephemeral recipient-projected cursor telemetry), and `ping` (transport health). None of those three are durable commands with an outcome worth idempotency.
- **No version segment.** Routes live under `/api/...` with no `/v1`. One owned client, one coordinated breaking deploy (id-keyed wire state) — a version segment would imply compatibility machinery we are explicitly not building. Versioning starts if and when a real external compatibility contract exists.
- **Identity.** Every request resolves to an identity via a cookie (`isomux_session`, browser) or `Authorization: Bearer <token>` (user token or agent token). The resolved identity is `{ scope: "user" | "agent" | "cron-run", userId, agentId?, runId?, role: "owner" | "member", capabilities: Capability[] }`. There is no loopback bypass: reads and writes both require identity. Unauthenticated JSON requests get `401 { error: { code: "unauthenticated" } }`; browser navigation gets the login page.
- **Two-stage authorization, both declared.** (1) The dispatcher checks the route's `requiredCapability` against the token's capability set before the handler runs. (2) The route's named `resourceGuard` enforces object-level authorization, subject binding, and ACL policy centrally. Handlers contain no authorization logic.
- **Error envelope.** Errors are `{ error: { code, message } }` with an appropriate status (`400` validation, `401` unauthenticated, `403` forbidden, `404` not found, `409` conflict/stale, `422` semantic). Non-leak: any response touching a room/agent/session/log the caller cannot access returns a generic `403`/`404` — never an "exists-but-hidden" distinction. Preference writes referencing an inaccessible or unknown id are ignored or rejected generically.
- **Idempotency.** A mutating POST may carry an `Idempotency-Key` header. Central middleware keys a short-TTL cache by `(identity, method, route, key)` plus a request-body hash: a repeat with the same key and body replays the cached response; the same key with a different body returns `409`. Optional per request. Subsumes today's `clientMessageId`.
- **Double-signal.** The HTTP response is the per-caller outcome (ack, error, ids, navigation). The WS broadcast is shared state. The UI is echo-authoritative: it applies state from the broadcast and uses HTTP only for ack/error/ids/navigation. Combined with id-keyed entity state, this neutralizes the event-before-response race; the per-command `requestId` correlation machinery and its bespoke `*_response` messages are deleted (HTTP correlates natively).
- **Connection binding.** A REST route that arms a recipient-scoped WS push (today only the editor file-watch) carries `X-Isomux-Connection-Id`, the `connectionId` the client learned from `session_context`. The server verifies that connection belongs to the authenticated session before binding the push, so a watch can only target the caller's own socket, never another user's.
- **Schema notation.** Request/response shapes reference `shared/types.ts` types (`AgentInfo`, `RoomWire`, `TaskItem`, `Cronjob`, `CronjobRun`, `SessionInfo`, `SessionWire`, `InviteWire`, `OfficeSettings`, `LogEntry`, …). Office-wide `all` events never carry a full `UserRecord` or `OfficeSettings`; they carry the reduced wire projections defined under [Named request and wire shapes](#named-request-and-wire-shapes). Rows give the exact shape including the wrapper: `{ agent: AgentInfo }`, not bare `AgentInfo`; `TaskItem[]`; `204` for no-content. New request bodies are named there even though they become TS aliases in code.
- **`emits` legend.** A route's `emits` is `—` (nothing observable), one event id, or several. Every id listed must exist in the [Event registry](#event-registry). `emits` is the route's declared contribution to shared state; the HTTP response is separate (the caller's outcome).
- **Operation ids.** Every route has a stable `opId` (e.g. `agents.spawn`), independent of method and path. Contract tests, generated docs, and future feature-owned prompt snippets attach to `opId`, not to the path.
- **Crosswalk · status.** The last column maps each route to today's surface and its strangler state: `[strangle]` new REST route; the old WS command / HTTP handler stays during migration delegating to the SAME core op, deleted after the UI moves; `[retain]` endpoint kept (now token-authed) as a stable compatibility surface; `[behavior-change]` semantics deliberately change (characterize old, then replace); `[new]` no prior equivalent; `[delete]` the old bespoke WS response/command is removed (folded into the HTTP response).

### Identities and capabilities

Three token scopes resolve to capability sets. Role (`owner`/`member`) is orthogonal to scope and is enforced by guards, not by the capability set.

- **USER scope** (cookie or user bearer) carries the **browser set** — every capability below, gated further by guards (`officeOwner`, `selfOrOwner`, `requiresRoomAccess`). A member and an owner both hold the browser set; the owner-only routes are blocked for members by `officeOwner`, not by a missing capability.
- **AGENT scope** (auto-injected `ISOMUX_AGENT_TOKEN`) carries exactly `{ agent:send-as-self, task:read, task:write, self:affordance }` and nothing else. Spawn, kill, room/user/office settings, invites, sessions, cronjob mutation, editor, terminal, and cronjob-transcript reads are all unreachable because the agent set omits their capability — narrowness comes from the identity being narrow, not from a separate automation tier.
- **RUN scope** (auto-injected into a firing cronjob run's env, rotated per run, revoked when the run ends) carries exactly `{ self:affordance }`, bound to its `{ cronjobId, runId }`. It is the cron-run analogue of an agent token: a fresh cron run has no desk-agent identity, so its in-flight read-file/diff affordances authenticate as the run. This closes the loopback hole rather than relying on a bypass.

| Capability | Held by USER | Held by AGENT | Gates |
|---|---|---|---|
| `office:read` | yes | no | read office/rooms/agents/users/sessions/logs (ACL-projected) |
| `agent:manage` | yes | no | spawn/kill/revive/abort/edit/move agents, swap desks, topic |
| `agent:converse` | yes | no | human↔agent chat: send/edit/cancel/resume/new-conversation |
| `room:manage` | yes | no | create/close/rename rooms, room settings |
| `view:manage` | yes | no | own view preferences (order, shown, notifRooms, defaultRoom) |
| `user:self` | yes | no | edit own user record (name/env/prompt/avatar) |
| `user:admin` | yes | no | edit/delete any user, set room-access grants (guard: `officeOwner`) |
| `office:admin` | yes | no | office settings, access settings, env file (guard: `officeOwner`) |
| `invite:manage` | yes | no | mint/list/revoke invites (scoped by guard) |
| `session:manage` | yes | no | list/revoke sessions (scoped by guard) |
| `cron:read` | yes | no | cronjob metadata + run transcripts (agents cannot read transcripts) |
| `cron:manage` | yes | no | create/update/delete/run-now cronjobs, cronjob prompt |
| `editor:use` | yes | no | open/save files in the editor |
| `file:upload` | yes | no | upload message attachments |
| `terminal:use` | yes | no | interactive terminal (WS) |
| `task:read` | yes | yes | list/get tasks |
| `task:write` | yes | yes | create/update/claim/done/delete tasks (attribution from token) |
| `agent:send-as-self` | no | yes | POST an inter-agent message naming itself as sender |
| `self:affordance` | no | yes† | read-file/diff/edit-file/terminal-command on its OWN chat |

† `self:affordance` is also the sole capability of RUN scope (a firing cron run), bound to its `{ cronjobId, runId }` via `runParamMustEqualTokenRun`. RUN holds nothing else, so it gets a footnote rather than a near-empty column.

The two agent-identity capabilities (`agent:send-as-self`, `self:affordance`) are deliberately absent from USER scope. A human is not an agent and has no own-chat; the human-facing equivalents (editor, message-to-agent) are separate browser routes with their own capability and guard. Impersonation is impossible by construction: a USER token cannot satisfy `agentParamMustEqualTokenAgent`/`senderMustEqualTokenAgent` (no `agentId`) and lacks the capability anyway. RUN scope holds only `self:affordance`, bound to its `{ cronjobId, runId }` via `runParamMustEqualTokenRun`, and can do nothing else.

### Guard catalog

Named, reusable, individually contract-tested policies. A route names one (possibly composite) guard; no authorization logic lives in handlers.

| Guard | Applies to | Check | On failure |
|---|---|---|---|
| `public` | login/static surface | none | — |
| `authenticated` | any identity | valid cookie or bearer | `401` |
| `selfUser` | `/users/:username` self routes | `:username` resolves to `token.userId` | `403` |
| `selfOrOwner` | user edit/delete | `selfUser` OR `officeOwner` | `403` |
| `officeOwner` | owner-only routes | `token.role === "owner"` | `403` |
| `requiresRoomAccess(ref)` | room/agent-scoped routes + data-exposing queries | caller has access to `ref` (a `roomId`, or an `agentId` resolved to its `roomId`) by owner-rule or explicit grant | generic `403`/`404` (no exists-but-hidden) |
| `agentParamMustEqualTokenAgent` | self-affordance routes | AGENT scope ∧ `:id === token.agentId` | `403` |
| `senderMustEqualTokenAgent` | inter-agent message | AGENT scope; sender authority is the token. `body.senderAgentId` is optional legacy input: rejected if present and ≠ `token.agentId`, ignored otherwise | `403` |
| `messageSend` | `agents.sendMessage` (composite) | USER ⇒ `requiresRoomAccess(:id)`, sender derived from token; AGENT ⇒ `senderMustEqualTokenAgent`, cross-room delivery allowed (recipient existence checked, never an ACL leak); if a pending approval exists it must belong to `:id` before the text is interpreted as an allow/deny | `403`/`404` |
| `cronjobOwnerOrOfficeOwner(:id)` | cronjob mutate/run | cronjob's creator `userId === token.userId` OR `officeOwner` | `403` |
| `runParamMustEqualTokenRun` | cron-run affordances | RUN scope ∧ `token.cronjobId === :id` ∧ `token.runId === :runId` | `403` |

Rule-based access (`requiresRoomAccess`) is the security input only: owners have access to all rooms by rule (no materialized `allowedRooms` fan-out), members by explicit grant. Visibility (which accessible rooms a user shows, and in what order) is a separate view-preference, never a security gate.

### REST route table

Grouped by resource. `Cap` = `requiredCapability`; `Guard` = `resourceGuard`. A `403` from any data-exposing query's guard is what keeps a query from becoming a leak — every row that can expose room/agent/session/log data carries a guard, not just a capability.

**Agents — lifecycle**

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `agents.spawn` | POST `/api/agents` | `agent:manage` | `requiresRoomAccess(body.roomId)` | `SpawnReq` | `{ agent: AgentInfo }` | `agent_added` | WS:spawn `[strangle]`, `[delete]` agent_save_response |
| `agents.kill` | DELETE `/api/agents/:id` | `agent:manage` | `requiresRoomAccess(:id)` | — | `204` | `agent_removed`, `killed_agent_added` | WS:kill `[strangle]` |
| `agents.revive` | POST `/api/agents/:id/revive` | `agent:manage` | `requiresRoomAccess(body.roomId)` ∧ `requiresRoomAccess(lastRoomId)` | `ReviveReq` | `{ agent: AgentInfo }` | `agent_added`, `killed_agent_removed` | WS:revive `[strangle]` |
| `agents.abort` | POST `/api/agents/:id/abort` | `agent:manage` | `requiresRoomAccess(:id)` | — | `204` | — | WS:abort `[strangle]` |
| `agents.update` | PATCH `/api/agents/:id` | `agent:manage` | `requiresRoomAccess(:id)` | `EditAgentReq` | `{ agent: AgentInfo }` | `agent_updated` | WS:edit_agent `[strangle]`, `[delete]` agent_save_response |
| `agents.move` | POST `/api/agents/:id/move` | `agent:manage` | `requiresRoomAccess(:id)` ∧ `requiresRoomAccess(body.targetRoomId)` | `MoveAgentReq` | `{ agent: AgentInfo }` | `agent_updated` | WS:move_agent `[strangle]` |
| `agents.setTopic` | PUT `/api/agents/:id/topic` | `agent:manage` | `requiresRoomAccess(:id)` | `TopicReq` | `204` | `agent_updated` | WS:set_topic `[strangle]` |
| `agents.clearTopic` | DELETE `/api/agents/:id/topic` | `agent:manage` | `requiresRoomAccess(:id)` | — | `204` | `agent_updated` | WS:reset_topic `[strangle]` |
| `rooms.swapDesks` | POST `/api/rooms/:roomId/swap-desks` | `agent:manage` | `requiresRoomAccess(:roomId)` | `SwapDesksReq` | `204` | `agent_updated` ×2 | WS:swap_desks `[strangle]` |

**Agents — conversation**

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `agents.sendMessage` | POST `/api/agents/:id/messages` | `agent:converse` \| `agent:send-as-self` | `messageSend` | `SendMessageReq` | `{ messageId }` | `log_entry`* | WS:send_message + HTTP:POST /agents/:id/message `[strangle]`. Sender authority is always the token; `senderAgentId` is optional legacy input, rejected only if present and ≠ `token.agentId` |
| `agents.editMessage` | PATCH `/api/agents/:id/messages/:logEntryId` | `agent:converse` | `requiresRoomAccess(:id)` | `EditMessageReq` | `{ messageId }` | `log_entry`* | WS:edit_message `[strangle]` |
| `agents.cancelQueued` | DELETE `/api/agents/:id/queue/:messageId` | `agent:converse` | `requiresRoomAccess(:id)` | — | `204` | — | WS:cancel_queued `[strangle]` |
| `agents.sendNow` | POST `/api/agents/:id/send-now` | `agent:converse` | `requiresRoomAccess(:id)` | — | `204` | `log_entry`* | WS:send_now `[strangle]` |
| `agents.newConversation` | POST `/api/agents/:id/new-conversation` | `agent:converse` | `requiresRoomAccess(:id)` | — | `204` | `clear_logs` | WS:new_conversation `[strangle]` |
| `agents.resume` | POST `/api/agents/:id/resume` | `agent:converse` | `requiresRoomAccess(:id)` | `ResumeReq` | `204` | `log_entry`* | WS:resume `[strangle]` |
| `agents.listSessions` | GET `/api/agents/:id/sessions` | `office:read` | `requiresRoomAccess(:id)` | — | `{ sessions: SessionInfo[], currentSessionId }` | — | WS:list_sessions `[strangle]`, `[delete]` sessions_list (guard replaces per-WS scoping) |

\* `log_entry` (and `approval_request`, `clear_logs`) stream over the WS as the turn runs; the HTTP response only acks enqueue. Approvals: while `pendingPermission` is set for `:id`, the next `agents.sendMessage` to that agent is interpreted as the allow/deny reply (guarded by `messageSend`); no separate route.

**Agents — self-affordances (AGENT scope, own chat)**

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `agents.readFile` | POST `/api/agents/:id/read-file` | `self:affordance` | `agentParamMustEqualTokenAgent` | `AffordanceReadFileReq` | `{ ok: true }` | `log_entry` | HTTP:POST /agents/:id/read-file `[retain]` (now token-authed) |
| `agents.diff` | POST `/api/agents/:id/diff` | `self:affordance` | `agentParamMustEqualTokenAgent` | `AffordanceDiffReq` | `{ ok: true }` | `log_entry` | HTTP:POST /agents/:id/diff `[retain]` |
| `agents.editFile` | POST `/api/agents/:id/edit-file` | `self:affordance` | `agentParamMustEqualTokenAgent` | `AffordanceEditFileReq` | `{ ok: true }` | `log_entry` | HTTP:POST /agents/:id/edit-file `[retain]` |
| `agents.terminalCommand` | POST `/api/agents/:id/terminal-command` | `self:affordance` | `agentParamMustEqualTokenAgent` | `AffordanceTerminalCmdReq` | `{ ok: true }` | `log_entry` | HTTP:POST /agents/:id/terminal-command `[retain]` |

**Agents — editor (browser)**

The editor is request/response, so it is REST (unlike the interactive terminal). `GET …/file` opens-and-registers a watch keyed by `(connectionId, agentId, path)`; the watch pushes `editor_external_change` over that session's WS; `DELETE …/file/watch` unregisters. Both `GET` and `DELETE` carry `X-Isomux-Connection-Id` (from `session_context`); the server verifies that connection belongs to the authenticated session before binding/unbinding, so the push reaches the right tab and cannot be aimed at another user's socket (see Conventions › Connection binding).

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `agents.openFile` | GET `/api/agents/:id/file?path=` | `editor:use` | `requiresRoomAccess(:id)` | — | `{ content, mtime, language, size }` | `editor_external_change`† | WS:editor_open `[strangle]`, `[delete]` editor_content/editor_open_error |
| `agents.saveFile` | PUT `/api/agents/:id/file` | `editor:use` | `requiresRoomAccess(:id)` | `EditorSaveReq` | `{ ok: true, mtime }` or `409 { reason:"stale", currentMtime }` | — | WS:editor_save `[strangle]`, `[delete]` editor_save_response |
| `agents.closeFile` | DELETE `/api/agents/:id/file/watch?path=` | `editor:use` | `requiresRoomAccess(:id)` | — | `204` | — | WS:editor_close `[strangle]` |

† pushed asynchronously to the watching session, not on the GET response.

**Agents — uploads / file serving**

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `agents.upload` | POST `/api/agents/:id/uploads` | `file:upload` | `requiresRoomAccess(:id)` | multipart (≤5 files, 20MB each, 40MB total) | `{ attachments: Attachment[] }` | — | HTTP:POST /api/upload/:agentId `[strangle]` |
| `agents.getFile` | GET `/api/agents/:id/files/:filename` | `office:read` | `requiresRoomAccess(:id)` | — | file bytes | — | HTTP:GET /api/files/:agentId/:filename `[behavior-change]` now room-ACL-gated, not public-with-cookie |

**Rooms**

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `rooms.create` | POST `/api/rooms` | `room:manage` | `authenticated` | `RoomCreateReq` | `{ room: RoomWire }` | `room_created` | WS:create_room `[behavior-change]` creator gets access, owners by rule, NO allowedRooms fan-out |
| `rooms.close` | DELETE `/api/rooms/:roomId` | `room:manage` | `requiresRoomAccess(:roomId)` | — | `204` | `room_closed` | WS:close_room `[strangle]` (cleanup trivial under rule-based access) |
| `rooms.rename` | PATCH `/api/rooms/:roomId` | `room:manage` | `requiresRoomAccess(:roomId)` | `RoomRenameReq` | `204` | `room_renamed` | WS:rename_room `[strangle]` |
| `rooms.setSettings` | PUT `/api/rooms/:roomId/settings` | `room:manage` | `requiresRoomAccess(:roomId)` | `RoomSettingsReq` | `204` | `room_settings_updated` | WS:update_room_settings `[strangle]`, `[delete]` settings_save_response |
| `rooms.list` | GET `/api/rooms` | `office:read` | `authenticated` (ACL-projected) | — | `{ rooms: RoomWire[] }` (owner: all; member: accessible) | — | part of full_state today `[new]` explicit query |

**View preferences (per-user; the visibility axis, never security)**

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `view.get` | GET `/api/me/view` | `view:manage` | `authenticated` | — | `{ order, shown, notifRooms, defaultRoomId }` | — | `[new]` (was implicit in user record) |
| `view.setOrder` | PUT `/api/me/view/order` | `view:manage` | `authenticated` | `ViewOrderReq` | `204` | `full_state` (self) | WS:reorder_rooms `[behavior-change]` per-user, always allowed; old global owner-only reorder deleted |
| `view.setShown` | PUT `/api/me/view/shown` | `view:manage` | `authenticated` | `ShownRoomsReq` | `204` | `full_state` (self) | `[new]` (hide/show accessible rooms) |
| `view.setNotifRooms` | PUT `/api/me/view/notif-rooms` | `view:manage` | `authenticated` | `NotifRoomsReq` | `204` | `user_updated` | WS:claim_user/update_user (notif slice) `[strangle]`; enforced ⊆ shown |
| `view.setDefaultRoom` | PUT `/api/me/view/default-room` | `view:manage` | `authenticated` | `DefaultRoomReq` | `204` | `user_updated` | WS:claim_user/update_user (default slice) `[strangle]` |

Non-leak invariant on all view writes: inaccessible or unknown room ids are ignored or generically rejected, never surfaced as exists-but-hidden. `notifRooms ⊆ shown ⊆ accessible` is enforced server-side; revoking access or hiding a room auto-drops it from `notifRooms`/`defaultRoomId`.

**Users**

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `users.list` | GET `/api/users` | `office:read` | `authenticated` | — | recipient-scoped: `{ users: UserAdminWire[] }` (owner) \| `{ users: UserPublicWire[] }` (member; own entry as `UserSelfWire`) | — | part of users_list today `[new]` explicit query |
| `users.update` | PATCH `/api/users/:username` | `user:self` \| `user:admin` | `selfOrOwner` | `UserUpdateReq` | `{ user: UserSelfWire }` (self) \| `{ user: UserAdminWire }` (owner) | `user_updated`; `full_state` (self) when a private field changed | WS:update_user (record slice) `[strangle]`, `[delete]` settings_save_response. Name/env/prompt/avatar only. Public fields ride `user_updated` (`all`); a subject's private-field changes (env/prompt) reach only that subject's own sockets via `full_state`, never the `all` event |
| `users.setAccess` | PUT `/api/users/:username/access` | `user:admin` | `officeOwner` | `SetAccessReq` | `{ user: UserAdminWire }` (to the owner caller) | `full_state` (target) | WS:update_user (allowedRooms slice) `[behavior-change]` access grants split from record edit; the target sees their new projection via `full_state`, not a broadcast of their grants |
| `users.delete` | DELETE `/api/users/:username` | `user:self` \| `user:admin` | `selfOrOwner` (not last owner; owner≠self) | — | `204` | `users_list`, `session_expired` (target) | WS:delete_user `[strangle]`, `[delete]` delete_user_blocked |

`users.update` no longer carries `defaultRoomId`/`notifRooms`/`allowedRooms`: the first two move to `view.*`, the third to `users.setAccess`. `claim_user` (first-login prefs) becomes `view.setDefaultRoom` + `view.setNotifRooms`.

User wire projections (see [Named request and wire shapes](#named-request-and-wire-shapes)): `all` user events and the public roster carry `UserPublicWire` (id/name/role/avatar/createdAt only). A user's sensitive fields (`envFile`, `allowedRooms`, `memberPrompt`, view prefs) reach only that user (`UserSelfWire`) or an owner managing them (`UserAdminWire`), never the office-wide `all` audience. `UserRecord` is never a wire shape on an `all` channel.

**Sessions, invites, access (auth surface)**

The login HTML flow (`GET /`, `POST /auth/claim`, `GET /i/:token`, `POST /auth/accept`, `POST /auth/logout`, `GET /auth/login-bg.png`) is the cookie-minting browser surface and stays as-is (`public`/origin-checked, not `/api`). The management surface below becomes REST.

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `invites.mint` | POST `/api/invites` | `invite:manage` | `officeOwner` | `InviteMintReq` | `{ url, invite: InviteWire }` | `invites_list` (recipient-scoped) | WS:mint_invite `[strangle]`, `[delete]` invite_minted |
| `invites.mintSelf` | POST `/api/invites/self` | `invite:manage` | `authenticated` | — | `{ url, invite: InviteWire }` | `invites_list` | WS:mint_self_invite `[strangle]` |
| `invites.list` | GET `/api/invites` | `invite:manage` | `authenticated` (recipient-scoped) | — | `{ invites: InviteWire[] }` | — | WS:list_invites `[strangle]` |
| `invites.revoke` | DELETE `/api/invites/:tokenPrefix` | `invite:manage` | owner unrestricted; member own only | — | `204` | `invite_revoked` (owners), `invites_list` | WS:revoke_invite `[strangle]` |
| `sessions.list` | GET `/api/sessions` | `session:manage` | `authenticated` (recipient-scoped) | — | `{ sessions: SessionWire[] }` | — | WS:list_active_sessions `[strangle]` |
| `sessions.revoke` | DELETE `/api/sessions/:sessionPrefix` | `session:manage` | owner global / member self (not last owner) | — | `204` or `409 { reason }` | `session_revoked` (owners), `sessions_active_list`, `session_expired` (target) | WS:revoke_session `[strangle]`, `[delete]` revoke_blocked |
| `sessions.logout` | DELETE `/api/sessions/current` | `authenticated` | not last owner session | — | `204` or `409 { reason }` | `session_expired` (self) | WS:logout + HTTP:/auth/logout `[strangle]`, `[delete]` logout_blocked |
| `office.getAccess` | GET `/api/office/access` | `office:admin` | `officeOwner` | — | `AccessSettings` | — | WS:get_access_settings `[strangle]` |
| `office.setAccess` | PUT `/api/office/access` | `office:admin` | `officeOwner` | `AccessSettingsReq` | `{ signInUrl, restartRequired }` | `invites_list` | WS:update_access_settings `[strangle]`, `[delete]` access_settings_updated |

**Office settings, validation, backends**

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `office.getSettings` | GET `/api/office/settings` | `office:admin` | `officeOwner` | — | `OfficeSettings` | — | `[new]` owner reads full settings incl `envFile` (the field that may not ride an `all` event) |
| `office.setSettings` | PUT `/api/office/settings` | `office:admin` | `officeOwner` | `OfficeSettingsReq` | `204` | `office_settings_updated` | WS:update_office_settings `[strangle]`, `[delete]` settings_save_response; the `office_settings_updated` event carries public `name`/`prompt` only (`envFile` stays owner-only via `office.getSettings`) |
| `validate.cwd` | POST `/api/validate/cwd` | `agent:manage` | `authenticated` | `ValidateCwdReq` | `{ ok, error? }` | — | WS:request_cwd_validation `[strangle]`, `[delete]` cwd_validation |
| `validate.env` | POST `/api/validate/env` | `office:read` | office/other-user ⇒ `officeOwner`; own ⇒ `selfUser` | `ValidateEnvReq` | `{ ok, keyCount?, error? }` | — | WS:request_settings_validation `[strangle]`, `[delete]` settings_validation; the resolved env-file path is omitted from the response by design |
| `backends.listModels` | GET `/api/backends/:agentType/models?cwd=&includeHidden=` | `agent:manage` | `authenticated` | — | `{ models: BackendModelWire[], authError? }` | — | WS:list_backend_models `[strangle]`, `[delete]` list_backend_models_response |

**Tasks** (global shared board; `createdBy` + `username` derived from token, `assignee` from body)

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `tasks.list` | GET `/api/tasks?status=&assignee=&title=` | `task:read` | `authenticated` | — | `TaskItem[]` | — | HTTP:GET /tasks `[retain]` (now token-authed) |
| `tasks.get` | GET `/api/tasks/:id` | `task:read` | `authenticated` | — | `TaskItem` | — | HTTP:GET /tasks/:id `[retain]` |
| `tasks.create` | POST `/api/tasks` | `task:write` | `authenticated` | `TaskCreateReq` | `TaskItem` (201) | `tasks` | HTTP:POST /tasks `[behavior-change]` createdBy/username from token, not body |
| `tasks.update` | PATCH `/api/tasks/:id` | `task:write` | `authenticated` | `TaskUpdateReq` | `TaskItem` | `tasks` | HTTP:PATCH /tasks/:id + WS:update_task `[strangle]` |
| `tasks.claim` | POST `/api/tasks/:id/claim` | `task:write` | `authenticated` | `TaskClaimReq` | `TaskItem` | `tasks` | HTTP:POST /tasks/:id/claim `[retain]` |
| `tasks.done` | POST `/api/tasks/:id/done` | `task:write` | `authenticated` | — | `TaskItem` | `tasks` | HTTP:POST /tasks/:id/done `[retain]` |
| `tasks.delete` | DELETE `/api/tasks/:id` | `task:write` | `authenticated` | — | `204` | `tasks` | WS:delete_task `[behavior-change]` HTTP DELETE was blocked; now unified |

**Cronjobs** (metadata office-wide read; mutation owner-or-office-owner; transcripts `cron:read` — AGENT scope cannot read them)

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `cron.list` | GET `/api/cronjobs` | `cron:read` | `authenticated` | — | `Cronjob[]` | — | HTTP:GET /cronjobs `[retain]` |
| `cron.get` | GET `/api/cronjobs/:id` | `cron:read` | `authenticated` | — | `Cronjob` | — | HTTP:GET /cronjobs/:id `[retain]` |
| `cron.create` | POST `/api/cronjobs` | `cron:manage` | `authenticated` | `CronCreateReq` | `Cronjob` | `cronjob_added` | WS:add_cronjob `[strangle]`, `[delete]` agent_save_response |
| `cron.update` | PATCH `/api/cronjobs/:id` | `cron:manage` | `cronjobOwnerOrOfficeOwner(:id)` | `CronUpdateReq` | `Cronjob` | `cronjob_updated` | WS:update_cronjob `[strangle]` |
| `cron.delete` | DELETE `/api/cronjobs/:id` | `cron:manage` | `cronjobOwnerOrOfficeOwner(:id)` | — | `204` | `cronjob_deleted` | WS:delete_cronjob `[strangle]` |
| `cron.runNow` | POST `/api/cronjobs/:id/runs` | `cron:manage` | `cronjobOwnerOrOfficeOwner(:id)` | — | `{ runId }` | `cronjob_run_updated` | WS:run_cronjob_now `[strangle]` |
| `cron.setPrompt` | PUT `/api/cron-prompt` | `cron:manage` | `officeOwner` | `{ value: string \| null }` | `204` | `cronjobs_prompt_updated` | WS:update_cronjobs_prompt `[behavior-change]` today has NO role check (any authenticated session); tightened to owner. Path off the `:id` namespace to avoid shadowing `/api/cronjobs/:id` |
| `cron.listRuns` | GET `/api/cronjobs/:id/runs` | `cron:read` | `authenticated` | — | `{ runs: CronjobRun[] }` | — | WS:list_cronjob_runs `[strangle]` |
| `cron.listAllRuns` | GET `/api/cron-runs` | `cron:read` | `authenticated` | — | `{ jobs: { cronjobId, runs: CronjobRun[] }[] }` | — | WS:list_all_cronjob_runs `[strangle]`, `[delete]` cronjob_runs_complete sentinel. Path off the `:id` namespace to avoid shadowing `/api/cronjobs/:id` |
| `cron.getRun` | GET `/api/cronjobs/:id/runs/:runId` | `cron:read` | `authenticated` | — | `{ run: CronjobRun, entries: LogEntry[] }` | — | WS:load_cronjob_run `[behavior-change]` transcript returned as data, not replayed as log_entry events |
| `cron.runMessage` | POST `/api/cronjobs/:id/runs/:runId/messages` | `cron:manage` | `cronjobOwnerOrOfficeOwner(:id)` | `CronRunMessageReq` | `{ messageId }` | `cron_run_log_entry` | WS:send_cronjob_run_message `[strangle]` |
| `cron.editRunMessage` | PATCH `/api/cronjobs/:id/runs/:runId/messages/:logEntryId` | `cron:manage` | `cronjobOwnerOrOfficeOwner(:id)` | `EditMessageReq` | `{ messageId }` | `cron_run_log_entry` | WS:edit_cronjob_run_message `[strangle]` |
| `cron.runReadFile` | POST `/api/cronjobs/:id/runs/:runId/read-file` | `self:affordance` | `runParamMustEqualTokenRun` | `AffordanceReadFileReq` | `{ ok: true }` | `cron_run_log_entry` | HTTP:POST /cronjobs/:jobId/runs/:runId/read-file `[strangle]` now RUN-token-authed (no loopback bypass) |
| `cron.runDiff` | POST `/api/cronjobs/:id/runs/:runId/diff` | `self:affordance` | `runParamMustEqualTokenRun` | `AffordanceDiffReq` | `{ ok: true }` | `cron_run_log_entry` | HTTP:POST /cronjobs/:jobId/runs/:runId/diff `[strangle]` RUN-token-authed |

**System**

| opId | Method · Path | Cap | Guard | Request | Response | Emits | Crosswalk · status |
|---|---|---|---|---|---|---|---|
| `system.backupStatus` | GET `/api/backup/status` | `office:read` | `authenticated` | — | `{ lastRunAt, ok, error, retention, destDir }` | — | HTTP:GET /backup/status `[retain]` |

### Event registry

The single typed registry of every outbound WS event. Audience is a first-class attribute of the event TYPE (not of a route), because many sensitive events have no owning HTTP route (backend stream, terminal IO, presence, scheduler-fired cronjobs, auth expiry, subprocess lifecycle). A single emit helper is the only path to the wire; contract tests enumerate this union, assert each audience, and forbid raw `ws.send`/`broadcast` outside the dispatcher.

`projectionKey` is the payload field(s) from which recipients are computed — its presence is what makes an audience auditable (an event whose audience cannot be computed from its payload is a bug the registry surfaces). Audience strategies: `all`, `owners`, `room-ACL`, `recipient-scoped`, `by-user`, `none`.

Events whose mutation removes or relocates their projection source (`agent_removed`, `room_closed`, `agent_updated` on move) carry the pre-mutation room id(s) in the payload, so the audience is always computable without a post-mutation lookup. The emit helper captures that projection context before the core op mutates state; projection never depends on state the mutation just removed.

**Live agent / room stream**

| Event | Payload | Audience | projectionKey | Notes |
|---|---|---|---|---|
| `log_entry` | `{ entry: LogEntry }` | room-ACL | `agentId → roomId` | includes streamed turn output and the `approval_request` interactive prompt. Agent streams only; cron-run transcript entries use `cron_run_log_entry` |
| `clear_logs` | `{ agentId }` | room-ACL | `agentId → roomId` | |
| `slash_commands` | `{ agentId, commands, skills }` | room-ACL | `agentId → roomId` | server-pushed; no inbound route |
| `agent_added` | `{ agent: AgentInfo }` | room-ACL | `agent.roomId` | room index projected per recipient; suppressed if hidden |
| `agent_removed` | `{ agentId, roomId }` | room-ACL | `roomId` (carried; room at removal) | `[behavior-change]` today broadcast-all; scoping removes a minor id leak. `roomId` in the payload makes the audience computable after the delete |
| `agent_updated` | `{ agentId, changes: Partial<AgentInfo> & { oldRoomId?, newRoomId? } }` (a move sets `oldRoomId`+`newRoomId`) | room-ACL | `agentId → roomId`; on move `oldRoomId ∪ newRoomId` (both carried) | a room-move triggers a recipient `full_state` refresh instead of a raw delta |
| `killed_agent_added` | `{ agent: KilledAgentSummary }` | room-ACL | `lastRoomId` | |
| `killed_agent_removed` | `{ agentId, lastRoomId }` | room-ACL | `lastRoomId` | |
| `terminal_output` | `{ agentId, data }` | room-ACL | `agentId → roomId` | interactive; viewers gated by room access |
| `terminal_exit` | `{ agentId, exitCode }` | room-ACL | `agentId → roomId` | |
| `room_created` | `{ room: RoomWire }` | room-ACL | `room.id` | under rule-based access, owners always; members on grant |
| `room_closed` | `{ roomId }` | room-ACL | `roomId` (pre-close access snapshot) | audience computed from who had access before cleanup; triggers recipient `full_state` refresh (index shift) |
| `room_renamed` | `{ roomId, name }` | room-ACL | `roomId` | |
| `room_settings_updated` | `{ roomId, prompt }` | room-ACL | `roomId` | |

**State / projection (per-recipient)**

| Event | Payload | Audience | projectionKey | Notes |
|---|---|---|---|---|
| `session_context` | `{ context }` | recipient-scoped | `connectionId` | connect handshake; the socket itself |
| `full_state` | `{ agents, rooms, office, recentCwds, killedAgents }` | recipient-scoped | `userId` (ACL projection) | dense visible-room projection; agents filtered; killed filtered by `lastRoomId` |
| `all_rooms_list` | `{ rooms: RoomWire[] }` | owners | owner-flag | unfiltered global rooms; owners only |
| `presence_list` | `{ entries, totalOnlineUsers }` | recipient-scoped | `connectionId` + per-session projection | `currentRoomId` remapped to dense visible index; off-scene entries omitted |
| `editor_external_change` | `{ agentId, path, mtime }` | recipient-scoped | `connectionId` | only the session whose watch is open |
| `session_expired` | `{}` | recipient-scoped | `connectionId` | the socket being expired |

**Office-wide (audience `all` — the leak-prone class)**

These are intentionally office-wide read; each is justified (a global shared board, or office-wide metadata), and `all` is the leak-prone class. Two constraints it honors: (a) user/office payloads are reduced wire projections (`UserPublicWire`; office `name`/`prompt`), never the full `UserRecord`/`OfficeSettings`, so env paths, access grants, and profile prompts do not ride an `all` channel. (b) Cronjob events carry the full `Cronjob` (prompt, cwd, model/permission config, creator attribution, schedule), and `cron_run_log_entry` carries the live run-transcript stream: all office-wide-readable by design. Stored run-transcript bodies are deferred (Follow-up 3) and stay `cron:read`-gated, so AGENT scope can never read them.

| Event | Payload | Audience | projectionKey | Notes |
|---|---|---|---|---|
| `users_list` | `{ users: UserPublicWire[] }` | all | none | public display metadata only (id/name/role/avatar/createdAt); env/access/prompt never broadcast |
| `user_updated` | `{ user: UserPublicWire, prevName? }` | all | none | public fields only; a subject's private-field changes go recipient-scoped to their own sockets |
| `tasks` | `{ tasks: TaskItem[] }` | all | none | global shared board |
| `cronjobs_state` | `{ cronjobs, cronjobsPrompt }` | all | none | connect snapshot |
| `cronjob_added` / `cronjob_updated` / `cronjob_deleted` | `{ cronjob }` / `{ id }` | all | none | cronjob metadata office-wide read |
| `cronjobs_prompt_updated` | `{ value }` | all | none | |
| `cronjob_run_updated` | `{ run: CronjobRun }` | all | none | run state; transcript reads are separately `cron:read`-gated |
| `cron_run_log_entry` | `{ entry: LogEntry }` (`entry.agentId` = synthetic `cronrun-<runId>`) | all | none | live cron-run transcript stream: output, file/diff cards, run-message replies. Office-wide today (the accepted cron exposure); tightens to `cron:read` under Follow-up 3. Distinct from `log_entry` because a run has no room, so it broadcasts rather than projecting room-ACL |
| `office_settings_updated` | `{ name, prompt }` | all | none | public office metadata only; `envFile` is owner-only via `office.getSettings`, never in an `all` event |
| `update_status` | `{ updateAvailable, current, latest }` | all | none | |

**Auth-sensitive**

| Event | Payload | Audience | projectionKey | Notes |
|---|---|---|---|---|
| `session_revoked` | `{ sessionPrefix }` | owners | owner-flag | a plain broadcast would leak the prefix |
| `invite_revoked` | `{ tokenPrefix }` | owners | owner-flag | |
| `invites_list` | `{ invites: InviteWire[] }` | recipient-scoped | `userId` | owner sees all; member sees own (by username) |
| `sessions_active_list` | `{ sessions: SessionWire[] }` | recipient-scoped | `userId` | owner sees all; member sees own |

**Retired response messages** (deleted from the WS; each becomes the HTTP response of its `opId`)

`agent_save_response`, `settings_save_response`, `cwd_validation`, `settings_validation`, `list_backend_models_response`, `editor_content`, `editor_open_error`, `editor_save_response`, `sessions_list`, `cronjob_runs`, `cronjob_runs_complete`, `invite_minted`, `access_settings`, `access_settings_updated`, `delete_user_blocked`, `revoke_blocked`, `logout_blocked`. `pong` is the one kept WS reply (transport keepalive).

**Deleted broadcast:** `rooms_reordered` is removed entirely — room order is now per-user view-preference (`view.setOrder`, which emits `full_state` (self)), so there is no global reorder broadcast to retire onto an HTTP response.

### WebSocket surface (post-refactor)

The WS is no longer a command bus. It carries:

- **Outbound:** the entire event registry above, through the single audience-applying emit helper.
- **Connect handshake:** authenticate (cookie or bearer + origin check) on upgrade, then `session_context`, `users_list`, `full_state`, `all_rooms_list` (owners), `tasks`, `cronjobs_state`, `presence_list`, and per-visible-agent `log_entry`/`slash_commands` replay.
- **Inbound exceptions (the only inbound messages):** interactive terminal (`terminal_open`, `terminal_input`, `terminal_resize`, `terminal_close` → `terminal_output`/`terminal_exit`); `presence_update` (ephemeral recipient-projected cursor telemetry → `presence_list`); `ping` → `pong`. These are live/interactive/ephemeral transport, not durable commands — they have no idempotency or HTTP outcome and stay on the socket.

### Named request and wire shapes

Request bodies and the reduced wire projections, aliased in code against `shared/types.ts`. Fields marked `?` are optional.

**Wire projections (response / event shapes):**

- `UserPublicWire` `Pick<UserRecord, "id"|"name"|"role"|"avatarColor"|"avatarVariant"|"createdAt">`: office-wide user display metadata; the only user shape in `all` events and the public roster.
- `UserSelfWire` `UserRecord`: the caller's own full record (env/access/prompt/view prefs); delivered only to that user.
- `UserAdminWire` `UserRecord`: any user's full record; delivered only to owners. Same shape as `UserSelfWire`, separated by recipient so the audience contract is explicit.
- Existing `shared/types.ts` types used verbatim as responses: `AgentInfo`, `RoomWire`, `TaskItem`, `Cronjob`, `CronjobRun`, `SessionInfo` (per-agent conversation list item), `SessionWire`, `InviteWire`, `OfficeSettings`, `KilledAgentSummary`, `LogEntry`, `BackendModelWire`, `Attachment`.
- `AccessSettings` (the `office.getAccess` response) `{ externalAccess: boolean, publicOrigin: string | null, envOriginSet: boolean, envOrigin: string | null, boundLoopback: boolean }`.

**Request bodies:**

- `SpawnReq` `{ name, cwd, roomId, desk, permissionMode?, customInstructions?, outfit?, modelFamily?, effort?, agentType?, codexSandbox? }`
- `EditAgentReq` `Partial<Pick<AgentInfo, "name"|"cwd"|"outfit"|"customInstructions"|"modelFamily"|"effort"|"permissionMode"|"codexSandbox">>`
- `ReviveReq` `{ roomId, desk }` · `MoveAgentReq` `{ targetRoomId }` · `SwapDesksReq` `{ deskA, deskB }`
- `SendMessageReq` `{ text, device?, attachments?: Attachment[], senderAgentId? }` (sender authority is the token; `senderAgentId` is optional legacy input, rejected if present and mismatched, ignored otherwise)
- `EditMessageReq` `{ newText, device? }` · `ResumeReq` `{ sessionId }` · `TopicReq` `{ topic }`
- `AffordanceReadFileReq` `{ path }` · `AffordanceEditFileReq` `{ path }` · `AffordanceDiffReq` `{ dir?, commit? }` · `AffordanceTerminalCmdReq` `{ command }`
- `EditorSaveReq` `{ path, content, expectedMtime, force? }`
- `RoomCreateReq` `{ name? }` · `RoomRenameReq` `{ name }` · `RoomSettingsReq` `{ prompt: string | null }`
- `ViewOrderReq` `{ order: string[] }` · `ShownRoomsReq` `{ shown: string[] }` · `NotifRoomsReq` `{ notifRooms: string[] }` · `DefaultRoomReq` `{ defaultRoomId: string }`
- `UserUpdateReq` `Partial<{ name, envFile, memberPrompt, avatarColor, avatarVariant }>` · `SetAccessReq` `{ allowedRooms: string[] }`
- `InviteMintReq` `{ username, role, allowExisting? }` · `AccessSettingsReq` `{ externalAccess, publicOrigin }`
- `OfficeSettingsReq` `{ prompt, envFile, name? }` · `ValidateCwdReq` `{ cwd }` · `ValidateEnvReq` `{ scope: "office"|"user", username? }`
- `TaskCreateReq` `{ title, description?, priority?, assignee? }` (createdBy/username derived from token) · `TaskUpdateReq` `Partial<{ title, description, priority, status, assignee }>` · `TaskClaimReq` `{ assignee? }`
- `CronCreateReq` `{ name, schedule, prompt, cwd, agentType?, modelFamily, effort, permissionMode, codexSandbox? }` (username derived from token) · `CronUpdateReq` `Partial<{ name, schedule, prompt, cwd, modelFamily, effort, permissionMode, codexSandbox, enabled }>` · `CronRunMessageReq` `{ text, device? }`

## Implementation plan

The ordered, phased plan that sequences the locked design above into implementation. The altitude is deliberate: phases, dependencies, gates, and exit criteria, not a per-command or line-level checklist. The implementing agent owns the order of routes within a resource group and the line-level edits; this plan owns what must happen before what, and why.

Two fixed points anchor the order:

- Contract-first. The full API spec was the first deliverable and is already captured in the **Server API Spec** section; implementation is driven by it, with contract tests TDD'd against it.
- Config-root ships first as a standalone, independently-tested commit (it unblocks the test net and has zero production behavior change).

One shipping invariant governs the rest: every phase is independently shippable, and behavior-preserving wherever possible. P0 and P1 are pure additions (infrastructure and tests) with no runtime behavior change. The only unavoidable client-coordinated break is the P3c wire-shape change (dense indices to id-keyed maps), and it is isolated to its own deploy precisely so nothing else rides on a breaking change.

### Phase 0 — Test-infrastructure foundation

Goal: make the new test tiers possible. No runtime behavior change; pure additions.

- **0.1 Config-root + cleanup guard.** A single config module for the state root (an `ISOMUX_HOME`-style override) that defaults to `~/.isomux` so production is byte-for-byte unchanged; re-point the ~15 inlined `ISOMUX_DIR` sites at it. The cleanup guard refuses destructive cleanup unless the target realpath-resolves under the OS temp dir, and always refuses the real `~/.isomux`. Standalone, independently-tested commit. (Fixed first.)
- **0.2 Constructor DI + FakeBackend.** Convert `AgentManager`/`CronjobManager` to instantiable units per the Decided "Dependency injection and module shape" bullet, with a production factory wiring today's defaults. Preserve the two init-order invariants the current modules rely on: rooms seeded synchronously at construction (the auth snapshot provider can fire before the async restore completes), and the construct-quietly-then-enable-persistence latch. `FakeBackend` is injected through the resolver.
- **0.3 In-process harness + script split.** A harness that boots the server against temp state with multiple authenticated users and sockets. Add the `test` (no LLM) vs `test:live` (gated) package.json split.

Exit: a T1 test can boot the server against a temp `ISOMUX_HOME`, connect multiple authenticated sockets, drive a `FakeBackend`, and assert on persisted files, with `bun test` making zero LLM calls.

### Phase 1 — Characterization safety net

Goal: freeze current observable behavior before any of it is refactored. Tests assert at public boundaries (WS messages, REST responses, persisted files) so they survive the refactor.

- **1.1 Flagship onboarding / fresh-install** across the three backend-availability states. Sequenced first so config-root plus FakeBackend immediately prove the net is real.
- **1.2 Projection/ACL characterization** (the checklist in the Testing strategy section). Highest-value net: it freezes the dense-index projection, per-recipient ACL filtering, the old global reorder behavior, the `create_room` owner fan-out, and presence projection, all of which Phase 3 rewrites. This is the before-and-after net that lets the ACL/view split (3b) proceed safely while the wire is still dense-index.
- **1.3 Persistence/migration characterization.** Round-trip plus the existing load-time migrations, and the pre-flatten persisted shape, before stable room IDs touch it.
- **1.4 Remaining net.** Queue/resume/fork/usage; route-level tests of the current HTTP surface (tasks, cronjobs, uploads, affordances, settings, auth policy) so the strangler has a before-picture; adapter fixtures plus opt-in live smoke.

Exit: every refactor-adjacent README mechanism has a deterministic behavioral test; projection/ACL and persistence are frozen.

### Phase 2 — Contract-enforcement foundation

Goal: stand up the typed machinery the strangler will fill. No command migrated, no security behavior changed.

- **2.1 Identity and capabilities.** Token scopes (user/agent/run), capability sets, `Authorization: Bearer` parsing alongside the existing cookie path, RUN-scope tokens for cron runs, and redaction (the token never appears in prompts, logs, errors, diffs, or over WS). Wire mint/rotate/revoke to spawn/kill/revive (agent) and to run lifecycle (cron); deliver via the existing per-agent env-injection path (`ISOMUX_AGENT_TOKEN`). Tokens are issued and accepted here additively: nothing is enforced yet, so the live loopback path keeps working.
- **2.2 Guard catalog + two-stage dispatcher.** The named, individually contract-tested guards, and the dispatcher that checks the coarse `requiredCapability` and then the route's `resourceGuard`. No authorization logic in handler bodies.
- **2.3 Route-table skeleton + emit helper + event registry + idempotency.** The typed route table, the single emit helper as the only path to the wire, the event registry with declared audiences, and the centralized `Idempotency-Key` middleware. Contract tests are TDD'd against the spec. The emit helper initially delegates to today's projection logic, so nothing changes on the wire yet.

Gate (blocks Phase 3): a **Reviewer4 security pass** on the token/auth design and on the audience declarations (a mis-declared audience is a leak).

Exit: the contract is enforced in code (types plus contract tests) for the machinery; the route table is ready to receive migrated commands.

### Phase 3 — Transport migration and behavior changes

Goal: move every command onto REST via the strangler (expand to one shared core op, migrate the UI, then contract away the WS command), and land the three behavior changes, ordered so policy changes are not entangled with the wire-shape change. The same fanout/UI zone is touched twice on purpose: an ACL/view-semantics failure (3b) stays decoupled from the id-keyed wire migration (3c).

- **3a. Migrate the security-stable groups first.** Tasks, cronjobs (including the RUN-authed run affordances), agent self-affordances, sessions/invites, office settings, validation, backends, and uploads/file-serving move onto the unified REST surface (some routes are stranglers that replace a WS command, others are existing HTTP endpoints retained and now token-authed). These carry no ACL/view or wire-shape dependency, so they prove the new transport end-to-end on low-risk surface.
- **Loopback-bypass removal (a discrete milestone, after 3a).** Once agent and run tokens are issued (2.1) and the documented agent curl snippets carry the `Authorization` header, flip the affordance and message endpoints from loopback-trust to token-required. A running agent has no `ISOMUX_AGENT_TOKEN` until its process env is refreshed, so legacy loopback auth and bearer auth coexist during a grace window: tests pin both paths while it is open, and the flip (which deletes the legacy path and its tests) lands on a restart/respawn boundary. This is its own milestone, not a line inside a resource-group migration.
- **3b. Projection rewrite: rule-based ACL + view-preference split, plus audience-declared events.** Replace the materialized `create_room` owner fan-out with rule-based owner access and explicit member grants; split access (security) from view-preference (per-user order, shown set, `notifRooms ⊆ shown ⊆ accessible`, `defaultRoomId`); delete the `reorder_rooms` access gate (reorder becomes per-user and always allowed) and the `notifRooms` auto-sync; replace the implicit per-WebSocket projection with the declared registry plus emit-helper fan-out. The wire stays dense-index here: the projection/ACL service is built to emit today's shape first, so an ACL/view failure cannot be confused with the wire migration. Migration: members' `allowedRooms` become grants; owners drop `allowedRooms` as an access input and seed their view-preference from it.
  - Gate: a **focused ACL security review** during this sub-phase (a mistake here is a security hole, not a bug).
- **3c. Stable room IDs + id-keyed wire (the one coordinated deploy).** Flatten persistence so each `PersistedAgent` carries an explicit `roomId`; move the wire off dense per-recipient indices to id-keyed maps; convert every `agent.room` consumer to `roomId` and reset the in-memory `currentRoom` selection. Ship server, the production UI, and the demo/`demo-server` client in one coordinated deploy (a single restart), with no dual-shape shim.

Exit: the `dispatchCommand` switch is deleted; the WS carries only the event stream plus the three inbound exceptions (interactive terminal IO, `presence_update`, `ping`); every command is REST.

### Phase 4 — Close-out

- Delete the now-dead surface, only after the strangler leaves it callerless: the ~1,940-line switch, the bespoke `*_response` messages, the `rooms_reordered` broadcast, and the materialized owner-access code.
- Full suite plus ESLint, and a final review pass.
- Extract the Testing strategy section into a standalone, maintained testing guide (tiers, how to run them, seams, conventions, reflecting what was actually built) and register it in `internal-docs/documentation.md` in the same change, so the doc index does not drift. This document stays the design and decision record; the testing guide becomes the living reference.
- File the follow-ups below as tracked tasks.

## Follow-ups (filed as tracked tasks during close-out)

1. Skin / metaphor-agnostic core (existing task f48a9d52): `officeLayout` extraction, desk-as-skin, uncapping the 8-per-room limit, and the reference-client skin. Revisit when a second client is real.
2. Capability-lattice expansion: grow the agent token's capability set additively as agent permissions broaden.
3. Cronjob run-transcript visibility: restrict transcript reads to the owner-user plus office owners (metadata stays office-wide read). Until then it is an accepted known leak, held in check by the agent-token and no-broader-than-browser rails noted in Decided.
4. Feature-plugin architecture: features own their REST endpoints and their agent-facing prompt snippet; the core stays agnostic; the office composes them. This removes the manual sync between feature behavior and the "How to..." prompt sections. The typed route table is its foundation; the cheap now-step is grouping routes into feature modules so prompt docs can later attach to a feature rather than to each route.
5. Clean up accumulated test cruft: ~55 stale temp HOME fixtures in `/tmp` (over 1GB, including a 612MB CI artifact and several 50-94MB dirs) and the throwaway smoke/repro scripts. Preserve the keepers first (`cwd_verify.ts` into the T1 persistence net; `cron-test.ts` and `scripts/v1-smoke.ts` into the gated `test:live` tier). Leave `/tmp/tmp.mxGn13RFM7` (TLS certs and office state) unless confirmed disposable. The cleanup guard above stops future runs from re-accumulating.
6. Dead-code cleanup (Phase 4 close-out sweep), surfaced by Phase 1.4b characterization: the `update_room_settings` "Room not found" branch is unreachable — access is checked before existence, so an unknown room id returns "You don't have access" first, even for an owner. Remove it with the other now-dead surface. Frozen by `routes-settings.test.ts`.
7. Upload-limit reconciliation (Phase 3a, `agents.upload`): the current upload route enforces 5 files / 200MB per file / 400MB total, but the route-table row states 5 / 20MB / 40MB. 3a must treat the tightening as a deliberate behavior change, not an accidental one. The current 200/400 limits are frozen by `routes-affordances.test.ts` so the change is visible in the diff.
