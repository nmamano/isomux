// The broker streams request bodies. The buffered parser used by the admin
// socket and agent runner keeps its existing contract in unix-socket-server.ts.
export interface RequestHead {
  method: string;
  url: URL;
  headers: Headers;
  contentLength: number;
}

export class RequestHeadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function parseRequestHead(head: Buffer): RequestHead {
  const lines = head.toString("utf8").split("\r\n");
  const match = /^(GET|POST|PATCH|PUT|DELETE) ([^ ]+) HTTP\/1\.[01]$/.exec(lines.shift() ?? "");
  if (!match) throw new RequestHeadError(400, "Invalid OpenCode office request.");
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new RequestHeadError(400, "Invalid OpenCode office request.");
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  if (headers.has("transfer-encoding"))
    throw new RequestHeadError(411, "OpenCode office requests require Content-Length.");
  const length = headers.get("content-length") ?? "0";
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
    throw new RequestHeadError(400, "Invalid OpenCode office request.");
  const url = new URL(match[2], "http://isomux");
  if (url.origin !== "http://isomux")
    throw new RequestHeadError(400, "Invalid OpenCode office request.");
  return { method: match[1], url, headers, contentLength: Number(length) };
}

// Request buffers do not grow with Content-Length: the body queue holds at
// most 64 KiB plus one native socket read. Head assembly holds at most 64 KiB
// plus one read. Including transient copies, a conservative bound is three
// 64 KiB buffers plus three native read buffers; Bun owns the native read size.
export const BODY_HIGH_WATER_MARK = 64 * 1024;

export class StreamingRequestBody {
  readonly stream: ReadableStream<Uint8Array>;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private admitted = false;
  private remaining: number;

  constructor(length: number, private readonly socket: { pause(): void; resume(): void }) {
    this.remaining = length;
    // No additional body reads until the head's identity and route pass.
    socket.pause();
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller; },
      pull: () => { if (this.admitted && this.remaining > 0) socket.resume(); },
      cancel: () => { this.controller = null; socket.pause(); },
    }, new ByteLengthQueuingStrategy({ highWaterMark: BODY_HIGH_WATER_MARK }));
  }

  admit(initial: Buffer): void {
    this.admitted = true;
    this.push(initial);
    if (this.controller && (this.controller.desiredSize ?? 0) > 0) this.socket.resume();
  }

  push(chunk: Buffer): void {
    if (!this.admitted || !this.controller) return;
    const take = Math.min(chunk.length, this.remaining);
    if (take) this.controller.enqueue(new Uint8Array(chunk.subarray(0, take)));
    this.remaining -= take;
    if (this.remaining === 0) {
      this.controller.close();
      this.controller = null;
      this.socket.pause();
    } else if ((this.controller.desiredSize ?? 0) <= 0) {
      this.socket.pause();
    }
  }

  abort(reason: Error): void {
    this.controller?.error(reason);
    this.controller = null;
    this.socket.pause();
  }

}

// The runner writes a continuing frame stream with drain waiters. This broker
// queues an optional interim response and one bounded final response.
export class BrokerResponseWriter {
  private pending: Array<{ bytes: Buffer; final: boolean; flushed?: () => void }> = [];
  private offset = 0;
  private closed = false;
  constructor(private readonly socket: Pick<Bun.Socket, "write" | "end">) {}

  interim(response: Buffer, flushed: () => void): void {
    this.enqueue(response, false, flushed);
  }

  send(response: Buffer): void { this.enqueue(response, true); }

  private enqueue(bytes: Buffer, final: boolean, flushed?: () => void): void {
    if (this.closed) return;
    const idle = this.pending.length === 0;
    this.pending.push({ bytes, final, flushed });
    if (idle) this.drain();
  }

  drain(): void {
    while (!this.closed && this.pending.length) {
      const next = this.pending[0];
      const wrote = this.socket.write(next.bytes.subarray(this.offset));
      if (wrote < 0) { this.close(); return; }
      this.offset += wrote;
      if (this.offset < next.bytes.length) return;
      this.pending.shift();
      this.offset = 0;
      if (next.final) { this.close(); this.socket.end(); return; }
      next.flushed?.();
    }
  }

  get draining(): boolean { return !this.closed && this.pending.length > 0; }

  close(): void { this.closed = true; this.pending = []; }
}
