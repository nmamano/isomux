# Receptionist loop - standing orders + slice handoffs

Re-read this file at the start of every iteration. Conversations compact; this file does not.

Owner: Nil. Runner: Nil's Direct Helper. No reviewer (self-review checklist per slice; a reviewer pass before merge is parked for Nil).
Worktree: ~/nil/isomux-worktrees/lobby (branch `lobby`; this loop starts at b01bb5d, 2026-09-05, on top of the lobby scene loop and the members chat loop).
Sibling loops in the same worktree: plans/lobby-loop.md (the SCENE, Nil's other session) and plans/members-chat-loop.md (complete). This loop never edits ui/office/lobby/* except the ONE placement hook named in slice 3.

## North star

A receptionist agent: the only agent in the lobby scene, standing by the counter, that every user of the office can open and talk to - including a member with zero rooms. It answers questions about Isomux in general and about THIS office, and points confused users at the right place. It runs on a free OpenCode model by default; an owner can put a better model or another engine behind it. It cannot be killed, moved or renamed.

Nil's spec (2026-09-05): a receptionist agent on a free OpenCode model, with a system prompt that answers questions about isomux in general and about this office; where confused isomux users go. The only agent in the lobby scene; it cannot be moved. Its backend/model is customizable; how much else is customizable is my call. Starting prompt based on the isomux.com chatbot prompt (api/chat.ts SYSTEM_PROMPT) plus office-specific knowledge.

## Design (decided 2026-09-05; cite the files)

Identity and projection:
- `LOBBY_ROOM_ID = "lobby"` and `LOBBY_ROOM` (`{ id: "lobby", name: "Lobby", prompt: null }`) in shared/types.ts. Not an 8-hex id, so it never collides with a room. The lobby stays OUT of officeState.rooms, allowedRooms, notifRooms and every room list; it exists only as the receptionist's roomId.
- AgentInfo gains `receptionist?: true` (shared/types.ts); PersistedAgent carries it too. One receptionist per office, name "Receptionist", desk 0, roomId "lobby".
- Access: `canAccess(user, LOBBY_ROOM_ID)` is true for every user (server/isomux-office.ts). That one predicate makes roomAllowedForSession, sessionsForRoomAccess (event fan-out), hasRoomAccessForUser (route guards via agentParam) and agentVisibleForSession reach every session. `projectAgentForSession` passes the receptionist through before the room-index lookup. The emit seam's roomIdForAgent and guard-deps roomIdForAgent accept "lobby" as live.
- Room lists never contain the lobby, so `visibleRoomProjection`, room tabs and desk counts are untouched. Routes that take a room id and get "lobby" fall to the handlers' own 404 (spawn, revive, close, rename, swap-desks): pinned.
- Manifest (GET /agents and agents-summary.json): the receptionist is listed for every identity with `room: null`, `roomName: "Lobby"`, `roomId: "lobby"`.

Reach of the receptionist's OWN token (the safe default, widening parked for Nil):
- Its bearer token is minted with `userId: null` (server/identity/tokens.ts mintAgentToken), so guard-deps hasRoomAccess and accessibleRoomIdsForIdentity give it NO room: no other agent's logs or instructions, no room task boards (office-global tasks only), no killed-agent logs, no apps, no boss memory. Its AgentInfo.userId stays the owner's (env, manager display, provider accounts). Its prompt loads office + agent memory only (never room or boss scopes). Its system prompt carries no curl recipes.
- Filesystem reach is the box's, like any agent: out of scope here, noted in the report.

Lifecycle:
- Persisted in `<STATE_ROOT>/receptionist.json` (one PersistedAgent + lastSessionId), never inside agents.json (which nests agents under rooms; a self-hoster downgrading keeps a clean agents.json). Loaded after rooms at boot through restoreOrReviveAgent with an explicit roomId override.
- Ensured twice: on the first-owner hook after the welcome agents (server/isomux-office.ts setOnOwnerCreated) and at boot when an owner exists and no receptionist was restored (existing offices, this office included). Model: the free OpenCode discovery used for the Free Welcome Agent; no free model -> OPENCODE_DEFAULT_MODEL with a warning, never absent.
- Locked: kill (409 receptionist_locked), move (409), rename (409), spawn into "lobby" (404 room_not_found). Editable: engine, model, effort, permission mode, sandbox, cwd, outfit, custom instructions ("extra instructions" on top of the base prompt), privileged flag (owner-only route as today; harmless with a null-user token).
- Kill history / revive never see it.

Prompt (slice 2): `buildReceptionistSystemPrompt` in server/system-prompt.ts (Nil's rule: guidance ships in code). Composition: identity + voice + `ISOMUX_KNOWLEDGE` (the product knowledge and guidelines of api/chat.ts, exported from that file so the two never drift) + this office (office name, member names and roles, the office-wide prompt, office memory) + what it cannot see and where to send people + the owner's extra instructions. No affordance recipes.

Scene (slice 3): each layout in ui/office/lobby/layouts.ts gains a `receptionist: { a, b }` floor slot; LobbySceneProps gains `receptionist?: ReactNode` drawn in painter's order at that slot with a contact shadow. That is the whole scene change. The mount (ui/office/OfficeView.tsx) fills it with a Character (ui/office/Character.tsx) plus a nametag; click -> `focus`; right-click -> context menu without Kill.

## Process per slice

plan (PICKUP block) -> implement -> commit -> gates on the committed hash -> self-review checklist -> tick the checkbox -> author the next PICKUP.

Self-review checklist:
1. Every gate log opens with the committed hash and ends with exit=0.
2. No file in ~/nil/isomux (main) or another worktree touched.
3. ui/office/lobby/* untouched except layouts.ts (the slot) and LobbyScene.tsx (the prop) in slice 3.
4. Every grant and every denial the design names is pinned by a harness test, not asserted in prose.
5. A scripted edit was grepped before anything depended on it.
6. UI slices: screenshots exist for dark and light and were LOOKED AT (Read the PNG).
7. Doc surfaces (internal-docs/documentation.md) touched when the change makes them stale.

## Gates per slice (always-run, offline, nothing costs money)

Run in the worktree AFTER the commit, on the committed hash:

    H=$(git rev-parse HEAD)
    (echo $H; bun run build:ui; echo exit=$?) > /tmp/recep-build.log 2>&1
    (echo $H; systemd-run --user --scope -q -p MemoryMax=2G bun test <scoped files>; echo exit=$?) > /tmp/recep-test.log 2>&1
    (echo $H; bunx eslint <touched files>; echo exit=$?) > /tmp/recep-eslint.log 2>&1
    # when ui/demo-server.ts or shared/storage-labels.ts changes:
    (echo $H; bun run build:demo; echo exit=$?) > /tmp/recep-demo.log 2>&1
    # UI slices: screenshots through the demo bundle (port 9878), PNGs in /tmp/recep-shots/slice-N/

Scoped test set (grow it as files appear): server/test-support/receptionist.test.ts, server/test-support/onboarding.test.ts, server/test-support/routes-agents-rest.test.ts, server/test-support/routes-agents-manifest.test.ts, server/test-support/projection.test.ts, server/test-support/guard-deps.test.ts, server/test-support/guards.test.ts, server/test-support/emit.test.ts, server/test-support/system-prompt.test.ts, server/test-support/routes-rooms-rest.test.ts, api/chat-prompt.test.ts, ui/office, ui/store.test.ts, ui/components/AgentListView.test.ts (if created), ui/demo-server.test.ts.
Read the exit= line of each log; never a pipeline status. A gate failure is fixed in the slice or queued; gates are never weakened.
Once, before the final report: `(echo $H; systemd-run --user --scope -q -p MemoryMax=2G bunx tsc --noEmit; echo exit=$?) > /tmp/recep-tsc.log 2>&1` (about 60 s).
Baseline (2026-09-05, b01bb5d): tsc exit=0; Chrome 151.0.7922.137; bun 1.3.11; playwright-core at ~/nil/wallgame/node_modules.
Safety hook: every write target in a shell command must be an ABSOLUTE path; invoke scripts with `bash`, never chmod +x.

## Standing rails (prohibitions)

- Never edit files in ~/nil/isomux (main) or in any other worktree.
- Never restart the isomux server. Never push. Never merge. Never run prettier.
- Never edit ui/office/lobby/* beyond the slot in layouts.ts and the `receptionist` prop in LobbyScene.tsx.
- Never store a lobby in officeState.rooms or in any user's allowedRooms / notifRooms.
- Never let the receptionist's token reach a room: every read it could leak (other agents' logs, room tasks, room memory, killed logs) has a test pinning the denial.
- Never let the receptionist be killed, moved, renamed or spawned twice; a test pins each.
- Never put the receptionist's guidance in office or room memory.
- Never start slice N+1 with slice N uncommitted. One commit per slice.
- Never message Isomux PM or the reviewers. No agent traffic in this loop.
- Keep chat quiet until the final report; interim messages only as "(orchestration chatter: ...)". Answer Nil inline if he asks.
- Never pkill by name; keep a static server's PID and kill that.
- Never read, archive or scan ~/.claude/projects/.

## Slice plan

- [x] 1 Server core: constants + flag, OfficeState receptionist spawn and locks, agent-manager spawn/restore/persist/manifest/token, isomux-office ACL + projection + ensure-at-boot-and-claim + REST rejections, guard-deps; harness tests.
- [x] 2 Prompt: ISOMUX_KNOWLEDGE export in api/chat.ts, buildReceptionistSystemPrompt, wiring in createSession and /isomux-system-prompt, manifest note in the ordinary prompt; tests.
- [x] 3 UI: scene slot + prop, OfficeView figure with focus and context menu, mobile row, presence, dialog locks, sound; demo seed and screenshots; tests.
- [x] 4 Docs (features.md, api/chat.ts feature line, internal-docs/documentation.md), tsc, completion note, report.

## Deferred / parked (do not pick up)

- Widening the receptionist's reach (to its manager's rooms, or per-asker): Nil's decision; recommendation in the report.
- A per-office switch to remove the receptionist: not asked; Nil said it cannot be killed.
- Ghosts in the lobby, Tab cycling into the lobby, scene layout pick: parked from the earlier loops.

## Resources

- Welcome-agent seed: server/isomux-office.ts registerBootHooks (~line 537-705): WELCOME_AGENTS, spawnWelcomeAgent, welcomeOpenCodeModel, setOnOwnerCreated. Boot order at ~line 5959 (registerBootHooks) and 5770 (restoreAgents awaited).
- ACL: canAccess ~1329, accessibleRoomIdsFor ~1336, accessibleRoomIdsForIdentity ~1642, visibleRoomProjection ~3799, projectAgentForSession ~3867, agentVisibleForSession ~3891, sendProjectedFullState ~3920, emit deps roomIdForAgent ~1493, GET /agents ~5165 (filter at ~5245).
- Guards: server/identity/guard-deps.ts (hasRoomAccess null-user rule, roomIdForAgent liveness), server/identity/guards.ts (agentParam via requiresRoomAccess ~333, killedAgentLogAccess ~620).
- Tokens: server/identity/tokens.ts mintAgentToken(agentId, userId, privileged); minted in agent-manager at spawn (~5095), restore (~1879), setPrivileged (~4211).
- OfficeState: shared/office-state.ts spawn ~191 (name dedupe, room check, desk scan), kill ~305, editAgent ~330, moveAgent ~489, closeRoom ~456, swapDesks ~403.
- agent-manager: spawn ~4940, restoreOrReviveAgent ~1666 (roomIdx -> roomId), restoreAgents ~2004, persistAll ~1478, roomById ~899, getAgentDisplay ~908, manifestEntries ~1375, memoryRefsFor ~4803, createSession ~4845 (buildSystemPrompt call ~4896), kill ~7245.
- Persistence: server/persistence.ts PersistedAgent ~645, Room ~695, loadAgents, saveAgents ~831, buildManifest ~863 (room + 1), atomicWriteFileSync.
- REST deps: server/isomux-office.ts agentsHandlers register ~2829 (kill, move, spawn ~2872, edit ~2962); handlers in server/routes/handlers/agents.ts (fail(status, code, message)).
- Prompt: server/system-prompt.ts buildSystemPrompt (~43), memorySection (~324), rewriteOpenCodeOfficeCommands; /isomux-system-prompt in server/command-handlers.ts ~750; api/chat.ts SYSTEM_PROMPT (~41-251) and api/chat-prompt.test.ts.
- Harness: server/test-support/harness.ts (startTestServer, seedOwner bypasses the owner hook; onboarding.test.ts claimOwner drives the real claim; restart() cold-reloads STATE_ROOT). Models: routes-agents-manifest.test.ts, projection.test.ts, routes-tasks-rest.test.ts.
- UI: ui/office/OfficeView.tsx (lobby branch ~504, desk click ~650, star ~178), ui/office/DeskUnit.tsx (Character placement, nametag), ui/office/Character.tsx, ui/components/AgentListView.tsx (lobby branch ~118), ui/components/ContextMenu.tsx (Kill ~217), ui/components/EditAgentDialog.tsx (name ~1537, desk line ~1089), ui/App.tsx (presenceRoomId ~346, Tab ~488), ui/device-settings.ts shouldNotifyRoom, ui/office/lobby/layouts.ts + LobbyScene.tsx LobbyProps (~411), geometry.ts floorXY.
- Demo: ui/demo-server.ts OFFICE_CHARACTERS (~185), seedOffice (~408), agent shim (~2339); scripts/members-chat-shots.sh + .mjs (Playwright through the demo bundle on port 9878).
- Docs: internal-docs/documentation.md; docs/features.md "Multi-provider" (line 13) and "Multi-user" (line 44); api/chat.ts feature list.

## SLICE-1 PICKUP (authored 2026-09-05)

Baseline: b01bb5d + the commit that adds this file.
Goal: the receptionist exists on every office with an owner, reaches every session, is locked against kill/move/rename, and its own token reaches no room - all over the real HTTP and WS surface.
Mechanics:
- shared/types.ts: `LOBBY_ROOM_ID`, `LOBBY_ROOM`, `AgentInfo.receptionist?: true`. server/persistence.ts: `PersistedAgent.receptionist?: true`; `RECEPTIONIST_FILE = join(ISOMUX_DIR, "receptionist.json")`, `loadReceptionist(): PersistedAgent | null`, `saveReceptionist(p | null)`.
- shared/office-state.ts spawn: `receptionist?: true` in opts -> skip the room check and desk scan, roomId LOBBY_ROOM_ID, desk 0, flag stamped; a second receptionist returns null. kill/moveAgent return [] for the receptionist; editAgent ignores `name` for it.
- agent-manager: `spawnReceptionist({ cwd, modelFamily, permissionMode, outfit, userId, username })` (reuses spawn's body via a shared internal `spawnWith(opts)`; spawn keeps its positional signature); restoreAgents reads receptionist.json after the room loop (restoreOrReviveAgent gains `roomIdOverride`); persistAll writes it separately and never into a room bucket; roomById("lobby") returns LOBBY_ROOM; memoryRefsFor for the receptionist = office + agent; `mintAgentToken(id, receptionist ? null : userId, ...)` at the three mint sites; manifestEntries: room null + roomName "Lobby" (ManifestAgentInput.room: number | null; buildManifest keeps `+1` only for numbers); kill() returns without effect for the receptionist; `getReceptionist()`.
- isomux-office: canAccess lobby; projectAgentForSession pass-through; emit roomIdForAgent + guard-deps roomIdForAgent accept lobby; GET /agents filter includes lobby entries; `ensureReceptionist(ownerUsername)` (free-model discovery as the welcome agent, default model fallback) called from the owner hook after the welcome agents and at boot after restoreAgents when an owner exists; REST deps: kill/move/edit(name) -> `{ ok: false, reason: "receptionist_locked" }` mapped to 409 in the handlers.
- Presence: a `currentRoomId` of "lobby" from a client sanitizes to null (it already does: the rooms membership check).
- Tests in server/test-support/receptionist.test.ts (harness): claim -> four agents, the receptionist roomId lobby, flag, token userId null; restart -> still one, from receptionist.json; boot with an owner and no file -> spawned; zero-room member: full_state carries it, log_entry from its turn reaches the member's socket, POST message 201/202, GET its logs 200, GET another agent's logs 403; owner: DELETE 409, POST move 409, PATCH name 409, PATCH modelFamily 200, spawn roomId lobby 404, DELETE /api/rooms/lobby 404, swap-desks lobby 404; the receptionist's token: GET /agents lists only itself with room null, GET another agent's logs 403, GET /api/tasks shows global tasks only; a user spawn named "Receptionist" -> 409 name_taken. Update onboarding.test.ts counts (3 -> 4 where the claim runs) and any manifest test that counts entries.
Acceptance: scoped tests exit=0 on the committed hash; build:ui and eslint green.
Locked: the constants, the flag, the file name, the 409 code `receptionist_locked` (slices 2-4 depend on them).

## SLICE-2 PICKUP (authored after slice 1 committed)

What slice 1 taught: agent-to-agent delivery is office-wide by design (messageSend's agent branch checks the sender only), so the receptionist's reach rule needed a refusal in the office's sendAsAgent and scheduleMessage deps (403 receptionist_reach), not a guard change; the harness's seedOwner skips the owner hook while /auth/claim runs it, and restart() re-runs the whole boot so the boot-ensure fires there; the two result unions that carry an HTTP status had no 403 member. A full typecheck is about 60 s; run it in the background while writing tests.

Goal: the receptionist speaks from a purpose-built prompt: Isomux knowledge, this office, its limits, the owner's extras - and no affordance recipes.
Mechanics:
- api/chat.ts: split SYSTEM_PROMPT into the site voice header and an exported `ISOMUX_KNOWLEDGE` (from "## What is Isomux?" through the Guidelines); SYSTEM_PROMPT stays byte-identical as their concatenation (api/chat-prompt.test.ts pins the composition).
- server/system-prompt.ts: `buildReceptionistSystemPrompt(input)` with input { agentName, officeName, members: {name, role}[], officePrompt, customInstructions, autoLoadedMemory, publicOrigin }: identity and voice (in the office, not on the website), ISOMUX_KNOWLEDGE, "This office" (name, members and roles, the office-wide instructions), what it cannot see and where to send people (an owner for room access, /help, the docs, Discord), the no-secrets rule, the owner's extra instructions, memorySection. No curl, no bearer token, no OpenCode rewrite.
- agent-manager createSession: branch on managed.info.receptionist (members from listUsers()); command-handlers /isomux-system-prompt: same branch through a new CommandDeps member `receptionistSystemPrompt(managed)`.
- The ordinary prompt's manifest sentence gains one clause: the receptionist is listed with room null and roomName "Lobby".
- Tests: system-prompt.test.ts (office name, member names, office prompt, extras, memory, the knowledge marker, no ISOMUX_AGENT_TOKEN, no curl, no room prompt), api/chat-prompt.test.ts (composition), receptionist.test.ts (the fake backend's createSession received a prompt naming the office and no bearer token).
Acceptance: scoped tests exit=0 on the committed hash; build:ui and eslint green.
Locked: the function name and input shape (slice 4's docs cite them).

## SLICE-3 PICKUP (authored after slice 2 committed)

What slice 2 taught: the shared knowledge mentions "curl cards" as a feature, so a no-recipes assertion must look for the recipe shape ("curl -s", "Authorization: Bearer"), not the word; the pure builder reads the boot-stable public origin itself (like buildSystemPrompt) so agent-manager needs no auth import; a nested template literal inside a python heredoc turns \n into a real newline - write those lines with the file's own bytes and cat -A them.

Goal: the receptionist stands by the counter in the lobby, a click opens its chat like any agent, a phone lists it above the members chat, the dialogs respect the locks, and the demo shows it - all seen in screenshots.
Mechanics:
- ui/office/lobby/layouts.ts: `LayoutSpec.receptionist: { a, b }` - lounge (3.6, 0.1) behind the counter (painter's order puts the counter over its legs), fireside (7.9, 0.9) by the directory board, nook (7.8, 0.9). ui/office/lobby/LobbyScene.tsx: `LobbySceneProps.receptionist?: ReactNode`; LobbyProps draws it as one more floor item at that slot (ContactShadow rx 14 ry 7, then the node translated to floorXY). Nothing else in ui/office/lobby changes.
- ui/office/ReceptionistFigure.tsx (new, outside the scene): `<g style={{ pointerEvents: "auto", cursor: "pointer" }} onClick onContextMenu>` holding the Character (ui/office/Character.tsx, its feet at viewBox y 60, so translate(-26 -60)) and an SVG nametag pill above the head (name, state dot, unread badge). Static-markup test.
- ui/office/OfficeView.tsx: find the receptionist in `agents`; pass the figure to LobbyScene with `viewport.wrapClick(() => dispatch focus)` and the context-menu callback; exclude it from employeeOfTheMinute.
- ui/components/AgentListView.tsx (mobile): when lobbyOpen, a receptionist row (portrait Character, name, topic, "..." menu) above the members chat panel.
- ui/App.tsx: presence reports no room while the receptionist is focused. ui/store.tsx: the turn-end sound fires for the lobby regardless of notifRooms.
- ui/components/ContextMenu.tsx: no Kill entry for the receptionist. ui/components/EditAgentDialog.tsx: name input locked with a hint, the desk line reads "Lobby".
- ui/demo-server.ts: seed a receptionist (roomId LOBBY_ROOM_ID, receptionist true, opencode, desk 0) outside the embed; a receptionist-specific canned reply.
- Shots: scripts/receptionist-shots.sh + .mjs (model: scripts/members-chat-shots.*): the Lobby tab dark and light at 1280x800, the receptionist chat after a click, and the 390x844 mobile list; PNGs in /tmp/recep-shots/slice-3/, copied to ~/nil/lobby-gallery/receptionist/.
- Tests: LobbyScene.test.tsx (every layout has a slot inside the floor; a passed node renders in the lounge markup), ReceptionistFigure.test.tsx, ui/demo-server.test.ts (the seeded receptionist), ui/store.test.ts if the sound rule moves into the reducer.
Acceptance: build:ui, build:demo, scoped tests (ui/office, ui/store.test.ts, ui/demo-server.test.ts, ui/components), eslint on touched files, all exit=0 on the committed hash; PNGs looked at.

## SLICE-4 PICKUP (authored after slice 3 committed)

What slice 3 taught: the viewport captures the pointer on pointerdown unless the target matches its blocker selector, so any clickable thing inside the scene needs `data-no-pan` (the desks have it); Playwright clicks the bounding-box centre, so an SVG figure needs a transparent hit rect or the click falls through a gap; the Character element is 40x68 with a 52x68 viewBox, so its drawing is 0.77-scaled and centred (feet at y 54.2) and it needs scale 2 to stand at the lobby's furniture scale; the demo's usage report indexed rooms with a non-null assertion, and the real one named an unknown room "?" - both now say Lobby. A hit-test probe through Playwright (elementsFromPoint at several points) beats theorising about pointer-events.

Goal: the doc surfaces say what shipped, the full typecheck is green on the final hash, and Nil gets the report with the parked queue.
Mechanics: docs/features.md gets a Receptionist bullet next to the welcome-agents bullet under "Multi-provider" and a line under "Multi-user" beside the Members chat (Nil's voice: listed for his review, never applied to main by me); api/chat.ts ISOMUX_KNOWLEDGE gets the same fact in the Office View list; internal-docs/documentation.md's system-prompt entry names buildReceptionistSystemPrompt and the receptionist.json file; README and landing untouched (not headline). Gates: build:ui, scoped tests (api/chat-prompt.test.ts, server/test-support/system-prompt.test.ts, server/test-support/receptionist.test.ts), eslint on touched files, `bunx tsc --noEmit` once. Then the completion note and the report.

## COMPLETION NOTE (2026-09-05, about 20:30 box time)

Four slices committed on branch `lobby` after the members chat loop: 43d8e0c (core, ACL, persistence, locks), bc94fb2 (prompt), 980a261 (UI, demo, shots), and the docs commit that carries this note. Every gate green on each hash; tsc clean on the final one. Screenshots in /tmp/recep-shots/slice-3/ and ~/nil/lobby-gallery/receptionist/. Not merged, not pushed, server untouched.

Parked for Nil (this loop): widening the receptionist's reach beyond a zero-room member (recommendation: keep the safe default; the one-line switch is tokenUserIdFor in agent-manager); the three doc lines (features.md x2, api/chat.ts) in his voice; the receptionist's outfit and its spot per layout (a slot per layout in ui/office/lobby/layouts.ts, his scene session moves it); a member can edit the receptionist's model and instructions today (agent:manage plus lobby access - pinned in the test, easy to narrow to owners); reviewer pass, merge and restart (server code changed; existing offices get their receptionist at the first boot after).
