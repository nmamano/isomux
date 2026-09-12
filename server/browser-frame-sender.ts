/** Keep one latest frame while this socket drains. A quiet page still gets its
 * final frame delivered by the websocket drain callback. */
export class BrowserFrameSender {
  private pending: string | undefined;
  private stopped = false;

  constructor(
    private readonly socket: {
      send(data: string): unknown;
      getBufferedAmount(): number;
    },
    private readonly canDeliver: () => boolean,
  ) {}

  send(frame: string): void {
    if (this.stopped) return;
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
    if (this.socket.getBufferedAmount() > Buffer.byteLength(this.pending))
      return;
    const frame = this.pending;
    this.pending = undefined;
    this.socket.send(frame);
  }

  stop(): void {
    this.stopped = true;
    this.pending = undefined;
  }
}
