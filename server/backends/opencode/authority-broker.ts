import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { openCodeAuthoritySocketPath } from "./office-proxy-shared.ts";
import { readProcessHop, type ProcessHop } from "./process-identity.ts";
import {
  httpResponse,
  parseHttpRequest,
  readPeerCredentials,
  socketFileDescriptor,
  type ParsedRequest,
} from "../../unix-socket-server.ts";

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

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CALLS_PER_TURN = 32;
const MAX_ANCESTRY_DEPTH = 32;
const PROXY_TIMEOUT_MS = 30_000;
const PORT = process.env.PORT || "4000";

const ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/agents$/ },
  { method: "GET", path: /^\/api\/agent-reference(?:\/[^/]+)?$/ },
  { method: "GET", path: /^\/api\/tasks$/ },
  { method: "POST", path: /^\/api\/tasks$/ },
  { method: "PATCH", path: /^\/api\/tasks\/[^/]+$/ },
  { method: "POST", path: /^\/api\/tasks\/[^/]+\/(claim|done)$/ },
  { method: "GET", path: /^\/api\/pager(?:\/[^/]+)?$/ },
  { method: "POST", path: /^\/api\/pager(?:\/[^/]+\/(ack|resolve))?$/ },
  {
    method: "GET",
    path: /^\/api\/agents\/[^/]+\/(context|subscription|logs|sessions|instructions|scheduled-messages)$/,
  },
  {
    method: "POST",
    path: /^\/api\/agents\/[^/]+\/(messages|read-file|preview-url|browser|diff|edit-file|terminal-command|resume|new-conversation|handoff|send-now|abort|move|revive)$/,
  },
  { method: "PATCH", path: /^\/api\/agents\/[^/]+(?:\/messages\/[^/]+)?$/ },
  {
    method: "DELETE",
    path: /^\/api\/agents\/[^/]+(?:\/queue\/[^/]+|\/scheduled-messages\/[^/]+)?$/,
  },
  { method: "POST", path: /^\/api\/agents$/ },
  {
    method: "GET",
    path: /^\/api\/apps(?:\/[^/]+(?:\/logs|\/thumbnail)?)?$/,
  },
  {
    method: "POST",
    path: /^\/api\/apps(?:\/[^/]+\/(restart|start|stop|archive|unarchive))?$/,
  },
  { method: "PATCH", path: /^\/api\/apps\/[^/]+$/ },
  { method: "PUT", path: /^\/api\/apps\/[^/]+\/thumbnail$/ },
  { method: "DELETE", path: /^\/api\/apps\/[^/]+$/ },
  {
    method: "GET",
    path: /^\/api\/webhooks(?:\/[^/]+(?:\/deliveries)?)?$/,
  },
  { method: "POST", path: /^\/api\/webhooks(?:\/[^/]+\/dry-run)?$/ },
  { method: "PATCH", path: /^\/api\/webhooks\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/webhooks\/[^/]+$/ },
  { method: "GET", path: /^\/api\/memory$/ },
  { method: "POST", path: /^\/api\/memory$/ },
  { method: "PUT", path: /^\/api\/memory$/ },
  { method: "POST", path: /^\/api\/rooms$/ },
  { method: "PATCH", path: /^\/api\/rooms\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/rooms\/[^/]+$/ },
  { method: "GET", path: /^\/api\/rooms\/[^/]+\/settings$/ },
  { method: "PUT", path: /^\/api\/rooms\/[^/]+\/settings$/ },
  { method: "POST", path: /^\/api\/rooms\/[^/]+\/swap-desks$/ },
  { method: "POST", path: /^\/api\/users$/ },
  {
    method: "GET",
    path: /^\/api\/cronjobs(?:\/[^/]+(?:\/runs(?:\/[^/]+)?)?)?$/,
  },
  { method: "POST", path: /^\/api\/cronjobs(?:\/[^/]+\/runs)?$/ },
  { method: "PATCH", path: /^\/api\/cronjobs\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/cronjobs\/[^/]+$/ },
  { method: "GET", path: /^\/api\/cron-runs$/ },
  { method: "POST", path: /^\/api\/api-token-inboxes\/[^/]+\/messages$/ },
  { method: "GET", path: /^\/api\/members-chat$/ },
  { method: "POST", path: /^\/api\/members-chat$/ },
  { method: "PATCH", path: /^\/api\/members-chat\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/members-chat\/[^/]+$/ },
  { method: "PUT", path: /^\/api\/members-chat\/[^/]+\/thumbs-up$/ },
];

export class OpenCodeAuthorityBroker {
  private readonly turns = new Map<string, TurnBinding>();
  private server: ReturnType<typeof Bun.listen<ConnectionData>> | null = null;

  constructor(
    private readonly socketPath = openCodeAuthoritySocketPath(),
    private readonly expectedUid = process.getuid?.() ?? -1,
    private readonly upstreamOrigin = `http://127.0.0.1:${PORT}`,
    private readonly readers = HOST_PROCESS_READERS,
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
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    rmSync(this.socketPath, { force: true });
    this.server = Bun.listen<ConnectionData>({
      unix: this.socketPath,
      data: {
        peer: null,
        buffer: Buffer.alloc(0),
        handled: false,
      },
      socket: {
        open: (socket) => {
          const fd = socketFileDescriptor(socket);
          socket.data = {
            peer: fd === null ? null : this.readPeer(fd),
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
            request = parseHttpRequest(socket.data.buffer, MAX_REQUEST_BYTES);
          } catch {
            socket.data.handled = true;
            socket.end(httpResponse(400, "Invalid OpenCode office request."));
            return;
          }
          if (!request) return;
          socket.data.handled = true;
          void this.proxy(request, socket.data.peer).then(
            (response) => socket.end(response),
            () =>
              socket.end(httpResponse(502, "OpenCode office request failed.")),
          );
        },
      },
    });
  }

  private readPeer(fd: number): PeerIdentity | null {
    const credentials = this.readers.readPeerCredentials(fd);
    if (!credentials) return null;
    const hop = this.readers.readProcessHop(credentials.pid);
    return hop ? { ...credentials, startTicks: hop.startTicks } : null;
  }

  private async proxy(
    request: ParsedRequest,
    peer: PeerIdentity | null,
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
