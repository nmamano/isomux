// A message queued during a turn that then fails is delivered without a new
// message (task 394d8430; internal-docs/queue-reliability-design.md).
//
// Before: a failed turn left the agent in "error" with the queue kept, and
// only a NEW incoming message started the recovery of an errored agent, so
// the queued message waited with no signal.
//
// Now: a turn that ends in error with a queue starts, once per failure
// streak, the same recovery an incoming message starts. It waits
// RESTART_WAKE_CLEAR_DELAY_MS on the restart-wake clock, so a server stop
// that killed the engine shows first, and it does not run when a usage
// limit stopped the turn (the limit resume owns the delivery).
//
// Seam: the DI manager (createAgentManager + FakeBackend) with an injected
// restart-wake clock, limit-resume clock and serverStopping. Zero LLM calls.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "fs";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import { createAgentManager, type LimitResumeClock } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { loadAgents } from "../persistence.ts";
import { RESTART_WAKE_CLEAR_DELAY_MS } from "../restart-wake.ts";
import {
  FakeBackend,
  type FakeBackendConfig,
  type FakeSession,
} from "./fake-backend.ts";
import type { EventHandler } from "../internal-types.ts";
import type {
  AgentInfo,
  LogEntry,
  QueuedMessage,
  RoomWire,
} from "../../shared/types.ts";

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
});

const activeFakes: FakeBackend[] = [];
afterEach(() => {
  for (const f of activeFakes) f.sessions.forEach((s) => s.close());
  activeFakes.length = 0;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}
// Long enough for a resume or a flush that must not happen to have happened.
const settle = () => sleep(100);

const HOUR = 60 * 60 * 1000;
const rooms: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];
const SENDER: QueuedMessage["sender"] = {
  kind: "agent",
  agentId: "agent-sender",
  agentName: "Sender",
  roomName: "room-a",
};

// advance() runs every timer due by the new time, in order.
function fakeClock() {
  let now = Date.now();
  const timers: { at: number; fn: () => void; done: boolean }[] = [];
  const clock: LimitResumeClock & { advance(ms: number): Promise<void> } = {
    now: () => now,
    setTimeout(fn, ms) {
      const t = { at: now + ms, fn, done: false };
      timers.push(t);
      return t;
    },
    clearTimeout(handle) {
      if (handle) (handle as { done: boolean }).done = true;
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = timers
          .filter((t) => !t.done && t.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.done = true;
        next.fn();
        await sleep(0);
      }
      now = end;
    },
  };
  return clock;
}

function makeHarness(
  cfg: FakeBackendConfig = {},
  opts: { limitResumeOn?: boolean } = {},
) {
  const fake = new FakeBackend({
    ...cfg,
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
      ...cfg.session,
    },
  });
  const clock = fakeClock();
  let stopping = false;
  const logs: LogEntry[] = [];
  const sink: EventHandler = (e) => {
    const ev = e as { type?: string; entry?: LogEntry };
    if (ev.type === "log_entry" && ev.entry) logs.push(ev.entry);
  };
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms }),
    initialRooms: [],
    eventSink: sink,
    restartWakeClock: clock,
    limitResumeClock: clock,
    limitResumeEnabled: () => opts.limitResumeOn ?? true,
    serverStopping: () => stopping,
  });
  mgr.configureAgentTurnDeps();
  activeFakes.push(fake);
  return {
    mgr,
    fake,
    clock,
    logs,
    stop: () => {
      stopping = true;
    },
  };
}
type Harness = ReturnType<typeof makeHarness>;

async function spawn(
  h: Harness,
  agentType: AgentInfo["agentType"] = "claude",
): Promise<AgentInfo> {
  const info = await h.mgr.spawn(
    "Receiver",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
    undefined,
    undefined,
    undefined,
    undefined,
    agentType,
  );
  if (!info) throw new Error("spawn returned null");
  return info;
}

const stateOf = (h: Harness, id: string) => h.mgr.getAgent(id)?.state;
const queueOf = (h: Harness, id: string): string[] =>
  (h.mgr.getAllAgents().find((a) => a.id === id)?.queue ?? []).map(
    (m) => m.text,
  );
// How many times any session of this agent was sent `text`.
const sentCount = (h: Harness, id: string, text: string) =>
  h.fake.sessions
    .filter((s) => s.opts.agentId === id)
    .flatMap((s) => s.sent.map((m) => m.text))
    .filter((t) => t.includes(text)).length;
// Sessions started for this agent: the first one plus each recovery.
const sessionsOf = (h: Harness, id: string) =>
  h.fake.sessions.filter((s) => s.opts.agentId === id).length;
const limitResumeAtOnDisk = (id: string) =>
  loadAgents()
    .flatMap((r) => r.agents)
    .find((a) => a.id === id)?.limitResumeAt;

// A member turn, running.
async function startTurn(
  h: Harness,
  id: string,
  text = "kickoff",
): Promise<FakeSession> {
  void h.mgr.sendMessage(id, text);
  await waitUntil(
    () =>
      stateOf(h, id) === "thinking" &&
      !!h.fake.sessionForAgent(id)?.sent.some((m) => m.text.includes(text)),
    `turn "${text}" running`,
  );
  return h.fake.sessionForAgent(id)!;
}

// An agent message that waits in the queue: the receiver is busy or parked.
function queue(h: Harness, id: string, text: string) {
  const r = h.mgr.enqueueMessage(id, { sender: SENDER, text });
  expect(r).toMatchObject({ ok: true, queued: true });
}

async function failTurn(h: Harness, id: string, session: FakeSession) {
  session.completeTurn({ status: "failed", error: "boom" });
  await waitUntil(() => stateOf(h, id) === "error", "turn failed");
  await settle();
}

// Past the recovery's wait, and long enough for its resume and flush.
async function pastRecoveryWait(h: Harness) {
  await h.clock.advance(RESTART_WAKE_CLEAR_DELAY_MS);
  await settle();
}

describe("a turn that ends in error with a queue", () => {
  it("delivers the queued message after the wait, with no new message", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await startTurn(h, info.id);
    queue(h, info.id, "queued-during-turn");
    await failTurn(h, info.id, session);

    // The enabling state: errored, the message waits, nothing sent yet.
    expect(queueOf(h, info.id)).toEqual(["queued-during-turn"]);
    expect(sentCount(h, info.id, "queued-during-turn")).toBe(0);
    expect(sessionsOf(h, info.id)).toBe(1);

    await pastRecoveryWait(h);
    await waitUntil(
      () => sentCount(h, info.id, "queued-during-turn") === 1,
      "queued message delivered",
    );
    // One recovery: a resume of the same conversation, sent once.
    expect(sessionsOf(h, info.id)).toBe(2);
    const resumed = h.fake.sessionForAgent(info.id)!;
    expect(resumed.isResume).toBe(true);
    expect(resumed.sessionId).toBe(session.sessionId);
    expect(stateOf(h, info.id)).toBe("thinking");
    await settle();
    expect(sentCount(h, info.id, "queued-during-turn")).toBe(1);
  });

  it("waits for the restart-wake delay before it recovers", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await startTurn(h, info.id);
    queue(h, info.id, "queued-during-turn");
    await failTurn(h, info.id, session);

    await h.clock.advance(RESTART_WAKE_CLEAR_DELAY_MS - 1);
    await settle();
    expect(sessionsOf(h, info.id)).toBe(1);
    expect(stateOf(h, info.id)).toBe("error");

    await h.clock.advance(1);
    await waitUntil(
      () => sentCount(h, info.id, "queued-during-turn") === 1,
      "delivered at the delay",
    );
  });

  it("delivers a pushed steer the failed turn never took", async () => {
    const h = makeHarness({
      toolBoundaryDelivery: true,
      session: { steerPush: true },
    });
    const info = await spawn(h, "codex");
    const session = await startTurn(h, info.id);
    expect(
      h.mgr.enqueueMessage(
        info.id,
        { sender: SENDER, text: "urgent" },
        { steer: true },
      ),
    ).toMatchObject({ ok: true, steered: true });
    await waitUntil(() => session.steerCalls.length === 1, "steer pushed");
    // The engine accepted it for the turn, but never recorded it.
    session.steerCalls[0].resolve(true);
    await settle();
    await failTurn(h, info.id, session);

    // The failed turn released it back to the visible queue.
    expect(queueOf(h, info.id)).toEqual(["urgent"]);
    expect(sentCount(h, info.id, "urgent")).toBe(0);

    await pastRecoveryWait(h);
    await waitUntil(
      () => sentCount(h, info.id, "urgent") === 1,
      "steer delivered",
    );
    await settle();
    expect(sentCount(h, info.id, "urgent")).toBe(1);
  });

  it("delivers after a backend error event ends the turn", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await startTurn(h, info.id);
    queue(h, info.id, "queued-during-turn");
    session.push({ kind: "error", message: "kaput" });
    await waitUntil(() => stateOf(h, info.id) === "error", "error event");
    await settle();
    expect(queueOf(h, info.id)).toEqual(["queued-during-turn"]);

    await pastRecoveryWait(h);
    await waitUntil(
      () => sentCount(h, info.id, "queued-during-turn") === 1,
      "delivered",
    );
  });

  it("recovers once per failure streak: a recovered turn that fails again keeps the queue", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const first = await startTurn(h, info.id);
    queue(h, info.id, "A");
    await failTurn(h, info.id, first);
    await pastRecoveryWait(h);
    await waitUntil(
      () =>
        sentCount(h, info.id, "A") === 1 && stateOf(h, info.id) === "thinking",
      "A delivered by the recovery",
    );

    // The recovered turn fails too, with B queued during it.
    const recovered = h.fake.sessionForAgent(info.id)!;
    queue(h, info.id, "B");
    await failTurn(h, info.id, recovered);
    const sessionsBefore = sessionsOf(h, info.id);
    expect(queueOf(h, info.id)).toEqual(["B"]);

    await pastRecoveryWait(h);
    await h.clock.advance(RESTART_WAKE_CLEAR_DELAY_MS);
    await settle();
    expect(stateOf(h, info.id)).toBe("error");
    expect(sessionsOf(h, info.id)).toBe(sessionsBefore);
    expect(sentCount(h, info.id, "B")).toBe(0);
    expect(queueOf(h, info.id)).toEqual(["B"]);

    // A new message still recovers the agent, as before, and takes B along.
    queue(h, info.id, "C");
    await waitUntil(
      () =>
        sentCount(h, info.id, "B") === 1 &&
        sentCount(h, info.id, "C") === 1 &&
        stateOf(h, info.id) === "thinking",
      "a new message recovers",
    );

    // That message started a new streak: its turn fails with D queued, and
    // D is recovered with no other message.
    const byMessage = h.fake.sessionForAgent(info.id)!;
    queue(h, info.id, "D");
    await failTurn(h, info.id, byMessage);
    expect(queueOf(h, info.id)).toEqual(["D"]);
    await pastRecoveryWait(h);
    await waitUntil(
      () => sentCount(h, info.id, "D") === 1,
      "D delivered: the message re-armed the recovery",
    );
  });

  it("a completed turn re-arms the recovery", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const first = await startTurn(h, info.id);
    queue(h, info.id, "A");
    await failTurn(h, info.id, first);
    await pastRecoveryWait(h);
    await waitUntil(
      () =>
        sentCount(h, info.id, "A") === 1 && stateOf(h, info.id) === "thinking",
      "A delivered by the recovery",
    );

    // The recovered turn completes.
    const recovered = h.fake.sessionForAgent(info.id)!;
    recovered.completeTurn();
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "recovered turn completed",
    );

    // A later turn fails with a queue: recovered again.
    const later = await startTurn(h, info.id, "later work");
    expect(later).toBe(recovered);
    queue(h, info.id, "D");
    await failTurn(h, info.id, later);
    const sessionsBefore = sessionsOf(h, info.id);

    await pastRecoveryWait(h);
    await waitUntil(
      () => sentCount(h, info.id, "D") === 1,
      "D delivered by a second recovery",
    );
    expect(sessionsOf(h, info.id)).toBe(sessionsBefore + 1);
  });

  it("starts no recovery when nothing waits", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await startTurn(h, info.id);
    await failTurn(h, info.id, session);
    expect(queueOf(h, info.id)).toEqual([]);

    await pastRecoveryWait(h);
    expect(stateOf(h, info.id)).toBe("error");
    expect(sessionsOf(h, info.id)).toBe(1);
    expect(h.fake.resumeSessionCount).toBe(0);
  });

  it("starts no recovery when the server stops before the wait ends", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await startTurn(h, info.id);
    queue(h, info.id, "queued-during-turn");
    await failTurn(h, info.id, session);
    expect(queueOf(h, info.id)).toEqual(["queued-during-turn"]);

    // The stop shows after the engine died, inside the wait.
    h.stop();
    await pastRecoveryWait(h);
    expect(stateOf(h, info.id)).toBe("error");
    expect(sessionsOf(h, info.id)).toBe(1);
    expect(sentCount(h, info.id, "queued-during-turn")).toBe(0);
    expect(queueOf(h, info.id)).toEqual(["queued-during-turn"]);
  });
});

describe("a turn a usage limit stopped (Codex ends it failed)", () => {
  async function limitStopped(h: Harness, id: string, resetsAtMs: number) {
    const session = await startTurn(h, id);
    queue(h, id, "queued-during-turn");
    session.push({ kind: "usage_limit_stop", resetsAtMs });
    session.push({
      kind: "turn_completed",
      status: "failed",
      error: "You've hit your usage limit.",
    });
    await waitUntil(() => stateOf(h, id) === "error", "limit stop: error");
    await settle();
    return session;
  }

  it("leaves the delivery to the armed limit resume", async () => {
    const h = makeHarness();
    const info = await spawn(h, "codex");
    const reset = h.clock.now() + 5 * HOUR;
    await limitStopped(h, info.id, reset);
    const armed = limitResumeAtOnDisk(info.id);
    expect(typeof armed).toBe("number");

    await pastRecoveryWait(h);
    expect(stateOf(h, info.id)).toBe("error");
    expect(sessionsOf(h, info.id)).toBe(1);
    expect(sentCount(h, info.id, "queued-during-turn")).toBe(0);
    // The limit resume is still armed, for the same time.
    expect(limitResumeAtOnDisk(info.id)).toBe(armed);
  });

  it("does not retry into a limit whose reset time is unknown", async () => {
    const h = makeHarness();
    const info = await spawn(h, "codex");
    const session = await startTurn(h, info.id);
    queue(h, info.id, "queued-during-turn");
    session.push({ kind: "usage_limit_stop" });
    session.push({
      kind: "turn_completed",
      status: "failed",
      error: "You've hit your usage limit.",
    });
    await waitUntil(() => stateOf(h, info.id) === "error", "limit stop");
    await settle();
    // Nothing armed: no reset time to arm it at.
    expect(limitResumeAtOnDisk(info.id) ?? null).toBeNull();

    await pastRecoveryWait(h);
    expect(stateOf(h, info.id)).toBe("error");
    expect(sessionsOf(h, info.id)).toBe(1);
    expect(queueOf(h, info.id)).toEqual(["queued-during-turn"]);
  });

  // OpenCode keeps its refusal as the turn's error line (no limit notice),
  // but the stop is a usage limit all the same.
  for (const limitResumeOn of [true, false])
    it(`opencode, limit resume ${limitResumeOn ? "on" : "off"}: no retry into the limit`, async () => {
      const h = makeHarness({}, { limitResumeOn });
      const info = await spawn(h, "opencode");
      await limitStopped(h, info.id, h.clock.now() + 5 * HOUR);
      expect(typeof limitResumeAtOnDisk(info.id)).toBe(
        limitResumeOn ? "number" : "undefined",
      );

      await pastRecoveryWait(h);
      expect(stateOf(h, info.id)).toBe("error");
      expect(sessionsOf(h, info.id)).toBe(1);
      expect(queueOf(h, info.id)).toEqual(["queued-during-turn"]);
    });

  it("does not retry into the limit when the limit resume is off", async () => {
    const h = makeHarness({}, { limitResumeOn: false });
    const info = await spawn(h, "codex");
    await limitStopped(h, info.id, h.clock.now() + 5 * HOUR);
    // The enabling condition: nothing armed, so only the limit stop itself
    // can keep the recovery away.
    expect(limitResumeAtOnDisk(info.id) ?? null).toBeNull();

    await pastRecoveryWait(h);
    expect(stateOf(h, info.id)).toBe("error");
    expect(sessionsOf(h, info.id)).toBe(1);
    expect(sentCount(h, info.id, "queued-during-turn")).toBe(0);
    expect(queueOf(h, info.id)).toEqual(["queued-during-turn"]);
  });
});

describe("a turn parked on a permission prompt", () => {
  async function parked(h: Harness, id: string) {
    const session = await startTurn(h, id);
    session.push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "ls" },
      title: "Claude wants to use Bash",
    });
    await waitUntil(
      () => h.mgr.getAgent(id)?.pendingPrompt === "permission",
      "parked on a permission prompt",
    );
    // Parked is not busy: the prompt keeps the turn, and the queue waits.
    expect(stateOf(h, id)).toBe("waiting_for_response");
    queue(h, id, "queued-while-parked");
    await settle();
    expect(queueOf(h, id)).toEqual(["queued-while-parked"]);
    return session;
  }

  it("delivers the queue when the parked turn fails", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await parked(h, info.id);
    await failTurn(h, info.id, session);
    expect(queueOf(h, info.id)).toEqual(["queued-while-parked"]);

    await pastRecoveryWait(h);
    await waitUntil(
      () => sentCount(h, info.id, "queued-while-parked") === 1,
      "delivered after the parked turn failed",
    );
  });

  it("delivers the queue when a backend error event ends the parked turn", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await parked(h, info.id);
    session.push({ kind: "error", message: "kaput" });
    await waitUntil(() => stateOf(h, info.id) === "error", "error event");
    await settle();
    expect(queueOf(h, info.id)).toEqual(["queued-while-parked"]);

    await pastRecoveryWait(h);
    await waitUntil(
      () => sentCount(h, info.id, "queued-while-parked") === 1,
      "delivered after the error event",
    );
  });
});

describe("an error that ends no turn starts no recovery", () => {
  it("a flush whose session start fails", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    // The spawned agent has no session yet: the flush starts one.
    expect(sessionsOf(h, info.id)).toBe(0);
    let starts = 0;
    h.fake.createSession = () => {
      starts++;
      throw new Error("spawn failed");
    };
    h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "first" });
    await waitUntil(() => stateOf(h, info.id) === "error", "start failed");
    await settle();
    expect(starts).toBe(1);
    expect(queueOf(h, info.id)).toEqual(["first"]);

    await pastRecoveryWait(h);
    expect(starts).toBe(1);
    expect(h.fake.resumeSessionCount).toBe(0);
    expect(stateOf(h, info.id)).toBe("error");
  });

  it("a resume that fails after a message claimed it", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await startTurn(h, info.id);
    // Errored with an empty queue: no automatic recovery is pending.
    await failTurn(h, info.id, session);
    await pastRecoveryWait(h);
    expect(sessionsOf(h, info.id)).toBe(1);

    let resumes = 0;
    h.fake.resumeSession = () => {
      resumes++;
      throw new Error("resume failed");
    };
    h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "after error" });
    await waitUntil(() => resumes === 1, "the message's resume ran");
    await settle();
    expect(stateOf(h, info.id)).toBe("error");
    expect(queueOf(h, info.id)).toEqual(["after error"]);

    await pastRecoveryWait(h);
    expect(resumes).toBe(1);
    expect(stateOf(h, info.id)).toBe("error");
  });
});

describe("a member's Stop whose in-place interrupt ends the turn failed", () => {
  it("delivers the queue once, through the Stop's own recovery", async () => {
    const h = makeHarness({ session: { abortInPlace: true } });
    const info = await spawn(h, "codex");
    const session = await startTurn(h, info.id);
    queue(h, info.id, "queued-during-turn");

    const stopped = h.mgr.abort(info.id);
    await waitUntil(() => session.abortCount === 1, "interrupt sent");
    // The engine died during the interrupt: a failed turn while aborting.
    session.completeTurn({ status: "failed", error: "exited" });
    await stopped;
    await waitUntil(
      () => sentCount(h, info.id, "queued-during-turn") === 1,
      "delivered after the Stop",
    );
    const sessionsAfterStop = sessionsOf(h, info.id);

    await pastRecoveryWait(h);
    await h.clock.advance(RESTART_WAKE_CLEAR_DELAY_MS);
    await settle();
    expect(sentCount(h, info.id, "queued-during-turn")).toBe(1);
    expect(sessionsOf(h, info.id)).toBe(sessionsAfterStop);
  });

  it("leaves the queue to a Stop whose replacement is still running at the wait's end", async () => {
    // The old session's stream ends only when the test says so: the Stop's
    // replacement waits on it past the recovery's wait.
    const h = makeHarness({
      session: { abortInPlace: true, hangOnClose: true },
    });
    const info = await spawn(h, "codex");
    const session = await startTurn(h, info.id);
    queue(h, info.id, "queued-during-turn");

    const stopped = h.mgr.abort(info.id);
    await waitUntil(() => session.abortCount === 1, "interrupt sent");
    session.completeTurn({ status: "failed", error: "exited" });
    await waitUntil(() => session.closed, "the Stop replaces the session");
    // The enabling state: errored, the Stop still running, the queue waiting.
    expect(stateOf(h, info.id)).toBe("error");
    expect(queueOf(h, info.id)).toEqual(["queued-during-turn"]);

    await pastRecoveryWait(h);
    session.endStream();
    await stopped;
    await waitUntil(
      () => sentCount(h, info.id, "queued-during-turn") === 1,
      "delivered after the Stop",
    );
    await settle();
    // The first session and the Stop's replacement: no recovery of its own.
    expect(sessionsOf(h, info.id)).toBe(2);
    expect(sentCount(h, info.id, "queued-during-turn")).toBe(1);
  });
});
