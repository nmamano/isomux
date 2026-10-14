# Automatic Handoff Mode

Design for task b7e88135 (P0): "A mode where the user doesn't need to worry about hand offs. When context crosses a threshold, it hands itself off to a new session automatically." Written 2026-10-13 as a design; built 2026-10-14 with Nil's rulings of 2026-10-13 and 2026-10-14, which replaced the first draft's 75% threshold and its Claude-only scope. Line numbers are from main at 5747e770 and have moved since; the code is in `server/auto-handoff.ts` and the automatic-handoff block of `server/agent-manager.ts`. The mechanism details are in Appendix C.

## Summary

A per-agent switch, off by default. When it is on and a completed turn leaves the agent's context at or above the trigger (section 2), the server runs one more turn, the **brief turn**: it asks the agent for a forward-looking brief and takes the reply as that brief. Then it runs the existing handoff logic, which resets the session and delivers the brief, followed by every queued message, to the fresh session. All three engines take part. If a step fails, the conversation continues, and the mode does not try again in that conversation.

## 1. Turning it on

**A per-agent boolean `autoHandoff`, default `false`, set in the agent edit dialog.**

- It sits with the other per-agent settings: `AgentInfo`, `PersistedAgent` and the `EditAgentReq` pick. The persisted field is optional, written only when on and read as `?? false`, so old state files load with no migration. Spawn takes no such field; the spawn dialog switches it on with an edit right after the spawn.
- No room or office default.
- Off by default, because the mode skips the member-approval step of `/handoff` (`skills/isomux-handoff/SKILL.md`, step 2) and clears the chat (section 5).
- The switch shows only where the engine supports the mode, through `AgentCapabilities.autoHandoff`. Claude, Codex and OpenCode set it; the OpenCode tracer does not.

## 2. Trigger and measurement

**Hand off at 500k tokens or at 90% of the window, whichever comes first (Nil, 2026-10-13). An engine that compacts on its own before that point gets a trigger 5 points of the window ahead of its compaction point.** In tokens: `min(500_000, 0.9 x window, compactAt - 0.05 x window)`, the last term only when the engine's compaction point is knowable. On a tie the earlier term in that order is the one reported. Constants, not settings: `server/auto-handoff.ts`. The 5 points leave room for the brief turn, which runs in the old context.

Each engine feeds `ManagedAgent.contextUsage`. Claude reports its compaction point through the SDK's `autoCompactThreshold`; an adapter reports its own in the internal `ContextUsage.compactAtTokens`, which `/context` does not show. The snapshot keeps the point as `compactAtTokens`; it is not on the wire.

| engine | context use | compaction point (source checked 2026-10-14) |
|---|---|---|
| Claude | SDK `getContextUsage()`, passed through. Sampled after every `turn_completed`. | The SDK's own `autoCompactThreshold` when `isAutoCompactEnabled`. |
| Codex | The `last.*` counts of the latest `thread/tokenUsage/updated` against `modelContextWindow`. Null until the first notification. | Not knowable at runtime, so Codex uses 500k/90% alone. With upstream defaults (codex-rs 0.153.4: `auto_compact_token_limit` is `min(configured limit, 90% of the raw window)`; app-server reports the usable window, 95% of the raw one), Codex compacts at 0.9 raw and the 90% limit fires at 0.855 raw, about 12k tokens earlier on a 272k model. But the model catalog can come from the backend, `config.toml` can set `model_auto_compact_token_limit`, and app-server reports neither value. |
| OpenCode | The latest step's `total` against the catalog's `limit.context`. Null when the catalog has no limit. | The default path of `SessionCompaction.isOverflow` in the JavaScript bundled with 1.18.35: a step at or above `limit.input - min(20000, maxOut)` when the model has an input limit, else `limit.context - maxOut`, where `maxOut = min(limit.output, 32000)`, or 32000 when there is no output limit. A member's own OpenCode config (`compaction.auto`, `compaction.reserved`) or `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` can move it; the config Isomux writes sets none of them, and Isomux does not read the others. |

A null sample commits nothing, so nothing arms.

## 3. Trigger

**Between turns only, right after the crossing turn ends (eager). Never mid-turn.**

- **Arming.** A sample from a `turn_completed` of status `completed` arms the mode when it is at or above the trigger, the switch is on, the conversation has not spent its attempt, and the loop guard (section 6) has not paused it. An interrupted or failed turn does not arm it: a member who presses Stop wants attention, not a reset.
- **One phase.** From arming to the reset, an in-memory phase holds the queue back from the old session. While it is set, every `flushQueue` call starts the brief turn instead of sending a batch, so every existing flush trigger is a start site. The other start site is the arming itself, which waits out the turn in flight and starts the brief turn when the agent is idle, for the case with an empty queue. While the phase is set, a member's message or skill counts the agent as busy and queues, and `flushQueue` does not call itself again (the phase's exits flush). Every exit releases the phase and lets the queue flush. Appendix C has the gates and the release list.
- **Turn in flight.** It always finishes. Mid-turn the number is stale, and a reset would kill running tool calls.
- **Queued messages.** They go to the fresh session after the brief, through `handoff`'s `keepQueue`. A member's message during the phase waits in the queue (the phase counts as busy). A new steer is declined with `steerDeclined: "auto_handoff"`. A member's send-now still aborts the brief turn: the member's explicit action wins, the attempt fails (section 6), and the queue flushes to the old session.

## 4. What the new session gets, and who writes it

**The agent writes the brief in a server-run brief turn. The server captures the reply and runs the existing handoff logic. The agent does not call the route itself.**

- **Brief turn.** One isomux-authored prompt through `runAgentTurn`, with `humanInput: false` and `usageCapped: true`. The prompt keeps the content rules of `/handoff` step 1 and no more (Nil, 2026-10-13). The text is `autoHandoffBriefPrompt` in `server/auto-handoff.ts`.
- **In the old chat** the prompt is not shown. The section 5 system entry stands for it.
- **Capture.** The brief is all `assistant_text` after the brief turn's last own tool call (OpenCode's deltas join with nothing, other engines' blocks with a blank line). Tools are allowed, so the agent can check `git status` first.
- **Delivery.** Today's `handoff` body: transactional, keeps the queue, and marks the brief as `[Handoff from your previous session]`. A manual `POST /api/agents/:id/handoff` during the phase gets 409 `handoff_in_progress`, the agent's own call included.
- **Fresh-session notice.** The first prompt of the fresh session carries a one-shot `auto-handoff` envelope block (`AUTO_HANDOFF_FRESH_NOTICE`): it says the session was handed off automatically, and names `GET /api/agent-reference/conversation-history` for earlier work the brief does not cover, before an action that depends on it.
- **No brief, no handoff.** The server does not write a fallback brief from the transcript.

## 5. What members see

- **Old chat, as the brief turn starts:** `Context is at 500k tokens. Writing a handoff brief for a fresh session.`, `Context is 90% full. ...`, or `Context is NN% full, close to auto-compaction. ...`, by the limit that fired. The brief then appears as normal agent text.
- **Wrap-up notices.** While an automatic attempt is still possible (switch on, attempt not spent, not paused), both audiences skip every band: the member notice and the agent's `[context check: ...]` block. All bands, because the 50 band only applies to windows of 500k or more, where the 500k trigger fires at or before 50%, and the member copy at every band points at `/handoff`. Nothing is marked fired while they are quiet, so after a failed or paused attempt the highest band fires as before. Codex and OpenCode never get these notices.
- **The reset** clears the chat, as a manual `/handoff` does (Nil, 2026-10-13: no chat that spans handoffs).
- **Fresh chat, first entry** (in place of "New conversation started."): `Handed off automatically at 500k tokens.`, `Handed off automatically at 90% context.`, or `Handed off automatically at NN% context, before auto-compaction.` Both lines name the limit that fired, not the measured value, so they give one reason. Then the brief and the agent's first reply.
- **An audit row**: operation `agents.handoff`, actor kind `auto_handoff`, the agent as target.
- Member-facing strings are in `shared/i18n` (en, es, ca, zh).

## 6. Failure cases

| case | behaviour |
|---|---|
| Brief turn errors, is aborted, is refused by the usage cap, or gives no brief; or `handoff` fails | No handoff. A system entry: `Automatic handoff did not complete. This conversation continues.` The attempt is spent, the wrap-up notices come back, and the queue flushes to the old session. A failed write loses nothing: `handoff` takes the brief out again. |
| `/clear`, resume or fork during the brief turn | The phase goes with the conversation; the brief turn's text is discarded. No entry: the member's action explains it. |
| Handoff loop (the fresh session starts at or above the trigger, for example because of a huge brief) | A conversation opened by an automatic handoff carries an in-memory flag. If its first sample is at or above the trigger, the mode pauses for that conversation, with one entry: `Automatic handoff is paused for this conversation: it started above the handoff threshold.` A restart loses the flag, so a conversation can hand off once more per restart. |
| Engine without a usable measure | A null sample commits nothing, so nothing arms. After a restart nothing arms until the first completed turn. |
| Cron run | Not applicable: a cron run is a separate one-turn session with no `ManagedAgent`. A cron message to an agent is ordinary input. |
| Agent on a permission prompt | It is mid-turn, so nothing arms. The brief turn never starts in a multi-step flow; the phase waits for the next flush. |

## Rulings

Nil, 2026-10-13 and 2026-10-14: the 500k/90% trigger with the compaction guard; all three engines; the chat clears; the fresh-session notice and history pointer; no brief rules beyond `/handoff` step 1; the per-conversation summary is a separate task (ac41c60e). Defaults where Nil has not ruled (reversible): the per-agent switch, off for new agents; no room or office default; eager timing.

## For the Lead (route, wire and state-layout proposals)

Proposals, not decisions. The Lead rules on them before any code:

- A persisted per-agent field `autoHandoff?: boolean` (`PersistedAgent`, `AgentInfo`, `EditAgentReq`) and a wire field `AgentCapabilities.autoHandoff`.
- A new `steerDeclined` value `"auto_handoff"` in the message-route response.
- An audit row for an automatic handoff. Recommend none in v1: `AuditEntry` has no place for an "automatic" mark (`shared/audit.ts`), and an `agents.handoff` row with the agent as actor would credit the agent with a server action.

Lead rulings (2026-10-13), for implementation after Nil's go:

- The persisted field `autoHandoff?: boolean`, read as `?? false`, and `AgentCapabilities.autoHandoff`: approved.
- `steerDeclined: "auto_handoff"`: approved.
- Audit: write a row. Secrets B2 set the precedent for a server action with its own actor kind (`secret_proxy`): an automatic handoff gets one too (for example `auto_handoff`), with the agent as the target, so the audit log shows that the server, not the agent or a member, cleared the conversation.

## Doc surfaces

`docs/features.md` and `api/chat.ts` (the `/handoff` line), `server/agent-reference/conversation-lifecycle.md` (the server can run the handoff; 409 meanwhile), `server/agent-reference/agent-management.md` (`autoHandoff` is a PATCH field). `server/system-prompt.ts` does not change: the brief-turn prompt and the fresh-session notice say all the agent needs, and the system prompt avoids per-agent differences.

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

**Start sites.** (1) `flushQueue`: every caller, including enqueue's idle branch (`:6806-6815`), the idle transition, the watchdog (`:5370-5386`), boot replay and the post-turn kick. Like the notice step (`server/agent-turn.ts:453-462`), `flushQueue` first waits up to 500 ms for the in-flight sample, so a sample that lands in time arms the phase before the batch goes out. A later sample means the batch goes to the old session, the phase arms during that turn, and the arming's own start (2) waits for that turn to end. (2) `commitContextSample` (`:3983`), when it arms: it waits out the turn in flight, then starts the brief turn if the agent is idle, live and not in a multi-step flow. Otherwise the next message, which queues while the phase is set, starts it through `flushQueue`.

**Second-start guard.** The start function checks and sets `briefStarted` synchronously, before any await. `beginTurn` then puts the agent in a busy state, which `flushQueue`'s idle check also refuses. `briefStarted` stays true from the start of the brief turn until the phase is released (at the splice on success, or by the owner on failure). It is never cleared at turn end: the brief turn's own idle transition calls `flushQueue` (`:3499-3505`) before the owner captures the text and before `handoff` reaches the splice (it first awaits `prepareEnqueue`, `:9276`). In that window the agent is idle, and `briefStarted` alone stops a second brief turn in the old session. The brief turn does not hold `flushInProgress`, because `newConversation`'s held-queue flush (`:9228-9244`) skips when that flag is set.

**Arming input.** `refreshContextUsage` samples on every turn status and passes only `source` (`:4718-4725`), so its token also carries the turn status, and `commitContextSample` arms only on `completed`.

**Release.** Every exit clears the phase and then calls `flushQueue` if the agent is idle and the queue is not empty, so the queue is never left waiting (the lost-wakeup hazard at `:6880-6889`):

- success: cleared at the splice; `newConversation` then flushes the held queue into the fresh session (`:9228-9244`).
- failure (error, abort, usage cap, no brief, `handoff` refused): cleared by the brief-turn owner.
- `/clear`, resume, fork: cleared in `resetContextUsage` (`:3876`), which every conversation boundary calls.
- Stop (abort): the brief turn ends, which is a failure (above). No code path sets an agent's state to `stopped`, so that state has no release.
- switch off before the brief turn starts: cleared in `editAgent`.
- kill: removed with the agent.

**Provenance flag.** The auto path passes `autoHandoff: true` to `newConversation` in the opts next to `keepQueue`. `newConversation` sets the new conversation's provenance flag right after `resetContextUsage` (`:9189`). It cannot be set before the call, because the reset clears it. It cannot be set after `await newConversation`, because the held-queue flush may already be running.
