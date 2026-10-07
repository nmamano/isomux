import { afterEach, expect, it, spyOn } from "bun:test";
import { createOpenCodeBackend } from "./adapter.ts";
import {
  OPENCODE_SERVER_STOPPED_FAILURE,
  OPENCODE_SERVER_UNRESPONSIVE_FAILURE,
  OpenCodeTransport,
  type SafeOpenCodeError,
} from "./transport.ts";
import type { OpenCodeSupervisor } from "./supervisor.ts";
import type { NormalizedEvent } from "../types.ts";
import { createAgentManager } from "../../agent-manager.ts";
import { OfficeState } from "../../../shared/office-state.ts";
import { STATE_ROOT } from "../../config.ts";
import { join } from "node:path";

const CANARY = "LOCAL_FAILURE_HEADER_SECRET_CANARY";
const failure = Object.assign(new Error(`Authorization: Bearer ${CANARY}`), {
  code: "ConnectionRefused",
  headers: { authorization: CANARY },
});
type Stage =
  | "acquire"
  | "session"
  | "session-json"
  | "begin"
  | "events"
  | "body"
  | "reader"
  | "prompt"
  | "end"
  | "idle"
  | "race"
  | "close"
  | "late-permission";
let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function fixture(stage: Stage, onPrompt = () => {}) {
  let ended = 0;
  let prompts = 0;
  let recoveries = 0;
  let eventStream: ReadableStreamDefaultController | undefined;
  const permissionReplies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "http://127.0.0.1:1") return originalFetch(input, init);
    if (url.pathname === "/session") {
      if (stage === "session") return new Response(CANARY, { status: 503 });
      if (stage === "session-json") return new Response("{");
      return Response.json({ id: "failure-session" });
    }
    if (url.pathname === "/event") {
      if (stage === "events") return new Response(CANARY, { status: 502 });
      if (stage === "body") return new Response(null);
      return new Response(
        new ReadableStream({
          start(controller) {
            eventStream = controller;
            if (stage === "reader") controller.error(failure);
            else if (stage === "end") controller.close();
            else if (stage === "idle") {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"session.idle","properties":{"sessionID":"failure-session"}}\n\n',
                ),
              );
            }
            init?.signal?.addEventListener(
              "abort",
              () => {
                try {
                  controller.close();
                } catch {
                  /* Already failed or closed. */
                }
              },
              { once: true },
            );
          },
        }),
      );
    }
    if (url.pathname.endsWith("/prompt_async")) {
      prompts++;
      if (stage === "late-permission") {
        const response = new Response(null);
        Object.defineProperty(response, "ok", {
          get() {
            // Queue the reader before send() catches this response failure.
            // The permission handler's await resumes after that catch settles.
            eventStream!.enqueue(
              new TextEncoder().encode(
                'data: {"type":"permission.asked","properties":{"sessionID":"failure-session","id":"late","permission":"bash","patterns":["pwd"],"metadata":{"command":"pwd"}}}\n\n',
              ),
            );
            throw failure;
          },
        });
        return response;
      }
      if (stage === "race" || stage === "close") {
        if (stage === "race") eventStream!.error(failure);
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
          onPrompt();
        });
      }
      return new Response(CANARY, { status: 504 });
    }
    if (url.pathname === "/permission/late/reply") {
      if (typeof init?.body !== "string")
        throw new Error("Expected a JSON permission reply.");
      permissionReplies.push(JSON.parse(init.body));
    }
    if (url.pathname === "/provider")
      return Response.json({ all: [], connected: [] });
    return Response.json(true);
  }) as typeof fetch);
  restoreFetch = () => fetchSpy.mockRestore();
  const supervisor = {
    acquire: async () => {
      if (stage === "acquire") throw failure;
      return {
        pid: process.pid,
        baseUrl: "http://127.0.0.1:1",
        authHeader: "Basic synthetic",
        beginTurn: async () => {
          if (stage === "begin") throw failure;
        },
        recoverBeforePrompt: async () => {
          recoveries++;
        },
        endTurn: () => {
          ended++;
        },
        serverStopped: () => false,
        markUnresponsive: () => {},
        release: () => {},
      };
    },
  } as unknown as OpenCodeSupervisor;
  return {
    supervisor,
    ended: () => ended,
    prompts: () => prompts,
    recoveries: () => recoveries,
    permissionReplies,
  };
}

const cases: Array<[Stage, string, string, number | undefined]> = [
  ["acquire", "OpenCode turn failed", "Error", undefined],
  ["session", "OpenCode turn failed", "Error", 503],
  ["session-json", "OpenCode turn failed", "SyntaxError", undefined],
  ["begin", "OpenCode turn failed", "Error", undefined],
  ["events", "OpenCode turn failed", "Error", 502],
  ["body", "OpenCode turn failed", "Error", undefined],
  ["reader", "OpenCode event stream failed", "Error", undefined],
  ["prompt", "OpenCode turn failed", "Error", 504],
  [
    "end",
    "OpenCode event stream ended before turn completion",
    "Error",
    undefined,
  ],
  [
    "idle",
    "OpenCode became idle without a recorded completion",
    "Error",
    undefined,
  ],
  ["race", "OpenCode event stream failed", "Error", undefined],
];

for (const [stage, context, name, statusCode] of cases) {
  it(`reports ${stage} failure once with safe class and status`, async () => {
    const harness = fixture(stage);
    const errors: SafeOpenCodeError[] = [];
    const events: NormalizedEvent[] = [];
    const transport = new OpenCodeTransport({
      supervisor: harness.supervisor,
      cwd: STATE_ROOT,
      model: "provider/model",
      systemPrompt: "system",
      safeErrorSink: (error) => errors.push(error),
    });
    try {
      await transport.send([{ type: "text", text: "go" }], (event) =>
        events.push(event),
      );
      const code = ["acquire", "begin", "reader", "race"].includes(stage)
        ? "ConnectionRefused"
        : undefined;
      expect(errors, "safe error projection").toEqual([
        {
          name,
          ...(code ? { code } : {}),
          ...(statusCode === undefined ? {} : { statusCode }),
        },
      ]);
      expect(
        events.filter((event) => event.kind === "turn_completed"),
        "single failed completion",
      ).toEqual([
        {
          kind: "turn_completed",
          status: "failed",
          error: `${context} (${name}${code ? `/${code}` : ""}; HTTP status: ${statusCode ?? "unavailable"}).`,
        },
      ]);
      expect(
        JSON.stringify({ errors, events }),
        "no raw error fields",
      ).not.toContain(CANARY);
      expect(harness.ended(), "balanced turn lease").toBe(
        ["acquire", "session", "session-json", "begin"].includes(stage) ? 0 : 1,
      );
      expect(harness.prompts(), "no prompt after early failure").toBe(
        stage === "prompt" || stage === "race" ? 1 : 0,
      );
      expect(
        harness.recoveries(),
        "recovery stays before prompt submission",
      ).toBe(stage === "events" || stage === "body" ? 1 : 0);
    } finally {
      transport.close();
    }
  });
}

it("drops unreviewed exception fields and still settles if the error observer throws", async () => {
  const error = Object.assign(new Error(CANARY), {
    name: CANARY,
    code: CANARY,
    status: Infinity,
    headers: { secret: CANARY },
  });
  const errors: SafeOpenCodeError[] = [];
  const events: NormalizedEvent[] = [];
  const transport = new OpenCodeTransport({
    supervisor: {
      acquire: async () => {
        throw error;
      },
    } as unknown as OpenCodeSupervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
    systemPrompt: "system",
    safeErrorSink: (safe) => {
      errors.push(safe);
      throw new Error(CANARY);
    },
  });
  const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    await transport.send([{ type: "text", text: "go" }], (event) =>
      events.push(event),
    );
    expect(errors).toEqual([{ name: "UnknownError", code: "UnknownCode" }]);
    expect(events).toEqual([
      {
        kind: "turn_completed",
        status: "failed",
        error:
          "OpenCode turn failed (UnknownError/UnknownCode; HTTP status: unavailable).",
      },
    ]);
    expect(consoleSpy.mock.calls).toEqual([["OpenCode error sink failed."]]);
  } finally {
    consoleSpy.mockRestore();
    transport.close();
  }
});

it("retries one refused event subscription before submitting one prompt, then reports the fixture's idle failure", async () => {
  let subscriptions = 0;
  let recoveries = 0;
  let prompts = 0;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const originalFetch = globalThis.fetch;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/session")
      return Response.json({ id: "recovered-session" });
    if (url.pathname === "/provider")
      return Response.json({ all: [], connected: [] });
    if (url.pathname === "/event") {
      subscriptions++;
      if (subscriptions === 1) throw failure;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            init?.signal?.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      );
    }
    if (url.pathname.endsWith("/prompt_async")) {
      prompts++;
      stream!.enqueue(
        new TextEncoder().encode(
          'data: {"type":"session.idle","properties":{"sessionID":"recovered-session"}}\n\n',
        ),
      );
      return Response.json(true);
    }
    return originalFetch(input, init);
  }) as typeof fetch);
  const events: NormalizedEvent[] = [];
  const settled = Promise.withResolvers<void>();
  const transport = new OpenCodeTransport({
    supervisor: {
      acquire: async () => ({
        pid: process.pid,
        baseUrl: "http://127.0.0.1:1",
        authHeader: "Basic synthetic",
        beginTurn: async () => {},
        recoverBeforePrompt: async () => {
          recoveries++;
        },
        endTurn: () => {},
        serverStopped: () => false,
        markUnresponsive: () => {},
        release: () => {},
      }),
    } as unknown as OpenCodeSupervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
    systemPrompt: "system",
  });
  try {
    await transport.send([{ type: "text", text: "go" }], (event) => {
      events.push(event);
      if (event.kind === "turn_completed") settled.resolve();
    });
    await settled.promise;
    expect(subscriptions).toBe(2);
    expect(recoveries).toBe(1);
    expect(prompts, "recovery never replays the prompt").toBe(1);
    expect(events.at(-1)).toMatchObject({
      kind: "turn_completed",
      status: "failed",
    });
  } finally {
    transport.close();
    fetchSpy.mockRestore();
  }
});

it("does not recover when closure aborts the initial event subscription", async () => {
  const subscriptionStarted = Promise.withResolvers<void>();
  let recoveries = 0;
  const originalFetch = globalThis.fetch;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/session") return Response.json({ id: "closing" });
    if (url.pathname === "/provider")
      return Response.json({ all: [], connected: [] });
    if (url.pathname === "/event") {
      subscriptionStarted.resolve();
      if (init?.signal?.aborted)
        throw new DOMException("aborted", "AbortError");
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch);
  const transport = new OpenCodeTransport({
    supervisor: {
      acquire: async () => ({
        pid: process.pid,
        baseUrl: "http://127.0.0.1:1",
        authHeader: "Basic synthetic",
        beginTurn: async () => {},
        recoverBeforePrompt: async () => {
          recoveries++;
        },
        endTurn: () => {},
        serverStopped: () => false,
        markUnresponsive: () => {},
        release: () => {},
      }),
    } as unknown as OpenCodeSupervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
    systemPrompt: "system",
  });
  try {
    const sending = transport.send([{ type: "text", text: "go" }], () => {});
    await subscriptionStarted.promise;
    transport.close();
    await sending;
    expect(recoveries).toBe(0);
  } finally {
    transport.close();
    fetchSpy.mockRestore();
  }
});

it("persists reader failure class, code and status in the agent log", async () => {
  const harness = fixture("reader");
  const errors: SafeOpenCodeError[] = [];
  const backend = createOpenCodeBackend({
    supervisor: harness.supervisor,
    safeErrorSink: (error) => errors.push(error),
  });
  const settled = Promise.withResolvers<void>();
  let agentId = "";
  const streamed: string[] = [];
  const mgr = createAgentManager({
    resolveBackend: () => ({
      ...backend,
      oneShotPrompt: async () => "test topic",
    }),
    officeState: new OfficeState({
      rooms: [{ id: "failure-room", name: "Failure room", prompt: null }],
    }),
    initialRooms: [],
    eventSink: (event) => {
      if (event.type === "log_entry" && event.entry.agentId === agentId)
        streamed.push(event.entry.content);
      if (
        event.type === "agent_updated" &&
        event.agentId === agentId &&
        event.changes.state === "error"
      )
        settled.resolve();
    },
  });
  mgr.configureAgentTurnDeps();
  const info = await mgr.spawn(
    "Failure tracer",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "failure-room",
    undefined,
    "provider/model",
    "high",
    undefined,
    "opencode",
  );
  agentId = info!.id;
  try {
    mgr.enqueueMessage(agentId, {
      sender: { kind: "user", username: "tester" },
      text: "go",
    });
    await settled.promise;
    const expected =
      "OpenCode event stream failed (Error/ConnectionRefused; HTTP status: unavailable).";
    expect(errors, "manager safe error sink").toEqual([
      { name: "Error", code: "ConnectionRefused" },
    ]);
    expect(
      JSON.stringify(mgr.getAgentLogs(agentId)),
      "log cache omits raw exception message",
    ).not.toContain(failure.message);
    expect(streamed, "live agent error trace").toContain(expected);
    expect(
      mgr
        .getAgentLogs(agentId)
        .filter((entry) => entry.kind === "error")
        .map((entry) => entry.content),
      "cached agent error trace",
    ).toEqual([expected]);
    let persisted = "";
    for await (const path of new Bun.Glob("**/*.jsonl").scan(
      join(STATE_ROOT, "logs", agentId),
    )) {
      persisted += await Bun.file(
        join(STATE_ROOT, "logs", agentId, path),
      ).text();
    }
    expect(persisted, "persisted agent error trace").toContain(expected);
    expect(persisted, "JSONL omits raw exception message").not.toContain(
      failure.message,
    );
    expect(persisted, "persisted trace scrubs raw message").not.toContain(
      CANARY,
    );
    expect(harness.prompts(), "reader failure prevents provider prompt").toBe(
      0,
    );
  } finally {
    await mgr.kill(agentId);
  }
});

it("does not report intentional closure as a turn failure", async () => {
  const harness = fixture("close", () => transport.close());
  const errors: SafeOpenCodeError[] = [];
  const events: NormalizedEvent[] = [];
  const transport = new OpenCodeTransport({
    supervisor: harness.supervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
    systemPrompt: "system",
    safeErrorSink: (error) => errors.push(error),
  });
  try {
    await transport.send([{ type: "text", text: "go" }], (event) =>
      events.push(event),
    );
    expect(errors, "intentional close has no failure diagnostic").toEqual([]);
    expect(
      events.filter((event) => event.kind === "turn_completed"),
      "intentional close has no failed completion",
    ).toEqual([]);
  } finally {
    transport.close();
  }
});

it("delivers and answers a late approval after the turn settles", async () => {
  const harness = fixture("late-permission");
  const events: NormalizedEvent[] = [];
  const transport = new OpenCodeTransport({
    supervisor: harness.supervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
    systemPrompt: "system",
  });
  try {
    await transport.send([{ type: "text", text: "go" }], (event) =>
      events.push(event),
    );
    // The stream pump hands the late frame on a few ticks after send() ends.
    for (
      let turn = 0;
      turn < 20 && !events.some((event) => event.kind === "approval_request");
      turn++
    )
      await new Promise((resolve) => setImmediate(resolve));
    expect(
      events.map((event) => event.kind),
      "late approval remains visible after completion",
    ).toEqual(["system_init", "turn_completed", "approval_request"]);
    await transport.approve("late", { kind: "deny" });
    expect(
      harness.permissionReplies,
      "late approval remains answerable",
    ).toEqual([{ reply: "reject" }]);
  } finally {
    transport.close();
  }
});

// A virtual clock for the event-stream deadline: time moves only on advance().
function drivenClock() {
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
async function settleUntil(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !condition(); turn++)
    await new Promise((resolve) => setImmediate(resolve));
}

const DEADLINE_MS = 1_000;
const frame = (event: object) =>
  new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const heartbeat = () => frame({ type: "server.heartbeat", properties: {} });

// A local OpenCode stand-in. Each route can hold its answer until the request
// is aborted, as a frozen server does.
function drivenServer(
  options: {
    holdSession?: boolean;
    holdProvider?: "first" | "always";
    holdEvent?: "first" | "always";
    holdReply?: boolean;
    failStreamAtPrompt?: boolean;
  } = {},
) {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let releaseReply: (() => void) | undefined;
  let providerRequests = 0;
  let eventRequests = 0;
  const requested = new Set<string>();
  const promptBodies: Record<string, unknown>[] = [];
  const hold = (init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  const originalFetch = globalThis.fetch;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "http://127.0.0.1:1") return originalFetch(input, init);
    requested.add(url.pathname);
    if (url.pathname === "/session") {
      if (options.holdSession) return hold(init);
      return Response.json({ id: "driven" });
    }
    if (url.pathname === "/provider") {
      providerRequests++;
      if (
        options.holdProvider === "always" ||
        (options.holdProvider === "first" && providerRequests === 1)
      )
        return hold(init);
      return Response.json({
        all: [
          { id: "provider", models: { model: { variants: { high: {} } } } },
        ],
        connected: ["provider"],
      });
    }
    if (url.pathname === "/event") {
      eventRequests++;
      if (
        options.holdEvent === "always" ||
        (options.holdEvent === "first" && eventRequests === 1)
      )
        return hold(init);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(
              frame({ type: "server.connected", properties: {} }),
            );
            init?.signal?.addEventListener(
              "abort",
              () => {
                try {
                  controller.close();
                } catch {
                  /* Already failed or closed. */
                }
              },
              { once: true },
            );
          },
        }),
      );
    }
    if (url.pathname.endsWith("/prompt_async")) {
      promptBodies.push(JSON.parse(init?.body as string));
      if (options.failStreamAtPrompt) stream!.error(failure);
      else if (options.holdReply)
        stream!.enqueue(
          frame({
            type: "permission.asked",
            properties: {
              sessionID: "driven",
              id: "asked",
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
            },
          }),
        );
      return Response.json(true);
    }
    if (url.pathname === "/permission/asked/reply") {
      await new Promise<void>((resolve) => (releaseReply = resolve));
      return Response.json(true);
    }
    return Response.json(true);
  }) as typeof fetch);
  return {
    requested: (path: string) => requested.has(path),
    eventRequests: () => eventRequests,
    promptBodies,
    replyPending: () => releaseReply !== undefined,
    releaseReply: () => releaseReply?.(),
    send: (bytes: Uint8Array) => stream!.enqueue(bytes),
    complete() {
      stream!.enqueue(
        frame({
          type: "message.part.updated",
          properties: {
            sessionID: "driven",
            part: {
              type: "step-finish",
              id: "step",
              tokens: { input: 1, output: 1 },
            },
          },
        }),
      );
      stream!.enqueue(
        frame({ type: "session.idle", properties: { sessionID: "driven" } }),
      );
    },
    restore: () => fetchSpy.mockRestore(),
  };
}

function drivenTransport(
  clock: ReturnType<typeof drivenClock>,
  options: {
    serverStopped?: boolean;
    sessionId?: string;
    agent?: string;
    recoveryBlocked?: boolean;
  } = {},
) {
  const marked: { pid: number; afterPrompt: boolean }[] = [];
  const errors: SafeOpenCodeError[] = [];
  let recoveries = 0;
  const transport = new OpenCodeTransport({
    supervisor: {
      acquire: async () => ({
        pid: 4242,
        baseUrl: "http://127.0.0.1:1",
        authHeader: "Basic synthetic",
        beginTurn: async () => {},
        recoverBeforePrompt: async () => {
          recoveries++;
          if (options.recoveryBlocked)
            throw new Error("guard: another turn is active");
        },
        endTurn: () => {},
        serverStopped: () => options.serverStopped ?? false,
        markUnresponsive: (pid: number, afterPrompt: boolean) =>
          marked.push({ pid, afterPrompt }),
        release: () => {},
      }),
    } as unknown as OpenCodeSupervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
    effort: "high",
    systemPrompt: "system",
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    eventStreamDeadlineMs: DEADLINE_MS,
    deadlineScheduler: clock.scheduler,
    safeErrorSink: (error) => errors.push(error),
  });
  const completions: Extract<NormalizedEvent, { kind: "turn_completed" }>[] =
    [];
  return {
    transport,
    marked,
    recoveries: () => recoveries,
    completions,
    errors,
    send: () =>
      transport.send([{ type: "text", text: "go" }], (event) => {
        if (event.kind === "turn_completed") completions.push(event);
      }),
  };
}

const unresponsive = {
  kind: "turn_completed",
  status: "failed",
  error: OPENCODE_SERVER_UNRESPONSIVE_FAILURE,
} as const;

it("keeps a turn whose stream frames reset the deadline across several deadlines", async () => {
  const clock = drivenClock();
  const server = drivenServer();
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    expect(server.promptBodies).toHaveLength(1);
    for (let beat = 1; beat <= 3; beat++) {
      clock.advance(700);
      const arms = clock.arms();
      server.send(heartbeat());
      await settleUntil(() => clock.arms() > arms);
      expect(clock.arms(), `heartbeat ${beat} re-armed the deadline`).toBe(
        arms + 1,
      );
      expect(turn.completions, `alive after ${beat * 700} ms`).toEqual([]);
    }
    clock.advance(DEADLINE_MS);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([unresponsive]);
    expect(turn.marked).toEqual([{ pid: 4242, afterPrompt: true }]);
    expect(turn.recoveries(), "no replacement inside the turn").toBe(0);
    expect(server.promptBodies, "the prompt is never replayed").toHaveLength(1);
    expect(server.eventRequests(), "no second subscription").toBe(1);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("keeps a turn whose stream frames arrive while a permission reply is pending", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdReply: true });
  const turn = drivenTransport(clock, { sessionId: "driven", agent: "build" });
  try {
    await turn.send();
    await settleUntil(() => server.replyPending());
    expect(server.replyPending(), "the reply POST is pending").toBe(true);
    for (let beat = 1; beat <= 3; beat++) {
      clock.advance(700);
      const arms = clock.arms();
      server.send(heartbeat());
      await settleUntil(() => clock.arms() > arms);
      expect(clock.arms(), `heartbeat ${beat} re-armed the deadline`).toBe(
        arms + 1,
      );
    }
    expect(turn.completions, "alive with the reply still pending").toEqual([]);
    server.releaseReply();
    server.complete();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([{ status: "completed" }]);
    expect(turn.marked).toEqual([]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("recovers once before the prompt when the event stream headers miss the deadline", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdEvent: "first" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.requested("/event"));
    expect(server.eventRequests(), "the subscription is pending").toBe(1);
    expect(turn.completions).toEqual([]);
    clock.advance(DEADLINE_MS);
    await settleUntil(() => server.promptBodies.length > 0);
    expect(turn.marked).toEqual([{ pid: 4242, afterPrompt: false }]);
    expect(turn.recoveries()).toBe(1);
    expect(server.eventRequests()).toBe(2);
    expect(server.promptBodies, "the message goes through once").toHaveLength(
      1,
    );
    server.complete();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([{ status: "completed" }]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("fails in member words when the recovered subscription also misses the deadline", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdEvent: "always" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.eventRequests() === 1);
    clock.advance(DEADLINE_MS);
    await settleUntil(() => server.eventRequests() === 2);
    expect(server.eventRequests(), "one retry after recovery").toBe(2);
    expect(turn.completions).toEqual([]);
    clock.advance(DEADLINE_MS);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([unresponsive]);
    expect(turn.recoveries()).toBe(1);
    expect(turn.marked).toEqual([
      { pid: 4242, afterPrompt: false },
      { pid: 4242, afterPrompt: false },
    ]);
    expect(server.promptBodies, "no prompt").toEqual([]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("fails in member words when the guard blocks recovery after a missed subscription deadline", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdEvent: "first" });
  const turn = drivenTransport(clock, {
    sessionId: "driven",
    recoveryBlocked: true,
  });
  try {
    void turn.send();
    await settleUntil(() => server.requested("/event"));
    expect(server.eventRequests(), "the subscription is pending").toBe(1);
    clock.advance(DEADLINE_MS);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.recoveries(), "recovery was attempted").toBe(1);
    expect(turn.completions).toEqual([unresponsive]);
    expect(turn.marked).toEqual([{ pid: 4242, afterPrompt: false }]);
    expect(server.eventRequests(), "no second subscription").toBe(1);
    expect(server.promptBodies, "no prompt").toEqual([]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("fails a turn whose new session request never answers and marks its server", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdSession: true });
  const turn = drivenTransport(clock);
  try {
    void turn.send();
    await settleUntil(() => server.requested("/session"));
    expect(server.requested("/session"), "the session POST is pending").toBe(
      true,
    );
    expect(turn.completions).toEqual([]);
    clock.advance(DEADLINE_MS);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([unresponsive]);
    expect(turn.marked).toEqual([{ pid: 4242, afterPrompt: false }]);
    expect(server.requested("/event"), "no subscription").toBe(false);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("drops the effort variant for one turn when the catalog is slow, without marking the server", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdProvider: "first" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.requested("/provider"));
    expect(server.requested("/provider"), "the catalog is pending").toBe(true);
    clock.advance(DEADLINE_MS);
    await settleUntil(() => server.promptBodies.length > 0);
    expect(server.promptBodies[0], "first turn has no variant").not.toHaveProperty(
      "variant",
    );
    server.complete();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([{ status: "completed" }]);
    expect(turn.marked).toEqual([]);

    await turn.send();
    expect(
      server.promptBodies[1],
      "the slow catalog was not cached",
    ).toMatchObject({ variant: "high" });
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("reports a stream failure from a stopped server in member words and keeps the safe class", async () => {
  const clock = drivenClock();
  const server = drivenServer({ failStreamAtPrompt: true });
  const turn = drivenTransport(clock, {
    sessionId: "driven",
    serverStopped: true,
  });
  try {
    await turn.send();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([
      {
        kind: "turn_completed",
        status: "failed",
        error: OPENCODE_SERVER_STOPPED_FAILURE,
      },
    ]);
    expect(turn.errors).toEqual([{ name: "Error", code: "ConnectionRefused" }]);
    expect(turn.marked).toEqual([]);
    expect(JSON.stringify(turn.errors)).not.toContain(CANARY);
  } finally {
    turn.transport.close();
    server.restore();
  }
});
