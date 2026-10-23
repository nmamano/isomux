import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "fs";
import { homedir, userInfo } from "os";
import type { TerminalRecordingEvent } from "../shared/terminal-recording.ts";
import { officeAuditStore } from "./audit-store.ts";
import type { ManagedAgent } from "./internal-types.ts";
import {
  closeTerminal,
  killSidecar,
  openTerminal,
  restartTerminal,
  terminalInput,
  terminalResize,
  type TerminalDeps,
} from "./terminal.ts";
import {
  listTerminalRecordings,
  parseTerminalRecording,
  terminalRecordingPath,
} from "./terminal-recorder.ts";
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
  spyOn(console, "warn").mockImplementation(() => {});
  const deps: TerminalDeps = {
    getAgent: () => managed,
    emit,
    buildEnvForUserId,
  };
  return {
    managed,
    spawn,
    emit,
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

  it("exits without a sidecar when environment loading throws", () => {
    const f = fixture(() => {
      throw new Error("managed environment import pending");
    });
    expect(openTerminal("agent-terminal", f.deps)).toBe(false);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.managed.ptySidecar).toBeNull();
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

it("audits real terminal starts and stops, but not repeated opens or absent closes", () => {
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

describe("the secrets notice", () => {
  it("a new terminal clears the flag, and a status after a secrets change carries it", async () => {
    const managed = {
      info: { id: "agent-terminal", userId: "member-id", cwd: "/tmp" },
      ptySidecar: null,
      ptyBuffer: "",
      // Left over from a terminal that a change reached before.
      ptyEnvStale: true,
    } as unknown as ManagedAgent;
    let push!: (line: string) => void;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (line) =>
          controller.enqueue(new TextEncoder().encode(`${line}\n`));
      },
    });
    spyOn(Bun, "spawn").mockReturnValue({
      stdin: { write: mock((data: string) => data.length) },
      stdout,
      exited: new Promise<number>(() => {}),
      pid: 123,
    } as unknown as ReturnType<typeof Bun.spawn>);
    spyOn(console, "log").mockImplementation(() => {});
    const events: Parameters<TerminalDeps["emit"]>[0][] = [];
    const deps: TerminalDeps = {
      getAgent: () => managed,
      emit: (event) => events.push(event),
      buildEnvForUserId: () => ({}),
    };
    expect(openTerminal("agent-terminal", deps)).toBe(true);
    expect(managed.ptyEnvStale).toBe(false);
    const status = JSON.stringify({
      type: "status",
      process: "bash",
      shell: true,
    });
    push(status);
    await new Promise((r) => setTimeout(r, 20));
    // The agent manager marks the terminal when its secrets change.
    managed.ptyEnvStale = true;
    push(status);
    await new Promise((r) => setTimeout(r, 20));
    const statuses = events.filter((e) => e.type === "terminal_status");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).not.toHaveProperty("envStale");
    expect(statuses[1]).toMatchObject({ envStale: true });
  });
});

// Terminal recording (task 749cb7fd, slice b): which sessions are recorded,
// what reaches the file from the terminal, how each way a session ends closes
// the file, and the terminal.join row.
describe("terminal recording", () => {
  const alice = { kind: "member" as const, id: "u-rec-alice", name: "Alice" };
  const bob = { kind: "member" as const, id: "u-rec-bob", name: "Bob" };

  // An agent whose sidecars the test drives: output and status lines, the
  // stdout end, and the process exit.
  function rig(recordTerminals?: () => boolean) {
    const agentId = `agent-rec-${crypto.randomUUID().slice(0, 8)}`;
    const managed = {
      info: { id: agentId, userId: "member-id", cwd: "/tmp" },
      ptySidecar: null,
      ptyBuffer: "",
    } as unknown as ManagedAgent;
    const sidecars: {
      send: (msg: object) => void;
      endOutput: () => void;
      exit: (code: number) => void;
    }[] = [];
    spyOn(Bun, "spawn").mockImplementation(() => {
      let out!: ReadableStreamDefaultController<Uint8Array>;
      let exit!: (code: number) => void;
      sidecars.push({
        send: (msg) =>
          out.enqueue(new TextEncoder().encode(JSON.stringify(msg) + "\n")),
        endOutput: () => out.close(),
        exit: (code) => exit(code),
      });
      return {
        stdin: { write: () => 1 },
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            out = controller;
          },
        }),
        exited: new Promise<number>((resolve) => {
          exit = resolve;
        }),
        pid: 123,
        kill: () => {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });
    spyOn(console, "log").mockImplementation(() => {});
    const events: Parameters<TerminalDeps["emit"]>[0][] = [];
    const deps: TerminalDeps = {
      getAgent: (id) => (id === agentId ? managed : undefined),
      emit: (event) => events.push(event),
      buildEnvForUserId: () => ({}),
      ...(recordTerminals ? { recordTerminals } : {}),
    };
    return {
      agentId,
      managed,
      sidecars,
      events,
      deps,
      recordings: () => listTerminalRecordings({ agentId }),
      // The terminal audit rows of this agent, oldest first.
      rows: () =>
        officeAuditStore()
          .list({ targetId: agentId })
          .items.filter((row) => row.operation.startsWith("terminal."))
          .reverse(),
    };
  }

  // The sidecar's lines are read asynchronously.
  const settle = () => Bun.sleep(5);

  // A recording, once its "end" or "cap" event is on disk.
  async function finished(id: string) {
    const deadline = Date.now() + 2000;
    for (;;) {
      const parsed = parseTerminalRecording(
        readFileSync(terminalRecordingPath(id)!, "utf8"),
      );
      if (parsed.events.at(-1)?.[1] === "x") return parsed;
      if (Date.now() > deadline) throw new Error(`recording ${id} never ended`);
      await Bun.sleep(5);
    }
  }

  const outputText = (events: TerminalRecordingEvent[]) =>
    events
      .filter((e) => e[1] === "o")
      .map((e) => e[2])
      .join("");

  it("is off when the office gives no setting", async () => {
    const r = rig();
    expect(openTerminal(r.agentId, r.deps, alice)).toBe(true);
    r.sidecars[0].send({ type: "output", data: "hello\r\n" });
    await settle();
    closeTerminal(r.agentId, r.deps, alice);
    expect(r.recordings()).toEqual([]);
    expect(r.rows().map((row) => row.terminalRecording)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("records a session only when the setting is on at its start", async () => {
    let on = false;
    const r = rig(() => on);
    openTerminal(r.agentId, r.deps, alice);
    // Turned on mid-session: the running terminal stays unrecorded.
    on = true;
    r.sidecars[0].send({ type: "output", data: "before\r\n" });
    await settle();
    expect(r.recordings()).toEqual([]);
    closeTerminal(r.agentId, r.deps, alice);

    openTerminal(r.agentId, r.deps, alice);
    // Turned off mid-session: the running terminal stays recorded.
    on = false;
    r.sidecars[1].send({ type: "output", data: "after\r\n" });
    await settle();
    closeTerminal(r.agentId, r.deps, alice);

    const [recording, ...more] = r.recordings();
    expect(more).toEqual([]);
    const { header, events } = await finished(recording.id);
    expect(header.isomux.startedBy.id).toBe(alice.id);
    expect(outputText(events)).toBe("after\r\n");
    // The open row of the recorded session names its recording.
    const opens = r.rows().filter((row) => row.operation === "terminal.open");
    expect(opens.map((row) => row.terminalRecording?.id)).toEqual([
      undefined,
      recording.id,
    ]);
  });

  it("writes the output, the resizes and who typed, never what they typed", async () => {
    const r = rig(() => true);
    openTerminal(r.agentId, r.deps, alice);
    r.sidecars[0].send({ type: "output", data: "$ " });
    await settle();
    terminalResize(r.agentId, 100, 30, r.deps, alice);
    terminalInput(r.agentId, "typed-only-xyz\r", r.deps, bob);
    r.sidecars[0].send({ type: "output", data: "done\r\n" });
    await settle();
    closeTerminal(r.agentId, r.deps, alice);
    const [recording] = r.recordings();
    const { events } = await finished(recording.id);
    expect(outputText(events)).toBe("$ done\r\n");
    expect(events.filter((e) => e[1] === "r").map((e) => e[2])).toEqual([
      "100x30",
    ]);
    expect(
      events
        .filter((e) => e[1] === "u")
        .map((e) => (e[2] as { id: string }).id),
    ).toEqual([bob.id]);
    expect(
      readFileSync(terminalRecordingPath(recording.id)!, "utf8"),
    ).not.toContain("typed-only-xyz");
  });

  // Every way a terminal session ends writes the "end" event.
  const endings: [string, (r: ReturnType<typeof rig>) => void][] = [
    ["a member closes it", (r) => closeTerminal(r.agentId, r.deps, alice)],
    ["a member restarts it", (r) => restartTerminal(r.agentId, r.deps, alice)],
    [
      "the shell exits",
      (r) => r.sidecars[0].send({ type: "exit", exitCode: 0 }),
    ],
    [
      "the sidecar dies without an exit line",
      (r) => {
        r.sidecars[0].endOutput();
        r.sidecars[0].exit(9);
      },
    ],
    ["the agent is killed", (r) => killSidecar(r.managed)],
  ];
  for (const [way, end] of endings) {
    it(`ends the recording when ${way}`, async () => {
      const r = rig(() => true);
      openTerminal(r.agentId, r.deps, alice);
      r.sidecars[0].send({ type: "output", data: "work\r\n" });
      await settle();
      const [first] = r.recordings();
      end(r);
      const { events } = await finished(first.id);
      expect(events.at(-1)?.[2]).toBe("end");
      expect(outputText(events)).toBe("work\r\n");
      if (way === "a member restarts it") {
        // The new session is a new recording, and its open row says so.
        const ids = r.recordings().map((rec) => rec.id);
        expect(ids).toHaveLength(2);
        const second = ids.find((id) => id !== first.id);
        expect(r.rows().at(-1)?.terminalRecording?.id).toBe(second);
      }
    });
  }

  // A restart installs a new sidecar before the old one has exited: its late
  // exit, structured or not, must not detach the new session.
  it("keeps the new session attached when the replaced sidecar exits late", async () => {
    const r = rig();
    openTerminal(r.agentId, r.deps, alice);
    restartTerminal(r.agentId, r.deps, alice);
    const current = r.managed.ptySidecar;
    expect(current).not.toBeNull();
    r.sidecars[0].send({ type: "exit", exitCode: 0 });
    r.sidecars[0].endOutput();
    r.sidecars[0].exit(9);
    await settle();
    expect(r.managed.ptySidecar).toBe(current);
    expect(r.events.filter((e) => e.type === "terminal_exit")).toEqual([]);
    // The new sidecar's own exit still ends the session.
    r.sidecars[1].send({ type: "exit", exitCode: 3 });
    await settle();
    expect(r.managed.ptySidecar).toBeNull();
    expect(r.events.filter((e) => e.type === "terminal_exit")).toEqual([
      { type: "terminal_exit", agentId: r.agentId, exitCode: 3 },
    ]);
  });

  it("writes one terminal.join row per member who joins a running session", async () => {
    let on = true;
    const r = rig(() => on);
    openTerminal(r.agentId, r.deps, alice);
    // The opener's remount writes nothing.
    openTerminal(r.agentId, r.deps, alice);
    openTerminal(r.agentId, r.deps, bob);
    // Nor does the joiner's remount.
    openTerminal(r.agentId, r.deps, bob);
    closeTerminal(r.agentId, r.deps, alice);
    // A new, unrecorded session: Bob opens it, Alice joins it.
    on = false;
    openTerminal(r.agentId, r.deps, bob);
    openTerminal(r.agentId, r.deps, alice);
    openTerminal(r.agentId, r.deps, alice);

    const [recording, ...more] = r.recordings();
    expect(more).toEqual([]);
    const rows = r.rows();
    expect(rows.map((row) => [row.operation, row.actor.id])).toEqual([
      ["terminal.open", alice.id],
      ["terminal.join", bob.id],
      ["terminal.close", alice.id],
      ["terminal.open", bob.id],
      ["terminal.join", alice.id],
    ]);
    const joins = rows.filter((row) => row.operation === "terminal.join");
    expect(joins.map((row) => row.targets)).toEqual([[r.agentId], [r.agentId]]);
    expect(joins.map((row) => row.terminalRecording?.id)).toEqual([
      recording.id,
      undefined,
    ]);
  });

  it("says in terminal_status that the session is recorded, only while it is", async () => {
    let on = true;
    const r = rig(() => on);
    const status = { type: "status", process: "bash", shell: true };
    openTerminal(r.agentId, r.deps, alice);
    r.sidecars[0].send(status);
    await settle();
    closeTerminal(r.agentId, r.deps, alice);
    on = false;
    openTerminal(r.agentId, r.deps, alice);
    r.sidecars[1].send(status);
    await settle();
    const statuses = r.events.filter((e) => e.type === "terminal_status");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({ recorded: true });
    expect(statuses[1]).not.toHaveProperty("recorded");
  });
});
