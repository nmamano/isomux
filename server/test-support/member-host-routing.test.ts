// An isolated member's work goes to their own host, and carries nothing of the
// office (internal-docs/member-os-user-design.md, slice 1a; PM bar: "test it as
// an attack from an isolated agent"). Two canaries stand for what the member
// must never get: a value in the server's own env (office tokens and keys live
// there) and another member's personal variable. Office variables reach the
// member as today, so the office variable is the enabling value, not a canary.
//
// Each path is driven from where the env is built (buildEnvForUserId, the
// agent manager), so a copy that drops the member's tag before the spawn shows
// red here (the office host refuses a tagged env, a member host an untagged
// one, and the recording stand-ins here record where each call went).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { memberEnvOwner } from "../agent-host.ts";
import { buildEnvForUserId } from "../env-loader.ts";
import type { ManagedAgent } from "../internal-types.ts";
import { openTerminal, killSidecar } from "../terminal.ts";
import { startAskRun } from "../ask-command-runner.ts";
import { realV1SdkClient } from "../backends/claude.ts";
import { JsonRpcLiteClient } from "../backends/codex/client.ts";
import { openCodeSupervisorForEnvironment } from "../backends/opencode/supervisor.ts";
import { createMember, getUserByName } from "../users.ts";
import { removeManagedUserEnv, writeManagedUserEnv } from "../user-env.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  carried,
  isolateMember,
  type IsolatedMember,
} from "./member-host-fixture.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FOLDER_FILES_MCP_PATH } from "../folder-mcp-endpoint.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { createCronjobManager } from "../cronjob-manager.ts";
import { makeFakeCronPersistence } from "./fake-cron-persistence.ts";
import type { AgentInfo } from "../../shared/types.ts";

const SERVER_CANARY = `server-canary-${crypto.randomUUID()}`;
const BOB_CANARY = `bob-canary-${crypto.randomUUID()}`;
const CANARY_KEY = "ISOMUX_TEST_SERVER_CANARY";

function memberId(name: string): string {
  const known = getUserByName(name);
  if (known) return known.id;
  const created = createMember(name, { role: "member" });
  if (!created.ok) throw new Error(created.error);
  return created.user.id;
}

let iso: IsolatedMember | null = null;
let dirs: string[] = [];
let server: TestServer | null = null;

beforeAll(() => {
  process.env[CANARY_KEY] = SERVER_CANARY;
});
afterAll(() => {
  delete process.env[CANARY_KEY];
});

afterEach(async () => {
  await server?.stop();
  server = null;
  iso?.dispose();
  iso = null;
  removeManagedUserEnv(memberId("RoutingAlice"));
  removeManagedUserEnv(memberId("RoutingBob"));
  clearTestManagedOfficeEnv();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), "member-routing-"));
  dirs.push(d);
  return d;
}

// Alice is isolated; Bob is a plain member with a secret-looking variable.
async function setup(): Promise<{ alice: string; iso: IsolatedMember }> {
  const alice = memberId("RoutingAlice");
  const bob = memberId("RoutingBob");
  writeManagedUserEnv(alice, { ALICE_VAR: "alice-ok" });
  writeManagedUserEnv(bob, { BOB_TOKEN: BOB_CANARY });
  setTestManagedOfficeEnv({ OFFICE_VAR: "office-ok" });
  iso = await isolateMember(alice);
  return { alice, iso };
}

function expectNoCanary(text: string): void {
  expect(text.includes(SERVER_CANARY)).toBe(false);
  expect(text.includes(BOB_CANARY)).toBe(false);
}

async function waitUntil(pred: () => boolean, label: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(10);
  }
}

describe("the env of an isolated member", () => {
  it("is tagged with the member, starts from the member host's env, and carries no canary", async () => {
    const { alice, iso } = await setup();
    const env = buildEnvForUserId(alice);
    expect(env).toBeDefined();
    expect(memberEnvOwner(env)).toBe(alice);
    expect(env!.HOME).toBe(iso.home);
    expect(env!.ALICE_VAR).toBe("alice-ok");
    expect(env!.OFFICE_VAR).toBe("office-ok");
    expectNoCanary(Object.values(env!).join("\n"));
    // A base from the caller is never tagged as the member's: an office
    // base would carry the server's env onto the member's host.
    expect(() => buildEnvForUserId(alice, { ...process.env })).toThrow();
    // A plain member is unchanged: no tag.
    expect(memberEnvOwner(buildEnvForUserId(memberId("RoutingBob")))).toBe(
      undefined,
    );
  });
});

describe("an isolated member's agent through the agent manager", () => {
  async function office() {
    const fakeBackend = new FakeBackend({
      storedSessionState: "durable",
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    const srv = (server = await startTestServer({ fakeBackend }));
    const owner = await srv.seedOwner("RoutingMorgan");
    const room = srv.agentManager.getRooms()[0].id;
    return { srv, fakeBackend, owner, room };
  }

  for (const engine of ["claude", "codex"] as const) {
    it(`${engine}: the session env is the member's, with no canary`, async () => {
      const o = await office();
      const { alice, iso } = await setup();
      const agent = await o.srv.agentManager.spawn(
        "AliceBot",
        folder(),
        "default",
        undefined,
        undefined,
        o.room,
        undefined,
        undefined,
        undefined,
        "RoutingAlice",
        engine,
        undefined,
        alice,
      );
      expect(agent).not.toBeNull();
      const res = await o.srv.http(`/api/agents/${agent!.id}/messages`, {
        method: "POST",
        rawSessionId: o.owner.rawSessionId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(200);
      await waitUntil(
        () => o.fakeBackend.sessions.some((s) => s.opts.agentId === agent!.id),
        "session started",
      );
      const session = o.fakeBackend.sessions.find(
        (s) => s.opts.agentId === agent!.id,
      )!;
      const env = session.opts.env;
      expect(memberEnvOwner(env)).toBe(alice);
      expect(env?.HOME).toBe(iso.home);
      expect(env?.ALICE_VAR).toBe("alice-ok");
      expectNoCanary(Object.values(env ?? {}).join("\n"));
      // Nothing of Alice's ran on the office host.
      expect(
        iso.office
          .processCalls()
          .filter((c) => memberEnvOwner(c.env) === alice),
      ).toEqual([]);
      expect(carried(iso.office.processCalls()).includes("alice-ok")).toBe(
        false,
      );
    });
  }

  it("/isomux-diff of an isolated member's agent runs on the member's host", async () => {
    const o = await office();
    const { alice, iso } = await setup();
    const project = folder();
    expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
    writeFileSync(join(project, "notes.txt"), "x\n");
    const agent = await o.srv.agentManager.spawn(
      "AliceDiff",
      project,
      "default",
      undefined,
      undefined,
      o.room,
      undefined,
      undefined,
      undefined,
      "RoutingAlice",
      "claude",
      undefined,
      alice,
    );
    const res = await o.srv.http(`/api/agents/${agent!.id}/messages`, {
      method: "POST",
      rawSessionId: o.owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `/isomux-diff ${project}` }),
    });
    expect(res.status).toBe(200);
    await waitUntil(
      () => iso.member.calls.some((c) => c.op === "isomuxDiff"),
      "diff on the member host",
    );
    expect(iso.office.calls.filter((c) => c.op === "isomuxDiff")).toEqual([]);
  });
});

describe("each spawn path of an isolated member", () => {
  it("terminal: the sidecar starts on the member host with the member's env", async () => {
    const { alice, iso } = await setup();
    const managed = {
      info: { id: "agent-iso-terminal", userId: alice, cwd: folder() },
      ptySidecar: null,
      ptyBuffer: "",
    } as unknown as ManagedAgent;
    try {
      expect(
        openTerminal("agent-iso-terminal", {
          getAgent: () => managed,
          emit: () => {},
          buildEnvForUserId,
        }),
      ).toBe(true);
      const pipes = iso.member.calls.filter((c) => c.op === "spawnPipe");
      expect(pipes).toHaveLength(1);
      expect(iso.office.processCalls()).toEqual([]);
      const start = JSON.parse(pipes[0].stdin[0]) as {
        env: Record<string, string>;
      };
      expect(start.env.HOME).toBe(iso.home);
      expect(start.env.ALICE_VAR).toBe("alice-ok");
      expectNoCanary(carried(pipes));
    } finally {
      killSidecar(managed);
    }
  });

  it("ask run: the command runs on the member host", async () => {
    const { alice, iso } = await setup();
    const env = buildEnvForUserId(alice)!;
    await startAskRun({
      command: "true",
      cwd: folder(),
      env,
      shell: "/bin/sh",
      timeoutMs: 2000,
    })
      .then((r) => r.done)
      .catch(() => {});
    const spawns = iso.member.calls.filter((c) => c.op === "spawnChild");
    expect(spawns).toHaveLength(1);
    expect(memberEnvOwner(spawns[0].env)).toBe(alice);
    expect(iso.office.processCalls()).toEqual([]);
    expectNoCanary(carried(spawns));
  });

  it("Claude: the SDK starts the CLI on the member host, with the member's tag kept through the SDK", async () => {
    const { alice, iso } = await setup();
    await realV1SdkClient
      .oneShotPrompt({
        prompt: "Topic",
        model: "claude-haiku-4-5",
        pathToClaudeCodeExecutable: "/bin/true",
        env: buildEnvForUserId(alice),
      })
      .catch(() => {});
    const spawns = iso.member.calls.filter((c) => c.op === "spawnChild");
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns.every((c) => memberEnvOwner(c.env) === alice)).toBe(true);
    expect(iso.office.processCalls()).toEqual([]);
    expectNoCanary(carried(spawns));
  });

  it("Codex: the App Server starts on the member host", async () => {
    const { alice, iso } = await setup();
    const client = new JsonRpcLiteClient({
      codexBin: "/bin/false",
      args: ["app-server"],
      cwd: folder(),
      env: buildEnvForUserId(alice),
      skipSafetyPreflightForTestProbe: true,
    });
    try {
      await client.start().catch(() => {});
    } finally {
      await client.close().catch(() => {});
    }
    const spawns = iso.member.calls.filter((c) => c.op === "spawnChild");
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns.every((c) => memberEnvOwner(c.env) === alice)).toBe(true);
    expect(iso.office.processCalls()).toEqual([]);
    expectNoCanary(carried(spawns));
  });

  it("OpenCode: the server helper runs on the member host", async () => {
    const { alice, iso } = await setup();
    const supervisor = openCodeSupervisorForEnvironment(
      `routing-${alice}`,
      buildEnvForUserId(alice),
    );
    await Promise.race([supervisor.acquire().catch(() => {}), Bun.sleep(5000)]);
    const calls = iso.member.processCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls
        .filter((c) => c.op === "run" || c.op === "spawnChild")
        .every((c) => memberEnvOwner(c.env) === alice),
    ).toBe(true);
    expect(iso.office.processCalls()).toEqual([]);
    expectNoCanary(carried(calls));
  });
});

describe("the other paths of an isolated member's agent", () => {
  async function office() {
    const fakeBackend = new FakeBackend({
      storedSessionState: "durable",
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    const srv = (server = await startTestServer({ fakeBackend }));
    const owner = await srv.seedOwner("RoutingMorgan");
    const room = srv.agentManager.getRooms()[0].id;
    return { srv, fakeBackend, owner, room };
  }

  async function aliceAgent(
    o: Awaited<ReturnType<typeof office>>,
    alice: string,
    engine: AgentInfo["agentType"],
    cwd = folder(),
  ): Promise<AgentInfo> {
    const agent = await o.srv.agentManager.spawn(
      `Alice ${engine}`,
      cwd,
      "default",
      undefined,
      undefined,
      o.room,
      undefined,
      engine === "codex" ? "gpt-5.5" : undefined,
      undefined,
      "RoutingAlice",
      engine,
      undefined,
      alice,
    );
    if (!agent) throw new Error("spawn failed");
    return agent;
  }

  it("the diff route (an agent's own diff card) runs on the member's host", async () => {
    const o = await office();
    const { alice, iso } = await setup();
    const project = folder();
    expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
    const agent = await aliceAgent(o, alice, "claude", project);
    await o.srv.agentManager.emitAgentDiff(agent.id, project);
    expect(iso.member.calls.filter((c) => c.op === "isomuxDiff")).toHaveLength(
      1,
    );
    expect(iso.office.calls.filter((c) => c.op === "isomuxDiff")).toEqual([]);
  });

  it("an ask's Run runs on the member's host with the member's env", async () => {
    const o = await office();
    const { alice, iso } = await setup();
    const agent = await aliceAgent(o, alice, "claude");
    await o.srv.agentManager
      .runAskCommand(agent.id, "true")
      .then((r) => r.done)
      .catch(() => {});
    const spawns = iso.member.calls.filter((c) => c.op === "spawnChild");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].env?.HOME).toBe(iso.home);
    expect(iso.office.processCalls()).toEqual([]);
    expectNoCanary(carried(spawns));
  });

  it("the folder file tools of a Codex agent run on the member's host", async () => {
    const o = await office();
    const { alice, iso } = await setup();
    const agent = await aliceAgent(o, alice, "codex");
    const access = await o.srv.http(`/api/agents/${agent.id}/access`, {
      method: "PUT",
      rawSessionId: o.owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access: "folder" }),
    });
    expect(access.status).toBe(200);
    const token = getAgentTokenRaw(agent.id);
    expect(typeof token).toBe("string");
    const client = new Client({ name: "routing-files", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${o.srv.baseUrl}${FOLDER_FILES_MCP_PATH}`),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
      ),
    );
    try {
      await client.callTool({
        name: "read_file",
        arguments: { file_path: "readme.txt" },
      });
    } finally {
      await client.close().catch(() => {});
    }
    expect(
      iso.member.calls.filter(
        (c) => c.op === "runEntry" && c.argv[0] === "folder-files",
      ),
    ).toHaveLength(1);
    expect(iso.office.processCalls()).toEqual([]);
  }, 30_000);
});

describe("a schedule of an isolated member", () => {
  function cron(fake: FakeBackend) {
    return createCronjobManager({
      resolveBackend: () => fake,
      resolveEnv: buildEnvForUserId,
      resolveEnvironmentKey: () => "routing-environment",
      resolveEnvironmentRevision: () => "routing-revision",
      resolveUser: () => undefined,
      persistence: makeFakeCronPersistence(),
      clock: { now: () => Date.now() },
      scheduler: {
        setTimeout: (() => 0) as unknown as typeof setTimeout,
        clearTimeout: () => {},
        setInterval: (() => 0) as unknown as typeof setInterval,
        clearInterval: () => {},
      },
      renderMemoryForPrompt: () => null,
    });
  }

  it("a run starts with the member's env, and its diff runs on the member's host", async () => {
    const { alice, iso } = await setup();
    const project = folder();
    expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
    // The session stays open, so the run is live for the diff.
    const fake = new FakeBackend();
    const mgr = cron(fake);
    const job = mgr.addCronjob({
      name: "AliceJob",
      schedule: { type: "interval", minutes: 60 },
      prompt: "do the thing",
      cwd: project,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username: "RoutingAlice",
      userId: alice,
    });
    const run = mgr.runCronjobNow(job.id, "RoutingAlice");
    expect(run).not.toBeNull();
    try {
      await waitUntil(() => fake.lastSession !== undefined, "run session");
      const env = fake.lastSession!.opts.env;
      expect(memberEnvOwner(env)).toBe(alice);
      expect(env?.HOME).toBe(iso.home);
      expectNoCanary(Object.values(env ?? {}).join("\n"));
      await mgr.emitCronjobRunDiff(job.id, run!.id, project);
      expect(
        iso.member.calls.filter((c) => c.op === "isomuxDiff"),
      ).toHaveLength(1);
      expect(iso.office.calls.filter((c) => c.op === "isomuxDiff")).toEqual([]);
    } finally {
      fake.sessions.forEach((s) => s.close());
    }
  });
});
