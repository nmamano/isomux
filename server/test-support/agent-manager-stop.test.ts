// What a stopped agent manager still writes (task 7a54c6a3). stop() is for a
// server stopped in a process that boots another (the test harness, the next
// test file): the stopped manager's late events must not write transcripts
// over the next office's state. Seam: the DI manager (createAgentManager +
// FakeBackend) with an injected clock for the death-line hold
// (RESTART_WAKE_CLEAR_DELAY_MS). Transcripts are read from disk with loadLog.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import { createAgentManager, type LimitResumeClock } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { loadLog } from "../persistence.ts";
import { FakeBackend } from "./fake-backend.ts";
import { RESTART_WAKE_CLEAR_DELAY_MS } from "../restart-wake.ts";
import type { EventHandler } from "../internal-types.ts";
import type { LogEntry, RoomWire } from "../../shared/types.ts";

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
  const deadline = Date.now() + 3000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

const rooms: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];

// The hold's clock. advance() runs every timer due by the new time.
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

function makeHarness() {
  const fake = new FakeBackend();
  const clock = fakeClock();
  const events: LogEntry[] = [];
  const sink: EventHandler = (e) => {
    const ev = e as { type?: string; entry?: LogEntry };
    if (ev.type === "log_entry" && ev.entry) events.push(ev.entry);
  };
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms }),
    initialRooms: [],
    eventSink: sink,
    restartWakeClock: clock,
    turnsInFlightFile: join(STATE_ROOT, "agent-manager-stop-turns.json"),
    serverStopping: () => false,
  });
  mgr.configureAgentTurnDeps();
  activeFakes.push(fake);
  return { mgr, fake, clock, events };
}
type Harness = ReturnType<typeof makeHarness>;

async function spawn(h: Harness) {
  const info = await h.mgr.spawn(
    "Worker",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
  );
  if (!info) throw new Error("spawn returned null");
  return info;
}

const busy = (h: Harness, id: string) => {
  const s = h.mgr.getAgent(id)?.state;
  return s === "thinking" || s === "tool_executing";
};

// A member turn, running in the agent's session.
async function runningTurn(h: Harness, id: string) {
  void h.mgr.sendMessage(id, "work");
  await waitUntil(() => busy(h, id), "turn running");
  const session = h.fake.sessionForAgent(id)!;
  return session;
}

// The transcript on disk of the agent's session.
const onDisk = (id: string, sessionId: string) => loadLog(id, sessionId);
// The error lines the live view got.
const errorEvents = (h: Harness) =>
  h.events.filter((e) => e.kind === "error").length;
const errorsOnDisk = (id: string, sessionId: string) =>
  onDisk(id, sessionId).filter((e) => e.kind === "error").length;

describe("a session that ends mid-turn", () => {
  // The session closes as a test file's afterEach closes it. The death line
  // could be a server stop, so it waits RESTART_WAKE_CLEAR_DELAY_MS.
  async function cutMidTurn(h: Harness, id: string) {
    const session = h.fake.sessionForAgent(id)!;
    session.close();
    await waitUntil(() => !busy(h, id), "turn cut");
    return session;
  }

  it("with no stop, writes its line to the transcript after the hold", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await runningTurn(h, info.id);
    await cutMidTurn(h, info.id);
    expect(errorsOnDisk(info.id, session.sessionId)).toBe(0);
    await h.clock.advance(RESTART_WAKE_CLEAR_DELAY_MS);
    await sleep(50);
    expect(errorsOnDisk(info.id, session.sessionId)).toBe(1);
    expect(errorEvents(h)).toBe(1);
  });

  it("after the manager stops, writes no line", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await runningTurn(h, info.id);
    h.mgr.stop();
    await cutMidTurn(h, info.id);
    expect(errorsOnDisk(info.id, session.sessionId)).toBe(0);
    await h.clock.advance(RESTART_WAKE_CLEAR_DELAY_MS);
    await sleep(50);
    expect(errorsOnDisk(info.id, session.sessionId)).toBe(0);
    // A stopped manager holds no line, so the live view gets none either.
    expect(errorEvents(h)).toBe(0);
  });

  it("when the manager stops during the hold, writes no line and recreates no folder", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await runningTurn(h, info.id);
    await cutMidTurn(h, info.id);
    // The hold is pending: nothing written yet.
    expect(errorsOnDisk(info.id, session.sessionId)).toBe(0);
    h.mgr.stop();
    // The next test file wipes the state, as the gate's one process does.
    removeStateDir(STATE_ROOT);
    mkdirSync(STATE_ROOT, { recursive: true });
    await h.clock.advance(RESTART_WAKE_CLEAR_DELAY_MS);
    await sleep(50);
    expect(onDisk(info.id, session.sessionId).length).toBe(0);
    // stop() drops the held line: the live view gets none either.
    expect(errorEvents(h)).toBe(0);
  });
});

// The preload's stop of a manager a test made (createAgentManager registers
// it): the first case leaves a turn running, and this file's afterEach closes
// its session mid-turn, as the files that leaked did. The second case reads
// what the first left, so the two run in order, as a whole describe.
describe("a manager the previous test made", () => {
  let left: { h: Harness; id: string; sessionId: string } | undefined;

  it("leaves a turn running", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const session = await runningTurn(h, info.id);
    left = { h, id: info.id, sessionId: session.sessionId };
  });

  it("writes nothing into the next test's state", async () => {
    if (!left) throw new Error("run the whole describe, in order");
    const { h, id, sessionId } = left;
    // The session ended mid-turn (this file's afterEach closed it).
    await waitUntil(() => !busy(h, id), "previous turn cut");
    // This test's beforeEach wiped the state.
    expect(onDisk(id, sessionId).length).toBe(0);
    await h.clock.advance(RESTART_WAKE_CLEAR_DELAY_MS);
    await sleep(50);
    expect(onDisk(id, sessionId).length).toBe(0);
  });
});

describe("a log entry after the manager stops", () => {
  // An agent idle after one turn: its session has an id, so entries go to
  // the transcript at once.
  async function idleWithSession(h: Harness) {
    const info = await spawn(h);
    const session = await runningTurn(h, info.id);
    session.completeTurn({ text: "done" });
    await waitUntil(() => !busy(h, info.id), "turn ended");
    return { info, sessionId: session.sessionId };
  }
  const notes = (entries: LogEntry[], text: string) =>
    entries.filter((e) => e.kind === "system" && e.content === text).length;

  it("reaches the live view but not the transcript", async () => {
    const h = makeHarness();
    const { info, sessionId } = await idleWithSession(h);
    // Before the stop, a note is written: the transcript path is live.
    expect(h.mgr.addSystemNote(info.id, "before stop")).toBe(true);
    expect(notes(onDisk(info.id, sessionId), "before stop")).toBe(1);

    h.mgr.stop();
    expect(h.mgr.addSystemNote(info.id, "after stop")).toBe(true);
    expect(notes(h.events, "after stop")).toBe(1);
    expect(notes(h.mgr.getAgentLogs(info.id), "after stop")).toBe(1);
    expect(notes(onDisk(info.id, sessionId), "after stop")).toBe(0);
  });

  it("a member message is accepted, shown, and not written", async () => {
    const h = makeHarness();
    const { info, sessionId } = await idleWithSession(h);
    const before = onDisk(info.id, sessionId).filter(
      (e) => e.kind === "user_message",
    ).length;
    // The first turn's message is on disk: the durable write path is live.
    expect(before).toBe(1);

    h.mgr.stop();
    const accepted = await new Promise<unknown>((resolve) => {
      void h.mgr.sendMessage(
        info.id,
        "after stop",
        undefined,
        undefined,
        undefined,
        { onAccepted: resolve },
      );
    });
    expect(accepted).toMatchObject({ ok: true });
    const shown = (entries: LogEntry[]) =>
      entries.filter(
        (e) => e.kind === "user_message" && e.content === "after stop",
      ).length;
    expect(shown(h.events)).toBe(1);
    expect(shown(onDisk(info.id, sessionId))).toBe(0);
  });
});
