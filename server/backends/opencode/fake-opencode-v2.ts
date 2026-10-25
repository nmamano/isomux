// Test support: an OpenCode 2.1.4 server stand-in behind a fetch spy, for the
// transport and adapter tests. It serves the /api routes the transport uses
// with the response shapes a real 2.1.4 server sent on 2026-10-25 (task
// e47be82a), and it plays the recorded /api/event frames of fixtures/v2.
// Nothing here is product code.
import { spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenCodeSupervisor } from "./supervisor.ts";
import type { AgentMcpServer } from "../../mcp-servers.ts";
import { openCodeSafetyPluginDir } from "./profile-paths.ts";
import { OPENCODE_SAFETY_PLUGIN_ID } from "./safety-plugin-tool.ts";

// Port 1 refuses connections, so a request the spy does not answer fails.
export const FAKE_BASE_URL = "http://127.0.0.1:1";
export const FAKE_PROFILE = "/fake-profile";
// The folder the fixtures were rewritten to.
export const FAKE_CWD = "/work/repo";
export const FAKE_SESSION = "ses_fake";

export interface Frame {
  id?: string;
  created?: number;
  type: string;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export function loadFixture(name: string): Frame[] {
  return readFileSync(
    join(import.meta.dir, "fixtures", "v2", `${name}.jsonl`),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Frame);
}

function frameSession(frame: Frame): string | undefined {
  const data = frame.data ?? {};
  if (typeof data.sessionID === "string") return data.sessionID;
  const form = data.form as { sessionID?: unknown } | undefined;
  return typeof form?.sessionID === "string" ? form.sessionID : undefined;
}

// The recorded agent session: the first session created without a parent.
export function fixtureSession(frames: Frame[]): string {
  const created = frames.find(
    (frame) => frame.type === "session.created" && !frame.data.parentID,
  );
  if (created) return created.data.sessionID as string;
  // A recording that starts after the session was created.
  const input = frames.find((frame) => frame.type === "session.inbox.enqueued");
  if (!input) throw new Error("The fixture names no agent session.");
  return input.data.sessionID as string;
}

const TERMINAL = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

// The fixture's busy periods of its agent session. Turn n runs from after the
// previous terminal frame of that session to its own terminal frame.
export function fixtureTurns(frames: Frame[]): Frame[][] {
  const session = fixtureSession(frames);
  const turns: Frame[][] = [];
  let current: Frame[] = [];
  for (const frame of frames) {
    if (frame.type === "session.created" && !frame.data.parentID) continue;
    current.push(frame);
    if (TERMINAL.has(frame.type) && frameSession(frame) === session) {
      turns.push(current);
      current = [];
    }
  }
  return turns;
}

// Replaces ids in every string of the frames (a frame is plain JSON).
export function rewriteFrames(
  frames: Frame[],
  ids: Record<string, string>,
): Frame[] {
  return frames.map((frame) => {
    let text = JSON.stringify(frame);
    for (const [from, to] of Object.entries(ids))
      text = text.replaceAll(from, to);
    return JSON.parse(text) as Frame;
  });
}

export function sse(frame: object): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

export const HEARTBEAT = ": heartbeat\n\n";
const CONNECTED = `${sse({ id: "evt_connected", type: "server.connected", data: {} })}${HEARTBEAT}`;

// One turn the fake plays when a prompt arrives.
export interface FakeTurn {
  // The frames, with the recorded session and input ids. The fake swaps them
  // for the live session id and the id its prompt answer gave.
  frames: Frame[];
  // The recorded ids to swap. Defaults: the frames' agent session and the
  // first input that session received.
  session?: string;
  inbox?: string;
  // The frames up to and including this index go out before the prompt
  // answer, as a server can send them.
  beforeAnswer?: number;
  // The fake waits for POST /interrupt before the first frame this matches.
  interruptBefore?: (frame: Frame) => boolean;
  // false: play on without waiting for each permission reply.
  waitForReplies?: boolean;
}

export function fixtureTurn(
  name: string,
  index = 0,
  options: Omit<FakeTurn, "frames" | "session"> = {},
): FakeTurn {
  const frames = loadFixture(name);
  return {
    frames: fixtureTurns(frames)[index],
    session: fixtureSession(frames),
    ...options,
  };
}

type Route =
  | "info"
  | "session.create"
  | "session.get"
  | "session.patch"
  | "session.agent"
  | "session.active"
  | "session.list"
  | "messages"
  | "prompt"
  | "instructions"
  | "model.select"
  | "interrupt"
  | "fork"
  | "delete"
  | "permission.list"
  | "permission.request"
  | "reply"
  | "catalog"
  | "provider"
  | "plugin"
  | "config"
  | "mcp.list"
  | "mcp.add"
  | "mcp.remove"
  | "session.environment"
  | "event";

export interface FakeOptions {
  sessionId?: string;
  // The id of each new session; default: sessionId.
  nextSessionId?: () => string;
  // Rows of GET /api/plugin. Default: the Isomux plugin, active.
  plugins?: () => unknown[];
  // Entries of GET /api/config, lowest layer first. Default: the member's
  // config folder, the profile's opencode.json and Isomux's top layer.
  config?: () => unknown[];
  // MCP server names each folder has from config before any run-time add.
  // Default: none.
  mcpServers?: (directory: string) => string[];
  // Rows of GET /api/model. Default: provider/model, with variants.
  models?: () => unknown[];
  // Rows of GET /api/provider. Default: provider, enabled.
  providers?: () => unknown[];
  // GET /api/session/:id data.
  session?: () => Record<string, unknown>;
  // GET /api/session/active data.
  active?: () => Record<string, unknown>;
  // Items of GET /api/session/:id/message, oldest first.
  messages?: () => unknown[];
  // Items of GET /api/session/:id/permission.
  permissions?: () => unknown[];
  // Items of GET /api/permission/request: every open request in the
  // folder, of any session.
  permissionRequests?: () => unknown[];
  // GET /api/session/:id data of other sessions, by id (a child carries
  // parentID).
  sessionsById?: Record<string, Record<string, unknown>>;
  // An HTTP error status per route.
  status?: Partial<Record<Route, number>>;
  // "first": only the first request of the route; "later": every one after it.
  hold?: Partial<Record<Route, "always" | "first" | "later">>;
  // How GET /api/info answers. A frozen server accepts the connection and
  // never answers; a killed one that is not reaped yet refuses it.
  health?: "healthy" | "silent" | "refused";
  // Turns played in order, one per prompt.
  turns?: FakeTurn[];
  // An answer of the test's own for a request, before the route's: return
  // undefined to let the route answer.
  override?: (
    route: Route,
    request: {
      url: URL;
      init?: RequestInit;
      emit: (...frames: object[]) => void;
    },
  ) => Response | Promise<Response> | undefined;
}

export const failure = Object.assign(new Error("stream failed"), {
  code: "ECONNRESET",
});

export function ourPluginRow(
  status = "active",
  profileDir = FAKE_PROFILE,
): Record<string, unknown> {
  return {
    id: status === "active" ? OPENCODE_SAFETY_PLUGIN_ID : null,
    source: {
      type: "local",
      path:
        status === "active"
          ? join(openCodeSafetyPluginDir(profileDir), "index.js")
          : openCodeSafetyPluginDir(profileDir),
    },
    features: { server: true },
    state: { status },
  };
}

// GET /api/config as 2.1.4 answers it (pm-p1-observed.json, 2026-10-25):
// the top layer, OPENCODE_CONFIG_CONTENT, is the one document without a path.
export function configEntries(
  topLayer: Record<string, unknown> | null = {
    agents: { "isomux-cron": { mode: "primary" } },
  },
): unknown[] {
  return [
    { type: "directory", path: "/fake-member/opencode" },
    {
      type: "document",
      path: `${FAKE_PROFILE}/opencode.json`,
      info: { agents: { "isomux-cron": { mode: "primary" } } },
    },
    ...(topLayer ? [{ type: "document", info: topLayer }] : []),
  ];
}

export function builtinPluginRow(id: string): Record<string, unknown> {
  return {
    id,
    source: { type: "builtin" },
    features: { server: true },
    state: { status: "active" },
  };
}

export function modelRow(
  providerID: string,
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
    cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 10_000 },
    ...extra,
  };
}

export function fakeOpenCode(options: FakeOptions = {}) {
  const sessionId = options.sessionId ?? FAKE_SESSION;
  const requests: FakeRequest[] = [];
  const counts = new Map<Route, number>();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const turns = [...(options.turns ?? [])];
  const replies: { session: string; id: string; body: unknown }[] = [];
  const replyWaiters = new Map<string, () => void>();
  let interrupts = 0;
  const interruptWaiters: (() => void)[] = [];
  const held = new Map<Route, (() => void)[]>();
  let promptCount = 0;
  // The MCP servers of each folder: its config's, plus run-time adds, minus
  // run-time removes (core/src/mcp/index.ts:730-744).
  const mcpByFolder = new Map<string, Set<string>>();
  const mcpOf = (directory: string) => {
    let names = mcpByFolder.get(directory);
    if (!names) {
      names = new Set(options.mcpServers?.(directory) ?? []);
      mcpByFolder.set(directory, names);
    }
    return names;
  };
  // Each session's agent: set at create, changed by PATCH.
  const agents = new Map<string, string>();
  // Every prompt, with the agent its session had when it arrived.
  const promptLog: { session: string; text: unknown; agent: string }[] = [];
  const playing: Promise<void>[] = [];
  const encoder = new TextEncoder();
  // Frames emitted while no stream is open are lost, as on /api/event.
  const write = (text: string) => {
    for (const stream of streams) {
      try {
        stream.enqueue(encoder.encode(text));
      } catch {
        streams.delete(stream);
      }
    }
  };
  const emit = (...frames: object[]) => {
    for (const frame of frames) write(sse(frame));
  };
  // Held until the request is aborted, as a frozen server holds it, or
  // answered late by release().
  const hold = (
    route: Route,
    init: RequestInit | undefined,
    answer: () => Promise<Response>,
  ) =>
    new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
      const list = held.get(route) ?? [];
      list.push(() => void answer().then(resolve, reject));
      held.set(route, list);
    });
  const shouldHold = (route: Route): boolean => {
    const mode = options.hold?.[route];
    const n = counts.get(route) ?? 0;
    return (
      mode === "always" ||
      (mode === "first" && n === 1) ||
      (mode === "later" && n > 1)
    );
  };
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  // interruptsBefore: the interrupt count when the prompt arrived. An
  // interrupt after it releases the turn's interrupt waits.
  async function play(
    turn: FakeTurn,
    session: string,
    inboxId: string,
    emitFrom: number,
    interruptsBefore: number,
  ) {
    const interrupted = () =>
      interrupts > interruptsBefore
        ? Promise.resolve()
        : new Promise<void>((resolve) => interruptWaiters.push(resolve));
    const recordedSession = turn.session ?? fixtureSession(turn.frames);
    const recordedInbox =
      turn.inbox ??
      (turn.frames.find(
        (frame) =>
          frame.type === "session.inbox.enqueued" &&
          frame.data.sessionID === recordedSession,
      )?.data.inboxID as string | undefined);
    const frames = rewriteFrames(turn.frames, {
      [recordedSession]: session,
      ...(recordedInbox ? { [recordedInbox]: inboxId } : {}),
    });
    for (const frame of frames.slice(emitFrom)) {
      if (turn.interruptBefore?.(frame)) await interrupted();
      emit(frame);
      await tick();
      if (frame.type === "permission.asked" && turn.waitForReplies !== false)
        await replied(frame.data.id as string);
      if (frame.type === "form.created") await interrupted();
    }
  }
  const replied = (id: string) =>
    replies.some((reply) => reply.id === id)
      ? Promise.resolve()
      : new Promise<void>((resolve) => replyWaiters.set(id, resolve));
  // The frames of a turn that go out before the prompt answer.
  const preparePrompt = (
    turn: FakeTurn | undefined,
    session: string,
    inboxId: string,
  ) => {
    if (!turn || turn.beforeAnswer === undefined) return 0;
    const recordedSession = turn.session ?? fixtureSession(turn.frames);
    const recordedInbox =
      turn.inbox ??
      (turn.frames.find(
        (frame) =>
          frame.type === "session.inbox.enqueued" &&
          frame.data.sessionID === recordedSession,
      )?.data.inboxID as string | undefined);
    const early = rewriteFrames(turn.frames.slice(0, turn.beforeAnswer + 1), {
      [recordedSession]: session,
      ...(recordedInbox ? { [recordedInbox]: inboxId } : {}),
    });
    emit(...early);
    return turn.beforeAnswer + 1;
  };

  const json = (value: unknown, status = 200) =>
    Response.json(value, { status });

  async function route(
    method: string,
    url: URL,
    init: RequestInit | undefined,
  ): Promise<{ route: Route; respond: () => Promise<Response> } | null> {
    const path = url.pathname;
    const parts = path.split("/").map(decodeURIComponent);
    // ["", "api", ...]
    if (parts[1] !== "api") return null;
    const rest = parts.slice(2);
    const r = (name: Route, respond: () => Promise<Response> | Response) => ({
      route: name,
      respond: async () => respond(),
    });
    if (method === "GET" && path === "/api/info")
      return r("info", () =>
        json({ version: "2.1.4", pid: 4242, urls: [FAKE_BASE_URL] }),
      );
    if (method === "GET" && path === "/api/event")
      return r(
        "event",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streams.add(controller);
                controller.enqueue(encoder.encode(CONNECTED));
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    streams.delete(controller);
                    try {
                      controller.close();
                    } catch {
                      /* Already failed or closed. */
                    }
                  },
                  { once: true },
                );
              },
              cancel() {
                // The reader let go of this stream.
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
    if (method === "GET" && path === "/api/model")
      return r("catalog", () =>
        json({
          location: { directory: url.searchParams.get("location[directory]") },
          data: options.models?.() ?? [modelRow("provider", "model")],
        }),
      );
    if (method === "GET" && path === "/api/provider")
      return r("provider", () =>
        json({
          location: { directory: url.searchParams.get("location[directory]") },
          data: options.providers?.() ?? [
            { id: "provider", name: "Provider", activation: "enabled" },
          ],
        }),
      );
    if (method === "GET" && path === "/api/plugin")
      return r("plugin", () =>
        json({
          location: { directory: url.searchParams.get("location[directory]") },
          data: options.plugins?.() ?? [
            builtinPluginRow("opencode.agent"),
            ourPluginRow(),
          ],
        }),
      );
    if (method === "GET" && path === "/api/mcp") {
      const directory = url.searchParams.get("location[directory]") ?? "";
      return r("mcp.list", () =>
        json({
          location: { directory },
          data: [...mcpOf(directory)].map((name) => ({
            name,
            status: { status: "connected" },
          })),
        }),
      );
    }
    if (rest[0] === "experimental" && rest[1] === "mcp" && rest.length === 3) {
      const directory = url.searchParams.get("location[directory]") ?? "";
      if (method === "PUT")
        return r("mcp.add", () => {
          mcpOf(directory).add(rest[2]);
          return new Response(null, { status: 204 });
        });
      if (method === "DELETE")
        return r("mcp.remove", () =>
          mcpOf(directory).delete(rest[2])
            ? new Response(null, { status: 204 })
            : json({ _tag: "McpServerNotFoundError" }, 404),
        );
    }
    // A bare array: config.get has no location wrapper.
    if (method === "GET" && path === "/api/config")
      return r("config", () => json(options.config?.() ?? configEntries()));
    if (method === "GET" && path === "/api/permission/request")
      return r("permission.request", () =>
        json({
          location: { directory: url.searchParams.get("location[directory]") },
          data: options.permissionRequests?.() ?? [],
        }),
      );
    if (rest[0] !== "session") return null;
    if (method === "POST" && rest.length === 1)
      return r("session.create", () => {
        const id = options.nextSessionId?.() ?? sessionId;
        const body = bodyOf(init) as
          | { agent?: unknown; location?: { directory?: unknown } }
          | undefined;
        const agent = typeof body?.agent === "string" ? body.agent : "build";
        agents.set(id, agent);
        return json({
          data: {
            id,
            agent,
            time: { created: 1, updated: 1 },
            location: { directory: body?.location?.directory ?? FAKE_CWD },
          },
        });
      });
    if (method === "GET" && rest.length === 1)
      return r("session.list", () => json({ data: [] }));
    if (method === "GET" && rest[1] === "active")
      return r("session.active", () =>
        json({ data: options.active?.() ?? {} }),
      );
    const id = rest[1];
    if (method === "GET" && rest.length === 2)
      return r("session.get", () =>
        json({
          data: {
            id,
            agent: agents.get(id) ?? "build",
            time: { created: 1, updated: 1 },
            ...(options.sessionsById?.[id] ??
              (id === sessionId ? (options.session?.() ?? {}) : {})),
          },
        }),
      );
    if (method === "PATCH" && rest.length === 2)
      return r("session.patch", () => new Response(null, { status: 204 }));
    if (method === "DELETE" && rest.length === 2)
      return r("delete", () => new Response(null, { status: 204 }));
    if (method === "GET" && rest[2] === "message")
      return r("messages", () => {
        const items = options.messages?.() ?? [];
        // Pages of `limit` items; the cursor is the next index.
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const cursor = url.searchParams.get("cursor");
        if (cursor !== null && url.searchParams.has("order"))
          return json(
            {
              _tag: "BadRequest",
              message: "cursor cannot be combined with order",
            },
            400,
          );
        const start = cursor === null ? 0 : Number(cursor);
        const page = items.slice(start, start + limit);
        const next =
          start + limit < items.length ? String(start + limit) : null;
        return json({
          data: page,
          cursor: { ...(next ? { next } : {}) },
        });
      });
    if (method === "POST" && rest[2] === "prompt")
      return r("prompt", async () => {
        promptCount++;
        const inboxId = `msg_input_${promptCount}`;
        promptLog.push({
          session: id,
          text: (bodyOf(init) as { text?: unknown } | undefined)?.text,
          agent: agents.get(id) ?? "build",
        });
        const turn = turns.shift();
        const emitFrom = preparePrompt(turn, id, inboxId);
        // The early frames reach the stream reader before the answer does.
        if (emitFrom > 0) await settleUntil(() => false, 20);
        const interruptsBefore = interrupts;
        if (turn) {
          const run = (async () => {
            await tick();
            await play(turn, id, inboxId, emitFrom, interruptsBefore);
          })();
          playing.push(run);
        }
        return json({
          data: {
            id: inboxId,
            sessionID: id,
            time: { created: 1 },
            type: "user",
            payload: { text: (bodyOf(init) as { text?: unknown })?.text },
            delivery: "steer",
          },
        });
      });
    // 2.1.4 changes a session's agent here; PATCH ignores an agent field
    // (2026-10-25).
    if (method === "POST" && rest[2] === "agent")
      return r("session.agent", () => {
        const body = bodyOf(init) as { agent?: unknown } | undefined;
        if (typeof body?.agent === "string") agents.set(id, body.agent);
        return new Response(null, { status: 204 });
      });
    if (method === "POST" && rest[2] === "model")
      return r("model.select", () => new Response(null, { status: 204 }));
    if (method === "PUT" && rest[2] === "environment" && rest.length === 3)
      return r(
        "session.environment",
        () => new Response(null, { status: 204 }),
      );
    if (method === "POST" && rest[2] === "interrupt")
      return r("interrupt", () => {
        interrupts++;
        interruptWaiters.splice(0).forEach((resolve) => resolve());
        return json({ interrupted: true });
      });
    if (method === "POST" && rest[2] === "fork")
      return r("fork", () =>
        json({
          data: {
            id: `${id}_fork`,
            fork: { sessionID: id },
            time: { created: 2, updated: 2 },
          },
        }),
      );
    if (method === "GET" && rest[2] === "permission" && rest.length === 3)
      return r("permission.list", () =>
        json({ data: options.permissions?.() ?? [] }),
      );
    if (method === "POST" && rest[2] === "permission" && rest[4] === "reply")
      return r("reply", () => {
        const requestId = rest[3];
        replies.push({ session: id, id: requestId, body: bodyOf(init) });
        replyWaiters.get(requestId)?.();
        replyWaiters.delete(requestId);
        return new Response(null, { status: 204 });
      });
    return null;
  }

  const originalFetch = globalThis.fetch;
  let restored = false;
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== FAKE_BASE_URL) return originalFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body: bodyOf(init),
    });
    // PUT /api/experimental/session/:id/instructions/entries/:key
    const instructions =
      method === "PUT" &&
      /^\/api\/experimental\/session\/[^/]+\/instructions\/entries\/[^/]+$/.test(
        url.pathname,
      );
    const matched = instructions
      ? {
          route: "instructions" as Route,
          respond: async () => new Response(null, { status: 204 }),
        }
      : await route(method, url, init);
    if (!matched) return json({ message: "not found" }, 404);
    counts.set(matched.route, (counts.get(matched.route) ?? 0) + 1);
    if (matched.route === "info") {
      const health = options.health ?? "healthy";
      if (health === "silent")
        return hold("info", init, async () => json({ version: "2.1.4" }));
      if (health === "refused")
        throw Object.assign(new TypeError("Unable to connect."), {
          code: "ConnectionRefused",
        });
    }
    const custom = options.override?.(matched.route, { url, init, emit });
    if (custom) return custom;
    const status = options.status?.[matched.route];
    if (status) return json({ message: "failed" }, status);
    if (shouldHold(matched.route))
      return hold(matched.route, init, matched.respond);
    return matched.respond();
  }) as typeof fetch);

  return {
    sessionId,
    requests,
    // The requests of one route, by method and path pattern.
    calls: (method: string, pattern: RegExp) =>
      requests.filter(
        (request) => request.method === method && pattern.test(request.path),
      ),
    replies,
    promptLog,
    interrupts: () => interrupts,
    // Prompts the transport sent, answered or not.
    prompts: () => counts.get("prompt") ?? 0,
    // The folder lost its run-time MCP servers (a rebuilt location).
    forgetMcp: (directory: string) => mcpByFolder.delete(directory),
    // Plays one more turn at the next prompt.
    queue: (turn: FakeTurn) => turns.push(turn),
    emit,
    heartbeat: () => write(HEARTBEAT),
    openStreams: () => streams.size,
    // The stream breaks while the server still answers.
    failStreams: () => {
      for (const stream of streams) stream.error(failure);
      streams.clear();
    },
    // The stream ends cleanly.
    endStreams: () => {
      for (const stream of streams) stream.close();
      streams.clear();
    },
    release: (route: Route) =>
      (held.get(route) ?? []).splice(0).forEach((answer) => answer()),
    heldCount: (route: Route) => (held.get(route) ?? []).length,
    count: (route: Route) => counts.get(route) ?? 0,
    // Every scripted turn played to its end.
    played: () => Promise.all(playing),
    // Idempotent: a test can end one fake before it starts the next.
    restore: () => {
      if (restored) return;
      restored = true;
      spy.mockRestore();
    },
  };
}

export type FakeOpenCode = ReturnType<typeof fakeOpenCode>;

function bodyOf(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") return undefined;
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

export interface FakeLeaseOptions {
  pid?: number;
  serverKey?: () => string;
  replacementPending?: boolean;
  launchVariables?: string[];
  // The supervisor's current Isomux MCP servers.
  mcpServers?: () => AgentMcpServer[];
  serverStopped?: () => boolean;
  recoveryBlocked?: boolean;
  onBeginTurn?: () => void;
  onRecover?: () => void;
}

// The fake supervisor's tool environment: each value marked, so a test can
// tell it from the env it was given.
export function fakeToolEnvironment(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {})
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => [name, `tool:${value}`]),
  );
}

// A supervisor whose lease points at the fake.
export function fakeSupervisor(options: FakeLeaseOptions = {}) {
  const marked: { pid: number; afterPrompt: boolean }[] = [];
  let acquires = 0;
  let releases = 0;
  let recoveries = 0;
  let turnsBegun = 0;
  let turnsEnded = 0;
  const supervisor = {
    profileDir: FAKE_PROFILE,
    toolEnvironment: fakeToolEnvironment,
    acquire: async () => {
      acquires++;
      return {
        pid: options.pid ?? 4242,
        baseUrl: FAKE_BASE_URL,
        authHeader: "Basic synthetic",
        profileDir: FAKE_PROFILE,
        get serverKey() {
          return options.serverKey?.() ?? "server-1";
        },
        replacementPending: options.replacementPending ?? false,
        get mcpServers() {
          return options.mcpServers?.() ?? [];
        },
        hasLaunchVariable: (name: string) =>
          (options.launchVariables ?? []).includes(name),
        settle: () => {},
        beginTurn: async () => {
          turnsBegun++;
          options.onBeginTurn?.();
        },
        recoverBeforePrompt: async () => {
          recoveries++;
          if (options.recoveryBlocked)
            throw new Error("guard: another turn is active");
          options.onRecover?.();
        },
        endTurn: () => {
          turnsEnded++;
        },
        serverStopped: () => options.serverStopped?.() ?? false,
        markUnresponsive: (pid: number, afterPrompt: boolean) =>
          marked.push({ pid, afterPrompt }),
        release: () => {
          releases++;
        },
      };
    },
  } as unknown as OpenCodeSupervisor;
  return {
    supervisor,
    marked,
    acquires: () => acquires,
    releases: () => releases,
    recoveries: () => recoveries,
    turnsBegun: () => turnsBegun,
    turnsEnded: () => turnsEnded,
  };
}

// A deadline scheduler that only fires when the test advances it.
export function drivenClock() {
  let now = 0;
  let nextId = 1;
  let arms = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  return {
    scheduler: {
      setTimeout: (callback: () => void, delayMs: number) => {
        const id = nextId++;
        arms++;
        timers.set(id, { due: now + delayMs, callback });
        return id;
      },
      clearTimeout: (id: unknown) => {
        timers.delete(id as number);
      },
    },
    arms: () => arms,
    pending: () => timers.size,
    advance(ms: number) {
      now += ms;
      const due = [...timers]
        .filter(([, timer]) => timer.due <= now)
        .sort(([, left], [, right]) => left.due - right.due);
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        timer.callback();
      }
    },
  };
}

// Event-loop turns, never wall-clock time.
export async function settleUntil(
  condition: () => boolean,
  turns = 200,
): Promise<void> {
  for (let turn = 0; turn < turns && !condition(); turn++)
    await new Promise((resolve) => setImmediate(resolve));
}

// Frames of one session, in the 2.1.4 shape, for tests that drive a turn by
// hand. `at` is the frame's created time.
export function framesOf(sessionID: string) {
  let clock = 1_000;
  const frame = (type: string, data: Record<string, unknown>, at?: number) => ({
    id: `evt_${type}_${clock}`,
    created: at ?? ++clock,
    type,
    data: { sessionID, ...data },
  });
  return {
    delivered: (inboxID: string, at?: number) =>
      frame("session.inbox.delivered", { inboxID }, at),
    stepStarted: (message: string) =>
      frame("session.step.started", {
        assistantMessageID: message,
        agent: "build",
      }),
    stepEnded: (
      message: string,
      tokens = {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    ) =>
      frame("session.step.ended", {
        assistantMessageID: message,
        finish: "stop",
        cost: 0,
        tokens,
      }),
    textDelta: (message: string, delta: string, ordinal = 0) =>
      frame("session.text.delta", {
        assistantMessageID: message,
        ordinal,
        delta,
      }),
    textEnded: (message: string, text: string, ordinal = 0) =>
      frame("session.text.ended", {
        assistantMessageID: message,
        ordinal,
        text,
      }),
    toolCalled: (message: string, id: string, name: string, input: object) => [
      frame("session.tool.input.started", {
        assistantMessageID: message,
        id,
        name,
      }),
      frame("session.tool.called", {
        assistantMessageID: message,
        id,
        input,
        executed: false,
      }),
    ],
    toolSuccess: (message: string, id: string, text: string) =>
      frame("session.tool.success", {
        assistantMessageID: message,
        id,
        content: [{ type: "text", text }],
        metadata: { status: "completed", exit: 0 },
        executed: false,
      }),
    retry: (message: string, attempt: number, errorMessage: string) =>
      frame("session.retry.scheduled", {
        assistantMessageID: message,
        attempt,
        at: clock + 1_000,
        error: { type: "provider.error", message: errorMessage, status: 503 },
      }),
    asked: (id: string, command: string) =>
      frame("permission.asked", {
        id,
        action: "shell",
        resources: [command],
        save: ["*"],
        source: { type: "tool", messageID: "msg_tool", id: "call_1" },
      }),
    succeeded: () => frame("session.execution.succeeded", {}),
    failed: (error: Record<string, unknown>) =>
      frame("session.execution.failed", { error }),
    interrupted: (reason: "user" | "shutdown") =>
      frame("session.execution.interrupted", { reason }),
    created: (child: string) => ({
      ...frame("session.created", { parentID: sessionID }),
      data: { sessionID: child, parentID: sessionID },
    }),
  };
}

// Items of GET /api/session/:id/message for hand-driven turns.
export const messageItems = {
  user: (id: string, text: string, created = 1) => ({
    id,
    time: { created },
    type: "user",
    text,
  }),
  assistant: (
    id: string,
    content: unknown[],
    options: { created?: number; finished?: boolean; tokens?: object } = {},
  ) => ({
    id,
    time: {
      created: options.created ?? 2,
      ...(options.finished === false
        ? {}
        : { completed: (options.created ?? 2) + 1 }),
    },
    type: "assistant",
    agent: "build",
    content,
    ...(options.finished === false
      ? {}
      : {
          finish: "stop",
          cost: 0,
          tokens: options.tokens ?? {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        }),
  }),
  idle: (id: string, outcome: string, created = 3) => ({
    id,
    time: { created },
    type: "idle",
    outcome,
  }),
};
