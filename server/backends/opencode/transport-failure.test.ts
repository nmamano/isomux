import { OPENCODE_SAFETY_TOOL } from "./safety-plugin-tool.ts";
import { afterEach, expect, it, spyOn } from "bun:test";
import { createOpenCodeBackend } from "./adapter.ts";
import {
  discoverOpenCodeModels,
  OPENCODE_CATALOG_LOAD_LIMIT_MS,
  OPENCODE_EFFORT_CATALOG_UNAVAILABLE,
  OPENCODE_FOLDER_SETUP_FAILURE,
  OPENCODE_FOLDER_SETUP_LIMIT_MS,
  OPENCODE_FOLDER_SETUP_NOTICE,
  OPENCODE_EVENT_STREAM_LOST_FAILURE,
  OPENCODE_SAFETY_PLUGIN_MISSING_FAILURE,
  OPENCODE_SERVER_STOPPED_FAILURE,
  OPENCODE_SERVER_UNRESPONSIVE_FAILURE,
  openCodeEffortUnavailableNotice,
  OpenCodeTransport,
  type OpenCodeErrorContext,
  type OpenCodeStreamSilence,
  type OpenCodeTurnStep,
  type SafeOpenCodeError,
} from "./transport.ts";
import { openCodeLogPath } from "./profile-paths.ts";
import type { OpenCodeSupervisor } from "./supervisor.ts";
import { OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS as PROBE_MS } from "./server-health.ts";
import type { NormalizedEvent } from "../types.ts";
import { createAgentManager } from "../../agent-manager.ts";
import { OfficeState } from "../../../shared/office-state.ts";
import { STATE_ROOT } from "../../config.ts";
import { join } from "node:path";
import { msg, type LogText } from "../../../shared/i18n/log-message.ts";

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
  | "recover"
  | "plugin"
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

function fixture(
  stage: Stage,
  onPrompt = () => {},
  acquireGate?: Promise<void>,
  messageGate?: Promise<void>,
) {
  let ended = 0;
  let settles = 0;
  let acquires = 0;
  let releases = 0;
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
      if (stage === "events" || stage === "recover")
        return new Response(CANARY, { status: 502 });
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
    if (url.pathname === "/experimental/tool/ids") {
      if (stage === "plugin") return new Response(CANARY, { status: 503 });
      return Response.json([OPENCODE_SAFETY_TOOL]);
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
    if (url.pathname.endsWith("/message")) {
      if (messageGate) await messageGate;
      return Response.json([]);
    }
    return Response.json(true);
  }) as typeof fetch);
  restoreFetch = () => fetchSpy.mockRestore();
  const supervisor = {
    acquire: async () => {
      acquires++;
      if (acquireGate) await acquireGate;
      if (stage === "acquire") throw failure;
      // As in the supervisor, release() also ends a hold not yet settled.
      let held = true;
      const endHold = () => {
        if (held) settles++;
        held = false;
      };
      return {
        pid: process.pid,
        baseUrl: "http://127.0.0.1:1",
        authHeader: "Basic synthetic",
        settle: endHold,
        beginTurn: async () => {
          if (stage === "begin") throw failure;
        },
        recoverBeforePrompt: async () => {
          recoveries++;
          if (stage === "recover") throw failure;
        },
        endTurn: () => {
          ended++;
        },
        serverStopped: () => false,
        markUnresponsive: () => {},
        release: () => {
          endHold();
          releases++;
        },
      };
    },
  } as unknown as OpenCodeSupervisor;
  return {
    supervisor,
    acquires: () => acquires,
    releases: () => releases,
    ended: () => ended,
    prompts: () => prompts,
    recoveries: () => recoveries,
    settles: () => settles,
    permissionReplies,
  };
}

// The last column is the step the journal line names (task 8d9561a5).
const cases: Array<
  [Stage, string, string, number | undefined, OpenCodeTurnStep]
> = [
  ["acquire", "OpenCode turn failed", "Error", undefined, "acquire"],
  ["session", "OpenCode turn failed", "Error", 503, "session"],
  ["session-json", "OpenCode turn failed", "SyntaxError", undefined, "session"],
  ["begin", "OpenCode turn failed", "Error", undefined, "begin_turn"],
  ["events", "OpenCode turn failed", "Error", 502, "event_stream"],
  ["body", "OpenCode turn failed", "Error", undefined, "event_stream"],
  ["recover", "OpenCode turn failed", "Error", undefined, "recovery"],
  ["plugin", "OpenCode turn failed", "Error", 503, "safety_plugin"],
  [
    "reader",
    "OpenCode event stream failed",
    "Error",
    undefined,
    "event_stream",
  ],
  ["prompt", "OpenCode turn failed", "Error", 504, "prompt"],
  [
    "end",
    "OpenCode event stream ended before turn completion",
    "Error",
    undefined,
    "event_stream",
  ],
  [
    "idle",
    "OpenCode became idle without a recorded completion",
    "Error",
    undefined,
    "event_stream",
  ],
  ["race", "OpenCode event stream failed", "Error", undefined, "event_stream"],
];

for (const [stage, context, name, statusCode, step] of cases) {
  it(`reports ${stage} failure once with safe class and status`, async () => {
    const harness = fixture(stage);
    const errors: SafeOpenCodeError[] = [];
    const steps: (OpenCodeTurnStep | undefined)[] = [];
    const events: NormalizedEvent[] = [];
    const transport = new OpenCodeTransport({
      supervisor: harness.supervisor,
      cwd: STATE_ROOT,
      model: "provider/model",
      systemPrompt: "system",
      safeErrorSink: (error, context) => {
        errors.push(error);
        steps.push(context?.step);
      },
    });
    try {
      await transport.send([{ type: "text", text: "go" }], (event) =>
        events.push(event),
      );
      const code = ["acquire", "begin", "reader", "race", "recover"].includes(
        stage,
      )
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
      expect(steps, "the journal names the failed step").toEqual([step]);
      expect(
        JSON.stringify({ errors, events }),
        "no raw error fields",
      ).not.toContain(CANARY);
      expect(harness.ended(), "balanced turn lease").toBe(
        ["acquire", "session", "session-json", "begin"].includes(stage) ? 0 : 1,
      );
      // Task 8d9561a5: the hold an acquire takes keeps a pending server
      // replacement waiting. A lost settle would keep it waiting until restart.
      expect(harness.settles(), "the acquire's hold ended").toBe(
        stage === "acquire" ? 0 : 1,
      );
      expect(harness.prompts(), "no prompt after early failure").toBe(
        stage === "prompt" || stage === "race" ? 1 : 0,
      );
      expect(
        harness.recoveries(),
        "recovery stays before prompt submission",
      ).toBe(["events", "body", "recover"].includes(stage) ? 1 : 0);
    } finally {
      transport.close();
    }
  });
}

// Task 63efb5b1: the supervisor counts a lease until its release. One that
// came back after close() was never released, so the idle reap never armed.
it("releases a lease that an acquire returns after close", async () => {
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const harness = fixture("end", () => {}, gate);
  const transport = new OpenCodeTransport({
    supervisor: harness.supervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
  });
  const read = transport.getSessionMessages().then(
    () => "read",
    () => "rejected",
  );
  transport.close();
  open();
  const outcome = await read;
  expect(harness.acquires()).toBe(1);
  expect(harness.releases()).toBe(1);
  expect(outcome).toBe("rejected");
});

it("releases the lease of a failed initialization when the next one acquires", async () => {
  const harness = fixture("session");
  const transport = new OpenCodeTransport({
    supervisor: harness.supervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        await transport.getSessionMessages().then(
          () => "read",
          () => "rejected",
        ),
      ).toBe("rejected");
    expect(harness.acquires()).toBe(2);
    expect(harness.releases()).toBe(1);
  } finally {
    transport.close();
  }
  expect(harness.releases()).toBe(2);
});

// Task 63efb5b1: two initializations in flight both acquired, and the second
// lease replaced the first, which was never released or settled.
it("shares one acquire between two callers in flight, and only its owner ends the hold", async () => {
  let openAcquire = () => {};
  const acquireGate = new Promise<void>((resolve) => (openAcquire = resolve));
  let openMessages = () => {};
  const messageGate = new Promise<void>((resolve) => (openMessages = resolve));
  const harness = fixture("end", () => {}, acquireGate, messageGate);
  const transport = new OpenCodeTransport({
    supervisor: harness.supervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
  });
  try {
    let read = false;
    const owner = transport.getSessionMessages().then(() => {
      read = true;
    });
    const joiner = transport.deleteSession();
    openAcquire();
    await joiner;
    expect(harness.acquires()).toBe(1);
    expect(read, "the owner's work still runs").toBe(false);
    expect(harness.settles(), "the joiner ends no hold").toBe(0);
    openMessages();
    await owner;
    expect(harness.settles()).toBe(1);
  } finally {
    transport.close();
  }
  expect(harness.releases()).toBe(1);
});

it("starts a turn that waited for another caller's initialization with the session", async () => {
  let openAcquire = () => {};
  const acquireGate = new Promise<void>((resolve) => (openAcquire = resolve));
  const harness = fixture("end", () => {}, acquireGate);
  const events: NormalizedEvent[] = [];
  const transport = new OpenCodeTransport({
    supervisor: harness.supervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
    systemPrompt: "system",
  });
  try {
    const read = transport.getSessionMessages();
    const sent = transport.send([{ type: "text", text: "go" }], (event) =>
      events.push(event),
    );
    openAcquire();
    await Promise.all([read, sent]);
    expect(harness.acquires()).toBe(1);
    expect(events.filter((event) => event.kind === "system_init")).toEqual([
      {
        kind: "system_init",
        sessionId: "failure-session",
        model: "provider/model",
      },
    ]);
    expect(harness.ended(), "the turn began").toBe(1);
  } finally {
    transport.close();
  }
});

// Task 8d9561a5: a turn that failed inside acquire had no lease, so its
// journal line named no OpenCode log.
it("names OpenCode's log when the turn fails before acquire returns a lease", async () => {
  const contexts: (OpenCodeErrorContext | undefined)[] = [];
  const transport = new OpenCodeTransport({
    supervisor: {
      profileDir: "/profiles/acquire-failure",
      acquire: async () => {
        throw new Error("replacement failed");
      },
    } as unknown as OpenCodeSupervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
    systemPrompt: "system",
    agentId: "agent-acquire",
    safeErrorSink: (_error, context) => contexts.push(context),
  });
  try {
    await transport.send([{ type: "text", text: "go" }], () => {});
    expect(contexts).toEqual([
      expect.objectContaining({
        agentId: "agent-acquire",
        step: "acquire",
        openCodeLog: openCodeLogPath("/profiles/acquire-failure"),
      }),
    ]);
  } finally {
    transport.close();
  }
});

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
        settle: () => {},
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

// Nil, 2026-10-19 (task 9251ff1d): a request that reaches the transport after
// its turn settled is refused like one still open when the turn ends. Nobody
// reads the stream any more, so it gets no card and OpenCode gets a reject.
for (const agent of [undefined, "build"]) {
  it(`refuses a request that arrives after the turn settles${agent ? " in agent mode" : ""}`, async () => {
    const harness = fixture("late-permission");
    const events: NormalizedEvent[] = [];
    const transport = new OpenCodeTransport({
      supervisor: harness.supervisor,
      cwd: STATE_ROOT,
      model: "provider/model",
      systemPrompt: "system",
      ...(agent ? { agent } : {}),
    });
    try {
      await transport.send([{ type: "text", text: "go" }], (event) =>
        events.push(event),
      );
      // The stream pump hands the late frame on a few ticks after send() ends.
      await settleUntil(
        () =>
          harness.permissionReplies.length > 0 ||
          events.some((event) => event.kind === "approval_request"),
      );
      expect(
        events.map((event) => event.kind),
        "the turn failed first, and no card followed it",
      ).toEqual(["system_init", "turn_completed"]);
      // MUTANT (agent mode): the safety handler runs on the late request and
      // allows it with "once", so OpenCode runs the tool unseen.
      expect(
        harness.permissionReplies,
        "the late request reached the transport and OpenCode got a reject",
      ).toEqual([{ reply: "reject" }]);
      await transport.approve("late", { kind: "allow_once" });
      expect(
        harness.permissionReplies,
        "an answer after the refusal sends nothing",
      ).toEqual([{ reply: "reject" }]);
    } finally {
      transport.close();
    }
  });
}

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

// The pre-stream deadline on a frozen server: the bound, and then the bound of
// the health probe it sends.
async function missPreStreamDeadline(
  clock: ReturnType<typeof drivenClock>,
): Promise<void> {
  clock.advance(DEADLINE_MS);
  await settleUntil(() => false);
  clock.advance(PROBE_MS);
}
const frame = (event: object) =>
  new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const heartbeat = () => frame({ type: "server.heartbeat", properties: {} });

// A local OpenCode stand-in. Each route can hold its answer until the request
// is aborted, as a frozen server does.
function drivenServer(
  options: {
    holdSession?: boolean;
    holdProvider?: "first" | "always";
    // "later": every subscription after the first, as a stuck folder holds a
    // reconnect.
    holdEvent?: "first" | "always" | "later";
    holdReply?: boolean;
    holdToolIds?: boolean;
    failStreamAtPrompt?: boolean;
    // An HTTP status for prompt_async other than 200.
    promptStatus?: number;
    // The session abort answers only on releaseAbort, as a server that is
    // slow to stop a session does.
    holdAbort?: boolean;
    // How /global/health answers. A frozen server (a held session or event
    // request) accepts the connection and never answers; a killed one that
    // is not reaped yet refuses it.
    health?: "healthy" | "silent" | "refused";
    // false: the safety plugin did not load, so its tool is missing.
    safetyPlugin?: boolean;
    variants?: () => Record<string, unknown>;
    // What the reads of a stream recovery answer.
    status?: Record<string, unknown>;
    messages?: () => unknown[];
    permissions?: unknown[];
    children?: () => Record<string, unknown[]>;
  } = {},
) {
  const health =
    options.health ??
    (options.holdSession || options.holdEvent ? "silent" : "healthy");
  const heldEvents: (() => void)[] = [];
  const heldProviders: (() => void)[] = [];
  const heldToolIds: (() => void)[] = [];
  let providerAborts = 0;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let releaseReply: (() => void) | undefined;
  const heldAborts: (() => void)[] = [];
  let providerRequests = 0;
  let eventRequests = 0;
  let healthRequests = 0;
  const requested = new Set<string>();
  const log: string[] = [];
  const promptBodies: Record<string, unknown>[] = [];
  // Every permission reply, with the request id from its path.
  const replies: Record<string, unknown>[] = [];
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
    log.push(url.pathname);
    if (url.pathname === "/session/status")
      return Response.json(options.status ?? {});
    if (url.pathname === "/permission")
      return Response.json(options.permissions ?? []);
    if (url.pathname === "/session/driven/message")
      return Response.json(options.messages?.() ?? []);
    if (url.pathname.endsWith("/children"))
      return Response.json(
        options.children?.()[url.pathname.split("/")[2]] ?? [],
      );
    if (url.pathname === "/session") {
      if (options.holdSession) return hold(init);
      return Response.json({ id: "driven" });
    }
    if (url.pathname === "/provider") {
      providerRequests++;
      const variants = options.variants?.() ?? { high: {} };
      const catalog = () =>
        Response.json({
          all: [{ id: "provider", models: { model: { variants } } }],
          connected: ["provider"],
        });
      if (
        options.holdProvider === "always" ||
        (options.holdProvider === "first" && providerRequests === 1)
      )
        // Held until aborted, or answered late by releaseProvider.
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              providerAborts++;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
          heldProviders.push(() => resolve(catalog()));
        });
      return catalog();
    }
    if (url.pathname === "/event") {
      eventRequests++;
      const respond = () =>
        new Response(
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
      if (
        options.holdEvent === "always" ||
        (options.holdEvent === "first" && eventRequests === 1) ||
        (options.holdEvent === "later" && eventRequests > 1)
      )
        // Held until aborted, or answered late by releaseEvent.
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
          heldEvents.push(() => resolve(respond()));
        });
      return respond();
    }
    if (url.pathname === "/experimental/tool/ids") {
      const ids = () =>
        Response.json(
          options.safetyPlugin === false ? ["bash"] : [OPENCODE_SAFETY_TOOL],
        );
      if (!options.holdToolIds) return ids();
      return new Promise<Response>((resolve) =>
        heldToolIds.push(() => resolve(ids())),
      );
    }
    if (url.pathname.endsWith("/prompt_async")) {
      promptBodies.push(JSON.parse(init?.body as string));
      if (options.promptStatus)
        return new Response(null, { status: options.promptStatus });
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
    if (
      url.pathname.startsWith("/permission/") &&
      url.pathname.endsWith("/reply")
    )
      replies.push({
        id: decodeURIComponent(url.pathname.split("/")[2]),
        ...JSON.parse(init?.body as string),
      });
    if (url.pathname === "/permission/asked/reply") {
      await new Promise<void>((resolve) => (releaseReply = resolve));
      return Response.json(true);
    }
    if (url.pathname === "/session/driven/abort" && options.holdAbort)
      return new Promise<Response>((resolve) =>
        heldAborts.push(() => resolve(Response.json(true))),
      );
    if (url.pathname === "/global/health") {
      healthRequests++;
      if (health === "silent") return hold(init);
      if (health === "refused")
        throw Object.assign(new TypeError("Unable to connect."), {
          code: "ConnectionRefused",
        });
    }
    return Response.json(true);
  }) as typeof fetch);
  return {
    requested: (path: string) => requested.has(path),
    log,
    eventRequests: () => eventRequests,
    healthRequests: () => healthRequests,
    releaseEvent: () => heldEvents.splice(0).forEach((answer) => answer()),
    toolIdsHeld: () => heldToolIds.length > 0,
    releaseToolIds: () => heldToolIds.splice(0).forEach((answer) => answer()),
    providerRequests: () => providerRequests,
    providerAborts: () => providerAborts,
    releaseProvider: () =>
      heldProviders.splice(0).forEach((answer) => answer()),
    promptBodies,
    replies,
    replyPending: () => releaseReply !== undefined,
    releaseAbort: () => heldAborts.splice(0).forEach((answer) => answer()),
    // How many times the session was stopped.
    aborts: () => log.filter((path) => path === "/session/driven/abort").length,
    releaseReply: () => releaseReply?.(),
    send: (bytes: Uint8Array) => stream!.enqueue(bytes),
    // The stream breaks while the server still answers.
    fail: () => stream!.error(failure),
    // The stream ends cleanly before the turn completed.
    end: () => stream!.close(),
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

const DRIVEN_PROFILE = "/driven-profile";

function drivenTransport(
  clock: ReturnType<typeof drivenClock>,
  options: {
    serverStopped?: boolean;
    sessionId?: string;
    agent?: string;
    recoveryBlocked?: boolean;
    serverKey?: () => string;
    onBeginTurn?: () => void;
    onRecover?: () => void;
    agentId?: string;
    replacementPending?: boolean;
  } = {},
) {
  const marked: { pid: number; afterPrompt: boolean }[] = [];
  const errors: SafeOpenCodeError[] = [];
  const contexts: (OpenCodeErrorContext | undefined)[] = [];
  const silences: OpenCodeStreamSilence[] = [];
  // Both journal sinks, in the order they wrote.
  const journal: string[] = [];
  let recoveries = 0;
  const supervisor = {
    acquire: async () => ({
      pid: 4242,
      baseUrl: "http://127.0.0.1:1",
      authHeader: "Basic synthetic",
      profileDir: DRIVEN_PROFILE,
      get serverKey() {
        return options.serverKey?.() ?? "server-1";
      },
      replacementPending: options.replacementPending ?? false,
      settle: () => {},
      beginTurn: async () => {
        options.onBeginTurn?.();
      },
      recoverBeforePrompt: async () => {
        recoveries++;
        if (options.recoveryBlocked)
          throw new Error("guard: another turn is active");
        options.onRecover?.();
      },
      endTurn: () => {},
      serverStopped: () => options.serverStopped ?? false,
      markUnresponsive: (pid: number, afterPrompt: boolean) =>
        marked.push({ pid, afterPrompt }),
      release: () => {},
    }),
  } as unknown as OpenCodeSupervisor;
  const transport = new OpenCodeTransport({
    supervisor,
    cwd: STATE_ROOT,
    model: "provider/model",
    effort: "high",
    systemPrompt: "system",
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    eventStreamDeadlineMs: DEADLINE_MS,
    deadlineScheduler: clock.scheduler,
    safeErrorSink: (error, context) => {
      errors.push(error);
      contexts.push(context);
      journal.push("error");
    },
    streamSilenceSink: (silence) => {
      silences.push(silence);
      journal.push("silence");
    },
  });
  const completions: Extract<NormalizedEvent, { kind: "turn_completed" }>[] =
    [];
  const notices: LogText[] = [];
  const texts: string[] = [];
  const approvals: string[] = [];
  const withdrawn: string[] = [];
  return {
    transport,
    supervisor,
    marked,
    texts,
    approvals,
    withdrawn,
    recoveries: () => recoveries,
    completions,
    notices,
    errors,
    contexts,
    silences,
    journal,
    send: () =>
      transport.send([{ type: "text", text: "go" }], (event) => {
        if (event.kind === "turn_completed") completions.push(event);
        if (event.kind === "system_text") notices.push(event.text);
        if (event.kind === "assistant_text") texts.push(event.text);
        if (event.kind === "approval_request") approvals.push(event.approvalId);
        if (event.kind === "approval_withdrawn")
          withdrawn.push(event.approvalId);
      }),
  };
}

const unresponsive = {
  kind: "turn_completed",
  status: "failed",
  error: OPENCODE_SERVER_UNRESPONSIVE_FAILURE,
} as const;

// A server that refuses the health probe at the deadline has stopped
// answering: the turn fails and the server is marked.
// Task 42500a30: the journal line of an unresponsive turn was a bare
// {"name":"Error"} that named neither the agent nor the failure.
it("keeps a turn whose stream frames reset the deadline across several deadlines, and names the agent, the failure and OpenCode's log when it misses one", async () => {
  const clock = drivenClock();
  const server = drivenServer({ health: "refused" });
  const turn = drivenTransport(clock, {
    sessionId: "driven",
    agentId: "agent-driven",
  });
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
    // A request to a server that stopped answering has no bound.
    await settleUntil(() => server.aborts() > 0);
    expect(server.aborts(), "no session abort").toBe(0);
    expect(turn.recoveries(), "no replacement inside the turn").toBe(0);
    expect(server.promptBodies, "the prompt is never replayed").toHaveLength(1);
    expect(server.eventRequests(), "no second subscription").toBe(1);
    expect(turn.errors).toEqual([{ name: "Error" }]);
    expect(turn.contexts).toEqual([
      {
        agentId: "agent-driven",
        failure: OPENCODE_SERVER_UNRESPONSIVE_FAILURE,
        step: "event_stream",
        openCodeLog: openCodeLogPath(DRIVEN_PROFILE),
      },
    ]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

// Task 439afbc8: one silent stream marked the shared server, and its
// replacement failed every other turn on it. A server that answers is kept.
const streamLost = {
  kind: "turn_completed",
  status: "failed",
  error: OPENCODE_EVENT_STREAM_LOST_FAILURE,
} as const;
// An earlier turn's answer, which a recovery never shows again.
const earlierTurn = [
  {
    info: { id: "user-0", role: "user", time: { created: 1 } },
    parts: [
      { type: "text", id: "user-part-0", messageID: "user-0", text: "hi" },
    ],
  },
  {
    info: { id: "answer-0", role: "assistant", time: { created: 2 } },
    parts: [
      { type: "text", id: "old-part", messageID: "answer-0", text: "Earlier" },
      {
        type: "step-finish",
        id: "old-step",
        messageID: "answer-0",
        tokens: {},
      },
    ],
  },
];
// This turn's answer, which OpenCode creates after the prompt went out.
const answer = (text: string, finished: boolean) => ({
  info: {
    id: "answer-1",
    role: "assistant",
    time: { created: Date.now() },
  },
  parts: [
    { type: "text", id: "answer-part", messageID: "answer-1", text },
    ...(finished
      ? [
          {
            type: "step-finish",
            id: "answer-step",
            messageID: "answer-1",
            tokens: { input: 1, output: 1 },
          },
        ]
      : []),
  ],
});
const textFrame = (text: string) =>
  frame({
    type: "message.part.updated",
    properties: {
      sessionID: "driven",
      part: { type: "text", id: "answer-part", messageID: "answer-1", text },
    },
  });
const answerStarted = () =>
  frame({
    type: "message.updated",
    properties: {
      sessionID: "driven",
      info: { id: "answer-1", role: "assistant" },
    },
  });

// The deadline, the health probe, and the recovery requests.
async function missStreamDeadline(
  clock: ReturnType<typeof drivenClock>,
  server: ReturnType<typeof drivenServer>,
): Promise<void> {
  const health = server.healthRequests();
  clock.advance(DEADLINE_MS);
  await settleUntil(() => server.healthRequests() > health);
  await settleUntil(() => false);
}

it("moves a turn whose stream goes silent on a server that answers to a new stream, with the text it missed", async () => {
  const clock = drivenClock();
  const server = drivenServer({
    status: { driven: { type: "busy" } },
    messages: () => [...earlierTurn, answer("Hello there", false)],
  });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    server.send(answerStarted());
    server.send(textFrame("Hello"));
    await settleUntil(() => turn.texts.length > 0);
    expect(turn.texts).toEqual(["Hello"]);
    await missStreamDeadline(clock, server);
    expect(server.eventRequests(), "a second subscription").toBe(2);
    expect(turn.completions, "the turn goes on").toEqual([]);
    expect(turn.texts, "the missed text, once").toEqual(["Hello", " there"]);
    // The new stream subscribes before the reads, so nothing after them is
    // lost.
    const subscribed = server.log.lastIndexOf("/event");
    expect(subscribed).toBeLessThan(server.log.indexOf("/session/status"));
    expect(subscribed).toBeLessThan(server.log.indexOf("/permission"));
    server.send(textFrame("Hello there, done"));
    server.complete();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([{ status: "completed" }]);
    expect(turn.texts).toEqual(["Hello", " there", ", done"]);
    expect(turn.marked, "the server is not marked").toEqual([]);
    expect(server.promptBodies, "the prompt is never replayed").toHaveLength(1);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("shows text once when the new stream delivers frames older than the replay", async () => {
  const clock = drivenClock();
  const server = drivenServer({
    status: { driven: { type: "busy" } },
    messages: () => [answer("Hi", false)],
  });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await missStreamDeadline(clock, server);
    expect(turn.texts, "the replay").toEqual(["Hi"]);
    // Sent between the new subscription and the message read.
    server.send(answerStarted());
    server.send(textFrame(""));
    server.send(textFrame("H"));
    server.send(textFrame("Hi"));
    server.send(textFrame("Hi there"));
    server.complete();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([{ status: "completed" }]);
    expect(turn.texts).toEqual(["Hi", " there"]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("shows reasoning once when the new stream delivers frames older than the replay", async () => {
  const clock = drivenClock();
  const reasoning = (text: string) => ({
    type: "reasoning",
    id: "thought",
    messageID: "answer-1",
    text,
  });
  const server = drivenServer({
    status: { driven: { type: "busy" } },
    messages: () => [{ ...answer("", false), parts: [reasoning("Thinking")] }],
  });
  const thoughts: string[] = [];
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.transport.send([{ type: "text", text: "go" }], (event) => {
      if (event.kind === "thinking") thoughts.push(event.text);
      if (event.kind === "turn_completed") turn.completions.push(event);
    });
    await missStreamDeadline(clock, server);
    expect(thoughts, "the replay").toEqual(["Thinking"]);
    server.send(answerStarted());
    for (const text of ["Think", "Thinking", "Thinking more"])
      server.send(
        frame({
          type: "message.part.updated",
          properties: { sessionID: "driven", part: reasoning(text) },
        }),
      );
    server.complete();
    await settleUntil(() => turn.completions.length > 0);
    expect(thoughts).toEqual(["Thinking", " more"]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("replays a turn whose prompt went out while its recovery subscribed", async () => {
  const clock = drivenClock();
  const server = drivenServer({
    holdToolIds: true,
    holdEvent: "later",
    health: "healthy",
    status: { driven: { type: "busy" } },
    messages: () => [answer("Hi", false)],
  });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.toolIdsHeld());
    expect(server.promptBodies, "no prompt yet").toEqual([]);
    // The stream deadline passes before the prompt. The recovery waits on
    // its new subscription while the prompt goes out.
    await missStreamDeadline(clock, server);
    expect(server.eventRequests(), "the new subscription is pending").toBe(2);
    server.releaseToolIds();
    await settleUntil(() => server.promptBodies.length > 0);
    expect(server.promptBodies).toHaveLength(1);
    server.releaseEvent();
    await settleUntil(() => turn.texts.length > 0);
    expect(turn.texts, "the frames on neither stream").toEqual(["Hi"]);
    expect(turn.completions).toEqual([]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("completes a turn that finished while its stream was silent, with its text", async () => {
  const clock = drivenClock();
  const server = drivenServer({
    messages: () => [...earlierTurn, answer("All done", true)],
  });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await missStreamDeadline(clock, server);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([{ status: "completed" }]);
    expect(turn.completions[0].usage, "the missed step is billed").toEqual({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(turn.texts).toEqual(["All done"]);
    expect(turn.marked).toEqual([]);
    expect(server.requested("/session/driven/abort")).toBe(false);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("fails only its own turn and stops its session when the session went idle with no answer while the stream was silent", async () => {
  const clock = drivenClock();
  const server = drivenServer({ messages: () => earlierTurn });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await missStreamDeadline(clock, server);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([streamLost]);
    expect(turn.marked, "the server is not marked").toEqual([]);
    await settleUntil(() => server.requested("/session/driven/abort"));
    expect(server.requested("/session/driven/abort")).toBe(true);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("ends a turn the member stopped while its stream was silent as stopped", async () => {
  const clock = drivenClock();
  const server = drivenServer({ messages: () => earlierTurn });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await turn.transport.abort();
    await missStreamDeadline(clock, server);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([
      { kind: "turn_completed", status: "interrupted" },
    ]);
    expect(turn.marked).toEqual([]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("fails only its own turn when a server that answers health does not answer the new subscription", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdEvent: "later", health: "healthy" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await missStreamDeadline(clock, server);
    expect(server.eventRequests(), "the new subscription is pending").toBe(2);
    expect(turn.completions).toEqual([]);
    clock.advance(DEADLINE_MS);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([streamLost]);
    expect(turn.marked, "a server that answers health is kept").toEqual([]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("marks a server that answers neither health nor the new subscription", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdEvent: "later", health: "silent" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    clock.advance(DEADLINE_MS);
    await settleUntil(() => server.healthRequests() > 0);
    clock.advance(PROBE_MS);
    await settleUntil(() => server.eventRequests() === 2);
    expect(server.eventRequests(), "a slow health answer is not proof").toBe(2);
    expect(turn.marked).toEqual([]);
    clock.advance(DEADLINE_MS);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([unresponsive]);
    expect(turn.marked).toEqual([{ pid: 4242, afterPrompt: true }]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("recovers a turn's first stream once, and fails it alone when the new stream sends nothing after it connects", async () => {
  const clock = drivenClock();
  const server = drivenServer({ status: { driven: { type: "busy" } } });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await missStreamDeadline(clock, server);
    expect(server.eventRequests(), "the first stream is recovered").toBe(2);
    expect(turn.completions).toEqual([]);
    await missStreamDeadline(clock, server);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([streamLost]);
    expect(server.eventRequests(), "no third subscription").toBe(2);
    expect(turn.marked).toEqual([]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("shows a subagent's permission request after a silence in which the subagent started", async () => {
  const clock = drivenClock();
  const server = drivenServer({
    status: { driven: { type: "busy" } },
    children: () => ({
      driven: [
        { id: "child", parentID: "driven", time: { created: Date.now() } },
      ],
    }),
    permissions: [
      {
        id: "asked-in-silence",
        sessionID: "child",
        permission: "bash",
        patterns: ["pwd"],
      },
      {
        id: "another-agent",
        sessionID: "elsewhere",
        permission: "bash",
        patterns: ["pwd"],
      },
    ],
  });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await missStreamDeadline(clock, server);
    expect(turn.approvals).toEqual(["asked-in-silence"]);
    server.send(
      frame({
        type: "permission.asked",
        properties: {
          sessionID: "child",
          id: "asked-after",
          permission: "bash",
          patterns: ["ls"],
        },
      }),
    );
    await settleUntil(() => turn.approvals.length > 1);
    expect(turn.approvals).toEqual(["asked-in-silence", "asked-after"]);
    expect(turn.completions).toEqual([]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

// Task 386f6ad1: a subagent reopened with task_id is older than the stream,
// so only the replayed task part names it.
it("shows a reopened subagent's permission request after a silence", async () => {
  const clock = drivenClock();
  const server = drivenServer({
    status: { driven: { type: "busy" } },
    children: () => ({
      driven: [{ id: "child", parentID: "driven", time: { created: 1 } }],
    }),
    messages: () => [
      {
        info: {
          id: "answer-1",
          role: "assistant",
          time: { created: Date.now() },
        },
        parts: [
          {
            type: "tool",
            id: "task-part",
            messageID: "answer-1",
            tool: "task",
            callID: "call-task",
            state: {
              status: "running",
              input: { prompt: "go on", task_id: "child" },
              metadata: { parentSessionId: "driven", sessionId: "child" },
            },
          },
        ],
      },
    ],
    permissions: [
      {
        id: "asked-in-silence",
        sessionID: "child",
        permission: "bash",
        patterns: ["pwd"],
      },
    ],
  });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await missStreamDeadline(clock, server);
    // MUTANT: the recovery delivering the missed requests before the
    // replayed messages drops the request.
    expect(turn.approvals).toEqual(["asked-in-silence"]);
    expect(turn.completions).toEqual([]);
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

const askedBash = (id: string, metadata?: object) =>
  frame({
    type: "permission.asked",
    properties: {
      sessionID: "driven",
      id,
      permission: "bash",
      patterns: ["pwd"],
      ...(metadata ? { metadata } : {}),
    },
  });

// Task 9251ff1d: the turn end withdrew the card, but OpenCode waited on the
// request for ever.
it("rejects to OpenCode a request still open when its stream fails", async () => {
  const clock = drivenClock();
  const server = drivenServer();
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    server.send(askedBash("open", { command: "pwd" }));
    await settleUntil(() => turn.approvals.length > 0);
    expect(turn.approvals, "the request is open").toEqual(["open"]);
    server.fail();
    await settleUntil(
      () => turn.completions.length > 0 && server.replies.length > 0,
    );
    expect(turn.completions).toMatchObject([{ status: "failed" }]);
    expect(turn.withdrawn).toEqual(["open"]);
    // MUTANT: the turn end only withdraws the card.
    expect(server.replies).toEqual([{ id: "open", reply: "reject" }]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

// Task 4817cf7b: a turn that failed after its prompt went out only settled,
// and OpenCode ran the turn on with nobody reading its stream.
for (const [how, options, failTurn] of [
  ["its stream ends", {}, (server) => server.end()],
  ["its stream fails", {}, (server) => server.fail()],
  ["OpenCode refuses its prompt", { promptStatus: 500 }, () => {}],
] as const satisfies readonly (readonly [
  string,
  Parameters<typeof drivenServer>[0],
  (server: ReturnType<typeof drivenServer>) => void,
])[])
  it(`stops its session when ${how} after the prompt went out`, async () => {
    const clock = drivenClock();
    const server = drivenServer(options);
    const turn = drivenTransport(clock, { sessionId: "driven" });
    try {
      await turn.send();
      failTurn(server);
      await settleUntil(
        () => turn.completions.length > 0 && server.aborts() > 0,
      );
      expect(turn.completions).toMatchObject([{ status: "failed" }]);
      expect(server.promptBodies).toHaveLength(1);
      expect(server.aborts()).toBe(1);
      expect(server.log.lastIndexOf("/session/driven/abort")).toBeGreaterThan(
        server.log.indexOf("/session/driven/prompt_async"),
      );
    } finally {
      turn.transport.close();
      server.restore();
    }
  });

// OpenCode must not take the session abort as the answer to the request.
it("stops a failed turn's session only after OpenCode took the reject of its open request", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdReply: true });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await settleUntil(() => turn.approvals.length > 0);
    expect(turn.approvals, "the request is open").toEqual(["asked"]);
    server.fail();
    await settleUntil(() => server.replyPending() && server.aborts() > 0);
    expect(turn.completions).toMatchObject([{ status: "failed" }]);
    expect(server.replies).toEqual([{ id: "asked", reply: "reject" }]);
    expect(server.aborts(), "no abort while the reject is open").toBe(0);
    server.releaseReply();
    await settleUntil(() => server.aborts() > 0);
    expect(server.aborts()).toBe(1);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

// The prompt of the previous turn does not count for this one.
it("does not stop the session when a turn fails before its prompt after an earlier turn sent one", async () => {
  const clock = drivenClock();
  const server = drivenServer();
  let entries = 0;
  const turn = drivenTransport(clock, {
    sessionId: "driven",
    onBeginTurn: () => {
      if (++entries === 2) throw new Error("begin turn failed");
    },
  });
  try {
    await turn.send();
    server.complete();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([{ status: "completed" }]);
    await turn.send();
    await settleUntil(() => turn.completions.length > 1 && server.aborts() > 0);
    expect(entries, "the second turn failed at its entry").toBe(2);
    expect(turn.completions).toMatchObject([
      { status: "completed" },
      { status: "failed" },
    ]);
    expect(server.promptBodies, "one prompt, the first turn's").toHaveLength(1);
    expect(server.aborts()).toBe(0);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

// A queued message starts the next turn on the same session at once. The
// failed turn's late abort must not stop it.
it("sends the next turn's prompt only after the failed turn's session abort answered", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdAbort: true });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    server.fail();
    await settleUntil(() => turn.completions.length > 0 && server.aborts() > 0);
    expect(turn.completions).toMatchObject([{ status: "failed" }]);
    expect(server.aborts(), "the abort is open").toBe(1);
    const next = turn.send();
    await settleUntil(() => server.promptBodies.length > 1);
    expect(server.promptBodies, "the next prompt waits").toHaveLength(1);
    server.releaseAbort();
    await settleUntil(() => server.promptBodies.length > 1);
    expect(server.promptBodies).toHaveLength(2);
    await next;
    server.complete();
    await settleUntil(() => turn.completions.length > 1);
    expect(turn.completions).toMatchObject([
      { status: "failed" },
      { status: "completed" },
    ]);
    expect(server.aborts(), "the next turn is not stopped").toBe(1);
  } finally {
    server.releaseAbort();
    turn.transport.close();
    server.restore();
  }
});

// A server that froze after the failure does not hold the next turn for ever.
it("sends the next turn's prompt at the deadline when the failed turn's session abort never answers", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdAbort: true });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    server.fail();
    await settleUntil(() => turn.completions.length > 0 && server.aborts() > 0);
    const next = turn.send();
    await settleUntil(() => server.promptBodies.length > 1);
    expect(server.promptBodies, "the next prompt waits").toHaveLength(1);
    // A frame moves the stream deadline past the wait's bound.
    clock.advance(DEADLINE_MS / 2);
    server.send(heartbeat());
    await settleUntil(() => false);
    clock.advance(DEADLINE_MS / 2);
    await settleUntil(() => server.promptBodies.length > 1);
    expect(server.promptBodies, "the prompt went at the bound").toHaveLength(2);
    await next;
    expect(server.eventRequests(), "the stream was not recovered").toBe(2);
    server.complete();
    await settleUntil(() => turn.completions.length > 1);
    expect(turn.completions).toMatchObject([
      { status: "failed" },
      { status: "completed" },
    ]);
  } finally {
    server.releaseAbort();
    turn.transport.close();
    server.restore();
  }
});

it("sends no prompt when the member stops the next turn while it waits on the failed turn's session abort", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdAbort: true });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    server.fail();
    await settleUntil(() => turn.completions.length > 0 && server.aborts() > 0);
    const next = turn.send();
    await settleUntil(() => server.promptBodies.length > 1);
    expect(server.promptBodies, "the next prompt waits").toHaveLength(1);
    // The member's stop posts its own abort, which the server also holds.
    void turn.transport.abort();
    server.releaseAbort();
    await settleUntil(() => turn.completions.length > 1);
    server.releaseAbort();
    await next;
    expect(turn.completions).toEqual([
      expect.objectContaining({ status: "failed" }),
      { kind: "turn_completed", status: "interrupted" },
    ]);
    expect(server.promptBodies, "no prompt after the stop").toHaveLength(1);
  } finally {
    server.releaseAbort();
    turn.transport.close();
    server.restore();
  }
});

// Task 9251ff1d: the turn can end between the safety check of a request and
// its card. A request with no command fails the check open, and its warning
// is the moment to end the turn.
it("refuses a request whose turn ends while its safety check runs", async () => {
  const clock = drivenClock();
  const server = drivenServer();
  const turn = drivenTransport(clock, { sessionId: "driven" });
  const events: NormalizedEvent[] = [];
  let endOnNotice = false;
  let endedInCheck = false;
  try {
    await turn.transport.send([{ type: "text", text: "go" }], (event) => {
      events.push(event);
      if (endOnNotice && event.kind === "system_text") {
        endOnNotice = false;
        endedInCheck = true;
        turn.transport.close();
      }
    });
    endOnNotice = true;
    server.send(askedBash("unchecked"));
    await settleUntil(
      () =>
        server.replies.length > 0 ||
        events.some((event) => event.kind === "approval_request"),
    );
    expect(endedInCheck, "the turn ended inside the safety check").toBe(true);
    // MUTANT: no check after the safety handler says "prompt" shows the card
    // after the turn ended.
    expect(events.some((event) => event.kind === "approval_request")).toBe(
      false,
    );
    expect(server.replies).toEqual([{ id: "unchecked", reply: "reject" }]);
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
    await missPreStreamDeadline(clock);
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
    await missPreStreamDeadline(clock);
    await settleUntil(() => server.eventRequests() === 2);
    expect(server.eventRequests(), "one retry after recovery").toBe(2);
    expect(turn.completions).toEqual([]);
    await missPreStreamDeadline(clock);
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
    await missPreStreamDeadline(clock);
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
    await settleUntil(() => server.healthRequests() > 0);
    expect(server.healthRequests(), "one health probe at the bound").toBe(1);
    clock.advance(PROBE_MS - 1);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions, "waits for the probe bound").toEqual([]);
    clock.advance(1);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([unresponsive]);
    expect(turn.marked).toEqual([{ pid: 4242, afterPrompt: false }]);
    expect(turn.notices, "no setup notice on a frozen server").toEqual([]);
    expect(server.requested("/event"), "no subscription").toBe(false);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

// The catalog wait starts once the stream is open, so the stream deadline is
// kept alive with a heartbeat while the clock passes the catalog wait bound.
async function passCatalogWait(
  clock: ReturnType<typeof drivenClock>,
  server: ReturnType<typeof drivenServer>,
): Promise<void> {
  clock.advance(DEADLINE_MS / 2);
  const arms = clock.arms();
  server.send(heartbeat());
  await settleUntil(() => clock.arms() > arms);
  clock.advance(DEADLINE_MS / 2);
}

it("runs a turn at default effort with a notice when the catalog is slow, and keeps the late catalog", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdProvider: "first" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.eventRequests() > 0);
    expect(server.requested("/provider"), "the catalog is pending").toBe(true);
    await settleUntil(() => false);
    await passCatalogWait(clock, server);
    await settleUntil(() => server.promptBodies.length > 0);
    expect(
      server.promptBodies[0],
      "first turn has no variant",
    ).not.toHaveProperty("variant");
    expect(turn.notices, "the member learns of the default effort").toEqual([
      OPENCODE_EFFORT_CATALOG_UNAVAILABLE,
    ]);
    server.complete();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([{ status: "completed" }]);
    expect(turn.marked, "a slow catalog does not mark the server").toEqual([]);

    server.releaseProvider();
    await turn.send();
    expect(server.promptBodies[1], "the late catalog was kept").toMatchObject({
      variant: "high",
    });
    expect(server.providerRequests(), "no second catalog request").toBe(1);
    expect(turn.notices, "no notice once the catalog loads").toHaveLength(1);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("aborts a catalog load that never answers at its bound, and the next turn loads again", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdProvider: "first" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.eventRequests() > 0);
    await settleUntil(() => false);
    await passCatalogWait(clock, server);
    await settleUntil(() => server.promptBodies.length > 0);
    server.complete();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.notices).toEqual([OPENCODE_EFFORT_CATALOG_UNAVAILABLE]);

    // The load timer was armed when the transport acquired its lease, at 0.
    clock.advance(OPENCODE_CATALOG_LOAD_LIMIT_MS - DEADLINE_MS - 1);
    await settleUntil(() => false);
    expect(server.providerAborts(), "still loading before the bound").toBe(0);
    clock.advance(1);
    await settleUntil(() => server.providerAborts() > 0);
    expect(server.providerAborts(), "aborted at the bound").toBe(1);

    await turn.send();
    expect(server.providerRequests(), "the next turn loads again").toBe(2);
    expect(server.promptBodies[1]).toMatchObject({ variant: "high" });
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("does not cancel another waiter when a turn stops waiting for the catalog", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdProvider: "first" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.eventRequests() > 0);
    let listed: string[] | undefined;
    let listFailed = false;
    void discoverOpenCodeModels(turn.supervisor, STATE_ROOT).then(
      (models) => {
        listed = models.flatMap((model) =>
          model.supportedEfforts.map(({ level }) => `${model.id}:${level}`),
        );
      },
      () => {
        listFailed = true;
      },
    );
    await settleUntil(() => false);
    await passCatalogWait(clock, server);
    await settleUntil(() => server.promptBodies.length > 0);
    expect(turn.notices).toEqual([OPENCODE_EFFORT_CATALOG_UNAVAILABLE]);
    expect(listed, "the other waiter still waits").toBeUndefined();
    expect(listFailed, "the other waiter was not cancelled").toBe(false);

    server.releaseProvider();
    await settleUntil(() => listed !== undefined);
    expect(listed).toEqual(["provider/model:high"]);
    expect(server.providerRequests(), "one shared load").toBe(1);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("resolves the effort on the server a turn entry replaced", async () => {
  const clock = drivenClock();
  let serverKey = "old";
  const catalogReads: string[] = [];
  const server = drivenServer({
    variants: () => {
      catalogReads.push(serverKey);
      return serverKey === "old" ? { high: {} } : { low: {} };
    },
  });
  const turn = drivenTransport(clock, {
    sessionId: "driven",
    serverKey: () => serverKey,
    onBeginTurn: () => {
      serverKey = "new";
    },
  });
  try {
    await turn.send();
    expect(catalogReads.at(-1), "the prompt's server was read").toBe("new");
    expect(server.promptBodies[0]).not.toHaveProperty("variant");
    expect(turn.notices).toEqual([
      openCodeEffortUnavailableNotice("provider/model", "high"),
    ]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("resolves the effort on the server that pre-prompt recovery replaced", async () => {
  const clock = drivenClock();
  let serverKey = "old";
  const catalogReads: string[] = [];
  const server = drivenServer({
    holdEvent: "first",
    variants: () => {
      catalogReads.push(serverKey);
      return serverKey === "old" ? { high: {} } : { low: {} };
    },
  });
  const turn = drivenTransport(clock, {
    sessionId: "driven",
    serverKey: () => serverKey,
    onRecover: () => {
      serverKey = "new";
    },
  });
  try {
    void turn.send();
    await settleUntil(() => server.requested("/event"));
    await missPreStreamDeadline(clock);
    await settleUntil(() => server.promptBodies.length > 0);
    expect(turn.recoveries()).toBe(1);
    expect(catalogReads.at(-1), "the prompt's server was read").toBe("new");
    expect(server.promptBodies[0]).not.toHaveProperty("variant");
    expect(turn.notices).toEqual([
      openCodeEffortUnavailableNotice("provider/model", "high"),
    ]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("sends no prompt when the member stops the turn during the catalog wait", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdProvider: "first" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.eventRequests() > 0);
    await settleUntil(() => false);
    await turn.transport.abort();
    await passCatalogWait(clock, server);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([
      { kind: "turn_completed", status: "interrupted" },
    ]);
    expect(server.promptBodies, "no prompt").toHaveLength(0);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("keeps waiting on the same request past the deadline while the server answers health, and completes", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdEvent: "first", health: "healthy" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.requested("/event"));
    clock.advance(DEADLINE_MS);
    await settleUntil(() => turn.notices.length > 0);
    clock.advance(60_000);
    await settleUntil(() => false);
    expect(turn.completions, "still waiting a minute later").toEqual([]);
    server.releaseEvent();
    await settleUntil(() => server.promptBodies.length > 0);
    server.complete();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([{ status: "completed" }]);
    expect(turn.marked, "the server is not marked").toEqual([]);
    expect(turn.recoveries(), "no recovery").toBe(0);
    expect(server.eventRequests(), "the request is never sent again").toBe(1);
    expect(turn.notices, "one notice").toEqual([OPENCODE_FOLDER_SETUP_NOTICE]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("fails at the folder setup bound without marking the server or recovering", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdEvent: "always", health: "healthy" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.requested("/event"));
    clock.advance(DEADLINE_MS);
    await settleUntil(() => turn.notices.length > 0);
    clock.advance(OPENCODE_FOLDER_SETUP_LIMIT_MS - DEADLINE_MS - 1);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions, "still waiting before the bound").toEqual([]);
    clock.advance(1);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([
      {
        kind: "turn_completed",
        status: "failed",
        error: OPENCODE_FOLDER_SETUP_FAILURE,
      },
    ]);
    expect(turn.marked).toEqual([]);
    expect(turn.recoveries()).toBe(0);
    expect(server.eventRequests()).toBe(1);
    expect(server.promptBodies, "no prompt").toEqual([]);
    expect(turn.notices).toEqual([OPENCODE_FOLDER_SETUP_NOTICE]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("ends the turn as stopped when the member stops it during a folder setup wait", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdEvent: "always", health: "healthy" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.requested("/event"));
    clock.advance(DEADLINE_MS);
    await settleUntil(() => turn.notices.length > 0);
    clock.advance(60_000);
    await turn.transport.abort();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([
      { kind: "turn_completed", status: "interrupted" },
    ]);
    expect(turn.marked).toEqual([]);
    expect(turn.recoveries()).toBe(0);
    expect(server.requested("/session/driven/abort"), "no abort request").toBe(
      false,
    );
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("fails the turn before its prompt when the folder's tools lack the safety plugin", async () => {
  const clock = drivenClock();
  const server = drivenServer({ safetyPlugin: false });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([
      {
        kind: "turn_completed",
        status: "failed",
        error: OPENCODE_SAFETY_PLUGIN_MISSING_FAILURE,
      },
    ]);
    expect(server.promptBodies, "no prompt").toEqual([]);
    expect(turn.marked).toEqual([]);
    await settleUntil(() => server.aborts() > 0);
    expect(server.aborts(), "nothing runs to stop").toBe(0);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("keeps the transport text for a stream failure when the health probe times out", async () => {
  const clock = drivenClock();
  const server = drivenServer({ failStreamAtPrompt: true, health: "silent" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await settleUntil(() => server.healthRequests() > 0);
    expect(turn.completions, "waits for the probe").toEqual([]);
    clock.advance(PROBE_MS);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([
      { status: "failed", error: expect.stringContaining("event stream") },
    ]);
    expect(turn.completions[0]?.error).not.toBe(
      OPENCODE_SERVER_STOPPED_FAILURE,
    );
  } finally {
    turn.transport.close();
    server.restore();
  }
});

// A dying server: its process is not reaped yet but refuses health, or its
// pid is already gone.
for (const [dying, health, serverStopped] of [
  ["refuses health", "refused", false],
  ["is stopped", undefined, true],
] as const)
  it(`reports a stream failure in member words when the server ${dying}`, async () => {
    const clock = drivenClock();
    const server = drivenServer({
      failStreamAtPrompt: true,
      ...(health ? { health } : {}),
    });
    const turn = drivenTransport(clock, { sessionId: "driven", serverStopped });
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
      expect(turn.errors).toEqual([
        { name: "Error", code: "ConnectionRefused" },
      ]);
      expect(turn.marked).toEqual([]);
      expect(server.promptBodies).toHaveLength(1);
      await settleUntil(() => server.aborts() > 0);
      expect(server.aborts(), "no session abort to a stopped server").toBe(0);
      expect(JSON.stringify(turn.errors)).not.toContain(CANARY);
    } finally {
      turn.transport.close();
      server.restore();
    }
  });

// Task 430d7bfd: a silence left no record of what the turn waited on. Each
// silence writes one journal line at the deadline, before the recovery's
// effects, with how the recovery ended.
const toolFrame = (status: "pending" | "running" | "completed") =>
  frame({
    type: "message.part.updated",
    properties: {
      sessionID: "driven",
      part: {
        type: "tool",
        id: "tool-part",
        messageID: "answer-1",
        callID: "call-1",
        tool: "bash",
        state: { status, input: { command: `echo ${CANARY}` } },
      },
    },
  });
// Another session's frame, with text that must never reach the journal.
const otherSessionText = () =>
  frame({
    type: "message.part.updated",
    properties: {
      sessionID: "other",
      part: {
        type: "text",
        id: "other-part",
        messageID: "other",
        text: CANARY,
      },
    },
  });

it("journals a silent turn's running tool, its last frames, the probe and its recovery, once per silence", async () => {
  const clock = drivenClock();
  const server = drivenServer({
    status: { driven: { type: "busy" } },
    messages: () => [answer("Hi", false)],
  });
  const turn = drivenTransport(clock, {
    sessionId: "driven",
    agentId: "agent-driven",
  });
  try {
    await turn.send();
    server.send(answerStarted());
    server.send(toolFrame("running"));
    server.send(otherSessionText());
    await settleUntil(() => false);
    await missStreamDeadline(clock, server);
    expect(turn.completions, "the turn goes on").toEqual([]);
    expect(turn.silences).toHaveLength(1);
    const [first] = turn.silences;
    expect(first).toMatchObject({
      agentId: "agent-driven",
      sessionId: "driven",
      silence: 1,
      lastEvent: { type: "message.part.updated:text" },
      lastTurnEvent: { type: "message.part.updated:tool" },
      waitingOn: "tool",
      tools: ["bash"],
      probe: "healthy",
      outcome: "recovered",
      openCodeLog: openCodeLogPath(DRIVEN_PROFILE),
    });
    expect(Date.parse(first.lastTurnEvent!.at)).toBeLessThanOrEqual(
      Date.parse(first.deadlineAt),
    );
    expect(Date.parse(first.promptSentAt!)).toBeLessThanOrEqual(
      Date.parse(first.lastTurnEvent!.at),
    );
    // The new stream sends only its connect frame, so the next silence
    // fails the turn alone. The replay is not a frame the stream sent.
    await missStreamDeadline(clock, server);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([streamLost]);
    expect(turn.silences).toHaveLength(2);
    expect(turn.silences[1]).toMatchObject({
      silence: 2,
      lastEvent: { type: "server.connected" },
      lastTurnEvent: { type: "message.part.updated:tool" },
      waitingOn: "tool",
      tools: ["bash"],
      probe: "healthy",
      outcome: "failed_alone",
    });
    expect(turn.journal, "each silence line before the failure").toEqual([
      "silence",
      "silence",
      "error",
    ]);
    expect(JSON.stringify(turn.silences)).not.toContain(CANARY);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("journals a silent turn that waits on a permission request on a server that refuses health as marked", async () => {
  const clock = drivenClock();
  const server = drivenServer({ holdReply: true, health: "refused" });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    await settleUntil(() => turn.approvals.length > 0);
    expect(turn.approvals, "the member is asked").toEqual(["asked"]);
    clock.advance(DEADLINE_MS);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([unresponsive]);
    expect(turn.silences).toMatchObject([
      {
        waitingOn: "permission",
        permissions: ["bash"],
        lastTurnEvent: { type: "permission.asked" },
        probe: "refused",
        outcome: "marked",
      },
    ]);
    expect(turn.journal).toEqual(["silence", "error"]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("journals a silent turn in a provider retry with its attempt and no provider text", async () => {
  const clock = drivenClock();
  const server = drivenServer({ messages: () => earlierTurn });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    server.send(answerStarted());
    server.send(
      frame({
        type: "session.status",
        properties: {
          sessionID: "driven",
          status: { type: "retry", attempt: 2, message: `HTTP 503 ${CANARY}` },
        },
      }),
    );
    await settleUntil(() => turn.notices.length > 0);
    await missStreamDeadline(clock, server);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([streamLost]);
    expect(turn.silences).toMatchObject([
      {
        lastTurnEvent: { type: "session.status:retry" },
        waitingOn: "retry",
        retryAttempt: 2,
        outcome: "failed_alone",
      },
    ]);
    expect(JSON.stringify(turn.silences)).not.toContain(CANARY);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("journals a silent turn whose model request was open and that finished in the silence as completed", async () => {
  const clock = drivenClock();
  const server = drivenServer({
    messages: () => [...earlierTurn, answer("All done", true)],
  });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    await turn.send();
    server.send(answerStarted());
    server.send(textFrame("All"));
    await settleUntil(() => turn.texts.length > 0);
    await missStreamDeadline(clock, server);
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([{ status: "completed" }]);
    expect(turn.silences).toMatchObject([
      { waitingOn: "model", probe: "healthy", outcome: "completed" },
    ]);
    expect(turn.silences[0].tools).toBeUndefined();
    expect(turn.journal).toEqual(["silence"]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

it("journals a silence before the prompt went out, and one that the turn's close ended", async () => {
  const clock = drivenClock();
  const server = drivenServer({
    holdToolIds: true,
    holdEvent: "later",
    health: "healthy",
  });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  try {
    void turn.send();
    await settleUntil(() => server.toolIdsHeld());
    await missStreamDeadline(clock, server);
    expect(server.eventRequests(), "the new subscription is pending").toBe(2);
    expect(turn.silences, "written when the recovery ends").toEqual([]);
    turn.transport.close();
    await settleUntil(() => turn.silences.length > 0);
    expect(turn.silences).toMatchObject([
      {
        lastEvent: { type: "server.connected" },
        waitingOn: "prompt_not_sent",
        probe: "healthy",
        outcome: "ended",
      },
    ]);
    expect(turn.silences[0].promptSentAt).toBeUndefined();
    expect(turn.silences[0].lastTurnEvent).toBeUndefined();
  } finally {
    turn.transport.close();
    server.releaseToolIds();
    server.restore();
  }
});

// The frames before the silence decide what the journal says it waited on:
// an answer whose model request ended waits on none, and a tool that
// completed leaves the model, without that tool.
const answerEnded = () =>
  frame({
    type: "message.updated",
    properties: {
      sessionID: "driven",
      info: {
        id: "answer-1",
        role: "assistant",
        time: { created: 1, completed: 2 },
      },
    },
  });
for (const [ended, frames, lastTurnEvent, waitingOn] of [
  [
    "an answer's model request",
    () => [answerEnded()],
    "message.updated",
    "none",
  ],
  [
    "a tool",
    () => [toolFrame("running"), toolFrame("completed")],
    "message.part.updated:tool",
    "model",
  ],
] as const)
  it(`journals what a silent turn waits on after ${ended} ended`, async () => {
    const clock = drivenClock();
    const server = drivenServer({ status: { driven: { type: "busy" } } });
    const turn = drivenTransport(clock, { sessionId: "driven" });
    try {
      await turn.send();
      server.send(answerStarted());
      for (const sent of frames()) server.send(sent);
      await settleUntil(() => false);
      await missStreamDeadline(clock, server);
      expect(turn.silences).toMatchObject([
        {
          lastTurnEvent: { type: lastTurnEvent },
          waitingOn,
          outcome: "recovered",
        },
      ]);
      expect(turn.silences[0].tools).toBeUndefined();
    } finally {
      turn.transport.close();
      server.restore();
    }
  });

// recover() makes no request outside its own catch; what can throw in it is
// an injected dependency. Here the deadline scheduler refuses the recovery's
// bound, after the probe and before any outcome.
it("journals a recovery that throws as error, before the turn's failure line", async () => {
  const clock = drivenClock();
  const server = drivenServer({ status: { driven: { type: "busy" } } });
  const turn = drivenTransport(clock, { sessionId: "driven" });
  const arm = clock.scheduler.setTimeout;
  let refuseBound = false;
  clock.scheduler.setTimeout = (callback, delayMs) => {
    if (refuseBound && delayMs === DEADLINE_MS) {
      refuseBound = false;
      throw new Error("scheduler refused");
    }
    return arm(callback, delayMs);
  };
  try {
    await turn.send();
    refuseBound = true;
    await missStreamDeadline(clock, server);
    await settleUntil(() => turn.completions.length > 0);
    expect(refuseBound, "the recovery asked for its bound").toBe(false);
    expect(turn.completions).toMatchObject([{ status: "failed" }]);
    expect(turn.silences).toMatchObject([
      { probe: "healthy", outcome: "error" },
    ]);
    expect(turn.journal).toEqual(["silence", "error"]);
  } finally {
    turn.transport.close();
    server.restore();
  }
});

// Task d4a7031e: a changed setting waits for every turn on the shared server,
// and the turn did not say it ran on the previous settings. The notice is a
// message each reader words (task c37a7365).
const previousSettings = msg("systemEntries.openCodePreviousSettings");
for (const pending of [true, false])
  it(`${pending ? "says once" : "does not say"} that a turn uses the previous settings when the server's replacement ${pending ? "waits" : "does not wait"}`, async () => {
    const clock = drivenClock();
    const server = drivenServer();
    const turn = drivenTransport(clock, {
      sessionId: "driven",
      replacementPending: pending,
    });
    try {
      await turn.send();
      server.complete();
      await settleUntil(() => turn.completions.length > 0);
      expect(turn.completions).toMatchObject([{ status: "completed" }]);
      expect(
        turn.notices.filter(
          (notice) =>
            JSON.stringify(notice) === JSON.stringify(previousSettings),
        ),
      ).toHaveLength(pending ? 1 : 0);
    } finally {
      turn.transport.close();
      server.restore();
    }
  });
