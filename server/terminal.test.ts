import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { homedir, userInfo } from "os";
import type { ManagedAgent } from "./internal-types.ts";
import { openTerminal, type TerminalDeps } from "./terminal.ts";
import { localAgentHost, type AgentHost } from "./agent-host.ts";

afterEach(() => mock.restore());

function fixture(buildEnvForUserId: TerminalDeps["buildEnvForUserId"]) {
  const managed = {
    info: { id: "agent-terminal", userId: "member-id", cwd: "/tmp" },
    ptySidecar: null,
    ptyBuffer: "",
  } as unknown as ManagedAgent;
  const write = mock((data: string) => data.length);
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    stdin: { write },
    stdout: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    exited: new Promise<number>(() => {}),
    pid: 123,
  } as unknown as ReturnType<typeof Bun.spawn>);
  const emit = mock((_event: Parameters<TerminalDeps["emit"]>[0]) => {});
  spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const deps: TerminalDeps = {
    getAgent: () => managed,
    emit,
    buildEnvForUserId,
  };
  return {
    managed,
    spawn,
    emit,
    warn,
    deps,
    env: () => JSON.parse(write.mock.calls[0][0]).env,
  };
}

describe("terminal environment", () => {
  it("passes the agent owner's managed variables to the PTY", () => {
    const build = mock((userId: string | null | undefined) => ({
      TERMINAL_MEMBER_VALUE:
        userId === "member-id" ? "member-value" : "wrong-owner",
      CLAUDE_CONFIG_DIR: "/personal/claude",
      CODEX_HOME: "/personal/codex",
    }));
    const f = fixture(build);
    expect(openTerminal("agent-terminal", f.deps)).toBe(true);
    expect(build).toHaveBeenCalledWith("member-id");
    const env = f.env();
    expect(env.TERMINAL_MEMBER_VALUE).toBe("member-value");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/personal/claude");
    expect(env.CODEX_HOME).toBe("/personal/codex");
  });

  it("keeps all six shell overlay values above managed values", () => {
    const f = fixture(() => ({
      TERM: "managed",
      SHELL: "managed",
      HOME: "managed",
      USER: "managed",
      LANG: "managed",
      PATH: "managed",
    }));
    expect(openTerminal("agent-terminal", f.deps)).toBe(true);
    expect(f.env()).toMatchObject({
      TERM: "xterm-256color",
      SHELL: process.env.SHELL || "/bin/bash",
      HOME: homedir(),
      USER: process.env.USER || userInfo().username,
      LANG: process.env.LANG || "en_US.UTF-8",
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    });
  });

  it("warns and exits without a sidecar when environment loading throws", () => {
    const error = new Error("managed environment import pending");
    const f = fixture(() => {
      throw error;
    });
    expect(openTerminal("agent-terminal", f.deps)).toBe(false);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.managed.ptySidecar).toBeNull();
    expect(f.warn).toHaveBeenCalledWith(
      "[terminal] cannot open PTY for agent-terminal:",
      error,
    );
    expect(f.emit).toHaveBeenCalledWith({
      type: "terminal_exit",
      agentId: "agent-terminal",
      exitCode: 1,
    });
  });
});

describe("terminal on an agent host", () => {
  it("takes the shell's environment, Bun and process from the host", () => {
    const write = mock((data: string) => data.length);
    const spawnPipe = mock((argv: string[]) => ({
      pid: 7,
      stdin: { write, end: () => {} },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      exited: new Promise<number>(() => {}),
      kill: () => {},
      argv,
    }));
    const host: AgentHost = {
      ...localAgentHost,
      kind: "runner",
      baseEnv: () => ({ PATH: "/agent/bin", SHELL: "/bin/zsh", USER: "agent" }),
      home: () => "/agent/home",
      username: () => "agent-name",
      bunPath: () => "/agent/bun",
      spawnPipe,
      isomuxDiff: async () => ({ kind: "not_repo", cwd: "/" }),
    };
    const spawn = spyOn(Bun, "spawn");
    spyOn(console, "log").mockImplementation(() => {});
    const managed = {
      info: { id: "agent-terminal", userId: null, cwd: "/work" },
      ptySidecar: null,
      ptyBuffer: "",
    } as unknown as ManagedAgent;
    expect(
      openTerminal("agent-terminal", {
        getAgent: () => managed,
        emit: () => {},
        buildEnvForUserId: () => undefined,
        host,
      }),
    ).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnPipe.mock.calls[0][0][0]).toBe("/agent/bun");
    const env = JSON.parse(write.mock.calls[0][0]).env;
    expect(env).toMatchObject({
      SHELL: "/bin/zsh",
      HOME: "/agent/home",
      USER: "agent",
      PATH: "/agent/bin",
    });
    expect(env.HOME).not.toBe(homedir());
  });
});

for (const structuredExit of [false, true]) {
  it(`drains sidecar output before ${structuredExit ? "structured" : "fallback"} exit`, async () => {
    const f = fixture(() => ({}));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    f.spawn.mockReturnValue({
      stdin: { write: () => 0 },
      stdout,
      exited: Promise.resolve(9),
      pid: 123,
    } as unknown as ReturnType<typeof Bun.spawn>);
    openTerminal("agent-terminal", f.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.emit.mock.calls).toHaveLength(0);
    const lines =
      JSON.stringify({ type: "output", data: "tail" }) +
      "\n" +
      (structuredExit
        ? JSON.stringify({ type: "exit", exitCode: 7 }) + "\n"
        : "");
    controller.enqueue(new TextEncoder().encode(lines));
    controller.close();
    await Bun.sleep(0);
    expect(f.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "terminal_output", agentId: "agent-terminal", data: "tail" },
      {
        type: "terminal_exit",
        agentId: "agent-terminal",
        exitCode: structuredExit ? 7 : 9,
      },
    ]);
  });
}

it("audits real terminal starts and stops, but not repeated opens or absent closes", async () => {
  const { closeTerminal, restartTerminal } = await import("./terminal.ts");
  const { officeAuditStore } = await import("./audit-store.ts");
  const f = fixture(() => ({}));
  f.spawn.mockImplementation(
    () =>
      ({
        stdin: { write: () => 1 },
        stdout: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: new Promise<number>(() => {}),
        pid: 123,
      }) as unknown as ReturnType<typeof Bun.spawn>,
  );
  const actor = {
    kind: "member" as const,
    id: "terminal-member",
    name: "Terminal member",
  };
  const before = officeAuditStore().list({ actorId: actor.id }).items.length;
  openTerminal("agent-terminal", f.deps, actor);
  openTerminal("agent-terminal", f.deps, actor);
  closeTerminal("agent-terminal", f.deps, actor);
  closeTerminal("agent-terminal", f.deps, actor);
  openTerminal("agent-terminal", f.deps, actor);
  restartTerminal("agent-terminal", f.deps, actor);
  const rows = officeAuditStore().list({ actorId: actor.id }).items;
  expect(rows.length - before).toBe(5);
  expect(rows.slice(0, 5).map((row) => row.operation)).toEqual([
    "terminal.open",
    "terminal.close",
    "terminal.open",
    "terminal.close",
    "terminal.open",
  ]);
});
