// Scheduled messages (task 8ff369b5): let an agent send a message to itself or
// another agent at a future time (POST /api/agents/:id/messages + deliverAt).
//
// Shape mirrors cronjob-manager: an instantiable factory with injected
// persistence, clock, and scheduler seams so schedule firing is
// deterministically testable, and a tick loop (initial tick shortly after
// boot + a fixed interval) rather than one timer per entry — restart safety
// falls out of the persisted entry list instead of timer bookkeeping.
//
// DELIVERY SEMANTICS (decisions by Nil, 2026-07-11; see
// internal-docs/scheduled-messages-design.md):
//   - AT-LEAST-ONCE from acceptance to queue handoff: fire order is
//     enqueue-then-persist-removal, so a crash between the two re-fires the
//     entry on restart (rare duplicate). The alternative order would turn the
//     same crash window into silent loss.
//   - Scheduled messages ALWAYS deliver, even when the sender agent no longer
//     exists at fire time — the stored snapshot identifies the schedule-time
//     sender and the receiver is told the sender is gone (receiver decides
//     what that means).
//   - After handoff the message lives in the receiver's queue, which is
//     itself DURABLE since task 9870b472 (~/.isomux/message-queues.json,
//     replayed on boot) — the old "crash before the flush loses it" window is
//     closed; end-to-end delivery is at-least-once.

import type { ScheduledMessageEntry, QueuedMessage } from "../shared/types.ts";
import type { EnqueueResult } from "./internal-types.ts";
import { errMessage } from "../shared/errors.ts";

// Tick cadence. 30s precision is plenty for a "future time" feature; the
// initial tick delays a few seconds so boot catch-up runs after agent restore
// kicks off (a past-due entry to a still-restoring agent just queues normally).
const TICK_INTERVAL_MS = 30_000;
const INITIAL_TICK_DELAY_MS = 5_000;

// Junk control (design-pinned): a sender may hold at most this many pending
// entries, and may not schedule further out than the horizon. Pending-but-
// past-due entries (blocked on a stopped receiver) still count against the
// quota until delivered or expired; cancel frees it.
export const MAX_PENDING_PER_SENDER = 20;
export const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// A pending entry that cannot deliver (receiver stopped/errored/queue-full)
// is retried each tick until this long past its deliverAt, then dropped with
// a best-effort notice to the sender.
export const DELIVERY_DEADLINE_MS = 24 * 60 * 60 * 1000; // 24h

// Strict RFC3339 wall-clock with a REQUIRED zone: 'Z' or a numeric offset.
// Offset-less local forms are deliberately rejected (Date.parse would guess
// the server's zone), as are bare epoch numbers (a seconds-vs-ms confusion
// would otherwise schedule for 1970 and "fire immediately", masking the bug).
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

// Parse a deliverAt request field to epoch ms, or null when malformed. Pure —
// "is it in the future / within the horizon" is the manager's job (it owns the
// clock); this owns only the format contract.
export function parseDeliverAt(value: string): number | null {
  if (!RFC3339_RE.test(value)) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

// The one message shape this module hands to the queue: a scheduled agent
// sender plus the scheduledFor/scheduledSenderGone markers the flush prefix
// renders. Kept structural (not imported from agent-manager) so this module
// stays a leaf below agent-manager; isomux-office.ts's closure is where the two meet.
export interface ScheduledDelivery {
  sender: Extract<QueuedMessage["sender"], { kind: "agent" }>;
  text: string;
  scheduledFor: number;
  scheduledSenderGone?: boolean;
}

export interface ScheduledMessagesPersistence {
  // Raw load (unknown[]): per-entry validation happens here in the manager so
  // it also covers injected test persistence. Must never throw.
  load(): unknown[];
  // Durable write. MUST THROW on failure — schedule/cancel callers translate
  // that into a failed request instead of holding a memory-only entry.
  save(entries: ScheduledMessageEntry[]): void;
}

export interface ScheduledMessagesClock {
  now(): number;
}

export interface ScheduledMessagesScheduler {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export interface ScheduledMessageManagerDeps {
  // Queue handoff (production: agentManager.enqueueMessage). The discriminated
  // result drives retry-vs-drop below.
  enqueue(receiverId: string, msg: ScheduledDelivery): EnqueueResult;
  // Live display lookup (production: agentManager.getAgentDisplay). Snapshot
  // source at schedule time; freshness source at fire time.
  getAgentDisplay(agentId: string): { name: string; roomName: string } | null;
  // Best-effort failure notice into the SENDER's chat (production: a system
  // log entry — boss-visible, burns no turn). Failures here are swallowed.
  notifySender(senderAgentId: string, text: string): void;
  persistence: ScheduledMessagesPersistence;
  clock: ScheduledMessagesClock;
  scheduler: ScheduledMessagesScheduler;
}

export type ScheduleInput = {
  senderAgentId: string;
  receiverAgentId: string;
  text: string;
  deliverAt: number; // epoch ms, already format-validated by parseDeliverAt
  clientMessageId?: string;
};

// Discriminated outcomes for the two mutating operations. Status/code map
// straight onto the HTTP contract in the conversation handler.
export type ScheduleResult =
  | { ok: true; entry: ScheduledMessageEntry; deduped: boolean }
  | {
      ok: false;
      status: 400 | 404 | 409 | 429 | 500;
      code: string;
      message: string;
    };
export type CancelResult =
  | { ok: true }
  | { ok: false; status: 404 | 500; code: string; message: string };

export type ScheduledMessageManager = ReturnType<
  typeof createScheduledMessageManager
>;

// Narrow an unknown loaded record to a ScheduledMessageEntry. Parity-loose on
// nothing: every field the fire/cancel paths read is checked, so a hand-edited
// or partially-written record can't crash a tick.
function isValidEntry(e: unknown): e is ScheduledMessageEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.senderAgentId === "string" &&
    typeof r.senderName === "string" &&
    typeof r.senderRoomName === "string" &&
    typeof r.receiverAgentId === "string" &&
    typeof r.text === "string" &&
    (r.clientMessageId === undefined ||
      typeof r.clientMessageId === "string") &&
    typeof r.deliverAt === "number" &&
    Number.isFinite(r.deliverAt) &&
    typeof r.createdAt === "number"
  );
}

function generateScheduledId(existing: ScheduledMessageEntry[]): string {
  const ids = new Set(existing.map((m) => m.id));
  for (;;) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const id =
      "sm_" +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    if (!ids.has(id)) return id;
  }
}

export function createScheduledMessageManager(
  deps: ScheduledMessageManagerDeps,
) {
  const { clock, scheduler, persistence } = deps;

  // Load + validate once at construction (boot). Invalid records are dropped
  // with a log line; a fully corrupt FILE was already quarantined by the
  // production persistence layer before we got here.
  const entries: ScheduledMessageEntry[] = [];
  for (const raw of persistence.load()) {
    if (isValidEntry(raw)) entries.push(raw);
    else
      console.error(
        "Dropping invalid scheduled-message record:",
        JSON.stringify(raw)?.slice(0, 200),
      );
  }

  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let initialTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let tickInProgress = false;

  // --- Create / list / cancel ------------------------------------------------

  function schedule(input: ScheduleInput): ScheduleResult {
    const now = clock.now();
    if (input.text.length === 0) {
      return {
        ok: false,
        status: 400,
        code: "invalid_text",
        message: "text is required",
      };
    }
    if (input.deliverAt <= now) {
      return {
        ok: false,
        status: 400,
        code: "invalid_deliver_at",
        message: "deliverAt must be in the future",
      };
    }
    if (input.deliverAt - now > MAX_HORIZON_MS) {
      return {
        ok: false,
        status: 400,
        code: "invalid_deliver_at",
        message: "deliverAt is more than 30 days ahead",
      };
    }
    // Receiver must exist at schedule time (parity with the immediate send's
    // recipient-existence contract). Fire time re-checks — deletion between
    // the two is the drop-and-notify path, not a schedule-time concern.
    if (!deps.getAgentDisplay(input.receiverAgentId)) {
      return {
        ok: false,
        status: 404,
        code: "recipient_not_found",
        message: "Recipient not found.",
      };
    }
    const senderDisplay = deps.getAgentDisplay(input.senderAgentId);
    if (!senderDisplay) {
      // Token-authenticated callers always resolve; this is a deleted-mid-
      // request race or a direct-call misuse.
      return {
        ok: false,
        status: 400,
        code: "unknown_sender",
        message: "Sender is not a known agent.",
      };
    }
    // Restart-surviving idempotency: same sender + same clientMessageId on a
    // PENDING entry returns the original (deduped); a different payload under
    // the same key is a caller bug surfaced loudly, never silently merged.
    if (input.clientMessageId) {
      const existing = entries.find(
        (e) =>
          e.senderAgentId === input.senderAgentId &&
          e.clientMessageId === input.clientMessageId,
      );
      if (existing) {
        const samePayload =
          existing.receiverAgentId === input.receiverAgentId &&
          existing.text === input.text &&
          existing.deliverAt === input.deliverAt;
        if (samePayload) return { ok: true, entry: existing, deduped: true };
        return {
          ok: false,
          status: 409,
          code: "client_message_id_conflict",
          message:
            "clientMessageId matches a pending scheduled message with a different payload.",
        };
      }
    }
    const pendingBySender = entries.filter(
      (e) => e.senderAgentId === input.senderAgentId,
    ).length;
    if (pendingBySender >= MAX_PENDING_PER_SENDER) {
      return {
        ok: false,
        status: 429,
        code: "schedule_full",
        message: `Sender already has ${MAX_PENDING_PER_SENDER} pending scheduled messages.`,
      };
    }
    const entry: ScheduledMessageEntry = {
      id: generateScheduledId(entries),
      senderAgentId: input.senderAgentId,
      senderName: senderDisplay.name,
      senderRoomName: senderDisplay.roomName,
      receiverAgentId: input.receiverAgentId,
      text: input.text,
      ...(input.clientMessageId
        ? { clientMessageId: input.clientMessageId }
        : {}),
      deliverAt: input.deliverAt,
      createdAt: now,
    };
    entries.push(entry);
    try {
      persistence.save(entries);
    } catch (err) {
      // Durable write failed: roll back the in-memory push and fail the
      // request. A memory-only schedule would silently die on restart.
      entries.pop();
      console.error("Failed to persist scheduled message:", errMessage(err));
      return {
        ok: false,
        status: 500,
        code: "persist_failed",
        message: "Failed to persist the scheduled message.",
      };
    }
    return { ok: true, entry, deduped: false };
  }

  // The sender's pending outbox, soonest first.
  function listBySender(senderAgentId: string): ScheduledMessageEntry[] {
    return entries
      .filter((e) => e.senderAgentId === senderAgentId)
      .sort((a, b) => a.deliverAt - b.deliverAt || a.createdAt - b.createdAt);
  }

  function cancel(senderAgentId: string, scheduledId: string): CancelResult {
    const idx = entries.findIndex(
      (e) => e.id === scheduledId && e.senderAgentId === senderAgentId,
    );
    // Unknown id, someone else's entry, and already-fired all collapse into
    // one 404 — the outbox never confirms other senders' entry ids.
    if (idx === -1) {
      return {
        ok: false,
        status: 404,
        code: "scheduled_message_not_found",
        message: "No such pending scheduled message.",
      };
    }
    const [removed] = entries.splice(idx, 1);
    try {
      persistence.save(entries);
    } catch (err) {
      entries.splice(idx, 0, removed);
      console.error(
        "Failed to persist scheduled-message cancel:",
        errMessage(err),
      );
      return {
        ok: false,
        status: 500,
        code: "persist_failed",
        message: "Failed to persist the cancellation.",
      };
    }
    return { ok: true };
  }

  // --- Firing ------------------------------------------------------------------

  function removeAndPersistBestEffort(entry: ScheduledMessageEntry) {
    const idx = entries.indexOf(entry);
    if (idx !== -1) entries.splice(idx, 1);
    try {
      persistence.save(entries);
    } catch (err) {
      // AT-LEAST-ONCE: the entry stays on disk (and, if the splice above ran,
      // re-loads on restart). If the process survives, the in-memory removal
      // holds and no duplicate fires this boot; a crash may re-fire it.
      console.error(
        "Failed to persist scheduled-message removal (entry may re-fire after a restart):",
        errMessage(err),
      );
    }
  }

  function notify(senderAgentId: string, text: string) {
    try {
      deps.notifySender(senderAgentId, text);
    } catch (err) {
      console.error(
        "Failed to notify scheduled-message sender:",
        errMessage(err),
      );
    }
  }

  function tick() {
    // Reentrancy guard: enqueue can synchronously kick a queue flush whose
    // side effects could conceivably re-enter tick; and a slow tick must not
    // interleave with the next interval firing.
    if (tickInProgress) return;
    tickInProgress = true;
    try {
      const now = clock.now();
      const due = entries
        .filter((e) => e.deliverAt <= now)
        .sort((a, b) => a.deliverAt - b.deliverAt || a.createdAt - b.createdAt);
      if (due.length === 0) return;
      // Per-receiver ordering: once an entry for a receiver fails retryably
      // (stopped / errored / queue-full), LATER entries for that receiver are
      // not attempted this tick — no leapfrogging.
      const blockedReceivers = new Set<string>();
      for (const entry of due) {
        if (blockedReceivers.has(entry.receiverAgentId)) continue;
        const liveSender = deps.getAgentDisplay(entry.senderAgentId);
        const senderGone = liveSender === null;
        const result = deps.enqueue(entry.receiverAgentId, {
          sender: {
            kind: "agent",
            agentId: entry.senderAgentId,
            agentName: liveSender?.name ?? entry.senderName,
            roomName: liveSender?.roomName ?? entry.senderRoomName,
          },
          text: entry.text,
          scheduledFor: entry.deliverAt,
          ...(senderGone ? { scheduledSenderGone: true } : {}),
        });
        if (result.ok) {
          // Enqueue-then-persist-removal (at-least-once; see header).
          removeAndPersistBestEffort(entry);
          continue;
        }
        if (result.status === 404) {
          // Receiver deleted since scheduling: deliver-anyway applies to a
          // GONE SENDER, not a gone receiver — there is no chat to deliver
          // into. Drop + best-effort notice.
          removeAndPersistBestEffort(entry);
          notify(
            entry.senderAgentId,
            `Scheduled message ${entry.id} to agent ${entry.receiverAgentId} was dropped: the recipient no longer exists.`,
          );
          continue;
        }
        // Retryable (agent_stopped / agent_error 409, queue_full 429): the
        // rejected enqueue is a cheap no-op — no turn started, nothing queued.
        // Stay pending and retry next tick until the delivery deadline.
        if (now - entry.deliverAt > DELIVERY_DEADLINE_MS) {
          removeAndPersistBestEffort(entry);
          notify(
            entry.senderAgentId,
            `Scheduled message ${entry.id} to agent ${entry.receiverAgentId} was dropped after 24h of failed delivery attempts (last error: ${result.error}).`,
          );
          continue;
        }
        blockedReceivers.add(entry.receiverAgentId);
      }
    } finally {
      tickInProgress = false;
    }
  }

  // --- Lifecycle -----------------------------------------------------------------

  // Boot catch-up happens on the first (delayed) tick: anything past-due —
  // including entries that came due while the server was down — fires there.
  function start() {
    if (intervalHandle !== null) return;
    initialTimeoutHandle = scheduler.setTimeout(
      () => tick(),
      INITIAL_TICK_DELAY_MS,
    );
    intervalHandle = scheduler.setInterval(() => tick(), TICK_INTERVAL_MS);
  }

  function stop() {
    if (initialTimeoutHandle !== null) {
      scheduler.clearTimeout(initialTimeoutHandle);
      initialTimeoutHandle = null;
    }
    if (intervalHandle !== null) {
      scheduler.clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  return {
    schedule,
    listBySender,
    cancel,
    start,
    stop,
  };
}
