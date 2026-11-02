// Each agent session in its own PID namespace (task 8db21c8b): bubblewrap with
// the whole filesystem bound as it is and only the PID namespace new. The
// agent then sees only its own process tree in ps and /proc, so it cannot read
// another agent's environment or signal it. Effective isolation, not a
// security boundary (internal-docs/isolation-design.md, process layer).
//
// The probe runs through the host that spawns (the agent runner in split
// mode), so it tests the same user and the same bwrap as the agents.

import { readdirSync, readFileSync } from "fs";
import type { RunOptions, RunResult } from "./agent-host.ts";
import type { ProcessIsolationReason } from "../shared/types.ts";

export type { ProcessIsolationReason };

// What the probe found on this host. turned_off is the owner's switch, never a
// probe result.
export type ProcessIsolationProbe =
  | { available: true }
  | {
      available: false;
      reason: Exclude<ProcessIsolationReason, "turned_off">;
      detail: string;
    };

export type ProcessIsolationStatus =
  | { state: "on" }
  | { state: "off"; reason: ProcessIsolationReason };

// How a wrapped spawn shares its namespace: "session" is one agent session
// (Claude, Codex at danger-full-access); "shared_server" is the OpenCode
// server that all of one member's OpenCode agents on one profile share.
export type IsolationForm = "session" | "shared_server";

// The error code (in the errno-name slot) of a wrapped spawn whose bwrap
// setup failed after a passed probe.
export const ISOLATION_SETUP_FAILED = "ISOLATION_SETUP_FAILED";

export interface ProcessIsolationProbeDeps {
  platform: NodeJS.Platform;
  // The environment of the agent user (XDG_RUNTIME_DIR, PATH).
  env: Record<string, string | undefined>;
  run(argv: string[], options?: RunOptions): Promise<RunResult>;
}

// The probe runs the same wrap as an agent session and reads what the command
// sees: its own pid, the processes in /proc, whether systemctl --user works
// when it works outside, and its AppArmor label. Any failed step leaves
// isolation off, with bwrap's own message as the detail.
const APPARMOR_LABEL = "/proc/self/attr/apparmor/current";
const PROBE_SCRIPT = `echo "self=$$"; echo "pids=$(ls -d /proc/[0-9]* | wc -l)"; systemctl --user show --property=Version >/dev/null 2>&1; echo "systemctl=$?"; echo "apparmor=$(cat ${APPARMOR_LABEL} 2>/dev/null)"`;
// bwrap's init is pid 1 and the command pid 2; a few processes at most.
const MAX_PROBE_PIDS = 5;

export async function probeProcessIsolation(
  deps: ProcessIsolationProbeDeps,
): Promise<ProcessIsolationProbe> {
  if (deps.platform !== "linux")
    return {
      available: false,
      reason: "needs_linux",
      detail: "PID namespaces need Linux",
    };
  let result: RunResult;
  try {
    result = await deps.run(
      isolatedArgv(["sh", "-c", PROBE_SCRIPT], { dieWithParent: true }),
      { env: deps.env },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return {
        available: false,
        reason: "no_bwrap",
        detail: "bwrap is not installed",
      };
    return { available: false, reason: "denied", detail: String(error) };
  }
  const detail = (text: string) => ({
    available: false as const,
    reason: "denied" as const,
    detail: text,
  });
  if (result.exitCode !== 0)
    return detail(
      result.stderr.trim() || `bwrap exited with ${result.exitCode}`,
    );
  const value = (key: string) =>
    new RegExp(`^${key}=(\\d+)$`, "m").exec(result.stdout)?.[1];
  const self = value("self");
  const pids = value("pids");
  if (
    self === undefined ||
    pids === undefined ||
    Number(self) > MAX_PROBE_PIDS ||
    Number(pids) > MAX_PROBE_PIDS
  )
    return detail("bwrap ran the command without its own PID namespace");
  // Ubuntu's bwrap profile stacks bwrap's children onto the profile of any
  // program that has one, and in that stack Chrome and other browsers cannot
  // open a network socket (task ffb7007c). Nothing short of root changes it.
  const inside = /^apparmor=(.*)$/m.exec(result.stdout)?.[1]?.trim() ?? "";
  if (confining(inside) && (await apparmorLabel(deps)) !== inside)
    return {
      available: false,
      reason: "apparmor",
      detail: `AppArmor confines programs in the namespace (${inside}), which blocks network access for browsers such as Chrome`,
    };
  if (value("systemctl") !== "0" && (await systemctlWorks(deps)))
    return detail(
      "systemctl --user works outside the namespace but not inside it",
    );
  return { available: true };
}

// An AppArmor label that confines: not empty (no AppArmor), not unconfined,
// and not a profile in unconfined mode. Complain mode counts as confining.
function confining(label: string): boolean {
  return (
    label !== "" && label !== "unconfined" && !label.endsWith(" (unconfined)")
  );
}

// The label of a command outside the namespace, through the same host; empty
// when it cannot be read.
async function apparmorLabel(deps: ProcessIsolationProbeDeps): Promise<string> {
  try {
    const outside = await deps.run(["cat", APPARMOR_LABEL], { env: deps.env });
    return outside.exitCode === 0 ? outside.stdout.trim() : "";
  } catch {
    return "";
  }
}

async function systemctlWorks(
  deps: ProcessIsolationProbeDeps,
): Promise<boolean> {
  try {
    const outside = await deps.run(
      ["systemctl", "--user", "show", "--property=Version"],
      { env: deps.env, output: "ignore" },
    );
    return outside.exitCode === 0;
  } catch {
    return false;
  }
}

// The status from the probe and the owner's switch. The probe runs also when
// the switch is off, so the status line can tell the two apart. A probe that
// has not ended yet is off: spawns before it run as they did.
export function processIsolationStatus(
  probe: ProcessIsolationProbe | null,
  switchOn: boolean,
): ProcessIsolationStatus {
  if (probe !== null && !probe.available)
    return { state: "off", reason: probe.reason };
  if (!switchOn) return { state: "off", reason: "turned_off" };
  if (probe === null) return { state: "off", reason: "denied" };
  return { state: "on" };
}

export interface IsolatedArgvOptions {
  // The inner tree dies with the process that spawned bwrap. False for a
  // server that outlives the helper that started it (OpenCode).
  dieWithParent: boolean;
  // The fd bwrap writes its JSON status to. An {"exit-code": n} line comes
  // only when the command ran and exited; a failed setup writes none.
  statusFd?: number;
}

// The whole filesystem as it is and a new PID namespace with its own /proc;
// nothing else changes.
export function isolatedArgv(
  argv: string[],
  options: IsolatedArgvOptions,
): string[] {
  return [
    "bwrap",
    "--dev-bind",
    "/",
    "/",
    "--unshare-pid",
    "--proc",
    "/proc",
    ...(options.dieWithParent ? ["--die-with-parent"] : []),
    ...(options.statusFd === undefined
      ? []
      : ["--json-status-fd", String(options.statusFd)]),
    "--",
    ...argv,
  ];
}

// Whether bwrap's JSON status says the command ran and exited. Without that
// line, an outer bwrap that exited on its own failed its setup.
export function statusHasExitCode(status: string): boolean {
  return /"exit-code"\s*:/.test(status);
}

// The children of pid, over all its threads: a child belongs to the thread
// that started it.
function childrenOf(pid: number): number[] {
  const children: number[] = [];
  let tasks: string[];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return children;
  }
  for (const task of tasks) {
    try {
      for (const child of readFileSync(
        `/proc/${pid}/task/${task}/children`,
        "utf8",
      )
        .trim()
        .split(/\s+/))
        if (child) children.push(Number(child));
    } catch {}
  }
  return children;
}

// The namespace's init, as the host sees it: the outer bwrap's only child.
function namespaceInit(outerPid: number): number | null {
  return childrenOf(outerPid)[0] ?? null;
}

// The host pid of the command inside the namespace (outer bwrap -> namespace
// init -> command), or null when it is gone.
export function isolatedCommandPid(outerPid: number): number | null {
  const init = namespaceInit(outerPid);
  return init === null ? null : (childrenOf(init)[0] ?? null);
}

function signal(target: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

// Signal a wrapped child by its outer bwrap pid. A catchable signal goes to
// the command inside ("command") or to every process in the namespace but
// its init ("namespace"); bwrap itself has no handler and would die at once,
// and the namespace init ignores it. When the command is not there (not yet
// started, or gone), and for SIGKILL, the signal goes to the outer bwrap's
// process group: the init dies with it, and the kernel then ends the
// namespace. False when nothing was signalled.
export function signalIsolated(
  outerPid: number,
  sig: NodeJS.Signals,
  scope: "command" | "namespace",
): boolean {
  if (sig !== "SIGKILL") {
    const init = namespaceInit(outerPid);
    const targets =
      init === null
        ? []
        : scope === "command"
          ? childrenOf(init).slice(0, 1)
          : descendantsOf(init);
    let sent = false;
    for (const pid of targets) sent = signal(pid, sig) || sent;
    if (sent) return true;
  }
  return signal(-outerPid, sig) || signal(outerPid, sig);
}

function descendantsOf(pid: number): number[] {
  const out: number[] = [];
  const queue = childrenOf(pid);
  while (queue.length > 0) {
    const next = queue.shift()!;
    out.push(next);
    queue.push(...childrenOf(next));
  }
  return out;
}
