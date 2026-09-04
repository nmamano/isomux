import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const binary = join(root, "durable-opencode-fake");
    await writeFile(
      binary,
      `#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const streams = new Map();
let nextSession = 0;
const send = (controller, value) => controller.enqueue(
  new TextEncoder().encode(\`data: \${JSON.stringify(value)}\\n\\n\`),
);
Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/global/health")
    return Response.json({ healthy: true, version: "1.18.23" });
  if (url.pathname === "/session" && request.method === "POST")
    return Response.json({ id: \`session-\${++nextSession}\` });
  if (url.pathname === "/event") {
    let subscriber;
    return new Response(new ReadableStream({
      start(controller) {
        subscriber = controller;
        streams.set("active", controller);
        send(controller, { type: "server.connected", properties: {} });
      },
      cancel() {
        if (streams.get("active") === subscriber) streams.delete("active");
      },
    }), { headers: { "content-type": "text/event-stream" } });
  }
  if (url.pathname.endsWith("/prompt_async")) {
    const sessionID = url.pathname.split("/")[2];
    const body = await request.json();
    const prompt = body.parts?.map((part) => part.text ?? "").join("") ?? "";
    const stored = join(process.cwd(), \`stored-\${sessionID}\`);
    if (prompt.includes("S4_CONTEXT_CANARY")) writeFileSync(stored, "stored");
    const text = prompt === "GATE_RECALL"
      ? existsSync(stored) ? "RECALLED:S4_CONTEXT_CANARY" : "RECALLED:EMPTY"
      : "FIRST_TURN_STORED";
    const controller = streams.get("active");
    if (!controller) return new Response("no event subscriber", { status: 503 });
    const messageID = "message-1";
    send(controller, { type: "message.updated", properties: {
      sessionID, info: { id: messageID, role: "assistant" },
    }});
    send(controller, { type: "message.part.updated", properties: {
      sessionID, part: { id: "part-1", messageID, type: "text", text },
    }});
    send(controller, { type: "message.part.updated", properties: {
      sessionID, part: { id: "finish-1", messageID, type: "step-finish" },
    }});
    send(controller, { type: "session.idle", properties: { sessionID } });
    return Response.json(true);
  }
  return new Response("not found", { status: 404 });
}});
await new Promise(() => {});
`,
    );
    await chmod(binary, 0o700);
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
            // The protocol fake produces replies itself and never calls a provider.
            baseURL: "http://127.0.0.1:1/v1",
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
          S4_BINARY: binary,
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
