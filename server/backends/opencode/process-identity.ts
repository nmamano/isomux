import { readFileSync } from "node:fs";

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
