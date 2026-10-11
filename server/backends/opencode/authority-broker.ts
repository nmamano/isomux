import { API_ROUTES } from "../../routes/table.ts";
import { matchRoute } from "../../routes/match.ts";
import { passesRouteStageOne } from "../../identity/dispatch.ts";
import {
  PRIVILEGED_AGENT_CAPABILITIES,
  type Identity,
} from "../../identity/index.ts";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { SPLIT_CONFIG } from "../../split/roots.ts";
import { chmodShare } from "../../split/share-mode.ts";
import { openCodeAuthoritySocketPath } from "./office-proxy-shared.ts";
import { readProcessHop, type ProcessHop } from "./process-identity.ts";
import {
  httpResponse,
  readPeerCredentials,
  socketFileDescriptor,
} from "../../unix-socket-server.ts";

import {
  BrokerResponseWriter,
  parseRequestHead,
  RequestHeadError,
  StreamingRequestBody,
  type RequestHead,
} from "./authority-request.ts";

interface TurnBinding {
  owner: symbol;
  agentId: string;
  token: string;
  serverPid: number;
  serverStartTicks: string;
  calls: number;
}

interface ConnectionData {
  peer: PeerIdentity | null;
  buffer: Buffer;
  handled: boolean;
  body: StreamingRequestBody | null;
  abort: AbortController;
  writer: BrokerResponseWriter | null;
}

export interface OpenCodeAuthorityBinding {
  readonly handle: string;
  activate(serverPid: number): string;
  deactivate(): void;
  unbind(): void;
}

// The connecting process as read when the broker accepts the connection. The
// request-time ancestry walk must start at this same process.
interface PeerIdentity {
  pid: number;
  uid: number;
  startTicks: string;
}

export interface OpenCodeAuthorityProcessReaders {
  readPeerCredentials(fd: number): { pid: number; uid: number } | null;
  readProcessHop(pid: number): ProcessHop | null;
}

const HOST_PROCESS_READERS: OpenCodeAuthorityProcessReaders = {
  readPeerCredentials,
  readProcessHop: (pid) => readProcessHop(pid),
};

const MAX_REQUEST_HEAD_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CALLS_PER_TURN = 32;
const MAX_ANCESTRY_DEPTH = 32;
const PROXY_TIMEOUT_MS = 30_000;
const PORT = process.env.PORT || "4000";

// This ceiling admits every route available to an agent. The executor resolves
// the actual token and applies its capabilities and all live resource guards.
const AGENT_CEILING: Identity = {
  scope: "agent",
  userId: null,
  role: "member",
  capabilities: PRIVILEGED_AGENT_CAPABILITIES,
};

export class OpenCodeAuthorityBroker {
  private readonly turns = new Map<string, TurnBinding>();
  private server: ReturnType<typeof Bun.listen<ConnectionData>> | null = null;

  constructor(
    private readonly socketPath = openCodeAuthoritySocketPath(),
    // The OpenCode processes run as the agent user: in split mode that is
    // not this process's uid.
    private readonly expectedUid = SPLIT_CONFIG?.agentUid ??
      process.getuid?.() ??
      -1,
    private readonly upstreamOrigin = `http://127.0.0.1:${PORT}`,
    private readonly readers = HOST_PROCESS_READERS,
    private readonly split = SPLIT_CONFIG !== null,
  ) {}

  bind(agentId: string, token: string): OpenCodeAuthorityBinding {
    this.ensureListening();
    const owner = Symbol(agentId);
    const handle = randomBytes(24).toString("base64url");
    let active = false;
    return {
      handle,
      activate: (serverPid) => {
        if (active) this.turns.delete(handle);
        const identity = this.readers.readProcessHop(serverPid);
        if (!identity)
          throw new Error("OpenCode server process identity is unreadable.");
        this.turns.set(handle, {
          owner,
          agentId,
          token,
          serverPid,
          serverStartTicks: identity.startTicks,
          calls: 0,
        });
        active = true;
        return handle;
      },
      deactivate: () => {
        if (!active) return;
        if (this.turns.get(handle)?.owner === owner) this.turns.delete(handle);
        active = false;
      },
      unbind: () => {
        if (active && this.turns.get(handle)?.owner === owner)
          this.turns.delete(handle);
        active = false;
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
    // Split mode: the agent user's group may pass through and connect; only
    // the server can create, rename or remove entries (design 3.1.1).
    const directoryMode = this.split ? 0o2750 : 0o700;
    mkdirSync(directory, { recursive: true, mode: directoryMode });
    chmodShare(directory, directoryMode);
    rmSync(this.socketPath, { force: true });
    this.server = Bun.listen<ConnectionData>({
      unix: this.socketPath,
      data: {
        peer: null,
        buffer: Buffer.alloc(0),
        handled: false,
        body: null,
        abort: new AbortController(),
        writer: null,
      },
      socket: {
        open: (socket) => {
          const fd = socketFileDescriptor(socket);
          socket.data = {
            peer: fd === null ? null : this.readPeer(fd),
            buffer: Buffer.alloc(0),
            handled: false,
            body: null,
            abort: new AbortController(),
            writer: new BrokerResponseWriter(socket),
          };
        },
        data: (socket, chunk) => {
          if (socket.data.body) {
            socket.data.body.push(chunk);
            return;
          }
          if (socket.data.handled) return;
          const buffer = Buffer.concat([socket.data.buffer, chunk]);
          const headEnd = buffer.indexOf("\r\n\r\n");
          if (
            (headEnd < 0 ? buffer.length : headEnd + 4) > MAX_REQUEST_HEAD_BYTES
          ) {
            socket.data.handled = true;
            socket.data.writer!.send(
              httpResponse(413, "OpenCode office request head is too large."),
            );
            return;
          }
          if (headEnd < 0) {
            socket.data.buffer = buffer;
            return;
          }
          socket.pause();
          socket.data.handled = true;
          socket.data.buffer = Buffer.alloc(0);
          let request: RequestHead;
          try {
            request = parseRequestHead(buffer.subarray(0, headEnd));
          } catch (error) {
            socket.data.writer!.send(
              httpResponse(
                error instanceof RequestHeadError ? error.status : 400,
                error instanceof RequestHeadError
                  ? error.message
                  : "Invalid OpenCode office request.",
              ),
            );
            return;
          }
          const body = new StreamingRequestBody(request.contentLength, socket);
          socket.data.body = body;
          const signal = AbortSignal.any([
            socket.data.abort.signal,
            AbortSignal.timeout(PROXY_TIMEOUT_MS),
          ]);
          signal.addEventListener(
            "abort",
            () => {
              body.abort(new Error("OpenCode office request aborted."));
              // A response already partly written cannot be replaced by a 502.
              // Bound a stalled reader too, and release its queued response.
              if (socket.data.writer?.draining) {
                socket.data.writer.close();
                socket.terminate();
              }
            },
            { once: true },
          );
          let initial: Buffer | null = buffer.subarray(headEnd + 4);
          void this.proxy(
            request,
            socket.data.peer,
            body.stream,
            signal,
            () => {
              const readBody = () => {
                body.admit(initial!);
                initial = null;
              };
              // Other Expect values are ignored. Never forward Expect upstream.
              if (
                request.headers.get("expect")?.toLowerCase() === "100-continue"
              )
                socket.data.writer!.interim(
                  Buffer.from("HTTP/1.1 100 Continue\r\n\r\n"),
                  readBody,
                );
              else readBody();
            },
          ).then(
            (response) => {
              body.abort(new Error("OpenCode office request finished."));
              socket.data.writer!.send(response);
            },
            () => {
              body.abort(new Error("OpenCode office request failed."));
              socket.data.writer!.send(
                httpResponse(502, "OpenCode office request failed."),
              );
            },
          );
        },
        drain: (socket) => {
          socket.data.writer?.drain();
        },
        close: (socket) => {
          socket.data.writer?.close();
          socket.data.abort.abort();
        },
        error: (socket) => {
          socket.data.writer?.close();
          socket.data.abort.abort();
        },
      },
    });
    // A process needs write permission on a socket to connect. Until this
    // chmod the socket is closed to the group, the safe direction.
    if (this.split) chmodSync(this.socketPath, 0o660);
  }

  private readPeer(fd: number): PeerIdentity | null {
    const credentials = this.readers.readPeerCredentials(fd);
    if (!credentials) return null;
    const hop = this.readers.readProcessHop(credentials.pid);
    return hop ? { ...credentials, startTicks: hop.startTicks } : null;
  }

  private async proxy(
    request: RequestHead,
    peer: PeerIdentity | null,
    requestBody: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    admit: () => void,
  ): Promise<Buffer> {
    const handle = request.headers.get("x-isomux-turn") ?? "";
    const turn = this.turns.get(handle);
    const ancestry = peer
      ? readVerifiedAncestry(peer, (pid) => this.readers.readProcessHop(pid))
      : null;
    const ancestryText =
      ancestry?.map((hop) => `${hop.pid}:${hop.startTicks}`).join(",") ??
      "refused";
    console.info(
      `[opencode-office-proxy] agent=${turn?.agentId ?? "unknown"} peer=${peer?.pid ?? "unknown"} ancestry=${ancestryText} method=${request.method} path=${request.url.pathname}`,
    );
    if (peer?.uid !== this.expectedUid || !turn || !ancestry)
      return httpResponse(403, ancestryFailureMessage(ancestry));
    const serverHop = ancestry.find((hop) => hop.pid === turn.serverPid);
    if (!serverHop || serverHop.startTicks !== turn.serverStartTicks)
      return httpResponse(403, ancestryFailureMessage(ancestry));
    if (turn.calls >= MAX_CALLS_PER_TURN)
      return httpResponse(
        429,
        "OpenCode office call limit reached for this turn.",
      );
    const matched = matchRoute(
      API_ROUTES,
      request.method,
      request.url.pathname,
    );
    // Discovery is the only agent endpoint outside API_ROUTES.
    const manifest =
      request.method === "GET" && request.url.pathname === "/agents";
    if (
      !manifest &&
      (!matched || !passesRouteStageOne(matched.route.auth, AGENT_CEILING))
    )
      return httpResponse(
        403,
        "This Isomux API route is not available through OpenCode.",
      );
    turn.calls += 1;
    const upstream = new URL(request.url.pathname, this.upstreamOrigin);
    for (const [name, value] of request.url.searchParams)
      upstream.searchParams.append(name, value);
    const contentType = request.headers.get("content-type");
    admit();
    const response = await fetch(upstream, {
      method: request.method,
      headers: {
        authorization: `Bearer ${turn.token}`,
        ...(contentType !== null ? { "content-type": contentType } : {}),
        ...(request.contentLength
          ? { "content-length": String(request.contentLength) }
          : {}),
      },
      body: request.contentLength ? requestBody : undefined,
      signal,
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
      response.headers.get("content-type") ?? undefined,
    );
  }
}

// On the bytes, not on decoded text: an image (GET /api/apps/:name/thumbnail)
// passes unchanged, and a text body gets the same result as a string replace,
// because the token is ASCII.
function scrubToken(body: Buffer, token: string): Buffer {
  const needle = Buffer.from(token);
  if (needle.length === 0) return body;
  const parts: Buffer[] = [];
  let from = 0;
  for (
    let at = body.indexOf(needle);
    at !== -1;
    at = body.indexOf(needle, from)
  ) {
    parts.push(body.subarray(from, at), REDACTED);
    from = at + needle.length;
  }
  if (from === 0) return body;
  parts.push(body.subarray(from));
  return Buffer.concat(parts);
}

const REDACTED = Buffer.from("[REDACTED]");

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

function readVerifiedAncestry(
  peer: PeerIdentity,
  readHop: (pid: number) => ProcessHop | null,
): ProcessHop[] | null {
  const hops: ProcessHop[] = [];
  let current = peer.pid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current > 1; depth++) {
    const hop = readHop(current);
    if (!hop) return null;
    hops.push(hop);
    current = hop.parentPid;
  }
  if (current > 1) return null;
  // The walk must start at the process that connected. If it exited and its
  // pid was reused before the request arrived, start ticks differ.
  if (hops[0]?.startTicks !== peer.startTicks) return null;
  // Every hop is read again after the walk. If a process exits or a pid is
  // reused during the walk, start ticks differ and the request fails closed.
  for (const hop of hops) {
    if (readHop(hop.pid)?.startTicks !== hop.startTicks) return null;
  }
  return hops;
}

export const openCodeAuthorityBroker = new OpenCodeAuthorityBroker();
