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

export interface OutboxSocket {
  send(data: string): number;
  getBufferedAmount(): number;
  terminate(): void;
}

export interface OutboxOptions {
  // Runs the pump on a later tick. Tests pass a manual scheduler.
  schedule?: (run: () => void) => void;
  // Called once when the queue closes the socket, with the reason.
  onFail?: (reason: "dropped" | "threw" | "overflow") => void;
}

type Item =
  | { kind: "frame"; data: string }
  | { kind: "replay"; next: Iterator<string> };

export class OfficeOutbox {
  private readonly items: Item[] = [];
  private queuedBytes = 0;
  private scheduled = false;
  private disposed = false;
  private readonly schedule: (run: () => void) => void;

  constructor(
    private readonly ws: OutboxSocket,
    private readonly options: OutboxOptions = {},
  ) {
    this.schedule = options.schedule ?? ((run) => void setTimeout(run, 0));
  }

  // True while frames wait here for the socket.
  get backlogged(): boolean {
    return this.items.length > 0;
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
    this.items.length = 0;
    this.queuedBytes = 0;
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
    while (!this.disposed && this.items.length > 0) {
      // Bun's buffer is full: its drain callback resumes the pump.
      if (!this.room()) return;
      if (budget <= 0) {
        this.later();
        return;
      }
      let data: string | null;
      try {
        data = this.take();
      } catch {
        this.fail("threw");
        return;
      }
      if (data === null) continue;
      budget -= data.length;
      this.write(data);
    }
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
