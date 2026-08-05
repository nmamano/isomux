# Agent messaging: steering, queue control, lazy delivery, condition triggers

> Status: DESIGN ONLY. No code in this slice. Covers tasks 80b2bb08, 0da22912, e17989e0, bca33c68.
> Every API shape and policy below is a proposal; the numbered list at the end is what needs a ruling.

## 1. What exists today

**Delivery.** `enqueueMessage` (`server/agent-manager.ts:4676`) is the single entry point for both human and
agent senders. It pushes onto `managed.messageQueue`, persists transactionally, and if the receiver is idle
(`idle` / `waiting_for_response`, no multi-step flow) immediately calls `flushQueue`. Busy receivers get the
message on the next idle transition. `flushQueue` (`:4767`) coalesces every queued item into one prompt, each
line carrying a sender prefix from `queuedItemPrefix` (`:4467`). Queue cap 50, dedupe window 5 min.

**Durability.** Queues are mirrored to `~/.isomux/message-queues.json` and replayed at boot (task 9870b472).
A watchdog sweep (`sweepStuckFlushes`, `:3873`) treats "items queued while the agent is idle for over 60s with no
flush in progress" as a bug and re-fires the flush; a flush stuck over 60s gets a forced session replacement
(rate-limited to one per 5 min).

**Turn assembly.** `runAgentTurn` (`server/plugin-hooks.ts:2-20`) is the single send-and-await entry point for
every path that produces a model turn: `sendMessage`, `flushQueue`, `executeSkill`, `editMessage`. It assembles
an outbound envelope (`:201-241`): server built-in blocks first (context-fullness notice, session-start memory
notice), then plugin blocks, then the payload. Built-ins are consumed (marked fired) only **after** the send is
accepted, guarded on `contextGen` so a mid-send conversation reset does not burn one. This matters below.

**Steering.** `sendNow` (`:5085`) aborts the in-flight turn and flushes the queue. Two front doors:
`POST /api/agents/:id/send-now`, and `sendNow: true` on the send body (composer Ctrl/Cmd+Enter, user scope only,
explicitly rejected for agent scope in `server/routes/handlers/conversation.ts:212`).

**Agent-initiated steering already works, for privileged agents, and they are already told how.** `send-now` and
`cancelQueued` are guarded by `cap("agent:converse", agentParam("id"))` (`server/routes/table.ts:391-403`);
`agent:converse` is in `PRIVILEGED_AGENT_CAPABILITIES` (`server/identity/index.ts:153`); `agentParam` resolves to
room access keyed on the spawning user. The privileged-operator section of the system prompt documents both curl
invocations verbatim (`server/system-prompt.ts:170-171`). So the gap in task 0da22912 is narrower than it reads:

- **not** the capability, and **not** the documentation, for privileged agents;
- **is** a single atomic call - today it is enqueue, then a second request to `send-now`, with a window in between
  where the receiver goes idle and flushes your message before the `send-now` lands, so what was meant as a steer
  reports as an ordinary queue-and-flush. Nothing is lost either way. What the atomic flag buys is a defined batch
  boundary and an honest ack (did I interrupt a turn, or did it simply arrive), not exclusive delivery: messages
  already queued before your request still ride the same flush, as they should;
- **is** any steering path at all for an ordinary agent.

**Queue reads.** There is no HTTP read of a queue. Users see it over WebSocket (`agent_updated.changes.queue`,
plus `getAllAgents` splicing the live queue into `full_state`). The `GET /agents` discovery manifest agents use
carries no queue and no state. So no agent can see its own pending messages, let alone anyone else's - and a
privileged agent can cancel a queued message by id but has no supported way to learn the id.

**Scheduled messages.** `POST /messages` + `deliverAt` stores a durable entry
(`~/.isomux/scheduled-messages.json`); a 30s tick fires it through `enqueueMessage` with a `scheduledFor` marker.
`GET`/`DELETE /api/agents/:id/scheduled-messages` manage the **sender's outbox** (`scheduledMessagesOwner`,
`server/identity/guards.ts:357`): an agent sees only its own, a user sees any agent in a room they can reach.
Self-send is allowed on this path and rejected (400 `self_send`) on the immediate one.
**The UI has zero surface for scheduled messages.** Nothing renders them, nothing pushes them over WS.

## 2. Proposals

### 2.1 Agent-initiated steering

Shape: `POST /api/agents/:id/messages` gains `"steer": true` - enqueue and `sendNow` in one request, closing the
two-call window described above. The agent-scope rejection of the `sendNow` body flag is replaced by this field.
The ack reports whether an abort actually happened (receiver busy) or the message simply delivered (receiver idle),
so the sender can tell the two apart.

Who may steer whom:

| | Rule | Cost |
|---|---|---|
| A | Privileged agents only (today's de-facto rule) | Zero policy change; only the atomic call is new. Ordinary workers still cannot page each other. |
| B | Any agent may steer any agent its boss can reach | Confused deputy. `hasRoomAccess` keys on the spawning user, so "room-mate" really means "everything my boss owns" - the exact escalation the `conversationReset` guard comment warns against (`guards.ts:375`). |
| C | Per-receiver opt-in, three grains: a global `steerable` boolean; a sender allowlist on the receiver; or a receiver-scoped capability granted to named agents | The boolean is cheapest but lets every agent under the boss steer once enabled. An allowlist expresses "my reviewer and my manager may interrupt me, nobody else". Cost scales with grain: persisted field, spawn/edit UI, guard branch. |
| D | Same-room only | Reads as the natural middle, but still needs a deliberate guard (room membership, not `hasRoomAccess`), and it breaks the pattern this office actually uses, where the manager steers workers **across** rooms. |

Recommendation: **A now, C-with-allowlist as the growth path.** B is cheap and wrong; D sounds right and does not
match how the office is used.

Interruption tradeoffs, whatever the rule: an abort stops further work and further token spend, but does not roll
back tool side effects already committed, so the receiver can be left mid-edit. Two agents steering each other can
ping-pong. Candidate mitigations (decisions, not settled here): refuse to steer an agent in a multi-step flow
(`flushQueue` already declines to run there, so a steer would abort a turn and then fail to deliver); a rate limit
per receiver with excess degrading to a plain queue; the existing "Previous response was interrupted" system line
keeps the interruption legible in the receiver's transcript either way.

### 2.2 Queue visibility and manipulation by agents

New read: `GET /api/agents/:id/queue` returning `{queue: QueuedMessage[]}`. It needs its **own** guard rather than
borrowing one: the log-read guard carries killed-agent clauses that mean nothing for a live queue. The model to
copy is the log route's - own agent, plus any agent in the boss's rooms - but whether privileged status is required
for the cross-agent case is a decision, not an inheritance.

Mutations, in increasing order of blast radius:

- **Cancel** (`DELETE /api/agents/:id/queue/:messageId`) exists and is privileged-only today. Two separable
  questions: may an ordinary agent cancel from its **own** queue, and may a non-privileged agent cancel from
  **someone else's**. Both are decisions.
- **Fetch-now** for self: an agent asking "flush my own queue into this turn" is incoherent - the queue flushes
  when the turn ends, and cannot be spliced into a turn already running. What the request actually wants is the
  READ above, so the agent can decide whether to wrap up. No new mutation needed.
- **Reorder**: skip. The queue coalesces into a single prompt in queue order, so ordering only affects
  intelligibility, and no caller has a principled ordering to impose. Adding it invites senders to fight over position.

Worth stating in the system prompt regardless of what ships: an agent reading its own queue mid-turn is looking at
items that are about to be delivered to it anyway.

### 2.3 Lazy queueing

The use case: an agent's web app records browser actions so the agent learns about them the next time it runs,
without each click costing a wake-up and a turn.

Three designs. A and B are the two Nil sketched; B' is the synthesis I would ship.

**A. Flag on the existing queue.** `"lazy": true` on the send; lazy items never trigger a flush, and ride along
when a non-lazy item flushes. Conceptually the smallest change, and the one that collides hardest with the
delivery core:

- `canDemote` requires `messageQueue.length === 0` (`agent-manager.ts:3799`). A lazy item pins the agent's session
  in memory forever, the opposite of the intent.
- The wake lives *inside* `flushQueue`: a session-less agent gets one created at `:4827`, before the item loop is
  reached. The lazy gate therefore cannot live at the item loop; it has to be at the top of `flushQueue` **and** in
  every trigger, or a lazy item wakes a dormant agent by the very path it was meant to avoid.
- Once `flushQueue` is taught to return early on lazy-only contents (without that, lazy items are simply delivered
  and the feature does nothing), the watchdog's signature matches exactly: nonempty queue, idle, no flush in
  progress, age over 60s. It warns and re-triggers a flush every 30s sweep, forever. It would not escalate to a
  session replacement - that branch requires `flushInProgress` - but the log noise is permanent.
- Every other reflush predicate keys on raw length too: the state-transition trigger (`:1975`), the post-swap kick
  (`:3754`), the drain-path retry, and boot replay (`:1629`).
- `sendNow` keys on raw length (`:5091`), so a lazy-only queue reads as steerable: a "Send now" click would abort a
  live turn to deliver notes explicitly marked as not worth interrupting for.
- Four context-switch paths **silently destroy** the whole queue: resume-pick (`:5465`), `/clear` (`:6241`),
  `/resume` (`:6522`), edit-fork (`:6708`). Under A a `/clear` throws away every lazy note, which is exactly the
  moment a fresh session most needs the backlog.
- `QUEUE_MAX` is shared, so a chatty web app starves real messages out of a 50-slot queue. Persistence validation,
  the `QueuedMessage` type, the dedupe window, cancel, and the UI queue chips all need a lazy answer too.

Each is fixable, but that is nine-plus edits across the delivery core, each one a place where a future reader must
remember lazy exists.

**B. Separate channel, hint only.** Lazy items go to a `~/.isomux/lazy-queues.json` store the delivery path never
reads. On the agent's next real turn a one-line notice rides the built-in envelope:
`[3 lazy notes waiting: GET /api/agents/<id>/lazy]`. The agent decides whether to pull. Delivery core untouched.
Cost: the agent must spend a tool call and may reasonably decide not to, so "the agent becomes aware of everything
that happened automatically" is no longer guaranteed.

**B'. Separate channel, server-delivered.** Same separate store, same untouched delivery core, but the content
rides the envelope directly, as a third **built-in block** in `runAgentTurn` alongside the context and memory
notices (`plugin-hooks.ts:201-241`). That is one integration point, not several: `runAgentTurn` is the single
send-and-await path for `sendMessage`, `flushQueue`, `executeSkill`, and `editMessage`, and handoff, scheduled,
and cron deliveries all reach a turn through it. Local slash commands produce no model turn and correctly see nothing.

The delivery protocol matters more than the storage. Snapshot the notes when the block is built, send them, and
**clear them only after `session.send` is accepted**, generation-guarded exactly like `markContextThresholdFired`.
Clearing at read or assembly time loses notes to a plugin timeout, a Stop, a session swap, or a failed send - the
same hazards the context notice's send-accept guard was written for.

Recommendation: **B'**, with a size budget: splice up to a byte cap and fall back to B's hint for the remainder, so
one busy browser session cannot dominate a turn's prompt.

Three things any of the three needs:

- **Self-targeting must be allowed**, with the credential boundary stated precisely. The flagship sender is a web
  app the agent serves, posting notes back to that same agent, and the immediate path rejects a self-send with 400
  `self_send` (the scheduled path already carves out the same exception for the same reason). But **the browser must
  never hold `ISOMUX_AGENT_TOKEN`.** An ordinary agent token carries every self-affordance, and a privileged one
  carries operator powers over other agents; shipping either into page JavaScript hands them to anyone who opens
  devtools or to any XSS on the page. The topology is: browser calls the agent's own app server, and that trusted
  server-side process holds the token and loopback-POSTs the note to isomux. Any design that puts the bearer in the
  browser is rejected here, not offered as an option. If server-side proxying turns out not to be available for
  some app, the answer is a narrower app-ingress credential scoped to the lazy endpoint alone - a separate design
  question, not a reason to loosen this one.
- **A scoping answer across conversation boundaries.** Are notes bound to the agent's identity, or to the
  conversation that was live when they arrived? A `/clear`, a resume into a different session, an edit-fork, a
  handoff, or an engine switch all start a new conversation, and the queue is wiped at each. Identity-scoped notes
  survive all of it, which is what the `/clear` critique of design A argues for, but they can also carry stale
  context into an unrelated resumed session. Note what the generation guard does and does not mean here: it exists
  so a reset during an accepted send does not silently drop notes, which under identity scoping means deliberate
  at-least-once redelivery into the new generation.
- **A cap and an eviction rule.** Lazy notes are unbounded by construction; nothing forces a turn to ever happen.
- **A plugin-visibility answer.** Built-in blocks are not part of `originalText`, so memory and audit plugins do
  not see them. Probably right (lazy notes are machine chatter, not user intent), but it is a choice.

### 2.4 Condition-triggered messages

Stated use case: kick off a long-running task, resume the session when it finishes.

The general primitive is not a condition evaluator; it is **the producer posting the completion itself**. Anything
that can finish can also send a message, and it knows it finished before any observer does. Isomux already has the
inbound surface (`POST /messages`), so the missing pieces are durability of the producer and a fallback for the
case where it dies without posting.

The documented pattern, with the parts that are easy to get wrong:

1. Schedule a deadline fallback (`deliverAt`: "if I have not heard by 03:00, wake me anyway") and **keep the
   returned `scheduledId`**.
2. Launch the job so it outlives both the Bash call and the session release, e.g. `systemd-run --user`.
3. On success the job POSTs the completion **and** DELETEs the fallback by its `scheduledId`. Without step 3 the
   agent gets a second, stale wake-up hours later.
4. Token provisioning is the sharp edge: a transient unit does not inherit the agent shell's `ISOMUX_AGENT_TOKEN`,
   and putting a bearer token in unit command metadata makes it readable from `systemctl` output and the journal.
   The job needs a file-based token read at run time, or a small wrapper script. This needs a concrete answer
   before the pattern goes into the system prompt.

If Nil wants it in the server anyway, the narrow version is `deliverAt` plus an optional condition from a closed
set, with a **mandatory** deadline so no entry can poll forever - and the architecture splits in two: `agent_idle`
and `task_done` are events isomux already owns and should be hooked, not polled; `file_exists` and an HTTP probe
genuinely need the 30s tick. Arbitrary shell predicates should not be a v1: the server would run them as the server
user, a no-op today (all agents share that user) but an escalation the moment
`internal-docs/per-user-isolation-design.md` lands its bwrap slice.

Recommendation: **ship the pattern (with steps 3 and 4 solved), defer the feature.**

### 2.5 Scheduled-message visibility

The data is already there; only the surface is missing. Proposal: a second chip section under the existing
`QueueChips` block (`ui/log-view/LogView.tsx:357`), visually muted, each row showing the text preview and a
relative delivery time ("in 3h 12m"), with a cancel affordance. Pushed with a `scheduled` field on `agent_updated`
alongside `queue`, and included in `full_state`, so no polling.

**The existing API is outbox-only, and Nil's question is an inbox question.** "Will this agent come back?" is about
messages arriving at the agent, not ones it sent. For a self-wake-up (the common case) those coincide; for a
cross-agent scheduled message the outbox view puts the chip in the sender's chat while the interesting fact belongs
in the receiver's. Showing sender-or-receiver entries needs a receiver-indexed read the current guard does not
authorize. Display scope is separable from cancel authority: seeing that a message is inbound does not imply the
right to cancel another agent's outbox entry.

## 3. Phasing

**Slice 1 (read-only, no delivery-core changes).** `GET /api/agents/:id/queue` with its own guard. Scheduled-message
chips + the `scheduled` WS field. Nothing in `agent-manager`'s delivery path is touched.

**Slice 2 (steering as a first-class flag).** `steer: true` on the send, whichever permission rule wins decision 1,
plus the guard rails from decision 2.

**Slice 3 (lazy).** Separate store, built-in envelope block in `runAgentTurn`, consume-on-send-accept, self-send
carve-out, cap + eviction.

**Slice 4 (conditions), only if decision 10 says build.** Otherwise the pattern goes in the system prompt, once
decision 11 answers the token question.

Doc surfaces per `internal-docs/documentation.md`, once anything ships: `server/system-prompt.ts` (every slice -
note the privileged-operator section already lists `send-now` and the queue cancel, so those entries get amended
rather than added), `ui/log-view/isomux-curl.ts` (curl-card labels, which already know the scheduled-message
routes), README and landing only if steering becomes a headline capability.

## 4. Board tasks

**0da22912 duplicates the steering half of 80b2bb08** (Nil suspected this; confirmed - both ask for agent-initiated
steering with a flag on the messaging endpoint, and 0da22912 adds only the "privileged agents as a starting point"
suggestion, which section 2.1 folds in as option A). Recommendation: close 0da22912 as a duplicate, keep 80b2bb08
as the steering + lazy-queue + scheduled-visibility umbrella, and keep e17989e0 (queue read/manipulate) and
bca33c68 (conditions) as separate tasks since they ship in different slices.

## 5. Decisions for Nil

**Steering**

1. Permission rule: A (privileged only), B (any agent in the boss's rooms), C (per-receiver opt-in: global boolean /
   sender allowlist / receiver-scoped capability), or D (same-room)? Recommendation: A now, C-with-allowlist later.
2. Guard rails, if steering ships: (a) refuse to steer an agent in a multi-step flow, yes or no? (b) rate limit per
   receiver, and if so what happens to the excess - degrade to a plain queue, or reject?

**Queue access**

3. Cross-agent queue **reads**: any agent in the boss's rooms, or privileged only?
4. Own-queue **cancel** for an ordinary agent: allow or not?
5. Cross-agent **cancel**: stays privileged-only, or opens to whoever can read the queue?
6. Confirm reorder is dropped.

**Lazy queueing**

7. Design: A (flag in the shared queue), B (pull channel + hint), or B' (separate store, delivered in the turn
   envelope)? Recommendation: B'.
8. **If B or B'** - these apply to either: (a) allow an agent's own token to lazy-post to itself, required for the
   web-app use case? Recommendation: yes, with the token held by the app's server-side process and never by the
   browser (§2.3). (b) scoping: are notes bound to the agent's identity, surviving `/clear`, resume, edit-fork,
   handoff and engine switch, or to the conversation that was live when they arrived? Recommendation:
   identity-scoped, since browser events describe the app rather than the conversation, and a fresh session is
   exactly when the backlog is most useful. (c) cap and eviction - keep newest N and drop oldest with a
   dropped-count line in the delivered header, or refuse new notes when full?
9. **If B' only** - under B the envelope carries a hint rather than the notes, so none of these arise, and accepting
   the hint must not consume anything (the notes are consumed by the agent's own pull): (a) byte budget per turn,
   and does the remainder become a hint or wait for the next turn? (b) should lazy notes appear in `originalText`,
   visible to memory and audit plugins, or only in the built-in envelope? Recommendation: envelope only.
   (c) confirm consume-on-send-accept: notes survive a failed or superseded send and are re-delivered next turn,
   which under identity scoping means at-least-once redelivery into a new conversation if the reset lands mid-send.

**Condition triggers**

10. Build the narrow closed-set condition (events for `agent_idle` / `task_done`, polling for `file_exists` / HTTP,
   mandatory deadline), or ship the producer-posts-completion pattern as documentation only?
   Recommendation: documentation only.
11. If documentation only: how does a detached job get a token - a file-based token read at run time, or something
    else? This blocks writing the pattern down.

**Scheduled-message visibility**

12. Display scope: self-scheduled entries only (no guard change), or every entry where the agent is sender or
    receiver (needs a receiver-indexed read)? Recommendation: sender-or-receiver, it is the question actually being
    asked.
13. Cancel authority in that view: only the sender's own entries, or anything displayed?

**Board**

14. Close 0da22912 as a duplicate of 80b2bb08?
