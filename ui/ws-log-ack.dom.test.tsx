// The client side of the background lane's flow control (task 9ebe887d):
// ws.ts counts the raw length of every lane frame it receives (a replay frame
// with its request id, or a log_open_done that is not a refusal) and sends
// log_ack per LOG_ACK_BYTES and at each lane log_open_done. It counts before
// the store sees the frame, so a frame the store drops as stale is acked too;
// a frame never acked would hold the server's lane for good. The server side
// is in server/office-ws-outbox.test.ts and office-ws-replay.test.ts.

import { expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const ws = await import("./ws.ts");
const { LOG_ACK_BYTES } = await import("../shared/log-stream.ts");

type FakeSocket = {
  readyState: number;
  sent: string[];
  onopen?: () => void;
  onmessage?: (e: { data: unknown }) => void;
};

function withFakeSocket(run: (sockets: FakeSocket[]) => void) {
  const original = globalThis.WebSocket;
  const sockets: FakeSocket[] = [];
  class Fake {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    binaryType = "blob";
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (e: { data: unknown }) => void;
    onclose?: () => void;
    constructor(public url: string) {
      sockets.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {}
  }
  globalThis.WebSocket = Fake as unknown as typeof WebSocket;
  ws.setShim(null);
  jest.useFakeTimers();
  try {
    run(sockets);
  } finally {
    jest.useRealTimers();
    ws.setShim(() => {});
    globalThis.WebSocket = original;
  }
}

function open(s: FakeSocket) {
  s.readyState = 1;
  s.onopen?.();
}

// Deliver one raw frame and return its length, the unit of the ack.
function deliver(s: FakeSocket, msg: object): number {
  const data = JSON.stringify(msg);
  s.onmessage?.({ data });
  return data.length;
}

const entry = (requestId: string | undefined, size: number) => ({
  type: "log_entry",
  entry: {
    id: `e${size}`,
    agentId: "a1",
    kind: "text",
    content: "x".repeat(size),
    timestamp: 1,
  },
  ...(requestId !== undefined ? { requestId } : {}),
});

const acks = (s: FakeSocket) =>
  s.sent
    .map((d) => JSON.parse(d) as { type: string; bytes?: number })
    .filter((c) => c.type === "log_ack")
    .map((c) => c.bytes);

// A third of the ack step, so three frames cross it and two do not.
const THIRD = Math.floor(LOG_ACK_BYTES / 3);

it("acks the lane bytes once a step has come, frames of any request included, and does not count a live entry", () => {
  withFakeSocket((sockets) => {
    // The handler keeps nothing: the count must not depend on the store.
    ws.connect(() => {});
    const s = sockets[0];
    open(s);
    const first = deliver(s, entry("no-such-request", THIRD));
    deliver(s, entry(undefined, 2 * LOG_ACK_BYTES));
    const second = deliver(s, entry("no-such-request", THIRD));
    // Enabling condition: two lane frames are under the step, three over it.
    expect(first + second).toBeLessThan(LOG_ACK_BYTES);
    expect(acks(s)).toEqual([]);
    const third = deliver(s, entry("other-request", THIRD));
    expect(acks(s)).toEqual([first + second + third]);
  });
});

it("acks at a lane log_open_done, counts the replayed commands, and a refusal is not a lane frame", () => {
  withFakeSocket((sockets) => {
    ws.connect(() => {});
    const s = sockets[0];
    open(s);
    const e = deliver(s, entry("r1", 100));
    const cmds = deliver(s, {
      type: "slash_commands",
      agentId: "a1",
      commands: [{ name: "help" }],
      skills: [],
      requestId: "r1",
    });
    deliver(s, {
      type: "log_open_done",
      agentId: "a2",
      requestId: "r2",
      refused: true,
    });
    expect(acks(s)).toEqual([]);
    const done = deliver(s, {
      type: "log_open_done",
      agentId: "a1",
      requestId: "r1",
    });
    expect(acks(s)).toEqual([e + cmds + done]);
  });
});

it("a new socket counts from zero, and the old socket's late frames count for nothing", () => {
  withFakeSocket((sockets) => {
    ws.connect(() => {});
    const old = sockets[0];
    open(old);
    deliver(old, entry("r1", 2 * THIRD));
    ws.connect(() => {});
    const next = sockets[1];
    open(next);
    // A late frame of the old socket, after the reconnect.
    deliver(old, entry("r1", 2 * THIRD));
    const a = deliver(next, entry("r2", THIRD));
    expect(acks(old)).toEqual([]);
    expect(acks(next)).toEqual([]);
    const b = deliver(next, entry("r2", THIRD));
    const c = deliver(next, entry("r2", THIRD));
    expect(acks(next)).toEqual([a + b + c]);
    expect(acks(old)).toEqual([]);
  });
});
