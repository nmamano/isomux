import { OPENCODE_SAFETY_PLUGIN_ID } from "./safety-plugin-tool.ts";
import { openCodeSafetyPluginDir } from "./profile-paths.ts";
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
    // The plugin row the transport's S2 check looks for.
    const pluginEntry = join(
      openCodeSafetyPluginDir(join(root, "profile")),
      "index.js",
    );
    await writeFile(
      binary,
      `#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const streams = new Map();
// Ids differ per server process: a resume that made a new session on the
// replacement would find no stored context.
let nextSession = 0;
let nextInput = 0;
const send = (controller, value) => controller.enqueue(
  new TextEncoder().encode(\`data: \${JSON.stringify(value)}\\n\\n\`),
);
const frame = (type, data) => ({ id: "evt_" + type, created: Date.now(), type, data });
Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
  const url = new URL(request.url);
  // Health for the supervisor and the transport (T8).
  if (url.pathname === "/api/experimental/migration/v1")
    return Response.json({ status: "completed" });
  if (url.pathname === "/api/info")
    return Response.json({ version: "2.1.4", pid: process.pid });
  if (url.pathname === "/api/session" && request.method === "POST")
    return Response.json({ data: { id: \`session-\${process.pid}-\${++nextSession}\` } });
  if (url.pathname === "/api/event") {
    let subscriber;
    return new Response(new ReadableStream({
      start(controller) {
        subscriber = controller;
        streams.set("active", controller);
        send(controller, { id: "evt_connected", type: "server.connected", data: {} });
      },
      cancel() {
        if (streams.get("active") === subscriber) streams.delete("active");
      },
    }), { headers: { "content-type": "text/event-stream" } });
  }
  // Isomux's top layer is the one document without a path (C3).
  if (url.pathname === "/api/config")
    return Response.json([{ type: "document", info: { agents: { "isomux-cron": {} } } }]);
  if (url.pathname === "/api/mcp")
    return Response.json({ data: [] });
  if (url.pathname.endsWith("/environment") && request.method === "PUT")
    return new Response(null, { status: 204 });
  if (url.pathname.split("/").length === 4 && request.method === "PATCH")
    return new Response(null, { status: 204 });
  if (url.pathname === "/api/plugin")
    return Response.json({ data: [{
      id: ${JSON.stringify(OPENCODE_SAFETY_PLUGIN_ID)},
      source: { type: "local", path: ${JSON.stringify(pluginEntry)} },
      state: { status: "active" },
    }] });
  if (url.pathname === "/api/model")
    return Response.json({ data: [{
      id: "gate-model", providerID: "gate", name: "Gate", variants: [],
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active", enabled: true, limit: { context: 100000, output: 10000 },
    }] });
  if (url.pathname.startsWith("/api/experimental/session/") && request.method === "PUT")
    return new Response(null, { status: 204 });
  if (url.pathname.endsWith("/agent") && request.method === "POST")
    return new Response(null, { status: 204 });
  if (url.pathname.endsWith("/model") && request.method === "POST")
    return new Response(null, { status: 204 });
  if (url.pathname.endsWith("/prompt") && request.method === "POST") {
    const sessionID = url.pathname.split("/")[3];
    const prompt = (await request.json()).text ?? "";
    const stored = join(process.cwd(), \`stored-\${sessionID}\`);
    if (prompt.includes("S4_CONTEXT_CANARY")) writeFileSync(stored, "stored");
    const text = prompt === "GATE_RECALL"
      ? existsSync(stored) ? "RECALLED:S4_CONTEXT_CANARY" : "RECALLED:EMPTY"
      : "FIRST_TURN_STORED";
    const controller = streams.get("active");
    if (!controller) return new Response("no event subscriber", { status: 503 });
    const inboxID = \`msg_input_\${++nextInput}\`;
    const assistantMessageID = \`msg_answer_\${nextInput}\`;
    setTimeout(() => {
      send(controller, frame("session.inbox.delivered", { sessionID, inboxID }));
      send(controller, frame("session.step.started", { sessionID, assistantMessageID }));
      send(controller, frame("session.text.delta", { sessionID, assistantMessageID, ordinal: 0, delta: text }));
      send(controller, frame("session.text.ended", { sessionID, assistantMessageID, ordinal: 0, text }));
      send(controller, frame("session.step.ended", { sessionID, assistantMessageID, finish: "stop", cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }));
      send(controller, frame("session.execution.succeeded", { sessionID }));
    }, 0);
    return Response.json({ data: { id: inboxID, sessionID } });
  }
  return new Response("not found", { status: 404 });
}});
await new Promise(() => {});
`,
    );
    await chmod(binary, 0o700);
    const config = JSON.stringify({
      update: "disable",
      model: "gate/gate-model",
      providers: {
        gate: {
          name: "Gate",
          env: [],
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            apiKey: "test-only",
            // The protocol fake produces replies itself and never calls a provider.
            baseURL: "http://127.0.0.1:1/v1",
          },
          models: { "gate-model": { name: "Gate" } },
        },
      },
    });
    const resultPath = join(root, "result.json");
    const harness = join(import.meta.dir, "process-loss-harness.ts");
    const run = (phase: "first" | "resume") =>
      Bun.spawn([process.execPath, "run", harness], {
        env: {
          ...process.env,
          // One state root, as a restarted office keeps: the safety plugin
          // is built with it, and another root's server is not adopted.
          ISOMUX_HOME: join(root, "isomux"),
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
    const health = await fetch(`http://127.0.0.1:${record.port}/api/info`, {
      headers: {
        authorization: `Basic ${btoa(`opencode:${record.password}`)}`,
      },
    });
    expect(await health.json()).toEqual({
      version: "2.1.4",
      pid: prior.serverPid,
    });
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
