import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { OPENCODE_CLI_VERSION } from "./runtime.ts";
import { parseOpenCodeServerPort } from "./server-port.ts";

// Measured 2026-10-11, pinned 1.18.35, five fresh profiles per condition:
// healthy in 2.90-3.41 s alone and 12.36-20.79 s with 24 CPU workers on
// eight CPUs (load 16.6-27.4). Five loaded supervisor acquisitions took
// 12.30-30.17 s (load 26.3-33.3). Allow 60 s, nearly 2x that maximum.
export const OPENCODE_STARTUP_TIMEOUT_MS = 60_000;
export const OPENCODE_SERVER_USERNAME = "isomux";
// OpenCode never rotates its log: a start moves a log over this size to
// opencode.log.1 (start-server.ts).
export const OPENCODE_LOG_ROTATE_BYTES = 10 * 1024 * 1024;

interface StartupRuntime {
  now(): number;
  sleep(ms: number): Promise<unknown>;
  readOutput(path: string): Promise<string>;
  fetch(url: string, options: RequestInit): Promise<Response>;
}

const runtime: StartupRuntime = {
  now: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
  readOutput: (path) => readFile(path, "utf8"),
  fetch: (url, options) => fetch(url, options),
};

export async function waitHealthy(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
  stdoutPath: string,
  password: string,
  clock: StartupRuntime = runtime,
): Promise<number | null> {
  const deadline = clock.now() + OPENCODE_STARTUP_TIMEOUT_MS;
  let port: number | null = null;
  while (clock.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid)
      return null;
    try {
      // Only private child output supplies the port; it can contain provider data.
      port ??= parseOpenCodeServerPort(await clock.readOutput(stdoutPath));
      if (clock.now() >= deadline) return null;
      if (port !== null) {
        process.kill(child.pid, 0);
        const response = await clock.fetch(
          `http://127.0.0.1:${port}/global/health`,
          {
            headers: {
              authorization: `Basic ${btoa(`${OPENCODE_SERVER_USERNAME}:${password}`)}`,
            },
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(300, deadline - clock.now())),
            ),
          },
        );
        const body = (await response.json()) as {
          healthy?: boolean;
          version?: string;
        };
        if (response.ok && body.healthy) {
          // This child cannot change version while we wait.
          if (body.version !== OPENCODE_CLI_VERSION) return null;
          // A ready server is useful even if its reply crossed the deadline.
          return port;
        }
      }
    } catch {}
    const remaining = deadline - clock.now();
    if (remaining > 0) await clock.sleep(Math.min(50, remaining));
  }
  return null;
}
