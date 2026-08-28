import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
      fork: false,
      hooks: false,
      skills: false,
      oneShot: false,
      canUseTool: false,
      topicGen: false,
      edit: false,
      mcp: false,
    });
    expect(backend.inspectStoredSession("stored", opts)).toBe("durable");
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

  it("reports missing auth as plain text with no runnable command", async () => {
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
    expect(backend.getLoginInstructions()).toEqual({
      text: "OpenCode is not configured. Login instructions are not available in this slice.",
    });
  });
});

describe("OpenCode Slice 1B pinned transport", () => {
  it("refuses a production session without stable environment identity", () => {
    const backend = createOpenCodeBackend();
    expect(() => backend.createSession(opts)).toThrow(
      "OpenCode session environment identity is required.",
    );
  });

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
      model: "gate/gate-model",
      contractShapeSink: (shape) => contractShapes.push(shape),
    });
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
    session.close();
    expect(events[0]).toMatchObject({ kind: "system_init", model: "gate/gate-model" });
    expect(events.filter((event) => event.kind === "assistant_text")).toEqual([
      { kind: "assistant_text", text: "OpenCode real tracer reply." },
    ]);
    expect(events.at(-1)).toEqual({ kind: "turn_completed", status: "completed" });
    expect([...new Set(contractShapes)].sort()).toEqual(
      await Bun.file(join(import.meta.dir, "fixtures", "s1b-text-contract.json")).json(),
    );
  }, 20_000);
});
