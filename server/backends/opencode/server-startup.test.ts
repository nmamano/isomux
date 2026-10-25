import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { OPENCODE_CLI_VERSION } from "./runtime.ts";
import {
  OPENCODE_STARTUP_TIMEOUT_MS,
  openCodePortTaken,
  waitHealthy,
} from "./server-startup.ts";

const HEALTH_FETCH_MS = 300;
const PORT = 43210;

// healthyAt: when the child starts to answer health. 2.1.4 gets its port
// from start-server.ts (T8), so the wait reads no output.
function fixture(healthyAt = Infinity, version = OPENCODE_CLI_VERSION) {
  let elapsed = 0;
  let requests = 0;
  const child: {
    -readonly [K in "pid" | "exitCode" | "signalCode"]: ChildProcess[K];
  } = {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
  };
  return {
    child,
    elapsed: () => elapsed,
    requests: () => requests,
    runtime: {
      now: () => elapsed,
      sleep: async (ms: number) => {
        elapsed += ms;
      },
      fetch: async (url: string, options: RequestInit) => {
        requests++;
        elapsed += HEALTH_FETCH_MS;
        // T8: health is GET /api/info; E3: the user is always opencode.
        expect(url).toBe(`http://127.0.0.1:${PORT}/api/info`);
        expect(new Headers(options.headers).get("authorization")).toBe(
          `Basic ${btoa("opencode:fixture")}`,
        );
        if (elapsed - HEALTH_FETCH_MS < healthyAt)
          throw new TypeError("Unable to connect.");
        // ServerInfo has no "healthy" field.
        return Response.json({ version, pid: process.pid });
      },
    },
  };
}

describe("OpenCode startup deadline", () => {
  it("starts an alive child that answers after the old attempt budget", async () => {
    const f = fixture(9_000);
    expect(
      await waitHealthy(f.child, PORT, "fixture", f.runtime),
      "a live child still starting after eight seconds gets its startup deadline",
    ).toBe(true);
    expect(f.requests()).toBeGreaterThan(1);
  });

  it("rejects a healthy wrong-version child without using the remaining deadline", async () => {
    const f = fixture(0, "wrong-version");
    expect(await waitHealthy(f.child, PORT, "fixture", f.runtime)).toBe(false);
    expect(
      f.elapsed(),
      "a healthy wrong version cannot improve by waiting",
    ).toBe(HEALTH_FETCH_MS);
    expect(f.requests()).toBe(1);
  });

  it("accepts a healthy reply that crosses the deadline", async () => {
    const f = fixture(0);
    const fetch = f.runtime.fetch;
    // The first request answers 100 ms after the deadline.
    f.runtime.fetch = async (url, options) => {
      await f.runtime.sleep(
        OPENCODE_STARTUP_TIMEOUT_MS + 100 - HEALTH_FETCH_MS,
      );
      return fetch(url, options);
    };
    expect(await waitHealthy(f.child, PORT, "fixture", f.runtime)).toBe(true);
    expect(f.elapsed()).toBe(OPENCODE_STARTUP_TIMEOUT_MS + 100);
    expect(f.requests()).toBe(1);
  });

  it.each(["exit", "signal"] as const)(
    "fails immediately when the child reports %s",
    async (kind) => {
      const f = fixture();
      const sleep = f.runtime.sleep;
      f.runtime.sleep = async (ms) => {
        await sleep(ms);
        if (kind === "exit") f.child.exitCode = 1;
        else f.child.signalCode = "SIGTERM";
      };
      expect(await waitHealthy(f.child, PORT, "fixture", f.runtime)).toBe(
        false,
      );
      expect(
        f.requests(),
        "an exited child does not use the remaining startup budget",
      ).toBe(1);
    },
  );

  it("bounds a live child that never answers by elapsed time", async () => {
    const f = fixture();
    expect(await waitHealthy(f.child, PORT, "fixture", f.runtime)).toBe(false);
    expect(
      f.elapsed(),
      "health requests count against the wall-clock deadline",
    ).toBeGreaterThanOrEqual(OPENCODE_STARTUP_TIMEOUT_MS);
    expect(f.elapsed()).toBeLessThan(
      OPENCODE_STARTUP_TIMEOUT_MS + 2 * HEALTH_FETCH_MS,
    );
  });
});

// R5: the stderr of a 2.1.4 serve whose port another process held (probe
// p11, 2026-10-25), trimmed to its first lines.
const portInUse = (port: number) =>
  `timestamp=2026-10-25T12:05:58.121Z level=ERROR run=483160a1 message="cli process failed" cause="Cause([Fail(ServeError (cause: Error: Failed to start server. Is port ${port} in use?))])" args="[\\"serve\\",\\"--hostname\\",\\"127.0.0.1\\",\\"--port\\",\\"${port}\\",\\"--print-logs\\",\\"--log-level\\",\\"info\\"]" role=cli\nServeError: \n  [cause]: Error: Failed to start server. Is port ${port} in use?\n`;

describe("OpenCode lost port", () => {
  it("reads the bind failure for the port it passed", () => {
    expect(openCodePortTaken(portInUse(45135), 45135)).toBe(true);
  });

  it.each([
    ["another port's line", portInUse(45136)],
    ["a longer port with the same prefix", portInUse(451350)],
    ["another early failure", "error: wrong architecture\n"],
    ["no output", ""],
  ])("does not read %s as a lost port", (_why, stderr) => {
    expect(openCodePortTaken(stderr, 45135)).toBe(false);
  });
});
