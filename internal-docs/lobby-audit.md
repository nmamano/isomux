> Superseded behavior, 2026-09-08: the receptionist is now an ordinary agent
> created from the Isomux Receptionist profile. Name, cwd, kill, move, prompt and
> token use the normal paths. Its initial cwd is ~; the old directory is left
> on disk. The first owner is its boss. Knowledge and office guidance render at
> spawn into custom instructions. The canonical lobby room has one slot and
> persists in agents.json. Any agent can occupy it; an empty lobby stays empty
> across restarts. The former locks, restricted token, dedicated prompt and
> directory claims below describe the previous implementation only.

# Lobby integration audit

Worktree: `~/nil/isomux-worktrees/lobby`. Audit date: 2026-09-08.
Base: `101414ed09ce363e34dc73c8a8b17cf2ed0cc30a`.
Original lobby tip: `f0c034284fc618efd4086040f342fc0a4c492ce8`.
Main used for rebase: `9df7311a2aee3472d9d5ffcc924a7db5e51b588c`.
R1 approved: `fddc7d5515c7614d871ce04c091547450d9d6691`.

The file inventory in [lobby-audit-files.json](lobby-audit-files.json) records
all 561 main-only files and all 30 files changed by both branches. Generated
provider protocol types, tests, build metadata, and the separate hosted
control plane remain in that complete inventory. The
runtime review below follows the chains that can receive lobby entities.
The five requested clean-merge files were compared with both original sides,
in addition to reading their current runtime consumers.

## Runtime results

| File | What it enumerates | Verdict and reason |
|---|---|---|
| server/identity/index.ts | Identity scopes and capability sets | Pass. chat:members occurs explicitly in USER, API and PRIVILEGED_AGENT only. Main's API user:env rule remains separate. Ordinary agents, cron runs and apps lack the chat capability. |
| server/identity/guards.ts | Scope switches, room references, owner and manager checks | Pass. requiresRoomAccess resolves the target before consulting the adapter. Apps are denied. Null user IDs cannot match an owner or manager. Agent-to-agent messageSend retains its separate sender-identity path; this is not room authority. |
| server/identity/guard-deps.ts | Agent-to-room resolution and user access | Pass. Unknown agents and dangling ordinary room IDs resolve to null. lobby is an explicit live-room exception. hasRoomAccess returns false before consulting live state when identity.userId is null. |
| server/isomux-office.ts | Production ACL, discovery, projection, presence, handlers | Pass for access. canAccess explicitly allows lobby for an existing user. Missing users deny. The full-access fast path can allow an unknown room ID for an owner or a member with all current grants; that existing rule is not what grants lobby access. Normal agent references are validated by roomIdForAgent and real room mutations validate stored rooms. Receptionist tokens have null userId and cannot enter that fast path. Browser projection explicitly includes the receptionist; discovery includes its lobby roomId. Lobby selection reports null presence. |
| server/auth-middleware.ts | Cookie/bearer resolution and WebSocket upgrade | Pass. API tokens use the live issuing user and explicit API capability set. Bearer auth does not grant a browser WebSocket. The all-browser members-chat audience therefore excludes agent, run and app tokens. |
| server/routes/table.ts | Seven chat routes and all capability gates | Pass. All seven chat routes use chat:members plus operationalAuthenticated. Exact path length prevents page/read/upload/file collision. Main's userEnv.names guard and API inbox request shape survive the merge. |
| server/routes/executor.ts | Capability dispatch and idempotency replay | Pass. The capability is checked before a handler runs. Main's Idempotency-Replayed response header applies generically; chat handlers need no alternate dispatcher. |
| server/routes/handlers/members-chat.ts | Post authors, edit/delete ownership, attachments and read pointers | Pass. Authorship comes from the resolved user/agent/API identity, not the request body. Edits require matching userId; owner deletion is explicit. Attachments must exist in the chat store. Read pointers and their events belong to the caller's user. |
| server/events/registry.ts | Event IDs and audiences | Pass. Message/delete use all-browser delivery; read uses userId delivery. All-audience allowlist includes only the two shared chat events, not private read pointers. Main's comment correction is preserved. |
| shared/contract-shapes.ts | Request/response unions | Pass. Chat page, post, edit and read shapes remain intact beside main's API-token sequence log, member provider-status projection and hosted access flag. No chat payload uses the token inbox union. |
| server/persistence.ts | Stored agents and log preparation | Pass. receptionist.json is separate from the room buckets in agents.json. loadReceptionist runs the normal agent migration. Main's prepareLogEntry redaction remains on appendLog for all agents, including the receptionist. Chat posts are their own human content store, not agent log entries. |
| server/agent-manager.ts | Spawn/restore, session state, prompt/memory selection | Pass. Both normal and receptionist restore construct a SessionManager; persistedAgentOf reads sessionManager.sessionId. Receptionist bypasses only stored-room placement, uses the special prompt and office/agent memory, and mints a token with no user. |
| server/session-manager.ts | Install, replace, drain, event consumption and dormant states | Pass. SessionHost carries lifecycle state and no room-membership predicate. Receptionist uses these same operations. No new backend or event-state arm is needed. |
| server/internal-types.ts | Managed agent lifecycle shape | Pass. SessionManager is the required lifecycle field. Lobby adds an AgentInfo flag, not a second managed-agent type. |
| server/agent-turn.ts | Turn execution over a managed session | Pass. It uses the shared session manager, with no stored-room enumeration. |
| server/routes/handlers/conversation.ts | User, agent, API and scheduled send branches | Pass. Main's API tokenId argument, messageId result and clientMessageId rejection remain. Lobby send still reaches the normal acceptance path; receptionist clearing delegates to the manager. |
| server/command-handlers.ts | Slash command dispatch and prompt selection | Pass. The receptionist prompt branch remains beside main's translated command responses and session-manager operations. Machine prompt text stays English by the existing catalog rule. |
| server/system-prompt.ts | Agent affordances and manifest description | Fixed. The manifest field description now explicitly permits room:null for the receptionist. Privileged chat routes remain in the privileged section. |
| server/api-tokens.ts | Token conversation directions and sequence records | Pass. Agent display names and room names are strings; Lobby works without a numeric room. Chat posts use the chat store, not token inbox sequence storage. |
| server/routes/handlers/api-tokens.ts | Inbox owner and agent sender paths | Pass. Sender display is resolved through agentDisplay; no room-number conversion or chat-event switch. |
| server/routes/handlers/access.ts | Office access settings | Pass. Hosted flags and owner-only access updates do not enumerate rooms or receptionist agents. Lobby grants no office-admin capability. |
| server/routes/handlers/user-env.ts | User/API environment ownership | Pass. subjectUserId permits only user/API with a non-null user. A receptionist agent cannot enter this surface through its spawning user's record. |
| server/provider-account-manager.ts | Office/personal provider scope | Pass. The scope switch is provider configuration, not room membership. Lobby adds no provider scope. |
| server/users.ts | User grants, hidden rooms and ordering | Pass. Grants remain stored-room IDs. The lobby is not stored or added to grant lists; canAccess handles it explicitly. |
| server/storage-usage.ts | Storage categories and per-agent log directories | Pass. The complete state-root walk counts chat month files, pointers and attachments in other-state. Receptionist log files remain in the ordinary logs tree. |
| server/storage-report.ts | Category reading order and per-agent labels | Pass. other-state is shown; names resolve independently of room placement. No month-file data is omitted from the total. |
| server/storage-prune.ts | Prunable roots and candidate files | Pass. Only logs and token-logs are candidate roots. The members-chat directory and receptionist.json are outside both; this lane adds no chat retention policy. |
| server/routes/handlers/storage.ts | Allowed prune targets and owner controls | Pass. The explicit target list has no members chat. No existing prune request gains chat deletion rights. |
| shared/storage-labels.ts | Category labels and order | Pass. Existing other-state category covers the new directory. No new category or prune label is introduced. |
| ui/components/StoragePane.tsx | Storage categories and target selector | Pass. The report displays other-state and the existing explicit prune targets. |
| server/usage-report.ts | Agent rows, room buckets and office totals | Fixed under the PM ruling. Per PM ruling, a synthetic Lobby bucket joins the report only when a receptionist exists. Every viewer can see it; the normal summation now includes receptionist spend in office totals. Stored rooms and response schema remain unchanged. |
| ui/components/UsagePane.tsx | Usage row rendering | Pass as a renderer. It accepts returned names and IDs; the accounting fix is upstream in usage-report.ts. |
| ui/routes.ts | Four full-page paths | Pass. /tasks, /cronjobs, /apps and /settings remain the only canonical pages. Lobby remains office state at /; no /lobby route is introduced. |
| ui/App.tsx | Page selection, saved view, title and presence | Pass. A URL page wins over saved panels. Lobby is restored after room selection and persisted separately. With no agent focused, lobby uses office.name for the title. Presence is null on lobby/receptionist views. |
| ui/view-persistence.ts | Stored lobby flag and legacy panels | Pass. Missing lobby defaults to false; saved room/agent IDs remain separate. Old users/settings aliases still parse. |
| ui/store.tsx | Hydration and members_chat event reduction | Pass. Each event has its own reducer arm. Reconnect clears loaded so REST hydration resumes. No-room hydration and closing the last visible room open the lobby. Room selection closes it. Receptionist completion sound is excluded from room notifications. |
| ui/office/OfficeView.tsx | Scene branch, navigation and empty state | Fixed. Main had removed office from the state destructure, while the clean lobby merge referenced office.name. Restored the read. The lobby now mounts the shared Apps screen, opens schedules from its clock, uses nilo, and removes the dead no-room overlay under Nil's ruling. The first room has a door back to the lobby. |
| ui/office/Floor.tsx | Shared wall controls | Fixed. Extracted the existing Apps screen into AppsWallScreen so both scenes use the same art and translated label. Normal room clock and walls remain intact. |
| ui/office/RoomTabBar.tsx | Lobby versus stored room tabs | Fixed translation. The lobby stays outside dragging/order/settings, and ordinary room cycling still enumerates rooms only. Existing unread count is retained; no unread-dot redesign is added. |
| ui/components/UserSettingsView.tsx | Settings pages, rooms and users | Pass. Room rows come from the server's stored-room projection. Lobby has no RoomPane, grant row, hidden preference or room prompt. |
| ui/components/RoomPane.tsx | Stored-room mutation routes | Pass. Only stored rooms can be selected from settings; no lobby record is sent to rename/settings/delete. |
| ui/components/InvitesPane.tsx | Initial member room grants | Pass. It enumerates stored rooms. A member with no grants reaches the lobby through the explicit ACL rule and hydration default. |
| ui/components/TaskView.tsx | Room scope and agent assignees | Pass. Lobby is not a selectable task room. Agent assignees use identity/name; no desk index is required. A receptionist's implicit room is not a valid task room; explicit office-global tasks remain the existing route. |
| ui/components/AppsView.tsx | App status and page errors | Pass. Reused page fetches GET /api/apps with the current browser session. Handler projectForList filters/projects each record for that identity. No receptionist token or wider list is passed from the lobby. |
| ui/components/AgentListView.tsx | Receptionist row and members-chat mount | Gone: the merge onto main took main's deletion of the mobile list view (task f3ebd376). The receptionist row and the members-chat mobile home move to the follow-up with the unread dot. |
| ui/components/EditAgentDialog.tsx | Receptionist locks and desk label | Fixed translations for Lobby and the name-lock hint. Ordinary desk labels keep main's translation. |
| ui/components/ContextMenu.tsx | Kill action | Pass after R1. Receptionist lock and main's translated label are both retained. |
| ui/log-view/LogView.tsx | Agent-state labels and chat navigation | Pass. Receptionist uses the ordinary AgentInfo states. No separate lobby state is needed in the label map. |
| ui/log-view/LogEntryCard.tsx | Shared human message cards | Pass after R1. avatar and editTitle overrides survive beside translated defaults. Members chat still edits in place through its own callback. |
| ui/log-view/isomux-curl.ts | Agent-facing route labels | Pass after R1. All five transcript-oriented chat actions use typed catalog keys. Upload and file serving are intentionally left without action labels, like the existing attachment transport; the privileged post route is labeled. |
| ui/members-chat/MembersChatPanel.tsx | Author kinds, controls, errors and time labels | Fixed. UI-owned words use the catalog, author/time helpers take a translator/language, counters use the number formatter. Server error detail stays verbatim under the existing i18n rule. |
| ui/members-chat/api.ts | Multipart upload error | Fixed. Carries HTTP status as ApiError data, so the panel formats its own translated error. |
| ui/office/ReceptionistFigure.tsx | Chat tooltip and unread badge | Fixed. Catalog words; unread badge width accommodates the translated word. Stored agent names remain identity data. |
| ui/office/lobby/LobbyScene.tsx | Theme, Apps and schedule controls | Fixed. Translated fallback/tooltip; shared Apps screen and schedule callback. |
| ui/office/lobby/props-decor.tsx | Rug, bunting, poster and directory text | Fixed. WELCOME, THE OFFICE and DIRECTORY moved to the catalog. User room/office names stay verbatim. |
| ui/office/lobby/props-plaque.tsx | Two-line Employee of the Minute heading | Fixed. Both display lines are catalog entries in all three languages. Agent name remains data. |
| ui/office/lobby/layouts.ts | Layouts, placements and ghost spots | Fixed. Added nilo with all saved coordinates and ten named spots without rounding. Internal editor layout labels stay outside user-facing translation scope. No live ghost consumer, per PM ruling. |
| ui/demo-server.ts | Demo event and REST switches | Pass. Members-chat page/post/edit/delete/read fixtures remain beside main's API-token changes; the demo uses the same scene and catalog, with the fixed receptionist cwd reflected in its fixture. Upload remains the existing raw multipart route. |
| shared/i18n/en.ts | Canonical user-visible messages | Fixed. Lobby strings and default identity names have catalog entries. Default stored identities remain English; reader-specific labels translate. |
| shared/i18n/es.ts | Spanish catalog | Fixed. Complete translations with matching placeholders. |
| shared/i18n/ca.ts | Catalan catalog | Fixed. Complete translations with matching placeholders. |
| shared/i18n/time.ts | Locale date shapes | Fixed. Added explicit 24-hour clock and month/day/clock shapes for members chat; old dates use the existing fullDate shape. |
| shared/i18n/translate.ts | Key/placeholder resolution | Pass. New keys use the existing typed translation path; no fallback layer added. |
| ui/i18n.tsx | User language context | Pass. Lobby is under the existing provider; standalone internal previews retain the default English context. |
| shared/types.ts | Lobby room constant and wire arms | Fixed default name source. LOBBY_ROOM.name reads the English catalog for the machine manifest; receptionist flag and chat wire events remain intact. |

| ui/components/CronjobsView.tsx | Schedule list, runs and page dialogs | Pass with inherited visibility. Reads cronjobs_state from the store; browser WS open sends listCronjobs() to every authenticated browser. GET /api/cronjobs returns that same unfiltered list. The clock opens this existing page, without supplying records or another identity. Runs use /api/cron-runs and /api/cronjobs/:id/runs. cron:read is in USER_CAPABILITIES for owners and members. This existing office-wide read access adds no reach when the lobby clock opens the page. |
| ui/components/CronjobDialog.tsx | Schedule creation/edit fields and model menus | Pass. The reused dialog operates on a selected Cronjob and uses the existing POST/PATCH/DELETE routes. Model and provider selection does not enumerate room IDs. No lobby-specific body or authority is introduced. |
| ui/components/CronjobsPromptDialog.tsx | Global schedule prompt | Pass. Reuses cronjobsPrompt state and PUT /api/cron-prompt; the route guard retains mutation authority. The lobby callback supplies no prompt or credential. |
| ui/components/CronjobRunView.tsx | Run selection, log hydration and actions | Pass. Reads runs/logs from the existing store and GET /api/cronjobs/:id/runs/:runId, with mutations on existing run routes. Run identity is distinct from the receptionist; no room fallback is added. |
| api/chat.ts | Public product facts | Fixed. Added the lobby scene and shared controls beside the existing feature list. No HTTP capability or room access branch is introduced. |
| api/chat-prompt.test.ts | Product-answer prompt assertions | Pass. Both branches' product facts remain; no assertion excludes a lobby or requires all agents to have a numeric room. |
| docs/features.md | Canonical feature inventory | Fixed. Lobby detail and shared controls are described beside the isometric-office feature. |
| internal-docs/documentation.md | Documentation surface index | Fixed. Explicit manifest exception records receptionist room:null and roomName:Lobby. All stale surfaces are listed below. |
| server/test-support/routes-table.test.ts | Route entries, guards and shape pins | Pass. Chat route entries coexist with main's route changes; the review gate exercises these assertions. No assertion was removed. |
| server/test-support/system-prompt.test.ts | Prompt variants and exposed affordances | Pass. Receptionist and ordinary prompts keep their separate selectors beside main's language argument. No assertion was removed. |
| ui/store.test.ts | Event reduction and hydration | Pass. Members-chat reducers coexist with main's hydration/store assertions. No conflicting event names or assertion removals. |
| ui/styles.ts | Global styles and animation names | Pass. Lobby CSS additions do not replace main's theme variables or existing animation names; no room/capability dispatch exists here. |

| server/receptionist-workspace.ts | Dedicated workspace path and creation | Fixed under PM ruling. Default ~/isomux-receptionist; tests use the existing state-root override. Created before spawn/restore, symlink refused, contents preserved on later boots. |
| server/safety-policy-cwd.test.ts | Relative write targets and cwd resolution | Pass in the 598-test run on 698818b6. Its cases distinguish protected state writes from ordinary cwd-relative writes; the receptionist workspace is outside the protected state root. |

## Documentation surfaces

- Updated docs/features.md and api/chat.ts together for the lobby scene and wall controls.
- Updated docs/access-and-invites.md for no-grant lobby access and members-chat authority.
- Updated docs/developer-api.md for the nullable manifest room and seven chat routes, storage and ownership.
- Updated docs/how-it-works.md for receptionist and chat persistence.
- Updated server/system-prompt.ts and internal-docs/documentation.md for the manifest exception.
- README and the three landing pages retain their existing headline lists. This adds detail to the feature inventory, not a new headline claim.
- Hosted, legal, control-plane, machine-readable website API, installer and updater contracts are unchanged: no new public website route or deployment setting.
- The historical security audit remains dated as such; this integration audit is the current evidence.
- /help and the command registry gain no command. Backup still archives the state root, which includes both new stores; no archive-layout change.
- Personal-site pitches, resume and org profile are outside this feature-detail change; no new stack or headline claim.

## Verification and assertion changes

R1: both UI builds, 104 office tests and 20 catalog tests passed; ESLint had
only the known LobbyEditor effect warning. Reviewer 1 separately ran the
327-test receptionist/chat/identity/route/prompt set and approved R1.

R2 gates are recorded on the commit supplied for review, not on an earlier tree.
The intermediate run passed 515 tests across 28 files. A real Chrome check on
2026-09-08 showed the saved nilo scene, receptionist, chat and both wall
controls; clicking Apps opened the shared app list. Screenshot:
`/home/nil/nil/lobby-r2-scene.png`. DOM tests check both routes and Spanish/Catalan
text. The browser check also caught the bunting default, now translated with
the same welcome key as the rug. Spanish and Catalan were also checked in
Chrome (`/home/nil/nil/lobby-r2-es.png`, `/home/nil/nil/lobby-r2-ca.png`);
the rug text has a fixed SVG text length so longer translations fit.

Existing assertion changes:

 MembersChatPanel.test.tsx, formatWhen's old-year
case, now expects `Feb 3, 2025` instead of `Feb 3 2025`, because Intl's existing
fullDate shape supplies the reader's date order and punctuation. All three
date cases and all author/control/ownership assertions remain. Helper calls
now provide English explicitly.

New render tests:
- App.lobby.dom.test.tsx clicks the actual SVG Apps and Schedules controls and
  checks the resulting path/history entry. Named mutants: delete
  `onOpenApps={embed ? undefined : onOpenApps}` or
  `onOpenCronjobs={onOpenCronjobs}` from the LobbyScene call. Each should fail
  the matching control/path assertion.
- The same test pins the office-name title. Nil ruled that the no-room overlay
  is dead and must be removed. Its previous overlay mutant is retired.
- lobby.i18n.dom.test.tsx renders the saved scene and chat in Spanish/Catalan
  and asserts literal translated headings, rug, directory and composer text.
  Mutant: replace `t("membersChat.title")` with `"Members chat"`; the
  `queryByText(heading)` assertion must fail.

These mutants are specified for the reviewer to run; this report does not
claim they have already been run.

Additional layout assertions changed in LobbyScene.test.tsx: the per-layout
`places only registered variants inside the floor` case is renamed to
`places registered variants at valid coordinates`. The four bounds (a/b >= 0
and <= 10) remain for all original presets; nilo has explicit -2..11
bounds with margin because the locked saved cat and plant have negative
coordinates. Finite-coordinate checks remain too.
The ghost-spot bounds change from >0.5/<9.5 to >0/<10 on both axes: Nil's
blue-sofa spot is at a=0.15. Minimum count and pairwise spacing >1 remain.
The copied placements, receptionist slot and ten spots were compared with
the saved JSON value for value; all matched on 2026-09-08.

## Follow-ups and live state

PM ruling: ghost rendering, placement and movement ship together in task
365c5d69. nilo's spots are stored with no live consumer. Also out of scope:
room types, receptionist profiles, the room-creation door, and the unread-dot
and mobile-chat redesign.

The lobby-editor app remains bound to this worktree. Leave it and the stash
alone. At merge the PM must resolve the app's worktree lifetime before cleanup.
Server changes need a boss-approved restart; no server restart is part of this
lane. Worktree builds do not change the served office.

## Copy inventory

[lobby-strings.md](lobby-strings.md) records the exact English, Spanish and
Catalan catalog text. New lobby keys are separate from inherited strings in
the reused controls and pages. Dynamic names, server error details and member
messages remain verbatim data. Internal editor labels are excluded.

The new usage test is `counts receptionist spend for owners and lists it for
members without room grants`. It seeds receptionist spend 3 and inaccessible
Room B spend 11. Owner session total is 14; the member rows contain only the
receptionist and Lobby, and the member total is 3. This negative room/total
check is in the same test, per the PM ruling. The report footer "Scoped to the
rooms you can access" is pre-existing raw English in the machine report.

Usage mutants for this implementation (the exemption is in the shared room
predicate and the synthetic map, so the old bare lines now already work):
- M1 replace `.filter((a) => canSeeRoom(a.info.roomId))` with
  `.filter((a) => a.info.roomId !== LOBBY_ROOM_ID && canSeeRoom(a.info.roomId))`.
  The member per-agent-row equality must fail; owner totals still pass.
- M2 replace `if (!room) continue;` with
  `if (!room || a.info.roomId === LOBBY_ROOM_ID) continue;`.
  `expect(owner.total.session.costUSD).toBe(14)` must fail (11 received).

## Receptionist working directory

PM ruling: the fixed default directory is `~/isomux-receptionist`. This is a
new top-level convention for Nil to confirm or rename. Isomux creates it empty
before spawn; later boots preserve its contents. Unlike the welcome agents,
the receptionist deliberately does not use the home directory. The existing
ISOMUX_HOME override uses `<STATE_ROOT>-receptionist` so alternate offices and
tests cannot touch the real workspace. No new environment variable was added.
The directory has no `.isomux` path segment and is outside the protected state
root; the helper rejects a symlink at the workspace path.

Spawn and restore both use ensureReceptionistWorkspace. The restore pin ignores
a stale receptionist.json cwd. Historical session cwd metadata also cannot
undo the pin during resume. PATCH rejects a changed cwd with receptionist_locked,
and the edit dialog disables the cwd field and its suggestions. The lifecycle
test checks the fixed path, existence, initial empty contents, restart identity,
and restoration from a record with cwd "~". The lock test checks a refused cwd
edit and unchanged stored identity. Permission mode stays bypassPermissions.

Verbatim reachable claim for Nil's policy decision in the batch report:
"A member who can see no room can ask the office receptionist to read files under the home directory, which includes ~/.isomux."
The fixed cwd and enforced pin are the hardening done; cwd is not a filesystem
sandbox. Whether bypassPermissions stays is still a policy question for Nil.

Cwd enforcement mutants:
- C1 replace `(typeof changes.cwd === "string" && resolveCwd(changes.cwd.trim()) !== current.cwd)`
  with `false`. `expect(changeCwd.status).toBe(409)` must fail.
- C2 replace the AgentInfo construction line `cwd: restoredCwd,` with
  `cwd: p.cwd,`. The restart test's `expect(after[0].cwd).toBe(before.cwd)` must fail.

## Nil's no-room-screen removal

Removed OfficeView's dead overlay and all four office.noRooms.* keys in en/es/ca.
Removed one assertion: App.lobby.dom.test.tsx
`expect(view.queryByText("No rooms assigned")).toBeNull()`. Its paired overlay
mutant is retired. The two page-route cases and office-name title assertion
remain. No other test asserted that screen in the repository search.
common.noRooms stays: UserSettingsView and InvitesPane still read it. The lobby
plus tab still creates a room through the existing path.

The Catalan author labels now use `token d'API`, matching the existing catalog.
The cwd change removes home as the working directory and the default location
for backend state; it does not restrict which files bypassPermissions can read.

## Last-room closure

room_closed is the only reducer arm that shrinks the room list. It now mirrors
full_state's empty-room rule: `lobbyOpen: result.rooms.length === 0 ? true : state.lobbyOpen,`.
room_created appends; rename/settings/pet map without changing the length.
The new ui/store.test.ts case `opens the lobby when the user's last visible room closes`
starts in a selected room with the lobby closed, closes that room, and asserts
empty rooms, null currentRoomId and an open lobby. This replaces the safety
previously supplied by the removed overlay assertion. No existing assertion
was removed or changed after 0cd9dd62.

Mutant L1: delete `lobbyOpen: result.rooms.length === 0 ? true : state.lobbyOpen,`
from room_closed. `expect(closed.lobbyOpen).toBe(true)` must fail, receiving false.

## Closing verification

Reviewer 1 approved R4's runtime changes on 6d678e7d, independently running
612 tests, both builds, ESLint and all eight mutants. D1/D2 fail at the missing
control assertion, not the route assertion: they prove the callback keeps the
control present. The positive route assertions pass. A real Chrome mouse click
on the lobby clock also opened the Schedules page; screenshot
`/home/nil/nil/lobby-final-clock-schedules.png` (2026-09-08).

The final TypeScript run found three saved-view fixtures missing lobby:false.
App.restored-chat.dom.test.tsx's bootWithSavedAgent and the two saveView calls
in App.saved-spot.dom.test.tsx now provide it. No assertion changed; these
fixtures continue to represent a saved ordinary-office view.

Directory mode note: mkdir creates the receptionist directory with mode 0700.
An existing directory keeps its mode; this lane does not change its permissions.
