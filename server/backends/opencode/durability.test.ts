import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("OpenCode durable process loss", () => {
  it("adopts the pinned server and resumes context after the Isomux process is SIGKILLed", async () => {
    const root = await mkdtemp(join(tmpdir(), "isomux-opencode-process-loss-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: [{ id: "gate-model", object: "model" }],
          });
        }
        if (url.pathname !== "/v1/chat/completions")
          return new Response("not found", { status: 404 });
        const body = (await request.json()) as {
          messages?: Array<{ role?: unknown; content?: unknown }>;
        };
        const messages = body.messages ?? [];
        const last = [...messages]
          .reverse()
          .find((message) => message.role === "user")?.content;
        const recalled = messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes("S4_CONTEXT_CANARY"),
        );
        const text =
          last === "GATE_RECALL"
            ? recalled
              ? "RECALLED:S4_CONTEXT_CANARY"
              : "RECALLED:EMPTY"
            : "FIRST_TURN_STORED";
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
                {
                  index: 0,
                  delta: { role: "assistant", content: text },
                  finish_reason: null,
                },
              ],
            });
            send({
              ...base,
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
    cleanup.push(() => mock.stop(true));
    const config = JSON.stringify({
      autoupdate: false,
      model: "gate/gate-model",
      small_model: "gate/gate-model",
      share: "disabled",
      provider: {
        gate: {
          name: "Gate",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "gate-model": {
              name: "Gate",
              limit: { context: 100000, output: 10000 },
              cost: { input: 0, output: 0 },
            },
          },
          options: {
            apiKey: "test-only",
            baseURL: `http://127.0.0.1:${mock.port}/v1`,
          },
        },
      },
    });
    const resultPath = join(root, "result.json");
    const harness = join(import.meta.dir, "process-loss-harness.ts");
    const run = (phase: "first" | "resume") =>
      Bun.spawn([process.execPath, "run", harness], {
        env: {
          ...process.env,
          ISOMUX_HOME: join(root, `isomux-${phase}`),
          S4_PHASE: phase,
          S4_ROOT: root,
          S4_RESULT: resultPath,
          S4_CONFIG: config,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const first = run("first");
    expect(await first.exited).not.toBe(0);
    const prior = JSON.parse(await readFile(resultPath, "utf8")) as {
      serverPid: number;
    };
    expect(() => process.kill(prior.serverPid, 0)).not.toThrow();
    const record = JSON.parse(
      await readFile(join(root, "profile", "server.lock"), "utf8"),
    ) as { port: number; password: string; environmentRevision: string };
    expect(record.environmentRevision).toBe("s4-process-loss");
    const health = await fetch(
      `http://127.0.0.1:${record.port}/global/health`,
      {
        headers: {
          authorization: `Basic ${btoa(`isomux:${record.password}`)}`,
        },
      },
    );
    expect(await health.json()).toEqual({ healthy: true, version: "1.18.23" });
    const resume = run("resume");
    const [exitCode, stderr] = await Promise.all([
      resume.exited,
      new Response(resume.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      serverPid: number;
      adoptedPid: number;
      text: string;
    };
    expect(result.adoptedPid).toBe(result.serverPid);
    expect(result.text).toContain("S4_CONTEXT_CANARY");
    const replacement = run("resume");
    const [replacementExit, replacementStderr] = await Promise.all([
      replacement.exited,
      new Response(replacement.stderr).text(),
    ]);
    expect(replacementStderr).toBe("");
    expect(replacementExit).toBe(0);
    const replaced = JSON.parse(await readFile(resultPath, "utf8")) as {
      serverPid: number;
      adoptedPid: number;
      text: string;
    };
    expect(replaced.adoptedPid).not.toBe(replaced.serverPid);
    expect(replaced.text).toContain("S4_CONTEXT_CANARY");
  }, 30_000);
});
