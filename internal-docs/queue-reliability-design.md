# Message-queue reliability bundle - design (tasks da065287, 9870b472, 314ee9fb)

Worktree: `~/nil/isomux-worktrees/queue-reliability`. Designed together per the
board note; written by Isomuxer6, reviewed by Reviewer6 (v1 review: request
changes on 3 points; this is v2 with his findings folded in - deltas marked
[v2]).

## Background: the delivery machinery today

- `enqueueMessage` pushes onto in-memory `managed.messageQueue`; idle receiver →
  immediate `flushQueue`, busy → rides the next idle transition (`updateState`'s
  flush trigger).
- `flushQueue` is gated by `managed.flushInProgress` (set at entry, cleared in
  its `finally`). Between those points it can await: (a) an in-flight turn's
  `pendingTurn` handoff, (b) `managed.abortPromise`, (c) `runAgentTurn`
  (plugins → `session.send` → `await turn`).
- `pendingTurn` is `{resolve, reject}` (no promise stored). Two places wait on
  an in-flight turn by REPLACING it with a wrapper object that delegates to the
  original and additionally wakes the waiter: flushQueue's handoff wait
  (agent-manager.ts ~3384) and `tryHotAbort` (~4461).

## Task da065287 - flushInProgress strands true; queued message sits forever

### Root cause (the lost-wakeup class)

The wrap-and-wake pattern has an orphaning hole. `runAgentTurn` (plugin-hooks.ts
~258) cleans up its deferred on a `session.send` throw ONLY when
`managed.pendingTurn === ownPending`. Once a waiter has wrapped the deferred,
that identity check is false, so runAgentTurn skips the reject - and if no
turn_completed / error event / session swap follows (send failed, so the backend
owes nothing), the wrapper is never settled. The parked flushQueue never wakes,
`flushInProgress` stays true forever, and every delivery path for that agent
(enqueue trigger, state-transition trigger, Send-now → flushQueue) is gated off
 - exactly the production evidence (Isomuxer1 2026-06-21: idle agent, queued
message, Send-now dead for that one agent only).

More generally: any code holding a direct reference to the original deferred can
settle it without going through `managed.pendingTurn`, and any code replacing
`managed.pendingTurn` can orphan a waiter. The pattern is unsound; patching one
interleaving leaves the class open.

### Fix, three layers

**Layer 1 - kill the wrap-and-wake pattern (the class, not the instance).**
`ManagedAgent.pendingTurn` becomes `{ promise: Promise<void>; resolve; reject }`
(createTurnDeferred stores the promise it already builds). Waiters ATTACH
instead of replacing:

```ts
const pending = managed.pendingTurn; // [v2] snapshot once, never re-read
if (pending) await pending.promise.catch(() => {});
```

at both wait sites (flushQueue handoff; tryHotAbort, still raced with its 7s
timeout). Promise semantics wake every attached waiter on any settle, from any
settle site; nothing is ever replaced, so runAgentTurn's ownership check now
holds whenever it should. Audit of all settle/null sites after this change
(turn_completed resolve; error-event reject; runConsumer catch reject;
closeAndDrainSession reject; createTurnDeferred stale-supersede reject;
runAgentTurn own-cleanup reject): every site that nulls also settles, so an
attached waiter can only hang if the deferred NEVER settles - which requires a
backend contract violation, covered by layers 2–3.

Backstop in the same layer: runConsumer's CLEAN stream-end path (loop exits, no
throw, no swap, not aborting) currently returns without settling a still-owned
pendingTurn - a backend whose stream ends silently mid-turn strands `await
turn`. [v2, per review] Handle the still-bound clean end in BOTH cases, not
just mid-turn: if `managed.session === boundSession && !managed.aborting` →
(a) settle any owned pendingTurn (null + reject "stream ended unexpectedly
mid-turn"), and (b) null `session`/`consumerPromise` and flip dormant=true
(mirroring closeAndDrainSession's flip) so the manager never retains a dead
session pointer - the next message wakes cleanly through flushQueue's
`!session` resume branch instead of sending into a corpse. No-op when adapters
behave (Codex already synthesizes a failed turn_completed on subprocess exit).
The mid-turn case gets a dedicated test. [v2.1, per final review] After the
cleanup, a mid-turn stream end leaves state thinking/tool_executing, which
enqueueMessage treats as busy and flushQueue rejects - so the "next message
wakes it" claim only holds if we also normalize state: after logging the
unexpected end, flip busy state → waiting_for_response (matching the dead-turn
normalization), letting the existing queue trigger work. ALL cleanup/state
mutation in this path is guarded by `agents.get(agentId) === managed &&
managed.session === boundSession` so a replacement consumer or a killed agent
is untouched.

**Layer 2 - bound closeAndDrainSession's drain await.**
The other permanent-hang path under flushQueue is `await managed.abortPromise`
where abort() itself is parked in replaceSession → closeAndDrainSession →
`await oldConsumer`, i.e. a session whose `stream()` never returns after
`close()`. Race that await against `CONSUMER_DRAIN_TIMEOUT_MS` (15s, named
constant; timer cleared on the normal path); on timeout, a loud console.error
diagnostic and proceed. Safety: the runConsumer `managed.session !==
boundSession` guard already discards late events from the zombie stream. [v2]
The on-disk .jsonl overlap risk (dying-old vs starting-new subprocess writing
the same session file - the drain-before-install rationale in the
replaceSession header) REMAINS REAL on the timeout path and stays explicitly
documented at the timeout site; it trades a rare corrupted resume against a
permanent office-visible wedge. BackendSession exposes no harder termination
primitive than `close()` (checked: stream/send/approve/abort/canAbortInPlace/
getContextUsage/close), so there is nothing stronger to escalate to before
proceeding; if adapters grow a hard-kill later, the timeout path should call it
first. Recovery then flows through the completely normal path: abort's finally
runs, abortPromise resolves, the parked flush wakes, the new session installs,
the queue delivers.

**Layer 3 - self-heal watchdog (unknown-bug backstop; the task's "a queued
message cannot sit indefinitely while the agent is idle" guarantee).**
New manager method `sweepStuckFlushes(stuckMs = 60_000)` exported like
`sweepIdleAgents`, driven by a 30s `setInterval` in index.ts's
`import.meta.main` block (tests call the method directly with `stuckMs` of
their choosing; no timer leaks into the harness - same pattern as the idle
sweep). Per agent, act only when ALL hold:

- `messageQueue.length > 0`
- `isQueueIdleState(info.state)` && `!inMultiStepFlow(managed)`

This signature excludes every legitimate wait: a running turn holds state
thinking/tool_executing (we deliberately do NOT watchdog busy states - a long
turn is indistinguishable from a hung one); permission/pick flows are
inMultiStepFlow; normal handoffs/aborts resolve well under the deadline.

Then:
- `!flushInProgress` and the OLDEST item's `queuedAt` older than `stuckMs` → a
  trigger was missed; just `flushQueue()` (idempotent, benign). Generic
  self-heal for missed-trigger bugs, known and unknown.
- `flushInProgress` and `managed.flushStartedAt` older than `stuckMs` ([v2]
  age computed from flushStartedAt for an active flush - an old queued item
  can coexist with a fresh, healthy flush) → forced recovery.

[v2, per review - the v1 epoch-fence force-clear had a correctness hole: an
epoch check at flushQueue's await boundaries cannot fence a zombie already
parked inside runAgentTurn/session.send; force-clearing the flag and starting
a second flush could put BOTH prompts on the backend. Dropped entirely.]

Forced recovery instead reuses the existing cancellation machinery so the
zombie is SETTLED, never raced: console.error + one chat system entry
("Message delivery stalled; recovering."), then a bounded session replacement
exactly like abort's slow path (`pickAutoResumeSessionId` → `replaceSession`
with resume-or-fresh + the stale-auto-resume cleanup). That path:
- bumps `turnCancelToken` (a zombie parked pre-send throws SessionSwappedError
  at its next checkpoint),
- rejects `pendingTurn` (a zombie parked on the handoff attach or `await turn`
  wakes),
- closes the old session (a zombie parked in `session.send` gets settled by
  the adapter's request teardown),
- is itself bounded by Layer 2's drain timeout.
The zombie's own catch/finally then clears `flushInProgress` and re-fires the
flush - recovery flows through the NORMAL flushQueue lifecycle; the flag is
never cleared out from under a live flush, so at most one flush can ever be
sending. `flushInProgress` is intentionally NOT touched by the watchdog.

Residue: an adapter whose `send()` neither settles nor reacts to `close()`
keeps the flag held; the sweep re-attempts after a per-agent cooldown
(`lastForcedRecoveryAt`, 5 min) with escalating logs rather than replacing
sessions every 30s. No duplicate-send-safety claim is made beyond "one live
flush at a time + old session closed before any retry sends".

New ManagedAgent fields: `flushStartedAt: number`, `lastForcedRecoveryAt:
number`.

## Task 9870b472 - durable queues across restarts

**Store.** `~/.isomux/message-queues.json`:

```jsonc
{ "<agentId>": {
    "queue": [ /* QueuedMessage[], verbatim (attachments are hash-file refs - cheap) */ ],
    "dedupe": { "<clientMessageId>": 1784000000000 /* expiresAtMs */ }
} }
```

Written with `atomicWriteFileSync`. Corrupt file at boot → quarantine to
`.corrupt-<ts>` and start empty (exact scheduled-messages pattern,
persistence.ts ~1265).

**Write path. [v2, restructured per review]** UI emission stays pure:
`emitQueueUpdate` does NO disk I/O. Instead:

- **Acceptance is transactional.** enqueueMessage: push the item AND record the
  dedupe entry in memory, then ONE combined `atomicWriteFileSync` of the
  agent's `{queue, dedupe}` record. If the write throws: roll back both
  in-memory mutations and return `{ok:false, status:500, error:
  "persist_failed"}` - a successful ack after a failed persist would be
  silent-loss-on-restart and would hide the retry signal from the sender.
  Only after the persist succeeds: emitQueueUpdate + recordDedupe's TTL
  bookkeeping + the idle flush kick. The single combined write also removes
  the two-write crash window (queue persisted, dedupe not → restart replays
  without the retry key). This 500 surfaces on both the agent POST and the
  human busy-queue path; scheduled-messages' tick treats it as retryable
  (non-404 → stays pending), which is correct.
- **Post-accept mutations are best-effort.** Drain (onSendAccepted),
  cancelQueued, the four clear paths, surfaceBackendNotConfigured's drain:
  `persistQueueState(agentId, managed)` alongside their existing
  emitQueueUpdate; on write failure console.error and continue - the backend
  already accepted (or the user explicitly cleared), and stale disk merely
  widens at-least-once replay. `kill()` deletes the agent's key (best-effort).
- A comment on `ManagedAgent.messageQueue` pins the rule: every mutation site
  must call the matching persist helper.

**Boot replay.** `restoreOrReviveAgent` seeds `managed.messageQueue` and
`queueDedupe` from the store (expired dedupe entries dropped; array order = 
delivery order preserved). Keys for agents no longer on disk are pruned in one
pass at load. At the end of `restoreAgents`, fire-and-forget `flushQueue` for
every agent with a replayed non-empty queue - plugin hooks are configured
before restoreAgents runs (index.ts ~4268 vs ~4299), and the flush wakes the
dormant agent through the existing `!session` resume branch, so delivery
resumes exactly where the restart cut it off. The watchdog (task 1, layer 3)
is the belt-and-braces if a kick is ever missed.

**Semantics: at-least-once.** The drain persists inside onSendAccepted, i.e.
after the backend accepted the prompt; a crash in the window between
send-accept and the removal write replays an already-delivered message on next
boot. This mirrors Nil's resolved decision for scheduled messages
(enqueue-then-persist-removal; a rare duplicate beats silent loss) - echoed in
the report as a policy note, not decided fresh here. The `clientMessageId`
dedupe map surviving restarts closes the sender-retry-across-restart duplicate
window the board called out.

## Task 314ee9fb - out-of-band swap strands a pre-send-cancelled flush

When an out-of-band `replaceSession` (setPrivileged; /model and /effort picks
on a busy agent) cancels a flush parked pre-send, the flush turn's `beginTurn`
already claimed state=thinking, nobody resets it, and no idle transition ever
fires - the queued item sits, and worse, the agent LOOKS busy forever (all
ingress queues behind a dead turn).

**Fix [v2, ownership-gated per review].** The v1 "no NEW turn can have begun"
invariant is false in one window: during closeAndDrainSession's drain await
`session` is null, so if the agent is (or becomes) idle-state, an inbound
message can wake a session via flushQueue's `!session` branch - or
`wakeSessionForSend` on the human path - and be mid-pre-send (state=thinking,
pendingTurn=null) when replaceSession resumes; v1 would clobber that live wake
session AND mis-normalize its state. Fix, four parts:

1. **Serialize the flush-wake against a swap:** flushQueue's session-recovery
   (`!session`) branch bails when `info.sessionSwapping` is true - the
   post-swap kick (part 4) re-fires it against the properly installed session.
   This makes the common wake path defer to the swap instead of racing it.
2. **Conditional install:** when replaceSession resumes from the drain and
   `managed.session !== null`, another installer won the window (e.g.
   wakeSessionForSend). Do NOT clobber it: close the caller's never-installed
   newSession and skip install. Strictly better than today's clobber (which
   leaves the wake turn sending into a foreign session). Residual race noted:
   for /resume-pick / fork-style callers a concurrent wake now wins and the
   pick no-ops - a rarer and safer failure than cross-thread delivery; full
   swap/wake serialization remains task 154e2c14, out of scope here.
3. **Ownership-gated normalization:** ONLY in the we-installed branch (which
   is atomic with the `session === null` check - no await between), apply: if
   `info.state` is thinking/tool_executing AND `pendingTurn === null` →
   `updateState(agentId, "waiting_for_response")`. Within the owned branch the
   old justification holds: the pre-swap turn is provably dead
   (closeAndDrainSession rejected or token-cancelled it) and no new turn can
   exist (any wake would have installed a session, contradicting ownership).
4. **Explicit post-swap flush kick** at the end of replaceSession (after the
   sessionSwapping=false emit): `flushQueue(agentId).catch(...)` - flushQueue
   itself re-checks state/queue/flow/flushInProgress. This is needed
   independently of normalization: when the agent was idle-state throughout
   (so normalization no-ops and updateState's same-state trigger never fires),
   a flush bailed by part 1 would otherwise never retry.

No-op paths: abort's slow path (state already waiting_for_response;
kick no-ops on empty/being-flushed queues), /clear / resume / editMessage
(queue cleared pre-swap; at most the state gets fixed).

Contract change: the pinned test "an unexpected session swap in the same window
still surfaces the 'will retry' message" (queue.test.ts ~925) currently asserts
the item STAYS queued with no retry; it will now additionally assert the queue
drains post-swap and the item reaches the post-swap session.

## Test plan

FakeSession additions (test-support only): a knob to make `send()` park until
the test settles it (resolve or reject on command), and `hangOnClose` (close()
marks closed but the stream ends only when the test calls endStream() - models
a wedged subprocess, releasable for the swap-race test).

1. **Lost-wakeup / handoff semantics (da065287 L1):** kickoff turn parked in
   the send window on an `abortInPlace` FakeSession that acks abort() but emits
   no turn_completed; queue a second message; POST /send-now; then reject the
   parked send. Pre-fix the settle bypasses the installed wrapper(s) and
   delivery only limps in via the 7s hot-abort timeout (with an error-state
   detour); post-fix the rejection settles the shared promise, all attached
   waiters wake, and the queued item delivers promptly with
   `flushInProgress === false` after. Assert prompt delivery + final state.
2. **Wedged-drain recovery (L2):** `hangOnClose` session; abort path parks in
   the drain; with a test-set drain timeout, delivery resumes through the
   normal path into the replacement session, exactly once. [v2.1 - epoch
   wording removed; epochs no longer exist.]
3. **Watchdog (L3):** gentle path - a real missed-trigger scenario (message
   queued during a pending model/effort pick that gets cancelled without a
   state transition, if reachable; else the closest real construction) sits
   idle until `sweepStuckFlushes(0)` delivers it. Forced path - honest
   scoping: once L1/L2 exist, every wire-constructible wedge is already
   recovered by L1/L2 themselves, so the forced path is exercised via a
   test-support wedge hook (`_testWedgeFlush`, same convention as
   `_testSeedTerminalBuffer`): assert forced recovery ATTEMPTS (session
   replaced, chat entry logged, `lastForcedRecoveryAt` stamped, cooldown
   respected on an immediate second sweep, `flushInProgress` never externally
   cleared) - NOT delivery, which per the accepted residue depends on the
   zombie settling. Negative tests: sweep never fires for busy agents, fresh
   flushes, inMultiStepFlow, or empty queues.
4. **Durable queues (9870b472):** file written on enqueue / emptied on drain
   (assert on `srv.stateRoot`); `srv.restart()` replays order-preserved and the
   boot kick delivers the coalesced prompt (busy-note + prefixes) with
   user_message provenance; same `clientMessageId` re-POSTed after restart is
   deduped (no double delivery); newConversation/cancel clear the file; kill
   removes the key; corrupt file quarantines and boots empty.
5. **Post-swap retrigger (314ee9fb):** update the pinned setPrivileged test as
   above (drains + reaches post-swap session + "will retry" still logged).
6. **[v2] Mid-turn clean stream end (da065287 L1 backstop):** turn in flight
   (send accepted, awaiting turn_completed), endStream() without one while
   still bound → caller unwedged (pendingTurn rejected), dead session pointer
   released (dormant), error surfaced per existing conventions.
7. **[v2] Wake-during-swap race (314ee9fb gating):** idle-state replaceSession
   (setPrivileged on an idle agent) with the old session's drain blocked via
   hangOnClose; inbound message lands mid-drain; release the drain → the
   message is not lost and delivers into the post-swap session exactly once;
   no live pre-send turn gets mis-normalized or clobbered.

`bun test server/test-support/queue.test.ts` plus the full suite; ESLint on
touched files.

## Doc surfaces (per internal-docs/documentation.md)

- `shared/types.ts` (`AgentInfo.queue` "Empty after server restart",
  QueuedMessage header) and `internal-types.ts` (`messageQueue` "In-memory only
  - not persisted") comments → update to durable semantics.
- `internal-docs/scheduled-messages-design.md` delivery-semantics section +
  `scheduled-messages.ts` header bullet 3 ("a crash before the flush loses it")
  → now durable after handoff; loss window closed.
- `docs/features.md` / `how-it-works.md` / site chatbot prompt: check for any
  "queued messages don't survive restarts" caveat and update if present
  (marketing copy stays capability-level per convention).

## Scope-fence & flags

- No new endpoints or API fields. New `~/.isomux/message-queues.json` is
  mechanism.
- Flag to manager: (a) at-least-once boot replay (rare post-crash duplicate) - 
  echoes the existing scheduled-messages decision; (b) [v2] a queue-persistence
  write failure at ACCEPTANCE now fails the send with 500 `persist_failed`
  (durable contract honored; sender knows to retry); post-accept persistence
  failures degrade to at-least-once with loud logs; (c) post-swap
  normalization makes an agent whose busy turn was killed by /model / /effort /
  setPrivileged visibly return to waiting_for_response (previously stuck
  "thinking") - that's the bug fix, but it is observable; (d) [v2] on the
  15s drain-timeout path the .jsonl overlap risk between the wedged old
  subprocess and its replacement is accepted and documented (permanent wedge
  is worse than a rare corrupted resume).
