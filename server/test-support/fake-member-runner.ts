// A stand-in for an isolated member's runner, as the app supervisor's sync
// transport sees it (member-app-host.ts SyncCall): the runner's file calls
// on an in-memory file system, and a model of the member's systemd user
// manager behind `systemctl --user` and `journalctl --user`. Nothing runs
// and nothing touches the box: the suite never reaches a real user manager.
//
// The manager model keeps what the supervisor's proofs read: a unit's
// LoadState comes from its file in the member's unit folder, its
// ActiveState from the last start or stop, `enable` writes the
// default.target.wants link where systemd writes it, and a manager that is
// up has its runtime folder /run/user/<uid>/systemd. Test-support only;
// never imported by a production path.
import { dirname, join } from "node:path";
import type { RunnerRequest } from "../agent-runner/frames.ts";
import {
  createMemberAppHost,
  type SyncCall,
  type SyncReply,
} from "../member-app-host.ts";
import { createFakeAppSupervisor } from "./fake-app-supervisor.ts";

type Node = { kind: "dir" } | { kind: "file"; text: string; mode: number };

export interface FakeMemberRunner {
  call: SyncCall;
  // Every request, in order.
  requests: RunnerRequest[];
  // path -> node. Folders are made by mkdir; a writeText needs its folder.
  fs: Map<string, Node>;
  units: Map<string, "active" | "inactive" | "deactivating" | "failed">;
  // The member's user manager: up (show-environment answers and the
  // runtime folder is there), down (neither), or busFails (the runtime
  // folder is there, but the bus does not answer).
  manager: "up" | "down" | "busFails";
  // Set: the next calls answer nothing (a transport failure: the breaker).
  hung: boolean;
  // A stop leaves the unit deactivating for this many show calls.
  slowStopShows: number;
  // The runner's "info" answer (its uid, user and home).
  info: { uid: number; user: string; home: string };
  // path -> errno: a stat of that path fails with it.
  statErrors: Map<string, string>;
  // The files of the member's host that name `appName` (unit, link,
  // launcher, token, secrets): what a full teardown removes.
  appFiles(appName: string): string[];
  setManager(state: "up" | "down" | "busFails"): void;
}

export function createFakeMemberRunner(opts: {
  uid: number;
  home: string;
  agentRoot: string;
  user?: string;
}): FakeMemberRunner {
  const fs = new Map<string, Node>();
  const units = new Map<
    string,
    "active" | "inactive" | "deactivating" | "failed"
  >();
  const requests: RunnerRequest[] = [];
  const unitDir = join(opts.home, ".config", "systemd", "user");
  const wantsDir = join(unitDir, "default.target.wants");
  const runtimeDir = `/run/user/${opts.uid}/systemd`;
  let stopping = new Map<string, number>();

  const mkdirs = (path: string) => {
    let at = path;
    const made: string[] = [];
    while (at !== "/" && !fs.has(at)) {
      made.push(at);
      at = dirname(at);
    }
    for (const p of made) fs.set(p, { kind: "dir" });
  };
  mkdirs(opts.home);

  const runner: FakeMemberRunner = {
    call: () => null,
    requests,
    fs,
    units,
    manager: "up",
    hung: false,
    slowStopShows: 0,
    info: { uid: opts.uid, user: opts.user ?? "isomux-alice", home: opts.home },
    statErrors: new Map(),
    appFiles(appName) {
      return [...fs.entries()]
        .filter(([path, node]) => {
          const base = path.slice(path.lastIndexOf("/") + 1);
          return (
            node.kind === "file" &&
            (base.startsWith(`${appName}.`) ||
              base.endsWith(`-${appName}.service`))
          );
        })
        .map(([path]) => path)
        .sort();
    },
    setManager(state) {
      runner.manager = state;
      if (state === "down") {
        fs.delete(runtimeDir);
        for (const unit of units.keys()) units.set(unit, "inactive");
      } else mkdirs(runtimeDir);
    },
  };
  runner.setManager("up");

  const done = (
    control: NonNullable<SyncReply>["control"],
    stdout = "",
    stderr = "",
  ): SyncReply => ({
    control,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  });
  const fsOk = (stat?: unknown) =>
    done({ type: "fs", ...(stat !== undefined ? { stat } : {}) });
  const fsErr = (code: string) => done({ type: "error", code, message: code });
  const exit = (code: number, stdout = "", stderr = "") =>
    done({ type: "exit", code, signal: null }, stdout, stderr);

  function fsCall(request: RunnerRequest & { op: "fs" }, input?: Buffer) {
    const node = fs.get(request.path);
    switch (request.call) {
      case "mkdir":
        mkdirs(request.path);
        return fsOk();
      case "rm":
        for (const path of [...fs.keys()])
          if (path === request.path || path.startsWith(`${request.path}/`))
            fs.delete(path);
        return fsOk();
      case "writeText":
        if (fs.get(dirname(request.path))?.kind !== "dir")
          return fsErr("ENOENT");
        if (request.exclusive && node) return fsErr("EEXIST");
        fs.set(request.path, {
          kind: "file",
          text: (input ?? Buffer.alloc(0)).toString("utf8"),
          mode: request.mode,
        });
        return fsOk();
      case "readText":
        if (!node) return fsErr("ENOENT");
        if (node.kind === "dir") return fsErr("EISDIR");
        return done({ type: "fs" }, node.text);
      case "stat": {
        const failed = runner.statErrors.get(request.path);
        if (failed) return fsErr(failed);
        if (!node) return fsErr("ENOENT");
        return fsOk({
          type: node.kind === "dir" ? "directory" : "file",
          isDirectory: node.kind === "dir",
          isFile: node.kind === "file",
          mode: node.kind === "file" ? node.mode : 0o700,
          size: node.kind === "file" ? node.text.length : 0,
          mtimeMs: 0,
          uid: opts.uid,
        });
      }
      case "exists":
        return done({ type: "fs", value: node !== undefined });
      case "enter":
        if (!node) return fsErr("ENOENT");
        return node.kind === "dir" ? fsOk() : fsErr("ENOTDIR");
      case "realpath":
        if (!node) return fsErr("ENOENT");
        return done({ type: "fs" }, request.path);
      case "rename": {
        if (!node) return fsErr("ENOENT");
        if (fs.has(request.to)) return fsErr("EEXIST");
        for (const [path, value] of [...fs.entries()])
          if (path === request.path || path.startsWith(`${request.path}/`)) {
            fs.delete(path);
            fs.set(request.to + path.slice(request.path.length), value);
          }
        return fsOk();
      }
      default:
        return fsErr("ENOSYS");
    }
  }

  const showBlock = (unit: string) => {
    const loaded = fs.get(join(unitDir, unit))?.kind === "file";
    let active = units.get(unit) ?? "inactive";
    const left = stopping.get(unit);
    if (left !== undefined) {
      if (left > 0) {
        stopping.set(unit, left - 1);
        active = "deactivating";
      } else {
        stopping.delete(unit);
        units.set(unit, "inactive");
        active = "inactive";
      }
    }
    return `Id=${unit}\nLoadState=${loaded ? "loaded" : "not-found"}\nActiveState=${loaded ? active : "inactive"}\nSubState=x\nNRestarts=0\n`;
  };

  function systemctl(args: string[]): SyncReply {
    if (args[0] !== "--user") return exit(1, "", "system manager: refused");
    if (runner.manager !== "up")
      return exit(1, "", "Failed to connect to bus: No such file or directory");
    const verb = args[1];
    const rest = args.slice(2).filter((a) => !a.startsWith("--"));
    const unit = rest[0] ?? "";
    const unitFile = join(unitDir, unit);
    switch (verb) {
      case "show-environment":
        return exit(0, `HOME=${opts.home}\n`);
      case "daemon-reload":
      case "reset-failed":
        return exit(0);
      case "enable":
        if (fs.get(unitFile)?.kind !== "file")
          return exit(1, "", `Unit ${unit} not found.`);
        mkdirs(wantsDir);
        fs.set(join(wantsDir, unit), {
          kind: "file",
          text: unitFile,
          mode: 0o777,
        });
        return exit(0);
      case "disable":
        fs.delete(join(wantsDir, unit));
        return exit(0);
      case "start":
      case "restart":
        if (fs.get(unitFile)?.kind !== "file")
          return exit(
            5,
            "",
            `Failed to start ${unit}: Unit ${unit} not found.`,
          );
        stopping.delete(unit);
        units.set(unit, "active");
        return exit(0);
      case "stop":
        if (runner.slowStopShows > 0 && units.get(unit) === "active")
          stopping.set(unit, runner.slowStopShows);
        else units.set(unit, "inactive");
        return exit(0);
      case "show":
        return exit(0, rest.map(showBlock).join("\n"));
      default:
        return exit(0);
    }
  }

  runner.call = (request, input) => {
    requests.push(request);
    if (runner.hung) return null;
    if (request.op === "fs") return fsCall(request, input);
    if (request.op === "info")
      return done({
        type: "info",
        ...runner.info,
        gid: runner.info.uid,
        env: {},
        bundleHash: null,
      });
    if (request.op === "spawn") {
      const [program, ...args] = request.argv;
      if (program === "systemctl") return systemctl(args);
      if (program === "journalctl")
        return runner.manager === "up"
          ? exit(0, "line one\nline two\n")
          : exit(1, "", "No journal files were found.");
      return done({ type: "error", code: "ENOENT", message: "not found" });
    }
    return done({ type: "error", code: "EPROTO", message: "unexpected" });
  };
  stopping = new Map();
  return runner;
}

// The harness's member app supervisor (StartServerOpts.memberAppSupervisor):
// the production host (createMemberAppHost) on a fake runner, and the fake
// app supervisor, so a test office never reaches a member's runner or a
// user manager. `uid` overrides the uid the host says runs the app.
export function fakeMemberAppSupervisor(opts: { uid?: number } = {}) {
  return (
    userId: string,
    target: {
      uid: number;
      socketPath: string;
      home: string;
      agentRoot: string;
    },
  ) => {
    const runner = createFakeMemberRunner({
      uid: target.uid,
      home: target.home,
      agentRoot: target.agentRoot,
    });
    const host = createMemberAppHost({
      userId,
      memberName: userId,
      uid: opts.uid ?? target.uid,
      socketPath: target.socketPath,
      home: target.home,
      agentRoot: target.agentRoot,
      call: runner.call,
    });
    return { host, supervisor: createFakeAppSupervisor() };
  };
}
