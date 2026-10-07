import { describe, expect, it } from "bun:test";
import {
  OfficeOutbox,
  OUTBOX_HIGH_WATER_BYTES,
  OUTBOX_MAX_QUEUED_BYTES,
  OUTBOX_PUMP_BUDGET_BYTES,
  type OutboxSocket,
} from "./office-ws-outbox.ts";

// A socket whose Bun-side buffer the test sets by hand. `replies` scripts the
// send() return values in order; past the script every send returns its length.
function fakeSocket(replies: number[] = []) {
  const sent: string[] = [];
  const state = { buffered: 0, terminated: 0, throwOnSend: false };
  const ws: OutboxSocket = {
    send(data) {
      if (state.throwOnSend) throw new Error("closed");
      sent.push(data);
      return replies.length > 0 ? replies.shift()! : data.length;
    },
    getBufferedAmount: () => state.buffered,
    terminate() {
      state.terminated++;
    },
  };
  return { ws, sent, state };
}

// A scheduler the test runs by hand, so "later" is observable.
function manualSchedule() {
  const tasks: (() => void)[] = [];
  return {
    schedule: (run: () => void) => void tasks.push(run),
    pending: () => tasks.length,
    runAll() {
      while (tasks.length > 0) tasks.shift()!();
    },
  };
}

// A producer that records how many frames were pulled from it.
function producer(frames: string[]) {
  const pulled = { count: 0, returned: false };
  const it: Iterator<string> = {
    next() {
      if (pulled.count >= frames.length) return { done: true, value: undefined };
      return { done: false, value: frames[pulled.count++] };
    },
    return() {
      pulled.returned = true;
      return { done: true, value: undefined };
    },
  };
  return { it, pulled };
}

describe("OfficeOutbox", () => {
  it("sends at once while Bun has room and nothing waits", () => {
    const { ws, sent } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    box.send("a");
    box.send("b");
    expect(sent).toEqual(["a", "b"]);
    expect(box.backlogged).toBe(false);
    expect(s.pending()).toBe(0);
  });

  it("holds frames while Bun's buffer is at the high-water mark and sends them in order after a drain, never inside it", () => {
    const { ws, sent, state } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    state.buffered = OUTBOX_HIGH_WATER_BYTES;
    box.send("a");
    box.send("b");
    s.runAll();
    expect(sent).toEqual([]);
    expect(box.backlogged).toBe(true);
    state.buffered = 0;
    box.drain();
    // Inside the drain callback nothing is sent (Bun 1.3.11 can lose later
    // drain events after a send made there).
    expect(sent).toEqual([]);
    s.runAll();
    expect(sent).toEqual(["a", "b"]);
    expect(box.backlogged).toBe(false);
  });

  it("counts a -1 (Bun queued it) as sent exactly once and resumes with the next frame", () => {
    const { ws, sent, state } = fakeSocket([-1]);
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    box.send("a");
    state.buffered = OUTBOX_HIGH_WATER_BYTES;
    box.send("b");
    state.buffered = 0;
    box.drain();
    s.runAll();
    expect(sent).toEqual(["a", "b"]);
    expect(state.terminated).toBe(0);
  });

  it("pulls a lazy replay only as the socket takes it, and queues live frames behind its last frame", () => {
    const { ws, sent, state } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    const replay = producer(["r1", "r2", "r3", "fence"]);
    state.buffered = OUTBOX_HIGH_WATER_BYTES;
    box.sendLazy(replay.it);
    box.send("live1");
    expect(replay.pulled.count).toBe(0);
    state.buffered = 0;
    // Bun takes one frame, then is full again.
    const realSend = ws.send.bind(ws);
    ws.send = (data) => {
      const r = realSend(data);
      state.buffered = OUTBOX_HIGH_WATER_BYTES;
      return r;
    };
    box.drain();
    s.runAll();
    expect(sent).toEqual(["r1"]);
    expect(replay.pulled.count).toBe(1);
    ws.send = realSend;
    state.buffered = 0;
    box.drain();
    s.runAll();
    expect(sent).toEqual(["r1", "r2", "r3", "fence", "live1"]);
    expect(box.backlogged).toBe(false);
  });

  it("closes the socket when Bun drops a frame (send returns 0), and releases the replay", () => {
    const { ws, sent, state } = fakeSocket([5, 0]);
    const s = manualSchedule();
    const reasons: string[] = [];
    const box = new OfficeOutbox(ws, {
      schedule: s.schedule,
      onFail: (r) => reasons.push(r),
    });
    const replay = producer(["r1", "r2", "r3"]);
    box.sendLazy(replay.it);
    expect(sent).toEqual(["r1", "r2"]);
    expect(state.terminated).toBe(1);
    expect(reasons).toEqual(["dropped"]);
    expect(replay.pulled.returned).toBe(true);
    box.send("late");
    s.runAll();
    expect(sent).toEqual(["r1", "r2"]);
  });

  it("does not treat an empty frame's 0 as a drop", () => {
    const { ws, state } = fakeSocket([0]);
    const box = new OfficeOutbox(ws);
    box.send("");
    expect(state.terminated).toBe(0);
  });

  it("closes the socket when send throws", () => {
    const { ws, state } = fakeSocket();
    const reasons: string[] = [];
    const box = new OfficeOutbox(ws, { onFail: (r) => reasons.push(r) });
    state.throwOnSend = true;
    box.send("a");
    expect(state.terminated).toBe(1);
    expect(reasons).toEqual(["threw"]);
  });

  it("closes the socket when queued live frames pass the sanity bound", () => {
    const { ws, state } = fakeSocket();
    const s = manualSchedule();
    const reasons: string[] = [];
    const box = new OfficeOutbox(ws, {
      schedule: s.schedule,
      onFail: (r) => reasons.push(r),
    });
    state.buffered = OUTBOX_HIGH_WATER_BYTES;
    const chunk = "x".repeat(1024 * 1024);
    const fit = Math.floor(OUTBOX_MAX_QUEUED_BYTES / chunk.length);
    for (let i = 0; i < fit; i++) box.send(chunk);
    expect(state.terminated).toBe(0);
    box.send(chunk);
    expect(state.terminated).toBe(1);
    expect(reasons).toEqual(["overflow"]);
    expect(box.backlogged).toBe(false);
  });

  it("yields the event loop after a pump budget even when Bun keeps taking frames", () => {
    const { ws, sent } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    const frame = "x".repeat(1024 * 1024);
    const perPump = OUTBOX_PUMP_BUDGET_BYTES / frame.length;
    const replay = producer(Array.from({ length: perPump + 2 }, () => frame));
    box.sendLazy(replay.it);
    expect(sent).toHaveLength(perPump);
    expect(s.pending()).toBe(1);
    s.runAll();
    expect(sent).toHaveLength(perPump + 2);
  });

  it("a pump scheduled before the socket closed sends nothing when it runs", () => {
    const { ws, sent, state } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    state.buffered = OUTBOX_HIGH_WATER_BYTES;
    box.send("a");
    state.buffered = 0;
    box.drain();
    // Enabling condition: the pump is scheduled and would send "a".
    expect(s.pending()).toBe(1);
    box.dispose();
    s.runAll();
    expect(sent).toEqual([]);
  });

  it("dispose releases the queue and the replay, and later frames are ignored", () => {
    const { ws, sent, state } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    state.buffered = OUTBOX_HIGH_WATER_BYTES;
    const replay = producer(["r1"]);
    box.sendLazy(replay.it);
    box.send("live");
    box.dispose();
    expect(replay.pulled.returned).toBe(true);
    expect(box.backlogged).toBe(false);
    state.buffered = 0;
    box.drain();
    box.send("after");
    s.runAll();
    expect(sent).toEqual([]);
  });
});
