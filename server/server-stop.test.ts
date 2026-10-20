// The office process's stop (task e438f301): systemd stops the unit with
// SIGTERM to the whole control group, so every agent backend dies with exit 143
// in the same moment as the server. The server must know it is stopping, so the
// death notice names the stop instead of blaming out-of-memory protection.
//
// These run in real subprocesses on purpose: each case sends a stop signal to
// its own process, and the process must then die by that signal. Doing that
// in-process would stop the test runner.

import { describe, expect, test } from "bun:test";

import { msg } from "../shared/i18n/log-message.ts";

const STOP_MODULE = `${import.meta.dir}/server-stop.ts`;
const FAILURE_TEXT_MODULE = `${import.meta.dir}/backend-failure-text.ts`;
const SUPERVISOR_MODULE = `${import.meta.dir}/backends/opencode/supervisor.ts`;

// Far past a green run (about 0.2 s). A process that never re-raises its
// signal stays alive, and this is when the helper kills it.
const HANG_MS = 3_000;

interface StopRun {
  // One JSON line per out() call in the subprocess, in order.
  lines: Record<string, unknown>[];
  signalCode: string | null;
  exitCode: number | null;
  stderr: string;
  hung: boolean;
}

/**
 * Run `body` in a fresh bun process that has loaded server-stop.ts, then send
 * the process `signal`. `body` can call out(value) to report a JSON line.
 */
async function runStop(
  signal: "SIGTERM" | "SIGINT",
  body: string,
): Promise<StopRun> {
  const code = `
    const { serverStopping, runAtServerStop } = await import(${JSON.stringify(STOP_MODULE)});
    const out = (value) => console.log(JSON.stringify(value));
    ${body}
    setInterval(() => {}, 1000);
    process.kill(process.pid, ${JSON.stringify(signal)});
  `;
  const proc = Bun.spawn(["bun", "-e", code], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    proc.kill("SIGKILL");
  }, HANG_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const lines = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    lines,
    signalCode: proc.signalCode,
    exitCode: proc.exitCode,
    stderr,
    hung,
  };
}

/** How the subprocess ended, in one value, so a failure shows the whole story. */
function death(run: StopRun) {
  return {
    signalCode: run.signalCode,
    exitCode: run.exitCode,
    hung: run.hung,
    stderr: run.signalCode === null ? run.stderr : "",
  };
}

// A hook that takes long enough that a re-raise before it settles is visible:
// its "end" line is then missing.
const SLOW_HOOK = `
  runAtServerStop(async () => {
    out({ phase: "hook-start", stopping: serverStopping() });
    await new Promise((resolve) => setTimeout(resolve, 150));
    out({ phase: "hook-end", stopping: serverStopping() });
  });
`;

describe("the server's stop signal", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal}: the flag is set before the hooks run, and the process dies by ${signal} after they settle`, async () => {
      const run = await runStop(
        signal,
        `out({ phase: "before", stopping: serverStopping() });
         ${SLOW_HOOK}`,
      );
      expect(run.lines).toEqual([
        // Not stopping until the signal arrives.
        { phase: "before", stopping: false },
        // Already stopping when the first hook starts.
        { phase: "hook-start", stopping: true },
        // The process lived until the slow hook settled, and the flag stays set.
        { phase: "hook-end", stopping: true },
      ]);
      // Died by the same signal: systemd and a shell read the death that way.
      expect(death(run)).toEqual({
        signalCode: signal,
        exitCode: null,
        hung: false,
        stderr: "",
      });
    });
  }

  test("a hook that throws or rejects does not stop the other hooks or the re-raise", async () => {
    // The failing hooks register first, so a loop that stops at the first
    // failure never reaches the slow hook.
    const run = await runStop(
      "SIGTERM",
      `runAtServerStop(() => { throw new Error("sync hook failure"); });
       runAtServerStop(async () => { throw new Error("async hook failure"); });
       ${SLOW_HOOK}`,
    );
    expect(run.lines).toEqual([
      { phase: "hook-start", stopping: true },
      { phase: "hook-end", stopping: true },
    ]);
    expect(death(run)).toEqual({
      signalCode: "SIGTERM",
      exitCode: null,
      hung: false,
      stderr: "",
    });
  });

  test("a second signal while a hook hangs ends the process at once", async () => {
    // Ctrl-C twice: the stop helpers have no timeout of their own, so a hung
    // hook must not leave a foreground server that only SIGKILL can end.
    const run = await runStop(
      "SIGINT",
      `runAtServerStop(async () => {
         out({ phase: "hook-start", stopping: serverStopping() });
         setTimeout(() => process.kill(process.pid, "SIGINT"), 50);
         await new Promise(() => {});
       });`,
    );
    expect(run.lines).toEqual([{ phase: "hook-start", stopping: true }]);
    expect(death(run)).toEqual({
      signalCode: "SIGINT",
      exitCode: null,
      hung: false,
      stderr: "",
    });
  });

  test("with the OpenCode supervisor loaded, the process still waits for every hook", async () => {
    // The supervisor used to own the signal listeners. A listener of its own
    // left next to server-stop.ts re-raises when ITS reap settles, which kills
    // the process before a slower hook ends.
    const run = await runStop(
      "SIGTERM",
      `await import(${JSON.stringify(SUPERVISOR_MODULE)});
       ${SLOW_HOOK}`,
    );
    expect(run.lines).toEqual([
      { phase: "hook-start", stopping: true },
      { phase: "hook-end", stopping: true },
    ]);
    expect(death(run)).toEqual({
      signalCode: "SIGTERM",
      exitCode: null,
      hung: false,
      stderr: "",
    });
  });
});

// The death notice itself. Production callers call humanizeBackendFailure with
// no stop argument, so this calls it the same way, before and during a stop.
describe("the death notice while the server stops", () => {
  const SIGTERM_RAW = "Claude Code process exited with code 143";
  // [raw failure, id when the server is not stopping, id while it stops]
  const CASES: [string, string, string][] = [
    [SIGTERM_RAW, "sigterm:143", "server-stopped:143"],
    [
      "Claude Code process exited with code 137",
      "sigkill:137",
      "server-stopped:137",
    ],
    // SIGINT: Ctrl-C on a foreground server reaches its backends too.
    ["process exited with code 130", "signal:130", "server-stopped:130"],
    // Both ends of the signal-exit range, and the first code past it.
    ["process exited with code 129", "signal:129", "server-stopped:129"],
    ["process exited with code 192", "signal:192", "server-stopped:192"],
    ["process exited with code 193", "unclassified", "unclassified"],
    // Deaths that are not a signal keep their own explanation during a stop.
    ["Claude Code process exited with code 1", "unclassified", "unclassified"],
    [
      "Agent stopped: error_during_execution. [ede_diagnostic] result_type=user",
      "stopped-during-turn",
      "stopped-during-turn",
    ],
    [
      "Selected model is at capacity. Please try a different model.",
      "provider-capacity",
      "provider-capacity",
    ],
    ["ECONNRESET", "unclassified", "unclassified"],
  ];

  test("names the stop for a signal death and keeps every other explanation", async () => {
    const raws = CASES.map(([raw]) => raw);
    const run = await runStop(
      "SIGTERM",
      `const { humanizeBackendFailure } = await import(${JSON.stringify(FAILURE_TEXT_MODULE)});
       const raws = ${JSON.stringify(raws)};
       const notices = () => raws.map((raw) => humanizeBackendFailure(raw));
       out({ phase: "before", notices: notices() });
       runAtServerStop(async () => {
         out({ phase: "during", notices: notices() });
       });`,
    );
    expect(death(run).signalCode).toBe("SIGTERM");
    const [before, during] = run.lines as {
      phase: string;
      notices: { text: unknown; raw?: string; id: string }[];
    }[];
    expect(run.lines.map((line) => line.phase)).toEqual(["before", "during"]);

    // Before the signal: today's explanations, the OOM hint included.
    expect(before.notices.map((n) => n.id)).toEqual(
      CASES.map(([, beforeId]) => beforeId),
    );
    expect(before.notices[0].text).toEqual(
      msg("systemEntries.backendFailure.sigterm", { code: 143 }),
    );

    // During the stop: the stop is named for every signal exit.
    expect(during.notices.map((n) => n.id)).toEqual(
      CASES.map(([, , duringId]) => duringId),
    );
    expect(during.notices[0]).toEqual({
      text: msg("systemEntries.backendFailure.serverStopped", { code: 143 }),
      // The backend's own string stays in the log entry's metadata.
      raw: SIGTERM_RAW,
      id: "server-stopped:143",
    });
    expect(during.notices[1].text).toEqual(
      msg("systemEntries.backendFailure.serverStopped", { code: 137 }),
    );
  });
});
