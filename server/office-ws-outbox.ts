// The ordered outbound queue of one office browser socket (task adeb1267).
//
// Bun's ServerWebSocket.send() queues what the kernel does not take, and past
// its own backpressure limit (16 MB) it DROPS the frame and returns 0. The
// connect replay sends every visible transcript in one burst, so a big office
// or a slow link lost the tail of the history and the replay fence. This
// queue keeps Bun's own buffer under OUTBOX_HIGH_WATER_BYTES and holds the
// rest here, in order, until the socket drains.
//
// Measured on Bun 1.3.11 (2026-10-07): send() returns a byte count when the
// kernel took the frame, -1 when Bun queued it, and 0 when Bun dropped it. A
// send made INSIDE the drain callback can stop later drain events, which
// leaves the last frame in Bun's buffer until the next send. So drain only
// schedules the pump, and the pump runs on a later tick.
//
// The replay is a lazy producer, not a list of strings: it serializes one
// frame at a time as the socket drains, so a socket's memory does not grow
// with the office's history. Live frames sent while it runs wait behind it,
// so the client sees the same order as before: the whole replay, its fence,
// then the live frames.
//
// A socket that loads chats when they open (task 9ebe887d) has no connect
// replay; each open_log replay runs in a background lane instead. The lane
// sends only while no live frame waits and Bun holds nothing, so live frames
// (and the chat the member just opened, which goes to the lane's front)
// never wait behind a background load in Bun's buffer. Bytes that left Bun
// can still wait in the kernel, a proxy or the network, so the lane also has
// a window: the client acks the lane frames it received (log_ack), and the
// lane keeps at most the window sent and not acked (BACKGROUND_MIN_WINDOW).
//
// LEAF: no office imports, so the queue is unit-testable with a fake socket.

// What Bun may hold for this socket before the pump waits for a drain. Low,
// because a frame that bypasses the queue (the heartbeat pong) waits behind
// it on the wire.
export const OUTBOX_HIGH_WATER_BYTES = 256 * 1024;
// What one pump run may send before it yields the event loop to other work,
// for a reader fast enough that Bun's buffer never fills.
export const OUTBOX_PUMP_BUDGET_BYTES = 4 * 1024 * 1024;
// Sanity bound on queued live frames: past it the client is not reading, and
// the socket closes so the client reconnects to a fresh replay.
export const OUTBOX_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
// Flow control of the background lane (task 9ebe887d): the lane keeps in
// flight (sent, not acked by the client's log_ack) at most the larger of
// BACKGROUND_MIN_WINDOW and the bytes the client acked in the last
// BACKGROUND_TARGET_MS. So a live frame or a chat the member opens waits at
// most about BACKGROUND_TARGET_MS behind background bytes in the kernel and
// the network, and a fast link is not capped. Live frames ignore the window.
export const BACKGROUND_MIN_WINDOW = 64 * 1024;
export const BACKGROUND_TARGET_MS = 500;

export interface OutboxSocket {
  send(data: string): number;
  getBufferedAmount(): number;
  terminate(): void;
}

export interface OutboxOptions {
  // Runs the pump on a later tick. Tests pass a manual scheduler.
  schedule?: (run: () => void) => void;
  // The clock of the lane's window. Tests pass a manual clock.
  now?: () => number;
  // Called once when the queue closes the socket, with the reason.
  onFail?: (reason: "dropped" | "threw" | "overflow") => void;
}

type Item =
  { kind: "frame"; data: string } | { kind: "replay"; next: Iterator<string> };

export class OfficeOutbox {
  private readonly items: Item[] = [];
  // The background lane: open_log replays, keyed by agent, in send order.
  // held: a frame pulled from the producer that did not fit the window. It
  // goes first when the window opens, and is dropped with its producer.
  private readonly background: {
    key: string;
    next: Iterator<string>;
    held?: string;
  }[] = [];
  // Lane bytes sent and not acked, and the recent acks (time, bytes) that
  // size the window.
  private inFlight = 0;
  private readonly acks: { at: number; bytes: number }[] = [];
  private readonly now: () => number;
  private queuedBytes = 0;
  private scheduled = false;
  private disposed = false;
  private readonly schedule: (run: () => void) => void;

  constructor(
    private readonly ws: OutboxSocket,
    private readonly options: OutboxOptions = {},
  ) {
    this.schedule = options.schedule ?? ((run) => void setTimeout(run, 0));
    this.now = options.now ?? Date.now;
  }

  // True while frames wait here for the socket.
  get backlogged(): boolean {
    return this.items.length > 0 || this.background.length > 0;
  }

  send(data: string): void {
    if (this.disposed) return;
    if (this.items.length === 0 && this.room()) {
      this.write(data);
      return;
    }
    this.queuedBytes += data.length;
    if (this.queuedBytes > OUTBOX_MAX_QUEUED_BYTES) {
      this.fail("overflow");
      return;
    }
    this.items.push({ kind: "frame", data });
    this.later();
  }

  // Queue a lazily produced run of frames (the connect replay). Frames sent
  // after this call go out after the producer's last frame.
  sendLazy(frames: Iterator<string>): void {
    if (this.disposed) return;
    this.items.push({ kind: "replay", next: frames });
    if (this.items.length === 1) this.pump();
    else this.later();
  }

  // The background lane (task 9ebe887d slice 2): an open_log replay, keyed by
  // agent id. It sends only while no live frame waits and Bun holds nothing,
  // so a live frame never waits behind it. front: ahead of the lane's other
  // producers (a chat the member opened, ahead of prefetches). A producer
  // with the same key is cancelled first.
  sendBackground(
    key: string,
    frames: Iterator<string>,
    opts: { front?: boolean } = {},
  ): void {
    if (this.disposed) {
      frames.return?.();
      return;
    }
    this.cancelBackground(key);
    const item = { key, next: frames };
    if (opts.front) this.background.unshift(item);
    else this.background.push(item);
    this.later();
  }

  // The client's log_ack: `bytes` of lane frames arrived. In flight clamps at
  // 0. A frame bigger than the window goes only when nothing is in flight.
  ackBackground(bytes: number): void {
    if (this.disposed || !Number.isSafeInteger(bytes) || bytes < 0) return;
    const freed = Math.min(bytes, this.inFlight);
    this.inFlight -= freed;
    this.acks.push({ at: this.now(), bytes: freed });
    this.later();
  }

  // Cancel the background producer with this key, if any.
  cancelBackground(key: string): void {
    const at = this.background.findIndex((item) => item.key === key);
    if (at === -1) return;
    const [item] = this.background.splice(at, 1);
    item.next.return?.();
  }

  // True while LIVE frames (not the background lane) wait here.
  get liveBacklogged(): boolean {
    return this.items.length > 0;
  }

  // Bun's drain callback. Never sends from inside it (see the file header).
  drain(): void {
    this.later();
  }

  // The socket closed: release the producer and the queued frames.
  dispose(): void {
    this.disposed = true;
    for (const item of this.items) {
      if (item.kind === "replay") item.next.return?.();
    }
    for (const item of this.background) item.next.return?.();
    this.items.length = 0;
    this.background.length = 0;
    this.queuedBytes = 0;
    this.acks.length = 0;
  }

  private room(): boolean {
    return this.ws.getBufferedAmount() < OUTBOX_HIGH_WATER_BYTES;
  }

  private later(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    let budget = OUTBOX_PUMP_BUDGET_BYTES;
    while (
      !this.disposed &&
      (this.items.length > 0 || this.background.length > 0)
    ) {
      // A background frame goes only while no live frame waits and Bun holds
      // nothing: what Bun holds goes out before the next live frame.
      const live = this.items.length > 0;
      // Bun's buffer is full (or not empty, for the lane): its drain
      // callback resumes the pump.
      if (live ? !this.room() : this.ws.getBufferedAmount() > 0) return;
      if (budget <= 0) {
        this.later();
        return;
      }
      let data: string | null;
      try {
        data = live ? this.take() : this.takeBackground();
      } catch {
        this.fail("threw");
        return;
      }
      if (data === null) continue;
      if (!live) {
        // The window is full: an ack resumes the pump.
        if (!this.fits(data.length)) {
          this.background[0].held = data;
          return;
        }
        this.inFlight += data.length;
      }
      budget -= data.length;
      this.write(data);
    }
  }

  // Whether a lane frame of `bytes` fits the window: in flight stays at most
  // the window, or nothing is in flight (a frame bigger than the window).
  private fits(bytes: number): boolean {
    const since = this.now() - BACKGROUND_TARGET_MS;
    while (this.acks.length > 0 && this.acks[0].at <= since) this.acks.shift();
    if (this.inFlight === 0) return true;
    let acked = 0;
    for (const ack of this.acks) acked += ack.bytes;
    return this.inFlight + bytes <= Math.max(BACKGROUND_MIN_WINDOW, acked);
  }

  // The lane's next frame (a held one first), or null when its head
  // producer finished.
  private takeBackground(): string | null {
    const head = this.background[0];
    if (head.held !== undefined) {
      const held = head.held;
      head.held = undefined;
      return held;
    }
    const step = head.next.next();
    if (step.done) {
      this.background.shift();
      return null;
    }
    return step.value;
  }

  // The next frame in order, or null when a finished producer was removed.
  private take(): string | null {
    const head = this.items[0];
    if (head.kind === "frame") {
      this.items.shift();
      this.queuedBytes -= head.data.length;
      return head.data;
    }
    const step = head.next.next();
    if (step.done) {
      this.items.shift();
      return null;
    }
    return step.value;
  }

  // -1 (Bun queued it) counts as sent. 0 for a non-empty frame is a drop: a
  // hole in the stream, so the socket closes and the client re-syncs.
  private write(data: string): void {
    let written: number;
    try {
      written = this.ws.send(data);
    } catch {
      this.fail("threw");
      return;
    }
    if (written === 0 && data.length > 0) this.fail("dropped");
  }

  private fail(reason: "dropped" | "threw" | "overflow"): void {
    if (this.disposed) return;
    this.dispose();
    this.options.onFail?.(reason);
    try {
      this.ws.terminate();
    } catch {}
  }
}
