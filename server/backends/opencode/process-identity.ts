import { readFileSync } from "node:fs";
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
export function readProcessHop(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): ProcessHop | null {
  if (platform === "darwin") return readDarwinProcessHop(pid);
  if (platform !== "linux") return null;
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
