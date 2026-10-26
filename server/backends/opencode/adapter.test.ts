import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadavg, tmpdir } from "node:os";
import { getBackend } from "../index.ts";
import type { CreateSessionOptions, NormalizedEvent } from "../types.ts";
import {
  buildOpenCodePromptParts,
  createOpenCodeBackend,
  OPENCODE_ONE_SHOT_DIR,
} from "./adapter.ts";
import { OpenCodeSupervisor } from "./supervisor.ts";
import {
  OPENCODE_AUTH_FAILURE,
  OPENCODE_EVENT_STREAM_DEADLINE_MS,
  openCodeModelUnavailableFailure,
} from "./transport.ts";
import { STATE_ROOT } from "../../config.ts";
import { AGENT_ROOT } from "../../split/roots.ts";
import {
  fakeOpenCode,
  fakeSupervisor,
  fakeToolEnvironment,
  framesOf,
  modelRow,
  type FakeOptions,
  type FakeTurn,
  type Frame,
} from "./fake-opencode-v2.ts";
import {
  openCodeLiveConfig,
  openCodeLiveLaunchEnv,
  openCodeMockProvider,
} from "../../test-support/opencode-live-config.ts";
import { removeStateDir } from "../../test-support/temp-state.ts";

const LIVE = process.env.ISOMUX_TEST_OPENCODE === "1";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function livePhase<T>(
  phase: string,
  action: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await action();
  } finally {
    console.info(
      "OpenCode live timing",
      JSON.stringify({
        phase,
        ms: Math.round(performance.now() - started),
        load: loadavg(),
      }),
    );
  }
}
const liveCleanup: Array<() => Promise<void> | void> = [];
const liveProviderTargets = new Map<string, string>();
let liveServer: Promise<OpenCodeSupervisor> | undefined;
// A live case registers its provider path before it asks for the shared server.
// Default runs never call this function and therefore never start this fixture.
function liveSupervisor(): Promise<OpenCodeSupervisor> {
  return (liveServer ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), "isomux-opencode-live-"));
    liveCleanup.push(() => rm(root, { recursive: true, force: true }));
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const [, key, ...path] = url.pathname.split("/");
        const target = liveProviderTargets.get(key);
        if (!target)
          return new Response("Unknown live provider path", { status: 404 });
        return fetch(
          new Request(`${target}/${path.join("/")}${url.search}`, request),
        );
      },
    });
    liveCleanup.push(() => proxy.stop(true));
    const provider = (path: string) =>
      openCodeMockProvider(`http://127.0.0.1:${proxy.port}/${path}/v1`, {
        modelConfig: {
          limit: { context: 100000, output: 10000 },
          variants: ["high", "low", "none", "thinking"].map((id) => ({ id })),
        },
      });
    const supervisor = new OpenCodeSupervisor({
      profileDir: join(root, "profile"),
      serverCwd: root,
      idleShutdownMs: 100,
      launchEnv: openCodeLiveLaunchEnv(join(root, "profile")),
      config: openCodeLiveConfig("gate/gate-model", {
        gate: provider("reply"),
        tools: provider("tools"),
      }),
    });
    liveCleanup.push(() =>
      livePhase("shared server teardown", () => supervisor.shutdown()),
    );
    const lease = await livePhase("shared server start", () =>
      supervisor.acquire(),
    );
    liveCleanup.push(() => lease.release());
    return supervisor;
  })());
}
afterAll(async () => {
  if (!LIVE)
    expect(
      liveServer,
      "Default adapter tests must not start the live OpenCode fixture",
    ).toBeUndefined();
  for (const dispose of liveCleanup.splice(0).reverse()) await dispose();
});

const opts: CreateSessionOptions = {
  agentId: "agent-opencode-tracer",
  cwd: "/tmp",
  systemPrompt: "test",
  modelFamily: "opencode/fake",
  effort: "high",
  permissionMode: "default",
};

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected promise to reject.");
}

describe("OpenCode auth detection", () => {
  // A login card for a model the account cannot use would mislead.
  it("reads only the authentication failure as an auth error", () => {
    const backend = getBackend("opencode");
    expect(backend.detectAuthError(OPENCODE_AUTH_FAILURE)).toBe(true);
    expect(
      backend.detectAuthError(
        openCodeModelUnavailableFailure("opencode-go/deepseek-v4-pro"),
      ),
    ).toBe(false);
  });
});

describe("OpenCode pinned transport", () => {
  function controlledBackstop(delayMs: number) {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let callback: (() => void) | undefined;
    let handle: ReturnType<typeof setTimeout> | undefined;
    let now = 0;
    let armed = false;
    let cleared = false;
    let captures = 0;
    // 1cc892ff: only the one-shot budget is virtual. Transport timers with
    // other delays and Bun.sleep (SSE delivery/cleanup) retain their real clocks.
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: Bun.TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms !== delayMs) return realSetTimeout(fn, ms, ...args);
      captures++;
      callback = () => fn(...args);
      armed = true;
      // A real handle preserves clearTimeout's contract without a live deadline.
      handle = realSetTimeout(() => {}, 2_147_483_647);
      return handle;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
      if (handle !== undefined && id === handle) {
        armed = false;
        cleared = true;
      }
      // Bun, Node and DOM contribute separate overloads for this same native
      // function. The spy accepts their union and forwards the handle unchanged.
      (realClearTimeout as (value: typeof id) => void)(id);
    });
    cleanup.push(() => {
      timer.mockRestore();
      clear.mockRestore();
      if (handle !== undefined) realClearTimeout(handle);
    });
    return {
      advance(ms: number) {
        now += ms;
        expect(captures).toBe(1);
        if (armed && now >= delayMs) {
          armed = false;
          callback!();
        }
      },
      expectCleared() {
        expect(captures).toBe(1);
        expect(cleared).toBe(true);
        expect(armed).toBe(false);
      },
    };
  }

  // A 2.1.4 stand-in for one-shot and session tests. Its models: one paid,
  // two free, each with a 200k context and a 10k output limit.
  const ONE_SHOT_SESSION = "one-shot-session";
  const oneShot = framesOf(ONE_SHOT_SESSION);
  const gateModels = () => [
    modelRow("gate", "paid", { name: "Paid" }),
    modelRow("gate", "alternate", {
      name: "Another free model",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    }),
    modelRow("gate", "free", {
      name: "Free",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    }),
  ];
  // A turn of the one-shot session: the fake swaps INBOX for its input id.
  const oneShotTurn = (frames: object[]): FakeTurn => ({
    frames: [oneShot.delivered("INBOX"), ...frames] as Frame[],
    session: ONE_SHOT_SESSION,
    inbox: "INBOX",
  });

  function oneShotHarness(
    turns: FakeTurn[],
    timeoutMs = 100,
    options: FakeOptions = {},
  ) {
    const fake = fakeOpenCode({
      sessionId: ONE_SHOT_SESSION,
      models: gateModels,
      turns,
      ...options,
    });
    cleanup.push(fake.restore);
    const { supervisor } = fakeSupervisor();
    return {
      fake,
      backend: createOpenCodeBackend({
        supervisor,
        oneShotTimeoutMs: timeoutMs,
      }),
      deletes: () => fake.count("delete"),
    };
  }

  async function untilCompleted(
    session: ReturnType<
      ReturnType<typeof createOpenCodeBackend>["createSession"]
    >,
  ) {
    for await (const event of session.stream())
      if (event.kind === "turn_completed") return event;
    return undefined;
  }

  it("logs redacted provider errors through the default production sink", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => logged.mockRestore());
    const harness = oneShotHarness(
      [
        oneShotTurn([
          oneShot.failed({
            type: "provider.error",
            status: 503,
            message:
              "Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz123456",
          }),
        ]),
      ],
      2_000,
    );
    const session = harness.backend.createSession({
      ...opts,
      modelFamily: "gate/free",
    });
    cleanup.push(() => session.close());
    await session.send("fail");
    expect((await untilCompleted(session))?.status).toBe("failed");
    const entry = logged.mock.calls.find((args) => args[0] === "[opencode]");
    expect(entry).toBeDefined();
    const cause = JSON.parse(String(entry![1]));
    expect(cause).toMatchObject({ name: "provider.error", statusCode: 503 });
    expect(cause.message).toContain("REDACTED");
    expect(cause.message).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("journals a silent event stream through the default production sink", async () => {
    // The stream deadline is virtual; every other timer keeps its real clock.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const deadlines = new Map<unknown, () => void>();
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: Bun.TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms !== OPENCODE_EVENT_STREAM_DEADLINE_MS)
        return realSetTimeout(fn, ms, ...args);
      // A real handle keeps clearTimeout's contract without a live deadline.
      const handle = realSetTimeout(() => {}, 2_147_483_647);
      deadlines.set(handle, () => (fn as (...a: unknown[]) => void)(...args));
      return handle;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
      deadlines.delete(id);
      (realClearTimeout as (value: typeof id) => void)(id);
    });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => {
      for (const handle of deadlines.keys())
        realClearTimeout(handle as ReturnType<typeof setTimeout>);
      timer.mockRestore();
      clear.mockRestore();
      logged.mockRestore();
    });
    // The stream answers and then sends nothing. The health probe gets a
    // 404, so the silence ends with the server marked.
    const harness = oneShotHarness([], 100, { status: { info: 404 } });
    const session = harness.backend.createSession({
      ...opts,
      modelFamily: "gate/free",
    });
    cleanup.push(() => session.close());
    await session.send("wait");
    const until = Date.now() + 2_000;
    while (harness.fake.prompts() === 0 || deadlines.size !== 1) {
      if (Date.now() > until) break;
      await Bun.sleep(5);
    }
    expect(harness.fake.prompts(), "the prompt went out").toBe(1);
    expect(deadlines.size, "one armed stream deadline").toBe(1);
    for (const fire of [...deadlines.values()]) fire();
    expect((await untilCompleted(session))?.status).toBe("failed");
    const silences = logged.mock.calls.filter(
      (args) =>
        args[0] === "[opencode]" &&
        JSON.parse(String(args[1])).event === "event_stream_silent",
    );
    expect(silences).toHaveLength(1);
  });

  const topicTurn = () =>
    oneShotTurn([
      oneShot.stepStarted("msg_topic"),
      oneShot.textDelta("msg_topic", "Topic label"),
      oneShot.textEnded("msg_topic", "Topic label"),
      oneShot.stepEnded("msg_topic"),
      oneShot.succeeded(),
    ]);

  for (const modelFamily of ["gate/paid", "gate/free"]) {
    it(`routes one-shot marker only to selected model ${modelFamily}`, async () => {
      const harness = oneShotHarness([topicTurn()], 2_000);
      const marker = "SYNTHETIC_TOPIC_ROUTING_MARKER";
      const result = await harness.backend
        .oneShotPrompt(marker, { modelFamily })
        .catch((error: unknown) => error);
      // Check every HTTP body before checking the reply or the error text.
      expect(
        harness.fake.requests
          .filter((request) =>
            JSON.stringify(request.body ?? "").includes(marker),
          )
          .map((request) => request.path),
      ).toEqual([`/api/session/${ONE_SHOT_SESSION}/prompt`]);
      expect(harness.fake.calls("POST", /\/model$/).map((r) => r.body)).toEqual(
        [
          {
            model: expect.objectContaining({
              providerID: "gate",
              id: modelFamily.split("/")[1],
            }),
          },
        ],
      );
      expect(result).toBe("Topic label");
    });
  }

  it("runs a topic label in the neutral one-shot folder, never the agent's folder", async () => {
    const harness = oneShotHarness([topicTurn()], 2_000);
    const agentFolder = "/srv/member-project";
    expect(
      await harness.backend.oneShotPrompt("label", {
        cwd: agentFolder,
        modelFamily: "gate/free",
      }),
    ).toBe("Topic label");
    expect(
      JSON.stringify(
        harness.fake.requests.map((r) => [r.path, r.query.toString(), r.body]),
      ),
    ).not.toContain(agentFolder);
    const folders = new Set(
      harness.fake.requests.flatMap((request) => {
        const folder = request.query.get("location[directory]");
        return folder === null ? [] : [folder];
      }),
    );
    expect([...folders]).toEqual([OPENCODE_ONE_SHOT_DIR]);
    expect(
      harness.fake.calls("POST", /^\/api\/session$/)[0].body,
    ).toMatchObject({
      location: { directory: OPENCODE_ONE_SHOT_DIR },
    });
    expect(
      OPENCODE_ONE_SHOT_DIR.startsWith(`${AGENT_ROOT}/`),
      "in agent space",
    ).toBe(true);
  });

  for (const modelFamily of ["retired/preference", ""]) {
    it(`skips one-shot marker for unavailable selection ${JSON.stringify(modelFamily)}`, async () => {
      const harness = oneShotHarness([topicTurn()], 2_000);
      const marker = "SYNTHETIC_TOPIC_SKIP_MARKER";
      const result = await harness.backend
        .oneShotPrompt(marker, { modelFamily })
        .catch((error: unknown) => error);
      expect(
        harness.fake.requests.filter((request) =>
          JSON.stringify(request.body ?? "").includes(marker),
        ),
      ).toEqual([]);
      expect(harness.fake.count("session.create")).toBe(0);
      expect(result).toBeInstanceOf(Error);
    });
  }

  // 2.1.4's input leaves out the cache and its output leaves out reasoning,
  // so a step's context is the sum of the five counts.
  const measuredTurn = (...steps: [string, object][]) =>
    oneShotTurn([
      ...steps.map(([message, tokens]) =>
        oneShot.stepEnded(message, tokens as never),
      ),
      oneShot.succeeded(),
    ]);

  it("reports context fullness from the latest complete OpenCode step", async () => {
    const harness = oneShotHarness([
      measuredTurn(
        [
          "msg_earlier",
          {
            input: 577_000,
            output: 682,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        ],
        [
          "msg_latest",
          {
            input: 913,
            output: 79,
            reasoning: 0,
            cache: { read: 28_928, write: 0 },
          },
        ],
      ),
    ]);
    const session = harness.backend.createSession({
      ...opts,
      modelFamily: "gate/free",
    });
    cleanup.push(() => session.close());
    await session.send("measure");
    await untilCompleted(session);
    expect(await session.getContextUsage()).toEqual({
      model: "gate/free",
      totalTokens: 29_920,
      maxTokens: 200_000,
      percentage: 14.96,
      categories: [
        { name: "Input", tokens: 913 },
        { name: "Cached input", tokens: 28_928 },
        { name: "Cache creation", tokens: 0 },
        { name: "Output", tokens: 79 },
        { name: "Reasoning", tokens: 0 },
      ],
      // The catalog's 10k output limit: OpenCode compacts at context - 10k.
      compactAtTokens: 190_000,
    });
  });

  it("degrades a failed lazy model-limit lookup to no context sample", async () => {
    const harness = oneShotHarness(
      [
        measuredTurn([
          "msg_a",
          { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        ]),
      ],
      100,
      { status: { catalog: 503 } },
    );
    const session = harness.backend.createSession({
      ...opts,
      modelFamily: "gate/free",
    });
    cleanup.push(() => session.close());
    await session.send("measure");
    await untilCompleted(session);
    expect(await session.getContextUsage()).toBeNull();
  });

  it("reports context fullness after resuming an OpenCode session", async () => {
    const harness = oneShotHarness([
      measuredTurn([
        "msg_a",
        {
          input: 1_000,
          output: 500,
          reasoning: 100,
          cache: { read: 48_400, write: 0 },
        },
      ]),
    ]);
    const session = harness.backend.resumeSession(ONE_SHOT_SESSION, {
      ...opts,
      modelFamily: "gate/free",
    });
    cleanup.push(() => session.close());
    await session.send("resume and measure");
    await untilCompleted(session);
    expect(await session.getContextUsage()).toMatchObject({
      model: "gate/free",
      totalTokens: 50_000,
      maxTokens: 200_000,
      percentage: 25,
    });
  });

  it("denies unattended one-shot tool requests with a reason before the timeout backstop", async () => {
    const timeoutMs = 100;
    const clock = controlledBackstop(timeoutMs);
    const asked = oneShot.asked("per_one_shot", "printf one-shot");
    const harness = oneShotHarness(
      [{ ...oneShotTurn([asked]), waitForReplies: true }],
      timeoutMs,
    );
    const result = rejected(
      harness.backend.oneShotPrompt("label", {
        cwd: "/tmp",
        modelFamily: "gate/free",
        systemPrompt: "label only",
      }),
    );
    // A failed prompt also ends this wait, so an early backstop fails the
    // reply assertion instead of hanging on a reply that can never arrive.
    const replied = (async () => {
      while (harness.fake.replies.length === 0) await Bun.sleep(2);
    })();
    await Promise.race([replied, result]);
    clock.advance(timeoutMs);
    const error = await result;
    // R1: the reason goes to OpenCode, so the model reads why.
    expect(harness.fake.replies.map((r) => r.body)).toEqual([
      { decision: "reject", message: expect.stringMatching(/\S/) },
    ]);
    expect(error).toHaveProperty("message", expect.stringMatching(/timed out/));
    clock.expectCleared();
    expect(harness.deletes()).toBe(1);
  });

  it("fails unattended one-shot questions instead of waiting", async () => {
    const timeoutMs = 100;
    const clock = controlledBackstop(timeoutMs);
    const harness = oneShotHarness(
      [
        oneShotTurn([
          {
            type: "form.created",
            created: 1_500,
            data: {
              form: {
                id: "frm_one_shot",
                sessionID: ONE_SHOT_SESSION,
                title: "Questions",
                metadata: {
                  kind: "question",
                  tool: { messageID: "msg_q", id: "call_q" },
                },
                fields: [],
              },
            },
          },
        ]),
      ],
      timeoutMs,
    );
    expect(
      await rejected(
        harness.backend.oneShotPrompt("label", {
          cwd: "/tmp",
          modelFamily: "gate/free",
          systemPrompt: "label only",
        }),
      ),
    ).toHaveProperty(
      "message",
      expect.stringContaining("requested interactive input"),
    );
    clock.expectCleared();
    expect(harness.deletes()).toBe(1);
  });

  it("bounds a one-shot that emits no terminal event", async () => {
    const harness = oneShotHarness([oneShotTurn([])], 10);
    const timer = spyOn(globalThis, "setTimeout");
    cleanup.push(() => timer.mockRestore());
    expect(
      await rejected(
        harness.backend.oneShotPrompt("label", {
          cwd: "/tmp",
          modelFamily: "gate/free",
          systemPrompt: "label only",
        }),
      ),
    ).toHaveProperty("message", expect.stringContaining("timed out"));
    // Check the backstop budget without depending on CPU scheduling.
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 10);
    expect(harness.deletes()).toBe(1);
  });
  it("uses the shared attachment notice contract and fails empty input safe", async () => {
    const agentId = `opencode-attachment-${Date.now()}`;
    const files = join(STATE_ROOT, "logs", agentId, "files");
    await mkdir(files, { recursive: true });
    await writeFile(join(files, "proof.txt"), "proof");
    cleanup.push(() => removeStateDir(join(STATE_ROOT, "logs", agentId)));
    expect(
      buildOpenCodePromptParts(
        "inspect",
        [
          {
            filename: "proof.txt",
            originalName: "proof.txt",
            mediaType: "text/plain",
            size: 5,
          },
          {
            filename: "missing.txt",
            originalName: "missing.txt",
            mediaType: "text/plain",
            size: 1,
          },
        ],
        agentId,
      ),
    ).toEqual([
      { type: "text", text: "inspect" },
      {
        type: "text",
        text: expect.stringContaining(
          '[Attachment: "proof.txt" (text/plain, 5 B) saved at ',
        ),
      },
    ]);
    expect(buildOpenCodePromptParts("", undefined, agentId)).toEqual([
      { type: "text", text: "" },
    ]);
  });

  it("refuses every entry without stable environment identity", async () => {
    const backend = createOpenCodeBackend();
    const refusal = "OpenCode session environment identity is required.";
    expect(() =>
      backend.createSession({ ...opts, modelFamily: "gate/gate-model" }),
    ).toThrow(refusal);
    expect(() => backend.inspectStoredSession("stored", opts)).toThrow(refusal);
    const listed = await backend.listModels({ cwd: "/tmp" }).then(
      () => null,
      (error: unknown) => (error as Error).message,
    );
    expect(listed).toBe(refusal);
  });

  // R7: the 2.1.4 prompt carries no agent, model or system prompt. Each
  // session runs its turn with its own model, instructions and the agent of
  // its current permission mode, also when it was created in another mode.
  it("runs each session's turn with its model, its instructions and the agent of its mode", async () => {
    let nextSession = 0;
    const fake = fakeOpenCode({
      nextSessionId: () => `session-${++nextSession}`,
      models: () => [
        modelRow("alpha", "model-one"),
        modelRow("beta", "model-two"),
        modelRow("gamma", "model-three"),
      ],
    });
    cleanup.push(fake.restore);
    const backend = createOpenCodeBackend({
      supervisor: fakeSupervisor().supervisor,
    });
    const first = backend.createSession({
      ...opts,
      modelFamily: "alpha/model-one",
      env: { MEMBER_VARIABLE: "first" },
    });
    const second = backend.createSession({
      ...opts,
      modelFamily: "beta/model-two",
      permissionMode: "bypassPermissions",
      interactive: true,
      env: { MEMBER_VARIABLE: "second" },
    });
    // Created in the default mode elsewhere (the fake's sessions start as
    // build), resumed here.
    const resumed = backend.resumeSession("session-3", {
      ...opts,
      systemPrompt: "updated after resume",
      modelFamily: "gamma/model-three",
    });
    // An unattended bypass caller (a cron run) gets the narrower profile,
    // though its session was created as build.
    const unattended = backend.resumeSession("session-cron", {
      ...opts,
      modelFamily: "alpha/model-one",
      permissionMode: "bypassPermissions",
    });
    for (const session of [first, second, resumed, unattended])
      cleanup.push(() => session.close());
    const firstInit = first.stream()[Symbol.asyncIterator]().next();
    const secondInit = second.stream()[Symbol.asyncIterator]().next();
    const resumedInit = resumed.stream()[Symbol.asyncIterator]().next();
    await first.send("first");
    await second.send("second");
    await resumed.send("resumed");
    await unattended.send("unattended");
    expect((await firstInit).value).toEqual({
      kind: "system_init",
      sessionId: "session-1",
      model: "alpha/model-one",
    });
    expect((await secondInit).value).toEqual({
      kind: "system_init",
      sessionId: "session-2",
      model: "beta/model-two",
    });
    expect((await resumedInit).value).toEqual({
      kind: "system_init",
      sessionId: "session-3",
      model: "gamma/model-three",
    });
    // MUTANT: the agent set only at create leaves the cron run on build.
    expect(fake.promptLog).toEqual([
      { session: "session-1", text: "first", agent: "build" },
      {
        session: "session-2",
        text: "second",
        agent: "isomux-interactive-bypass",
      },
      { session: "session-3", text: "resumed", agent: "build" },
      { session: "session-cron", text: "unattended", agent: "isomux-cron" },
    ]);
    const bySession = (method: string, pattern: RegExp) =>
      fake
        .calls(method, pattern)
        .map((r) => [
          r.path.split("/")[r.path.split("/").indexOf("session") + 1],
          r.body,
        ]);
    expect(bySession("POST", /\/model$/)).toEqual([
      [
        "session-1",
        { model: { providerID: "alpha", id: "model-one", variant: "high" } },
      ],
      [
        "session-2",
        { model: { providerID: "beta", id: "model-two", variant: "high" } },
      ],
      [
        "session-3",
        { model: { providerID: "gamma", id: "model-three", variant: "high" } },
      ],
      [
        "session-cron",
        { model: { providerID: "alpha", id: "model-one", variant: "high" } },
      ],
    ]);
    // 1010dd4b: each conversation's shell commands get the tool environment
    // of the env it started with, from the supervisor.
    // MUTANT: one environment per server, or the member's env as it is.
    expect(bySession("PUT", /\/environment$/)).toEqual([
      [
        "session-1",
        { variables: fakeToolEnvironment({ MEMBER_VARIABLE: "first" }) },
      ],
      [
        "session-2",
        { variables: fakeToolEnvironment({ MEMBER_VARIABLE: "second" }) },
      ],
      ["session-3", { variables: fakeToolEnvironment(undefined) }],
      ["session-cron", { variables: fakeToolEnvironment(undefined) }],
    ]);
    expect(bySession("PUT", /instructions\/entries\/isomux$/)).toEqual([
      ["session-1", { value: "test" }],
      ["session-2", { value: "test" }],
      ["session-3", { value: "updated after resume" }],
      ["session-cron", { value: "test" }],
    ]);
  }, 10_000);

  // Real subprocess contract: run with bun run test:opencode.
  const replyScenario = (async function* () {
    const root = await mkdtemp(join(tmpdir(), "isomux-opencode-adapter-"));
    liveCleanup.push(() => rm(root, { recursive: true, force: true }));
    const providerRequests: Array<{ path: string; body: string }> = [];
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        providerRequests.push({
          path: url.pathname,
          body: await request.clone().text(),
        });
        if (url.pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: [{ id: "gate-model", object: "model" }],
          });
        }
        if (url.pathname !== "/v1/chat/completions")
          return new Response("not found", { status: 404 });
        const stream = new ReadableStream({
          start(controller) {
            const send = (value: unknown) =>
              controller.enqueue(
                `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
              );
            send({
              id: "gate",
              object: "chat.completion.chunk",
              created: 1,
              model: "gate-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: "OpenCode real tracer reply.",
                  },
                  finish_reason: null,
                },
              ],
            });
            send({
              id: "gate",
              object: "chat.completion.chunk",
              created: 1,
              model: "gate-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            });
            send("[DONE]");
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    liveCleanup.push(() => mock.stop(true));
    liveProviderTargets.set("reply", `http://127.0.0.1:${mock.port}`);
    const supervisor = await liveSupervisor();
    const contractShapes: string[] = [];
    const bindingAgents: Array<{ sessionId: string; agent?: string }> = [];
    const backend = createOpenCodeBackend({
      supervisor,
      contractShapeSink: (shape) => contractShapes.push(shape),
      bindingAgentSink: (sessionId, agent) =>
        bindingAgents.push({ sessionId, agent }),
    });
    const discovered = await backend.listModels({ cwd: root });
    // The mock declares cost {input: 0, output: 0}, so free detection must
    // mark it - a discovery result WITHOUT isFree here would mean the
    // measured-cost predicate silently stopped reading the payload.
    const gateModel = discovered.find(
      (model) => model.id === "gate/gate-model",
    );
    expect(gateModel).toMatchObject({
      id: "gate/gate-model",
      // 2.1.4 model rows name the provider by its id.
      label: "gate - Gate model",
      isFree: true,
    });
    expect(gateModel?.supportedEfforts).toContainEqual({ level: "low" });
    expect(gateModel?.supportedEfforts).toContainEqual({ level: "high" });
    expect(
      gateModel?.supportedEfforts.some(({ level }) => level === "none"),
    ).toBe(false);
    expect(
      gateModel?.supportedEfforts.some(({ level }) => level === "thinking"),
    ).toBe(false);
    expect(discovered.some((model) => model.id.startsWith("offline/"))).toBe(
      false,
    );
    expect(JSON.stringify(discovered)).not.toContain("test-only");
    const skippedMarker = "SYNTHETIC_RETIRED_TOPIC_MARKER";
    const beforeSkipped = providerRequests.length;
    const skipped = await backend
      .oneShotPrompt(skippedMarker, {
        cwd: root,
        modelFamily: "retired/preference",
        systemPrompt: "You only label.",
      })
      .catch((error: unknown) => error);
    expect(
      providerRequests.filter((request) =>
        request.body.includes(skippedMarker),
      ),
    ).toEqual([]);
    expect(
      providerRequests
        .slice(beforeSkipped)
        .some((request) => request.path === "/v1/chat/completions"),
    ).toBe(false);
    expect(skipped).toBeInstanceOf(Error);
    yield; // Discovery and rejected model are complete.
    expect(
      await backend.oneShotPrompt("label this conversation", {
        cwd: root,
        modelFamily: "gate/gate-model",
        systemPrompt: "You only label.",
      }),
    ).toBe("OpenCode real tracer reply.");
    const discoveryLease = await supervisor.acquire();
    const discoveryPid = discoveryLease.pid;
    discoveryLease.release();
    const session = backend.createSession({
      ...opts,
      cwd: root,
      modelFamily: "gate/gate-model",
      permissionMode: "bypassPermissions",
      interactive: true,
    });
    const eventsPromise = (async () => {
      const events: NormalizedEvent[] = [];
      for await (const event of session.stream()) {
        events.push(event);
        if (event.kind === "turn_completed") return events;
      }
      return events;
    })();
    await session.send("hello from Isomux");
    const events = await eventsPromise;
    expect(events[0]).toMatchObject({
      kind: "system_init",
      model: "gate/gate-model",
    });
    expect(events.filter((event) => event.kind === "assistant_text")).toEqual([
      { kind: "assistant_text", text: "OpenCode real tracer reply." },
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "turn_completed",
      status: "completed",
    });
    const sessionLease = await supervisor.acquire();
    expect(sessionLease.pid).toBe(discoveryPid);
    sessionLease.release();
    expect([...new Set(contractShapes)].sort()).toEqual(
      await Bun.file(
        join(import.meta.dir, "fixtures", "s1b-text-contract.json"),
      ).json(),
    );
    yield; // Reply and the captured transport contract are complete.
    const secondTurn = (async () => {
      const turn: NormalizedEvent[] = [];
      for await (const event of session.stream()) {
        turn.push(event);
        if (event.kind === "turn_completed") return turn;
      }
      return turn;
    })();
    await session.send("second parent turn");
    await secondTurn;
    const parentBefore = await backend.getSessionMessages(
      events[0].kind === "system_init" ? events[0].sessionId! : "",
      root,
    );
    const parentId =
      events[0].kind === "system_init" ? events[0].sessionId! : "";
    const defaultReplacement = backend.resumeSession(parentId, {
      ...opts,
      cwd: root,
      modelFamily: "gate/gate-model",
      permissionMode: "default",
      interactive: true,
    });
    defaultReplacement.close();
    expect(
      await backend.getSessionMessages(parentId, root, {
        cwd: root,
        modelFamily: "gate/gate-model",
        permissionMode: "default",
        interactive: true,
        environmentKey: "rebound",
        environmentRevision: "rebound",
      }),
    ).toEqual(parentBefore);
    const target = parentBefore.filter((message) => message.role === "user")[1];
    if (!target)
      throw new Error("OpenCode parent did not record a second user turn");
    const fork = await backend.forkSessionBeforeMessage(parentId, target.uuid, {
      cwd: root,
      modelFamily: "gate/gate-model",
      permissionMode: "default",
      interactive: true,
      environmentKey: "rebound",
      environmentRevision: "rebound",
    });
    expect(fork.kind).toBe("fork");
    if (fork.kind !== "fork") throw new Error("OpenCode fork was not linked");
    expect(
      bindingAgents.findLast((binding) => binding.sessionId === parentId),
    ).toEqual({ sessionId: parentId, agent: undefined });
    expect(
      bindingAgents.findLast((binding) => binding.sessionId === fork.sessionId),
    ).toEqual({ sessionId: fork.sessionId, agent: undefined });
    expect(bindingAgents).not.toContainEqual({
      sessionId: fork.sessionId,
      agent: "isomux-interactive-bypass",
    });
    const childBefore = await backend.getSessionMessages(fork.sessionId, root);
    expect(childBefore.map((message) => message.text)).toEqual([
      "hello from Isomux",
      "OpenCode real tracer reply.",
    ]);
    session.close();
    const child = backend.resumeSession(fork.sessionId, {
      ...opts,
      cwd: root,
      modelFamily: "gate/gate-model",
    });
    const childTurn = (async () => {
      for await (const event of child.stream()) {
        if (event.kind === "turn_completed") return;
      }
    })();
    await child.send("edited second turn");
    await childTurn;
    child.close();
    const parentAfter = await backend.getSessionMessages(parentId, root);
    expect(parentAfter).toEqual(parentBefore);
    yield; // Parent history, fork, and child reply are complete.
  })();
  let completedReplySteps = 0;
  const replySteps = [
    "discovers models and rejects a retired model through the real OpenCode contract",
    "returns one reply through the real OpenCode HTTP and SSE contract",
    "preserves history and forks a child through the real OpenCode contract",
  ];
  for (const [index, name] of replySteps.entries()) {
    it.skipIf(!LIVE)(
      name,
      async () => {
        expect(
          completedReplySteps,
          `Requires successful real OpenCode step ${index}: ${replySteps[index - 1] ?? "initial state"}`,
        ).toBe(index);
        const step = await livePhase(name, () => replyScenario.next());
        expect(
          step.done,
          `Real OpenCode step ${index + 1} did not reach its completion event`,
        ).toBe(false);
        completedReplySteps++;
      },
      40_000,
    );
  }

  // Real subprocess contract: run with bun run test:opencode.
  const toolsScenario = (async function* () {
    const root = await mkdtemp(join(tmpdir(), "isomux-opencode-tools-"));
    liveCleanup.push(() => rm(root, { recursive: true, force: true }));
    const toolStarted = Promise.withResolvers<void>();
    const toolStopped = Promise.withResolvers<void>();
    let toolStartObserved = false;
    let toolStopObserved = false;
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // The tool request stays open until the abort event closes it.
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/tool-started") {
          toolStartObserved = true;
          toolStarted.resolve();
          return new Promise<Response>((resolve) => {
            request.signal.addEventListener(
              "abort",
              () => {
                toolStopObserved = true;
                toolStopped.resolve();
                resolve(new Response("aborted"));
              },
              { once: true },
            );
            liveCleanup.push(() => resolve(new Response("cleanup")));
          });
        }
        if (url.pathname === "/v1/models")
          return Response.json({
            object: "list",
            data: [{ id: "gate-model", object: "model" }],
          });
        if (url.pathname !== "/v1/chat/completions")
          return new Response("not found", { status: 404 });
        const body = (await request.json()) as {
          messages?: Array<Record<string, unknown>>;
        };
        const messages = body.messages ?? [];
        const lastUserIndex = messages.findLastIndex(
          (message) => message.role === "user",
        );
        const content = messages[lastUserIndex]?.content;
        const prompt = typeof content === "string" ? content : "";
        const hasToolResult = messages
          .slice(lastUserIndex + 1)
          .some((message) => message.role === "tool");
        const stream = new ReadableStream({
          start(controller) {
            const send = (value: unknown) =>
              controller.enqueue(
                `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
              );
            const base = {
              id: "gate",
              object: "chat.completion.chunk",
              created: 1,
              model: "gate-model",
            };
            send({
              ...base,
              choices: [
                { index: 0, delta: { role: "assistant" }, finish_reason: null },
              ],
            });
            if (!hasToolResult) {
              const quote = (value: string) =>
                "'" + value.replaceAll("'", "'\\''") + "'";
              const command = prompt.includes("ABORT")
                ? `${quote(process.execPath)} -e ${quote(`await fetch("http://127.0.0.1:${mock.port}/tool-started")`)}`
                : prompt.includes("CRON")
                  ? "printf cron > gate-cron.txt"
                  : prompt.includes("REPO")
                    ? "pwd > repo-observed.txt"
                    : prompt.includes("FAIL")
                      ? "printf failed-before-exit; exit 7"
                      : prompt.includes("DENY")
                        ? "printf denied > gate-denied.txt"
                        : "printf allowed > gate-allowed.txt";
              const edit = prompt.includes("EDIT");
              const toolName = edit ? "edit" : "shell";
              const toolInput = edit
                ? {
                    path: join(root, "gate-edit.txt"),
                    oldString: "before",
                    newString: "after",
                  }
                : { command };
              send({
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_reused",
                          type: "function",
                          function: {
                            name: toolName,
                            arguments: JSON.stringify(toolInput),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
              send({
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              });
            } else {
              send({
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: "checked tool result" },
                    finish_reason: null,
                  },
                ],
              });
              send({
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: { content: "Recovered after tool." },
                    finish_reason: null,
                  },
                ],
              });
              send({
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              });
            }
            send("[DONE]");
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    liveCleanup.push(() => mock.stop(true));
    liveProviderTargets.set("tools", `http://127.0.0.1:${mock.port}`);
    const supervisor = await liveSupervisor();
    const backend = createOpenCodeBackend({ supervisor });
    const run = async (
      text: string,
      allow: boolean,
      repeats = 1,
      cwd = root,
      permissionMode: CreateSessionOptions["permissionMode"] = "default",
    ) => {
      const session = backend.createSession({
        ...opts,
        cwd,
        modelFamily: "tools/gate-model",
        permissionMode,
      });
      const events: NormalizedEvent[] = [];
      const turnWaiters: Array<() => void> = [];
      const consumer = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.kind === "approval_request") {
            expect(event.allowPersistentLabel).toBeUndefined();
            await session.approve(
              event.approvalId,
              allow ? { kind: "allow_once" } : { kind: "deny" },
            );
          }
          if (event.kind === "turn_completed") turnWaiters.shift()?.();
        }
      })();
      for (let index = 0; index < repeats; index++) {
        const done = new Promise<void>((resolve) => turnWaiters.push(resolve));
        await livePhase(`tool reply ${text} ${index + 1}`, async () => {
          await session.send(text);
          await done;
        });
        expect(
          events.filter((event) => event.kind === "turn_completed"),
        ).toHaveLength(index + 1);
      }
      session.close();
      await consumer;
      return events;
    };
    const cronBefore = await supervisor.acquire();
    const cronPid = cronBefore.pid;
    cronBefore.release();
    const abortAtPermission = async () => {
      const session = backend.createSession({
        ...opts,
        cwd: root,
        modelFamily: "tools/gate-model",
      });
      const events: NormalizedEvent[] = [];
      const done = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.kind === "approval_request") await session.abort();
          if (event.kind === "turn_completed") return;
        }
      })();
      await session.send("ABORT PERMISSION");
      await done;
      expect(
        events.filter((event) => event.kind === "turn_completed"),
      ).toHaveLength(1);
      session.close();
      return events;
    };
    const abortDuringTool = async () => {
      const session = backend.createSession({
        ...opts,
        cwd: root,
        modelFamily: "tools/gate-model",
      });
      const events: NormalizedEvent[] = [];
      const aborts: Promise<void>[] = [];
      const done = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.kind === "approval_request") {
            await session.approve(event.approvalId, { kind: "allow_once" });
          }
          if (event.kind === "turn_completed") return;
        }
      })();
      const abortOnStart = toolStarted.promise.then(async () => {
        expect(
          toolStartObserved,
          "Shell-start HTTP event must precede the abort",
        ).toBe(true);
        aborts.push(session.abort());
        await aborts[0];
      });
      await session.send("ABORT TOOL");
      await abortOnStart;
      await done;
      await toolStopped.promise;
      expect(
        toolStopObserved,
        "Aborting the shell must close its pending HTTP request",
      ).toBe(true);
      if (aborts.length !== 1)
        throw new Error("tool abort did not start exactly once");
      await Promise.all(aborts);
      session.close();
      return events;
    };
    const [allowed, denied, failed, cron] = await Promise.all([
      run("ALLOW", true, 2),
      run("DENY", false),
      run("FAIL", true),
      run("CRON", false, 1, root, "bypassPermissions"),
    ]);
    expect(await Bun.file(join(root, "gate-allowed.txt")).text()).toBe(
      "allowed",
    );
    expect(await Bun.file(join(root, "gate-denied.txt")).exists()).toBe(false);
    expect(
      allowed.filter((event) => event.kind === "approval_request"),
    ).toHaveLength(2);
    expect(allowed.filter((event) => event.kind === "tool_call")).toHaveLength(
      2,
    );
    expect(
      allowed.filter((event) => event.kind === "tool_result"),
    ).toHaveLength(2);
    expect(
      allowed.findLastIndex((event) => event.kind === "tool_result"),
    ).toBeLessThan(
      allowed.findLastIndex((event) => event.kind === "turn_completed"),
    );
    expect(allowed.some((event) => event.kind === "thinking")).toBe(true);
    expect(allowed.at(-1)).toMatchObject({
      kind: "turn_completed",
      status: "completed",
    });
    // The policy allows this write, so OpenCode asks and the member denies.
    // The office policy's own block runs in the safety plugin, before any
    // ask (supervisor.test.ts covers it on a real server).
    expect(
      denied.filter((event) => event.kind === "approval_request"),
    ).toHaveLength(1);
    expect(
      denied
        .filter((event) => event.kind === "tool_result")
        .map((event) => event.kind === "tool_result" && event.isError),
    ).toEqual([true]);
    expect(denied.at(-1)).toMatchObject({
      kind: "turn_completed",
      status: "completed",
    });
    expect(
      failed.some((event) => event.kind === "tool_result" && event.isError),
    ).toBe(true);
    expect(
      failed.some(
        (event) =>
          event.kind === "assistant_text" && event.text.includes("Recovered"),
      ),
    ).toBe(true);
    expect(
      cron.filter((event) => event.kind === "approval_request"),
    ).toHaveLength(0);
    expect(cron.at(-1)).toMatchObject({
      kind: "turn_completed",
      status: "completed",
    });
    expect(await Bun.file(join(root, "gate-cron.txt")).text()).toBe("cron");
    yield; // Permission outcomes are complete.
    await Bun.write(join(root, "gate-edit.txt"), "before\n");
    const edited = await run("EDIT", true);
    const [permissionAbort, toolAbort] = await Promise.all([
      abortAtPermission(),
      abortDuringTool(),
    ]);
    expect(await Bun.file(join(root, "gate-edit.txt")).text()).toBe("after\n");
    expect(
      edited.some(
        (event) => event.kind === "tool_call" && event.name === "edit",
      ),
    ).toBe(true);
    const permissionAbortCompletion = permissionAbort.at(-1);
    // Stop may precede the billed step. Accept only the two observed shapes.
    expect(permissionAbortCompletion).toEqual({
      kind: "turn_completed",
      status: "interrupted",
      ...(permissionAbortCompletion?.kind === "turn_completed" &&
      permissionAbortCompletion?.usage
        ? {
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
            cost: 0,
            costMode: "turn",
            usageId: expect.stringMatching(/^[a-f0-9]{64}$/),
          }
        : {}),
    });
    expect(
      toolAbort.filter((event) => event.kind === "tool_call"),
    ).toHaveLength(1);
    expect(
      toolAbort.filter((event) => event.kind === "tool_result"),
    ).toHaveLength(1);
    const toolAbortCompletion = toolAbort.at(-1);
    // Stop may precede the billed step. Accept only the two observed shapes.
    expect(toolAbortCompletion).toEqual({
      kind: "turn_completed",
      status: "interrupted",
      ...(toolAbortCompletion?.kind === "turn_completed" &&
      toolAbortCompletion?.usage
        ? {
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
            cost: 0,
            costMode: "turn",
            usageId: expect.stringMatching(/^[a-f0-9]{64}$/),
          }
        : {}),
    });
    yield; // Edits and both abort paths are complete.
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await Promise.all([mkdir(repoA), mkdir(repoB)]);
    await Promise.all([
      run("REPO A", true, 1, repoA),
      run("REPO B", true, 1, repoB),
    ]);
    const cronAfter = await supervisor.acquire();
    expect(cronAfter.pid).toBe(cronPid);
    cronAfter.release();
    expect(
      (await readFile(join(repoA, "repo-observed.txt"), "utf8")).trim(),
    ).toBe(repoA);
    expect(
      (await readFile(join(repoB, "repo-observed.txt"), "utf8")).trim(),
    ).toBe(repoB);
    yield; // Both working directories are verified.
  })();
  let completedToolsSteps = 0;
  const toolsSteps = [
    "runs and denies controlled shell tools through the real OpenCode permission route",
    "edits and aborts running tools through the real OpenCode permission route",
    "routes tools to two working directories through the real OpenCode contract",
  ];
  for (const [index, name] of toolsSteps.entries()) {
    it.skipIf(!LIVE)(
      name,
      async () => {
        expect(
          completedToolsSteps,
          `Requires successful real OpenCode tools step ${index}: ${toolsSteps[index - 1] ?? "initial state"}`,
        ).toBe(index);
        const step = await livePhase(name, () => toolsScenario.next());
        expect(
          step.done,
          `Real OpenCode tools step ${index + 1} did not reach its completion event`,
        ).toBe(false);
        completedToolsSteps++;
      },
      40_000,
    );
  }
});
