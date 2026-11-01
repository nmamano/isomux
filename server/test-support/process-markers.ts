// Process checks for the PID-namespace tests (server/process-isolation.ts): a
// test names each process it starts with a unique marker in its command line
// (bash `exec -a` or $0), then finds it from the host's /proc, where every
// namespace's processes show.
import { readFileSync, readdirSync } from "fs";

export function pidsWith(marker: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker))
        pids.push(Number(entry));
    } catch {}
  }
  return pids;
}

export function killMarked(marker: string): void {
  for (const pid of pidsWith(marker)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

// Whether bwrap on this host makes a PID namespace. Tests gate on this check,
// never on the office's probe.
export function bwrapMakesPidNamespace(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const result = Bun.spawnSync(
      [
        "bwrap",
        "--dev-bind",
        "/",
        "/",
        "--unshare-pid",
        "--proc",
        "/proc",
        "true",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function waitFor(
  check: () => boolean,
  ms = 3000,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}
