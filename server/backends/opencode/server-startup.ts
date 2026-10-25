import type { ChildProcess } from "node:child_process";
import { OPENCODE_CLI_VERSION } from "./runtime.ts";

// Measured 2026-10-11, pinned 1.18.35, five fresh profiles per condition:
// healthy in 2.90-3.41 s alone and 12.36-20.79 s with 24 CPU workers on
// eight CPUs (load 16.6-27.4). Five loaded supervisor acquisitions took
// 12.30-30.17 s (load 26.3-33.3). Allow 60 s, nearly 2x that maximum.
export const OPENCODE_STARTUP_TIMEOUT_MS = 60_000;
// 2.1.4 has no user setting: the user is always opencode (gate E3).
export const OPENCODE_SERVER_USERNAME = "opencode";
// OpenCode never rotates its log: a start moves a log over this size to
// opencode.log.1 (start-server.ts).
export const OPENCODE_LOG_ROTATE_BYTES = 10 * 1024 * 1024;

export function openCodeAuthHeader(password: string): string {
  return `Basic ${btoa(`${OPENCODE_SERVER_USERNAME}:${password}`)}`;
}

interface StartupRuntime {
  now(): number;
  sleep(ms: number): Promise<unknown>;
  fetch(url: string, options: RequestInit): Promise<Response>;
}

const runtime: StartupRuntime = {
  now: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
  fetch: (url, options) => fetch(url, options),
};

// True once the child on this port answers GET /api/info with the pinned
// version (T8). 2.1.4 takes the port from start-server.ts and prints no
// address, so nothing reads its output.
export async function waitHealthy(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
  port: number,
  password: string,
  clock: StartupRuntime = runtime,
): Promise<boolean> {
  const deadline = clock.now() + OPENCODE_STARTUP_TIMEOUT_MS;
  while (clock.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid)
      return false;
    try {
      process.kill(child.pid, 0);
      const response = await clock.fetch(`http://127.0.0.1:${port}/api/info`, {
        headers: { authorization: openCodeAuthHeader(password) },
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(300, deadline - clock.now())),
        ),
      });
      const body = (await response.json()) as { version?: string };
      if (response.ok) {
        // This child cannot change version while we wait. A ready server
        // is useful even if its reply crossed the deadline.
        return body.version === OPENCODE_CLI_VERSION;
      }
    } catch {}
    const remaining = deadline - clock.now();
    if (remaining > 0) await clock.sleep(Math.min(50, remaining));
  }
  return false;
}

// R5: plain 2.1.4 serve has no port retry of its own. When another process
// took the port start-server.ts picked, the child exits 1 and its stderr has
// the runtime's bind error for that port (probe, 2026-10-25): "Failed to
// start server. Is port 45135 in use?".
export function openCodePortTaken(stderr: string, port: number): boolean {
  return stderr.includes(`Is port ${port} in use?`);
}
