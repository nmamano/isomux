import { describe, expect, it } from "bun:test";
import {
  BACKGROUND_MIN_WINDOW,
  BACKGROUND_TARGET_MS,
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
      if (pulled.count >= frames.length)
        return { done: true, value: undefined };
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

  it("closes the socket when Bun drops a frame (send returns 0 for a non-empty frame), and releases the replay", () => {
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
    // An empty frame's 0 is not a drop: the socket stays open.
    const empty = fakeSocket([0]);
    const open = new OfficeOutbox(empty.ws);
    open.send("");
    open.send("next");
    expect(empty.sent).toEqual(["", "next"]);
    expect(empty.state.terminated).toBe(0);
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

// The background lane (task 9ebe887d slice 2): an open_log replay, keyed by
// agent. A live frame never waits behind it: the lane sends only while no live
// frame waits AND Bun holds nothing, because whatever Bun holds goes out before
// the next live frame (256 KB is 5 s at 50 KB/s).
describe("OfficeOutbox background lane", () => {
  it("sends a background frame only while Bun holds nothing; a live frame still goes at once", () => {
    const { ws, sent, state } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    state.buffered = 1;
    const bg = producer(["b1", "b2"]);
    box.sendBackground("x", bg.it);
    s.runAll();
    expect(sent).toEqual([]);
    expect(bg.pulled.count).toBe(0);
    // Bun's buffer is far under the live high-water mark.
    box.send("live");
    expect(sent).toEqual(["live"]);

    state.buffered = 0;
    box.drain();
    s.runAll();
    expect(sent).toEqual(["live", "b1", "b2"]);
  });

  it("live frames queued behind a full Bun buffer all go before the next background frame", () => {
    const { ws, sent, state } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    state.buffered = OUTBOX_HIGH_WATER_BYTES;
    box.sendBackground("x", producer(["b1", "b2"]).it);
    box.send("L1");
    box.send("L2");
    s.runAll();
    expect(sent).toEqual([]);
    // Enabling condition: live frames wait, and they are what liveBacklogged
    // counts.
    expect(box.liveBacklogged).toBe(true);
    state.buffered = 0;
    box.drain();
    s.runAll();
    expect(sent).toEqual(["L1", "L2", "b1", "b2"]);
    expect(box.liveBacklogged).toBe(false);
  });

  it("a live frame sent between two background frames goes before the next one", () => {
    const { ws, sent, state } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    // Each background frame fills Bun until the test empties it.
    const bg = producer(["b1", "b2", "b3"]);
    const it: Iterator<string> = {
      next() {
        const step = bg.it.next();
        if (!step.done) state.buffered = 1;
        return step;
      },
    };
    box.sendBackground("x", it);
    s.runAll();
    expect(sent).toEqual(["b1"]);
    box.send("live");
    state.buffered = 0;
    box.drain();
    s.runAll();
    expect(sent).toEqual(["b1", "live", "b2"]);
  });

  it("puts a front producer ahead of the lane's others", () => {
    const { ws, sent, state } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    state.buffered = 1;
    box.sendBackground("prefetch", producer(["p1", "p2"]).it);
    box.sendBackground("opened", producer(["o1", "o2"]).it, { front: true });
    state.buffered = 0;
    box.drain();
    s.runAll();
    expect(sent).toEqual(["o1", "o2", "p1", "p2"]);
  });

  it("a producer with the same key replaces the pending one, which is released", () => {
    const { ws, sent, state } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    state.buffered = 1;
    const first = producer(["a1", "a2"]);
    const second = producer(["c1"]);
    box.sendBackground("x", first.it);
    box.sendBackground("x", second.it, { front: true });
    expect(first.pulled.returned).toBe(true);
    state.buffered = 0;
    box.drain();
    s.runAll();
    expect(sent).toEqual(["c1"]);
  });

  it("cancelBackground releases one key's producer and keeps the others", () => {
    const { ws, sent, state } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    state.buffered = 1;
    const x = producer(["x1"]);
    const y = producer(["y1"]);
    box.sendBackground("x", x.it);
    box.sendBackground("y", y.it);
    box.cancelBackground("x");
    box.cancelBackground("absent");
    expect(x.pulled.returned).toBe(true);
    expect(y.pulled.returned).toBe(false);
    state.buffered = 0;
    box.drain();
    s.runAll();
    expect(sent).toEqual(["y1"]);
  });

  it("a pending background producer is not a live backlog; dispose releases it", () => {
    const { ws, state } = fakeSocket();
    const s = manualSchedule();
    const box = new OfficeOutbox(ws, { schedule: s.schedule });
    state.buffered = 1;
    const x = producer(["x1"]);
    box.sendBackground("x", x.it);
    expect(box.liveBacklogged).toBe(false);
    box.dispose();
    expect(x.pulled.returned).toBe(true);
  });
});

// Flow control of the background lane (task 9ebe887d): Bun's buffer can be
// empty while the kernel and the network hold megabytes, so the lane also
// counts what it sent and the client has not acked (log_ack). In flight stays
// at most the larger of BACKGROUND_MIN_WINDOW and what the client acked in the
// last BACKGROUND_TARGET_MS; one frame bigger than that goes alone.
describe("OfficeOutbox background window", () => {
  const KB = 1024;
  // Three fit under the floor, a fourth does not.
  const FRAME = 20 * KB;
  const frames = (prefix: string, n: number, size = FRAME) =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`.padEnd(size, "."));
  function rig() {
    const { ws, sent, state } = fakeSocket();
    const s = manualSchedule();
    const clock = { t: 0 };
    const box = new OfficeOutbox(ws, {
      schedule: s.schedule,
      now: () => clock.t,
    });
    const ack = (bytes: number, at: number) => {
      clock.t = at;
      box.ackBackground(bytes);
      s.runAll();
    };
    const names = () => sent.map((f) => f.replace(/\.+$/, ""));
    return { box, sent, state, s, clock, ack, names };
  }

  it("with no ack the lane stops at the floor, and a live frame still goes", () => {
    const { box, sent, s, names } = rig();
    // Enabling condition: the floor holds three frames and not four.
    expect(3 * FRAME).toBeLessThanOrEqual(BACKGROUND_MIN_WINDOW);
    expect(4 * FRAME).toBeGreaterThan(BACKGROUND_MIN_WINDOW);
    box.sendBackground("x", producer(frames("b", 10)).it);
    s.runAll();
    expect(names()).toEqual(["b0", "b1", "b2"]);
    box.send("live");
    s.runAll();
    expect(sent.at(-1)).toBe("live");
    expect(sent).toHaveLength(4);
  });

  it("acks in the last target interval widen the window, and older acks fall out of it", () => {
    const { box, sent, s, ack } = rig();
    box.sendBackground("x", producer(frames("b", 40)).it);
    s.runAll();
    expect(sent).toHaveLength(3);
    ack(3 * FRAME, 100);
    // 60 KB acked in the interval: the floor still rules.
    expect(sent).toHaveLength(6);
    ack(3 * FRAME, 200);
    // 120 KB acked in the interval: six frames in flight.
    expect(sent).toHaveLength(12);
    // Both acks are older than the interval now: the window is the floor
    // again, and 60 KB of the six frames are still in flight.
    ack(3 * FRAME, 200 + BACKGROUND_TARGET_MS + 300);
    expect(sent).toHaveLength(12);
  });

  it("a frame bigger than the window goes only when nothing is in flight", () => {
    const { box, s, ack, names } = rig();
    const big = 100 * KB;
    box.sendBackground(
      "x",
      producer([...frames("big", 2, big), ...frames("small", 1, 10 * KB)]).it,
    );
    s.runAll();
    expect(names()).toEqual(["big0"]);
    ack(big / 2, 10);
    expect(names()).toEqual(["big0"]);
    ack(big / 2, 20);
    expect(names()).toEqual(["big0", "big1"]);
  });

  it("a chat opened while a prefetch waits on the window goes first, and a cancelled producer's frames never go", () => {
    const { box, s, ack, names } = rig();
    const fat = 60 * KB;
    const opened = 10 * KB;
    const prefetch = producer(frames("p", 3, fat));
    box.sendBackground("prefetch", prefetch.it);
    s.runAll();
    expect(names()).toEqual(["p0"]);
    box.sendBackground("opened", producer(frames("o", 2, opened)).it, {
      front: true,
    });
    s.runAll();
    // Enabling condition: the window is full, so the open waits too.
    expect(fat + opened).toBeGreaterThan(BACKGROUND_MIN_WINDOW);
    expect(names()).toEqual(["p0"]);
    ack(fat, 10);
    expect(names()).toEqual(["p0", "o0", "o1"]);

    box.cancelBackground("prefetch");
    expect(prefetch.pulled.returned).toBe(true);
    box.sendBackground("other", producer(frames("y", 1, KB)).it);
    ack(2 * opened, 20);
    expect(names()).toEqual(["p0", "o0", "o1", "y0"]);
  });

  it("ignores an ack that is not a non-negative whole number of bytes", () => {
    const { box, sent, s, ack } = rig();
    box.sendBackground("x", producer(frames("b", 40)).it);
    s.runAll();
    expect(sent).toHaveLength(3);
    for (const bad of [Number.NaN, -5 * KB, Number.POSITIVE_INFINITY, 1.5])
      ack(bad, 1);
    expect(sent).toHaveLength(3);
    // Every bad ack left the count alone: this ack frees all three.
    ack(3 * FRAME, 2);
    expect(sent).toHaveLength(6);
  });

  it("an ack of more than is in flight counts the lane down to zero, not below", () => {
    const { box, sent, s, ack } = rig();
    box.sendBackground("x", producer(frames("b", 3)).it);
    s.runAll();
    expect(sent).toHaveLength(3);
    // All three are out and the lane is empty: the extra has nothing to free.
    ack(10 * 1024 * KB, 100);
    // Past the interval, so the big ack no longer widens the window.
    const later = 100 + BACKGROUND_TARGET_MS + 100;
    ack(0, later);
    box.sendBackground("y", producer(frames("c", 10)).it);
    s.runAll();
    expect(sent).toHaveLength(6);
  });
});
