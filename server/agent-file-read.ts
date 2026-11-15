// The server side of the runner's "file-read" entry (server/file-read-range.ts):
// bytes of a file that an isolated member's agent names, read as the member
// (internal-docs/member-os-user-design.md, slice 2a). Every reply is member
// data: the header is checked, the size is used only after the caller's
// bound, and the bytes are counted against what was asked. More bytes cut
// the stream; fewer fail it, so a short read never passes as a whole one.

import { isAbsolute } from "path";
import type { AgentHost } from "./agent-host.ts";

const HEADER_MAX = 8192;
const PATH_MAX = 4096;

export interface HostFileRange {
  // The file the runner opened (its realpath) and its size at the open.
  real: string;
  size: number;
  // The bytes of the range, in order. Throws when the runner sends more or
  // fewer than the range holds, or when the entry fails.
  bytes: AsyncIterable<Uint8Array>;
  // Ends the runner's stream; safe to call more than once.
  close(): Promise<void>;
}

export class HostFileReadError extends Error {
  constructor(
    message: string,
    readonly code: "too_large" | "bad_reply" | "failed",
  ) {
    super(message);
  }
}

export async function openHostFileRange(
  host: AgentHost,
  path: string,
  range: {
    offset: number;
    // The bytes asked for; the range ends at the end of the file if sooner.
    length: number;
    // The largest file the caller takes.
    sizeMax: number;
    timeoutMs: number;
  },
): Promise<HostFileRange> {
  if (!host.runEntryOut)
    throw new HostFileReadError("this host cannot stream a file", "failed");
  const stream = host.runEntryOut(
    "file-read",
    { path, offset: range.offset, length: range.length },
    range.timeoutMs,
  );
  const source = stream[Symbol.asyncIterator]();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await source.return?.().catch(() => {});
  };
  try {
    let head = Buffer.alloc(0);
    let newline = -1;
    while (newline < 0) {
      const next = await source.next();
      if (next.done)
        throw new HostFileReadError("the runner sent no header", "bad_reply");
      head = Buffer.concat([head, Buffer.from(next.value)]);
      newline = head.indexOf(0x0a);
      if (newline < 0 && head.length > HEADER_MAX)
        throw new HostFileReadError(
          "the runner's header is too long",
          "bad_reply",
        );
    }
    if (newline > HEADER_MAX)
      throw new HostFileReadError(
        "the runner's header is too long",
        "bad_reply",
      );
    let header: { real?: unknown; size?: unknown };
    try {
      header = JSON.parse(head.subarray(0, newline).toString("utf8")) as {
        real?: unknown;
        size?: unknown;
      };
    } catch {
      throw new HostFileReadError(
        "the runner's header is not JSON",
        "bad_reply",
      );
    }
    const { real, size } = header ?? {};
    if (
      typeof real !== "string" ||
      real.length > PATH_MAX ||
      !isAbsolute(real) ||
      real.includes("\0") ||
      !Number.isSafeInteger(size) ||
      (size as number) < 0
    )
      throw new HostFileReadError("the runner sent a bad header", "bad_reply");
    if ((size as number) > range.sizeMax)
      throw new HostFileReadError(
        `the file is larger than ${range.sizeMax} bytes`,
        "too_large",
      );
    const expected = Math.max(
      0,
      Math.min(range.length, (size as number) - range.offset),
    );
    const rest = head.subarray(newline + 1);
    async function* bytes(): AsyncGenerator<Uint8Array> {
      let total = 0;
      try {
        let pending: Uint8Array | null = rest.length > 0 ? rest : null;
        for (;;) {
          let chunk: Uint8Array;
          if (pending) {
            chunk = pending;
            pending = null;
          } else {
            const next = await source.next();
            if (next.done) break;
            chunk = next.value;
          }
          total += chunk.length;
          if (total > expected)
            throw new HostFileReadError(
              "the runner sent more bytes than the range holds",
              "bad_reply",
            );
          yield chunk;
        }
        if (total < expected)
          throw new HostFileReadError(
            "the runner sent fewer bytes than the range holds",
            "failed",
          );
      } catch (error) {
        if (error instanceof HostFileReadError) throw error;
        throw new HostFileReadError((error as Error).message, "failed");
      } finally {
        await close();
      }
    }
    return { real, size: size as number, bytes: bytes(), close };
  } catch (error) {
    await close();
    if (error instanceof HostFileReadError) throw error;
    throw new HostFileReadError((error as Error).message, "failed");
  }
}

// The largest file served in place for an isolated member's ask (video and
// audio). The office serves its own files with no cap; a runner's size is
// member data, so it gets one.
export const IN_PLACE_MAX_BYTES = 16 * 1024 ** 3;
// How long one in-place stream may stay open (a video that plays slowly).
export const IN_PLACE_STREAM_MS = 60 * 60_000;

// One "bytes=a-b", "bytes=a-" or "bytes=-n" range of a file of `size` bytes:
// null for no or another kind of Range header (the whole file is sent),
// "unsatisfiable" for a range outside the file.
export function parseByteRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null | "unsatisfiable" {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end < start
  )
    return "unsatisfiable";
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

// A file of an isolated member's agent as an HTTP response, read through
// their runner, with one byte range when the request asks for it. A stream
// that ends short fails the response body, so the client sees an error and
// never a short success; a client that goes away closes the runner's stream.
export async function hostFileResponse(
  host: AgentHost,
  path: string,
  contentType: string,
  headers: Record<string, string>,
  rangeHeader: string | null,
): Promise<Response | null> {
  let size: number;
  try {
    const st = await host.fs.stat(path);
    if (st.type !== "file" || st.size > IN_PLACE_MAX_BYTES) return null;
    size = st.size;
  } catch {
    return null;
  }
  const range = parseByteRange(rangeHeader, size);
  if (range === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  const { offset, length } = range ?? { offset: 0, length: size };
  let opened: HostFileRange;
  try {
    opened = await openHostFileRange(host, path, {
      offset,
      length,
      sizeMax: IN_PLACE_MAX_BYTES,
      timeoutMs: IN_PLACE_STREAM_MS,
    });
  } catch {
    return null;
  }
  if (opened.size !== size) {
    await opened.close();
    return null;
  }
  const bytes = opened.bytes[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await bytes.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await bytes.return?.(undefined).catch(() => {});
      await opened.close();
    },
  });
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      "Content-Type": contentType,
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      ...(range
        ? { "Content-Range": `bytes ${offset}-${offset + length - 1}/${size}` }
        : {}),
    },
  });
}

export type HostFileRead =
  | { ok: true; data: Buffer }
  | {
      ok: false;
      kind: "not_found" | "not_file" | "too_large" | "io_error";
      size?: number;
      message?: string;
    };

// One whole file of at most `max` bytes, read through a runner host: a stat,
// then readBytes, whose bytes the server counts (a file that grows past
// `max` after the stat is refused as too_large).
export async function readHostFile(
  host: AgentHost,
  path: string,
  max: number,
): Promise<HostFileRead> {
  const failed = (err: unknown): HostFileRead => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { ok: false, kind: "not_found" };
    if (code === "EFBIG")
      return { ok: false, kind: "too_large", size: max + 1 };
    return { ok: false, kind: "io_error", message: (err as Error).message };
  };
  try {
    const st = await host.fs.stat(path);
    if (st.type !== "file") return { ok: false, kind: "not_file" };
    if (st.size > max) return { ok: false, kind: "too_large", size: st.size };
  } catch (err) {
    return failed(err);
  }
  try {
    return { ok: true, data: await host.fs.readBytes(path, max) };
  } catch (err) {
    return failed(err);
  }
}
