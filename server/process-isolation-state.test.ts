// The office's process isolation state (server/process-isolation-state.ts):
// the status before and after the probe, the one form per session start, and
// the re-probe after a failed bwrap setup. The probe result is set, or the
// probe runs on an injected run: never on this host's bwrap.
//
// The module state is process-wide and bun runs every test file in one
// process: afterEach puts it back to "no probe result", which reads as off, so
// no other file's spawns are wrapped.
import { afterEach, describe, expect, it } from "bun:test";
import type { RunOptions, RunResult } from "./agent-host.ts";
import type { ProcessIsolationProbeDeps } from "./process-isolation.ts";
import {
  processIsolationNow,
  reportIsolationSetupFailure,
  runProcessIsolationProbe,
  sessionIsolationForm,
  setProcessIsolationProbe,
  setProcessIsolationProbeDeps,
  setProcessIsolationSwitch,
} from "./process-isolation-state.ts";

afterEach(() => {
  setProcessIsolationProbe(null);
  setProcessIsolationSwitch(() => true);
});

// A Linux host whose bwrap is refused. Counts the runs, and holds each one
// until release() so that failures can arrive while a probe is in flight.
function deniedHost() {
  let runs = 0;
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const deps: ProcessIsolationProbeDeps = {
    platform: "linux",
    env: {},
    async run(_argv: string[], _options?: RunOptions): Promise<RunResult> {
      runs++;
      await gate;
      return {
        exitCode: 1,
        stdout: "",
        stderr: "bwrap: No permissions to create a new namespace\n",
      };
    },
  };
  return {
    deps,
    runs: () => runs,
    release() {
      open();
    },
  };
}

describe("process isolation status", () => {
  it("is off until the probe has a result", () => {
    setProcessIsolationProbe(null);
    expect(processIsolationNow().state).toBe("off");
  });

  it("stores the result of a probe run", async () => {
    setProcessIsolationProbeDeps(() => ({
      platform: "darwin",
      env: {},
      run: () => Promise.reject(new Error("the probe ran a command")),
    }));
    expect(await runProcessIsolationProbe()).toEqual({
      state: "off",
      reason: "needs_linux",
    });
    expect(processIsolationNow()).toEqual({
      state: "off",
      reason: "needs_linux",
    });
  });

  it("reads the owner's switch at each call", () => {
    setProcessIsolationProbe({ available: true });
    let on = true;
    setProcessIsolationSwitch(() => on);
    expect(processIsolationNow()).toEqual({ state: "on" });
    on = false;
    expect(processIsolationNow()).toEqual({
      state: "off",
      reason: "turned_off",
    });
  });
});

describe("the form of a session start", () => {
  const cases = [
    [{ agentType: "claude" }, "session"],
    [{ agentType: "codex", codexSandbox: "danger-full-access" }, "session"],
    [{ agentType: "codex", codexSandbox: "workspace-write" }, null],
    [{ agentType: "codex", codexSandbox: "read-only" }, null],
    // Below standard a Codex thread is read-only whatever its stored mode.
    [
      {
        agentType: "codex",
        codexSandbox: "danger-full-access",
        access: "office",
      },
      null,
    ],
    [{ agentType: "opencode" }, "shared_server"],
  ] as const;

  it("follows the engine and the Codex sandbox when isolation is on", () => {
    setProcessIsolationProbe({ available: true });
    for (const [input, form] of cases)
      expect([input, sessionIsolationForm(input)]).toEqual([input, form]);
  });

  it("is null for every engine when the switch is off or the host cannot", () => {
    setProcessIsolationProbe({ available: true });
    setProcessIsolationSwitch(() => false);
    for (const [input] of cases)
      expect([input, sessionIsolationForm(input)]).toEqual([input, null]);
    setProcessIsolationSwitch(() => true);
    setProcessIsolationProbe({
      available: false,
      reason: "denied",
      detail: "bwrap: denied",
    });
    for (const [input] of cases)
      expect([input, sessionIsolationForm(input)]).toEqual([input, null]);
  });
});

describe("a failed bwrap setup", () => {
  it("probes again, once for the failures in flight, and the next start follows it", async () => {
    // The cost of one probe on this host, as the baseline.
    const one = deniedHost();
    setProcessIsolationProbeDeps(() => one.deps);
    setProcessIsolationProbe({ available: true });
    const single = reportIsolationSetupFailure();
    one.release();
    await single;
    expect(one.runs()).toBeGreaterThan(0);

    const many = deniedHost();
    setProcessIsolationProbeDeps(() => many.deps);
    setProcessIsolationProbe({ available: true });
    expect(processIsolationNow()).toEqual({ state: "on" });
    const failures = [1, 2, 3].map(() => reportIsolationSetupFailure());
    many.release();
    await Promise.all(failures);
    expect(many.runs()).toBe(one.runs());
    expect(processIsolationNow()).toEqual({ state: "off", reason: "denied" });
    expect(sessionIsolationForm({ agentType: "claude" })).toBeNull();
  });
});
