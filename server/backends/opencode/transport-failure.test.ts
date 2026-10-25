// How an OpenCode 2.1.4 turn fails, recovers and ends when the server or its
// event stream misbehaves (task e47be82a): the failed step, the lease, the
// stream deadline and its recovery (T2), the no-progress check (T9), the
// folder setup and catalog waits, and the journal of a silence.
import { afterEach, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { createOpenCodeBackend } from "./adapter.ts";
import {
  discoverOpenCodeModels,
  OPENCODE_CATALOG_LOAD_LIMIT_MS,
  OPENCODE_EFFORT_CATALOG_UNAVAILABLE,
  OPENCODE_EVENT_STREAM_LOST_FAILURE,
  OPENCODE_FOLDER_SETUP_FAILURE,
  OPENCODE_FOLDER_SETUP_LIMIT_MS,
  OPENCODE_FOLDER_SETUP_NOTICE,
  OPENCODE_SERVER_STOPPED_FAILURE,
  OPENCODE_SERVER_UNRESPONSIVE_FAILURE,
  OPENCODE_TURN_PROGRESS_CHECK_MS,
  openCodeEffortUnavailableNotice,
  OpenCodeTransport,
  type OpenCodeErrorContext,
  type OpenCodeStreamSilence,
  type OpenCodeTransportOptions,
  type OpenCodeTurnStep,
  type SafeOpenCodeError,
} from "./transport.ts";
import {
  drivenClock,
  FAKE_CWD,
  FAKE_PROFILE,
  FAKE_SESSION,
  fakeOpenCode,
  fakeSupervisor,
  fakeToolEnvironment,
  framesOf,
  messageItems,
  modelRow,
  settleUntil,
  type FakeLeaseOptions,
  type FakeOptions,
} from "./fake-opencode-v2.ts";
import { openCodeLogPath } from "./profile-paths.ts";
import type { OpenCodeSupervisor } from "./supervisor.ts";
import { OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS as PROBE_MS } from "./server-health.ts";
import type { NormalizedEvent } from "../types.ts";
import { createAgentManager } from "../../agent-manager.ts";
import { OfficeState } from "../../../shared/office-state.ts";
import { STATE_ROOT } from "../../config.ts";
import { msg, type LogText } from "../../../shared/i18n/log-message.ts";

const CANARY = "LOCAL_FAILURE_HEADER_SECRET_CANARY";
const secretFailure = Object.assign(
  new Error(`Authorization: Bearer ${CANARY}`),
  { code: "ConnectionRefused", headers: { authorization: CANARY } },
);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Completion = Extract<NormalizedEvent, { kind: "turn_completed" }>;

// ---------------------------------------------------------------------------
// The failed step of a turn that fails before or at its prompt.

type Stage =
  | "acquire"
  | "session"
  | "session-json"
  | "begin"
  | "events"
  | "recover"
  | "environment"
  | "mcp"
  | "config"
  | "plugin"
  | "instructions"
  | "model"
  | "body"
  | "reader"
  | "prompt"
  | "end"
  | "race";

function stageHarness(stage: Stage) {
  let ended = 0;
  let settles = 0;
  let recoveries = 0;
  const fake = fakeOpenCode({
    sessionId: "failure-session",
    status: {
      ...(stage === "session" ? { "session.create": 503 } : {}),
      ...(stage === "events" || stage === "recover" ? { event: 502 } : {}),
      ...(stage === "environment" ? { "session.environment": 503 } : {}),
      ...(stage === "mcp" ? { "mcp.list": 503 } : {}),
      ...(stage === "config" ? { config: 503 } : {}),
      ...(stage === "plugin" ? { plugin: 503 } : {}),
      ...(stage === "instructions" ? { instructions: 503 } : {}),
      ...(stage === "model" ? { "model.select": 503 } : {}),
      ...(stage === "prompt" ? { prompt: 504 } : {}),
    },
    override: (route, { init }) => {
      if (stage === "session-json" && route === "session.create")
        return new Response("{");
      if (route !== "event" && route !== "prompt") return undefined;
      if (route === "event" && stage === "body") return new Response(null);
      if (route === "event" && (stage === "reader" || stage === "end"))
        return new Response(
          new ReadableStream({
            start(controller) {
              if (stage === "reader") controller.error(secretFailure);
              else controller.close();
            },
          }),
        );
      if (route === "prompt" && stage === "race") {
        fake.failStreams();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return undefined;
    },
  });
  cleanups.push(fake.restore);
  const supervisor = {
    profileDir: FAKE_PROFILE,
    toolEnvironment: fakeToolEnvironment,
    acquire: async () => {
      if (stage === "acquire") throw secretFailure;
      let held = true;
      const endHold = () => {
        if (held) settles++;
        held = false;
      };
      const lease = (await fakeSupervisor().supervisor.acquire()) as object;
      // A live pid: the manager path activates the authority broker on it.
      return Object.assign(lease, {
        pid: process.pid,
        settle: endHold,
        beginTurn: async () => {
          if (stage === "begin") throw secretFailure;
        },
        recoverBeforePrompt: async () => {
          recoveries++;
          if (stage === "recover") throw secretFailure;
        },
        endTurn: () => {
          ended++;
        },
        release: endHold,
      });
    },
  } as unknown as OpenCodeSupervisor;
  return {
    fake,
    supervisor,
    ended: () => ended,
    settles: () => settles,
    recoveries: () => recoveries,
  };
}

// The last column is the step the journal line names (task 8d9561a5).
const stages: Array<
  [Stage, string, string, number | undefined, OpenCodeTurnStep]
> = [
  ["acquire", "OpenCode turn failed", "Error", undefined, "acquire"],
  ["session", "OpenCode turn failed", "Error", 503, "session"],
  ["session-json", "OpenCode turn failed", "SyntaxError", undefined, "session"],
  ["begin", "OpenCode turn failed", "Error", undefined, "begin_turn"],
  ["events", "OpenCode turn failed", "Error", 502, "event_stream"],
  ["body", "OpenCode turn failed", "Error", undefined, "event_stream"],
  ["recover", "OpenCode turn failed", "Error", undefined, "recovery"],
  ["environment", "OpenCode turn failed", "Error", 503, "environment"],
  ["mcp", "OpenCode turn failed", "Error", 503, "mcp"],
  ["config", "OpenCode turn failed", "Error", 503, "config"],
  ["plugin", "OpenCode turn failed", "Error", 503, "safety_plugin"],
  ["instructions", "OpenCode turn failed", "Error", 503, "instructions"],
  ["model", "OpenCode turn failed", "Error", 503, "model"],
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
  ["race", "OpenCode event stream failed", "Error", undefined, "event_stream"],
];

for (const [stage, context, name, statusCode, step] of stages) {
  it(`reports ${stage} failure once with safe class, status and step`, async () => {
    const harness = stageHarness(stage);
    const errors: SafeOpenCodeError[] = [];
    const steps: (OpenCodeTurnStep | undefined)[] = [];
    const events: NormalizedEvent[] = [];
    const transport = new OpenCodeTransport({
      supervisor: harness.supervisor,
      cwd: FAKE_CWD,
      model: "provider/model",
      systemPrompt: "system",
      toolEnvironment: { PATH: "/usr/bin:/bin" },
      safeErrorSink: (error, context) => {
        errors.push(error);
        steps.push(context?.step);
      },
    });
    cleanups.push(() => transport.close());
    await transport.send([{ type: "text", text: "go" }], (event) =>
      events.push(event),
    );
    await settleUntil(() => events.some((e) => e.kind === "turn_completed"));
    const code = ["acquire", "begin", "reader", "recover"].includes(stage)
      ? "ConnectionRefused"
      : stage === "race"
        ? "ECONNRESET"
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
    // replacement waiting.
    expect(harness.settles(), "the acquire's hold ended").toBe(
      stage === "acquire" ? 0 : 1,
    );
    expect(harness.fake.prompts(), "no prompt after an early failure").toBe(
      stage === "prompt" || stage === "race" ? 1 : 0,
    );
    expect(harness.recoveries(), "recovery stays before the prompt").toBe(
      ["events", "body", "recover"].includes(stage) ? 1 : 0,
    );
  });
}

// ---------------------------------------------------------------------------
// Leases and initialization, which no protocol change touches.

function gatedSupervisor(acquireGate?: Promise<void>) {
  let acquires = 0;
  let releases = 0;
  let settles = 0;
  let ended = 0;
  const supervisor = {
    acquire: async () => {
      acquires++;
      if (acquireGate) await acquireGate;
      let held = true;
      const endHold = () => {
        if (held) settles++;
        held = false;
      };
      const lease = (await fakeSupervisor().supervisor.acquire()) as object;
      return Object.assign(lease, {
        settle: endHold,
        endTurn: () => {
          ended++;
        },
        release: () => {
          endHold();
          releases++;
        },
      });
    },
  } as unknown as OpenCodeSupervisor;
  return {
    supervisor,
    acquires: () => acquires,
    releases: () => releases,
    settles: () => settles,
    ended: () => ended,
  };
}

// Task 63efb5b1: the supervisor counts a lease until its release.
it("releases a lease that an acquire returns after close", async () => {
  const fake = fakeOpenCode();
  cleanups.push(fake.restore);
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const lease = gatedSupervisor(gate);
  const transport = new OpenCodeTransport({
    supervisor: lease.supervisor,
    cwd: FAKE_CWD,
    model: "provider/model",
  });
  const read = transport.getSessionMessages().then(
    () => "read",
    () => "rejected",
  );
  transport.close();
  open();
  expect(await read).toBe("rejected");
  expect(lease.acquires()).toBe(1);
  expect(lease.releases()).toBe(1);
});

it("releases the lease of a failed initialization when the next one acquires", async () => {
  const fake = fakeOpenCode({ status: { "session.create": 503 } });
  cleanups.push(fake.restore);
  const lease = gatedSupervisor();
  const transport = new OpenCodeTransport({
    supervisor: lease.supervisor,
    cwd: FAKE_CWD,
    model: "provider/model",
  });
  for (let attempt = 0; attempt < 2; attempt++)
    expect(
      await transport.getSessionMessages().then(
        () => "read",
        () => "rejected",
      ),
    ).toBe("rejected");
  expect(lease.acquires()).toBe(2);
  expect(lease.releases()).toBe(1);
  transport.close();
  expect(lease.releases()).toBe(2);
});

// Task 63efb5b1: two initializations in flight both acquired.
it("shares one acquire between two callers in flight, and only its owner ends the hold", async () => {
  const fake = fakeOpenCode({ hold: { messages: "always" } });
  cleanups.push(fake.restore);
  let openAcquire = () => {};
  const lease = gatedSupervisor(
    new Promise<void>((resolve) => (openAcquire = resolve)),
  );
  const transport = new OpenCodeTransport({
    supervisor: lease.supervisor,
    cwd: FAKE_CWD,
    model: "provider/model",
  });
  cleanups.push(() => transport.close());
  let read = false;
  const owner = transport.getSessionMessages().then(() => {
    read = true;
  });
  const joiner = transport.deleteSession();
  openAcquire();
  await joiner;
  expect(lease.acquires()).toBe(1);
  expect(read, "the owner's work still runs").toBe(false);
  expect(lease.settles(), "the joiner ends no hold").toBe(0);
  await settleUntil(() => fake.heldCount("messages") > 0);
  fake.release("messages");
  await owner;
  expect(lease.settles()).toBe(1);
});

it("starts a turn that waited for another caller's initialization with the session", async () => {
  const fake = fakeOpenCode({ sessionId: "failure-session" });
  cleanups.push(fake.restore);
  let openAcquire = () => {};
  const lease = gatedSupervisor(
    new Promise<void>((resolve) => (openAcquire = resolve)),
  );
  const events: NormalizedEvent[] = [];
  const transport = new OpenCodeTransport({
    supervisor: lease.supervisor,
    cwd: FAKE_CWD,
    model: "provider/model",
    systemPrompt: "system",
  });
  cleanups.push(() => transport.close());
  const read = transport.getSessionMessages();
  const sent = transport.send([{ type: "text", text: "go" }], (event) =>
    events.push(event),
  );
  openAcquire();
  await Promise.all([read, sent]);
  expect(lease.acquires()).toBe(1);
  expect(events.filter((event) => event.kind === "system_init")).toEqual([
    {
      kind: "system_init",
      sessionId: "failure-session",
      model: "provider/model",
    },
  ]);
  expect(fake.prompts(), "the turn began and sent its prompt").toBe(1);
});

// Task 8d9561a5: a turn that failed inside acquire had no lease.
it("names OpenCode's log when the turn fails before acquire returns a lease", async () => {
  const contexts: (OpenCodeErrorContext | undefined)[] = [];
  const transport = new OpenCodeTransport({
    supervisor: {
      profileDir: "/profiles/acquire-failure",
      acquire: async () => {
        throw new Error("replacement failed");
      },
    } as unknown as OpenCodeSupervisor,
    cwd: FAKE_CWD,
    model: "provider/model",
    systemPrompt: "system",
    agentId: "agent-acquire",
    safeErrorSink: (_error, context) => contexts.push(context),
  });
  cleanups.push(() => transport.close());
  await transport.send([{ type: "text", text: "go" }], () => {});
  expect(contexts).toEqual([
    expect.objectContaining({
      agentId: "agent-acquire",
      step: "acquire",
      openCodeLog: openCodeLogPath("/profiles/acquire-failure"),
    }),
  ]);
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
    cwd: FAKE_CWD,
    model: "provider/model",
    systemPrompt: "system",
    safeErrorSink: (safe) => {
      errors.push(safe);
      throw new Error(CANARY);
    },
  });
  cleanups.push(() => transport.close());
  const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => consoleSpy.mockRestore());
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
});

it("does not recover when closure aborts the initial event subscription", async () => {
  const fake = fakeOpenCode({ hold: { event: "always" } });
  cleanups.push(fake.restore);
  const lease = fakeSupervisor();
  const transport = new OpenCodeTransport({
    supervisor: lease.supervisor,
    cwd: FAKE_CWD,
    model: "provider/model",
    systemPrompt: "system",
  });
  const sending = transport.send([{ type: "text", text: "go" }], () => {});
  await settleUntil(() => fake.heldCount("event") > 0);
  transport.close();
  await sending;
  expect(lease.recoveries()).toBe(0);
});

it("persists reader failure class, code and status in the agent log", async () => {
  const harness = stageHarness("reader");
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
    expect(JSON.stringify(mgr.getAgentLogs(agentId))).not.toContain(CANARY);
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
    expect(persisted, "persisted trace scrubs raw message").not.toContain(
      CANARY,
    );
    expect(harness.fake.prompts(), "reader failure prevents the prompt").toBe(
      0,
    );
  } finally {
    await mgr.kill(agentId);
  }
});

it("does not report intentional closure as a turn failure", async () => {
  const holder: { transport?: OpenCodeTransport } = {};
  const fake = fakeOpenCode({
    override: (route, { init }) => {
      if (route !== "prompt") return undefined;
      holder.transport?.close();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
        if (init?.signal?.aborted)
          reject(new DOMException("aborted", "AbortError"));
      });
    },
  });
  cleanups.push(fake.restore);
  const errors: SafeOpenCodeError[] = [];
  const events: NormalizedEvent[] = [];
  const transport = new OpenCodeTransport({
    supervisor: fakeSupervisor().supervisor,
    cwd: FAKE_CWD,
    model: "provider/model",
    systemPrompt: "system",
    safeErrorSink: (error) => errors.push(error),
  });
  holder.transport = transport;
  await transport.send([{ type: "text", text: "go" }], (event) =>
    events.push(event),
  );
  expect(errors).toEqual([]);
  expect(events.filter((event) => event.kind === "turn_completed")).toEqual([]);
});

// Nil, 2026-10-19 (task 9251ff1d): a request that reaches the transport after
// its turn settled gets no card, and OpenCode gets a reject.
for (const agent of [undefined, "build"]) {
  it(`refuses a request that arrives after the turn settles${agent ? " in agent mode" : ""}`, async () => {
    const f = framesOf("failure-session");
    const fake = fakeOpenCode({
      sessionId: "failure-session",
      override: (route, { emit }) => {
        if (route !== "prompt") return undefined;
        const response = new Response(null);
        Object.defineProperty(response, "ok", {
          get() {
            // The frame reaches the reader before send() handles the failed
            // prompt answer.
            emit(f.asked("late", "pwd"));
            throw secretFailure;
          },
        });
        return response;
      },
    });
    cleanups.push(fake.restore);
    const events: NormalizedEvent[] = [];
    const transport = new OpenCodeTransport({
      supervisor: fakeSupervisor().supervisor,
      cwd: FAKE_CWD,
      model: "provider/model",
      systemPrompt: "system",
      ...(agent ? { agent } : {}),
    });
    cleanups.push(() => transport.close());
    await transport.send([{ type: "text", text: "go" }], (event) =>
      events.push(event),
    );
    await settleUntil(
      () =>
        fake.replies.length > 0 ||
        events.some((event) => event.kind === "approval_request"),
    );
    expect(
      events.map((event) => event.kind),
      "the turn failed first, and no card followed it",
    ).toEqual(["system_init", "turn_completed"]);
    // MUTANT (agent mode): the safety handler allows the late request.
    expect(fake.replies.map((r) => [r.id, r.body])).toEqual([
      ["late", { decision: "reject" }],
    ]);
    await transport.approve("late", { kind: "allow_once" });
    expect(
      fake.replies,
      "an answer after the refusal sends nothing",
    ).toHaveLength(1);
  });
}

// ---------------------------------------------------------------------------
// Turns on a driven clock: the stream deadline, recovery and the progress
// check.

const DEADLINE_MS = 1_000;
const f = framesOf(FAKE_SESSION);
// The agent's message, as 2.1.4 stores it: its id is the prompt's input id.
const INPUT_1 = "msg_input_1";

function driven(
  options: {
    fake?: FakeOptions;
    lease?: FakeLeaseOptions;
    transport?: Partial<OpenCodeTransportOptions>;
  } = {},
) {
  const clock = drivenClock();
  const fake = fakeOpenCode(options.fake);
  cleanups.push(fake.restore);
  const lease = fakeSupervisor(options.lease);
  const errors: SafeOpenCodeError[] = [];
  const contexts: (OpenCodeErrorContext | undefined)[] = [];
  const silences: OpenCodeStreamSilence[] = [];
  // Both journal sinks, in the order they wrote.
  const journal: string[] = [];
  const transport = new OpenCodeTransport({
    supervisor: lease.supervisor,
    cwd: FAKE_CWD,
    model: "provider/model",
    effort: "high",
    systemPrompt: "system",
    sessionId: FAKE_SESSION,
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
    ...options.transport,
  });
  cleanups.push(() => transport.close());
  const events: NormalizedEvent[] = [];
  const completions: Completion[] = [];
  const notices: LogText[] = [];
  const texts: string[] = [];
  const approvals: string[] = [];
  const withdrawn: string[] = [];
  const send = () =>
    transport.send([{ type: "text", text: "go" }], (event) => {
      events.push(event);
      if (event.kind === "turn_completed") completions.push(event);
      if (event.kind === "system_text") notices.push(event.text);
      if (event.kind === "assistant_text") texts.push(event.text);
      if (event.kind === "approval_request") approvals.push(event.approvalId);
      if (event.kind === "approval_withdrawn") withdrawn.push(event.approvalId);
    });
  return {
    clock,
    fake,
    lease,
    transport,
    errors,
    contexts,
    silences,
    journal,
    events,
    completions,
    notices,
    texts,
    approvals,
    withdrawn,
    send,
    // A turn that OpenCode took: it delivered the prompt's input.
    sendDelivered: async () => {
      await send();
      fake.emit(f.delivered(`msg_input_${fake.prompts()}`));
      await settleUntil(() => false, 10);
    },
    complete: (message = "msg_answer") =>
      fake.emit(f.stepStarted(message), f.stepEnded(message), f.succeeded()),
    // Time passes with a heartbeat every half deadline: the stream lives.
    beat: async (ms: number) => {
      for (let passed = 0; passed < ms; passed += DEADLINE_MS / 2) {
        fake.heartbeat();
        await settleUntil(() => false, 5);
        clock.advance(Math.min(DEADLINE_MS / 2, ms - passed));
        await settleUntil(() => false, 5);
      }
    },
  };
}

type Driven = ReturnType<typeof driven>;

const unresponsive = {
  kind: "turn_completed",
  status: "failed",
  error: OPENCODE_SERVER_UNRESPONSIVE_FAILURE,
} as const;
const streamLost = {
  kind: "turn_completed",
  status: "failed",
  error: OPENCODE_EVENT_STREAM_LOST_FAILURE,
} as const;

// The deadline, the health probe, and the recovery requests.
async function missStreamDeadline(turn: Driven): Promise<void> {
  const health = turn.fake.count("info");
  turn.clock.advance(DEADLINE_MS);
  await settleUntil(() => turn.fake.count("info") > health);
  await settleUntil(() => false);
}

// The pre-stream deadline on a frozen server: the bound, and then the bound
// of the health probe it sends.
async function missPreStreamDeadline(turn: Driven): Promise<void> {
  turn.clock.advance(DEADLINE_MS);
  await settleUntil(() => false);
  turn.clock.advance(PROBE_MS);
}

// 2.1.4 sends ": heartbeat" every 15 s and no data frame (2026-10-25).
it("keeps a turn whose heartbeats reset the deadline, and names the agent, the failure and OpenCode's log when it misses one", async () => {
  const turn = driven({
    fake: { health: "refused" },
    transport: { agentId: "agent-driven" },
  });
  await turn.sendDelivered();
  for (let beat = 1; beat <= 3; beat++) {
    turn.clock.advance(700);
    const arms = turn.clock.arms();
    turn.fake.heartbeat();
    await settleUntil(() => turn.clock.arms() > arms);
    expect(
      turn.clock.arms(),
      `heartbeat ${beat} re-armed the deadline`,
    ).toBeGreaterThan(arms);
    expect(turn.completions, `alive after ${beat * 700} ms`).toEqual([]);
  }
  turn.clock.advance(DEADLINE_MS);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([unresponsive]);
  expect(turn.lease.marked).toEqual([{ pid: 4242, afterPrompt: true }]);
  // A request to a server that stopped answering has no bound.
  await settleUntil(() => turn.fake.interrupts() > 0);
  expect(turn.fake.interrupts(), "no session interrupt").toBe(0);
  expect(turn.lease.recoveries(), "no replacement inside the turn").toBe(0);
  expect(turn.fake.prompts(), "the prompt is never sent again").toBe(1);
  expect(turn.fake.count("event"), "no second subscription").toBe(1);
  expect(turn.contexts).toEqual([
    {
      agentId: "agent-driven",
      failure: OPENCODE_SERVER_UNRESPONSIVE_FAILURE,
      step: "event_stream",
      openCodeLog: openCodeLogPath(FAKE_PROFILE),
    },
  ]);
});

// T2: /api/event replays nothing, so a recovery reads the session's state.
// Task 439afbc8: one silent stream must not mark the shared server.
it("moves a turn whose stream goes silent to a new stream, with the text it missed, once", async () => {
  const answer = "msg_answer";
  const turn = driven({
    fake: {
      session: () => ({ time: { created: 1, updated: 2_000 } }),
      active: () => ({ [FAKE_SESSION]: { type: "running" } }),
      messages: () => [
        messageItems.user("msg_earlier", "hi", 1),
        messageItems.assistant("msg_earlier_answer", [
          { type: "text", text: "Earlier" },
        ]),
        messageItems.idle("msg_earlier_idle", "succeeded"),
        messageItems.user(INPUT_1, "go", 1_001),
        messageItems.assistant(
          answer,
          [{ type: "text", text: "Hello there" }],
          {
            created: 1_002,
            finished: false,
          },
        ),
      ],
    },
  });
  await turn.sendDelivered();
  turn.fake.emit(f.stepStarted(answer), f.textDelta(answer, "Hello"));
  await settleUntil(() => false);
  expect(turn.texts, "a part shows when it ends (task 3cb130ad)").toEqual([]);
  await missStreamDeadline(turn);
  expect(turn.fake.count("event"), "a second subscription").toBe(2);
  expect(turn.completions, "the turn goes on").toEqual([]);
  // The new stream subscribes before the reads, so nothing after them is
  // lost.
  const paths = turn.fake.requests.map((r) => r.path);
  const subscribed = paths.lastIndexOf("/api/event");
  expect(subscribed).toBeLessThan(
    paths.lastIndexOf(`/api/session/${FAKE_SESSION}`),
  );
  expect(subscribed).toBeLessThan(
    paths.lastIndexOf(`/api/session/${FAKE_SESSION}/message`),
  );
  turn.fake.emit(
    f.textDelta(answer, ", done"),
    f.textEnded(answer, "Hello there, done"),
    f.stepEnded(answer),
    f.succeeded(),
  );
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  // MUTANT: no replay leaves out " there"; a replay of all of it repeats
  // "Hello"; the earlier turn's answer shows again. MUTANT (task 3cb130ad):
  // the replay ends the part that was still streaming, and ", done" is lost.
  expect(turn.texts).toEqual(["Hello there, done"]);
  expect(turn.lease.marked, "the server is not marked").toEqual([]);
  expect(turn.fake.prompts(), "the prompt is never sent again").toBe(1);
});

it("shows text once when the new stream repeats a part the recovery read", async () => {
  const answer = "msg_answer";
  const turn = driven({
    fake: {
      active: () => ({ [FAKE_SESSION]: { type: "running" } }),
      messages: () => [
        messageItems.user(INPUT_1, "go", 1_001),
        messageItems.assistant(answer, [{ type: "text", text: "Hi" }], {
          created: 1_002,
          finished: false,
        }),
      ],
    },
  });
  await turn.sendDelivered();
  await missStreamDeadline(turn);
  // The replay's part is the last of a message that has not finished: it
  // may still stream (task 3cb130ad).
  expect(turn.texts, "the replay leaves the part open").toEqual([]);
  // The part's end, sent between the new subscription and the message read.
  turn.fake.emit(
    f.textEnded(answer, "Hi"),
    f.textDelta(answer, " there", 1),
    f.textEnded(answer, " there", 1),
    f.stepEnded(answer),
    f.succeeded(),
  );
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  // MUTANT: the replay ends the part, and its live end shows it again.
  expect(turn.texts).toEqual(["Hi", " there"]);
});

// Task 3cb130ad: a part shows once, when it ends. A recovery replays every
// part the session stores, the ones the chat already shows included.
it("does not show a part again when a recovery replays it after its end", async () => {
  const answer = "msg_answer";
  const turn = driven({
    fake: {
      active: () => ({ [FAKE_SESSION]: { type: "running" } }),
      messages: () => [
        messageItems.user(INPUT_1, "go", 1_001),
        messageItems.assistant(
          answer,
          [
            { type: "text", text: "Hi" },
            { type: "text", text: " th" },
          ],
          { created: 1_002, finished: false },
        ),
      ],
    },
  });
  await turn.sendDelivered();
  turn.fake.emit(
    f.stepStarted(answer),
    f.textDelta(answer, "H"),
    f.textDelta(answer, "i"),
    f.textEnded(answer, "Hi"),
    f.textDelta(answer, " th", 1),
  );
  await settleUntil(() => turn.texts.length > 0);
  expect(turn.texts, "the first part ended").toEqual(["Hi"]);
  await missStreamDeadline(turn);
  expect(turn.fake.count("event"), "a second subscription").toBe(2);
  turn.fake.emit(
    f.textDelta(answer, "ere", 1),
    f.textEnded(answer, " there", 1),
    f.stepEnded(answer),
    f.succeeded(),
  );
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  // MUTANT: every ended frame shows its part, the replayed one included.
  expect(turn.texts).toEqual(["Hi", " there"]);
});

// Task 3cb130ad: 2.1.4 stores a reasoning part's end as its time.completed,
// and a text part's not at all. A later part does not end a reasoning part:
// text can start before the reasoning ends.
const reasoningFrame = (
  type: "delta" | "ended",
  message: string,
  text: string,
) => ({
  id: `evt_reasoning_${type}_${text}`,
  type: `session.reasoning.${type}`,
  data: {
    sessionID: FAKE_SESSION,
    assistantMessageID: message,
    ordinal: 0,
    ...(type === "delta" ? { delta: text } : { text }),
  },
});
const thoughts = (turn: Driven) =>
  turn.events.flatMap((e) => (e.kind === "thinking" ? [e.text] : []));

it("keeps a replayed reasoning part with no end mark open, before a later part", async () => {
  const answer = "msg_answer";
  const turn = driven({
    fake: {
      active: () => ({ [FAKE_SESSION]: { type: "running" } }),
      messages: () => [
        messageItems.user(INPUT_1, "go", 1_001),
        messageItems.assistant(
          answer,
          [
            { type: "reasoning", text: "Weigh", time: { created: 1_003 } },
            { type: "text", text: "A" },
          ],
          { created: 1_002, finished: false },
        ),
      ],
    },
  });
  await turn.sendDelivered();
  await missStreamDeadline(turn);
  expect(turn.fake.count("event"), "a second subscription").toBe(2);
  expect(thoughts(turn), "the reasoning is open").toEqual([]);
  turn.fake.emit(
    reasoningFrame("delta", answer, " it"),
    reasoningFrame("ended", answer, "Weigh it"),
    f.textDelta(answer, "nswer"),
    f.textEnded(answer, "Answer"),
    f.stepEnded(answer),
    f.succeeded(),
  );
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  // MUTANT: only the message's last part can be open, so the replay ends
  // the reasoning at "Weigh" and " it" is lost.
  expect(thoughts(turn)).toEqual(["Weigh it"]);
  expect(turn.texts).toEqual(["Answer"]);
});

it("shows a replayed reasoning part with an end mark at the replay, even as its message's last part", async () => {
  const answer = "msg_answer";
  const turn = driven({
    fake: {
      active: () => ({ [FAKE_SESSION]: { type: "running" } }),
      messages: () => [
        messageItems.user(INPUT_1, "go", 1_001),
        messageItems.assistant(
          answer,
          [
            { type: "text", text: "Looking" },
            {
              type: "reasoning",
              text: "Read the file",
              time: { created: 1_003, completed: 1_004 },
            },
          ],
          { created: 1_002, finished: false },
        ),
      ],
    },
  });
  await turn.sendDelivered();
  await missStreamDeadline(turn);
  expect(turn.fake.count("event"), "a second subscription").toBe(2);
  turn.fake.emit(
    ...f.toolCalled(answer, "call_read", "read", { path: "a.txt" }),
    f.toolSuccess(answer, "call_read", "content"),
    f.stepEnded(answer),
    f.succeeded(),
  );
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  // MUTANT: the last part of an unfinished message stays open whatever its
  // mark, and the reasoning shows only at the turn's end, after the tool.
  expect(
    turn.events
      .map((e) => e.kind)
      .filter((kind) =>
        ["assistant_text", "thinking", "tool_call"].includes(kind),
      ),
  ).toEqual(["assistant_text", "thinking", "tool_call"]);
  expect(thoughts(turn)).toEqual(["Read the file"]);
});

// Task 3cb130ad: a part shows when it ends. A stream that ends first keeps
// the part's text, once, before the failed end.
it("keeps the text of a part that was open when its stream ended", async () => {
  const turn = driven();
  await turn.sendDelivered();
  turn.fake.emit(
    f.stepStarted("msg_answer"),
    f.textDelta("msg_answer", "Half"),
    f.textDelta("msg_answer", " a sentence"),
  );
  await settleUntil(() => false);
  expect(turn.texts, "the part is open").toEqual([]);
  turn.fake.endStreams();
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "failed" }]);
  // MUTANT: the stream's fail drops the open part, or each delta is an entry.
  expect(turn.texts).toEqual(["Half a sentence"]);
  const order = turn.events.map((e) => e.kind);
  expect(order.indexOf("assistant_text")).toBeLessThan(
    order.indexOf("turn_completed"),
  );
});

it("completes a turn that finished while its stream was silent, from its outcome, with its text and its bill", async () => {
  const answer = "msg_answer";
  const turn = driven({
    fake: {
      session: () => ({
        outcome: "succeeded",
        time: { created: 1, updated: 5_000, idle: 5_000 },
      }),
      messages: () => [
        messageItems.user("msg_earlier", "hi", 1),
        messageItems.assistant("msg_earlier_answer", [
          { type: "text", text: "Earlier" },
        ]),
        messageItems.idle("msg_earlier_idle", "succeeded"),
        messageItems.user(INPUT_1, "go", 1_001),
        messageItems.assistant(answer, [{ type: "text", text: "All done" }], {
          created: 1_002,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        }),
        messageItems.idle("msg_idle", "succeeded", 5_000),
      ],
    },
  });
  await turn.sendDelivered();
  await missStreamDeadline(turn);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  expect(turn.completions[0].usage, "the missed step is billed").toEqual({
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  });
  expect(turn.texts).toEqual(["All done"]);
  expect(turn.lease.marked).toEqual([]);
  expect(turn.fake.interrupts(), "a finished session needs no stop").toBe(0);
});

it("fails a turn whose session failed while its stream was silent", async () => {
  const turn = driven({
    fake: {
      session: () => ({
        outcome: "failed",
        time: { created: 1, updated: 5_000, idle: 5_000 },
      }),
      messages: () => [
        messageItems.user(INPUT_1, "go", 1_001),
        messageItems.idle("msg_idle", "failed", 5_000),
      ],
    },
  });
  await turn.sendDelivered();
  await missStreamDeadline(turn);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "failed" }]);
  expect(turn.lease.marked).toEqual([]);
});

it("ends a turn the member stopped while its stream was silent as stopped", async () => {
  const turn = driven({
    fake: {
      session: () => ({
        outcome: "interrupted",
        time: { created: 1, updated: 5_000, idle: 5_000 },
      }),
      messages: () => [
        messageItems.user(INPUT_1, "go", 1_001),
        messageItems.idle("msg_idle", "interrupted", 5_000),
      ],
    },
  });
  await turn.sendDelivered();
  await turn.transport.abort();
  await missStreamDeadline(turn);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([
    { kind: "turn_completed", status: "interrupted" },
  ]);
  expect(turn.lease.marked).toEqual([]);
});

it("fails only its own turn when a server that answers health does not answer the new subscription", async () => {
  const turn = driven({
    fake: { hold: { event: "later" }, health: "healthy" },
  });
  await turn.sendDelivered();
  await missStreamDeadline(turn);
  expect(turn.fake.count("event"), "the new subscription is pending").toBe(2);
  expect(turn.completions).toEqual([]);
  turn.clock.advance(DEADLINE_MS);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([streamLost]);
  expect(turn.lease.marked, "a server that answers health is kept").toEqual([]);
});

it("marks a server that answers neither health nor the new subscription", async () => {
  const turn = driven({ fake: { hold: { event: "later" }, health: "silent" } });
  await turn.sendDelivered();
  turn.clock.advance(DEADLINE_MS);
  await settleUntil(() => turn.fake.count("info") > 0);
  turn.clock.advance(PROBE_MS);
  await settleUntil(() => turn.fake.count("event") === 2);
  expect(turn.fake.count("event"), "a slow health answer is not proof").toBe(2);
  expect(turn.lease.marked).toEqual([]);
  turn.clock.advance(DEADLINE_MS);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([unresponsive]);
  expect(turn.lease.marked).toEqual([{ pid: 4242, afterPrompt: true }]);
});

it("recovers a turn's first stream once, and fails it alone when the new stream sends nothing after it connects", async () => {
  const turn = driven({
    fake: { active: () => ({ [FAKE_SESSION]: { type: "running" } }) },
  });
  await turn.sendDelivered();
  await missStreamDeadline(turn);
  expect(turn.fake.count("event"), "the first stream is recovered").toBe(2);
  expect(turn.completions).toEqual([]);
  await missStreamDeadline(turn);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([streamLost]);
  expect(turn.fake.count("event"), "no third subscription").toBe(2);
  expect(turn.lease.marked).toEqual([]);
});

it("shows a request the turn's session asked while its stream was silent, once", async () => {
  const asked = f.asked("per_in_silence", "pwd");
  const turn = driven({
    fake: {
      active: () => ({ [FAKE_SESSION]: { type: "running" } }),
      permissions: () => [asked.data],
    },
  });
  await turn.sendDelivered();
  await missStreamDeadline(turn);
  expect(turn.approvals).toEqual(["per_in_silence"]);
  // The new stream repeats it; a later one is new.
  turn.fake.emit(asked, f.asked("per_after", "ls"));
  await settleUntil(() => turn.approvals.length > 1);
  expect(turn.approvals).toEqual(["per_in_silence", "per_after"]);
  expect(turn.completions).toEqual([]);
});

// A subagent that started, or was reopened, and asked during the silence:
// its session.created frame was lost. 2.1.4 lists every open request of the
// folder at GET /api/permission/request, each with its own session, and a
// child session names its parent (probe of 2026-10-25; 2.1.4 has no
// /children route).
it("shows a subagent's and a nested subagent's request asked while the stream was silent, and no other session's", async () => {
  const child = framesOf("ses_child");
  const grandchild = framesOf("ses_grandchild");
  const elsewhere = framesOf("ses_elsewhere");
  const turn = driven({
    fake: {
      active: () => ({ [FAKE_SESSION]: { type: "running" } }),
      permissionRequests: () => [
        child.asked("per_child", "pwd").data,
        grandchild.asked("per_grandchild", "ls").data,
        elsewhere.asked("per_elsewhere", "pwd").data,
      ],
      sessionsById: {
        ses_child: { parentID: FAKE_SESSION },
        ses_grandchild: { parentID: "ses_child" },
        ses_elsewhere: {},
      },
    },
  });
  await turn.sendDelivered();
  await missStreamDeadline(turn);
  await settleUntil(() => turn.approvals.length > 1);
  // MUTANT: only the agent's own session's requests come back.
  expect(turn.approvals.sort()).toEqual(["per_child", "per_grandchild"]);
  expect(
    turn.fake
      .calls("GET", /^\/api\/permission\/request$/)[0]
      .query.get("location[directory]"),
  ).toBe(FAKE_CWD);
  // The children are the turn's now: a later request of one is shown, and
  // an answer goes to its own session's route.
  turn.fake.emit(child.asked("per_child_after", "ls"));
  await settleUntil(() => turn.approvals.length > 2);
  expect(turn.approvals).toContain("per_child_after");
  await turn.transport.approve("per_grandchild", { kind: "allow_once" });
  expect(turn.fake.replies.map((r) => [r.session, r.id])).toEqual([
    ["ses_grandchild", "per_grandchild"],
  ]);
  expect(turn.completions).toEqual([]);
});

it("keeps a turn whose stream frames arrive while a permission reply is pending", async () => {
  const turn = driven({
    fake: { hold: { reply: "always" } },
    transport: { agent: "build" },
  });
  await turn.sendDelivered();
  turn.fake.emit(f.asked("per_held", "pwd"));
  await settleUntil(() => turn.fake.heldCount("reply") > 0);
  expect(turn.fake.heldCount("reply"), "the reply POST is pending").toBe(1);
  for (let beat = 1; beat <= 3; beat++) {
    turn.clock.advance(700);
    const arms = turn.clock.arms();
    turn.fake.heartbeat();
    await settleUntil(() => turn.clock.arms() > arms);
    expect(
      turn.clock.arms(),
      `heartbeat ${beat} re-armed the deadline`,
    ).toBeGreaterThan(arms);
  }
  expect(turn.completions, "alive with the reply still pending").toEqual([]);
  turn.fake.release("reply");
  turn.complete();
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  expect(turn.lease.marked).toEqual([]);
});

// Task 9251ff1d: the turn end withdrew the card, but OpenCode waited on the
// request for ever.
it("rejects to OpenCode a request still open when its stream fails", async () => {
  const turn = driven();
  await turn.sendDelivered();
  turn.fake.emit(f.asked("per_open", "pwd"));
  await settleUntil(() => turn.approvals.length > 0);
  expect(turn.approvals, "the request is open").toEqual(["per_open"]);
  turn.fake.failStreams();
  await settleUntil(
    () => turn.completions.length > 0 && turn.fake.replies.length > 0,
  );
  expect(turn.completions).toMatchObject([{ status: "failed" }]);
  expect(turn.withdrawn).toEqual(["per_open"]);
  // MUTANT: the turn end only withdraws the card.
  expect(turn.fake.replies.map((r) => [r.id, r.body])).toEqual([
    ["per_open", { decision: "reject" }],
  ]);
});

// Task 4817cf7b: a turn that failed after its prompt went out must not run on
// unseen. 2.1.4 stops a session with /interrupt.
for (const [how, options, failTurn] of [
  ["its stream ends", {}, (turn: Driven) => turn.fake.endStreams()],
  ["its stream fails", {}, (turn: Driven) => turn.fake.failStreams()],
  ["OpenCode refuses its prompt", { status: { prompt: 500 } }, () => {}],
] as const)
  it(`stops its session when ${how} after the prompt went out`, async () => {
    const turn = driven({ fake: options });
    await turn.send();
    failTurn(turn);
    await settleUntil(
      () => turn.completions.length > 0 && turn.fake.interrupts() > 0,
    );
    expect(turn.completions).toMatchObject([{ status: "failed" }]);
    expect(turn.fake.interrupts()).toBe(1);
    const paths = turn.fake.requests.map((r) => r.path);
    expect(
      paths.lastIndexOf(`/api/session/${FAKE_SESSION}/interrupt`),
    ).toBeGreaterThan(paths.indexOf(`/api/session/${FAKE_SESSION}/prompt`));
  });

// OpenCode must not take the interrupt as the answer to the request.
it("stops a failed turn's session only after OpenCode took the reject of its open request", async () => {
  const turn = driven({ fake: { hold: { reply: "always" } } });
  await turn.sendDelivered();
  turn.fake.emit(f.asked("per_asked", "pwd"));
  await settleUntil(() => turn.approvals.length > 0);
  turn.fake.failStreams();
  await settleUntil(() => turn.fake.heldCount("reply") > 0);
  await settleUntil(() => turn.fake.interrupts() > 0);
  expect(turn.completions).toMatchObject([{ status: "failed" }]);
  expect(turn.fake.interrupts(), "no interrupt while the reject is open").toBe(
    0,
  );
  turn.fake.release("reply");
  await settleUntil(() => turn.fake.interrupts() > 0);
  expect(turn.fake.replies.map((r) => r.body)).toEqual([
    { decision: "reject" },
  ]);
  expect(turn.fake.interrupts()).toBe(1);
});

it("does not stop the session when a turn fails before its prompt after an earlier turn sent one", async () => {
  let entries = 0;
  const turn = driven({
    lease: {
      onBeginTurn: () => {
        if (++entries === 2) throw new Error("begin turn failed");
      },
    },
  });
  await turn.sendDelivered();
  turn.complete();
  await settleUntil(() => turn.completions.length > 0);
  await turn.send();
  await settleUntil(
    () => turn.completions.length > 1 && turn.fake.interrupts() > 0,
  );
  expect(entries, "the second turn failed at its entry").toBe(2);
  expect(turn.completions).toMatchObject([
    { status: "completed" },
    { status: "failed" },
  ]);
  expect(turn.fake.prompts(), "one prompt, the first turn's").toBe(1);
  expect(turn.fake.interrupts()).toBe(0);
});

// A queued message starts the next turn on the same session at once. The
// failed turn's late interrupt must not stop it.
it("sends the next turn's prompt only after the failed turn's interrupt answered", async () => {
  const turn = driven({ fake: { hold: { interrupt: "always" } } });
  await turn.sendDelivered();
  turn.fake.failStreams();
  await settleUntil(
    () => turn.completions.length > 0 && turn.fake.heldCount("interrupt") > 0,
  );
  expect(turn.completions).toMatchObject([{ status: "failed" }]);
  const next = turn.send();
  await settleUntil(() => turn.fake.prompts() > 1);
  expect(turn.fake.prompts(), "the next prompt waits").toBe(1);
  turn.fake.release("interrupt");
  await settleUntil(() => turn.fake.prompts() > 1);
  expect(turn.fake.prompts()).toBe(2);
  await next;
  turn.fake.emit(f.delivered("msg_input_2"));
  turn.complete();
  await settleUntil(() => turn.completions.length > 1);
  expect(turn.completions).toMatchObject([
    { status: "failed" },
    { status: "completed" },
  ]);
});

it("sends the next turn's prompt at the deadline when the failed turn's interrupt never answers", async () => {
  const turn = driven({ fake: { hold: { interrupt: "always" } } });
  await turn.sendDelivered();
  turn.fake.failStreams();
  await settleUntil(
    () => turn.completions.length > 0 && turn.fake.heldCount("interrupt") > 0,
  );
  const next = turn.send();
  await settleUntil(() => turn.fake.prompts() > 1);
  expect(turn.fake.prompts(), "the next prompt waits").toBe(1);
  await turn.beat(DEADLINE_MS);
  await settleUntil(() => turn.fake.prompts() > 1);
  expect(turn.fake.prompts(), "the prompt went at the bound").toBe(2);
  await next;
  turn.fake.emit(f.delivered("msg_input_2"));
  turn.complete();
  await settleUntil(() => turn.completions.length > 1);
  expect(turn.completions).toMatchObject([
    { status: "failed" },
    { status: "completed" },
  ]);
  turn.fake.release("interrupt");
});

it("sends no prompt when the member stops the next turn while it waits on the failed turn's interrupt", async () => {
  const turn = driven({ fake: { hold: { interrupt: "always" } } });
  await turn.sendDelivered();
  turn.fake.failStreams();
  await settleUntil(
    () => turn.completions.length > 0 && turn.fake.heldCount("interrupt") > 0,
  );
  const next = turn.send();
  await settleUntil(() => turn.fake.prompts() > 1);
  void turn.transport.abort();
  turn.fake.release("interrupt");
  await settleUntil(() => turn.completions.length > 1);
  turn.fake.release("interrupt");
  await next;
  expect(turn.completions).toEqual([
    expect.objectContaining({ status: "failed" }),
    { kind: "turn_completed", status: "interrupted" },
  ]);
  expect(turn.fake.prompts(), "no prompt after the stop").toBe(1);
});

// Task 9251ff1d: the turn can end between the safety check of a request and
// its card. A request with no command fails the check open, and its warning
// is the moment to end the turn.
it("refuses a request whose turn ends while its safety check runs", async () => {
  const turn = driven();
  const events: NormalizedEvent[] = [];
  let endOnNotice = false;
  let endedInCheck = false;
  await turn.transport.send([{ type: "text", text: "go" }], (event) => {
    events.push(event);
    if (endOnNotice && event.kind === "system_text") {
      endOnNotice = false;
      endedInCheck = true;
      turn.transport.close();
    }
  });
  turn.fake.emit(f.delivered(INPUT_1));
  endOnNotice = true;
  const unchecked = f.asked("per_unchecked", "pwd");
  turn.fake.emit({ ...unchecked, data: { ...unchecked.data, resources: [] } });
  await settleUntil(
    () =>
      turn.fake.replies.length > 0 ||
      events.some((event) => event.kind === "approval_request"),
  );
  expect(endedInCheck, "the turn ended inside the safety check").toBe(true);
  // MUTANT: no check after the safety handler says "prompt" shows the card
  // after the turn ended.
  expect(events.some((event) => event.kind === "approval_request")).toBe(false);
  expect(turn.fake.replies.map((r) => [r.id, r.body])).toEqual([
    ["per_unchecked", { decision: "reject" }],
  ]);
});

it("recovers once before the prompt when the event stream headers miss the deadline", async () => {
  const turn = driven({ fake: { hold: { event: "first" }, health: "silent" } });
  void turn.send();
  await settleUntil(() => turn.fake.count("event") > 0);
  expect(turn.completions).toEqual([]);
  await missPreStreamDeadline(turn);
  await settleUntil(() => turn.fake.prompts() > 0);
  expect(turn.lease.marked).toEqual([{ pid: 4242, afterPrompt: false }]);
  expect(turn.lease.recoveries()).toBe(1);
  expect(turn.fake.count("event")).toBe(2);
  expect(turn.fake.prompts(), "the message goes through once").toBe(1);
  turn.fake.emit(f.delivered(INPUT_1));
  turn.complete();
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
});

it("fails in member words when the recovered subscription also misses the deadline", async () => {
  const turn = driven({
    fake: { hold: { event: "always" }, health: "silent" },
  });
  void turn.send();
  await settleUntil(() => turn.fake.count("event") === 1);
  await missPreStreamDeadline(turn);
  await settleUntil(() => turn.fake.count("event") === 2);
  expect(turn.completions).toEqual([]);
  await missPreStreamDeadline(turn);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([unresponsive]);
  expect(turn.lease.recoveries()).toBe(1);
  expect(turn.lease.marked).toEqual([
    { pid: 4242, afterPrompt: false },
    { pid: 4242, afterPrompt: false },
  ]);
  expect(turn.fake.prompts(), "no prompt").toBe(0);
});

it("fails in member words when the guard blocks recovery after a missed subscription deadline", async () => {
  const turn = driven({
    fake: { hold: { event: "first" }, health: "silent" },
    lease: { recoveryBlocked: true },
  });
  void turn.send();
  await settleUntil(() => turn.fake.count("event") > 0);
  await missPreStreamDeadline(turn);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.lease.recoveries(), "recovery was attempted").toBe(1);
  expect(turn.completions).toEqual([unresponsive]);
  expect(turn.lease.marked).toEqual([{ pid: 4242, afterPrompt: false }]);
  expect(turn.fake.count("event"), "no second subscription").toBe(1);
  expect(turn.fake.prompts(), "no prompt").toBe(0);
});

it("fails a turn whose new session request never answers and marks its server", async () => {
  const turn = driven({
    fake: { hold: { "session.create": "always" }, health: "silent" },
    transport: { sessionId: undefined },
  });
  void turn.send();
  await settleUntil(() => turn.fake.count("session.create") > 0);
  expect(turn.completions).toEqual([]);
  turn.clock.advance(DEADLINE_MS);
  await settleUntil(() => turn.fake.count("info") > 0);
  expect(turn.fake.count("info"), "one health probe at the bound").toBe(1);
  turn.clock.advance(PROBE_MS - 1);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions, "waits for the probe bound").toEqual([]);
  turn.clock.advance(1);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([unresponsive]);
  expect(turn.lease.marked).toEqual([{ pid: 4242, afterPrompt: false }]);
  expect(turn.notices, "no setup notice on a frozen server").toEqual([]);
  expect(turn.fake.count("event"), "no subscription").toBe(0);
});

// B1: GET /api/mcp goes through the pre-stream bound like the other requests
// before the prompt; a PUT answers before its MCP server connects (probe,
// 2026-10-25), so a slow MCP server does not reach this bound.
it("fails before the prompt when the MCP list never answers on a server that stopped answering", async () => {
  const turn = driven({
    fake: { hold: { "mcp.list": "always" }, health: "silent" },
  });
  void turn.send();
  await settleUntil(() => turn.fake.count("mcp.list") > 0);
  expect(turn.completions).toEqual([]);
  // Heartbeats keep the stream alive: only the request's bound runs out.
  await turn.beat(DEADLINE_MS + PROBE_MS);
  await settleUntil(() => turn.completions.length > 0);
  // MUTANT: the read outside the bound, so the turn waits for ever.
  expect(turn.completions).toEqual([unresponsive]);
  expect(turn.lease.marked).toEqual([{ pid: 4242, afterPrompt: false }]);
  expect(turn.fake.prompts()).toBe(0);
});

it("keeps waiting on the same request past the deadline while the server answers health, and completes", async () => {
  const turn = driven({
    fake: { hold: { event: "first" }, health: "healthy" },
  });
  void turn.send();
  await settleUntil(() => turn.fake.count("event") > 0);
  turn.clock.advance(DEADLINE_MS);
  await settleUntil(() => turn.notices.length > 0);
  turn.clock.advance(60_000);
  await settleUntil(() => false);
  expect(turn.completions, "still waiting a minute later").toEqual([]);
  turn.fake.release("event");
  await settleUntil(() => turn.fake.prompts() > 0);
  turn.fake.emit(f.delivered(INPUT_1));
  turn.complete();
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  expect(turn.lease.marked, "the server is not marked").toEqual([]);
  expect(turn.lease.recoveries(), "no recovery").toBe(0);
  expect(turn.fake.count("event"), "the request is never sent again").toBe(1);
  expect(turn.notices, "one notice").toEqual([OPENCODE_FOLDER_SETUP_NOTICE]);
});

it("fails at the folder setup bound without marking the server or recovering", async () => {
  const turn = driven({
    fake: { hold: { event: "always" }, health: "healthy" },
  });
  void turn.send();
  await settleUntil(() => turn.fake.count("event") > 0);
  turn.clock.advance(DEADLINE_MS);
  await settleUntil(() => turn.notices.length > 0);
  turn.clock.advance(OPENCODE_FOLDER_SETUP_LIMIT_MS - DEADLINE_MS - 1);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions, "still waiting before the bound").toEqual([]);
  turn.clock.advance(1);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([
    {
      kind: "turn_completed",
      status: "failed",
      error: OPENCODE_FOLDER_SETUP_FAILURE,
    },
  ]);
  expect(turn.lease.marked).toEqual([]);
  expect(turn.lease.recoveries()).toBe(0);
  expect(turn.fake.prompts(), "no prompt").toBe(0);
  expect(turn.notices).toEqual([OPENCODE_FOLDER_SETUP_NOTICE]);
});

it("ends the turn as stopped when the member stops it during a folder setup wait", async () => {
  const turn = driven({
    fake: { hold: { event: "always" }, health: "healthy" },
  });
  void turn.send();
  await settleUntil(() => turn.fake.count("event") > 0);
  turn.clock.advance(DEADLINE_MS);
  await settleUntil(() => turn.notices.length > 0);
  turn.clock.advance(60_000);
  await turn.transport.abort();
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([
    { kind: "turn_completed", status: "interrupted" },
  ]);
  expect(turn.lease.marked).toEqual([]);
  expect(turn.fake.interrupts(), "no interrupt request").toBe(0);
});

it("keeps the transport text for a stream failure when the health probe times out", async () => {
  const turn = driven({
    fake: {
      health: "silent",
      override: (route) => {
        if (route === "prompt") queueMicrotask(() => turn.fake.failStreams());
        return undefined;
      },
    },
  });
  await turn.send();
  await settleUntil(() => turn.fake.count("info") > 0);
  expect(turn.completions, "waits for the probe").toEqual([]);
  turn.clock.advance(PROBE_MS);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([
    { status: "failed", error: expect.stringContaining("event stream") },
  ]);
  expect(turn.completions[0]?.error).not.toBe(OPENCODE_SERVER_STOPPED_FAILURE);
});

// A dying server: its process is not reaped yet but refuses health, or its
// pid is already gone.
for (const [dying, health, serverStopped] of [
  ["refuses health", "refused", false],
  ["is stopped", undefined, true],
] as const)
  it(`reports a stream failure in member words when the server ${dying}`, async () => {
    const turn = driven({
      fake: {
        ...(health ? { health } : {}),
        override: (route) => {
          if (route === "prompt") queueMicrotask(() => turn.fake.failStreams());
          return undefined;
        },
      },
      lease: { serverStopped: () => serverStopped },
    });
    await turn.send();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toEqual([
      {
        kind: "turn_completed",
        status: "failed",
        error: OPENCODE_SERVER_STOPPED_FAILURE,
      },
    ]);
    expect(turn.lease.marked).toEqual([]);
    expect(turn.fake.prompts()).toBe(1);
    await settleUntil(() => turn.fake.interrupts() > 0);
    expect(turn.fake.interrupts(), "no interrupt to a stopped server").toBe(0);
  });

// ---------------------------------------------------------------------------
// T9: a turn whose stream lives but whose session makes no progress. A
// sequence collision (upstream #53146) can leave a turn with no terminal
// frame; heartbeats keep its stream alive.

const PROGRESS_MS = OPENCODE_TURN_PROGRESS_CHECK_MS;

it("fails a turn that makes no progress and that OpenCode no longer runs, and stops its session", async () => {
  const turn = driven({
    fake: {
      // Not running, and its last idle is from before this prompt.
      active: () => ({}),
      session: () => ({
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
      messages: () => [messageItems.user(INPUT_1, "go", 1_001)],
    },
  });
  await turn.sendDelivered();
  turn.fake.emit(f.stepStarted("msg_stuck"));
  await turn.beat(PROGRESS_MS - DEADLINE_MS);
  expect(turn.completions, "no check before the bound").toEqual([]);
  expect(turn.fake.count("session.active")).toBe(0);
  await turn.beat(DEADLINE_MS);
  await settleUntil(
    () => turn.completions.length > 0 && turn.fake.interrupts() > 0,
  );
  expect(turn.fake.count("session.active")).toBeGreaterThan(0);
  // MUTANT: no check, so the turn waits for ever with a live stream.
  expect(turn.completions).toMatchObject([{ status: "failed" }]);
  // A line of its own, not the line of a lost stream.
  expect(turn.completions[0].error).not.toBe(
    OPENCODE_EVENT_STREAM_LOST_FAILURE,
  );
  expect(turn.completions[0].error).not.toBe(
    OPENCODE_SERVER_UNRESPONSIVE_FAILURE,
  );
  expect(turn.fake.interrupts()).toBe(1);
  expect(turn.lease.marked).toEqual([]);
});

// T9: the sequence collision failed the insert of the input itself ("Failed
// to drain Session", fx-seq-migrated, 2026-10-25), so no frame of the turn
// needs to follow the prompt answer.
it("checks a turn whose prompt OpenCode took when no frame of the turn follows", async () => {
  const turn = driven({ fake: { active: () => ({}) } });
  await turn.send();
  await settleUntil(() => false, 10);
  expect(turn.fake.prompts(), "the prompt went out").toBe(1);
  expect(turn.completions).toEqual([]);
  await turn.beat(PROGRESS_MS);
  await settleUntil(() => turn.completions.length > 0);
  // MUTANT: the check starts at a frame only, so this turn waits for ever.
  expect(turn.fake.count("session.active"), "the check ran").toBeGreaterThan(0);
  expect(turn.completions).toMatchObject([{ status: "failed" }]);
  expect(turn.completions[0].error).not.toBe(
    OPENCODE_EVENT_STREAM_LOST_FAILURE,
  );
});

it("keeps waiting on a session that OpenCode still runs, and checks again", async () => {
  const turn = driven({
    fake: { active: () => ({ [FAKE_SESSION]: { type: "running" } }) },
  });
  await turn.sendDelivered();
  turn.fake.emit(
    ...f.toolCalled("msg_tool", "call_1", "shell", { command: "sleep 600" }),
  );
  await turn.beat(PROGRESS_MS);
  await settleUntil(() => turn.fake.count("session.active") > 0);
  const checks = turn.fake.count("session.active");
  expect(checks).toBeGreaterThan(0);
  expect(turn.completions, "a long tool is not a stuck turn").toEqual([]);
  await turn.beat(PROGRESS_MS);
  await settleUntil(() => turn.fake.count("session.active") > checks);
  expect(turn.fake.count("session.active"), "a second check").toBeGreaterThan(
    checks,
  );
  turn.fake.emit(f.toolSuccess("msg_tool", "call_1", "done"));
  turn.complete();
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  expect(turn.fake.interrupts()).toBe(0);
});

it("settles a turn whose session went idle unseen from its outcome", async () => {
  const turn = driven({
    fake: {
      active: () => ({}),
      session: () => ({
        outcome: "succeeded",
        time: { created: 1, updated: 5_000, idle: 5_000 },
      }),
      messages: () => [
        messageItems.user(INPUT_1, "go", 1_001),
        messageItems.assistant("msg_answer", [{ type: "text", text: "Done" }], {
          created: 1_002,
        }),
        messageItems.idle("msg_idle", "succeeded", 5_000),
      ],
    },
  });
  await turn.sendDelivered();
  await turn.beat(PROGRESS_MS);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  expect(turn.texts).toEqual(["Done"]);
  expect(turn.fake.interrupts()).toBe(0);
});

it("does not check a turn that waits for the member's answer (R2)", async () => {
  const turn = driven({ fake: { active: () => ({}) } });
  await turn.sendDelivered();
  turn.fake.emit(f.asked("per_waiting", "pwd"));
  await settleUntil(() => turn.approvals.length > 0);
  await turn.beat(PROGRESS_MS * 3);
  // MUTANT: the clock runs while the member decides, and the "not running"
  // answer fails a turn the member is about to approve.
  expect(turn.fake.count("session.active")).toBe(0);
  expect(turn.completions).toEqual([]);
  await turn.transport.approve("per_waiting", { kind: "allow_once" });
  turn.complete();
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
});

it("restarts the progress check at every frame of the turn's session", async () => {
  const turn = driven({ fake: { active: () => ({}) } });
  await turn.sendDelivered();
  for (let step = 0; step < 3; step++) {
    await turn.beat(PROGRESS_MS - DEADLINE_MS);
    turn.fake.emit(f.textDelta("msg_answer", `part ${step} `));
  }
  expect(turn.fake.count("session.active"), "progress, so no check").toBe(0);
  expect(turn.completions).toEqual([]);
  turn.complete();
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
});

// ---------------------------------------------------------------------------
// The catalog wait.

// The catalog wait starts once the stream is open; a heartbeat keeps the
// stream deadline away while the clock passes the wait's bound.
async function passCatalogWait(turn: Driven): Promise<void> {
  await settleUntil(() => false);
  await turn.beat(DEADLINE_MS);
}

it("runs a turn at default effort with a notice when the catalog is slow, and keeps the late catalog", async () => {
  const turn = driven({ fake: { hold: { catalog: "first" } } });
  void turn.send();
  await settleUntil(() => turn.fake.count("event") > 0);
  expect(turn.fake.heldCount("catalog"), "the catalog is pending").toBe(1);
  await passCatalogWait(turn);
  await settleUntil(() => turn.fake.prompts() > 0);
  expect(turn.fake.calls("POST", /\/model$/)[0].body, "no variant").toEqual({
    model: { providerID: "provider", id: "model" },
  });
  expect(turn.notices).toEqual([OPENCODE_EFFORT_CATALOG_UNAVAILABLE]);
  turn.fake.emit(f.delivered(INPUT_1));
  turn.complete();
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  expect(turn.lease.marked, "a slow catalog does not mark the server").toEqual(
    [],
  );

  turn.fake.release("catalog");
  await turn.send();
  expect(
    turn.fake.calls("POST", /\/model$/)[1].body,
    "the late catalog was kept",
  ).toEqual({
    model: { providerID: "provider", id: "model", variant: "high" },
  });
  expect(turn.fake.count("catalog"), "no second catalog request").toBe(1);
  expect(turn.notices, "no notice once the catalog loads").toHaveLength(1);
});

it("aborts a catalog load that never answers at its bound, and the next turn loads again", async () => {
  const turn = driven({ fake: { hold: { catalog: "first" } } });
  void turn.send();
  await settleUntil(() => turn.fake.count("event") > 0);
  await passCatalogWait(turn);
  await settleUntil(() => turn.fake.prompts() > 0);
  turn.fake.emit(f.delivered(INPUT_1));
  turn.complete();
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.notices).toEqual([OPENCODE_EFFORT_CATALOG_UNAVAILABLE]);
  // The load timer was armed when the transport acquired its lease, at 0.
  turn.clock.advance(OPENCODE_CATALOG_LOAD_LIMIT_MS - DEADLINE_MS - 1);
  await settleUntil(() => false);
  expect(turn.fake.heldCount("catalog"), "still loading before the bound").toBe(
    1,
  );
  turn.clock.advance(1);
  await settleUntil(() => false);
  await turn.send();
  expect(turn.fake.count("catalog"), "the next turn loads again").toBe(2);
  expect(turn.fake.calls("POST", /\/model$/)[1].body).toEqual({
    model: { providerID: "provider", id: "model", variant: "high" },
  });
});

it("does not cancel another waiter when a turn stops waiting for the catalog", async () => {
  const turn = driven({ fake: { hold: { catalog: "first" } } });
  void turn.send();
  await settleUntil(() => turn.fake.count("event") > 0);
  let listed: string[] | undefined;
  let listFailed = false;
  void discoverOpenCodeModels(turn.lease.supervisor, FAKE_CWD).then(
    (models) => {
      listed = models.flatMap((model) =>
        model.supportedEfforts.map(({ level }) => `${model.id}:${level}`),
      );
    },
    () => {
      listFailed = true;
    },
  );
  await passCatalogWait(turn);
  await settleUntil(() => turn.fake.prompts() > 0);
  expect(turn.notices).toEqual([OPENCODE_EFFORT_CATALOG_UNAVAILABLE]);
  expect(listed, "the other waiter still waits").toBeUndefined();
  expect(listFailed, "the other waiter was not cancelled").toBe(false);
  turn.fake.release("catalog");
  await settleUntil(() => listed !== undefined);
  expect(listed).toEqual(["provider/model:high"]);
  expect(turn.fake.count("catalog"), "one shared load").toBe(1);
});

for (const [when, leaseOptions] of [
  ["a turn entry", (replace: () => void) => ({ onBeginTurn: replace })],
  ["pre-prompt recovery", (replace: () => void) => ({ onRecover: replace })],
] as const)
  it(`resolves the effort on the server that ${when} replaced`, async () => {
    let serverKey = "old";
    const catalogReads: string[] = [];
    const turn = driven({
      fake: {
        ...(when === "pre-prompt recovery"
          ? { hold: { event: "first" }, health: "silent" as const }
          : {}),
        models: () => {
          catalogReads.push(serverKey);
          return [
            modelRow("provider", "model", {
              variants: [
                { id: serverKey === "old" ? "high" : "low", settings: {} },
              ],
            }),
          ];
        },
      },
      lease: {
        serverKey: () => serverKey,
        ...leaseOptions(() => {
          serverKey = "new";
        }),
      },
    });
    const sending = turn.send();
    if (when === "pre-prompt recovery") {
      await settleUntil(() => turn.fake.count("event") > 0);
      await missPreStreamDeadline(turn);
    }
    await settleUntil(() => turn.fake.prompts() > 0);
    await sending;
    expect(catalogReads.at(-1), "the prompt's server was read").toBe("new");
    expect(turn.fake.calls("POST", /\/model$/)[0].body).toEqual({
      model: { providerID: "provider", id: "model" },
    });
    expect(turn.notices).toEqual([
      openCodeEffortUnavailableNotice("provider/model", "high"),
    ]);
  });

it("sends no prompt when the member stops the turn during the catalog wait", async () => {
  const turn = driven({ fake: { hold: { catalog: "first" } } });
  void turn.send();
  await settleUntil(() => turn.fake.count("event") > 0);
  await settleUntil(() => false);
  await turn.transport.abort();
  await passCatalogWait(turn);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([
    { kind: "turn_completed", status: "interrupted" },
  ]);
  expect(turn.fake.prompts(), "no prompt").toBe(0);
});

// ---------------------------------------------------------------------------
// The journal of a silence (task 430d7bfd): one line per silence, at the
// deadline, before the recovery's effects, with how the recovery ended. Every
// field is Isomux-authored or an OpenCode name in a fixed shape.

// Another session's frame, with text that must never reach the journal.
const otherSessionText = () =>
  framesOf("ses_other").textDelta("msg_other", CANARY);

it("journals a silent turn's running tool, its last frames, the probe and its recovery, once per silence", async () => {
  const turn = driven({
    fake: { active: () => ({ [FAKE_SESSION]: { type: "running" } }) },
    transport: { agentId: "agent-driven" },
  });
  await turn.sendDelivered();
  turn.fake.emit(
    f.stepStarted("msg_tool"),
    ...f.toolCalled("msg_tool", "call_1", "shell", {
      command: `echo ${CANARY}`,
    }),
    otherSessionText(),
  );
  await settleUntil(() => false);
  await missStreamDeadline(turn);
  expect(turn.completions, "the turn goes on").toEqual([]);
  expect(turn.silences).toHaveLength(1);
  const [first] = turn.silences;
  expect(first).toMatchObject({
    agentId: "agent-driven",
    sessionId: FAKE_SESSION,
    silence: 1,
    lastEvent: { type: "session.text.delta" },
    lastTurnEvent: { type: "session.tool.called" },
    waitingOn: "tool",
    tools: ["shell"],
    probe: "healthy",
    outcome: "recovered",
    openCodeLog: openCodeLogPath(FAKE_PROFILE),
  });
  expect(Date.parse(first.promptSentAt!)).toBeLessThanOrEqual(
    Date.parse(first.lastTurnEvent!.at),
  );
  // The new stream sends only its connect frame, so the next silence fails
  // the turn alone.
  await missStreamDeadline(turn);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([streamLost]);
  expect(turn.silences[1]).toMatchObject({
    silence: 2,
    lastEvent: { type: "server.connected" },
    lastTurnEvent: { type: "session.tool.called" },
    waitingOn: "tool",
    outcome: "failed_alone",
  });
  expect(turn.journal, "each silence line before the failure").toEqual([
    "silence",
    "silence",
    "error",
  ]);
  expect(JSON.stringify(turn.silences)).not.toContain(CANARY);
});

it("journals a silent turn that waits on a permission request on a server that refuses health as marked", async () => {
  const turn = driven({ fake: { health: "refused" } });
  await turn.sendDelivered();
  turn.fake.emit(f.asked("per_asked", "pwd"));
  await settleUntil(() => turn.approvals.length > 0);
  turn.clock.advance(DEADLINE_MS);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toEqual([unresponsive]);
  expect(turn.silences).toMatchObject([
    {
      waitingOn: "permission",
      permissions: ["shell"],
      lastTurnEvent: { type: "permission.asked" },
      probe: "refused",
      outcome: "marked",
    },
  ]);
  expect(turn.journal).toEqual(["silence", "error"]);
});

it("journals a silent turn in a provider retry with its attempt and no provider text", async () => {
  const turn = driven({
    fake: { active: () => ({ [FAKE_SESSION]: { type: "running" } }) },
  });
  await turn.sendDelivered();
  turn.fake.emit(
    f.stepStarted("msg_retry"),
    f.retry("msg_retry", 3, `HTTP 503 ${CANARY}`),
  );
  await settleUntil(() => turn.notices.length > 0);
  await missStreamDeadline(turn);
  expect(turn.silences).toMatchObject([
    {
      lastTurnEvent: { type: "session.retry.scheduled" },
      waitingOn: "retry",
      // Attempt 3 is the second retry.
      retryAttempt: 2,
      outcome: "recovered",
    },
  ]);
  expect(JSON.stringify(turn.silences)).not.toContain(CANARY);
});

it("journals a silent turn whose model step was open and that finished in the silence as completed", async () => {
  const turn = driven({
    fake: {
      session: () => ({
        outcome: "succeeded",
        time: { created: 1, updated: 5_000, idle: 5_000 },
      }),
      messages: () => [
        messageItems.user(INPUT_1, "go", 1_001),
        messageItems.assistant(
          "msg_answer",
          [{ type: "text", text: "All done" }],
          {
            created: 1_002,
          },
        ),
        messageItems.idle("msg_idle", "succeeded", 5_000),
      ],
    },
  });
  await turn.sendDelivered();
  turn.fake.emit(f.stepStarted("msg_answer"), f.textDelta("msg_answer", "All"));
  await settleUntil(() => false);
  await missStreamDeadline(turn);
  await settleUntil(() => turn.completions.length > 0);
  expect(turn.completions).toMatchObject([{ status: "completed" }]);
  expect(turn.texts).toEqual(["All done"]);
  expect(turn.silences).toMatchObject([
    { waitingOn: "model", probe: "healthy", outcome: "completed" },
  ]);
  expect(turn.silences[0].tools).toBeUndefined();
  expect(turn.journal).toEqual(["silence"]);
});

it("journals a silence before the prompt went out, and one that the turn's close ended", async () => {
  const turn = driven({
    fake: { hold: { plugin: "always", event: "later" }, health: "healthy" },
  });
  void turn.send();
  await settleUntil(() => turn.fake.heldCount("plugin") > 0);
  await missStreamDeadline(turn);
  expect(turn.fake.count("event"), "the new subscription is pending").toBe(2);
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
});

// The frames before the silence decide what the journal says it waited on: a
// step that ended waits on none, and a tool that completed leaves the model,
// without that tool.
for (const [ended, frames, lastTurnEvent, waitingOn] of [
  [
    "a model step",
    () => [f.stepStarted("msg_a"), f.stepEnded("msg_a")],
    "session.step.ended",
    "none",
  ],
  [
    "a tool",
    () => [
      f.stepStarted("msg_a"),
      ...f.toolCalled("msg_a", "call_1", "shell", { command: "pwd" }),
      f.toolSuccess("msg_a", "call_1", "ok"),
    ],
    "session.tool.success",
    "model",
  ],
] as const)
  it(`journals what a silent turn waits on after ${ended} ended`, async () => {
    const turn = driven({
      fake: { active: () => ({ [FAKE_SESSION]: { type: "running" } }) },
    });
    await turn.sendDelivered();
    turn.fake.emit(...frames());
    await settleUntil(() => false);
    await missStreamDeadline(turn);
    expect(turn.silences).toMatchObject([
      {
        lastTurnEvent: { type: lastTurnEvent },
        waitingOn,
        outcome: "recovered",
      },
    ]);
    expect(turn.silences[0].tools).toBeUndefined();
  });

// recover() makes no request outside its own catch; what can throw in it is
// an injected dependency. Here the deadline scheduler refuses the recovery's
// bound, after the probe and before any outcome.
it("journals a recovery that throws as error, before the turn's failure line", async () => {
  const turn = driven({
    fake: { active: () => ({ [FAKE_SESSION]: { type: "running" } }) },
  });
  const arm = turn.clock.scheduler.setTimeout;
  let refuseBound = false;
  turn.clock.scheduler.setTimeout = (callback, delayMs) => {
    if (refuseBound && delayMs === DEADLINE_MS) {
      refuseBound = false;
      throw new Error("scheduler refused");
    }
    return arm(callback, delayMs);
  };
  await turn.sendDelivered();
  refuseBound = true;
  await missStreamDeadline(turn);
  await settleUntil(() => turn.completions.length > 0);
  expect(refuseBound, "the recovery asked for its bound").toBe(false);
  expect(turn.completions).toMatchObject([{ status: "failed" }]);
  expect(turn.silences).toMatchObject([{ probe: "healthy", outcome: "error" }]);
  expect(turn.journal).toEqual(["silence", "error"]);
});

// Task d4a7031e: a changed setting waits for every turn on the shared server,
// and the turn says it ran on the previous settings.
const previousSettings = msg("systemEntries.openCodePreviousSettings");
for (const pending of [true, false])
  it(`${pending ? "says once" : "does not say"} that a turn uses the previous settings when the server's replacement ${pending ? "waits" : "does not wait"}`, async () => {
    const turn = driven({ lease: { replacementPending: pending } });
    await turn.sendDelivered();
    turn.complete();
    await settleUntil(() => turn.completions.length > 0);
    expect(turn.completions).toMatchObject([{ status: "completed" }]);
    expect(
      turn.notices.filter(
        (notice) => JSON.stringify(notice) === JSON.stringify(previousSettings),
      ),
    ).toHaveLength(pending ? 1 : 0);
  });
