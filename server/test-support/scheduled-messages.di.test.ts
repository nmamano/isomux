// Scheduled-messages unit tests (task 8ff369b5). Proves the manager is an
// instantiable unit: enqueue/display/notify/persistence/clock/scheduler are all
// injected, so schedule firing is fully deterministic - no timers, no server,
// no disk (except the quarantine section, which targets the REAL persistence
// helpers against the preload's temp STATE_ROOT on purpose).
//
// Pins the design-resolved delivery semantics (Nil, 2026-07-11):
//   - AT-LEAST-ONCE handoff: enqueue-then-persist-removal; a persist failure
//     after a successful enqueue re-fires after a "restart" (documented dup).
//   - Deleted senders still deliver, under the stored snapshot, flagged
//     scheduledSenderGone.
// Plus the review-pinned edges: strict RFC3339 zone requirement, persist
// failures fail the mutation (with in-memory rollback), per-receiver ordering
// with no queue-full leapfrogging, the 24h retry deadline, quota, and
// restart-surviving clientMessageId idempotency.

import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs";
import {
  createScheduledMessageManager,
  parseDeliverAt,
  MAX_PENDING_PER_SENDER,
  MAX_HORIZON_MS,
  DELIVERY_DEADLINE_MS,
  type ScheduledMessageManagerDeps,
  type ScheduledDelivery,
} from "../scheduled-messages.ts";
import {
  loadScheduledMessagesRaw,
  saveScheduledMessages,
} from "../persistence.ts";
import { STATE_ROOT } from "../config.ts";
import type { ScheduledMessageEntry } from "../../shared/types.ts";
import type { EnqueueResult } from "../internal-types.ts";

const FIXED_NOW = 1_000_000_000; // fake epoch; proves no real clock is read
const HOUR = 60 * 60 * 1000;

// Recording fake scheduler (cronjob-manager.di pattern): never auto-fires;
// tests drive captured callbacks by hand.
function fakeScheduler() {
  const timeouts: { fn: () => void; ms?: number }[] = [];
  const intervals: { fn: () => void; ms?: number }[] = [];
  const cleared = { timeouts: 0, intervals: 0 };
  const scheduler: ScheduledMessageManagerDeps["scheduler"] = {
    setTimeout: ((fn: () => void, ms?: number) => {
      timeouts.push({ fn, ms });
      return timeouts.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: () => {
      cleared.timeouts++;
    },
    setInterval: ((fn: () => void, ms?: number) => {
      intervals.push({ fn, ms });
      return intervals.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: () => {
      cleared.intervals++;
    },
  };
  return { scheduler, timeouts, intervals, cleared };
}

// A full fake world: mutable agent directory, scripted enqueue outcomes,
// recorded notices, an in-memory persistence with a fail switch.
function makeWorld(over: Partial<ScheduledMessageManagerDeps> = {}) {
  const agents = new Map<string, { name: string; roomName: string }>([
    ["agent-a", { name: "Alice", roomName: "Room 1" }],
    ["agent-b", { name: "Bob", roomName: "Room 2" }],
  ]);
  const enqueueCalls: { receiverId: string; msg: ScheduledDelivery }[] = [];
  let enqueueResult: (receiverId: string) => EnqueueResult = () => ({
    ok: true,
    queued: false,
    messageId: "q1",
  });
  const notices: { senderAgentId: string; text: string }[] = [];
  const store = {
    saved: [] as ScheduledMessageEntry[],
    saveCount: 0,
    failNextSave: false,
  };
  let now = FIXED_NOW;
  const sched = fakeScheduler();
  const deps: ScheduledMessageManagerDeps = {
    enqueue: (receiverId, msg) => {
      enqueueCalls.push({ receiverId, msg });
      return enqueueResult(receiverId);
    },
    getAgentDisplay: (id) => agents.get(id) ?? null,
    notifySender: (senderAgentId, text) => {
      notices.push({ senderAgentId, text });
    },
    persistence: {
      load: () => [...store.saved],
      save: (entries) => {
        if (store.failNextSave) {
          store.failNextSave = false;
          throw new Error("disk full");
        }
        store.saved = entries.map((e) => ({ ...e }));
        store.saveCount++;
      },
    },
    clock: { now: () => now },
    scheduler: sched.scheduler,
    ...over,
  };
  return {
    deps,
    agents,
    enqueueCalls,
    setEnqueueResult: (fn: (receiverId: string) => EnqueueResult) => {
      enqueueResult = fn;
    },
    notices,
    store,
    setNow: (t: number) => {
      now = t;
    },
    sched,
  };
}

const IN_1H = FIXED_NOW + HOUR;

function scheduleOk(
  m: ReturnType<typeof createScheduledMessageManager>,
  input: Partial<Parameters<typeof m.schedule>[0]> = {},
) {
  const r = m.schedule({
    senderAgentId: "agent-a",
    receiverAgentId: "agent-b",
    text: "hello future",
    deliverAt: IN_1H,
    ...input,
  });
  if (!r.ok) throw new Error(`schedule failed: ${r.code}`);
  return r.entry;
}

// Drive the manager's tick via the captured interval callback (start() first).
function makeTicker(
  m: ReturnType<typeof createScheduledMessageManager>,
  sched: ReturnType<typeof fakeScheduler>,
) {
  m.start();
  const tick = sched.intervals[0]?.fn;
  if (!tick) throw new Error("start() registered no interval");
  return tick;
}

describe("parseDeliverAt", () => {
  it("accepts RFC3339 with Z or numeric offset (and normalizes to epoch ms)", () => {
    expect(parseDeliverAt("2026-07-12T09:30:00Z")).toBe(
      Date.parse("2026-07-12T09:30:00Z"),
    );
    expect(parseDeliverAt("2026-07-12T09:30:00.250Z")).toBe(
      Date.parse("2026-07-12T09:30:00.250Z"),
    );
    // Same instant expressed with an offset parses to the same epoch.
    expect(parseDeliverAt("2026-07-12T11:30:00+02:00")).toBe(
      Date.parse("2026-07-12T09:30:00Z"),
    );
    // Seconds are optional per RFC3339 profile here.
    expect(parseDeliverAt("2026-07-12T09:30Z")).toBe(
      Date.parse("2026-07-12T09:30:00Z"),
    );
  });

  it("rejects offset-less local forms (ambiguous zone)", () => {
    expect(parseDeliverAt("2026-07-12T09:30:00")).toBeNull();
    expect(parseDeliverAt("2026-07-12 09:30:00Z")).toBeNull();
    expect(parseDeliverAt("2026-07-12")).toBeNull();
  });

  it("rejects bare epoch numbers and garbage (seconds-vs-ms guard)", () => {
    expect(parseDeliverAt("1784000000")).toBeNull();
    expect(parseDeliverAt("1784000000000")).toBeNull();
    expect(parseDeliverAt("tomorrow")).toBeNull();
    expect(parseDeliverAt("")).toBeNull();
  });

  it("rejects shape-valid but impossible dates", () => {
    expect(parseDeliverAt("2026-13-40T09:30:00Z")).toBeNull();
  });
});

describe("schedule (create)", () => {
  it("stores a persisted entry with sender snapshot and returns it", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    const entry = scheduleOk(m, { clientMessageId: "k1" });
    expect(entry.id).toMatch(/^sm_[0-9a-f]{8}$/);
    expect(entry.senderName).toBe("Alice");
    expect(entry.senderRoomName).toBe("Room 1");
    expect(entry.deliverAt).toBe(IN_1H);
    expect(entry.createdAt).toBe(FIXED_NOW);
    expect(w.store.saved).toHaveLength(1);
    expect(w.store.saved[0].id).toBe(entry.id);
    expect(w.store.saved[0].clientMessageId).toBe("k1");
  });

  it("rejects past / now / beyond-horizon deliverAt with invalid_deliver_at", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    for (const deliverAt of [
      FIXED_NOW - 1,
      FIXED_NOW,
      FIXED_NOW + MAX_HORIZON_MS + 1,
    ]) {
      const r = m.schedule({
        senderAgentId: "agent-a",
        receiverAgentId: "agent-b",
        text: "x",
        deliverAt,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.code).toBe("invalid_deliver_at");
      }
    }
    expect(w.store.saveCount).toBe(0);
  });

  it("rejects an unknown receiver (404) and empty text (400)", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    const r1 = m.schedule({
      senderAgentId: "agent-a",
      receiverAgentId: "agent-nope",
      text: "x",
      deliverAt: IN_1H,
    });
    expect(
      !r1.ok && r1.status === 404 && r1.code === "recipient_not_found",
    ).toBe(true);
    const r2 = m.schedule({
      senderAgentId: "agent-a",
      receiverAgentId: "agent-b",
      text: "",
      deliverAt: IN_1H,
    });
    expect(!r2.ok && r2.status === 400 && r2.code === "invalid_text").toBe(
      true,
    );
  });

  it("allows scheduling to SELF (the reminder/wake-up case)", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    const entry = scheduleOk(m, { receiverAgentId: "agent-a" });
    expect(entry.receiverAgentId).toBe("agent-a");
  });

  it("enforces the per-sender pending quota with 429 schedule_full", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    for (let i = 0; i < MAX_PENDING_PER_SENDER; i++) {
      scheduleOk(m, { text: `msg ${i}` });
    }
    const r = m.schedule({
      senderAgentId: "agent-a",
      receiverAgentId: "agent-b",
      text: "one too many",
      deliverAt: IN_1H,
    });
    expect(!r.ok && r.status === 429 && r.code === "schedule_full").toBe(true);
    // Another sender is unaffected (quota is per sender).
    const r2 = m.schedule({
      senderAgentId: "agent-b",
      receiverAgentId: "agent-a",
      text: "fine",
      deliverAt: IN_1H,
    });
    expect(r2.ok).toBe(true);
  });

  it("clientMessageId: same payload dedupes to the ORIGINAL entry; different payload conflicts 409", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    const entry = scheduleOk(m, { clientMessageId: "retry-key" });
    const dup = m.schedule({
      senderAgentId: "agent-a",
      receiverAgentId: "agent-b",
      text: "hello future",
      deliverAt: IN_1H,
      clientMessageId: "retry-key",
    });
    expect(dup.ok && dup.deduped && dup.entry.id === entry.id).toBe(true);
    expect(w.store.saved).toHaveLength(1);
    const conflict = m.schedule({
      senderAgentId: "agent-a",
      receiverAgentId: "agent-b",
      text: "DIFFERENT text",
      deliverAt: IN_1H,
      clientMessageId: "retry-key",
    });
    expect(
      !conflict.ok &&
        conflict.status === 409 &&
        conflict.code === "client_message_id_conflict",
    ).toBe(true);
    // The key is per sender: agent-b may reuse it freely.
    const other = m.schedule({
      senderAgentId: "agent-b",
      receiverAgentId: "agent-a",
      text: "unrelated",
      deliverAt: IN_1H,
      clientMessageId: "retry-key",
    });
    expect(other.ok).toBe(true);
  });

  it("a persist failure fails the create (500) and rolls back in-memory state", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    w.store.failNextSave = true;
    const r = m.schedule({
      senderAgentId: "agent-a",
      receiverAgentId: "agent-b",
      text: "doomed",
      deliverAt: IN_1H,
    });
    expect(!r.ok && r.status === 500 && r.code === "persist_failed").toBe(true);
    expect(m.listBySender("agent-a")).toHaveLength(0);
    expect(w.store.saved).toHaveLength(0);
  });
});

describe("list / cancel", () => {
  it("listBySender returns only the sender's entries, soonest first", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    const late = scheduleOk(m, { deliverAt: IN_1H + HOUR, text: "late" });
    const early = scheduleOk(m, { deliverAt: IN_1H, text: "early" });
    scheduleOk(m, { senderAgentId: "agent-b", receiverAgentId: "agent-a" });
    const listed = m.listBySender("agent-a");
    expect(listed.map((e) => e.id)).toEqual([early.id, late.id]);
  });

  it("cancel removes + persists; wrong sender and unknown id collapse to 404", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    const entry = scheduleOk(m);
    // Another sender cannot cancel it (and cannot distinguish it from absent).
    const foreign = m.cancel("agent-b", entry.id);
    expect(!foreign.ok && foreign.status === 404).toBe(true);
    const unknown = m.cancel("agent-a", "sm_ffffffff");
    expect(!unknown.ok && unknown.status === 404).toBe(true);
    expect(m.cancel("agent-a", entry.id).ok).toBe(true);
    expect(m.listBySender("agent-a")).toHaveLength(0);
    expect(w.store.saved).toHaveLength(0);
    // Cancel of an already-cancelled id is 404 (already fired looks the same).
    const again = m.cancel("agent-a", entry.id);
    expect(!again.ok && again.status === 404).toBe(true);
  });

  it("a persist failure fails the cancel (500) and restores the entry", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    const entry = scheduleOk(m);
    w.store.failNextSave = true;
    const r = m.cancel("agent-a", entry.id);
    expect(!r.ok && r.status === 500 && r.code === "persist_failed").toBe(true);
    expect(m.listBySender("agent-a").map((e) => e.id)).toEqual([entry.id]);
  });

  it("cancel frees quota", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    const entries = Array.from({ length: MAX_PENDING_PER_SENDER }, (_, i) =>
      scheduleOk(m, { text: `msg ${i}` }),
    );
    expect(m.cancel("agent-a", entries[0].id).ok).toBe(true);
    expect(
      m.schedule({
        senderAgentId: "agent-a",
        receiverAgentId: "agent-b",
        text: "fits again",
        deliverAt: IN_1H,
      }).ok,
    ).toBe(true);
  });
});

describe("firing (tick)", () => {
  it("fires due entries with scheduledFor + live sender display, removes + persists them; not-due entries wait", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    const due = scheduleOk(m, { deliverAt: IN_1H, text: "due" });
    scheduleOk(m, { deliverAt: IN_1H + HOUR, text: "not yet" });
    const tick = makeTicker(m, w.sched);
    tick();
    expect(w.enqueueCalls).toHaveLength(0); // nothing due yet
    // Live rename between schedule and fire: fire uses the FRESH display.
    w.agents.set("agent-a", { name: "Alice2", roomName: "Room 1b" });
    w.setNow(IN_1H + 1);
    tick();
    expect(w.enqueueCalls).toHaveLength(1);
    const call = w.enqueueCalls[0];
    expect(call.receiverId).toBe("agent-b");
    expect(call.msg.text).toBe("due");
    expect(call.msg.scheduledFor).toBe(IN_1H);
    expect(call.msg.scheduledSenderGone).toBeUndefined();
    expect(call.msg.sender).toEqual({
      kind: "agent",
      agentId: "agent-a",
      agentName: "Alice2",
      roomName: "Room 1b",
    });
    expect(m.listBySender("agent-a").map((e) => e.text)).toEqual(["not yet"]);
    expect(w.store.saved.map((e) => e.text)).toEqual(["not yet"]);
    expect(w.store.saved.find((e) => e.id === due.id)).toBeUndefined();
  });

  it("boot catch-up: past-due entries loaded from persistence fire on the initial tick", () => {
    const w = makeWorld();
    const m1 = createScheduledMessageManager(w.deps);
    scheduleOk(m1, { deliverAt: IN_1H });
    // "Restart": a fresh manager over the same store, clock past deliverAt
    // (the downtime covered the delivery window).
    w.setNow(IN_1H + HOUR);
    const w2sched = fakeScheduler();
    const m2 = createScheduledMessageManager({
      ...w.deps,
      scheduler: w2sched.scheduler,
    });
    m2.start();
    expect(w2sched.timeouts).toHaveLength(1); // initial catch-up tick
    w2sched.timeouts[0].fn();
    expect(w.enqueueCalls).toHaveLength(1);
    expect(m2.listBySender("agent-a")).toHaveLength(0);
  });

  it("DELETED SENDER still delivers, under the stored snapshot, flagged scheduledSenderGone (Nil's decision)", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    scheduleOk(m);
    w.agents.delete("agent-a");
    w.setNow(IN_1H + 1);
    const tick = makeTicker(m, w.sched);
    tick();
    expect(w.enqueueCalls).toHaveLength(1);
    const msg = w.enqueueCalls[0].msg;
    expect(msg.sender.agentName).toBe("Alice"); // schedule-time snapshot
    expect(msg.sender.roomName).toBe("Room 1");
    expect(msg.scheduledSenderGone).toBe(true);
    expect(m.listBySender("agent-a")).toHaveLength(0);
  });

  it("deleted RECEIVER drops the entry and notifies the sender", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    const entry = scheduleOk(m);
    w.setEnqueueResult(() => ({
      ok: false,
      error: "agent not found",
      status: 404,
    }));
    w.setNow(IN_1H + 1);
    const tick = makeTicker(m, w.sched);
    tick();
    expect(m.listBySender("agent-a")).toHaveLength(0);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0].senderAgentId).toBe("agent-a");
    expect(w.notices[0].text).toContain(entry.id);
    expect(w.notices[0].text).toContain("no longer exists");
  });

  it("retryable failures (stopped receiver) stay pending and deliver on a later tick", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    scheduleOk(m);
    w.setEnqueueResult(() => ({
      ok: false,
      error: "agent_stopped",
      status: 409,
    }));
    w.setNow(IN_1H + 1);
    const tick = makeTicker(m, w.sched);
    tick();
    tick();
    expect(w.enqueueCalls).toHaveLength(2); // retried, cheap no-ops
    expect(m.listBySender("agent-a")).toHaveLength(1);
    expect(w.notices).toHaveLength(0);
    // Receiver comes back: next tick delivers.
    w.setEnqueueResult(() => ({ ok: true, queued: true, messageId: "q9" }));
    tick();
    expect(m.listBySender("agent-a")).toHaveLength(0);
  });

  it("gives up 24h past deliverAt: drops + notifies the sender", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    const entry = scheduleOk(m);
    w.setEnqueueResult(() => ({
      ok: false,
      error: "agent_stopped",
      status: 409,
    }));
    const tick = makeTicker(m, w.sched);
    w.setNow(IN_1H + DELIVERY_DEADLINE_MS); // exactly at the deadline: still retrying
    tick();
    expect(m.listBySender("agent-a")).toHaveLength(1);
    w.setNow(IN_1H + DELIVERY_DEADLINE_MS + 1);
    tick();
    expect(m.listBySender("agent-a")).toHaveLength(0);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0].text).toContain(entry.id);
    expect(w.notices[0].text).toContain("agent_stopped");
  });

  it("fires same-receiver due entries in deliverAt order and never leapfrogs a queue-full one", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    scheduleOk(m, { deliverAt: IN_1H + 1, text: "second" });
    scheduleOk(m, { deliverAt: IN_1H, text: "first" });
    scheduleOk(m, {
      senderAgentId: "agent-b",
      receiverAgentId: "agent-a",
      deliverAt: IN_1H,
      text: "other receiver",
    });
    w.setNow(IN_1H + HOUR);
    // agent-b's queue is full; agent-a accepts.
    w.setEnqueueResult((receiverId) =>
      receiverId === "agent-b"
        ? { ok: false, error: "queue_full", status: 429 }
        : { ok: true, queued: true, messageId: "q1" },
    );
    const tick = makeTicker(m, w.sched);
    tick();
    // "first" was attempted and failed; "second" was NOT attempted (no
    // leapfrog); the other receiver's entry was attempted independently.
    expect(
      w.enqueueCalls.map((c) => ({ r: c.receiverId, t: c.msg.text })),
    ).toEqual([
      { r: "agent-b", t: "first" },
      { r: "agent-a", t: "other receiver" },
    ]);
    expect(m.listBySender("agent-a")).toHaveLength(2);
    // Queue clears: next tick delivers both, in order.
    w.setEnqueueResult(() => ({ ok: true, queued: true, messageId: "q2" }));
    tick();
    expect(w.enqueueCalls.slice(1).map((c) => c.msg.text)).toEqual([
      "other receiver",
      "first",
      "second",
    ]);
  });

  it("AT-LEAST-ONCE: a removal-persist failure after a successful enqueue does not re-fire this boot, but re-fires after a restart (the documented duplicate)", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    scheduleOk(m);
    w.setNow(IN_1H + 1);
    const tick = makeTicker(m, w.sched);
    w.store.failNextSave = true; // crash-window simulation: enqueue ok, save fails
    tick();
    expect(w.enqueueCalls).toHaveLength(1);
    // In-memory removal held: no duplicate while THIS process lives.
    tick();
    expect(w.enqueueCalls).toHaveLength(1);
    // But the store still holds the entry - a restart re-fires it.
    expect(w.store.saved).toHaveLength(1);
    const w2sched = fakeScheduler();
    const m2 = createScheduledMessageManager({
      ...w.deps,
      scheduler: w2sched.scheduler,
    });
    m2.start();
    w2sched.timeouts[0].fn();
    expect(w.enqueueCalls).toHaveLength(2); // the at-least-once duplicate
  });

  it("a backward clock jump delays firing without dropping anything", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    scheduleOk(m);
    w.setNow(FIXED_NOW - HOUR); // clock jumped back below createdAt
    const tick = makeTicker(m, w.sched);
    tick();
    expect(w.enqueueCalls).toHaveLength(0);
    expect(m.listBySender("agent-a")).toHaveLength(1);
    w.setNow(IN_1H + 1);
    tick();
    expect(w.enqueueCalls).toHaveLength(1);
  });
});

describe("load validation / lifecycle", () => {
  it("drops invalid records on load, keeps valid ones", () => {
    const w = makeWorld();
    const valid: ScheduledMessageEntry = {
      id: "sm_00000001",
      senderAgentId: "agent-a",
      senderName: "Alice",
      senderRoomName: "Room 1",
      receiverAgentId: "agent-b",
      text: "kept",
      deliverAt: IN_1H,
      createdAt: FIXED_NOW,
    };
    const m = createScheduledMessageManager({
      ...w.deps,
      persistence: {
        load: () => [
          valid,
          null,
          42,
          { id: "sm_bad" }, // missing fields
          { ...valid, id: "sm_00000002", deliverAt: "soon" }, // wrong type
        ],
        save: (entries) => w.deps.persistence.save(entries),
      },
    });
    expect(m.listBySender("agent-a").map((e) => e.id)).toEqual(["sm_00000001"]);
  });

  it("start registers the initial timeout + interval once; stop clears both", () => {
    const w = makeWorld();
    const m = createScheduledMessageManager(w.deps);
    m.start();
    m.start(); // idempotent
    expect(w.sched.timeouts).toHaveLength(1);
    expect(w.sched.intervals).toHaveLength(1);
    m.stop();
    expect(w.sched.cleared).toEqual({ timeouts: 1, intervals: 1 });
    m.stop(); // idempotent
    expect(w.sched.cleared).toEqual({ timeouts: 1, intervals: 1 });
  });
});

describe("production persistence (temp STATE_ROOT)", () => {
  const file = join(STATE_ROOT, "scheduled-messages.json");

  it("round-trips entries through scheduled-messages.json", () => {
    mkdirSync(STATE_ROOT, { recursive: true });
    const entry: ScheduledMessageEntry = {
      id: "sm_roundtrip",
      senderAgentId: "agent-a",
      senderName: "Alice",
      senderRoomName: "Room 1",
      receiverAgentId: "agent-b",
      text: "persist me",
      deliverAt: IN_1H,
      createdAt: FIXED_NOW,
    };
    saveScheduledMessages([entry]);
    expect(loadScheduledMessagesRaw()).toEqual([entry]);
    saveScheduledMessages([]);
    expect(loadScheduledMessagesRaw()).toEqual([]);
  });

  it("quarantines a corrupt file (renamed aside, never overwritten with [])", () => {
    mkdirSync(STATE_ROOT, { recursive: true });
    writeFileSync(file, "{not json![");
    expect(loadScheduledMessagesRaw()).toEqual([]);
    const quarantined = readdirSync(STATE_ROOT).filter((f) =>
      f.startsWith("scheduled-messages.json.corrupt-"),
    );
    expect(quarantined.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(STATE_ROOT, quarantined[0]), "utf-8")).toContain(
      "not json!",
    );
    // A non-array JSON payload is corrupt too.
    writeFileSync(file, '{"entries":[]}');
    expect(loadScheduledMessagesRaw()).toEqual([]);
  });
});
