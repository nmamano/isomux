// RunnerAgentHost as the backends use it: Node-shaped children, file
// operations, collected runs and fixed entries, all through a real runner in
// this process (one user; server/agent-runner/runner.test.ts covers the peer
// check). The split rig proves the same paths with two users.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  localAgentHost,
  setAgentHost,
  type AgentChild,
} from "../agent-host.ts";
import { spawnClaudeThroughHost } from "../backends/claude/agent-spawn.ts";
import { JsonRpcLiteClient } from "../backends/codex/client.ts";
import { configureCodexHooks } from "../backends/codex/safety-hook-install.ts";
import { inspectOpenCodeDatabaseInAgentSpace } from "../backends/opencode/storage.ts";
import { expectRejection } from "../test-support/expect-rejection.ts";
import { RunnerAgentHost, RunnerProcess } from "./client.ts";
import { STDIN_WINDOW_BYTES } from "./frames.ts";
import { startRunner } from "./runner.ts";

let dir: string;
let socketPath: string;
let runner: { stop(): void } | null = null;
let host: RunnerAgentHost;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "agent-runner-host-"));
  socketPath = join(dir, "runner.sock");
  runner = startRunner({
    socketPath,
    serverUid: process.getuid!(),
    readPeerUid: () => process.getuid!(),
    killGraceMs: 300,
  });
  host = await RunnerAgentHost.connect(socketPath);
});

afterEach(() => {
  setAgentHost(localAgentHost);
  runner?.stop();
  runner = null;
  rmSync(dir, { recursive: true, force: true });
});

function running(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z";
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

// Every event of a child, in order, with the stdout read in flowing mode.
function record(child: AgentChild): {
  events: string[];
  done: Promise<void>;
} {
  const events: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => events.push(`stdout:${chunk}`));
  child.on("spawn", () => events.push("spawn"));
  child.on("exit", (code, signal) => events.push(`exit:${code}:${signal}`));
  child.on("error", (error: NodeJS.ErrnoException) =>
    events.push(`error:${error.code}`),
  );
  const done = new Promise<void>((resolve) =>
    child.on("close", (code, signal) => {
      events.push(`close:${code}:${signal}`);
      resolve();
    }),
  );
  return { events, done };
}

describe("runner child", () => {
  it("keeps Node's event order with the last output before exit and close", async () => {
    const child = host.spawnChild(["sh", "-c", "cat; printf tail; exit 4"]);
    const { events, done } = record(child);
    child.stdin.write("head-");
    child.stdin.end();
    await done;
    expect(events.join("")).toContain("head-");
    const exitAt = events.findIndex((e) => e.startsWith("exit"));
    expect(events.slice(exitAt)).toEqual(["exit:4:null", "close:4:null"]);
    expect(events[0]).toBe("spawn");
    expect(
      events
        .filter((e) => e.startsWith("stdout:"))
        .map((e) => e.slice(7))
        .join(""),
    ).toBe("head-tail");
    expect(child.exitCode).toBe(4);
  });

  it("delivers a kill sent before the runner reported the pid", async () => {
    const child = host.spawnChild(["sleep", "30"]);
    const { events, done } = record(child);
    expect(child.pid).toBeUndefined();
    expect(child.kill("SIGTERM")).toBe(true);
    await done;
    expect(events.slice(-2)).toEqual([
      "exit:null:SIGTERM",
      "close:null:SIGTERM",
    ]);
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("delivers a kill while the child's stdin is full", async () => {
    // The child takes 64 KiB, says so, and reads nothing more: the rest of
    // the input fills its pipe and waits in the runner and in this process.
    const child = host.spawnChild([
      "sh",
      "-c",
      "head -c 65536 >/dev/null; echo consumed; exec sleep 30",
    ]);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    let written = false;
    child.stdin.write(Buffer.alloc(3_000_000), () => (written = true));
    // Only the window goes ahead of the runner's acknowledgements.
    expect(child.queuedInputBytes).toBeGreaterThanOrEqual(
      3_000_000 - 2 * STDIN_WINDOW_BYTES,
    );
    expect(await waitFor(() => out === "consumed\n")).toBe(true);
    expect(written).toBe(false);
    expect(child.queuedInputBytes).toBeGreaterThan(0);
    const pid = child.pid!;
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("exit", (_code, signal) => resolve(signal)),
    );
    child.kill("SIGKILL");
    const signal = await Promise.race([
      exited,
      Bun.sleep(1000).then(() => "none"),
    ]);
    expect(signal).toBe("SIGKILL");
    expect(running(pid)).toBe(false);
  });

  it("puts all queued input into the pipe before the end of input", async () => {
    // The child reads nothing until the gate opens. The first write fills
    // the pipe; the other two wait in the runner's queue when the end of
    // input arrives.
    const gate = join(dir, "gate");
    const child = host.spawnChild([
      "sh",
      "-c",
      `while [ ! -e ${gate} ]; do sleep 0.02; done; wc -c`,
    ]);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    for (let i = 0; i < 3; i++) child.stdin.write(Buffer.alloc(300_000, 97));
    child.stdin.end();
    // The end frame is on the socket; give it time to reach the runner.
    await new Promise((resolve) => child.stdin.once("finish", resolve));
    await Bun.sleep(200);
    writeFileSync(gate, "");
    await new Promise((resolve) => child.once("close", resolve));
    expect(out.trim()).toBe("900000");
  });

  it("carries input larger than the window to a reader", async () => {
    const child = host.spawnChild(["sh", "-c", "cat | wc -c"]);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stdin.write(Buffer.alloc(5_000_000, 97));
    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));
    expect(out.trim()).toBe("5000000");
  });

  it("keeps the end of input after the input of a pipe process", async () => {
    // The terminal's process: writes that nobody awaits, then the end.
    const child = new RunnerProcess(socketPath, ["wc", "-c"]);
    void child.stdin.write(new Uint8Array(3_000_000));
    void child.stdin.end();
    expect((await new Response(child.stdout).text()).trim()).toBe("3000000");
    expect(await child.exited).toBe(0);
  });

  it("reports a failed start as error with the errno code and no exit", async () => {
    const child = host.spawnChild([join(dir, "missing")]);
    const { events, done } = record(child);
    await done;
    expect(events).toEqual(["error:ENOENT", "close:null:null"]);
  });

  it("stops a launcher's grandchild with a group signal", async () => {
    const child = host.spawnChild([
      "sh",
      "-c",
      '(trap "" TERM; exec sleep 300) </dev/null >/dev/null 2>&1 & echo $!; wait',
    ]);
    let grandchild = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      grandchild = Number(chunk.toString().trim());
    });
    expect(await waitFor(() => grandchild > 0)).toBe(true);
    child.signalGroup("SIGKILL");
    expect(await waitFor(() => !running(grandchild))).toBe(true);
  });

  it("ends a lost connection with an exit and rejects a pending Codex request", async () => {
    const script = join(dir, "silent-codex.sh");
    writeFileSync(script, "#!/bin/sh\nexec cat > /dev/null\n");
    chmodSync(script, 0o755);
    setAgentHost(host);
    const client = new JsonRpcLiteClient({
      codexBin: script,
      args: [],
      skipSafetyPreflightForTestProbe: true,
    });
    await client.start();
    expect(client.pid()).toBeGreaterThan(0);
    const pending = client.request("thread/read", {});
    runner!.stop();
    runner = null;
    await expectRejection(pending, /codex subprocess exited with code 1/);
  });

  it("starts from the runner's environment and keeps a removed key unset", async () => {
    process.env.SPLIT_HOST_TEST = "from-runner";
    try {
      const fresh = await RunnerAgentHost.connect(socketPath);
      const echo = (env?: Record<string, string | undefined>) =>
        fresh.run(["sh", "-c", 'printf %s "${SPLIT_HOST_TEST-unset}"'], {
          env,
        });
      expect((await echo()).stdout).toBe("from-runner");
      expect(
        (await echo({ ...fresh.baseEnv(), SPLIT_HOST_TEST: undefined })).stdout,
      ).toBe("unset");
    } finally {
      delete process.env.SPLIT_HOST_TEST;
    }
  });

  it("passes an empty argument through", async () => {
    // The Claude SDK sends `--setting-sources ""` for a one-shot prompt.
    const result = await host.run(["sh", "-c", 'printf "[%s]" "$1"', "sh", ""]);
    expect(result.stdout).toBe("[]");
  });

  it("collects a run, or drops its output", async () => {
    const argv = ["sh", "-c", "printf out; printf err >&2; exit 3"];
    expect(await host.run(argv, { cwd: dir })).toEqual({
      exitCode: 3,
      stdout: "out",
      stderr: "err",
    });
    expect(await host.run(argv, { output: "ignore" })).toEqual({
      exitCode: 3,
      stdout: "",
      stderr: "",
    });
  });
});

describe("runner file operations", () => {
  it("writes, reads, checks and removes files as the runner's user", async () => {
    const path = join(dir, "a", "b", "file.txt");
    await host.fs.mkdir(join(dir, "a", "b"), 0o700);
    expect(statSync(join(dir, "a")).mode & 0o777).toBe(0o700);
    const big = "x".repeat(3_000_000);
    await host.fs.writeText(path, big, { mode: 0o600, exclusive: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await host.fs.readText(path)).toBe(big);
    expect(await host.fs.exists(path)).toBe(true);
    await host.fs.chmod(path, 0o640);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    await host.fs.rm(path);
    await host.fs.rm(path);
    expect(await host.fs.exists(path)).toBe(false);
  });

  const failure = (p: Promise<unknown>) =>
    p.then(
      () => "resolved",
      (error: NodeJS.ErrnoException) => error.code,
    );

  it("fails with the errno code", async () => {
    const path = join(dir, "once.txt");
    await host.fs.writeText(path, "1", { mode: 0o600, exclusive: true });
    expect(
      await failure(
        host.fs.writeText(path, "2", { mode: 0o600, exclusive: true }),
      ),
    ).toBe("EEXIST");
    expect(readFileSync(path, "utf8")).toBe("1");
    expect(await failure(host.fs.readText(join(dir, "absent")))).toBe("ENOENT");
    expect(await failure(host.fs.readText("relative/path"))).toBe(
      "bad_request",
    );
  });
});

describe("agent-space entries", () => {
  it("merges the Codex hook configuration the same way as in process", async () => {
    const hookPath = "/share/bin/isomux-codex-safety-hook";
    const trustedHash = "sha256:0123";
    const local = join(dir, "local-home");
    const remote = join(dir, "remote-home");
    const expected = configureCodexHooks(local, hookPath, trustedHash);
    setAgentHost(host);
    const result = await host.runEntry("codex-hook-config", {
      codexHome: remote,
      hookPath,
      trustedHash,
    });
    expect(expected.warning).toBeNull();
    expect(result).toEqual({
      warning: null,
      hookIdentity: {
        sourcePath: join(remote, "hooks.json"),
        displayOrder: expected.hookIdentity!.displayOrder,
      },
    });
    for (const file of ["hooks.json", "config.toml"])
      expect(
        readFileSync(join(remote, file), "utf8").replaceAll(remote, "HOME"),
      ).toBe(readFileSync(join(local, file), "utf8").replaceAll(local, "HOME"));
  });

  it("inspects OpenCode storage in agent space and returns only the state", async () => {
    setAgentHost(host);
    const databasePath = join(dir, "data", "opencode.db");
    mkdirSync(join(dir, "data"));
    expect(
      await inspectOpenCodeDatabaseInAgentSpace(databasePath, "ses_1"),
    ).toBe("missing");
  });
});

describe("Claude through the agent host", () => {
  function fakeSignal(aborted: boolean) {
    const listeners = new Set<() => void>();
    return {
      listeners,
      signal: {
        aborted,
        addEventListener: (_: string, listener: () => void) =>
          listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) =>
          listeners.delete(listener),
      } as unknown as AbortSignal,
    };
  }

  it("passes argv, cwd and env, and drops its abort listener at the end", async () => {
    const { signal, listeners } = fakeSignal(false);
    const child = spawnClaudeThroughHost(host, {
      command: "sh",
      args: ["-c", 'printf "%s|%s" "$PWD" "$CLAUDE_TEST"'],
      cwd: dir,
      env: { PATH: process.env.PATH, CLAUDE_TEST: "set" },
      signal,
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    expect(listeners.size).toBe(1);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(out).toBe(`${dir}|set`);
    expect(listeners.size).toBe(0);
  });

  it("kills at once when the signal is already aborted", async () => {
    const { signal, listeners } = fakeSignal(true);
    const child = spawnClaudeThroughHost(host, {
      command: "sleep",
      args: ["30"],
      env: { PATH: process.env.PATH },
      signal,
    });
    const signalled = await new Promise<string | null>((resolve) =>
      child.once("exit", (_code, sig) => resolve(sig)),
    );
    expect(signalled).toBe("SIGTERM");
    expect(listeners.size).toBe(0);
  });
});
