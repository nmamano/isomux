// The runner and its client as one user: a test cannot change uid, so the peer
// check runs through an injected uid reader here. The split rig
// (server/test-support/split-rig.integration.test.ts) checks a real foreign uid.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { connect, createServer, type Server } from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { getAgentHost, setAgentHost } from "../agent-host.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  copySessionFilesInAgentSpace,
  removeSessionSourceInAgentSpace,
} from "../session-account-move.ts";
import { runIsomuxDiff } from "../isomux-diff.ts";
import {
  readRunnerInfo,
  RunnerAgentHost,
  RunnerProcess,
  runRunnerEntry,
} from "./client.ts";
import {
  createFrameDecoder,
  encodeJson,
  encodeData,
  FRAME_STDIN,
  FRAME_JSON,
  FRAME_STDOUT,
} from "./frames.ts";
import { startRunner } from "./runner.ts";
import { expectRejection } from "../test-support/expect-rejection.ts";

let dir: string;
let socketPath: string;
let runner: { stop(): void } | null = null;
let fake: Server | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-runner-"));
  socketPath = join(dir, "runner.sock");
});

afterEach(() => {
  runner?.stop();
  runner = null;
  fake?.close();
  fake = null;
  rmSync(dir, { recursive: true, force: true });
});

function start(peerUid = process.getuid!(), killGraceMs?: number) {
  runner = startRunner({
    socketPath,
    serverUid: process.getuid!(),
    readPeerUid: () => peerUid,
    killGraceMs,
  });
}

// Running, and not a zombie waiting for its parent.
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

function fakeRunner(onConnection: (socket: import("net").Socket) => void) {
  fake = createServer(onConnection);
  return new Promise<void>((resolve) => fake!.listen(socketPath, resolve));
}

describe("agent runner spawn", () => {
  it("pipes stdin to stdout and reports the exit code", async () => {
    start();
    const child = new RunnerProcess(socketPath, ["sh", "-c", "cat; exit 3"]);
    void child.stdin.write("hello runner\n");
    void child.stdin.end();
    expect(await new Response(child.stdout).text()).toBe("hello runner\n");
    expect(await child.exited).toBe(3);
    expect(child.pid).toBeGreaterThan(0);
  });

  it("drains late input after the exit report until the peer closes", async () => {
    start();
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    const errors: Error[] = [];
    socket.on("error", (error) => errors.push(error));
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    const decode = createFrameDecoder();
    const controls: { type: string; code?: number }[] = [];
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decode(chunk)) {
        if (frame.type === FRAME_JSON)
          controls.push(JSON.parse(frame.payload.toString()));
      }
    });
    const ended = new Promise<void>((resolve) => socket.once("end", resolve));
    try {
      socket.write(encodeJson({ op: "spawn", argv: ["true"] }));
      await ended;
      expect(
        controls.some(
          (message) => message.type === "exit" && message.code === 0,
        ),
      ).toBe(true);
      // The peer has received EOF but still has input in flight. The runner
      // must keep its read side open until this peer closes its write side.
      const writeError = await new Promise<Error | null | undefined>(
        (resolve) => {
          socket.write(
            Buffer.concat(encodeData(FRAME_STDIN, Buffer.alloc(3_000_000))),
            resolve,
          );
        },
      );
      expect(writeError ?? null).toBeNull();
      socket.end();
      await closed;
      expect(errors).toEqual([]);
    } finally {
      socket.destroy();
      await closed;
    }
  });

  it("does not acknowledge input rejected by the dying child's pipe", async () => {
    start();
    const socket = connect(socketPath);
    socket.on("error", () => {});
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    socket.once("end", () => socket.destroy());
    const decode = createFrameDecoder();
    let output = "";
    const controls: { type: string; signal?: string }[] = [];
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decode(chunk)) {
        if (frame.type === FRAME_JSON)
          controls.push(JSON.parse(frame.payload.toString()));
        if (frame.type === FRAME_STDOUT) output += frame.payload.toString();
      }
    });
    try {
      socket.write(
        encodeJson({
          op: "spawn",
          argv: [
            "sh",
            "-c",
            "head -c 65536 >/dev/null; echo consumed; exec sleep 30",
          ],
        }),
      );
      // One frame is larger than the child's read plus its pipe capacity. Its
      // write callback stays pending until the kill makes that write fail.
      socket.write(
        Buffer.concat(encodeData(FRAME_STDIN, Buffer.alloc(1_000_000))),
      );
      expect(await waitFor(() => output === "consumed\n")).toBe(true);
      expect(controls.some((message) => message.type === "stdin-ack")).toBe(
        false,
      );
      socket.write(encodeJson({ type: "signal", signal: "SIGKILL" }));
      await closed;
      expect(
        controls.some(
          (message) => message.type === "exit" && message.signal === "SIGKILL",
        ),
      ).toBe(true);
      expect(controls.some((message) => message.type === "stdin-ack")).toBe(
        false,
      );
    } finally {
      socket.destroy();
      await closed;
    }
  });

  it("runs argv without a shell", async () => {
    start();
    const child = new RunnerProcess(socketPath, ["echo", "$HOME", "a;b"]);
    expect(await new Response(child.stdout).text()).toBe("$HOME a;b\n");
    expect(await child.exited).toBe(0);
  });

  it("reports a signal death the way a local spawn does", async () => {
    start();
    const child = new RunnerProcess(socketPath, ["sleep", "30"]);
    await waitFor(() => child.pid !== undefined);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
  });

  it("carries output larger than one frame", async () => {
    start();
    const out = new RunnerProcess(socketPath, [
      "head",
      "-c",
      "5000000",
      "/dev/zero",
    ]);
    expect((await new Response(out.stdout).arrayBuffer()).byteLength).toBe(
      5_000_000,
    );
  });

  // A grandchild that ignores SIGTERM and holds none of the pipes: only the
  // group SIGKILL after the grace period can stop it.
  const STUBBORN =
    '(trap "" TERM; exec sleep 300) </dev/null >/dev/null 2>&1 & echo $!';

  it.each(["end", "destroy"] as const)(
    "stops the whole process group when the server uses %s",
    async (close) => {
      start(process.getuid!(), 300);
      const socket = connect(socketPath);
      const decode = createFrameDecoder();
      let childPid = 0;
      let grandchildPid = 0;
      try {
        socket.on("data", (chunk: Buffer) => {
          for (const frame of decode(chunk)) {
            if (frame.type === FRAME_JSON) {
              const message = JSON.parse(frame.payload.toString());
              if (message.type === "spawned") childPid = message.pid;
            } else if (frame.type === FRAME_STDOUT)
              grandchildPid = Number(frame.payload.toString().trim());
          }
        });
        socket.write(
          encodeJson({ op: "spawn", argv: ["sh", "-c", `${STUBBORN}; wait`] }),
        );
        expect(await waitFor(() => childPid > 0 && grandchildPid > 0)).toBe(
          true,
        );
        expect([running(childPid), running(grandchildPid)]).toEqual([
          true,
          true,
        ]);
        socket[close]();
        expect(
          await waitFor(() => !running(childPid) && !running(grandchildPid)),
        ).toBe(true);
      } finally {
        socket.destroy();
        for (const pid of [childPid, grandchildPid]) {
          if (!running(pid)) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The process may have exited between the check and the signal.
          }
        }
      }
    },
  );

  it("stops what the group left behind after its leader exited", async () => {
    start(process.getuid!(), 300);
    const child = new RunnerProcess(socketPath, ["sh", "-c", STUBBORN]);
    const grandchildPid = Number(
      (await new Response(child.stdout).text()).trim(),
    );
    expect(await child.exited).toBe(0);
    expect(grandchildPid).toBeGreaterThan(0);
    expect(await waitFor(() => !running(grandchildPid))).toBe(true);
  });

  it("settles once with 127 when the program does not exist", async () => {
    start();
    const child = new RunnerProcess(socketPath, [join(dir, "missing")]);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await child.exited).toBe(127);
  });
});

describe("agent runner refusals", () => {
  it("refuses a connection from any uid but the server's", async () => {
    start(process.getuid!() + 1);
    await expectRejection(readRunnerInfo(socketPath), /./);
    const child = new RunnerProcess(socketPath, ["echo", "no"]);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await child.exited).toBe(1);
  });

  it("refuses an entry outside its fixed table and a malformed request", async () => {
    start();
    await expectRejection(
      runRunnerEntry(socketPath, "../runner", {}),
      /no such entry/,
    );
    const child = new RunnerProcess(socketPath, [""]);
    expect(await child.exited).toBe(127);
  });
});

describe("agent runner client failures", () => {
  it("settles when the socket does not exist", async () => {
    const child = new RunnerProcess(socketPath, ["echo", "x"]);
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stdout).text()).toBe("");
    await expectRejection(readRunnerInfo(socketPath), /./);
  });

  it("settles on a malformed frame, an early close and a cut-off frame", async () => {
    let mode = "garbage";
    await fakeRunner((socket) => {
      if (mode === "garbage") socket.end(Buffer.from([0, 0, 0, 0, 1]));
      else if (mode === "early") socket.end();
      else socket.end(Buffer.from([0, 0, 0, 9, FRAME_STDOUT, 65]));
    });
    for (const next of ["garbage", "early", "cut"]) {
      mode = next;
      const child = new RunnerProcess(socketPath, ["echo", "x"]);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await child.exited).toBe(1);
    }
    mode = "garbage";
    await expectRejection(
      runRunnerEntry(socketPath, "diff", {}),
      /diff failed/,
    );
  });
});

describe("agent runner identity and entries", () => {
  it("reports its own user and environment", async () => {
    start();
    const info = await readRunnerInfo(socketPath);
    expect(info.uid).toBe(process.getuid!());
    expect(info.env.PATH).toBe(process.env.PATH!);
  });

  it("reports the runner Bun executable", async () => {
    start();
    const host = await RunnerAgentHost.connect(socketPath);
    expect(host.bunPath()).toBe(process.execPath);
  });

  it("returns the same diff as the in-process code", async () => {
    start();
    const repo = join(dir, "repo");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "a.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "new.txt"), "fresh\n");
    const host = await RunnerAgentHost.connect(socketPath);
    const remote = await host.isomuxDiff({ agentCwd: repo });
    expect(remote.kind).toBe("ok");
    expect(remote).toEqual(runIsomuxDiff({ agentCwd: repo }));
    expect(await host.isomuxDiff({ agentCwd: repo, dir: "missing" })).toEqual({
      kind: "bad_dir",
      attempted: join(repo, "missing"),
    });
  });

  // Task 2008c993: in split mode the account folders are agent space, so a
  // conversation moves between accounts through the runner.
  it("moves a conversation between accounts, and a failed move rejects", async () => {
    start();
    const cwd = join(dir, "work");
    const fromRoot = join(dir, "member");
    const toRoot = join(dir, "office");
    const sid = crypto.randomUUID();
    const transcript = (root: string) =>
      join(claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: root }), `${sid}.jsonl`);
    mkdirSync(dirname(transcript(fromRoot)), { recursive: true });
    writeFileSync(transcript(fromRoot), "line\n");
    const move = {
      engine: "claude" as const,
      sessionId: sid,
      cwd,
      fromRoot,
      toRoot,
    };
    const previous = getAgentHost();
    setAgentHost(await RunnerAgentHost.connect(socketPath));
    try {
      await copySessionFilesInAgentSpace(move);
      expect(readFileSync(transcript(toRoot), "utf8")).toBe("line\n");
      expect(existsSync(transcript(fromRoot))).toBe(true);
      await removeSessionSourceInAgentSpace(move);
      expect(existsSync(transcript(fromRoot))).toBe(false);
      expect(readFileSync(transcript(toRoot), "utf8")).toBe("line\n");
      // Nothing left to copy in the member's folder.
      await expectRejection(copySessionFilesInAgentSpace(move), /./);
    } finally {
      setAgentHost(previous);
    }
  });

  it("reports each diagnostic try by its error code", async () => {
    start();
    const codeFile = join(dir, "package.json");
    writeFileSync(codeFile, "{}");
    const result = await runRunnerEntry(socketPath, "diagnose", {
      stateFile: join(dir, "absent", "users.json"),
      codeFile,
      shareRoot: dir,
    });
    // The same user may write here, so only the read is refused.
    expect(result).toEqual({
      readState: "ENOENT",
      writeCode: "ok",
      renameCode: "ok",
      createInShare: "ok",
    });
  });
});
