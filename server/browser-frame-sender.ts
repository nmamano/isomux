import { BrowserStreamPressure } from "./browser-stream-pressure.ts";

/** Keep one latest frame while this socket drains. A quiet page still gets its
 * final frame delivered by drain or a bounded retry timer. */
export class BrowserFrameSender {
  private pending: string | Uint8Array | undefined;
  private stopped = false;
  private frameBytes = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly socket: {
      send(data: string | Uint8Array): unknown;
      getBufferedAmount(): number;
    },
    private readonly canDeliver: () => boolean,
    private readonly onPressure?: () => void,
    readonly pressure = new BrowserStreamPressure(),
    private readonly intervalMs = 250,
  ) {
    if (onPressure) this.startTimer();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.samplePressure();
      this.flush();
    }, this.intervalMs);
    this.timer.unref();
  }

  samplePressure(now = performance.now()): void {
    if (this.stopped || !this.frameBytes) return;
    if (!this.canDeliver()) {
      this.stop();
      return;
    }
    if (
      this.pressure.sample(
        this.socket.getBufferedAmount(),
        this.frameBytes,
        now,
      )
    )
      this.onPressure?.();
  }

  canCapture(): boolean {
    return !this.stopped && this.pending === undefined && this.socket.getBufferedAmount() <= this.frameBytes;
  }

  send(frame: string | Uint8Array): void {
    if (this.stopped) return;
    this.frameBytes =
      typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
    this.pending = frame;
    this.flush();
  }

  flush(): void {
    if (this.stopped || this.pending === undefined) return;
    // Authorization can change while a frame waits for drain.
    if (!this.canDeliver()) {
      this.stop();
      return;
    }
    if (
      this.socket.getBufferedAmount() >
      (typeof this.pending === "string"
        ? Buffer.byteLength(this.pending)
        : this.pending.byteLength)
    ) {
      this.startTimer();
      return;
    }
    const frame = this.pending;
    this.clear();
    this.socket.send(frame);
  }

  clear(): void {
    if (!this.onPressure && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.pending = undefined;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clear();
  }
}
