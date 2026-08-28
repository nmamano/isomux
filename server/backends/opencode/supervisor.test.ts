import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OpenCodeSupervisor,
  openCodeSupervisorForEnvironment,
} from "./supervisor.ts";
import { resolveOpenCodeBinary } from "./runtime.ts";
import { expectRejection } from "../../test-support/expect-rejection.ts";

const supervisors: OpenCodeSupervisor[] = [];
const scratch: string[] = [];
const mocks: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
  for (const mock of mocks.splice(0)) await mock.stop(true);
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "isomux-opencode-supervisor-"));
  scratch.push(path);
  return path;
}

function mockProvider(delayMs = 0) {
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "gate-model", object: "model" }] });
      }
      if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      if (delayMs) await Bun.sleep(delayMs);
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
  mocks.push(mock);
  return mock;
}

function gateConfig(mock: ReturnType<typeof Bun.serve>): Record<string, unknown> {
  return {
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
}

function makeSupervisor(
  path: string,
  config: Record<string, unknown>,
  idleShutdownMs = 1000,
  launchEnv: Record<string, string | undefined> = {},
) {
  const supervisor = new OpenCodeSupervisor({
    profileDir: join(path, "profile"),
    serverCwd: path,
    config,
    idleShutdownMs,
    launchEnv,
  });
  supervisors.push(supervisor);
  return supervisor;
}

function alive(pid: number): boolean {
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2];
    return state !== "Z";
  } catch {
    return false;
  }
}

async function binaryProcessCount(): Promise<number> {
  const binary = resolveOpenCodeBinary();
  let count = 0;
  for await (const name of new Bun.Glob("[0-9]*/cmdline").scan("/proc")) {
    try {
      const argv0 = (await readFile(join("/proc", name))).toString().split("\0", 1)[0];
      if (argv0 === binary) count++;
    } catch {}
  }
  return count;
}

describe("OpenCode shared server supervisor", () => {
  it("uses stable source identity instead of restart-volatile process values", () => {
    const first = openCodeSupervisorForEnvironment("source-alpha", {
      PROVIDER_KEY: "alpha",
      INVOCATION_ID: "first-start",
      ISOMUX_AGENT_TOKEN: "agent-one",
    });
    const same = openCodeSupervisorForEnvironment("source-alpha", {
      PROVIDER_KEY: "alpha",
      INVOCATION_ID: "second-start",
      ISOMUX_AGENT_TOKEN: "agent-two",
    });
    const different = openCodeSupervisorForEnvironment("source-beta", {
      PROVIDER_KEY: "alpha",
      INVOCATION_ID: "second-start",
    });
    expect(first).toBe(same);
    expect(different).not.toBe(first);
    expect(first.profileDir).not.toContain("alpha");
    expect(different.profileDir).not.toContain("beta");
  });

  it("serializes two supervisors and reconciles by adopting one healthy process", async () => {
    const path = await root();
    const mock = mockProvider();
    const config = gateConfig(mock);
    const baseline = await binaryProcessCount();
    const hostileAmbient = {
      OPENCODE_CONFIG_CONTENT: "hostile ambient config",
      ISOMUX_OPENCODE_DEBUG: "1",
    };
    const first = makeSupervisor(path, config, 1000, hostileAmbient);
    const second = makeSupervisor(path, config, 1000, hostileAmbient);
    const [leaseA, leaseB] = await Promise.all([first.acquire(), second.acquire()]);
    expect(leaseA.pid).toBe(leaseB.pid);
    expect(await binaryProcessCount()).toBe(baseline + 1);
    const childEnv = (await readFile(`/proc/${leaseA.pid}/environ`))
      .toString()
      .replaceAll("\0", "\n");
    expect(childEnv).not.toContain("ISOMUX_AGENT_TOKEN=");
    expect(childEnv).not.toContain("OPENCODE_CONFIG_CONTENT=");
    expect(childEnv).not.toContain("OPENCODE_PROFILE_DIR=");
    expect(childEnv).not.toContain("ISOMUX_OPENCODE_DEBUG=");
    expect(childEnv).toContain("OPENCODE_DISABLE_PROJECT_CONFIG=1");
    expect(childEnv).toContain("OPENCODE_DISABLE_CLAUDE_CODE=1");
    expect(childEnv).toContain("OPENCODE_DISABLE_AUTOUPDATE=1");
    expect(
      (await readFile(`/proc/${leaseA.pid}/cmdline`))
        .toString()
        .replaceAll("\0", " "),
    ).toContain(" serve --pure ");
    expect(
      JSON.parse(
        await readFile(join(first.profileDir, "opencode.json"), "utf8"),
      ).autoupdate,
    ).toBe(false);
    leaseA.release();
    leaseB.release();
    await second.shutdown();
    expect(alive(leaseA.pid)).toBe(false);
  }, 20_000);

  it("replaces a stale cross-process record before starting", async () => {
    const path = await root();
    const supervisor = makeSupervisor(path, gateConfig(mockProvider()));
    await mkdir(supervisor.profileDir, { recursive: true });
    await writeFile(
      supervisor.recordPath,
      `${JSON.stringify({
        pid: 999_999_999,
        port: 43100,
        password: "stale",
        binary: resolveOpenCodeBinary(),
        profileDir: supervisor.profileDir,
      })}\n`,
    );
    const lease = await supervisor.acquire();
    expect(lease.pid).not.toBe(999_999_999);
    expect(alive(lease.pid)).toBe(true);
    lease.release();
  }, 20_000);

  it("reaps only after idle and never during an active turn", async () => {
    const path = await root();
    const supervisor = makeSupervisor(path, gateConfig(mockProvider()), 80);
    const lease = await supervisor.acquire();
    lease.beginTurn();
    lease.release();
    await Bun.sleep(180);
    expect(alive(lease.pid)).toBe(true);
    lease.endTurn();
    const deadline = Date.now() + 5000;
    while (alive(lease.pid) && Date.now() < deadline) await Bun.sleep(25);
    expect(alive(lease.pid)).toBe(false);
  }, 20_000);

  it("waits for an idle shutdown before granting a new healthy lease", async () => {
    const path = await root();
    const supervisor = makeSupervisor(path, gateConfig(mockProvider()), 20);
    const first = await supervisor.acquire();
    first.release();
    await Bun.sleep(30);
    const next = await supervisor.acquire();
    expect(alive(next.pid)).toBe(true);
    const response = await fetch(`${next.baseUrl}/global/health`, {
      headers: { authorization: next.authHeader },
    });
    expect(response.ok).toBe(true);
    next.release();
  }, 20_000);

  it("fails once and fast when startup fails for a reason other than a used port", async () => {
    const path = await root();
    const marker = join(path, "starts");
    const binary = join(path, "broken-opencode");
    await writeFile(
      binary,
      `#!/bin/sh\nprintf x >> ${JSON.stringify(marker)}\nprintf 'wrong architecture' >&2\nexit 1\n`,
    );
    await chmod(binary, 0o700);
    const supervisor = new OpenCodeSupervisor({
      profileDir: join(path, "profile"),
      serverCwd: path,
      binary,
      idleShutdownMs: 1000,
    });
    supervisors.push(supervisor);
    const startedAt = Date.now();
    await expectRejection(supervisor.acquire(), /ISOMUX_OPENCODE_DEBUG=1/);
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(await readFile(marker, "utf8")).toBe("x");
  }, 10_000);

  it("the Isomux launch builder blocks project plugin, MCP, and Claude compatibility loading", async () => {
    const path = await root();
    const repo = join(path, "hostile-repo");
    const markers = join(path, "markers");
    await mkdir(join(repo, ".opencode", "plugin"), { recursive: true });
    const skillCanary = "hostile-compat-marker-oc1";
    await mkdir(join(repo, ".claude", "skills", skillCanary), { recursive: true });
    await mkdir(markers, { recursive: true });
    const pluginMarker = join(markers, "plugin");
    const mcpMarker = join(markers, "mcp");
    await writeFile(join(repo, ".opencode", "plugin", "gate.js"), `Bun.write(${JSON.stringify(pluginMarker)}, "executed"); export const Gate = async () => ({});`);
    await writeFile(
      join(repo, ".claude", "skills", skillCanary, "SKILL.md"),
      `---\nname: ${skillCanary}\ndescription: marker\n---\nmarker\n`,
    );
    await writeFile(
      join(repo, "opencode.json"),
      JSON.stringify({ mcp: { gate: { type: "local", command: ["/bin/sh", "-c", `printf x > ${mcpMarker}`], enabled: true } } }),
    );
    const supervisor = new OpenCodeSupervisor({
      profileDir: join(path, "profile"),
      serverCwd: repo,
      config: gateConfig(mockProvider()),
      idleShutdownMs: 1000,
    });
    supervisors.push(supervisor);
    const lease = await supervisor.acquire();
    const headers = { authorization: lease.authHeader };
    for (const route of ["/config", "/mcp"]) {
      await fetch(`${lease.baseUrl}${route}?directory=${encodeURIComponent(repo)}`, { headers });
    }
    const skills = await fetch(
      `${lease.baseUrl}/skill?directory=${encodeURIComponent(repo)}`,
      { headers },
    ).then((response) => response.text());
    await Bun.sleep(300);
    expect(await Bun.file(pluginMarker).exists()).toBe(false);
    expect(await Bun.file(mcpMarker).exists()).toBe(false);
    expect(skills).not.toContain(skillCanary);
    lease.release();
  }, 20_000);

  it("keeps binary launch in the one reviewed builder", async () => {
    const files = await Array.fromAsync(new Bun.Glob("*.ts").scan(import.meta.dir));
    const launchers: string[] = [];
    for (const file of files) {
      if (file.endsWith(".test.ts")) continue;
      const text = await Bun.file(join(import.meta.dir, file)).text();
      if (text.includes('"serve"') && text.includes("OPENCODE_BINARY")) launchers.push(file);
    }
    expect(launchers).toEqual(["start-server.ts"]);
  });
});
