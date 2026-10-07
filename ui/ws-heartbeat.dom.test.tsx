import { expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const ws = await import("./ws.ts");

// The heartbeat pings every 25 s and gives the pong 5 s. On a slow link the
// pong can wait behind megabytes of replay, so any frame that arrives in the
// grace counts as proof the link is alive (task adeb1267).
function withFakeSocket(run: (sockets: FakeSocket[]) => void) {
  const original = globalThis.WebSocket;
  const sockets: FakeSocket[] = [];
  class Fake {
    static OPEN = 1;
    readyState = 1;
    binaryType = "blob";
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (e: { data: unknown }) => void;
    onclose?: () => void;
    constructor() {
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
type FakeSocket = {
  sent: string[];
  onopen?: () => void;
  onmessage?: (e: { data: unknown }) => void;
};

const pings = (s: FakeSocket) =>
  s.sent.filter((d) => JSON.parse(d).type === "ping").length;

it("a frame that arrives during the pong grace keeps the socket", () => {
  withFakeSocket((sockets) => {
    ws.connect(() => {});
    sockets[0].onopen?.();
    jest.advanceTimersByTime(25_000);
    // Enabling condition: the heartbeat pinged and now waits for an answer.
    expect(pings(sockets[0])).toBe(1);
    jest.advanceTimersByTime(4_000);
    sockets[0].onmessage?.({
      data: JSON.stringify({ type: "log_entry", entry: { id: "x" } }),
    });
    jest.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(1);
  });
});

it("with no frame at all during the grace, the socket is replaced", () => {
  withFakeSocket((sockets) => {
    ws.connect(() => {});
    sockets[0].onopen?.();
    jest.advanceTimersByTime(25_000);
    expect(pings(sockets[0])).toBe(1);
    jest.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(2);
  });
});
