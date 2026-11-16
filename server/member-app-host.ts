// The app supervisor's host for an isolated member
// (internal-docs/member-os-user-design.md, slice 3b): the same SupervisorHost
// as the office's systemd host (app-supervisor.ts), but every file and every
// systemctl or journalctl call runs as the member, through their runner.
//
// The supervisor is synchronous, so each call is one spawnSync of
// agent-runner/sync_call.py, bounded at CALL_BOUND_MS. The member controls
// their runner (same uid), so a runner that hangs could hold the office's
// event loop: a timeout, a dead socket or a reply that does not parse opens
// the member's breaker, and for BREAKER_MS every call throws at once, with
// no spawn.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppSupervisorError,
  type RunResult,
  type SupervisorHost,
} from "./app-supervisor.ts";
import type { RunnerControl, RunnerRequest } from "./agent-runner/frames.ts";

export const CALL_BOUND_MS = 5_000;
export const BREAKER_MS = 60_000;
// How long a "no systemd user manager" answer holds. A delete never reads it
// (userManager(true)).
export const USER_MANAGER_CHECK_MS = 60_000;

const SYNC_CALL = fileURLToPath(
  new URL("./agent-runner/sync_call.py", import.meta.url),
);

// The PATH the member's systemctl and journalctl run with: the system
// folders only, nothing of the office's.
const SYSTEM_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// The only programs the supervisor runs. The runner would run anything as
// the member; this is defense in depth.
const ALLOWED_PROGRAMS = new Set(["systemctl", "journalctl"]);

// One runner call's answer, or null when the transport failed (the breaker
// opens).
export type SyncReply = {
  control: RunnerControl;
  stdout: Buffer;
  stderr: Buffer;
} | null;

export type SyncCall = (
  request: RunnerRequest,
  input: Buffer | undefined,
  boundMs: number,
) => SyncReply;

export interface MemberAppHostOptions {
  userId: string;
  // The member's display name, for messages.
  memberName: string;
  uid: number;
  socketPath: string;
  home: string;
  agentRoot: string;
  // Tests: the transport, the clock and the bounds.
  call?: SyncCall;
  now?: () => number;
  boundMs?: number;
  breakerMs?: number;
}

export interface MemberAppHost extends SupervisorHost {
  readonly uid: number;
  readonly secretsDir: string;
  // Does the member have a systemd user manager? `fresh`: ask now, never
  // the held answer. Throws member_os_user when the runner cannot be asked.
  userManager(fresh: boolean): boolean;
  // Is the member's user manager provably not running: their runtime folder
  // /run/user/<uid>/systemd is absent? A running manager always has it, so
  // a failed show-environment with the folder there is a bus that failed,
  // not a manager that is down. False when the folder is there or cannot be
  // read; throws member_os_user when the runner cannot be asked.
  managerFolderAbsent(): boolean;
  // A folder (and its parents) of mode 0700, as the member.
  mkdir(path: string): void;
  // Move `path` to `to`, never onto an existing entry: an error with code
  // EEXIST, or ENOENT when `path` is not there.
  rename(path: string, to: string): void;
}

export function runnerSyncCall(socketPath: string, uid: number): SyncCall {
  return (request, input, boundMs) => {
    const result = spawnSync("python3", ["-I", "-S", SYNC_CALL], {
      input: JSON.stringify({
        socket: socketPath,
        uid,
        request,
        ...(input !== undefined ? { input: input.toString("base64") } : {}),
      }),
      encoding: "utf8",
      timeout: boundMs,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) return null;
    let parsed: {
      ok?: unknown;
      control?: RunnerControl;
      stdout?: unknown;
      stderr?: unknown;
    };
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      return null;
    }
    if (
      parsed.ok !== true ||
      typeof parsed.control !== "object" ||
      parsed.control === null ||
      typeof parsed.stdout !== "string" ||
      typeof parsed.stderr !== "string"
    )
      return null;
    return {
      control: parsed.control,
      stdout: Buffer.from(parsed.stdout, "base64"),
      stderr: Buffer.from(parsed.stderr, "base64"),
    };
  };
}

export function createMemberAppHost(
  options: MemberAppHostOptions,
): MemberAppHost {
  const call = options.call ?? runnerSyncCall(options.socketPath, options.uid);
  const now = options.now ?? (() => Date.now());
  const boundMs = options.boundMs ?? CALL_BOUND_MS;
  const breakerMs = options.breakerMs ?? BREAKER_MS;
  const notReady = () =>
    new AppSupervisorError(
      "member_os_user",
      `${options.memberName}'s own OS user is not ready`,
    );
  let openUntil = 0;
  let manager: { ok: boolean; at: number } | null = null;

  function send(
    request: RunnerRequest,
    input?: Buffer,
  ): NonNullable<SyncReply> {
    if (now() < openUntil) throw notReady();
    const answer = call(request, input, boundMs);
    if (!answer) {
      openUntil = now() + breakerMs;
      console.error(
        `[apps] the runner of ${options.memberName} could not be reached or did not answer in ${boundMs / 1000} s; their apps wait ${breakerMs / 1000} s`,
      );
      throw notReady();
    }
    return answer;
  }

  function fs(request: RunnerRequest & { op: "fs" }, input?: Buffer) {
    const answer = send(request, input);
    if (answer.control.type === "fs") return answer;
    const code =
      answer.control.type === "error" ? answer.control.code : "EPROTO";
    throw Object.assign(
      new Error(`${request.call} of ${request.path} failed: ${code}`),
      { code },
    );
  }

  const env = {
    PATH: SYSTEM_PATH,
    HOME: options.home,
    XDG_RUNTIME_DIR: `/run/user/${options.uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${options.uid}/bus`,
  };

  function run(argv: string[]): RunResult {
    if (!ALLOWED_PROGRAMS.has(argv[0] ?? ""))
      throw new AppSupervisorError(
        "supervisor_failed",
        `${argv[0]} is not a program the app supervisor runs`,
      );
    const answer = send({
      op: "spawn",
      argv,
      cwd: options.home,
      fullEnv: env,
      stderr: "pipe",
    });
    const stdout = answer.stdout.toString("utf8");
    const stderr = answer.stderr.toString("utf8");
    if (answer.control.type === "exit") {
      const code = answer.control.code ?? 1;
      return { code, stdout, stderr };
    }
    const message =
      answer.control.type === "error"
        ? `${answer.control.code} ${answer.control.message}`
        : "the runner sent no exit";
    return { code: 127, stdout: "", stderr: message };
  }

  return {
    uid: options.uid,
    unitDir: join(options.home, ".config", "systemd", "user"),
    launcherDir: join(options.agentRoot, "apps", "units"),
    secretsDir: join(options.agentRoot, "apps", "secrets"),
    writeFile(path, contents, mode) {
      fs({ op: "fs", call: "mkdir", path: dirname(path), mode: 0o700 });
      // Removed first and created with its mode: an existing file would keep
      // its old mode while the new text is written.
      fs({ op: "fs", call: "rm", path });
      fs(
        {
          op: "fs",
          call: "writeText",
          path,
          mode: mode ?? 0o644,
          exclusive: true,
        },
        Buffer.from(contents),
      );
    },
    readFile(path) {
      try {
        return fs({ op: "fs", call: "readText", path }).stdout.toString("utf8");
      } catch (error) {
        if (error instanceof AppSupervisorError) throw error;
        return null;
      }
    },
    removeFile(path) {
      fs({ op: "fs", call: "rm", path });
    },
    run,
    mkdir(path) {
      fs({ op: "fs", call: "mkdir", path, mode: 0o700 });
    },
    rename(path, to) {
      fs({ op: "fs", call: "rename", path, to });
    },
    userManager(fresh) {
      if (!fresh && manager && now() - manager.at < USER_MANAGER_CHECK_MS)
        return manager.ok;
      const result = run(["systemctl", "--user", "show-environment"]);
      manager = { ok: result.code === 0, at: now() };
      return manager.ok;
    },
    managerFolderAbsent() {
      try {
        fs({
          op: "fs",
          call: "stat",
          path: `/run/user/${options.uid}/systemd`,
        });
        return false;
      } catch (error) {
        if (error instanceof AppSupervisorError) throw error;
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
    },
  };
}
