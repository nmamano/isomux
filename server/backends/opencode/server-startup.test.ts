import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { OPENCODE_CLI_VERSION } from "./runtime.ts";
import { OPENCODE_STARTUP_TIMEOUT_MS, waitHealthy } from "./server-startup.ts";

const HEALTH_FETCH_MS = 300;

function fixture(portAt = Infinity, version = OPENCODE_CLI_VERSION) {
  let elapsed = 0;
  let reads = 0;
  let requests = 0;
  const child: { -readonly [K in "pid" | "exitCode" | "signalCode"]: ChildProcess[K] } = {
    pid: process.pid, exitCode: null, signalCode: null,
  };
  return {
    child,
    elapsed: () => elapsed,
    reads: () => reads,
    requests: () => requests,
    runtime: {
      now: () => elapsed,
      sleep: async (ms: number) => { elapsed += ms; },
      readOutput: async () => {
        reads++;
        return elapsed >= portAt ? "opencode server listening on http://127.0.0.1:43210\n" : "";
      },
      fetch: async (url: string, options: RequestInit) => {
        requests++;
        elapsed += HEALTH_FETCH_MS;
        expect(url).toBe("http://127.0.0.1:43210/global/health");
        expect(new Headers(options.headers).get("authorization")).toBe(`Basic ${btoa("isomux:fixture")}`);
        return Response.json({ healthy: true, version });
      },
    },
  };
}

describe("OpenCode startup deadline", () => {
  it("starts an alive child whose port arrives after the old attempt budget", async () => {
    // No port means no fetch: the old loop spent 160 * 50 = 8,000 ms.
    // The first fetch starts at 9,000 ms and takes another 300 ms.
    const f = fixture(9_000);
    expect(await waitHealthy(f.child, "private-output", "fixture", f.runtime),
      "a live child still starting after eight seconds gets its startup deadline").toBe(43210);
    expect(f.elapsed()).toBe(9_000 + HEALTH_FETCH_MS);
    expect(f.requests()).toBe(1);
  });

  it("rejects a healthy wrong-version child without using the remaining deadline", async () => {
    const f = fixture(0, "wrong-version");
    expect(await waitHealthy(f.child, "private-output", "fixture", f.runtime)).toBeNull();
    expect(f.elapsed(), "a healthy wrong version cannot improve by waiting").toBe(HEALTH_FETCH_MS);
    expect(f.requests()).toBe(1);
  });

  it("accepts a healthy reply that crosses the deadline", async () => {
    const f = fixture(OPENCODE_STARTUP_TIMEOUT_MS - 50);
    expect(await waitHealthy(f.child, "private-output", "fixture", f.runtime)).toBe(43210);
    expect(f.elapsed()).toBe(OPENCODE_STARTUP_TIMEOUT_MS - 50 + HEALTH_FETCH_MS);
    expect(f.requests()).toBe(1);
  });

  it.each(["exit", "signal"] as const)("fails immediately when the child reports %s", async (kind) => {
    const f = fixture();
    const sleep = f.runtime.sleep;
    f.runtime.sleep = async (ms) => {
      await sleep(ms);
      if (kind === "exit") f.child.exitCode = 1;
      else f.child.signalCode = "SIGTERM";
    };
    expect(await waitHealthy(f.child, "private-output", "fixture", f.runtime)).toBeNull();
    expect(f.elapsed(), "an exited child does not use the remaining startup budget").toBe(50);
    expect(f.reads()).toBe(1);
    expect(f.requests()).toBe(0);
  });

  it("bounds a live silent child by elapsed time including output reads", async () => {
    const f = fixture();
    const read = f.runtime.readOutput;
    f.runtime.readOutput = async () => {
      await f.runtime.sleep(250);
      return read();
    };
    expect(await waitHealthy(f.child, "private-output", "fixture", f.runtime)).toBeNull();
    expect(f.elapsed(), "poll work counts against the wall-clock deadline").toBe(OPENCODE_STARTUP_TIMEOUT_MS);
    expect(f.requests()).toBe(0);
  });
});
