import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OpenCodeSupervisor,
  openCodeSupervisorForEnvironment,
} from "./supervisor.ts";
import { resolveOpenCodeBinary } from "./runtime.ts";
import { expectRejection } from "../../test-support/expect-rejection.ts";
import { readLinuxProcessStartTicks } from "./process-identity.ts";

const supervisors: OpenCodeSupervisor[] = [];
const scratch: string[] = [];
const mocks: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  await Promise.all(
    supervisors.splice(0).map((supervisor) => supervisor.shutdown()),
  );
  for (const mock of mocks.splice(0)) await mock.stop(true);
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
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
        return Response.json({
          object: "list",
          data: [{ id: "gate-model", object: "model" }],
        });
      }
      if (url.pathname !== "/v1/chat/completions")
        return new Response("not found", { status: 404 });
      if (delayMs) await Bun.sleep(delayMs);
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
  mocks.push(mock);
  return mock;
}

function gateConfig(
  mock: ReturnType<typeof Bun.serve>,
): Record<string, unknown> {
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
        options: {
          apiKey: "test-only",
          baseURL: `http://127.0.0.1:${mock.port}/v1`,
        },
      },
    },
  };
}

function makeSupervisor(
  path: string,
  config?: Record<string, unknown>,
  idleShutdownMs = 1000,
  launchEnv: Record<string, string | undefined> = {},
  replacementDrainMs = 5000,
  binary?: string,
) {
  const supervisor = new OpenCodeSupervisor({
    profileDir: join(path, "profile"),
    serverCwd: path,
    config,
    idleShutdownMs,
    launchEnv,
    replacementDrainMs,
    binary,
  });
  supervisors.push(supervisor);
  return supervisor;
}

async function makeHealthOnlyBinary(path: string) {
  const binary = join(path, "health-only-opencode");
  const healthMarker = join(path, "health-only-requests");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
Bun.serve({ hostname: "127.0.0.1", port, fetch(request) {
  if (new URL(request.url).pathname !== "/global/health")
    return new Response("not found", { status: 404 });
  appendFileSync(${JSON.stringify(healthMarker)}, "hit\\n");
  return Response.json({ healthy: true, version: "1.18.23" });
}});
await new Promise(() => {});
`,
  );
  await chmod(binary, 0o700);
  return { binary, healthMarker };
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
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const argv0 = (await readFile(join("/proc", pid, "cmdline")))
        .toString()
        .split("\0", 1)[0];
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

  it("writes the named unattended agent without widening the default permissions", async () => {
    const path = await root();
    const supervisor = makeSupervisor(path, undefined, 1000);
    const lease = await supervisor.acquire();
    const config = JSON.parse(
      await readFile(join(supervisor.profileDir, "opencode.json"), "utf8"),
    );
    expect(config.permission).toEqual({
      bash: "ask",
      edit: "ask",
      question: "deny",
    });
    expect(config.agent?.["isomux-interactive-bypass"]).toMatchObject({
      mode: "primary",
      permission: {
        bash: "ask",
        edit: "ask",
        task: "allow",
        question: "deny",
      },
    });
    expect(config.agent?.["isomux-cron"]).toMatchObject({
      mode: "primary",
      permission: {
        bash: "ask",
        edit: "ask",
        task: "deny",
        question: "deny",
      },
    });
    lease.release();
  }, 20_000);

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
    const [leaseA, leaseB] = await Promise.all([
      first.acquire(),
      second.acquire(),
    ]);
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

  it("passes only the Zen API key through the OpenCode control prefix", async () => {
    const path = await root();
    const { binary } = await makeHealthOnlyBinary(path);
    const apiKeyCanary = "synthetic-opencode-api-key-canary";
    const debugRoot = join(path, "tmp");
    await mkdir(debugRoot);
    const supervisor = makeSupervisor(
      path,
      undefined,
      1000,
      {
        OPENCODE_API_KEY: apiKeyCanary,
        OPENCODE_UNRELATED: "must-not-reach-child",
        OPENCODE_CONFIG: "hostile-parent-config",
        OPENCODE_SERVER_PASSWORD: "hostile-parent-password",
        TMPDIR: debugRoot,
      },
      5000,
      binary,
    );
    const priorDebug = process.env.ISOMUX_OPENCODE_DEBUG;
    process.env.ISOMUX_OPENCODE_DEBUG = "1";
    const lease = await supervisor.acquire().finally(() => {
      if (priorDebug === undefined) delete process.env.ISOMUX_OPENCODE_DEBUG;
      else process.env.ISOMUX_OPENCODE_DEBUG = priorDebug;
    });
    const childEnv = Object.fromEntries(
      (await readFile(`/proc/${lease.pid}/environ`))
        .toString()
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf("=");
          return [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
    );
    const recordText = await readFile(supervisor.recordPath, "utf8");
    const record = JSON.parse(recordText);
    expect(childEnv.OPENCODE_API_KEY).toBe(apiKeyCanary);
    expect(childEnv.OPENCODE_UNRELATED).toBeUndefined();
    expect(childEnv.OPENCODE_CONFIG).toBe(
      join(supervisor.profileDir, "opencode.json"),
    );
    expect(childEnv.OPENCODE_SERVER_PASSWORD).toBe(record.password);
    expect(recordText).not.toContain(apiKeyCanary);
    const debugAfter = (await readdir(debugRoot)).filter((name) =>
      name.startsWith("isomux-opencode-debug-"),
    );
    expect(debugAfter.length).toBeGreaterThan(0);
    for (const name of debugAfter) {
      const debugDir = join(debugRoot, name);
      expect(
        await readFile(join(debugDir, "stdout.log"), "utf8"),
      ).not.toContain(apiKeyCanary);
      expect(
        await readFile(join(debugDir, "stderr.log"), "utf8"),
      ).not.toContain(apiKeyCanary);
    }
    lease.release();
  }, 20_000);

  it("replaces an adoptee that exits after its health response", async () => {
    const path = await root();
    const config = gateConfig(mockProvider());
    const { binary, healthMarker } = await makeHealthOnlyBinary(path);
    const first = makeSupervisor(path, config, 1000, {}, 5000, binary);
    const firstLease = await first.acquire();
    const firstPid = firstLease.pid;
    firstLease.release();
    let killerHits = 0;
    const killer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        killerHits++;
        process.kill(firstPid, "SIGKILL");
        while (readLinuxProcessStartTicks(firstPid)) await Bun.sleep(5);
        return Response.json({ healthy: true, version: "1.18.23" });
      },
    });
    mocks.push(killer);
    const record = JSON.parse(
      await readFile(first.recordPath, "utf8"),
    ) as Record<string, unknown>;
    record.port = killer.port;
    await writeFile(first.recordPath, `${JSON.stringify(record)}\n`);

    const second = makeSupervisor(path, config, 1000, {}, 5000, binary);
    const replacement = await second.acquire();
    expect(killerHits).toBeGreaterThan(0);
    expect((await readFile(healthMarker, "utf8")).length).toBeGreaterThan(0);
    expect(replacement.pid).not.toBe(firstPid);
    expect(alive(replacement.pid)).toBe(true);
    replacement.release();
  }, 20_000);

  it("replaces changed environment contents and refreshes retained leases", async () => {
    const path = await root();
    const supervisor = new OpenCodeSupervisor({
      profileDir: join(path, "profile"),
      serverCwd: path,
      config: gateConfig(mockProvider()),
      launchEnv: { S4_ENV_CANARY: "before" },
      environmentRevision: "revision-before",
      idleShutdownMs: 1000,
    });
    supervisors.push(supervisor);
    const retained = await supervisor.acquire();
    const priorPid = retained.pid;
    expect((await readFile(`/proc/${priorPid}/environ`)).toString()).toContain(
      "S4_ENV_CANARY=before",
    );
    supervisor.updateLaunchEnvironment(
      { S4_ENV_CANARY: "after" },
      "revision-after",
    );
    const replacement = await supervisor.acquire();
    expect(replacement.pid).not.toBe(priorPid);
    expect(retained.pid).toBe(replacement.pid);
    expect(
      (await readFile(`/proc/${replacement.pid}/environ`)).toString(),
    ).toContain("S4_ENV_CANARY=after");
    const response = await fetch(`${retained.baseUrl}/global/health`, {
      headers: { authorization: retained.authHeader },
    });
    expect(response.ok).toBe(true);
    retained.release();
    replacement.release();
  }, 20_000);

  it("refuses cross-process adoption when the environment revision changed", async () => {
    const path = await root();
    const config = gateConfig(mockProvider());
    const first = new OpenCodeSupervisor({
      profileDir: join(path, "profile"),
      serverCwd: path,
      config,
      environmentRevision: "revision-before",
    });
    const second = new OpenCodeSupervisor({
      profileDir: join(path, "profile"),
      serverCwd: path,
      config,
      environmentRevision: "revision-after",
    });
    supervisors.push(first, second);
    const oldLease = await first.acquire();
    const oldPid = oldLease.pid;
    const newLease = await second.acquire();
    expect(newLease.pid).not.toBe(oldPid);
    expect(alive(oldPid)).toBe(false);
    oldLease.release();
    newLease.release();
  }, 20_000);

  it("adopts an unchanged config but replaces a pre-revision config record", async () => {
    const path = await root();
    const oldConfig = gateConfig(mockProvider());
    const { binary, healthMarker } = await makeHealthOnlyBinary(path);
    const first = makeSupervisor(path, oldConfig, 1000, {}, 5000, binary);
    const initial = await first.acquire();
    const firstPid = initial.pid;
    initial.release();

    const unchanged = makeSupervisor(path, oldConfig, 1000, {}, 5000, binary);
    const adopted = await unchanged.acquire();
    expect(adopted.pid).toBe(firstPid);
    adopted.release();

    const legacyRecord = JSON.parse(
      await readFile(first.recordPath, "utf8"),
    ) as Record<string, unknown>;
    delete legacyRecord.startTicks;
    await writeFile(first.recordPath, `${JSON.stringify(legacyRecord)}\n`);
    const legacyUpgrade = makeSupervisor(
      path,
      oldConfig,
      1000,
      {},
      5000,
      binary,
    );
    const legacyLease = await legacyUpgrade.acquire();
    expect(legacyLease.pid).toBe(firstPid);
    expect(
      typeof JSON.parse(await readFile(first.recordPath, "utf8")).startTicks,
    ).toBe("string");
    legacyLease.release();

    const record = JSON.parse(
      await readFile(first.recordPath, "utf8"),
    ) as Record<string, unknown>;
    delete record.configRevision;
    await writeFile(first.recordPath, `${JSON.stringify(record)}\n`);
    const changedConfig = {
      ...oldConfig,
      agent: {
        "isomux-cron": {
          mode: "primary",
          permission: { bash: "allow", edit: "allow" },
        },
      },
    };
    const upgraded = makeSupervisor(
      path,
      changedConfig,
      1000,
      {},
      5000,
      binary,
    );
    const replaced = await upgraded.acquire();
    expect(replaced.pid).not.toBe(firstPid);
    expect(alive(firstPid)).toBe(false);
    expect((await readFile(healthMarker, "utf8")).length).toBeGreaterThan(0);
    replaced.release();
  }, 20_000);

  it("never signals a process when the saved start ticks do not match", async () => {
    const path = await root();
    const profileDir = join(path, "profile");
    await mkdir(profileDir, { recursive: true });
    const recordPath = join(profileDir, "server.lock");
    const unrelated = Bun.spawn(["sleep", "30"]);
    await writeFile(
      recordPath,
      `${JSON.stringify({ pid: unrelated.pid, startTicks: "0" })}\n`,
    );
    const helper = join(import.meta.dir, "start-server.ts");
    const stop = Bun.spawn([process.execPath, "run", helper], {
      env: {
        ...process.env,
        OPENCODE_SERVER_ACTION: "stop",
        OPENCODE_PROFILE_DIR: profileDir,
        OPENCODE_SERVER_RECORD: recordPath,
      },
      stderr: "pipe",
    });
    expect(await stop.exited).toBe(0);
    expect(alive(unrelated.pid)).toBe(true);
    unrelated.kill();
    await unrelated.exited;
  });

  it("waits for an active turn before a permission-config replacement", async () => {
    const path = await root();
    const initialConfig = { share: "disabled" };
    const { binary } = await makeHealthOnlyBinary(path);
    const supervisor = makeSupervisor(
      path,
      initialConfig,
      1000,
      {},
      5000,
      binary,
    );
    const active = await supervisor.acquire();
    const controlStarted = Date.now();
    const unchanged = await supervisor.acquire();
    const controlMs = Date.now() - controlStarted;
    expect(controlMs).toBeLessThan(1000);
    unchanged.release();
    await active.beginTurn();
    const priorPid = active.pid;
    supervisor.updateConfiguration({
      ...initialConfig,
      permission: { bash: "ask", edit: "ask", question: "deny" },
    });
    let granted = false;
    const waiting = supervisor.acquire().then((lease) => {
      granted = true;
      return lease;
    });
    await Bun.sleep(2000);
    expect(granted).toBe(false);
    expect(alive(priorPid)).toBe(true);
    active.endTurn();
    const replacement = await waiting;
    expect(replacement.pid).not.toBe(priorPid);
    active.release();
    replacement.release();
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
    await lease.beginTurn();
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
    const { binary, healthMarker } = await makeHealthOnlyBinary(path);
    const supervisor = makeSupervisor(
      path,
      gateConfig(mockProvider()),
      20,
      {},
      5000,
      binary,
    );
    const first = await supervisor.acquire();
    first.release();
    await Bun.sleep(30);
    const next = await supervisor.acquire();
    expect(alive(next.pid)).toBe(true);
    const response = await fetch(`${next.baseUrl}/global/health`, {
      headers: { authorization: next.authHeader },
    });
    expect(response.ok).toBe(true);
    expect((await readFile(healthMarker, "utf8")).length).toBeGreaterThan(0);
    next.release();
  }, 20_000);

  it("fails a requested replacement loudly when an active turn does not finish", async () => {
    const path = await root();
    const supervisor = makeSupervisor(
      path,
      gateConfig(mockProvider()),
      1000,
      {},
      30,
    );
    const lease = await supervisor.acquire();
    await lease.beginTurn();
    await writeFile(
      join(supervisor.profileDir, "server.replace"),
      "authentication changed\n",
    );
    await expectRejection(
      supervisor.acquire(),
      /Send your message again to retry/,
    );
    expect(alive(lease.pid)).toBe(true);
    lease.endTurn();
    lease.release();
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

  it("retries when a fresh healthy child exits before identity capture", async () => {
    const path = await root();
    const marker = join(path, "identity-loss-attempts");
    const binary = join(path, "identity-loss-opencode");
    await writeFile(
      binary,
      `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const marker = ${JSON.stringify(marker)};
if (!existsSync(marker)) {
  appendFileSync(marker, \`first:\${process.pid}\\n\`);
  const parentPid = process.pid;
  const child = spawn(process.execPath, ["-e", \`
    import { readFileSync } from "node:fs";
    const parentPid = \${parentPid};
    const server = Bun.serve({ hostname: "127.0.0.1", port: \${port}, async fetch() {
      process.kill(parentPid, "SIGKILL");
      while (true) {
        try { readFileSync("/proc/" + parentPid + "/stat"); await Bun.sleep(5); }
        catch { break; }
      }
      const response = Response.json({ healthy: true, version: "1.18.23" });
      void server.stop().then(() => process.exit(0));
      return response;
    }});
    await new Promise(() => {});
  \`], { detached: true, stdio: "ignore" });
  child.unref();
  await new Promise(() => {});
}
appendFileSync(marker, \`second:\${process.pid}\\n\`);
Bun.serve({ hostname: "127.0.0.1", port, fetch() {
  return Response.json({ healthy: true, version: "1.18.23" });
}});
await new Promise(() => {});
`,
    );
    await chmod(binary, 0o700);
    const supervisor = new OpenCodeSupervisor({
      profileDir: join(path, "profile"),
      serverCwd: path,
      binary,
      idleShutdownMs: 1000,
    });
    supervisors.push(supervisor);
    const lease = await supervisor.acquire();
    const attempts = (await readFile(marker, "utf8")).trim().split("\n");
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0]).toStartWith("first:");
    expect(attempts.at(-1)).toBe(`second:${lease.pid}`);
    lease.release();
  }, 20_000);

  it("the Isomux launch builder blocks project plugin, MCP, and Claude compatibility loading", async () => {
    const path = await root();
    const repo = join(path, "hostile-repo");
    const markers = join(path, "markers");
    await mkdir(join(repo, ".opencode", "plugin"), { recursive: true });
    const skillCanary = "hostile-compat-marker-oc1";
    await mkdir(join(repo, ".claude", "skills", skillCanary), {
      recursive: true,
    });
    await mkdir(markers, { recursive: true });
    const pluginMarker = join(markers, "plugin");
    const mcpMarker = join(markers, "mcp");
    await writeFile(
      join(repo, ".opencode", "plugin", "gate.js"),
      `Bun.write(${JSON.stringify(pluginMarker)}, "executed"); export const Gate = async () => ({});`,
    );
    await writeFile(
      join(repo, ".claude", "skills", skillCanary, "SKILL.md"),
      `---\nname: ${skillCanary}\ndescription: marker\n---\nmarker\n`,
    );
    await writeFile(
      join(repo, "opencode.json"),
      JSON.stringify({
        mcp: {
          gate: {
            type: "local",
            command: ["/bin/sh", "-c", `printf x > ${mcpMarker}`],
            enabled: true,
          },
        },
      }),
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
      await fetch(
        `${lease.baseUrl}${route}?directory=${encodeURIComponent(repo)}`,
        { headers },
      );
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
    const files = await Array.fromAsync(
      new Bun.Glob("*.ts").scan(import.meta.dir),
    );
    const launchers: string[] = [];
    for (const file of files) {
      if (file.endsWith(".test.ts")) continue;
      const text = await Bun.file(join(import.meta.dir, file)).text();
      if (text.includes('"serve"') && text.includes("OPENCODE_BINARY"))
        launchers.push(file);
    }
    expect(launchers).toEqual(["start-server.ts"]);
  });

  it("keeps one author for the OpenCode shared-process environment", async () => {
    const manager = await Bun.file(
      join(import.meta.dir, "..", "..", "agent-manager.ts"),
    ).text();
    const office = await Bun.file(
      join(import.meta.dir, "..", "..", "isomux-office.ts"),
    ).text();
    expect(manager).toMatch(
      /function buildOpenCodeLaunchEnvironmentForUserId[\s\S]*?return buildEnvForUserId\(userId\);[\s\S]*?\n {2}}/,
    );
    expect(manager).toMatch(
      /managed\.info\.agentType === "opencode"\s*\? buildOpenCodeLaunchEnvironmentForUserId\(managed\.info\.userId\)/,
    );
    expect(office).toMatch(
      /input\.agentType === "opencode"\s*\? agentManager\.buildOpenCodeLaunchEnvironmentForUserId\(input\.userId\)/,
    );
  });
});
