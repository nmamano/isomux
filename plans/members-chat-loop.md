# Members chat loop - standing orders + slice handoffs

Re-read this file at the start of every iteration. Conversations compact; this file does not.

Owner: Nil. Runner: Nil's Direct Helper. No reviewer (self-review checklist per slice; a reviewer pass before merge is parked for Nil).
Worktree: ~/nil/isomux-worktrees/lobby (branch `lobby`, base main 101414e; this loop starts at 15ea7b8, 2026-09-05).
Sibling loop in the same worktree: plans/lobby-loop.md (the lobby SCENE). Nil iterates on the scene in another session; this loop never edits ui/office/lobby/* except a named export in index.ts.

## North star

A members-only chat, humans and their proxies only, that lives on a Lobby tab: same message cards as the agent chat (Markdown, attachments, copy, edit in place), one office-wide stream stored month by month so a year of history costs nothing until someone scrolls to it, an unread badge on the Lobby tab, and a Lobby tab that members with no rooms land on.

Nil's rulings (2026-09-05):
1. Lobby only. 2. API tokens allowed. 3. Privileged agents allowed (same reach as humans and API tokens); ordinary agents, cron runs and apps never.
4. Unread pointer server-side per user. 5. No sound. 6. Edit in place if clean, else skip. 7. Attachments, same cards as the agent chat: not a second-class chat.
8. Mini ghost next to the author name as a trial; Nil decides on sight. 9. Keep forever, storage page reports it. 10. Name: "Members chat".
11. Order is mine. The scene visuals are not done; do not depend on a final layout.
Storage: one JSONL per month under <STATE_ROOT>/members-chat/, paged from the newest month backward; edits and deletes are appended to the month file that holds the target (the id carries its month). No /clear, no sessions.

## Process per slice

plan (PICKUP block) -> implement -> commit -> gates on the committed hash -> self-review checklist -> tick the checkbox (amend allowed only before the hash is used in a gate log) -> author the next PICKUP.

Self-review checklist:
1. Every gate log opens with the committed hash and ends with exit=0.
2. Every access rule has a test that proves the denial (ordinary agent 403, cron run 403, app 403) and the grant (user, API token, privileged agent).
3. A bug found by a gate gets a regression test at the right layer in the same slice.
4. No file under ui/office/lobby/ touched, except index.ts exports when the PICKUP names it.
5. No file outside the PICKUP's named surfaces touched.
6. UI slices: screenshots exist for dark and light and were LOOKED AT (Read the PNG).
7. Doc surfaces (internal-docs/documentation.md) touched when the change makes them stale; agent-facing routes get a ROUTE_LABELS entry in ui/log-view/isomux-curl.ts.

## Gates per slice (always-run, offline, nothing costs money)

Run in the worktree AFTER the commit, on the committed hash:

    H=$(git rev-parse HEAD)
    (echo $H; bun run build:ui; echo exit=$?) > /tmp/mchat-build.log 2>&1
    (echo $H; systemd-run --user --scope -q -p MemoryMax=2G bun test <scoped files>; echo exit=$?) > /tmp/mchat-test.log 2>&1
    (echo $H; bunx eslint <touched files>; echo exit=$?) > /tmp/mchat-eslint.log 2>&1
    # when ui/demo-server.ts or shared/storage-labels.ts changes:
    (echo $H; bun run build:demo; echo exit=$?) > /tmp/mchat-demo.log 2>&1
    # UI slices: screenshots through the demo bundle (port 9878, reserved), PNGs in /tmp/mchat-shots/slice-N/

Scoped test set (grow it as files appear): server/members-chat*.test.ts, server/test-support/routes-members-chat-rest.test.ts, server/test-support/event-registry.test.ts, server/test-support/routes-table.test.ts, server/test-support/emit.test.ts, server/test-support/guards.test.ts, server/test-support/identity-tokens.test.ts, ui/store.test.ts, ui/members-chat/, ui/office, ui/demo-app.test.ts.
Read the exit= line of each log; never a pipeline status. A gate failure is fixed in the slice or queued; gates are never weakened.
Once, before the final report: `(echo $H; systemd-run --user --scope -q -p MemoryMax=2G bunx tsc --noEmit; echo exit=$?) > /tmp/mchat-tsc.log 2>&1` (about 60 s).
Baseline (2026-09-05, 15ea7b8): tsc exit=0; `bun test server/events server/routes shared ui/store.test.ts ui/log-view` 353 pass exit=0; Chrome 151.0.7922.137; bun 1.3.11.
Safety hook: every write target in a shell command must be an ABSOLUTE path; invoke scripts with `bash`, never chmod +x.
Overlap warning: the browser-use worktree has committed changes to server/isomux-office.ts and server/routes/table.ts; expect a rebase conflict at merge time, not a reason to avoid those files.

## Standing rails (prohibitions)

- Never edit files in ~/nil/isomux (main) or in any other worktree.
- Never restart the isomux server. Never push. Never merge. Never run prettier.
- Never edit ui/office/lobby/* except a named export in index.ts (the scene is Nil's other session).
- Never store a lobby in officeState or in any user's allowedRooms / notifRooms; the Lobby tab is client-side state.
- Never let an ordinary agent token, a cron-run token or an app token read or write the members chat; a test pins each denial.
- Never load a whole history: every read is a page; older months open only on demand.
- Never mention the members chat in the system prompt of an ordinary agent; the privileged block may list the routes.
- Never start slice N+1 with slice N uncommitted. One commit per slice.
- Never message Isomux PM or the reviewers. No agent traffic in this loop.
- Keep chat quiet until the final report; interim messages only as "(orchestration chatter: ...)". Answer Nil inline if he asks.
- Never pkill by name; keep a static server's PID and kill that.
- Never read, archive or scan ~/.claude/projects/.

## Slice plan

- [x] 1 Server store: `server/members-chat.ts` (month files, fold, page, post/edit/delete, read pointer, attachment dir) + `server/members-chat.test.ts`.
- [x] 2 Access + wire: capability, route table, handlers, registry events, emit wiring, uploads and file serving, harness REST tests, ROUTE_LABELS, privileged prompt block.
- [x] 3 Client: store slice, api calls, `ui/members-chat/MembersChatPanel.tsx` (reused cards, new composer with attachments, edit, delete, paging, presence line, mini ghost trial) + tests.
- [x] 4 Lobby tab (client-only): tab with unread badge, zero-room landing, title fallthrough, presence null, mobile list entry, scene + panel mount, demo shim with canned messages, screenshots dark/light/mobile.
- [x] 5 Docs and battery: features.md bullet, api/chat.ts feature list, AGENTS.md if it inventories routes, storage page label if needed; tsc; completion note; report.

## Deferred / parked (do not pick up)

- Ghosts in the lobby, server-side synthetic lobby room, Ctrl+Tab lobby skip: out of scope (see plans/lobby-loop.md).
- Sound on new message; search; reactions; per-room human chats: not asked.
- Human-only queue (parked-for-Nil): mini ghost keep or strike; docs copy approval (his voice); scene layout pick; reviewer pass; merge and restart.

## Resources

- Persistence patterns: server/persistence.ts (appendLog JSONL, atomicWriteFileSync, getFilePath path-traversal guard, saveFile). State root: server/config.ts STATE_ROOT (tests get a temp root via server/test-support/temp-state.ts).
- Identity: server/identity/index.ts (TokenScope, Capability lattice, capabilitiesForScope, privileged set), server/identity/guards.ts (authenticated refuses app+api; operationalAuthenticated admits api).
- Routes: server/routes/table.ts (defineRoute, cap(), emits), server/routes/handlers/*.ts (LEAF handlers over injected deps; tasks.ts and uploads.ts are the models), composed in server/isomux-office.ts (`register(tasksHandlers({...}))`, ~line 1835 and 2155). liveEmit(id, payload, ctx) ~line 1530.
- Events: server/events/registry.ts (EventPayloads + EVENT_REGISTRY, ALL_AUDIENCE_ALLOWLIST), pinned by server/test-support/event-registry.test.ts SPEC_AUDIENCES.
- REST harness: server/test-support/harness.ts startTestServer (cookie users, connectWs, mintInvite); model test server/test-support/routes-tasks-rest.test.ts; token minting server/identity/tokens.ts (mintAgentToken, mintRunToken); app tokens server/app-tokens.ts.
- Legacy file route: server/isomux-office.ts ~line 5332 (`/api/files/<agentId>/<name>`); the card builds that URL in ui/log-view/LogEntryCard.tsx lines 166 and 252 from an `agentId` prop.
- UI: ui/store.tsx (reducer, `set_current_room`, `log_entry` dedupe pattern, users/onlineUserIds/sessionContext), ui/ws.ts (onmessage dispatch), ui/api.ts apiFetch, ui/App.tsx view branches ~line 575 and presence effect ~line 318 and document.title ~line 276, ui/office/RoomTabBar.tsx tab pill ~line 396, ui/components/AgentListView.tsx (mobile), ui/log-view/LogEntryCard.tsx (LogEntryCard user_message branch: UserMessage, EditableUserMessage, describeMessageSender), ui/office/Ghost.tsx GhostBody / ui/office/ghostVariants.tsx GhostGraphic (mini ghost), ui/office/lobby/index.ts (LobbyScene export), ui/styles.ts (needs the `.lobby-dark-only` light-mode rule at mount).
- Demo: ui/demo-server.ts (WS shim + apiFetch shim via setApiShim ~line 1467); `bun run build:demo` writes site/demo; serve a copy from /tmp on port 9878 and screenshot with `google-chrome --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=1100,820 --screenshot=<png> --virtual-time-budget=6000 <url>` (recipes: internal-docs/ui-verification.md).
- Docs: internal-docs/documentation.md (surfaces), docs/features.md "Multi-user", api/chat.ts feature list.

## SLICE-1 PICKUP (authored 2026-09-05)

Baseline: 15ea7b8 + the commit that adds this file.
Goal: a tested storage module with no HTTP and no wire, so slices 2 and 3 only plumb.
Mechanics:
- `server/members-chat.ts` exports a factory `createMembersChatStore(dir)` (dir injected; production passes join(STATE_ROOT, "members-chat")). Files: `<dir>/YYYY-MM.jsonl`, `<dir>/files/`, `<dir>/reads.json`.
- Message id: `YYYYMM-<8 hex>`; `monthOfId(id)` names the file for edits and deletes. Lines: `{op:"post", id, userId, userName, device?, timestamp, content, attachments}`, `{op:"edit", id, timestamp, content}`, `{op:"delete", id, timestamp}`. Fold per month into `MembersChatMessage {id, userId, userName, device?, timestamp, content, attachments, editedAt?}`; a deleted message folds to nothing.
- `page({before?, limit})`: newest first from the newest month; when a month has fewer than `limit` left, continue into the previous existing month file; return `{messages (chronological), hasMore}`. Month files listed from the directory, never assumed contiguous. A folded month is cached in memory and invalidated by its own append.
- `post`, `edit`, `delete` return the folded message (or null when the id is unknown or already deleted). `edit`/`delete` append to `monthOfId(id)`'s file; a malformed id (wrong shape) returns null without touching the disk.
- Read pointer: `getReadPointer(userId)` and `setReadPointer(userId, lastReadId)` in reads.json via atomicWriteFileSync; `unreadCount(userId)` counts folded messages newer than the pointer (bounded: stop at 99 and report `99+` as 100).
- Attachments: `saveAttachment(data, mediaType, originalName)` and `attachmentPath(filename)` mirroring persistence.ts saveFile/getFilePath (hash name, path-traversal guard, same MAX_FILE_BYTES).
- Content cap: `MEMBERS_CHAT_MAX_CHARS = 4000`, checked in post and edit (throws a typed error the handler maps to 400).
- Tests in `server/members-chat.test.ts` against a mktemp dir: post/fold/page across two months, edit and delete of an old-month message land in that month's file, page cursor at a month boundary, deleted messages vanish, unread count and pointer, traversal rejection, cap.
Acceptance: `bun test server/members-chat.test.ts` exit=0 on the committed hash; module imports nothing from agent-manager or isomux-office.
Locked: file layout, id shape, line ops. Slice 2 depends on them.

## SLICE-2 PICKUP (authored after slice 1 committed at c462e4a)

What slice 1 taught: the safety hook blocks a whole Bash call when any write target is relative (the sed -i on a relative path took the python heredoc down with it); eslint forbids require() in tests; `bun test <file>` runs in under a second, so run it before committing and keep the gate run for the hash.

Goal: the members chat reachable over HTTP and the wire by a cookie user, an API token and a privileged agent, and by nobody else, with the harness proving every grant and every denial.
Mechanics:
- Capability `chat:members` in server/identity/index.ts: in USER, PRIVILEGED_AGENT and API sets; absent from AGENT, RUN and APP. Pin it in server/test-support/identity-tokens.test.ts.
- MembersChatMessage gains `kind: "user" | "api" | "agent"` (author kind, snapshot at post time). For an API token, device is the token's display name; for a privileged agent, userName is the agent name and userId its owning user.
- Routes (server/routes/table.ts, all `cap("chat:members", operationalAuthenticated)`): `membersChat.page` GET /api/members-chat?before&limit -> {messages, hasMore, readPointer, unread}; `membersChat.post` POST /api/members-chat {text, attachments?, device?} -> 201 message, emits members_chat_message; `membersChat.edit` PATCH /api/members-chat/:id {text} -> message, emits members_chat_message; `membersChat.delete` DELETE /api/members-chat/:id -> 204, emits members_chat_deleted; `membersChat.upload` POST /api/members-chat/uploads (multipart, same limits as agents.upload) -> {attachments}; `membersChat.getFile` GET /api/members-chat/files/:filename; `membersChat.markRead` POST /api/members-chat/read {lastReadId} -> {readPointer, unread}, emits members_chat_read to every socket of that user.
- Ownership: edit when message.userId === identity.userId; delete when that, or the caller's user record is an owner. A posted attachment must name a file the store already holds (attachmentPath non-null), else 400.
- Registry: members_chat_message {message} and members_chat_deleted {id} audience all (add to ALL_AUDIENCE_ALLOWLIST and SPEC_AUDIENCES); members_chat_read {readPointer, unread} recipient-scoped by userId. Add the three to ServerMessage in shared/types.ts.
- Handlers in server/routes/handlers/members-chat.ts, LEAF over injected deps (store, authorFor(identity), isOwner(userId), emit*, contentTypeFor); composed in server/isomux-office.ts next to uploadsHandlers with `createMembersChatStore(join(STATE_ROOT, "members-chat"))`.
- ROUTE_LABELS entries in ui/log-view/isomux-curl.ts; a "How to use the members chat" block in the privileged section of server/system-prompt.ts (privileged agents only; the ordinary prompt never mentions it).
- Tests: server/test-support/routes-members-chat-rest.test.ts (model: routes-tasks-rest.test.ts; app token via the fake supervisor as in routes-app-message.test.ts; API token via POST /api/me/api-tokens): post fans out to a member socket; page with unread and pointer; edit own 200 / other's 403; owner deletes any, member only own; markRead advances and reaches the user's second socket; upload + post with attachment + getFile bytes; unknown attachment 400; empty and over-cap 400; ordinary agent 403 on GET and POST; cron run 403; app 403; privileged agent 201 kind agent; API token 201 kind api. Update routes-table.test.ts (SPEC_ROUTE_CONTRACT + opId list) and event-registry.test.ts (SPEC_AUDIENCES).
Acceptance: scoped tests exit=0 on the committed hash: server/members-chat.test.ts, routes-members-chat-rest, routes-table, event-registry, identity-tokens, routes-privileged-auth, system-prompt, isomux-authored-system-text, ui/log-view/isomux-curl.test.ts. build:ui and eslint green.
Locked: route paths and event names (slice 3 codes against them).

## SLICE-3 PICKUP (authored after slice 2 committed at 6cb395e)

What slice 2 taught: identity-tokens.test.ts pins the API capability list with toEqual, so a new capability edits that test too; the harness needs the "codex" backend on spawn for a fake agent; `operationalAuthenticated` only refuses app scope, the capability does the rest. The agent chat renders a person's message as plain pre-wrap text (Markdown is for agent output), so parity means plain text here too.

Goal: a self-contained panel that renders the stream with the agent chat's own cards, composes with attachments, edits in place, deletes, pages older on scroll, and keeps the unread state in the store - not yet mounted anywhere.
Mechanics:
- Store (ui/store.tsx): `membersChat: { messages: MembersChatMessage[]; hasMore: boolean; loaded: boolean; readPointer: string | null; unread: number }` in AppState + initialState. Wire actions (members_chat_message upsert by id keeping order, members_chat_deleted, members_chat_read) and client-local actions `members_chat_page` ({messages, hasMore, readPointer, unread, prepend: boolean}) and `members_chat_reset` (on socket reconnect: `loaded=false` so the panel refetches; find where full_state arrival resets per-connection slices). Reducer tests in ui/store.test.ts.
- API (ui/members-chat/api.ts): fetchPage(before?, limit?) via apiFetch GET; post({text, attachments, device}); edit(id, text); remove(id); markRead(lastReadId); upload(files) with a raw fetch multipart to /api/members-chat/uploads (apiFetch is JSON-only). The device label comes from ui/device-settings.ts getDevice().
- Cards: export `UserMessage` and `EditableUserMessage` from ui/log-view/LogEntryCard.tsx and add three optional props to UserMessage: `fileBase` (URL prefix for attachments; default stays `/api/files/<agentId>`), `avatar` (ReactNode drawn before the author label), `extraActions` (ReactNode after the edit button) and `editTitle` (default "Edit & branch"). Nothing else in the card changes; the agent chat renders byte-identical.
- Panel (ui/members-chat/MembersChatPanel.tsx, props-driven, store via hooks): header line "Members chat" with the online count from onlineUserIds and the mini ghosts of online users (GhostGraphic, size 14, from users Map avatarColor/avatarVariant); the list (oldest at the bottom, auto-scroll on own post, "load older" when scrolled to the top and hasMore); each message through UserMessage with the label rules: user -> formatIdentity(name, device); api -> `Name · API token "Phone"` non-human; agent -> `Name · agent` non-human; avatar = 12px GhostGraphic of the author when kind user (the trial); own messages get edit (in place, via EditableUserMessage) and delete; owners get delete on every message. A composer with the agent chat's box, paperclip, paste and drop uploads, staged chips with uploading/error state, Enter sends (touch: button), Shift+Enter newline, the 4000-char cap shown as a counter past 3500.
- Mark read: when the panel is visible and the newest message changes, POST markRead with the newest id (debounced 500 ms); the store applies the server's answer.
- Tests: reducer cases; a renderToStaticMarkup test of the panel with a seeded StateCtx (three messages of the three kinds: labels, non-human styling flag, attachment href under /api/members-chat/files/, avatar present for the user kind only); a test that LogEntryCard's user_message markup is unchanged with the new props absent (snapshot the string before/after in the same test by rendering with and without `fileBase`).
Acceptance: `bun test ui/store.test.ts ui/members-chat ui/log-view/LogEntryCard.test.ts` exit=0, build:ui exit=0, eslint clean, on the committed hash. No mount yet (slice 4).
Locked: store slice shape and action names.

## SLICE-4 PICKUP (authored after slice 3 committed at fbac177)

What slice 3 taught: the store's Action union lists wire members by hand, so a new wire event is a compile error until it is added there (tsc caught it; bun test did not); a static-markup test found a real bug (the file chip built `/api/files//name` because AttachmentDisplay did not forward fileBase), so keep those tests; an API token's and a privileged agent's posts belong to the person for edit and delete, in the UI as on the server.

Goal: the Lobby tab exists, members with no rooms land on it, the scene and the panel are mounted, the badge counts unread, and Nil can look at screenshots.
Mechanics:
- Store: `lobbyOpen: boolean` (client-local) + action `set_lobby_open`; `set_current_room` clears it; full_state with zero visible rooms opens it (no room to land on); `room_created` on a zero-room user keeps the lobby unless nothing else is selected (leave the existing selection rule alone).
- RoomTabBar: a Lobby tab first, not draggable, label "Lobby", active when lobbyOpen, with a small count pill when membersChat.unread > 0 ("99+" at the cap); click dispatches set_lobby_open. Room tabs deactivate while the lobby is open.
- App.tsx: title falls through to the office name while the lobby is open (Nil's rule); presence_update sends currentRoomId null while the lobby is open; saved view gains `lobby: boolean` (ui/view-persistence.ts, backward compatible: a missing field reads false) and restore reopens it; Tab cycling stays rooms-only (parked question for Nil).
- OfficeView: when lobbyOpen, the scene box renders `LobbyScene` (layout "fireside", palette "warm", rooms from the store, officeName from office.name, star from employeeOfTheMinute + crownHolder held in a ref) instead of Walls/Floor/desks/props/ghosts, and the MembersChatPanel sits to the right of the viewport at 380px (desktop). Zoom controls stay. The "No rooms assigned" overlay stays as it is.
- Mobile (AgentListView): when lobbyOpen the list area shows the panel full height; the header keeps its counts.
- ui/styles.ts: `[data-theme-mode="light"] .lobby-dark-only { display: none; }` next to the lamp-glow rule.
- Demo (ui/demo-server.ts): a canned stream (Ricky, Stephen, an API token line, an agent line) behind GET/POST/PATCH/DELETE /api/members-chat and POST /api/members-chat/read, fanning out members_chat_* through shimEmit; `bun run build:demo` is a gate this slice.
- Screenshots: scripts/members-chat-shots.sh builds the demo, serves a copy from /tmp/mchat-demo on port 9878 (PID kept, killed on exit), and a Playwright script (playwright-core from ~/nil/wallgame/node_modules, channel chrome) opens /demo/, clicks the Lobby tab, and shoots dark + light at 1280x800 and a 390x844 mobile shot into /tmp/mchat-shots/slice-4/. Looked at, not asserted.
- Tests: store reducer (lobbyOpen transitions, zero-room landing), RoomTabBar markup (Lobby tab present, badge text), view-persistence round trip with `lobby`, demo shim (GET page shape, POST fans out).
Acceptance: build:ui, build:demo, scoped tests (ui/store.test.ts, ui/office/RoomTabBar.test.ts, ui/view-persistence.test.ts, ui/demo-server.test.ts, ui/members-chat, ui/office), eslint on touched files, all exit=0 on the committed hash; three PNGs looked at.
Locked: tab label "Lobby"; the panel is a sibling of the viewport, never inside the SVG.

## SLICE-5 PICKUP (authored after slice 4 committed at d553e24)

What slice 4 taught: the store keys `users` by lowercased name, not id (ui/user-merge.ts), so anything that starts from a userId must index by id first - the first screenshot showed fallback ghost colours and "0 online" because of it; a static test with a by-id fixture had masked it, so fixtures must mirror the store's real keying. A row wrapper around the office viewport is enough to seat the panel beside the scene; the SVG never changes. Playwright through the demo bundle gives a real-browser shot in about a minute.

Goal: the doc surfaces say what shipped, the full typecheck is green on the final hash, and Nil gets the report with the parked queue.
Mechanics: features.md "Multi-user" gets a Members chat bullet and api/chat.ts the same line (Nil's voice: he approves the copy before it is applied to main, so it ships in the worktree and is listed for his review); README and landing untouched (not headline); AGENTS.md does not inventory routes. Gates: build:ui, scoped tests, eslint on touched files, `bunx tsc --noEmit` once. Then the completion note and the report.

## COMPLETION NOTE (2026-09-05, about 19:20 box time)

All five slices committed on branch `lobby`, on top of the lobby scene commits: c462e4a (store), 6cb395e (access and wire), fbac177 (panel), d553e24 (Lobby tab, mount, demo, shots), and the docs commit that carries this note. Every gate green on each hash; tsc clean on the final one. Screenshots in /tmp/mchat-shots/slice-4-final/ and copied to ~/nil/lobby-gallery/members-chat/. Not merged, not pushed, server untouched.

Parked for Nil: the mini ghost next to the author name (keep or strike); the two doc lines (features.md, api/chat.ts) in his voice; the scene layout and palette used for the mount (fireside, warm - a placeholder until his pick); whether Tab cycling should include the Lobby tab; a reviewer pass before merge; merge and restart (server code changed).
