# Implicit state machines in Isomux

Snapshot of main at `97bbdee71`, 2026-11-06 (task 0c3b26c4). Line numbers are from that commit and will rot; the entries name the field, so search for it.

An implicit state machine is state that moves through steps without one explicit representation: flags that only make sense together, a status written from many sites with no transition function, or timers and in-flight promises that hold a phase. Each entry says where it lives, what goes wrong, and whether to make it explicit.

## Method

Four read-only sweeps over `server/`, `ui/` and `shared/`, tests excluded. `control-plane/`, `site/` and `browser-extension/` were out of scope (the extension was read only where a server type depends on it).

- Flags that go together: grep for clusters of `boolean`, `?: number` timestamps and nullable fields on one interface (`internal-types.ts` `ManagedAgent`, `shared/types.ts`), and `useState(false)` / `useState<... | null>` clusters in one component.
- Status written from many sites: every field named `state`, `status`, `phase`, `mode`, `kind` or `stage`, with its write sites counted (assignments, object literals, `updateState(` calls).
- Timers and in-flight work: `setTimeout`, `setInterval`, `Promise` fields, `*InProgress`, `*Running`, `pending*`, `armed`, retry counters.

The sweep cannot find a phase held only in a closure's local variables or in the order of awaits in one function, unless a field also records it. "Make explicit" requires a past fix in git (cited) or a traced sequence to the bad state; "verify first" marks a sequence read from source but not reproduced.

## Ranked list

| # | Machine | Where | Verdict | Task |
| - | ------- | ----- | ------- | ---- |
| 1 | Agent busy state | `AgentInfo.state` + `SessionManager.pendingTurn` | make explicit | 28cab29a |
| 2 | Queue flush | `ManagedAgent.flushInProgress` and holds | make explicit | e7cd6259 |
| 3 | Session slot and dormancy | `SessionManager.session`, `dormant`, `sessionSwapping` | make explicit | 082ab039 |
| 4 | Browser grant and action fence | `browser-extension-bridge.ts` `Assignment`, `browser-extension-session.ts` `recovering` | make explicit | 701607e8 |
| 5 | WebSocket connection (UI) | `ui/ws.ts`, store `connected` | make explicit | d249cd25 |
| 6 | Cron run | `CronjobRun.status` + `ActiveRun` | make explicit | abc438ee |
| 7 | Editor tab save (UI) | `EditorPanel.tsx` tab `dirty`/`banner` | make explicit | b49c07fe |
| 8 | Provider sign-in | `ProviderAccountWire.loginStatus`, `ProviderSignInCard.tsx` | make explicit | da3fcc0b |
| 9 | Codex turn | `CodexSession` turn fields | make explicit, verify first | c4f2a5a6 |
| 10 | OpenCode server supervisor | `OpenCodeSupervisor` counters and timers | make explicit | 6619a97a |
| 11 | Full-page stack (UI) | `App.tsx` eight `*Open` flags | make explicit | 3484f6c9 |
| 12 | List snapshot loading (UI) | `asks-sync.ts`, pager, apps, webhooks loaders | make explicit | e2a2513b |
| 13 | Per-turn scratch flags | `ManagedAgent.limitStopFallback` and others | make explicit, verify first | 5433c5e1 |
| 14 | Terminal shell (UI) | `TerminalPanel.tsx` `owner`/`exited` | make explicit | 53bb50e1 |
| 15 | Task edit save (UI) | `TaskView.tsx` `savingId`/`saveConflict` | make explicit | 3b749d1f |
| 16 | App widget session (UI) | `AppWidgetPage.tsx` `refresh()` | make explicit | 4d7a21c1 |
| 17 | Members chat send (UI) | `MembersChatPanel.tsx` `sending`/`input` | make explicit | b80a15e0 |
| 18 | Welcome-model repick | `office-onboarding.ts` `fallbackRepickRunning` | not reachable (verified) | 5fc93a72 |

Entries 19 and later are "leave" (below).

## Make explicit

**1. Agent busy state.** `AgentInfo.state` (`shared/types.ts:28-34`) has 65 `updateState(` calls (agent-manager.ts 35, command-handlers.ts 26, session-manager.ts 3, agent-auth.ts 1), and `updateState` (`agent-manager.ts:2477`) accepts any previous state. Two boot writes skip it (`agent-restore.ts:565,584`). Whether a turn runs is a second fact, `SessionManager.pendingTurn`, so readers repeat `state === "thinking" || ... || pendingTurn !== null` inline about 14 times. `"stopped"` is a dead member: no server code writes it, and 5 server guards and 5 UI sites still test for it. Past fixes: `fcd7b4564` (a message racing a flush flipped the agent to error; the fix patched readers to OR in `pendingTurn`), `d9210d400` (late Codex items put the agent back to busy), `6e1ac8760`. Shape: one stored turn phase with a guarded transition, one `isBusy()`, `"stopped"` removed.

**2. Queue flush.** `flushInProgress`, `flushStartedAt`, `queueHolds`, `backendHold`, `autoResumeInProgress`, `nextTurnRestartWake`, `boundaryClaim` (`internal-types.ts`). `flushQueue` (`agent-manager.ts:5491-5890`) re-checks its preconditions after each await in four copies, and at least six callers re-trigger it, each with its own guard. `sweepStuckFlushes` (`agent-manager.ts:4542`) exists because "a trigger was missed somewhere". `autoResumeInProgress` has two copy-pasted claim sites (`message-queue.ts:995`, `handoff-and-wake.ts:225`). Past fixes: `6e1ac8760` (stranded flush waits), `98390c417` (the watchdog). Shape: a flush state union (idle / held with reasons / flushing with start time) and one `requestFlush()` that every trigger calls.

**3. Session slot and dormancy.** `session`, `consumerPromise`, `sessionId` (`session-manager.ts:183-188`), `dormant`, `sessionSwapping`, `dormantReason`, `envStale`. The header says every write goes through `SessionManager`, but `kill` writes `session` (`agent-manager.ts:7762`) and `sessionId` has 8 writes outside it. Three teardowns and six install sites. A known race is documented in source: a wake during a swap drain wins and a /resume pick no-ops (`session-manager.ts:672-680`). Past fixes: `6b214fd43` (kill during the drain leaked the replacement), `6e1ac8760`. Shape: one slot union (live / swapping / released with reason / dead) owned by `SessionManager`.

**4. Browser grant and action fence.** `Assignment` (`browser-extension-bridge.ts:118-172`) holds `creating`, `connected`, `announcing`, `announced`, `closed`, `recovery`; `assign()` refuses while `connected || recovery || pendingCount`, so a stale flag locks the tab. The action fence (`browser-extension-session.ts:253-269`) is a `recovering` map entry with an optional `ceiling`, cleared at two sites guarded only by identity checks. Past fixes, all for a wedged tab: `ec44bebce`, `12647d62a`, `69d2e1089`, `5b528d73b`, `86135b150`, `88bd1021f`. Shape: one grant union (offered / attached / recovering / released) that owns the fence state. One task, because `assign()` reads both.

**5. WebSocket connection (UI).** `ui/ws.ts:8-17` holds `socket`, `pongTimer`, `reconnectTimer`, `heartbeatTimer`, `connectTimer`; the store holds `connected`, `hydrationEpoch`, `logsReplay`. `checkLink()` (`ws.ts:123-142`) and the connect timeout (`ws.ts:178-182`) open a new socket without `connHandler(false)`; the store comment (`store.tsx:204-209`) records it. Traced: tab returns visible → `checkLink` → pong times out → `connect()`; while the new socket is CONNECTING, `send()` returns false (`ws.ts:244-252`), so terminal keys and commands drop, and the offline banner stays hidden because `connected` is still true. Past fixes: `e57beae46`, `773defdee`, `318e591f7`. Shape: one connection union (connecting / open-unhydrated / live / backing-off) that drives the banner. Task d249cd25 (2026-11-06) made every socket replacement report the link down in `connect()`, so the banner shows and the composer refuses until the new `full_state`; the union is not built.

**6. Cron run.** `CronjobRun.status` with `endedAt`, `errorReason` (`shared/types.ts:2087`), plus in-memory `ActiveRun` (`killed`, `hardTimeoutTimer`) and session-id placeholders (`pending-`, `skipped-`). 12 status writes; `finalizeRun` has 13 callers and is idempotent only by object identity; two failure paths and agent-target runs skip it; resume reopens a terminal run as `running`. Past fixes: `e505f9f5b` (a late close ended the run that took its slot, task 44872c41), `82e0e40a0`. Shape: one run union and one transition function, with agent-target runs in `activeRuns` too.

**7. Editor tab save (UI).** Tab `dirty` and `banner` (`EditorPanel.tsx:207`); saving is not represented. Traced: Ctrl+S sends a PUT; the member types (`:698-699` sets `dirty: true`); the PUT resolves and `saveTab` sets `dirty: false` (`:474`) without comparing content, so the tab loses its unsaved marker, and a later re-open (reconnect, external change) replaces the typed text with disk. Past fixes in the same banner machine: `e48e852a1`, `88451a94c`. Shape: per-tab `saving` with the content it sent; resolve marks clean only if the content still matches. Fixed in task b49c07fe without a new field: a save marks the tab clean only when the buffer still holds what it sent, and saves on one file run one at a time (`savesRef`), each based on the rev the save ahead returned.

**8. Provider sign-in.** Server: `Active` is a union, but `wire.loginStatus` is written at 7 sites in `provider-account-manager.ts` and cached separately. UI: `ProviderSignInCard.tsx:207-230` holds 11 variables (`running`, `localWaiting`, `codeSubmitted`, `signInError`, ...) next to the wire status, with an effect that only patches `signInError` beside Connected. Past fixes: `1133b23b5`, `97658f53d`, `8c0729078`, `58f70d916`, `2fb0a688c`. Shape: the server's `Active` union is the only phase; the card derives its view from the wire status plus one local "request in flight".

**9. Codex turn (verify first).** `CodexSession` (`backends/codex/adapter.ts:1151-1223`): `activeTurnId`, `turnInFlight`, `turnStarting`, `abandonedTurn`, `cancelCapacityRetry`, `cancelTurnWatchdog`, `selfInterruptedForAuth`, plus about 8 per-attempt flags. Read in source, not reproduced: if the subprocess exits while a capacity retry's `turn/start` is in flight, `handleSubprocessExit` emits a failed turn_completed (`:3524-3543`) and the retry's `.catch` (`:1953-1961`) emits a second. Past fixes: `acb0ffe28`, `d9210d400`, `ff27ef3c8`. Shape: one turn union (idle / starting / running(id) / backoff / abandoned). Task c4f2a5a6 (2026-11-06) reproduced the double turn_completed and replaced `turnInFlight`, `turnStarting` and `cancelCapacityRetry` with one `CodexTurn` union (idle / starting / running / backoff), written by `setTurn` and ended once through `endTurn`; `abandonedTurn` and `activeTurnId` stay separate fields, because the first outlives its turn and Codex can name a turn before `turn/start` returns.

**10. OpenCode server supervisor.** `OpenCodeSupervisor` (`backends/opencode/supervisor.ts:230-270`): `leases`, `activeTurns`, `holds`, `idleTimer`, `shutdownPromise`, `starting`, `replacementPromise`, `reloadRequested`, `unresponsive`. Past fixes, all races between these: `5d57ff510` (a start in flight stopped a held server), `0eb3befce` (a busy server killed), `fc67f65fe` (a pending replacement failed turns). Shape: one server union (none / starting / running / replacing / shutting down) with the counters inside running.

**11. Full-page stack (UI).** Eight `*Open` booleans plus `backRoomOpen` in `App.tsx:151-227`, about 30 setter sites; the stack order is inferred by fixed precedence (`routes.ts:162-214`). The code says a door that opens a page under the one shown breaks it (`routes.ts:198-202`, `App.tsx:253-255`). Past fix: `6bde41c54`. Shape: one page stack array.

**12. List snapshot loading (UI).** Asks, pager, apps, webhooks and members chat each encode not-loaded / loading / loaded / failed / refused-by-delta differently (`store.tsx:286-365`). Traced: `useAsksSync` swallows a failed GET (`asks-sync.ts:28`, `() => {}`), and the Asks page then shows its empty state (`AsksView.tsx:817-821`) until the next reconnect. Shape: one shared loader state type and reducer helper.

**13. Per-turn scratch flags (verify first).** `authNeededThisTurn`, `limitStopResetsAtMs`, `limitStopFallback`, `freeLimitNoticeThisTurn`, `freeModelResend`, `pendingFreshRecoveryNotice`, `editTurnText` (`internal-types.ts`), each reset at a different subset of turn start, turn_completed and conversation reset. `limitStopFallback` is set only at `session-accounts.ts:557` and cleared only on turn_completed (`agent-manager.ts:3446,3453`). Check: a turn on the member sign-in gets a usage-limit stop and then ends without turn_completed (stream error, swap, kill); does the next turn's turn_completed then queue a fallback continue? Shape: one per-turn record created in `beginTurn` and dropped on every turn end. Task 5433c5e1 (2026-11-06) confirmed the stale continue (a stream that dies after the stop) and moved the four flags that act at a turn's end into `ManagedAgent.turnFlags` (`TurnFlags`), which `beginTurn` and the conversation reset replace. `freeModelResend` is set per send, and `pendingFreshRecoveryNotice` and `editTurnText` are set before the turn begins, so they stay outside it.

**14. Terminal shell (UI).** `owner` and `exited` (`TerminalPanel.tsx:293-303`). `terminal_status` sets `owner` but never clears `exited` (`:365`); both events go to every viewer. Traced: viewer A sees the shell exit; viewer B restarts it; A keeps the "shell exited" overlay over a live shell, and A's Restart skips the confirm because `exited !== null` (`:855`), so one click kills the live shell. Shape: one shell union (unknown / running(owner) / exited(code)).

**15. Task edit save (UI).** `confirmDiscard`, `confirmDelete`, `savingId`, `saveConflict` (`TaskView.tsx:221-228`). Traced: `handleSave` treats only a 409 as failure (`:360`); any other error, a network drop included, falls through to `onClose()` (`:369`) and the edits are lost with no message. Same cluster in `WebhookDialog.tsx`, `CronjobDialog.tsx`. Shape: a save union (editing / saving / conflict / failed(message)).

**16. App widget session (UI).** 18 state variables in `AppWidgetPage.tsx:262-291`. Traced: the 60 s recheck calls `refresh()` (`:443`); on any failed GET its catch (`:427-432`) sets `frameUrl(null)` and `setOpen(false)`, which unmounts the app frame and closes the member's chat for a transient error. Shape: a session union (live / recovering / unavailable) where a failed recheck keeps the frame.

**17. Members chat send (UI).** `input`, `staged`, `sending`, one shared `error` (`MembersChatPanel.tsx:250-257`). Traced: the textarea stays enabled while `sending`; on success `handleSend` runs `setInput("")` and `setStaged([])` after the POST (`:417-419`), so text typed and files attached during the POST are lost. Shape: send the snapshot and clear only what was sent.

**18. Welcome-model repick (not reachable).** `fallbackSeededAgentIds`, `fallbackRepickRunning`, `fallbackRepickGeneration` (`office-onboarding.ts:269-272`). One discovery runs at a time, with the `userId` of the member whose agent started it. An agent another member seeds meanwhile joins the set and is moved by the same loop (`:296`) with the first member's result, or, if it joins after the loop, by the re-arm in `finally` (`:331-334`), which again passes the first caller's `userId`. Check whether discovery differs per member, on both paths. Shape: a queue of (userId, agentId) pairs. Verified in task 5fc93a72: not reachable. Only the first owner's seed calls `repickFallbackSeeds`: both claims refuse once an owner exists, and the last owner cannot be deleted or demoted, so every call in one process carries one `userId`.

## Leave

19. Abort (`aborting`, `abortPromise`, `abortCancelToken`, `session-manager.ts:203-226`): one writer (`abort()`), three recent fixes (`ec9237c65`, `22f7dc306`, `5734b68e7`); folds into 1 if 1 lands.
20. Handoff phase (`autoHandoffPhase` union plus `handoffInProgress`, `autoHandoffSpent`/`Opened`): partly explicit; no bug found.
21. Two-step prompts (`pendingResume`/`ModelPick`/`EffortPick` duplicate `pendingInteraction.kind`; `agent-manager.ts:2209-2230`): redundant storage, two writers; `openChoiceInteraction` does not clear `pendingPermission` (no sequence traced).
22. Claude session (`ClaudeSession`, `backends/claude.ts:1017-1028`, `:1767`): plan mode is three fields (`reportedPlanMode`, `memberPlanMode`, `planModeReady`) written only inside the class (about 8 sites, `:1059-1099`); `ended`, `closed` and `stoppedThisTurn` each have one setter. No bug found.
23. OpenCode transport turn (`transport.ts:554-604`): a `close()` during `beginTurn()` is not re-checked; unchecked, and abort is gated by `canAbortInPlace`.
24. Restart-wake record and usage-limit resume (`handoff-and-wake.ts:347-644`): keyed timers that re-read state; inherit 1.
25. Queued-message kind flags (`QueuedMessage`, 12 booleans): exclusion lists by hand in `message-queue.ts`; no bug found.
26. Agent access `access`/`privileged` (`shared/types.ts:917-927`): kept in sync at the writers; spawn refuses privileged.
27. Ask command run (`AskCommandRun.state`): one cleanup failure leaves `running` until boot marks it lost; logged.
28. Paged-ask delivery (`pager-delivery.ts`, `page-items.ts`): a pending "resolved" notice lives in memory only, as `page-items.ts:9-10` says; the comment at `pager-delivery.ts:446` ("retried after a restart") contradicts it.
29. Ask answering (UI; `store.tsx:333-344`, `AskCard.tsx:414-432`): two recent fixes (`122d56e84`, `911cd8122`); secret and sudo cards never dispatch `ask_answer_started`.
30. App WebSocket relay and upstream close (`app-ws-relay.ts`, `app-ws-upstream.ts`): explicit `state` plus duplicate flags; one `finish()`.
31. Sudo request (`sudo-requests.ts`): the wrong-password count is memory-only, so a restart resets it.
32. Discord bot (`discord/supervisor.ts`): `status` is a union; `halted`/`removed` beside it carry two meanings.
33. Smaller, one owner each: task board status (PATCH and GitHub sync both write), office export job, extension socket handshake, GitHub link status, webhook delivery row, secret-proxy and PTY sidecar, terminal recorder, members chat page loading, draft attachment upload, dictation, spawn-dialog model catalog, ghost door transitions, WhatsApp route form.

## Already explicit

- Stop-notice arm: `StopNoticeArm.state` with `pushStopArm`/`settleStopArm` (`stop-notice-arms.ts`).
- Context samples: generation-guarded commit (`usage-readings.ts`).
- Session account move: `SessionMove` union.
- Old pager pages: one `transition()` (`pager-store.ts:843`).
- App runtime: derived from systemd per read (`app-supervisor.ts`); the registry stores no runtime state.
- Scheduled messages: a persisted pending list and a tick loop, no phase (`scheduled-messages.ts:4-8`).
- Step asks: derived by predicate (`step-asks.ts`).
- `WhatsAppStatus`, `DiscordBotStatus`, `OfficeUsageStatusWire`, `UpdateStatusWire`, `Schedule`, `AskEvent`: discriminated unions.
- UI: `update-watch.ts`, `UpdatePane` phase, `AskActionBlock` phase, terminal command delivery (`advanceCommandDelivery`), `useConfirmStep`, the log outbox, `useRecordedDictation` (`move()`), `recording-mode.ts`.
