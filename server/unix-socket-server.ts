import { dlopen, ptr } from "bun:ffi";
import { readDarwinPeerCredentials } from "./backends/opencode/darwin-libsystem.ts";

// Helpers for Bun.listen Unix-socket servers that check the connecting
// process (the OpenCode authority broker and the admin socket). Bun.serve
// exposes no peer data, so these servers read the peer from the accepted
// socket's fd and parse their one HTTP request themselves.

export interface ParsedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: Buffer;
}

// Returns null until the buffer holds the whole request. Throws on a malformed
// or oversized request.
export function parseHttpRequest(
  buffer: Buffer,
  maxBytes: number,
): ParsedRequest | null {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const lines = buffer.subarray(0, headerEnd).toString("utf8").split("\r\n");
  const match = /^(GET|POST|PATCH|PUT|DELETE) ([^ ]+) HTTP\/1\.[01]$/.exec(
    lines.shift() ?? "",
  );
  if (!match || /[\r\n]/.test(match[2]))
    throw new Error("Invalid proxy request.");
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("Invalid proxy header.");
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const lengthText = headers.get("content-length") ?? "0";
  if (!/^\d+$/.test(lengthText)) throw new Error("Invalid content length.");
  const length = Number(lengthText);
  if (length > maxBytes) throw new Error("Proxy body is too large.");
  const bodyStart = headerEnd + 4;
  if (buffer.length < bodyStart + length) return null;
  const url = new URL(match[2], "http://isomux");
  if (url.origin !== "http://isomux") throw new Error("Proxy host is fixed.");
  return {
    method: match[1],
    url,
    headers,
    body: buffer.subarray(bodyStart, bodyStart + length),
  };
}

export function httpResponse(
  status: number,
  body: string | Buffer,
  contentType = "text/plain; charset=utf-8",
): Buffer {
  const safeBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([
    Buffer.from(
      `HTTP/1.1 ${status} ${statusText(status)}\r\nContent-Type: ${contentType ?? "application/octet-stream"}\r\nContent-Length: ${safeBody.length}\r\nConnection: close\r\n\r\n`,
    ),
    safeBody,
  ]);
}

function statusText(status: number): string {
  return status >= 200 && status < 300 ? "OK" : "Error";
}

const LIBC_SYMBOLS = {
  getsockopt: {
    args: ["i32", "i32", "i32", "ptr", "ptr"],
    returns: "i32",
  },
} as const;

function openLibc(candidate: string) {
  return dlopen(candidate, LIBC_SYMBOLS);
}

type LibcLibrary = ReturnType<typeof openLibc>;

let libc: LibcLibrary | null = null;
let libcLoadAttempted = false;

function loadLibc(): LibcLibrary | null {
  if (libcLoadAttempted) return libc;
  libcLoadAttempted = true;
  const candidates = [
    "libc.so.6",
    process.arch === "arm64"
      ? "libc.musl-aarch64.so.1"
      : "libc.musl-x86_64.so.1",
  ];
  for (const candidate of candidates) {
    try {
      libc = openLibc(candidate);
      return libc;
    } catch {}
  }
  console.error(
    "[unix-socket] SO_PEERCRED is unavailable; sockets that check the caller refuse every connection.",
  );
  return null;
}

export function socketFileDescriptor(
  socket: Bun.Socket<unknown>,
): number | null {
  // Bun's Socket type omits fd; the runtime exposes a number, verified
  // 2026-08-29. Read it as unknown and fail closed if that shape changes.
  const fd: unknown = Reflect.get(socket, "fd");
  return typeof fd === "number" && Number.isInteger(fd) && fd >= 0 ? fd : null;
}

// The connecting process of an accepted Unix socket: SO_PEERCRED on Linux,
// LOCAL_PEERCRED on macOS. Null when the platform or the call fails; callers
// refuse on null.
export function readPeerCredentials(
  fd: number,
): { pid: number; uid: number } | null {
  if (process.platform === "darwin") return readDarwinPeerCredentials(fd);
  if (process.platform !== "linux") return null;
  const loaded = loadLibc();
  if (!loaded) return null;
  const credential = new Uint32Array(3);
  const length = new Uint32Array([credential.byteLength]);
  let result: number;
  try {
    result = loaded.symbols.getsockopt(fd, 1, 17, ptr(credential), ptr(length));
  } catch {
    return null;
  }
  if (result !== 0 || length[0] !== credential.byteLength) return null;
  return { pid: credential[0], uid: credential[1] };
}
