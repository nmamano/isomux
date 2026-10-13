# Automatic Handoff Mode

Design for task b7e88135 (P0): "A mode where the user doesn't need to worry about hand offs. When context crosses a threshold, it hands itself off to a new session automatically." Design only (2026-10-13); no product code until Nil approves. Line numbers are from main at 5747e770. The mechanism details are in Appendix C.

## Summary

A per-agent toggle, off by default. When it is on and a completed turn leaves a Claude agent's context at or above 75% full, the server runs one more turn, the **brief turn**: it asks the agent for a forward-looking brief and takes the reply as that brief. Then it runs the existing handoff logic, which resets the session and delivers the brief, followed by every queued message, to the fresh session. Members see one line in each chat. If a step fails, the conversation continues, and the mode does not try again in that conversation.

## 1. Turning it on

**Recommendation: a per-agent boolean `autoHandoff`, default `false`, set in the agent edit dialog.**

- It sits with the other per-agent settings: `AgentInfo`, `PersistedAgent` and the `EditAgentReq` pick (`shared/contract-shapes.ts:92-110`). The persisted field is optional and read as `?? false`, like `privileged` (`server/persistence.ts:778-784`), so old state files load with no migration.
- No room or office default in v1. No room or office setting controls agent behaviour today (`OfficeSettings`, `shared/types.ts:1561-1565`), and a new layer is a state-layout change (P2).
- Off by default, because the mode skips the member-approval step of `/handoff` (`skills/isomux-handoff/SKILL.md`, step 2) and clears the chat (section 5). P1 asks about new agents.
- The toggle shows only where the engine supports the mode, through a new `AgentCapabilities.autoHandoff` flag. `capabilities` already gates UI per engine (`shared/types.ts:715-717`). In v1 only Claude sets it.

## 2. Threshold and measurement

**Recommendation: one constant, `AUTO_HANDOFF_PCT = 75`, next to `CONTEXT_NOTICE_BANDS` (`server/agent-turn.ts:345-348`). Claude only in v1.** 75 is the existing wrap-up band. It is a constant, not a setting, per Nil's rule.

Each engine feeds `ManagedAgent.contextUsage` (`server/internal-types.ts:24-31`, `:90`):

| engine | source | how exact |
|---|---|---|
| Claude | SDK `getContextUsage()`, passed through untouched (`server/backends/claude.ts:665-675`). Sampled after every `turn_completed` (`server/agent-manager.ts:4725`). | The CLI's own count; how exact it is has not been measured. It also reports `isAutoCompactEnabled` and `autoCompactThreshold` (`server/backends/types.ts:343-345`). |
| Codex | The `last.*` counts of the latest `thread/tokenUsage/updated` against `modelContextWindow` (`server/backends/codex/adapter.ts:1402-1436`, `:1840-1855`). | Close: the last request's input plus output. Null until the first notification. Codex compacts its own thread. |
| OpenCode | The latest step's `total` (`server/backends/opencode/transport.ts:1596-1610`) against `getModelContextLimit()` (`server/backends/opencode/adapter.ts:171-185`). | Close, per step. Null when the provider reports no limit. OpenCode compacts by itself (`transport.ts:1052`). |

- **Claude only.** The 75% notices already skip Codex and OpenCode, because they compact their own threads (`server/agent-turn.ts:444-452`, `server/agent-manager.ts:4031-4040`). P3 asks about extending it.
- **Auto-compact guard.** If Claude compacts first, the handoff never happens. So the trigger is `min(75, autoCompactThreshold / maxTokens * 100 - 5)` when auto-compact is on. The 5 points leave room for the brief turn. The snapshot must keep `autoCompactThreshold`, which `commitContextSample` drops today (`server/agent-manager.ts:3993-3999`). The real auto-compact percentage is unchecked; the server reads it at runtime.

## 3. Trigger

**Recommendation: between turns only, right after the crossing turn ends (eager). Never mid-turn.**

- **Arming.** A sample from a `turn_completed` of status `completed` arms the mode when it is at or above the trigger, the mode is on, no attempt was made in this conversation, and the loop guard (section 6) does not pause it. An interrupted turn does not arm it: a member who presses Stop wants attention, not a reset.
- **One phase.** From arming to the reset, an in-memory phase holds the queue back from the old session. While it is set, every `flushQueue` call starts the brief turn instead of sending a batch. So every existing flush trigger, the queue watchdog included, is a start site. The other start site is `commitContextSample`, for an agent that is idle with an empty queue. **Invariant: while the phase is set, a queued message waits only behind a brief turn that is running or that the current `flushQueue` call starts, or behind the handoff that follows it.** Every exit releases the phase and kicks a flush. Appendix C has the gates, the release list and the second-start guard.
- **Turn in flight.** It always finishes. Mid-turn, Claude has no fresh number, and a reset would kill running tool calls. In a very long turn, Claude's auto-compact stays the safety net, and the agent can still run `/handoff` itself.
- **Queued messages.** They go to the fresh session after the brief, through `handoff`'s `keepQueue` (`server/agent-manager.ts:9128`). Messages that arrive while the phase is set wait in the queue. A new steer is declined with `steerDeclined: "auto_handoff"`. A member's send-now still aborts the brief turn: the member's explicit action wins, the attempt fails (section 6), and the queue flushes to the old session as today.

## 4. What the new session gets, and who writes it

**Recommendation: the agent writes the brief in a server-run brief turn. The server captures the reply and runs the existing handoff logic. The agent does not call the route itself.**

- **Brief turn.** One isomux-authored prompt through `runAgentTurn` (`server/agent-turn.ts:70`), with `humanInput: false` and `usageCapped: true`. The usage cap covers input that comes from no human (`server/agent-manager.ts:3200-3221`). The prompt keeps the content rules of `/handoff` step 1. Draft (agent-facing, English only):

  > `[automatic handoff: your context is NN% full and this session is about to be handed off to a fresh one. Reply with only the brief for the fresh session: what is left, the next steps, working state not visible on disk (worktrees, uncommitted files, tokens you hold, replies you wait for), decisions not to relitigate, and any question you last put to a member, verbatim - their answer will reach the fresh session. Leave out a recap and anything in your system prompt or memory. Do not call the handoff route.]`

  The last-question clause matters: with eager timing, the member's next message usually answers the agent's last reply, and the fresh session sees only the brief.
- **In the old chat** the prompt is not shown and has no sender. The section 5 system entry stands for it, the same way the `[context check: ...]` block is not shown.
- **Capture.** The brief is all `assistant_text` (`server/agent-manager.ts:4532-4534`) after the brief turn's last tool call. Tools are allowed, so the agent can check `git status` first.
- **Delivery.** Today's `handoff` body (`server/agent-manager.ts:9266-9329`): transactional, keeps the queue, and marks the brief as `[Handoff from your previous session]` (`:6297-6307`). A manual `POST /api/agents/:id/handoff` during the phase gets 409 `handoff_in_progress`, the agent's own call included. The HTTP route (`server/routes/table.ts:657-672`) does not change.
- **No brief, no handoff.** The server does not write a fallback brief from the transcript: that would be a recap, which `/handoff` tells agents to leave out, and the current session is still usable.

## 5. What members see

- **Old chat, as the brief turn starts:** a persistent system entry, `Context is NN% full. Writing a handoff brief for a fresh session.` The brief then appears as normal agent text.
- **75% notices.** The member notice (`server/agent-manager.ts:4056`) and the agent notice (`server/agent-turn.ts:441-470`) are suppressed only while an attempt is still possible. After a failed or paused attempt they fire as today. The 50% band does not change.
- **The reset** clears the chat (`server/agent-manager.ts:9190-9194`), as a manual `/handoff` does. This also removes the crossing turn's reply (P5). The old conversation stays in `/resume`.
- **Fresh chat, first entry:** a persistent system entry, `Handed off automatically at NN% context. The previous conversation is in /resume.` Then the brief and the agent's first reply.
- **An audit row** with its own actor kind (Lead ruling, see "For the Lead").
- New member-facing strings go through `shared/i18n`, en plus every locale.

## 6. Failure cases

| case | behaviour |
|---|---|
| Brief turn errors, is aborted, is refused by the usage cap, or gives no brief; or `handoff` fails | No handoff. A system entry: `Automatic handoff did not complete. This conversation continues; /handoff hands off by hand.` The attempt is used, the 75% notices come back, and auto-compact stays the backstop. A failed write loses nothing: `handoff` takes the brief out again (`server/agent-manager.ts:9304-9316`). |
| `/clear`, resume or fork during the brief turn | The brief turn ends with `SessionSwappedError` and the text is discarded. No entry: the member's action explains it. |
| Handoff loop (the fresh session starts at or above the trigger, for example because of a huge brief) | **Provenance rule.** A conversation opened by an automatic handoff carries an in-memory flag. If its first sample is at or above the trigger, the mode pauses for that conversation, with one entry: `Automatic handoff is paused for this conversation: it started above the handoff threshold.` No other conversation pauses this way. **Worst case:** a restart loses the flag, so a conversation can hand off once more per restart. The next one has the flag again. |
| Engine without a usable measure | Codex and OpenCode do not offer the mode. A Claude sample that returns null (`server/backends/claude.ts:672-674`) commits nothing, so nothing arms. After a restart nothing arms until the first completed turn (accepted v1 behaviour, `internal-docs/context-fullness-visibility.md`). |
| Cron run | Not applicable: a cron run is a separate one-turn session with no `ManagedAgent` and no sampling (`server/cronjob-manager.ts:34-37`). A cron message to an agent is ordinary input. |
| Agent on a permission prompt | It is mid-turn, so nothing arms. The brief turn never starts in a multi-step flow (`server/internal-types.ts:429-437`); the phase waits for the next flush. A brief turn that parks on a prompt waits like any turn; a denial or abort is the first row. |

## PARKED FOR NIL

1. **P1: Default for new agents.** Recommend off: the mode skips approval and clears the chat without the member asking. Alternative: on for new Claude agents.
2. **P2: Room or office default.** Recommend none in v1, only the per-agent toggle. A layered default is a new state layout.
3. **P3: Codex and OpenCode.** Recommend Claude only, like the 75% notices. Their harnesses compact on their own, and no lane has shown when a handoff beats that.
4. **P4: Absolute cap on 1M windows.** 75% of 1M is 750k tokens. Recommend no cap in v1: one percentage, the band members know. Alternative: `min(75%, 400k)`.
5. **P5: Eager timing clears the reply the member is reading,** often within a minute (it stays in `/resume`). Recommend eager: no added wait on the next message. Alternative: lazy, which hands off at the next message, so the reply stays on screen but that message waits for a whole brief turn.

## For the Lead (route, wire and state-layout proposals)

Proposals, not decisions. The Lead rules on them before any code:

- A persisted per-agent field `autoHandoff?: boolean` (`PersistedAgent`, `AgentInfo`, `EditAgentReq`) and a wire field `AgentCapabilities.autoHandoff`.
- A new `steerDeclined` value `"auto_handoff"` in the message-route response.
- An audit row for an automatic handoff. Recommend none in v1: `AuditEntry` has no place for an "automatic" mark (`shared/audit.ts`), and an `agents.handoff` row with the agent as actor would credit the agent with a server action.

Lead rulings (2026-10-13), for implementation after Nil's go:

- The persisted field `autoHandoff?: boolean`, read as `?? false`, and `AgentCapabilities.autoHandoff`: approved.
- `steerDeclined: "auto_handoff"`: approved.
- Audit: write a row. Secrets B2 set the precedent for a server action with its own actor kind (`secret_proxy`): an automatic handoff gets one too (for example `auto_handoff`), with the agent as the target, so the audit log shows that the server, not the agent or a member, cleared the conversation.

## Doc surfaces at implementation

`docs/features.md` (the `/handoff` line, `:34`), `server/agent-reference/conversation-lifecycle.md` (one sentence: a reset can come from the server), `/help` if it fits. `server/system-prompt.ts:107` does not change: the brief-turn prompt says all the agent needs, and the system prompt avoids per-agent differences.

---

## Appendix A: Alternatives not chosen

- **Lazy trigger (hand off at the next inbound message).** This keeps the last reply on screen until the member answers. But that message then waits for a whole brief turn, and every send path needs the check: `flushQueue`, direct `sendMessage` (`server/agent-manager.ts:8288`), skill expansion (`server/command-handlers.ts:1244`) and edit (`server/agent-manager.ts:10007`). Eager needs only `flushQueue` and `commitContextSample`.
- **The agent calls `POST /handoff` itself (the `/handoff` skill without step 2).** No capture code is needed. But it depends on curl and JSON quoting of a long brief, and the server sees a failure only as "the turn ended with no handoff".
- **The server writes the brief from the transcript tail.** That is a recap, not a forward-looking brief. Not used even as a fallback.
- **Mid-turn trigger through a steer.** In-flight work is in an unknown state, and the Claude number is stale until the turn ends.
- **Keep the chat across the handoff.** `newConversation` clears it on purpose: a timeline across sessions makes edits of old entries fail (`server/agent-manager.ts:9190-9192`).
- **Per-agent threshold setting.** More UI for little gain; a constant follows Nil's rule on settings.

## Appendix B: Evidence index

- Snapshot, generation and fired-sets: `server/internal-types.ts:24-31`, `:90-126`. Sample commit: `server/agent-manager.ts:3983-4019`. Member notice: `:4027-4058`. Refresh: `:4066-4091`. Turn-boundary sampling: `:4718-4725`. Codex `usage_update` sampling: `:4850`. `/context` reading auto-compact: `server/command-handlers.ts:473-480`.
- Agent notice and its engine opt-out: `server/agent-turn.ts:332`, `:345-348`, `:441-470`.
- Handoff: `server/agent-manager.ts:9105-9246` (`newConversation` with `keepQueue`), `:9253` (guard), `:9266-9329` (`handoff`). Route: `server/routes/table.ts:644-672`. Handler: `server/routes/handlers/conversation.ts:603-619`. Office wiring: `server/isomux-office.ts:4911-4920`.
- Skill: `skills/isomux-handoff/SKILL.md`. Agent reference: `server/agent-reference/conversation-lifecycle.md`. System prompt pointer: `server/system-prompt.ts:107`.
- Queue: idle check `server/agent-manager.ts:6651-6653`; `flushQueue` `:6869-6910`; idle-branch flush in `enqueueMessage` `:6806-6815`; idle-transition trigger `:3496-3512`; send-accept drain `:7083-7091`; watchdog `:5370-5386`. Steer: decision `:6739-6762`, `:6826-6855`; tool-boundary delivery and drain `:6426-6482`, `:4690-4696`. Conversation-boundary reset: `:3876`.

## Appendix C: Mechanism

**Phase.** `managed.autoHandoff` holds `{ briefStarted: boolean }` (in memory only). It is set at arming and cleared at the queue splice in `newConversation` (`server/agent-manager.ts:9128`), or earlier on an exit.

**Gates while the phase is set:**

- `flushQueue` (`:6869`): after its existing waits and guards (`:6898-6900`), if the phase is set it starts the brief turn when `briefStarted` is false, and it returns without sending a batch. Its empty-queue early return stays. An empty queue means no message waits. An agent that armed while busy and then went idle with an empty queue starts the brief turn at its next message.
- The idle-transition trigger in `updateState` (`:3496-3512`) needs no change: it calls `flushQueue`.
- `takeToolBoundaryMessage` (`:6426-6475`) returns null. Without this gate, a `steer: true` item already in the queue would take the whole eligible queue into the brief turn at its first tool boundary (`:6445`), and `drainBoundaryClaim` would remove those items before the handoff (`:4690-4696`, `:6478-6482`).
- `enqueueMessage` declines a new steer with `steerDeclined: "auto_handoff"` (next to the existing reasons at `:6826-6855`). The item stays queued.
- The route's `handoff` is split. The outer guard answers 409 `handoff_in_progress` when `handoffInProgress` (`:9253`) or the phase holds the agent. The auto path calls the inner body, today's `handoff`, directly, so it does not block itself.

**Start sites.** (1) `flushQueue`: every caller, including enqueue's idle branch (`:6806-6815`), the idle transition, the watchdog (`:5370-5386`), boot replay and the post-turn kick. Like the notice step (`server/agent-turn.ts:453-462`), `flushQueue` first waits up to 500 ms for the in-flight sample, so a sample that lands in time arms the phase before the batch goes out. A later sample means the batch goes to the old session, the phase arms during that turn, and the next `flushQueue` call starts the brief turn. (2) `commitContextSample` (`:3983`), when it arms an agent that is idle, with an empty queue and not in a multi-step flow.

**Second-start guard.** The start function checks and sets `briefStarted` synchronously, before any await. `beginTurn` then puts the agent in a busy state, which `flushQueue`'s idle check also refuses. `briefStarted` stays true from the start of the brief turn until the phase is released (at the splice on success, or by the owner on failure). It is never cleared at turn end: the brief turn's own idle transition calls `flushQueue` (`:3499-3505`) before the owner captures the text and before `handoff` reaches the splice (it first awaits `prepareEnqueue`, `:9276`). In that window the agent is idle, and `briefStarted` alone stops a second brief turn in the old session. The brief turn does not hold `flushInProgress`, because `newConversation`'s held-queue flush (`:9228-9244`) skips when that flag is set.

**Arming input.** `refreshContextUsage` samples on every turn status and passes only `source` (`:4718-4725`), so its token also carries the turn status, and `commitContextSample` arms only on `completed`.

**Release.** Every exit clears the phase and then calls `flushQueue` if the agent is idle and the queue is not empty, so the queue is never left waiting (the lost-wakeup hazard at `:6880-6889`):

- success: cleared at the splice; `newConversation` then flushes the held queue into the fresh session (`:9228-9244`).
- failure (error, abort, usage cap, no brief, `handoff` refused): cleared by the brief-turn owner.
- `/clear`, resume, fork: cleared in `resetContextUsage` (`:3876`), which every conversation boundary calls.
- stop: cleared when the state becomes `stopped`; the queue stays, as on any stop.
- kill: removed with the agent.

**Provenance flag.** The auto path passes `autoHandoff: true` to `newConversation` in the opts next to `keepQueue`. `newConversation` sets the new conversation's provenance flag right after `resetContextUsage` (`:9189`). It cannot be set before the call, because the reset clears it. It cannot be set after `await newConversation`, because the held-queue flush may already be running.
