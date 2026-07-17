# Scheduled messages — design proposal (task 8ff369b5)

Goal: let agents send messages to themselves or other agents at a given future time.
Reviewed by Reviewer1; his crash-consistency, timezone, and stopped-recipient points are folded in below.

## Existing path (what we build on)

- `POST /api/agents/:id/messages` (opId `agents.sendMessage`, route table + `routes/handlers/conversation.ts`). Agent-scope callers hit `sendAsAgent` (index.ts), which builds a server-derived structured sender (spoof-proof) and calls `agentManager.enqueueMessage(receiverId, ...)`.
- `enqueueMessage` pushes onto the in-memory `managed.messageQueue` (`QueuedMessage[]`); idle recipient → immediate flush (starts a turn), busy → rides the next turn. The queue is **in-memory only, empty after restart** (documented in `shared/types.ts`).
- Self-send is currently rejected (400 `self_send`). Stopped/error recipients are rejected (409).
- Scheduling precedent: `cronjob-manager.ts` — persisted `nextFireAt` + 60s `tick()` (initial tick ~5s post-boot), injected clock/scheduler seams for deterministic tests.

## API shape

**Recommended: optional `deliverAt` field on the existing POST** (one field, one send surface, legacy contract untouched when absent), plus a small management resource.

- `POST /api/agents/:receiverId/messages` body `{text, deliverAt?, clientMessageId?}`.
  - `deliverAt` absent → behavior unchanged, bit-for-bit.
  - `deliverAt` present, agent scope → validate, store scheduled entry, ack `{scheduledId, deliverAt}` with the normalized UTC value — no fake empty `messageId`.
  - `deliverAt` present, user scope → 400 (explicit reject; never silently send immediately). User scheduling is out of scope for v1; storage leaves room (sender kind).
  - Format: RFC3339 **with required `Z` or explicit offset** (strict pattern check, not bare `Date.parse` — offset-less local forms are ambiguous). Must be in the future (also catches seconds-vs-ms bugs). Stored internally as epoch ms.
  - Idempotency: `clientMessageId` is stored in the entry, so dedupe survives restarts. Duplicate key + same payload → return the ORIGINAL `scheduledId`; same key + different payload → 409 conflict.
- `GET /api/agents/:id/scheduled-messages` — pending entries **scheduled by** `:id` (its outbox).
- `DELETE /api/agents/:id/scheduled-messages/:scheduledId` — cancel; sender-only. 404 if already fired or unknown (cancel-vs-fire race resolves cleanly: ticks are single-threaded, so an entry is either removed before firing or already gone).
- Note the deliberate asymmetry: `:id` is the **recipient** on POST (matches today's send) but the **sender** on GET/DELETE (you manage your own outbox). Documented in the route table comments and system prompt.
- Auth: agent itself (token id == `:id`) or a user with manage rights, same guard family as other per-agent routes.

Alternative considered: separate `POST /api/agents/:id/scheduled-messages` creation endpoint. Cleaner REST, but a second send surface agents must learn; rejected.

## Storage

`~/.isomux/scheduled-messages.json` — flat JSON array, `atomicWriteFileSync` on every mutation (create / cancel / fire), loaded at boot. Entry:

```jsonc
{
  "id": "sm_a1b2c3d4",            // returned as scheduledId
  "senderAgentId": "...",
  "senderName": "...",            // snapshot, used if the sender is deleted before fire
  "senderRoomName": "...",
  "receiverAgentId": "...",
  "text": "...",
  "clientMessageId": "...",       // optional
  "deliverAt": 1784000000000,     // epoch ms
  "createdAt": 1783990000000
}
```

Robustness rules (per review):
- **Persistence failures fail the request**: if the file write throws on create/cancel, return 500 — never hold a memory-only schedule that silently dies on restart.
- **Corrupt file on boot**: quarantine (rename to `scheduled-messages.json.corrupt-<ts>`), log, start empty. Never overwrite unreadable data with `[]`. Per-entry validation on load; invalid entries dropped with a log line.

## Firing

Small new module (`server/scheduled-messages.ts`) mirroring cronjob-manager: injected clock + scheduler seams, `tick()` every 30s + initial tick ~5s post-boot. Tick-based, not one timer per entry (restart-safe for free, no timer bookkeeping; 30s precision is fine). Reentrancy guard on `tick()`.

- Boot catch-up: past-due entries (including those due during downtime) fire on the first tick.
- Fire calls `enqueueMessage` directly with a server-built structured sender — live agent display if the sender still exists (fresher name), else the stored snapshot. (It cannot reuse the `sendAsAgent` dep verbatim: that path rejects unknown senders, which would break delivery for deleted senders.)
- **Sender deletion (decision 2, resolved)**: pending schedules are NOT cancelled when the sender is deleted — they always fire, delivered under the stored snapshot, clearly marked as scheduled with the schedule-time sender identified. The receiver decides what the sender's absence means.
- `enqueueMessage` gains an optional `scheduledFor` passthrough onto `QueuedMessage` (it must copy the field explicitly or it's silently dropped).
- Ordering: due entries fire in `deliverAt` order (createdAt tiebreak). Per recipient, if an entry fails with `queue_full`, later entries for that recipient are NOT attempted that tick — no leapfrogging.
- Failure handling:
  - Recipient deleted → drop entry + best-effort notice to sender.
  - Recipient `stopped`/`error` or `queue_full` → entry stays pending; retried each tick (a refused enqueue is a cheap no-op call — no turn starts, no logging per attempt). `stopped` is a deliberate human action, so this can persist: give up **24h after `deliverAt`** → drop + best-effort notice to sender. (State-change-triggered immediate retry is a possible later optimization; the 30s tick bounds staleness well enough for v1.)
  - Pending-but-past-due entries still count against the sender quota until delivered/expired; cancel frees quota.

## Delivery semantics (explicit, per review)

**At-least-once from acceptance to queue handoff; durable queue semantics after that.**
- Fire order is enqueue-then-persist-removal. A crash between the two re-fires the entry on restart → rare duplicate. The alternative (persist-removal-then-enqueue) turns the same crash window into silent loss. For reminders/wake-ups a rare duplicate beats a silent drop, so at-least-once is the recommendation.
- After successful handoff, the message lives in the recipient's queue. UPDATE (task 9870b472, queue-reliability bundle): that queue is now itself durable (`~/.isomux/message-queues.json`, replayed on boot), so the old caveat — "if the recipient is busy and the server crashes before the flush, it is lost" — no longer applies. End-to-end delivery is at-least-once; see `internal-docs/queue-reliability-design.md`.

## Decisions (RESOLVED by Nil, 2026-07-11)

1. **Crash-consistency at fire time**: at-least-once (enqueue-then-persist-removal; a rare duplicate on crash beats silent loss).
2. **Deleted senders**: scheduled messages are **always delivered**, even if the sender is dead at fire time, using the stored sender snapshot. Rationale (Nil): the receiver can see the sender is gone and act accordingly — let the receiver decide. So: no cancellation on sender deletion; the delivered message clearly identifies the schedule-time sender and the fact that it was scheduled.

## Self-messages

400 `self_send` stays for immediate sends (loop hazard) but is **lifted when `deliverAt` is present** — a future self-message is the reminder/wake-up use case. `scheduledFor` on `QueuedMessage` lets the flush prompt mark it ("scheduled message from yourself, scheduled for <time>") so the recipient doesn't parrot a reply to itself.

## Limits

- Max 20 pending per sender → 429 `schedule_full`.
- Max horizon 30 days → 400 `invalid_deliver_at`.

## Test plan

Deterministic via the injected clock/scheduler (cronjob-manager pattern): boot catch-up; persistence-failure → 500; crash-window simulation around fire (entry re-fires after reload); clock jumps (backward jump delays, never crashes); recipient deletion / stopped-then-restarted / 24h deadline expiry; same-tick ordering + queue_full no-leapfrog; cancel-vs-fire; clientMessageId idempotency across reload incl. same-key-different-payload 409; corrupt-file quarantine; timer cleanup on dispose.

## Out of scope for v1

UI (GET endpoint leaves room for a pending panel later; post-fire the normal queue chip already shows it); user (boss) senders; recurring schedules (cronjobs cover recurring).

## Doc surfaces to update at implementation time

- `server/system-prompt.ts` messaging how-to (deliverAt + list/cancel + self-message note).
- Whatever `internal-docs/documentation.md` lists as affected (route table docs, API reference).
