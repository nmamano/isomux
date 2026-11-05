// Ending what outlives the office's stop (task 44f7b101).
//
// systemd stops the unit with SIGTERM to every process in its control group,
// then waits for the group to empty before it starts again. A process that
// ignores SIGTERM (a shell loop with `trap '' TERM` passes the ignore on to
// every child it starts) holds the restart until systemd's stop timeout, 90 s
// by default, and only then gets SIGKILL. The office therefore waits a short
// grace after the signal and SIGKILLs whatever is still in its own group.
//
// Only the unit's own office may do this. Every agent shell inherits the
// server's systemd variables and sits in the same group, so a scratch office
// an agent starts there would end the live office's agents. Two independent
// guards stop that: the ancestor walk (an office nested in another office's
// tree passes a process named `isomux` on the way up) and the inherited
// ISOMUX_OFFICE_PID marker. The walk works even under an office that predates
// the marker.
//
// The unit must also be an Isomux one (isomux.service, or a name that starts
// with isomux-). An office started under another service (a CI runner, a
// process supervisor) inherits that service's systemd variables and group,
// and would end all of it: on GitHub Actions, a test that stopped a real
// office ended the runner's job.

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { OFFICE_PROCESS_NAME } from "./process-name.ts";
import { setStopFinalStep } from "./server-stop.ts";

/** Set by the office for every process it starts: "an office is above you". */
export const OFFICE_PID_ENV = "ISOMUX_OFFICE_PID";

// install.sh and the self-hosting docs name the office's unit isomux.service.
const OFFICE_UNIT = /^isomux(-[^/]*)?\.service$/;

/** How long after the stop signal leftovers get before SIGKILL. */
export const STOP_REAP_GRACE_MS = 5_000;

// How long the kill passes go on after the deadline: a loop can fork between
// a read and a kill, and a process we may not kill must not hold the stop.
const KILL_WINDOW_MS = 1_000;
// Longest ancestor walk; a deeper tree is not the unit's office.
const MAX_WALK = 64;

export interface ProcInfo {
  ppid: number;
  comm: string;
}

export interface StopReapTarget {
  // The cgroup directory under /sys/fs/cgroup to reap.
  dir: string;
  // This process and every ancestor up to the unit's exec pid: never killed.
  keep: number[];
}

/**
 * The cgroup this process must reap at its stop, or null when it must not.
 * `procSelfCgroup` is the text of /proc/self/cgroup.
 *
 * Armed only when systemd started this tree as a service (SYSTEMD_EXEC_PID),
 * this process is in that service's own cgroup v2 group, the service is an
 * Isomux unit, no office marked the environment, and the walk up from this
 * process reaches the exec pid without passing another office.
 */
export function stopReapCgroup(
  env: Record<string, string | undefined>,
  pid: number,
  procSelfCgroup: string,
  readProc: (pid: number) => ProcInfo | null,
): StopReapTarget | null {
  if (env[OFFICE_PID_ENV]) return null;
  const execPid = Number(env.SYSTEMD_EXEC_PID);
  if (!Number.isInteger(execPid) || execPid <= 1) return null;
  const line = procSelfCgroup.split("\n").find((l) => l.startsWith("0::"));
  if (!line) return null;
  const path = line.slice("0::".length).trim();
  if (!OFFICE_UNIT.test(path.split("/").pop() ?? "")) return null;

  const keep = [pid];
  let current = pid;
  while (current !== execPid) {
    if (keep.length > MAX_WALK) return null;
    const parent = readProc(current)?.ppid ?? 0;
    if (parent <= 1 || keep.includes(parent)) return null;
    const info = readProc(parent);
    if (!info || info.comm === OFFICE_PROCESS_NAME) return null;
    keep.push(parent);
    current = parent;
  }
  return { dir: `/sys/fs/cgroup${path}`, keep };
}

/** Mark this process as an office for everything it starts from now on. */
export function markOfficeProcess(
  env: Record<string, string | undefined> = process.env,
  pid: number = process.pid,
): void {
  env[OFFICE_PID_ENV] = String(pid);
}

/** /proc/<pid>/stat and /proc/<pid>/comm, or null when the pid is gone. */
export function readProcInfo(pid: number): ProcInfo | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field is in parentheses and may hold ") ": read after the last.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return Number.isInteger(ppid) ? { ppid, comm } : null;
  } catch {
    return null;
  }
}

export interface ReapDeps {
  // Epoch ms after which leftovers get SIGKILL.
  deadline: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  // Every pid in `dir` and its sub-cgroups.
  readProcs: (dir: string) => number[];
  kill: (pid: number, signal: NodeJS.Signals) => void;
  comm: (pid: number) => string | null;
  log: (line: string) => void;
}

function readCgroupProcs(dir: string): number[] {
  const pids = readFileSync(join(dir, "cgroup.procs"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map(Number);
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory())
      pids.push(...readCgroupProcs(join(dir, entry.name)));
  return pids;
}

function readComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Wait until every pid in `dir` is in `keep` or the deadline passes, then
 * SIGKILL every other pid until none is left. Never throws. Resolves to the
 * pids it killed.
 */
export async function reapLeftovers(
  dir: string,
  keep: number[],
  deps: Partial<ReapDeps> & { deadline: number },
): Promise<number[]> {
  const {
    deadline,
    now = Date.now,
    sleep = (ms: number) => Bun.sleep(ms),
    pollMs = 100,
    readProcs = readCgroupProcs,
    kill = (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
    comm = readComm,
    log = (line: string) => console.log(line),
  } = deps;
  const killed = new Map<number, string | null>();
  const refused = new Set<number>();
  const leftovers = (): number[] | null => {
    try {
      return readProcs(dir).filter(
        (pid) => !keep.includes(pid) && !refused.has(pid),
      );
    } catch (err) {
      log(
        `[server-stop] could not read the process list of ${dir}: ${String(err)}`,
      );
      return null;
    }
  };

  try {
    // The grace: processes that end by the stop signal leave on their own.
    for (;;) {
      const left = leftovers();
      if (!left || left.length === 0) return [];
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining));
    }

    // Then SIGKILL, pass after pass, until nothing is left or the window ends.
    const windowEnd = now() + KILL_WINDOW_MS;
    for (;;) {
      const left = leftovers();
      if (!left || left.length === 0) break;
      for (const pid of left) {
        // Read the name first: it is gone once the process is.
        const name = killed.has(pid) ? killed.get(pid)! : comm(pid);
        try {
          kill(pid, "SIGKILL");
          killed.set(pid, name);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "ESRCH") continue;
          refused.add(pid);
          log(
            `[server-stop] could not end process ${pid} (${name ?? "unknown"}) after the stop: ${code ?? String(err)}`,
          );
        }
      }
      if (now() >= windowEnd) break;
      await sleep(Math.min(pollMs, 20));
    }
  } catch (err) {
    log(
      `[server-stop] could not end the processes left after the stop: ${String(err)}`,
    );
  }

  if (killed.size > 0) {
    const list = [...killed]
      .map(([pid, name]) => `${pid} (${name ?? "unknown"})`)
      .join(", ");
    const count = killed.size === 1 ? "1 process" : `${killed.size} processes`;
    log(
      `[server-stop] ended ${count} that were still running after the stop signal: ${list}`,
    );
  }
  return [...killed.keys()];
}

/**
 * At the office's entry: reap the unit's cgroup at the stop when this process
 * is the unit's own office, then mark the environment so no office started
 * below ever does.
 */
export function armStopReap(): void {
  let target: StopReapTarget | null = null;
  try {
    target = stopReapCgroup(
      process.env,
      process.pid,
      readFileSync("/proc/self/cgroup", "utf8"),
      readProcInfo,
    );
  } catch {
    // No /proc/self/cgroup (not Linux): nothing to reap.
  }
  markOfficeProcess();
  if (!target) return;
  const { dir, keep } = target;
  setStopFinalStep((signalAt) =>
    reapLeftovers(dir, keep, { deadline: signalAt + STOP_REAP_GRACE_MS }),
  );
}
