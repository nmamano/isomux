import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { openCodeAuthoritySocketPath } from "./office-proxy-shared.ts";

interface TurnBinding {
  owner: symbol;
  agentId: string;
  token: string;
  serverPid: number;
  serverStartTicks: string;
  calls: number;
}

interface ConnectionData {
  peerPid: number | null;
  peerUid: number | null;
  buffer: Buffer;
  handled: boolean;
}

export interface OpenCodeAuthorityBinding {
  activate(serverPid: number): string;
  deactivate(): void;
  unbind(): void;
}

interface ProcessHop {
  pid: number;
  parentPid: number;
  startTicks: string;
}

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CALLS_PER_TURN = 32;
const MAX_ANCESTRY_DEPTH = 32;
const PROXY_TIMEOUT_MS = 30_000;
const PORT = process.env.PORT || "4000";

const ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/agents$/ },
  { method: "GET", path: /^\/api\/tasks$/ },
  { method: "POST", path: /^\/api\/tasks$/ },
  { method: "PATCH", path: /^\/api\/tasks\/[^/]+$/ },
  { method: "POST", path: /^\/api\/tasks\/[^/]+\/(claim|done)$/ },
  {
    method: "GET",
    path: /^\/api\/agents\/[^/]+\/(context|logs|sessions|instructions|scheduled-messages)$/,
  },
  {
    method: "POST",
    path: /^\/api\/agents\/[^/]+\/(messages|read-file|preview-url|diff|edit-file|terminal-command|resume|new-conversation|handoff|send-now|abort|move|revive)$/,
  },
  { method: "PATCH", path: /^\/api\/agents\/[^/]+(?:\/messages\/[^/]+)?$/ },
  {
    method: "DELETE",
    path: /^\/api\/agents\/[^/]+(?:\/queue\/[^/]+|\/scheduled-messages\/[^/]+)?$/,
  },
  { method: "POST", path: /^\/api\/agents$/ },
  { method: "GET", path: /^\/api\/apps(?:\/[^/]+(?:\/logs)?)?$/ },
  { method: "POST", path: /^\/api\/apps(?:\/[^/]+\/(restart|start|stop))?$/ },
  { method: "PATCH", path: /^\/api\/apps\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/apps\/[^/]+$/ },
  { method: "GET", path: /^\/api\/memory$/ },
  { method: "POST", path: /^\/api\/memory$/ },
  { method: "PUT", path: /^\/api\/memory$/ },
  { method: "POST", path: /^\/api\/rooms$/ },
  { method: "PATCH", path: /^\/api\/rooms\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/rooms\/[^/]+$/ },
  { method: "GET", path: /^\/api\/rooms\/[^/]+\/settings$/ },
  { method: "PUT", path: /^\/api\/rooms\/[^/]+\/settings$/ },
  { method: "POST", path: /^\/api\/rooms\/[^/]+\/swap-desks$/ },
  {
    method: "GET",
    path: /^\/api\/cronjobs(?:\/[^/]+(?:\/runs(?:\/[^/]+)?)?)?$/,
  },
  { method: "POST", path: /^\/api\/cronjobs(?:\/[^/]+\/runs)?$/ },
  { method: "PATCH", path: /^\/api\/cronjobs\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/cronjobs\/[^/]+$/ },
  { method: "GET", path: /^\/api\/cron-runs$/ },
];

export class OpenCodeAuthorityBroker {
  private readonly turns = new Map<string, TurnBinding>();
  private server: ReturnType<typeof Bun.listen<ConnectionData>> | null = null;

  constructor(
    private readonly socketPath = openCodeAuthoritySocketPath(),
    private readonly expectedUid = process.getuid?.() ?? -1,
    private readonly upstreamOrigin = `http://127.0.0.1:${PORT}`,
  ) {}

  bind(agentId: string, token: string): OpenCodeAuthorityBinding {
    this.ensureListening();
    const owner = Symbol(agentId);
    let activeHandle: string | null = null;
    return {
      activate: (serverPid) => {
        if (activeHandle) this.turns.delete(activeHandle);
        const identity = readProcessHop(serverPid);
        if (!identity)
          throw new Error("OpenCode server process identity is unreadable.");
        activeHandle = randomBytes(24).toString("base64url");
        this.turns.set(activeHandle, {
          owner,
          agentId,
          token,
          serverPid,
          serverStartTicks: identity.startTicks,
          calls: 0,
        });
        return activeHandle;
      },
      deactivate: () => {
        if (!activeHandle) return;
        if (this.turns.get(activeHandle)?.owner === owner)
          this.turns.delete(activeHandle);
        activeHandle = null;
      },
      unbind: () => {
        if (activeHandle && this.turns.get(activeHandle)?.owner === owner)
          this.turns.delete(activeHandle);
        activeHandle = null;
      },
    };
  }

  close(): void {
    this.turns.clear();
    this.server?.stop(true);
    this.server = null;
    rmSync(this.socketPath, { force: true });
  }

  private ensureListening(): void {
    if (this.server) return;
    const directory = dirname(this.socketPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    rmSync(this.socketPath, { force: true });
    this.server = Bun.listen<ConnectionData>({
      unix: this.socketPath,
      data: {
        peerPid: null,
        peerUid: null,
        buffer: Buffer.alloc(0),
        handled: false,
      },
      socket: {
        open: (socket) => {
          const peer = readPeerCredentials(socket.fd);
          socket.data = {
            peerPid: peer?.pid ?? null,
            peerUid: peer?.uid ?? null,
            buffer: Buffer.alloc(0),
            handled: false,
          };
        },
        data: (socket, chunk) => {
          if (socket.data.handled) return;
          socket.data.buffer = Buffer.concat([
            socket.data.buffer,
            Buffer.from(chunk),
          ]);
          if (socket.data.buffer.length > MAX_REQUEST_BYTES) {
            socket.data.handled = true;
            socket.end(
              httpResponse(413, "OpenCode office request is too large."),
            );
            return;
          }
          let request: ParsedRequest | null;
          try {
            request = parseHttpRequest(socket.data.buffer);
          } catch {
            socket.data.handled = true;
            socket.end(httpResponse(400, "Invalid OpenCode office request."));
            return;
          }
          if (!request) return;
          socket.data.handled = true;
          void this.proxy(
            request,
            socket.data.peerPid,
            socket.data.peerUid,
          ).then(
            (response) => socket.end(response),
            () =>
              socket.end(httpResponse(502, "OpenCode office request failed.")),
          );
        },
      },
    });
  }

  private async proxy(
    request: ParsedRequest,
    peerPid: number | null,
    peerUid: number | null,
  ): Promise<Buffer> {
    const handle = request.headers.get("x-isomux-turn") ?? "";
    const turn = this.turns.get(handle);
    const ancestry = peerPid === null ? null : readVerifiedAncestry(peerPid);
    const ancestryText =
      ancestry?.map((hop) => `${hop.pid}:${hop.startTicks}`).join(",") ??
      "refused";
    console.info(
      `[opencode-office-proxy] agent=${turn?.agentId ?? "unknown"} peer=${peerPid ?? "unknown"} ancestry=${ancestryText} method=${request.method} path=${request.url.pathname}`,
    );
    if (peerUid !== this.expectedUid || !turn || !ancestry)
      return httpResponse(403, ancestryFailureMessage(ancestry));
    const serverHop = ancestry.find((hop) => hop.pid === turn.serverPid);
    if (!serverHop || serverHop.startTicks !== turn.serverStartTicks)
      return httpResponse(403, ancestryFailureMessage(ancestry));
    if (turn.calls >= MAX_CALLS_PER_TURN)
      return httpResponse(
        429,
        "OpenCode office call limit reached for this turn.",
      );
    if (
      !ROUTES.some(
        (route) =>
          route.method === request.method &&
          route.path.test(request.url.pathname),
      )
    )
      return httpResponse(
        403,
        "This Isomux API route is not available through OpenCode.",
      );
    turn.calls += 1;
    const upstream = new URL(request.url.pathname, this.upstreamOrigin);
    for (const [name, value] of request.url.searchParams)
      upstream.searchParams.append(name, value);
    let upstreamBody: string | undefined;
    if (request.body.length) {
      try {
        upstreamBody = JSON.stringify(
          JSON.parse(request.body.toString("utf8")),
        );
      } catch {
        return httpResponse(400, "OpenCode office request body must be JSON.");
      }
    }
    const response = await fetch(upstream, {
      method: request.method,
      headers: {
        authorization: `Bearer ${turn.token}`,
        ...(upstreamBody ? { "content-type": "application/json" } : {}),
      },
      body: upstreamBody,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > MAX_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      return httpResponse(
        502,
        "OpenCode office response exceeded the size limit.",
      );
    }
    const body = await readCappedResponse(response);
    if (!body)
      return httpResponse(
        502,
        "OpenCode office response exceeded the size limit.",
      );
    return httpResponse(
      response.status,
      scrubToken(body, turn.token),
      response.headers.get("content-type"),
    );
  }
}

interface ParsedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: Buffer;
}

function parseHttpRequest(buffer: Buffer): ParsedRequest | null {
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
  if (length > MAX_REQUEST_BYTES) throw new Error("Proxy body is too large.");
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

function httpResponse(
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

function scrubToken(body: Buffer, token: string): Buffer {
  return Buffer.from(body.toString("utf8").split(token).join("[REDACTED]"));
}

async function readCappedResponse(response: Response): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

function ancestryFailureMessage(ancestry: ProcessHop[] | null): string {
  return ancestry
    ? "OpenCode office call refused because it did not come from the active server turn."
    : "OpenCode office call refused because its process ancestry was lost. Run the call in the foreground, not through nohup, disown, or a background daemon.";
}

function readVerifiedAncestry(pid: number): ProcessHop[] | null {
  const hops: ProcessHop[] = [];
  let current = pid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current > 1; depth++) {
    const hop = readProcessHop(current);
    if (!hop) return null;
    hops.push(hop);
    current = hop.parentPid;
  }
  if (current > 1) return null;
  // Every hop is read again after the walk. If a process exits or a pid is
  // reused during the walk, start ticks differ and the request fails closed.
  for (const hop of hops) {
    if (readProcessHop(hop.pid)?.startTicks !== hop.startTicks) return null;
  }
  return hops;
}

function readProcessHop(pid: number): ProcessHop | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/);
    const parentPid = Number(fields[1]);
    const startTicks = fields[19];
    if (
      !Number.isSafeInteger(parentPid) ||
      !startTicks ||
      !/^\d+$/.test(startTicks)
    )
      return null;
    return { pid, parentPid, startTicks };
  } catch {
    return null;
  }
}

let libc: ReturnType<typeof dlopen> | null = null;
let libcLoadAttempted = false;
let libcLoadFailureLogged = false;

function loadLibc(): ReturnType<typeof dlopen> | null {
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
      libc = dlopen(candidate, {
        getsockopt: {
          args: [
            FFIType.i32,
            FFIType.i32,
            FFIType.i32,
            FFIType.ptr,
            FFIType.ptr,
          ],
          returns: FFIType.i32,
        },
      });
      return libc;
    } catch {}
  }
  if (!libcLoadFailureLogged) {
    libcLoadFailureLogged = true;
    console.error(
      "[opencode-office-proxy] SO_PEERCRED is unavailable; OpenCode office calls will be refused.",
    );
  }
  return null;
}

function readPeerCredentials(
  fd: number,
): { pid: number; uid: number; gid: number } | null {
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
  return { pid: credential[0], uid: credential[1], gid: credential[2] };
}

export const openCodeAuthorityBroker = new OpenCodeAuthorityBroker();
