import { expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const ws = await import("./ws.ts");

// The heartbeat pings every 25 s and gives the pong 5 s. On a slow link the
// pong can wait behind megabytes of replay, so any frame that arrives in the
// grace counts as proof the link is alive (task adeb1267).
// A fake socket starts in CONNECTING, as a real one does; open() moves it to
// OPEN and fires onopen.
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
    failSend = false;
    onopen?: () => void;
    onmessage?: (e: { data: unknown }) => void;
    onclose?: () => void;
    constructor() {
      sockets.push(this);
    }
    send(data: string) {
      if (this.failSend) throw new Error("send on a dead socket");
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
  readyState: number;
  sent: string[];
  failSend: boolean;
  onopen?: () => void;
  onmessage?: (e: { data: unknown }) => void;
  onclose?: () => void;
};

const pings = (s: FakeSocket) =>
  s.sent.filter((d) => JSON.parse(d).type === "ping").length;

function open(s: FakeSocket) {
  s.readyState = 1;
  s.onopen?.();
}

function goOnline() {
  window.dispatchEvent(new Event("online"));
}

it("a frame that arrives during the pong grace keeps the socket", () => {
  withFakeSocket((sockets) => {
    ws.connect(() => {});
    open(sockets[0]);
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
    open(sockets[0]);
    jest.advanceTimersByTime(25_000);
    expect(pings(sockets[0])).toBe(1);
    jest.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(2);
  });
});

// Phone repro (task 0690be6d): the network comes back while the socket is
// closed and waiting out the reconnect backoff, or while a socket opened during
// the outage still hangs in CONNECTING. Either way 'online' opens a new socket
// at once.
for (const [label, lose] of [
  [
    "closed",
    (s: FakeSocket) => {
      open(s);
      s.readyState = 3;
      s.onclose?.();
    },
  ],
  ["still connecting", () => {}],
] as const) {
  it(`'online' with the socket ${label} opens a new socket at once`, () => {
    withFakeSocket((sockets) => {
      ws.connect(() => {});
      lose(sockets[0]);
      jest.advanceTimersByTime(1_000);
      // Enabling condition: nothing has replaced the socket yet.
      expect(sockets).toHaveLength(1);
      goOnline();
      expect(sockets).toHaveLength(2);
      // The pending backoff does not open a third socket on top.
      jest.advanceTimersByTime(2_000);
      expect(sockets).toHaveLength(2);
    });
  });
}

// An open socket may have survived the blip, or may be mid-hydration with the
// banner up; tearing it down would restart the full_state replay. 'online'
// verifies it with a ping instead, the same way a return to the foreground does.
it("'online' with the socket open pings it and keeps it when a frame arrives", () => {
  withFakeSocket((sockets) => {
    ws.connect(() => {});
    open(sockets[0]);
    goOnline();
    expect(sockets).toHaveLength(1);
    expect(pings(sockets[0])).toBe(1);
    jest.advanceTimersByTime(2_000);
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "pong" }) });
    jest.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(1);
  });
});

it("'online' with the socket open replaces it when no frame answers the ping", () => {
  withFakeSocket((sockets) => {
    ws.connect(() => {});
    open(sockets[0]);
    goOnline();
    expect(pings(sockets[0])).toBe(1);
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(4_000);
    expect(sockets).toHaveLength(2);
  });
});

// iOS can keep a socket in CONNECTING for a long time (SYN retries) and fire
// no 'online' at all. About 8 s in CONNECTING replaces it, and the new socket
// gets the same watchdog.
it("a socket that stays in CONNECTING for about 8 s is replaced", () => {
  withFakeSocket((sockets) => {
    ws.connect(() => {});
    jest.advanceTimersByTime(7_000);
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].readyState).toBe(0);
    jest.advanceTimersByTime(9_000);
    expect(sockets).toHaveLength(3);
  });
});

it("a socket that opens before the CONNECTING timeout is kept", () => {
  withFakeSocket((sockets) => {
    ws.connect(() => {});
    jest.advanceTimersByTime(1_000);
    open(sockets[0]);
    jest.advanceTimersByTime(15_000);
    expect(sockets).toHaveLength(1);
  });
});

it("the CONNECTING timeout of a replaced socket does not replace its successor", () => {
  withFakeSocket((sockets) => {
    ws.connect(() => {});
    jest.advanceTimersByTime(5_000);
    goOnline();
    expect(sockets).toHaveLength(2);
    // The first socket's timeout would have fired here.
    jest.advanceTimersByTime(4_000);
    expect(sockets).toHaveLength(2);
    // The second socket's own timeout still runs.
    jest.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(3);
  });
});

// A ping that throws reconnects at once (here on a return to the foreground;
// 'online' runs the same check). A pong grace from the old socket must not
// survive that and then tear down the new, healthy socket.
it("a reconnect drops the old socket's pending pong grace", () => {
  withFakeSocket((sockets) => {
    ws.connect(() => {});
    open(sockets[0]);
    jest.advanceTimersByTime(25_000);
    // Enabling condition: the heartbeat grace (5 s) is pending.
    expect(pings(sockets[0])).toBe(1);
    jest.advanceTimersByTime(1_000);
    sockets[0].failSend = true;
    expect(document.visibilityState).toBe("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sockets).toHaveLength(2);
    open(sockets[1]);
    // The old grace would have expired here.
    jest.advanceTimersByTime(6_000);
    expect(sockets).toHaveLength(2);
  });
});
