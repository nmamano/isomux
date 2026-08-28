import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getBackend } from "../index.ts";
import type { CreateSessionOptions, NormalizedEvent } from "../types.ts";
import { createOpenCodeBackend, createOpenCodeTracerBackend } from "./adapter.ts";
import { OpenCodeSupervisor } from "./supervisor.ts";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const opts: CreateSessionOptions = {
  agentId: "agent-opencode-tracer",
  cwd: "/tmp",
  systemPrompt: "test",
  modelFamily: "opencode/fake",
  effort: "high",
  permissionMode: "default",
};

async function collect(
  stream: AsyncIterable<NormalizedEvent>,
): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("OpenCode Slice 1A tracer", () => {
  it("is registered with only the capabilities this tracer proves", () => {
    const backend = getBackend("opencode");
    expect(backend.capabilities).toEqual({
      fork: true,
      hooks: false,
      skills: false,
      oneShot: false,
      canUseTool: true,
      topicGen: false,
      edit: true,
      mcp: false,
    });
    expect(backend.inspectStoredSession("stored", opts)).toBe("durable");
    expect(createOpenCodeTracerBackend().capabilities).toMatchObject({
      fork: false,
      edit: false,
    });
  });

  it("emits one deterministic reply through the normalized event contract", async () => {
    const backend = createOpenCodeTracerBackend();
    const session = backend.createSession(opts);
    await session.send("hello");
    session.close();
    expect(await collect(session.stream())).toEqual([
      {
        kind: "system_init",
        sessionId: "opencode-tracer-1",
        model: "opencode/fake",
      },
      { kind: "assistant_text", text: "OpenCode tracer reply." },
      { kind: "turn_completed", status: "completed" },
    ]);
  });

  it("requires exact profile identity before it renders the login command", async () => {
    const backend = createOpenCodeTracerBackend({ failAuth: true });
    const session = backend.createSession(opts);
    await session.send("hello");
    session.close();
    const events = await collect(session.stream());
    expect(events.at(-1)).toEqual({
      kind: "turn_completed",
      status: "failed",
      error: "OpenCode authentication is not configured.",
    });
    expect(() => backend.getLoginInstructions()).toThrow(
      "OpenCode session environment identity is required.",
    );
    const instructions = backend.getLoginInstructions({ environmentKey: "default" });
    expect(instructions.text).toContain("shared environment");
    expect(instructions.text).toContain("Browser OAuth is not certified");
    expect(instructions.commands).toHaveLength(1);
  });
});

describe("OpenCode Slice 1B pinned transport", () => {
  it("refuses a production session without stable environment identity", () => {
    const backend = createOpenCodeBackend();
    expect(() =>
      backend.createSession({ ...opts, modelFamily: "gate/gate-model" }),
    ).toThrow(
      "OpenCode session environment identity is required.",
    );
  });

  it("refuses model discovery without stable environment identity", async () => {
    let failure: unknown;
    try {
      await createOpenCodeBackend().listModels({ cwd: "/tmp" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "OpenCode session environment identity is required.",
    );
  });

  it("rejects a legacy tracer model with a repair instruction", () => {
    const backend = createOpenCodeBackend({
      supervisor: {} as OpenCodeSupervisor,
    });
    expect(() => backend.createSession(opts)).toThrow(
      "Open agent settings and select a connected model",
    );
  });

  it("keeps each session model in system init and the prompt wire body", async () => {
    let nextSession = 0;
    let nextEvent = 0;
    const promptModels: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/session" && request.method === "POST") {
          return Response.json({ id: `session-${++nextSession}` });
        }
        if (url.pathname === "/event") {
          const sessionId = `session-${++nextEvent}`;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: sessionId } })}\n\n`,
                  ),
                );
                controller.close();
              },
            }),
            {
            headers: { "content-type": "text/event-stream" },
            },
          );
        }
        if (url.pathname.endsWith("/prompt_async")) {
          const body = (await request.json()) as { model?: unknown };
          promptModels.push(body.model);
          return Response.json(true);
        }
        return new Response("not found", { status: 404 });
      },
    });
    cleanup.push(() => server.stop(true));
    const lease = {
      get pid() {
        return 1;
      },
      get baseUrl() {
        return `http://127.0.0.1:${server.port}`;
      },
      get authHeader() {
        return "Basic test";
      },
      beginTurn: async () => {},
      endTurn: () => {},
      release: () => {},
    };
    const supervisor = {
      acquire: async () => lease,
    } as unknown as OpenCodeSupervisor;
    const backend = createOpenCodeBackend({ supervisor });
    const first = backend.createSession({
      ...opts,
      modelFamily: "alpha/model-one",
    });
    const second = backend.createSession({
      ...opts,
      modelFamily: "beta/model-two",
    });
    const firstInit = first.stream()[Symbol.asyncIterator]().next();
    const secondInit = second.stream()[Symbol.asyncIterator]().next();
    await first.send("first");
    await second.send("second");
    expect(await firstInit).toEqual({
      done: false,
      value: {
        kind: "system_init",
        sessionId: "session-1",
        model: "alpha/model-one",
      },
    });
    expect(await secondInit).toEqual({
      done: false,
      value: {
        kind: "system_init",
        sessionId: "session-2",
        model: "beta/model-two",
      },
    });
    expect(promptModels).toEqual([
      { providerID: "alpha", modelID: "model-one" },
      { providerID: "beta", modelID: "model-two" },
    ]);
    first.close();
    second.close();
  }, 10_000);

  it("returns one reply through the real OC1 HTTP and SSE contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "isomux-opencode-adapter-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
          return Response.json({ object: "list", data: [{ id: "gate-model", object: "model" }] });
        }
        if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
        const stream = new ReadableStream({
          start(controller) {
            const send = (value: unknown) =>
              controller.enqueue(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
            send({
              id: "gate",
              object: "chat.completion.chunk",
              created: 1,
              model: "gate-model",
              choices: [{ index: 0, delta: { role: "assistant", content: "OpenCode real tracer reply." }, finish_reason: null }],
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
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    cleanup.push(() => mock.stop(true));
    const config = {
      autoupdate: false,
      model: "gate/gate-model",
      small_model: "gate/gate-model",
      share: "disabled",
      provider: {
        gate: {
          name: "Gate mock",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "gate-model": {
              name: "Gate model",
              limit: { context: 100000, output: 10000 },
              cost: { input: 0, output: 0 },
            },
          },
          options: { apiKey: "test-only", baseURL: `http://127.0.0.1:${mock.port}/v1` },
        },
      },
    };
    const supervisor = new OpenCodeSupervisor({
      profileDir: join(root, "profile"),
      serverCwd: root,
      config,
      idleShutdownMs: 100,
    });
    cleanup.push(() => supervisor.shutdown());
    const contractShapes: string[] = [];
    const backend = createOpenCodeBackend({
      supervisor,
      contractShapeSink: (shape) => contractShapes.push(shape),
    });
    const discovered = await backend.listModels({ cwd: root });
    expect(discovered).toContainEqual({
      id: "gate/gate-model",
      label: "Gate mock - Gate model",
      supportedEfforts: [],
    });
    expect(discovered.some((model) => model.id.startsWith("offline/"))).toBe(
      false,
    );
    expect(JSON.stringify(discovered)).not.toContain("test-only");
    const discoveryLease = await supervisor.acquire();
    const discoveryPid = discoveryLease.pid;
    discoveryLease.release();
    const session = backend.createSession({ ...opts, cwd: root, modelFamily: "gate/gate-model" });
    const eventsPromise = (async () => {
      const events: NormalizedEvent[] = [];
      for await (const event of session.stream()) {
        events.push(event);
        if (event.kind === "turn_completed") return events;
      }
      return events;
    })();
    await session.send("hello from Isomux");
    const events = await Promise.race([
      eventsPromise,
      Bun.sleep(10_000).then(() => {
        throw new Error("timed out waiting for the real OpenCode tracer");
      }),
    ]);
    expect(events[0]).toMatchObject({ kind: "system_init", model: "gate/gate-model" });
    expect(events.filter((event) => event.kind === "assistant_text")).toEqual([
      { kind: "assistant_text", text: "OpenCode real tracer reply." },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "turn_completed", status: "completed" });
    const sessionLease = await supervisor.acquire();
    expect(sessionLease.pid).toBe(discoveryPid);
    sessionLease.release();
    expect([...new Set(contractShapes)].sort()).toEqual(
      await Bun.file(join(import.meta.dir, "fixtures", "s1b-text-contract.json")).json(),
    );
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
    const parentId = events[0].kind === "system_init" ? events[0].sessionId! : "";
    const reboundBackend = createOpenCodeBackend({
      supervisor,
    });
    expect(
      await reboundBackend.getSessionMessages(parentId, root, {
        cwd: root,
        modelFamily: "gate/gate-model",
        environmentKey: "rebound",
        environmentRevision: "rebound",
      }),
    ).toEqual(parentBefore);
    const target = parentBefore.filter((message) => message.role === "user")[1];
    if (!target) throw new Error("OpenCode parent did not record a second user turn");
    const forkBackend = createOpenCodeBackend({ supervisor });
    const fork = await forkBackend.forkSessionBeforeMessage(
      parentId,
      target.uuid,
      {
        cwd: root,
        modelFamily: "gate/gate-model",
        environmentKey: "rebound",
        environmentRevision: "rebound",
      },
    );
    expect(fork.kind).toBe("fork");
    if (fork.kind !== "fork") throw new Error("OpenCode fork was not linked");
    const childBefore = await forkBackend.getSessionMessages(fork.sessionId, root);
    expect(childBefore.map((message) => message.text)).toEqual([
      "hello from Isomux",
      "OpenCode real tracer reply.",
    ]);
    session.close();
    const child = forkBackend.resumeSession(fork.sessionId, {
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
    const parentAfter = await forkBackend.getSessionMessages(parentId, root);
    expect(parentAfter).toEqual(parentBefore);
  }, 40_000);

  it("runs and denies controlled shell tools through the real OC1 permission route", async () => {
    const root = await mkdtemp(join(tmpdir(), "isomux-opencode-tools-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "gate-model", object: "model" }] });
        if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
        const body = await request.json() as { messages?: Array<Record<string, unknown>> };
        const messages = body.messages ?? [];
        const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
        const content = messages[lastUserIndex]?.content;
        const prompt = typeof content === "string" ? content : "";
        const hasToolResult = messages.slice(lastUserIndex + 1).some((message) => message.role === "tool");
        const stream = new ReadableStream({
          start(controller) {
            const send = (value: unknown) => controller.enqueue(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
            const base = { id: "gate", object: "chat.completion.chunk", created: 1, model: "gate-model" };
            send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
            if (!hasToolResult) {
              const command = prompt.includes("ABORT")
                ? "sleep 30"
                : prompt.includes("REPO")
                  ? "pwd > repo-observed.txt"
                : prompt.includes("FAIL")
                  ? "printf failed-before-exit; exit 7"
                : prompt.includes("DENY")
                  ? "printf denied > gate-denied.txt"
                  : "printf allowed > gate-allowed.txt";
              const edit = prompt.includes("EDIT");
              const toolName = edit ? "edit" : "bash";
              const toolInput = edit
                ? { filePath: join(root, "gate-edit.txt"), oldString: "before", newString: "after" }
                : { command };
              send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_reused", type: "function", function: { name: toolName, arguments: JSON.stringify(toolInput) } }] }, finish_reason: null }] });
              send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
            } else {
              send({ ...base, choices: [{ index: 0, delta: { reasoning_content: "checked tool result" }, finish_reason: null }] });
              send({ ...base, choices: [{ index: 0, delta: { content: "Recovered after tool." }, finish_reason: null }] });
              send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            }
            send("[DONE]");
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    cleanup.push(() => mock.stop(true));
    const supervisor = new OpenCodeSupervisor({
      profileDir: join(root, "profile"), serverCwd: root, idleShutdownMs: 100,
      config: {
        autoupdate: false, model: "gate/gate-model", small_model: "gate/gate-model", share: "disabled",
        permission: { bash: "ask", edit: "ask", question: "deny" },
        provider: { gate: { name: "Gate", npm: "@ai-sdk/openai-compatible", env: [], models: { "gate-model": { name: "Gate", reasoning: true, tool_call: true, limit: { context: 100000, output: 10000 }, cost: { input: 0, output: 0 } } }, options: { apiKey: "test-only", baseURL: `http://127.0.0.1:${mock.port}/v1` } } },
      },
    });
    cleanup.push(() => supervisor.shutdown());
    const backend = createOpenCodeBackend({ supervisor });
    const run = async (
      text: string,
      allow: boolean,
      repeats = 1,
      cwd = root,
    ) => {
      const session = backend.createSession({ ...opts, cwd, modelFamily: "gate/gate-model" });
      const events: NormalizedEvent[] = [];
      const turnWaiters: Array<() => void> = [];
      const consumer = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.kind === "approval_request") {
            expect(event.allowPersistentLabel).toBeUndefined();
            await session.approve(event.approvalId, allow ? { kind: "allow_once" } : { kind: "deny" });
          }
          if (event.kind === "turn_completed") turnWaiters.shift()?.();
        }
      })();
      for (let index = 0; index < repeats; index++) {
        const done = new Promise<void>((resolve) => turnWaiters.push(resolve));
        await session.send(text);
        await Promise.race([done, Bun.sleep(15_000).then(() => { throw new Error("tool turn timed out"); })]);
      }
      session.close();
      await consumer;
      return events;
    };
    const allowed = await run("ALLOW", true, 2);
    const denied = await run("DENY", false);
    const failed = await run("FAIL", true);
    await Bun.write(join(root, "gate-edit.txt"), "before\n");
    const edited = await run("EDIT", true);
    const abortAtPermission = async () => {
      const session = backend.createSession({ ...opts, cwd: root, modelFamily: "gate/gate-model" });
      const events: NormalizedEvent[] = [];
      const done = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.kind === "approval_request") await session.abort();
          if (event.kind === "turn_completed") return;
        }
      })();
      await session.send("ABORT PERMISSION");
      await Promise.race([done, Bun.sleep(15_000).then(() => { throw new Error("permission abort timed out"); })]);
      session.close();
      return events;
    };
    const abortDuringTool = async () => {
      const session = backend.createSession({ ...opts, cwd: root, modelFamily: "gate/gate-model" });
      const events: NormalizedEvent[] = [];
      const aborts: Promise<void>[] = [];
      const done = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.kind === "approval_request") {
            await session.approve(event.approvalId, { kind: "allow_once" });
            await Bun.sleep(200);
            aborts.push(session.abort());
          }
          if (event.kind === "turn_completed") return;
        }
      })();
      await session.send("ABORT TOOL");
      await Promise.race([done, Bun.sleep(15_000).then(() => { throw new Error("tool abort timed out"); })]);
      if (aborts.length !== 1) throw new Error("tool abort did not start exactly once");
      await Promise.all(aborts);
      session.close();
      return events;
    };
    const permissionAbort = await abortAtPermission();
    const toolAbort = await abortDuringTool();
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await Promise.all([mkdir(repoA), mkdir(repoB)]);
    await Promise.all([
      run("REPO A", true, 1, repoA),
      run("REPO B", true, 1, repoB),
    ]);
    expect(await Bun.file(join(root, "gate-allowed.txt")).text()).toBe("allowed");
    expect(await Bun.file(join(root, "gate-denied.txt")).exists()).toBe(false);
    expect(allowed.filter((event) => event.kind === "approval_request")).toHaveLength(2);
    expect(allowed.filter((event) => event.kind === "tool_call")).toHaveLength(2);
    expect(allowed.filter((event) => event.kind === "tool_result")).toHaveLength(2);
    expect(allowed.findLastIndex((event) => event.kind === "tool_result")).toBeLessThan(
      allowed.findLastIndex((event) => event.kind === "turn_completed"),
    );
    expect(allowed.some((event) => event.kind === "thinking")).toBe(true);
    expect(allowed.at(-1)).toMatchObject({ kind: "turn_completed", status: "completed" });
    expect(denied.filter((event) => event.kind === "tool_result")).toHaveLength(1);
    expect(denied.at(-1)).toMatchObject({ kind: "turn_completed", status: "completed" });
    expect(failed.some((event) => event.kind === "tool_result" && event.isError)).toBe(true);
    expect(failed.some((event) => event.kind === "assistant_text" && event.text.includes("Recovered"))).toBe(true);
    expect(await Bun.file(join(root, "gate-edit.txt")).text()).toBe("after\n");
    expect(edited.some((event) => event.kind === "tool_call" && event.name === "edit")).toBe(true);
    expect(permissionAbort.at(-1)).toEqual({ kind: "turn_completed", status: "interrupted" });
    expect(toolAbort.filter((event) => event.kind === "tool_call")).toHaveLength(1);
    expect(toolAbort.filter((event) => event.kind === "tool_result")).toHaveLength(1);
    expect(toolAbort.at(-1)).toEqual({ kind: "turn_completed", status: "interrupted" });
    expect((await readFile(join(repoA, "repo-observed.txt"), "utf8")).trim()).toBe(repoA);
    expect((await readFile(join(repoB, "repo-observed.txt"), "utf8")).trim()).toBe(repoB);
  }, 40_000);
});
