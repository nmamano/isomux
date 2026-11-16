// The app supervisor's host as an isolated member (member-app-host.ts,
// slice 3b of task b94dfd25) and its sync transport (sync_call.py). The
// properties:
// - a runner that does not answer costs the office one bound, then the
//   breaker answers at once, with no connect, until it closes;
// - a runner that answers, even with an error, opens no breaker;
// - only systemctl and journalctl run, with her environment only;
// - the "no user manager" answer is held, and a fresh ask never reads it;
// - the transport sends nothing to a listener of another uid, and gives a
//   real runner's answers back (files, a rename that never replaces).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSupervisorError } from "../app-supervisor.ts";
import {
  createMemberAppHost,
  runnerSyncCall,
  type SyncCall,
} from "../member-app-host.ts";
import type { RunnerRequest } from "../agent-runner/frames.ts";

const UID = 4711;
const exitReply = (code: number, stdout = "") => ({
  control: { type: "exit" as const, code, signal: null },
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
});

function host(call: SyncCall, clock = { t: 0 }) {
  return createMemberAppHost({
    userId: "u-alice",
    memberName: "Alice",
    uid: UID,
    socketPath: "/nowhere.sock",
    home: "/home/isomux-alice",
    agentRoot: "/home/isomux-alice/.isomux-agent",
    call,
    now: () => clock.t,
  });
}

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof AppSupervisorError ? error.code : "other";
  }
};

describe("the breaker of a member's host", () => {
  // MUTANT: send() without the openUntil check (dies on the call count).
  it("answers at once for 60 s after a call that got no answer, then asks once", () => {
    let calls = 0;
    let answer = false;
    const clock = { t: 1_000 };
    const h = host(() => {
      calls++;
      return answer ? exitReply(0) : null;
    }, clock);
    expect(codeOf(() => h.run(["systemctl", "--user", "daemon-reload"]))).toBe(
      "member_os_user",
    );
    clock.t += 59_000;
    expect([
      codeOf(() => h.run(["systemctl", "--user", "daemon-reload"])),
      codeOf(() => h.readFile("/home/isomux-alice/x")),
      calls,
    ]).toEqual(["member_os_user", "member_os_user", 1]);
    answer = true;
    clock.t += 2_000;
    expect([
      h.run(["systemctl", "--user", "daemon-reload"]).code,
      calls,
    ]).toEqual([0, 2]);
  });

  // MUTANT: a runner error opens the breaker (dies on the second call).
  it("stays closed when the runner answers with an error", () => {
    let calls = 0;
    const h = host(() => {
      calls++;
      return {
        control: { type: "error", code: "EACCES", message: "denied" },
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    });
    expect(h.readFile("/home/isomux-alice/x")).toBeNull();
    expect(h.readFile("/home/isomux-alice/y")).toBeNull();
    expect(calls).toBe(2);
  });
});

describe("what a member's host runs", () => {
  it("runs systemctl and journalctl only, as her, with her environment only", () => {
    const seen: RunnerRequest[] = [];
    const h = host((request) => {
      seen.push(request);
      return exitReply(0);
    });
    h.run(["systemctl", "--user", "daemon-reload"]);
    h.run(["journalctl", "--user", "-u", "x"]);
    expect(codeOf(() => h.run(["sh", "-c", "id"]))).toBe("supervisor_failed");
    expect(
      seen.map((r) =>
        r.op === "spawn"
          ? [r.argv[0], Object.keys(r.fullEnv ?? {}).sort(), r.env]
          : r.op,
      ),
    ).toEqual([
      [
        "systemctl",
        ["DBUS_SESSION_BUS_ADDRESS", "HOME", "PATH", "XDG_RUNTIME_DIR"],
        undefined,
      ],
      [
        "journalctl",
        ["DBUS_SESSION_BUS_ADDRESS", "HOME", "PATH", "XDG_RUNTIME_DIR"],
        undefined,
      ],
    ]);
    const env = (seen[0] as { fullEnv: Record<string, string> }).fullEnv;
    expect([env.XDG_RUNTIME_DIR, env.DBUS_SESSION_BUS_ADDRESS]).toEqual([
      `/run/user/${UID}`,
      `unix:path=/run/user/${UID}/bus`,
    ]);
    expect(
      env.PATH.split(":").every(
        (dir) => !dir.includes(process.env.HOME ?? "\0"),
      ),
    ).toBe(true);
  });

  // MUTANT: userManager(true) reads the held answer (dies on the count).
  it("holds the answer about her user manager, and a fresh ask never reads it", () => {
    let asks = 0;
    let up = false;
    const clock = { t: 0 };
    const h = host((request) => {
      if (request.op === "spawn" && request.argv[2] === "show-environment") {
        asks++;
        return exitReply(up ? 0 : 1);
      }
      return exitReply(0);
    }, clock);
    expect(h.userManager(false)).toBe(false);
    up = true;
    expect([h.userManager(false), asks]).toEqual([false, 1]);
    expect([h.userManager(true), asks]).toEqual([true, 2]);
    up = false;
    clock.t += 61_000;
    expect([h.userManager(false), asks]).toEqual([false, 3]);
  });
});

// A real runner in its own process (the transport blocks this one), run as
// this user, and a listener that accepts and never answers.
describe("the sync transport", () => {
  let dir = "";
  let child: ChildProcess | null = null;
  let silent: Server | null = null;
  const socket = () => join(dir, "runner.sock");
  const silentSocket = () => join(dir, "silent.sock");

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "member-app-host-"));
    const script = join(dir, "start.ts");
    writeFileSync(
      script,
      `import { startRunner } from ${JSON.stringify(join(import.meta.dir, "..", "agent-runner", "runner.ts"))};\nstartRunner({ socketPath: ${JSON.stringify(socket())}, serverUid: process.getuid() });\n`,
    );
    child = spawn(process.execPath, [script], { stdio: "ignore" });
    for (let i = 0; i < 200 && !existsSync(socket()); i++)
      await new Promise((r) => setTimeout(r, 25));
    silent = createServer(() => {});
    await new Promise<void>((r) => silent!.listen(silentSocket(), r));
  });
  afterAll(() => {
    child?.kill("SIGKILL");
    silent?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const me = () => process.getuid!();

  it("gives a real runner's file answers back, and a rename never replaces", () => {
    const call = runnerSyncCall(socket(), me());
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    const wrote = call(
      { op: "fs", call: "writeText", path: a, mode: 0o600, exclusive: true },
      Buffer.from("hello"),
      5_000,
    );
    expect(wrote?.control.type).toBe("fs");
    const read = call(
      { op: "fs", call: "readText", path: a },
      undefined,
      5_000,
    );
    expect(read?.stdout.toString()).toBe("hello");
    writeFileSync(b, "keep");
    const onto = call(
      { op: "fs", call: "rename", path: a, to: b },
      undefined,
      5_000,
    );
    expect([
      onto?.control.type === "error" ? onto.control.code : onto?.control.type,
      readFileSync(b, "utf8"),
      existsSync(a),
    ]).toEqual(["EEXIST", "keep", true]);
    // A folder there, so the ".." path would resolve without the check.
    mkdirSync(join(dir, "x"));
    const up = call(
      // Not join(): it would take the ".." out.
      { op: "fs", call: "rename", path: a, to: `${dir}/x/../c.txt` },
      undefined,
      5_000,
    );
    expect([up?.control.type, existsSync(a)]).toEqual(["error", true]);
    const moved = call(
      { op: "fs", call: "rename", path: a, to: join(dir, "c.txt") },
      undefined,
      5_000,
    );
    expect([
      moved?.control.type,
      readFileSync(join(dir, "c.txt"), "utf8"),
    ]).toEqual(["fs", "hello"]);
  });

  it("runs a program with exactly the environment it is given", () => {
    const call = runnerSyncCall(socket(), me());
    const r = call(
      {
        op: "spawn",
        argv: ["/usr/bin/env"],
        fullEnv: { ONLY: "this" },
        stderr: "pipe",
      },
      undefined,
      5_000,
    );
    expect([r?.control, r?.stdout.toString().trim()]).toEqual([
      { type: "exit", code: 0, signal: null },
      "ONLY=this",
    ]);
  });

  // MUTANT: no SO_PEERCRED check in sync_call.py (dies on a reply).
  it("sends nothing to a listener of another uid", () => {
    const call = runnerSyncCall(socket(), me() + 1);
    expect(
      call(
        { op: "fs", call: "readText", path: join(dir, "c.txt") },
        undefined,
        5_000,
      ),
    ).toBeNull();
  });

  it("gives up on a listener that never answers within its bound", () => {
    const call = runnerSyncCall(silentSocket(), me());
    const begin = Date.now();
    const r = call(
      { op: "fs", call: "readText", path: "/x" },
      undefined,
      1_000,
    );
    const took = Date.now() - begin;
    expect([r, took >= 900, took < 3_000]).toEqual([null, true, true]);
  });

  it("gives null for a socket that is not there", () => {
    const call = runnerSyncCall(join(dir, "none.sock"), me());
    expect(
      call({ op: "fs", call: "readText", path: "/x" }, undefined, 5_000),
    ).toBeNull();
  });
});
