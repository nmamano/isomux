# Steer delivery: reach a busy agent without a phantom rejection

> Status: SHIPPED in lane steer-interrupt (2026-09-26), as ruled by the PM: §3.1's acceptance is "our callback
> returned the text" (no transcript read), and §5 is settled. Tasks 0a248523 (P0, steer read as a human rejection) and 7529b23b (P3, deliver
> at the next tool boundary). Builds on `message-steering-design.md` §2.1, which shipped the `steer` flag.

## 1. The failure, reproduced

Isolated office (temp `ISOMUX_HOME`, port 4731), 2026-09-26. A Claude Opus 5.5 agent ("Receiver") runs
`bash slow.sh 30` (30 steps, 5 s each) as step 1 of a 3-step job. A second agent ("Sender") steers it with
`{"text":"FYI from Sender: I am starting on the docs now. No action needed from you.","steer":true}`. Ack:
`{"queued":false,"steered":true}`.

The steer aborts the turn. Claude has no in-place abort, so isomux closes the CLI and resumes the session. The
Receiver's model then reads, in order:

1. the cut Bash call's `tool_result`, `is_error: true`: *"The user doesn't want to proceed with this tool use.
   The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what
   you are doing and wait for the user to tell you how to proceed."*
2. `[Request interrupted by user for tool use]`
3. isomux's flush: *"[Note: this message was queued while you were processing your previous turn - the sender
   had not seen your most recent reply when they sent it.]"* + the sender prefix + the steer text.

Its reply: *"I'm still stopped. `bash slow.sh 30` never ran because you declined that command, so steps 2 and 3
haven't happened either. Tell me when you want me to continue."* The script had run 14 steps. So the agent
stalls, blames the member, and is wrong about the state on disk.

A steer that lands between tools (no tool in flight) also stalls: the model reads `[Request interrupted by
user]` and replied *"Tester, you interrupted me before step 3 … Should I go ahead?"*

Every piece of the wrong story comes from the abort. Item 3 is also wrong: a steer is not queued.

## 2. What each engine can do instead

Probed with the SDK directly (`@anthropic-ai/claude-agent-sdk` 0.3.280, same CLI binary isomux uses), 2026-09-26:

| Lever | Running tool | Result |
|---|---|---|
| Push a user message into the live `query()` input, no priority | finishes | Folded in at the next tool boundary; one result, `user_message_uuids` lists both sends. But when no tool boundary is left, it runs as a **separate follow-on turn** right after the result, and that result's `queued_turn_count` was 0. |
| Same, `priority:"now"` | finishes | Ends the turn at the boundary and starts a new turn: the follow-on case, always. |
| `PostToolBatch` hook returns `additionalContext` | finishes | Model reads it before its next request and acts on it in the same turn (probe: steer asked for an extra line in `summary.txt`; model wrote it and said "the Reviewer agent asked for it partway through"). Main thread only when we skip inputs with `agent_id`. Persisted in the transcript as a `hook_additional_context` attachment, so a resume keeps it. |

The follow-on turn is what sank the July attempt (commit f05ef978, parked, 1300 lines): a turn the CLI starts on
its own has no isomux turn wrapper, so state, logs, turn deferreds and queue flushes all need a second owner.

The hook has no follow-on case: if the turn ends before a batch boundary, the steer is still in isomux's queue and
the ordinary idle flush delivers it as the next turn. isomux keeps sole ownership of turns. Local mutual exclusion
(hook callback and `flushQueue` both run on isomux's event loop) is not end-to-end exactly-once; §3.1 states the
acceptance boundary and the failure policy.

Codex: the app-server protocol has `turn/steer` ("steers an already-active turn") with an `expectedTurnId`
precondition that fails when that turn is no longer active, so accept-or-queue is atomic. Not probed live yet.
OpenCode: the transport uses only `prompt_async` and `abort`; whether `prompt_async` on a busy session folds in
mid-turn is unchecked. Both keep today's abort in this lane.


Probe scripts: `internal-docs/evidence/steer-delivery-0926/` (`probe.ts` for the table above, `probe2.ts` for §3.1).

## 3. Proposal

### 3.1 Claude: agent steers deliver at the next batch boundary (7529b23b)

`PostToolBatch` fires once after every call in a tool batch has resolved, before the next model request. So
"boundary" below means batch boundary: with parallel calls, the steer waits for the slowest one.

**Marking.** A queued item accepted through the steer branch at a busy receiver gets `steer: true`. There is no
agent-level flag: "a steer is pending" means "the queue holds a `steer` item". Cancelling that item, or any path
that clears the queue (new conversation, resume, edit), removes the steer with it, so a later plain enqueue cannot
inherit it. When the receiver's backend declares the capability, the steer branch marks the item and does not call
`sendNow`. Guard rails and ack shape are unchanged (rate-limit counting: §5).

**Eligible batch.** The hook takes the whole queue only when every item is machine traffic that the ordinary flush
would send as prefixed text: sender kind `agent`, `app` or `cronjob`; no `sdkText` (expanded skill); no `handoff`.
If any queued item comes from a member, or is a skill or a handoff, the hook takes nothing and the whole queue waits
for the turn-end flush, where it keeps today's `runAgentTurn` path (backend user message, edit/fork mapping, the
human-response notification). Attachments do not block: the hook text carries the same path notices that
`buildClaudeUserMessage` adds (`formatAttachmentLines(resolveAttachmentNotices(...))`).

**Session binding.** The callback is created per session. It captures the session object and does nothing unless
that object is still `managed.sessionManager.session`, a turn deferred is installed, the state is busy, no abort or
session swap is in progress, and the receiver is not in a multi-step flow. A callback from a closed or replaced
session (abort, swap, clear, resume) cannot touch the new session's queue. Subagent calls (`agent_id` present) are
skipped.

**Claim, deliver, drain.** The callback marks the items claimed (in memory: `boundaryClaim`, object references
bound to the session), logs them as `user_message` entries with sender, scheduled and sdkText metadata plus
`delivery: "tool_boundary"`, and returns the text as `additionalContext`. The hook fires after the batch's tool
results and before the next model request, so the chat order is right. Claimed items leave the visible queue and can
no longer be cancelled, but stay in `messageQueue` and on disk until that session's `turn_completed` drains them. The
log and drain steps are the same helpers `flushQueue` uses (`logDeliveredItems`, `drainQueueItems`, with the
existing `shouldAutoRegenerateTopic` check), and both paths build item text with `queuedItemText`.

**Acceptance and failure policy (PM ruling).** Acceptance is "our callback returned the text". The callback is ours
and in-process, so it cannot fail silently: its body is wrapped, and any exception releases what it claimed and
returns `{}`. It is synchronous and cheap, under a 60 s matcher timeout, so the CLI's timeout path (which ends the
session, see the probe) does not arise. No Claude session file is read. If the session ends, crashes or is swapped
before `turn_completed`, the claim is stale (`liveClaimed` compares it with the installed session) and the next flush
delivers the items again. Delivery is therefore at-least-once: a duplicate is possible whenever a session ends
between a delivery and its turn's end, the same guarantee the queue gives across a crash. An acknowledged message is
never lost.

Probe evidence kept for the record (2026-09-26, SDK 0.3.280, `probe2.ts`): a callback that throws is skipped by the
CLI while the model keeps working; a callback that exceeds its matcher timeout crashes the CLI session; callback hooks
emit no `hook_started`/`hook_response` events.

**Built-in notices** (context fullness, session-start memory, wake notice) stay attached to the next real turn. The
hook does not consume them.

**Edit and fork.** Entries with `delivery: "tool_boundary"` have no backend user message. `editMessage` excludes
them from `logUsers`, so they cannot shift the occurrence count of a human message with the same text, and an edit
of one of them fails with the existing "could not locate" error. (Agent-sent entries from the ordinary flush already
never match a backend message, because the backend text carries the sender prefix; the exclusion makes that
explicit.) The eligible-batch rule keeps every member message on the backend-user-message path.

**Human "Send now" / Ctrl+Enter:** unchanged (abort, then flush). A member who presses it means stop now.

What the receiver sees, as the CLI renders it:

```
<system-reminder>
PostToolBatch hook additional context: [Isomux: delivered between your tool calls; nothing was interrupted.]

"Sender" (agent id: …) from Room "…" FYI from Sender: …
</system-reminder>
```

The tool it was running finished and its real result is in context.

### 3.2 Every abort path: the delivered message names the cause (0a248523)

Paths that still abort: human Send now, and agent steers at Codex or OpenCode receivers.

**Marker.** When `sendNow` issues an abort against a busy receiver, it stamps every item then in the queue with
`interruptCause`: `"agent_steer"` when the steer branch called it, `"member_send_now"` for the button, the route and
Ctrl+Enter. The stamp lives on the items, so it has the items' lifetime: a cancelled item takes its stamp with it,
queue-clearing resets drop it, and it is consumed only when the flush that carries the item is accepted
(`onSendAccepted`). If the abort fails (`AbortResult` not ok; on a busy receiver that means the replacement
failed), `sendNow` restores the previous stamps on the items still queued. The send-now route stamps
`"agent_steer"` for an agent caller and `"member_send_now"` for a member (cookie or personal API token). The flush picks the note by precedence (member over agent)
and uses it in place of the "queued while you were processing" note:

- agent steer: `[Isomux: another agent interrupted your turn to deliver this. Any rejection or interruption text just before it came from that interruption, not from a human. A tool call cut short may have done partial work: check its effects before you continue.]`
- member Send now: `[Isomux: a member interrupted your turn to deliver this. A tool call cut short may have done partial work: check its effects before you continue.]`

The strings are exported from `server/agent-manager.ts` (`AGENT_INTERRUPT_NOTE`, `MEMBER_INTERRUPT_NOTE`,
`TOOL_BOUNDARY_NOTE`). Nil signs off agent-facing copy.

### 3.3 System prompt (server/system-prompt.ts, all engines)

Replace *"To interrupt their current turn instead of waiting, add "steer":true."* with:

> To reach them during their current turn instead of waiting, add "steer":true: Claude agents get it when their running tool calls end; other agents are interrupted. An Isomux note that another agent interrupted your turn means the rejection or interruption text before it came from that interruption, not from a human. A human denial or safety refusal outside that interruption still stands.

The receiver rule is conditioned on the server marker only, and only for the interruption it names.

A real human permission denial followed by an ordinary agent message carries no note. A real denial earlier in the
same turn stays a denial even when a steer follows it.

## 4. What changes for callers

| Surface | Before | After |
|---|---|---|
| Ack `steered:true` | turn aborted | Claude receiver: delivered at its next batch boundary, or as its next turn if the turn ends first or the queue holds a member/skill/handoff item. Codex/OpenCode: turn aborted (unchanged). Shape unchanged. |
| Ack `queued:false` on a steer | "does not wait for the current turn" | Claude receiver: can wait for the rest of the turn (long tool call, no further boundary, ineligible batch) |
| Rate limit (3/min/receiver) | counts steers that interrupted | unchanged meaning: boundary steers interrupt nothing, so they are neither counted nor refused |
| Long tool call at the receiver (for example a 15-minute suite) | steer cuts it | steer waits for it |
| Ordinary agent that must stop a Claude agent now | steer | no path; privileged agents and members keep `/abort` and Send now |
| Chat log | "Agent interrupted." then the message | the message appears after the tool result, no interruption line |
| Curl card label for a steer | "Interrupt {who} with a message" | "Message {who} mid-turn" (en; es, ca, zh follow) |

## 5. Decisions (PM, 2026-09-26)

1. Accepted: for Claude receivers a steer no longer interrupts. No hard-interrupt option; members keep Send now and
   privileged agents keep `/abort`. The PM takes the contract change to Nil.
2. The rate limit counts only steers that abort.
3. Codex `turn/steer`: a follow-up task. Codex and OpenCode keep the abort plus the §3.2 note.

## 6. Verification

- Unit, Claude hook: main thread vs subagent; null vs text; callback from a replaced session returns nothing.
- Unit, agent-manager with a boundary-capable FakeBackend (`server/test-support/steer-boundary.test.ts`):
  - steer at a busy receiver: ack, no abort, same session; the hook delivers, logs with `delivery` and sender
    metadata, hides the item, keeps it on disk; a second boundary delivers nothing; `turn_completed` drains with no
    second send;
  - turn ends before any boundary: normal flush;
  - member item in the queue: hook takes nothing, both flush together;
  - attachment item: hook text carries the path notice;
  - cancel the steer item, then plain enqueue: no boundary delivery; a delivered item cannot be cancelled;
  - a hook from a replaced session claims nothing;
  - a claim whose session ends before `turn_completed` is delivered again;
  - boundary steers are not rate limited;
  - edit of a member message with the same text as a boundary-delivered agent message forks at the right message.
- Unit, abort paths: non-capable backend steer and member Send now each carry their note; the note is consumed with
  its delivery, and a later plain queue gets none. The failed-abort restore is not unit-tested (it needs a failing
  session replacement).
- Live: repeat §1 on the isolated office. Pass = the script runs all 30 steps and the Receiver finishes steps 2
  and 3 without asking the member anything.
  Result, 2026-09-26, same office, agents and texts as §1: ack `{"queued":false,"steered":true}`; no "Agent
  interrupted." line; `slow.sh 30` ran all 30 steps (exit 0); the steer was logged right after that tool result
  with `delivery: "tool_boundary"`; the Receiver ran steps 2 and 3, wrote "progress.txt has 30 step lines.", and
  closed with "While the script was running, the agent Sender sent a note … I didn't act on it." It asked nobody
  anything.
