// The processes an office leaves behind when it stops (task cdd7883d): every
// process it started carries ISOMUX_OFFICE_PID equal to the office's pid
// (server/stop-reap.ts). The host command ends them after a lockdown stops the
// unit (scripts/rescue.ts), and the lockdown route ends them when it stops the
// office, on every install: with no Isomux unit around it, nothing else would.

import { readdirSync, readFileSync } from "node:fs";
import { OFFICE_PID_ENV } from "./stop-reap.ts";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  uid: number;
  /** Empty when the environment cannot be read. */
  env: Record<string, string>;
}

/** The office processes left after the office stopped: they carry
 *  ISOMUX_OFFICE_PID equal to the office's pid and run as one of `uids`.
 *  Never `selfPid` or one of its ancestors. */
export function findLeftovers(
  procs: ProcessInfo[],
  opts: { officePid: number; uids: number[]; selfPid: number },
): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const keep = new Set<number>();
  for (let pid = opts.selfPid; pid > 0 && !keep.has(pid);) {
    keep.add(pid);
    pid = byPid.get(pid)?.ppid ?? 0;
  }
  return procs
    .filter(
      (p) =>
        !keep.has(p.pid) &&
        opts.uids.includes(p.uid) &&
        p.env[OFFICE_PID_ENV] === String(opts.officePid),
    )
    .map((p) => p.pid);
}

/** Every process this user can see, from /proc. Empty without /proc (macOS). */
export function readProcesses(): ProcessInfo[] {
  const procs: ProcessInfo[] = [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return procs;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
      const env: Record<string, string> = {};
      try {
        for (const entry of readFileSync(`/proc/${name}/environ`, "utf8").split(
          "\0",
        )) {
          const eq = entry.indexOf("=");
          if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
      } catch {
        // Another user's process: no environment.
      }
      procs.push({ pid: Number(name), ppid, uid, env });
    } catch {
      // Exited while we read it.
    }
  }
  return procs;
}

/** How long leftovers get after SIGTERM before SIGKILL. */
export const LEFTOVER_KILL_GRACE_MS = 2_000;

export interface EndLeftoversDeps {
  officePid: number;
  uids: number[];
  selfPid: number;
  processes(): ProcessInfo[];
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  sleep(ms: number): Promise<void>;
}

/** SIGTERM to every leftover, then SIGKILL to the ones still there after the
 *  grace. A kill that fails (gone, another user's) is skipped. Returns the
 *  pids of the first pass. */
export async function endLeftovers(deps: EndLeftoversDeps): Promise<number[]> {
  if (deps.officePid <= 0) return [];
  const opts = {
    officePid: deps.officePid,
    uids: deps.uids,
    selfPid: deps.selfPid,
  };
  const tryKill = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
    try {
      deps.kill(pid, signal);
    } catch {
      // Gone already, or not ours to signal.
    }
  };
  const first = findLeftovers(deps.processes(), opts);
  for (const pid of first) tryKill(pid, "SIGTERM");
  if (first.length === 0) return [];
  await deps.sleep(LEFTOVER_KILL_GRACE_MS);
  for (const pid of findLeftovers(deps.processes(), opts))
    tryKill(pid, "SIGKILL");
  return first;
}
