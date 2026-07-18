# Testing Guide

The maintained reference for Isomux's test suite: the tiers, how to run them, the seams, and the conventions. This is the living companion to [`generic-runtime-refactor.md`](generic-runtime-refactor.md) (the server-refactor design and decision record): that doc explains *why* the test net was built this way, this one tracks *what exists* and how to work with it. Keep it current as the suite evolves.

## How to run

- `bun test` — the default. Zero LLM calls, so it is safe for CI, PRs, and pre-commit. This is the whole suite except the live smoke tier.
- `bun run test:live` — `ISOMUX_TEST_LIVE=1 bun test`. Adds the gated live smoke tier (T3 below): a few real-subscription, end-to-end checks against real backends. Run it manually or nightly, never in CI or pre-commit.
- `bun run lint` (ESLint) and `bun run format:check` (Prettier) round out the pre-review checks.

## Tiers (LLM-call policy)

Default `bun test` makes zero LLM calls.

| Tier | LLM? | What | When |
|---|---|---|---|
| T0 pure/unit | none | pure functions: prompt assembly, diff summary, fork-chain assembly, usage math, projection helpers | always |
| T1 integration (FakeBackend + non-backend harnesses) | none | the main tier: orchestrator/queue/fork/persistence/OfficeState, plus auth/projection/presence/route harnesses; real temp FS, in-process server | always |
| T2 adapter contract | none (replay) | real Claude/Codex adapters translate recorded/curated event streams correctly | always; refresh on SDK bumps |
| T3 live smoke | yes, a few | real-subscription end-to-end; assert invariants only (turn completes, a tool runs, resume works, topic non-empty and at most 8 words), never exact text | opt-in only (`test:live`) |

T3 is gated behind the `ISOMUX_TEST_LIVE` env flag plus the separate `test:live` script, run manually or nightly, serial, on cheap models. Never in CI or pre-commit.

## Principles

1. Test behavior through public interfaces, not implementation. Tests assert observable behavior at public boundaries (WS messages, REST responses, persisted files), never private internals, so they survive refactors.
2. Two modes, two jobs. Characterization tests freeze existing externally visible behavior (the refactor safety net); TDD red-green-refactor drives the new code (projection service, REST contract, token auth, stable room IDs).
3. The feature inventory as a coverage map, not a mandate. Every feature in the canonical inventory (`docs/features.md`) has at least one behavioral test of its critical mechanism at the lowest deterministic tier. Tracked via the traceability matrix below.
4. Avoid horizontal slicing. Do not write all tests up front against speculation: characterization tests are grounded by observation, new-code tests follow red-green-refactor.

## Seams and where they live

`FakeBackend` (implements the `Backend` interface, scripts `NormalizedEvent`s) is the main deterministic engine for T1: the Backend seam is clean and metaphor-free, and the projection/stable-id work sits above it. It is injected through constructor DI (`ManagerDeps` into `AgentManager`, `CronjobManagerDeps` into `CronjobManager`). Tests: `fake-backend.test.ts`, `agent-manager.di.test.ts`, `cronjob-manager.di.test.ts`.

Surfaces that are not below the Backend seam have their own harnesses. Tests under `server/test-support/` are named bare; tests elsewhere carry their path.

- **Auth / session / invite / token** — cookie and token auth, owner/member roles, session revocation, the removed agent-affordance loopback bypass, token lifecycle (mint/rotate on spawn/revive, revoke on kill/delete), redaction (the token never appears in prompts, logs, errors, diffs, or over WS), and the object-level guards (`agentParamMustEqualTokenAgent`, `requiresRoomAccess`, `cronjobOwnerOrOfficeOwner`, `selfOrOwner`). Tests: `routes-auth.test.ts`, `identity-tokens.test.ts`, `identity-lifecycle.test.ts`, `guards.test.ts`, `guard-combinators.test.ts`, `guard-deps.test.ts`, `routes-invites-rest.test.ts`, `routes-sessions-rest.test.ts`, `routes-access-rest.test.ts`.
- **Projection / fanout** — multi-WebSocket tests with different users and access grants; the event registry (every event type declares an audience and projection, a single emit helper is the only wire path, and no raw `ws.send`/`broadcast` exists outside the dispatcher); preference writes never leak hidden-room existence. Tests: `projection.test.ts`, `emit.test.ts`, `event-registry.test.ts`, `dispatch.test.ts`, `view-routes.test.ts`, `user-settings.test.ts`, `user-wire.test.ts`.
- **Presence** — its own `connectionId` map and recipient-specific room remapping. Tests: `presence.test.ts`.
- **Route contract** — the typed route table, the two-stage dispatcher, idempotency, and the per-resource REST handlers. Tests: `routes-table.test.ts`, `route-executor.test.ts`, `route-match.test.ts`, `idempotency.test.ts`, and the per-resource `routes-*-rest.test.ts` family (agents, conversation, editor, rooms, users, cronjobs + runs, office-settings, backends, uploads, validate, system, tasks, access, invites, sessions, affordances).
- **Stable room IDs** — `roomId` as the authority across server-internal logic and the wire. Tests: `roomid-authority.test.ts` (plus the room-id assertions threaded through `projection.test.ts`).
- **Persistence / migration** — round-trip write/load for agents/users/tasks/cronjobs, the load-time migrations, the stable-room-IDs flatten, and the configurable state root. Tests: `persistence.test.ts`, `migrations.test.ts`, `access-migration.test.ts`, `temp-state.test.ts`, `server/config.test.ts`.
- **Queue / fork / usage** — the message queue and coalescing, conversation branching, and usage accounting. Tests: `queue.test.ts`, `fork-usage.test.ts`.
- **Scheduled messages** — the deliver-later manager (`createScheduledMessageManager`, `ScheduledMessageManagerDeps`: enqueue, display lookup, notify, persistence, clock/scheduler seam — the cronjob-manager DI pattern): firing/catch-up/retry/deadline/ordering, the at-least-once crash window, quota, restart-surviving idempotency, and the corrupt-file quarantine, all against fakes (`scheduled-messages.di.test.ts`); the deliverAt REST branch + outbox routes + restart survival + the scheduled flush-prefix rendering through the harness (`routes-scheduled-messages-rest.test.ts`).
- **Backends / adapters** — the Claude and Codex adapters translating recorded/curated streams, auth-error detection, and subprocess lifecycle. Tests: `server/backends/claude.test.ts`, `server/backends/claude.session.test.ts`, `server/backends/claude.v1-adapter.test.ts`, `server/backends/codex/adapter.test.ts`, `server/backends/codex/native-bin.test.ts`, `server/backends/auth-detect.test.ts`, `server/fable-model.test.ts`. Background-task lifecycle breadcrumbs (`TaskBreadcrumbTracker`: background/foreground filtering, dedupe, skip_transcript, label sanitize): `server/backends/task-breadcrumbs.test.ts`. Live smoke (T3): `server/backends/live-smoke.test.ts`.
- **Safety / plugin hooks** — pre/post orchestration and prompt/env assembly, including a mem0-plugin compatibility pin (plugin pre/post hooks fire and their injected content reaches the prompt). Tests: `server/plugin-hooks.test.ts`.
- **Onboarding / fresh install** — welcome agents spawn across the three backend-availability states. Tests: `onboarding.test.ts`.
- **UI** — store-reducer invariants, the `apiFetch` harness, office grid, and room selection. Tests: `ui/store.test.ts`, `ui/api.test.ts`, `ui/office/grid.test.ts`, `ui/roomSelection.test.ts`, `ui/user-merge.test.ts`.

Most server harnesses live under `server/test-support/`; the in-process server harness (`harness.test.ts`) boots the server against temp state with multiple authenticated users and sockets. Interactive terminal coverage is PARTIAL: the event-registry audience for `terminal_output`/`terminal_exit` is pinned (`event-registry.test.ts`), and the `terminal_open` buffered-replay ACL is now characterized (`projection.test.ts`: a restricted member receives zero `terminal_output` for a hidden agent, the requester gets exactly one, and a second visible user is not re-seeded; the buffer is seeded through the manager's test-only stubbed-terminal seam since FakeBackend has no PTY; task `39ce6225` closed). The broader interactive PTY path (live input/resize/close routing) stays deferred to a future stubbed-PTY/opt-in seam. The Codex subprocess lifecycle is adapter-contract plus opt-in live, not part of the main net.

## Infrastructure

What the T1 tier rests on (all built):

1. **Configurable state root + cleanup guard.** A single config module for the state root (an `ISOMUX_HOME`-style override) defaults to `~/.isomux` so production behavior is byte-for-byte unchanged; tests redirect to a temp dir. The cleanup guard refuses destructive cleanup unless the target realpath-resolves under the OS temp dir, and always refuses the real `~/.isomux`. (`server/config.test.ts`, `temp-state.test.ts`.)
2. **Constructor DI + FakeBackend.** `AgentManager`/`CronjobManager` are instantiable units whose collaborators are injected at construction (`ManagerDeps`: backend resolver, event sink, `officeState`; `CronjobManagerDeps`: backend resolver, event sink, env/user resolution, run persistence, clock/scheduler seam), with a production factory wiring the defaults. `FakeBackend` is injected through the resolver.
3. **In-process server harness.** Boots the server against a temp state root with multiple authenticated users and sockets (`harness.test.ts`).
4. **Script split.** `test` (no LLM) versus `test:live` (gated).

## No-loopback-bypass convention

There is no loopback bypass on the agent self-affordance surface: reads and writes both require identity (cookie or token). Tests pin the end state: the deleted legacy affordance paths (`POST /agents/:id/{diff,edit-file,read-file,terminal-command}` and the cron-run read-file/diff) fail closed (no-bearer 401 at the cookie wall, valid-bearer 404), and the unified `POST /api/agents/:id/messages` route derives the sender from the token/cookie so a token-authed agent cannot spoof another agent's identity (`routes-affordances.test.ts`, `queue.test.ts`). New affordance/message tests must keep asserting that identity is token- or cookie-derived, never body-derived. (The legacy `/tasks`, `GET /cronjobs`, and `/backup/status` loopback reads intentionally remain trusted; their removal is a separate later step.)

## Coverage references

Living "must-stay-covered" lists. When a change touches one of these areas, keep its coverage green.

### Projection / ACL checklist

The highest-value net for both the projection/ACL service and stable room IDs:

- Two users with overlapping but non-identical access connect simultaneously; `full_state` rooms are filtered per recipient, and agents carry a stable `roomId` identical across recipients.
- A hidden-room agent emits `log_entry`/`slash_commands`/session list; the restricted user never receives it.
- Moving an agent visible-to-hidden, hidden-to-visible, and visible-to-visible triggers the right refresh/replay and no stale transcript loss.
- Room close/reorder with restricted users: visible agents stay correct, presence is rebroadcast, logs/slash commands replay where expected. Reorder is per-user; a close is a bare `room_closed` delta (no dense remap, no full_state-on-close).
- Owner with hidden rooms: the main view respects access, while the owner-only `all_rooms_list` stays unfiltered.
- `create_room`: the creator has access, owners have access by rule (no fan-out), other members do not until granted.
- An owner editing a member's `allowedRooms` pushes a projected `full_state` to that user's existing sockets and clamps presence if access was revoked.
- Killed-agent summaries are filtered by `lastRoomId` before the cap; revive requires access to both the target room and `lastRoomId`.
- `list_sessions`/load logs for hidden agents do not leak ids/topics/timestamps.
- `presence_update` from a restricted user sends a global `currentRoomId`; the server validates it against the user's access and stores it, and `presence_list` emits the same id to every recipient, filtered to each recipient's visible rooms.
- Agent-to-agent `POST /api/agents/:id/messages` identity lookup does not become a room/ACL leak when one agent is in a hidden room.

### Persistence and migration

- Round-trip: write then load agents/users/tasks/cronjobs; assert shape and field preservation.
- The load-time migrations (e.g. `modelFamily`/`agentType` backfill, per-room `envFile` strip, the boot owner-grants access migration).
- The stable-room-IDs flatten: a pre-migration persisted shape (agents nested under rooms, `agent.room` derived on load) migrates to the flattened shape where each agent carries an explicit stable `roomId`. Migration bugs are likely and expensive.

### API contract

The full API spec (the Server API Spec section of the design doc) is the contract: every resource, its method, its required capability, its request/response shape, and the audience of any event it emits. Tests are TDD'd against the spec, and the typed route table enforces it in code (validation plus types). Covered by `routes-table.test.ts` plus the per-resource `routes-*-rest.test.ts` family.

## Traceability matrix

Feature → risk tier → deterministic test path → live/manual coverage. A coverage map, not a mandate: every feature in the canonical inventory (`docs/features.md`) should have a behavioral test of its critical mechanism at the lowest deterministic tier.

| Feature | tier | deterministic test path | live/manual |
|---|---|---|---|
| Onboarding / fresh install (welcome agents spawn across not-installed / not-logged-in / logged-in) | T1 (+opt-in T3) | fresh-install harness: temp ISOMUX_HOME, welcome-agent seed, FakeBackend per backend state | T3 live logged-in happy path |
| Multi-provider (mix Claude + Codex) | T2/T3 | adapter contract fixtures per backend | T3 smoke per provider |
| Subscription auth (works if CLI works) | T3 | env-detect unit; login-instructions unit | T3 manual login |
| Agents message each other (queue) | T1 | FakeBackend: POST message enqueues; coalescing order | - |
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
| Terminal | T1 (partial) | event-registry audience for terminal_output/terminal_exit; terminal_open buffered-replay ACL covered (projection.test.ts, task 39ce6225); interactive PTY input/resize/close routing deferred to a future seam | opt-in real PTY |
| Editor | T1 | editor_open/save/external-change routes + path safety; watch deletion/recreation lifecycle + per-path revision guard (file-editor-watch.test.ts, routes-editor-rest.test.ts) | - |
| Diff tool | T0/T1 | diff summary unit + POST diff route | - |
| Browser preview card (preview-url) | T0/T1 | `preview-capture.test.ts`: capturePreview seam with a fake shell-script "browser" — strict validation matrix, host input policy (IP literals, mixed/public DNS, IPv4-mapped v6), no_browser/unreachable/capture_failed/timeout/busy codes, group-kill on deadline, temp-dir cleanup + slot release on every path. REST (`routes-agent-affordances-rest.test.ts`): full path via `ISOMUX_PREVIEW_BROWSER` fake → file-view log_entry with sanitized caption; 400s; cross-agent 403. ROUTE CAPS: `routes-table.test.ts`. | real-Chrome capture (needs Chrome on the box; exercised in normal office use) |
| Voice-to-text / TTS | manual | - | browser manual |
| Cron jobs | T1 | CronjobManager + FakeBackend: schedule/fire/run transcript/manual-run | - |
| Image/PDF attachments | T0/T1 | buildUserMessage attachment inlining + upload route | - |
| Conversation branching | T1 | fork-chain assembly + usage accounting | - |
| Notifications | T1 | turnHadHumanInput gating (mechanism) | - |
| Pre-tool-call safety hooks | T0/T1 | hook blocks dangerous commands | - |
| Plugin system (incl. mem0 memory) | T1 | plugin pre/post turn hooks; mem0 injected content reaches the prompt | - |
| isomux-memory (filesystem cross-agent memory) | T0/T1 | STORE/RENDER (`memory-store.test.ts`): raw line round-trip, sha256 `version`, exact-duplicate guard, op-log entries, version-guarded REPLACE (conflict + force), and per-scope size caps + trim notice — caps are a render/auto-load concern, the REST READ is intentionally UNCAPPED. REST contract (`routes-memory-rest.test.ts`): auth wall, the three verbs (READ/APPEND/REPLACE) across all scopes, server-stamped provenance, exact-dup 409 with matched text, version-mismatch 409, op-log, and the permissive-REPLACE pin (any authenticated agent CAN REPLACE office memory). PROMPT (`system-prompt.test.ts`): auto-load attributed layer + no-boss-path + the three-verb affordance. ROUTE CAPS (`routes-table.test.ts`): `memory.read`/`memory.append`/`memory.replace`. NOTE: authority is permissive on EVERY verb (Nil's product decision); restraint lives in the system-prompt affordance, recovery in the op-log. There are no per-surface curation routes — the settings UI curates through the same `/api/memory` READ/REPLACE verbs (`useMemoryEditor`). | Playwright curation smoke DEFERRED (no e2e infra in repo; behavior covered at T0/T1) — manual UI verification + a future opt-in browser smoke |
