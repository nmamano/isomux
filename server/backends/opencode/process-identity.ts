import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readDarwinProcessHop } from "./darwin-libsystem.ts";

export function parseLinuxProcessStartTicks(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fieldsFromState = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const startTicks = fieldsFromState[19];
  return startTicks && /^\d+$/.test(startTicks) ? startTicks : null;
}

export function parseLinuxProcessState(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  return (
    stat
      .slice(close + 1)
      .trim()
      .split(/\s+/)[0] ?? null
  );
}

export function readLinuxProcessStartTicks(pid: number): string | null {
  try {
    return parseLinuxProcessStartTicks(
      readFileSync(`/proc/${pid}/stat`, "utf8"),
    );
  } catch {
    return null;
  }
}

export function linuxProcessIdentityMatches(
  pid: number,
  startTicks: string | undefined,
): boolean {
  return Boolean(startTicks) && readLinuxProcessStartTicks(pid) === startTicks;
}

export interface ProcessHop {
  pid: number;
  parentPid: number;
  startTicks: string;
}

export function parseLinuxProcessHop(
  pid: number,
  stat: string,
): ProcessHop | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const parentPid = Number(fields[1]);
  const startTicks = fields[19];
  if (
    !Number.isSafeInteger(parentPid) ||
    !startTicks ||
    !/^\d+$/.test(startTicks)
  )
    return null;
  return { pid, parentPid, startTicks };
}

// The pid, parent and start identity of a live process, or null when any of
// them cannot be read. startTicks is opaque: kernel start ticks on Linux, the
// microsecond start time on macOS. Other hosts always get null.
export function readProcessHop(pid: number): ProcessHop | null {
  if (process.platform === "darwin") return readDarwinProcessHop(pid);
  if (process.platform !== "linux") return null;
  try {
    return parseLinuxProcessHop(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

export function readProcessStartTicks(pid: number): string | null {
  if (process.platform === "linux") return readLinuxProcessStartTicks(pid);
  return readProcessHop(pid)?.startTicks ?? null;
}

export function processIdentityMatches(
  pid: number,
  startTicks: string | undefined,
): boolean {
  if (process.platform === "linux")
    return linuxProcessIdentityMatches(pid, startTicks);
  return Boolean(startTicks) && readProcessStartTicks(pid) === startTicks;
}

// False for an exited or zombie process. macOS never reports a zombie through
// PROC_PIDTBSDINFO, so a zombie reads as exited there.
export function processIsRunning(pid: number): boolean {
  if (process.platform !== "linux") return readProcessHop(pid) !== null;
  try {
    return (
      parseLinuxProcessState(readFileSync(`/proc/${pid}/stat`, "utf8")) !== "Z"
    );
  } catch {
    return false;
  }
}

// One row per line of `ps -A -o pid=,ppid=`; a blank or malformed line is
// skipped.
export function parsePsParentTable(
  text: string,
): { pid: number; parentPid: number }[] {
  const rows: { pid: number; parentPid: number }[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match)
      rows.push({ pid: Number(match[1]), parentPid: Number(match[2]) });
  }
  return rows;
}

// Every live process below pid, by parent, whatever its process group (2.1.4
// starts each shell tool as its own group leader, core/src/shell.ts:315).
// The root is not included. A process whose identity cannot be read is left
// out, and so is everything below it. Never throws: a host where the table
// cannot be read gets [].
export function processDescendants(pid: number): ProcessHop[] {
  try {
    const children = new Map<number, ProcessHop[]>();
    for (const hop of processTable()) {
      const siblings = children.get(hop.parentPid) ?? [];
      siblings.push(hop);
      children.set(hop.parentPid, siblings);
    }
    const found: ProcessHop[] = [];
    const queue = [pid];
    const seen = new Set(queue);
    while (queue.length > 0) {
      for (const hop of children.get(queue.shift()!) ?? []) {
        if (seen.has(hop.pid)) continue;
        seen.add(hop.pid);
        found.push(hop);
        queue.push(hop.pid);
      }
    }
    return found;
  } catch {
    return [];
  }
}

function processTable(): ProcessHop[] {
  if (process.platform === "linux") {
    const hops: ProcessHop[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      let stat: string;
      try {
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        continue;
      }
      const hop = parseLinuxProcessHop(pid, stat);
      if (hop) hops.push(hop);
    }
    return hops;
  }
  if (process.platform !== "darwin") return [];
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (ps.status !== 0 || typeof ps.stdout !== "string") return [];
  // ps lists the processes; libsystem gives each one's start identity, and
  // its parent as of that later read.
  return parsePsParentTable(ps.stdout).flatMap((row) => {
    const hop = readDarwinProcessHop(row.pid);
    return hop ? [hop] : [];
  });
}
