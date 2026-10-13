// A small, strict HTTP/1.1 reader for the secret proxy. The proxy reads each
// request and response itself, so it owns the message boundaries that its
// per-request checks depend on. Bun's node:http server drops a connection
// with a pipelined second request and hands an Upgrade request to the normal
// handler (checked on Bun 1.4.2, 2026-10-13), so it is not used here.
//
// Requests come from agents and are parsed strictly: no obs-fold, no space
// before a colon, no Content-Length together with Transfer-Encoding, one
// Content-Length, and only the chunked transfer coding.

import type { Duplex } from "node:stream";

export const MAX_HEAD_BYTES = 64 * 1024;
const MAX_CHUNK_LINE = 4096;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

// Pulls bytes from a socket on demand. The socket is paused while nothing
// waits, so a slow consumer applies back pressure.
export class ByteReader {
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private failure: Error | null = null;
  private waiter: (() => void) | null = null;

  private readonly onData = (chunk: Buffer) => {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    this.socket.pause();
    this.wake();
  };
  private readonly onEnd = () => {
    this.ended = true;
    this.wake();
  };
  private readonly onError = (error: Error) => {
    this.failure = error;
    this.wake();
  };

  constructor(private readonly socket: Duplex) {
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
    socket.on("error", this.onError);
    socket.pause();
  }

  // Stops reading and returns the bytes read and not consumed. The socket
  // stays paused for its next reader.
  detach(): Buffer {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onError);
    return this.take();
  }

  private wake() {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  private async more(): Promise<boolean> {
    if (this.failure) throw this.failure;
    if (this.ended) return false;
    await new Promise<void>((resolve) => {
      this.waiter = resolve;
      this.socket.resume();
    });
    // The error handler may have set it during the wait.
    const failure = this.failure as Error | null;
    if (failure) throw failure;
    return true;
  }

  // Bytes already read and not consumed.
  pending(): Buffer {
    return this.buffer;
  }

  take(): Buffer {
    const out = this.buffer;
    this.buffer = Buffer.alloc(0);
    return out;
  }

  get isEnded(): boolean {
    return this.ended && this.buffer.length === 0;
  }

  // Up to `max` bytes, or null at the end of the stream.
  async read(max: number): Promise<Buffer | null> {
    while (this.buffer.length === 0) {
      if (!(await this.more()) && this.buffer.length === 0) return null;
    }
    const n = Math.min(max, this.buffer.length);
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  // Bytes up to and including `delimiter`, or null when the stream ends
  // before any byte. Throws when `limit` bytes pass with no delimiter.
  async readUntil(delimiter: string, limit: number): Promise<Buffer | null> {
    let searchFrom = 0;
    for (;;) {
      const at = this.buffer.indexOf(delimiter, searchFrom, "latin1");
      if (at !== -1) {
        if (at > limit)
          throw new HttpError(431, "the message head is too large");
        const end = at + delimiter.length;
        const out = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        return out;
      }
      if (this.buffer.length > limit)
        throw new HttpError(431, "the message head is too large");
      searchFrom = Math.max(0, this.buffer.length - delimiter.length + 1);
      if (!(await this.more())) {
        if (this.buffer.length === 0) return null;
        throw new HttpError(400, "the stream ended inside a message head");
      }
    }
  }
}

export type HeaderList = [name: string, value: string][];

export interface MessageHead {
  startLine: string;
  headers: HeaderList;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Field values: visible ASCII, space and tab, and obs-text.
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

// One message head, or null at a clean end of the stream (between messages).
export async function readHead(
  reader: ByteReader,
): Promise<MessageHead | null> {
  const raw = await reader.readUntil("\r\n\r\n", MAX_HEAD_BYTES);
  if (raw === null) return null;
  const text = raw.toString("latin1");
  // RFC 9112 2.2 lets a server skip empty lines before a request; this reader
  // refuses them instead, as it refuses every other loose form.
  if (text.startsWith("\r\n"))
    throw new HttpError(400, "empty line before the start line");
  const lines = text.slice(0, -4).split("\r\n");
  const startLine = lines.shift() ?? "";
  if (startLine.includes("\n") || startLine.includes("\r"))
    throw new HttpError(400, "bare line feed in the start line");
  const headers: HeaderList = [];
  for (const line of lines) {
    if (line.includes("\n") || line.includes("\r"))
      throw new HttpError(400, "bare line feed in a header");
    if (line.startsWith(" ") || line.startsWith("\t"))
      throw new HttpError(400, "folded header line");
    const colon = line.indexOf(":");
    if (colon <= 0) throw new HttpError(400, "header line without a name");
    const name = line.slice(0, colon);
    if (!TOKEN.test(name)) throw new HttpError(400, "invalid header name");
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
    if (!FIELD_VALUE.test(value))
      throw new HttpError(400, "invalid header value");
    headers.push([name, value]);
  }
  return { startLine, headers };
}

export function headerValues(headers: HeaderList, name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter(([n]) => n.toLowerCase() === lower).map(([, v]) => v);
}

export function hasToken(headers: HeaderList, name: string, token: string) {
  return headerValues(headers, name).some((value) =>
    value
      .split(",")
      .some((part) => part.trim().toLowerCase() === token.toLowerCase()),
  );
}

export type BodyFraming =
  | { kind: "none" }
  | { kind: "length"; length: number }
  | { kind: "chunked" }
  | { kind: "close" };

// The framing of a message body (RFC 9112 6.3). `strict` is for requests:
// Content-Length together with Transfer-Encoding, two Content-Length fields
// or a coding other than chunked are refused. A response with none of them
// runs to the close of the connection.
export function bodyFraming(
  headers: HeaderList,
  options: { strict: boolean; noBody?: boolean },
): BodyFraming {
  if (options.noBody) return { kind: "none" };
  const encodings = headerValues(headers, "transfer-encoding");
  const lengths = headerValues(headers, "content-length");
  if (encodings.length > 0) {
    if (options.strict && lengths.length > 0)
      throw new HttpError(400, "Content-Length with Transfer-Encoding");
    const codings = encodings
      .join(",")
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    if (codings.length === 0 || codings[codings.length - 1] !== "chunked") {
      if (options.strict)
        throw new HttpError(400, "unsupported transfer coding");
      return { kind: "close" };
    }
    if (codings.length !== 1)
      throw new HttpError(
        options.strict ? 400 : 502,
        "unsupported transfer coding",
      );
    return { kind: "chunked" };
  }
  if (lengths.length > 0) {
    if (options.strict && lengths.length > 1)
      throw new HttpError(400, "more than one Content-Length");
    const values = new Set(
      lengths
        .join(",")
        .split(",")
        .map((v) => v.trim()),
    );
    if (values.size !== 1)
      throw new HttpError(
        options.strict ? 400 : 502,
        "conflicting Content-Length",
      );
    const [value] = values;
    if (!/^[0-9]{1,15}$/.test(value))
      throw new HttpError(options.strict ? 400 : 502, "invalid Content-Length");
    const length = Number(value);
    return length === 0 ? { kind: "none" } : { kind: "length", length };
  }
  return options.strict ? { kind: "none" } : { kind: "close" };
}

// The body's bytes, with chunked framing removed. Trailers are read and
// dropped.
export async function* readBody(
  reader: ByteReader,
  framing: BodyFraming,
): AsyncGenerator<Buffer> {
  if (framing.kind === "none") return;
  if (framing.kind === "length") {
    let left = framing.length;
    while (left > 0) {
      const chunk = await reader.read(left);
      if (chunk === null) throw new HttpError(400, "the body ended early");
      left -= chunk.length;
      yield chunk;
    }
    return;
  }
  if (framing.kind === "close") {
    for (;;) {
      const chunk = await reader.read(64 * 1024);
      if (chunk === null) return;
      yield chunk;
    }
  }
  for (;;) {
    const line = await reader.readUntil("\r\n", MAX_CHUNK_LINE);
    if (line === null) throw new HttpError(400, "the body ended early");
    const size = line.toString("latin1").slice(0, -2).split(";")[0].trim();
    if (!/^[0-9a-fA-F]{1,12}$/.test(size))
      throw new HttpError(400, "invalid chunk size");
    let left = parseInt(size, 16);
    if (left === 0) {
      // Trailer section, ended by an empty line.
      for (;;) {
        const trailer = await reader.readUntil("\r\n", MAX_HEAD_BYTES);
        if (trailer === null) throw new HttpError(400, "the body ended early");
        if (trailer.length === 2) return;
      }
    }
    while (left > 0) {
      const chunk = await reader.read(left);
      if (chunk === null) throw new HttpError(400, "the body ended early");
      left -= chunk.length;
      yield chunk;
    }
    const end = await reader.readUntil("\r\n", 2);
    if (end === null || end.length !== 2)
      throw new HttpError(400, "invalid chunk end");
  }
}

export function serializeHead(startLine: string, headers: HeaderList): Buffer {
  let text = `${startLine}\r\n`;
  for (const [name, value] of headers) text += `${name}: ${value}\r\n`;
  return Buffer.from(`${text}\r\n`, "latin1");
}

export function chunk(data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${data.length.toString(16)}\r\n`, "latin1"),
    data,
    Buffer.from("\r\n", "latin1"),
  ]);
}

export const LAST_CHUNK = Buffer.from("0\r\n\r\n", "latin1");
