# Isomux Testing Strategy

Status: design proposal, pending sign-off to execute.

## Why now

We are about to do the server/UI decoupling refactor. Its two deepest pieces are:

- **A1**: a centralized projection + auth service (today the per-session ACL projection lives implicitly in the per-WebSocket fanout).
- **B3**: migrating `agent.room` from a mutable array index to a stable `groupId`.

Both are cross-cutting and invariant-heavy. We want a behavioral safety net in place **before** touching them. isomux currently has tests only at the Claude backend adapter seam (`claude.test.ts`, `claude.session.test.ts`, `claude.v1-adapter.test.ts`, `plugin-hooks.test.ts`); the orchestrator, OfficeState, persistence, projection, and the WS/REST surface are untested.

## Principles (adapted from the Pocock TDD skill)

1. **Test behavior through public interfaces, not implementation.** "Code can change entirely; tests shouldn't." Tests must survive the refactor, so they assert observable behavior at public boundaries (WS messages, REST responses, persisted files), never private internals.
2. **Two modes, two jobs:**
   - **Characterization tests** for the *existing* server: observe the running system and freeze its current externally visible behavior. This is the refactor safety net. (Writing imagined behavior is wrong here; the real contract is already encoded in the running app.)
   - **TDD red-green-refactor** for *new* code the refactor introduces (projection service, REST contract, token auth, groupId migration).
3. **README as a coverage map, not a mandate.** Goal: *every README feature has at least one behavioral test of its critical mechanism at the lowest deterministic tier*, prioritizing refactor-adjacent features. Not exhaustive, and not one E2E per visible phrase. Track via the traceability matrix below.
4. **Avoid horizontal slicing.** Do not write all tests up front against speculation. Characterization tests are grounded by observation; new-code tests follow the red-green-refactor loop.

## LLM-call policy (test tiers)

Default `bun test` (CI, PR, pre-commit) makes **zero** LLM calls.

| Tier | LLM? | What | When |
|---|---|---|---|
| **T0 pure/unit** | none | pure functions: prompt assembly, diff summary, fork-chain assembly, usage math, projection helpers | always |
| **T1 integration (FakeBackend + non-backend harnesses)** | none | the main tier: orchestrator/queue/fork/persistence/OfficeState, plus auth/projection/presence/route harnesses; real temp FS, in-process server | always |
| **T2 adapter contract** | none (replay) | real Claude/Codex adapters translate *recorded/curated* event streams correctly | always; refresh on SDK bumps |
| **T3 live smoke** | yes, a few | real-subscription end-to-end; assert invariants only (turn completes, a tool runs, resume works, topic non-empty and <=8 words), never exact text | **opt-in only** |

T3 is gated behind an env flag plus a separate `test:live` script, run manually or nightly, serial, on cheap models. Never in CI/pre-commit.

## Test seams

`FakeBackend` (implements the `Backend` interface, scripts `NormalizedEvent`s) is the **main deterministic engine for T1**, because the Backend seam is already clean and metaphor-free and the A1/B3 work sits above it. It is *not* the only seam. The following surfaces are not below Backend and need focused harnesses:

- **Auth/session/invite/token**: cookie auth, token auth, owner/member roles, origin/CSRF where practical, session revocation, loopback bypass.
- **Projection/fanout**: multi-WebSocket tests with different users and `allowedRooms`, not a single in-process client.
- **Presence**: its own `connectionId` map and recipient-specific room remapping.
- **Terminal/PTY**: narrow fake/stubbed terminal-deps test for routing/ACL; real PTY only opt-in/local.
- **Editor/file/upload/read-file/diff affordances**: HTTP routes + FS helpers; test visibility/auth and path safety explicitly.
- **Cronjobs**: own manager/persistence/transcript/manual-run/edit surface; `FakeBackend` must be injectable here too.
- **Safety hooks / plugin hooks / env loading**: pre/post orchestration and prompt/env assembly; pure or targeted T1.
- **Codex App Server subprocess lifecycle**: adapter contract + opt-in live/subprocess smoke, not part of the main net.

## Infrastructure prerequisites

1. **Configurable state root.** Persistence is homedir-hardcoded (`~/.isomux`) far more widely than it first appears: ~20 files / ~79 references (auth, persistence, logs, cronjobs, users, files, migrations, skills, plugins, safety-hooks, cwd-utils, backup, terminal, command-handlers, isomux-diff), with no config-root abstraction today. Introduce a single config module for the state root (`ISOMUX_HOME`-style override) and migrate callers incrementally. Do this carefully or tests will mix real `~/.isomux` state with temp state.
2. **Cleanup guard** that refuses destructive cleanup outside a temp dir (a stray `rm -rf` in a test must never touch real `~/.isomux`).
3. **`FakeBackend`** + scripted-event helpers. There is no backend dependency-injection hook today: `getBackend()` is called directly at ~14 sites inside `agent-manager`, `cronjob-manager`, and `index.ts`, so building the injection seam (a registry override or a resolver parameter) is itself a prerequisite, not just wiring. Then make FakeBackend injectable into both `AgentManager` and `CronjobManager`. The entire T1 tier depends on this.
4. **In-process server harness** that can connect multiple authenticated users/sockets against temp state.
5. **package.json scripts**: `test` (no LLM) vs `test:live` (gated).

## Projection / ACL characterization checklist (capture before B3)

This is the highest-value net for both A1 and B3. Freeze current behavior for:

- Two users with overlapping but non-identical `allowedRooms` connect simultaneously; `full_state` rooms are filtered and `agent.room` is dense per recipient.
- A hidden-room agent emits `log_entry`/`slash_commands`/`terminal_output`/session list; the restricted user never receives it.
- Moving an agent visible->hidden, hidden->visible, visible->visible triggers the right refresh/replay and no stale transcript loss.
- Room close/reorder with restricted users: dense indices remap, visible agents stay correct, presence is rebroadcast, logs/slash commands replay where expected.
- Owner with hidden rooms: main view respects `allowedRooms`, but owner-only `all_rooms_list` stays unfiltered.
- `create_room` grants the creator and current owners, not other members; `allowedRooms` and `notifRooms` stay in sync.
- `update_user` `allowedRooms` by an owner pushes a projected `full_state` to that user's existing sockets and clamps presence if access was revoked.
- Killed-agent summaries are filtered by `lastRoomId` before the cap; revive requires access to both the target room and `lastRoomId`.
- `list_sessions`/load logs for hidden agents do not leak ids/topics/timestamps.
- `presence_update` from a restricted user uses that user's dense visible index, stores the global `roomId`, and emits recipient-specific indices.
- Agent-to-agent `POST /agents/:id/message` identity lookup does not become a room/ACL leak when one agent is in a hidden room (see Policy edge below).

## Persistence and migration tests

- Round-trip: write then load agents/users/tasks/cronjobs; assert shape and field preservation.
- Existing load-time migrations (e.g. `modelFamily`/`agentType` backfill, per-room envFile strip).
- **B3 migration**: seed pre-migration persisted state (note: `agents.json` today nests `PersistedAgent`s under rooms; `agent.room` is the in-memory/wire shape derived on load, not a persisted field) plus any legacy/compat fixture intentionally supported, with room ids referenced in users (`allowedRooms`/`notifRooms`/`defaultRoomId`) and killed-agent summaries; assert post-migration shape and the compatibility projection. Migration bugs are likely and expensive.

## API contract tests before implementation

Before REST exists, write a small spec/table for the intended resources, the auth policy per resource, and the streaming exclusions (log stream, terminal, presence stay on a streaming channel, not request/response). Then TDD the implementation against that spec. This doubles as the refactor's "define the contract first" deliverable: the contract is expressed as tests.

## Sequencing

1. Configurable state root + cleanup guard.
2. `FakeBackend` injection into `AgentManager` and `CronjobManager`.
3. In-process server harness with multiple authenticated users/sockets and temp state.
4. Projection/ACL characterization tests (highest-value net for A1 and B3).
5. Persistence/migration characterization.
6. Queue/resume/fork/usage tests.
7. Route-level tests for tasks/cronjobs/uploads/settings/recentCwds/auth policy.
8. Adapter fixtures (hand-curated, minimized), then opt-in live smoke. Build a recorder only when fixture refresh becomes painful (it carries privacy/sanitization/versioning burden).

UI E2E (Playwright) stays thin: "browser connects, renders projected state, performs a core command." The server harness carries the combinatorics.

## Policy edge

Today's loopback affordance endpoints (agent-to-agent `/message`, `/diff`, `/read-file`, `/edit-file`, `/terminal-command`) are trusted local IPC. A public token API cannot inherit that trust model unchanged. Decide per endpoint whether it stays a local-agent affordance or becomes part of the authenticated public surface. This is a concrete instance of the refactor's open question "do non-browser clients get browser-equivalent power or a narrower automation surface."

## Traceability matrix (seed)

Columns: README claim | risk tier | deterministic test path | live/manual coverage | owner.

| README claim | tier | deterministic test path | live/manual |
|---|---|---|---|
| Multi-provider (mix Claude + Codex) | T2/T3 | adapter contract fixtures per backend | T3 smoke per provider |
| Subscription auth ("works if CLI works") | T3 | env-detect unit; login-instructions unit | T3 manual login |
| Agents message each other (queue) | T1 | FakeBackend: POST /message enqueues; coalescing order | - |
| Shared task board | T1 | route + OfficeState task CRUD | - |
| Hierarchical system prompts | T0 | prompt assembly office/room/agent layering | - |
| Custom commands | T1 | slash_commands surfaced to client | - |
| Collaborate in conversations (multi-user) | T1 | multi-socket mixed human/agent queue | - |
| Live presence (ghosts) | T1 | presence harness: connectionId map, recipient indices | - |
| Invite-link access | T1 | auth harness: mint/accept/consume/expire | - |
| Self-hosted reachable / real-time | T1 | full_state on connect + delta sync | - |
| Mobile UI | manual | - | visual |
| Visual office / animated characters / skeuomorphic / themes | manual | - | visual |
| Auto-generated topic | T1/T3 | endpoint returns non-empty <=8 words (mechanism) | T3 quality spot-check |
| Terminal | T1 | routing/ACL with stubbed PTY | opt-in real PTY |
| Editor | T1 | editor_open/save/external-change routes + path safety | - |
| Diff tool | T0/T1 | diff summary unit + POST /diff route | - |
| Voice-to-text / TTS | manual | - | browser manual |
| Cron jobs | T1 | CronjobManager + FakeBackend: schedule/fire/run transcript/manual-run | - |
| Image/PDF attachments | T0/T1 | buildUserMessage attachment inlining (exists: `server/backends/claude.ts`, tested in `claude.test.ts`) + upload route | - |
| Conversation branching | T1 | fork-chain assembly + usage accounting | - |
| Notifications | T1 | turnHadHumanInput gating (mechanism) | - |
| Pre-tool-call safety hooks | T0/T1 | hook blocks dangerous commands | - |
| Plugin system | T1 | plugin pre/post turn hooks (partial coverage exists: `server/plugin-hooks.test.ts`) | - |
