import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashMarker, heapEnv, readHeapReport, runMarker } from "./heap-report";
import {
  type EslintRun,
  type LintReport,
  LINT_RESERVE_BYTES,
  LINT_THREAD_BYTES,
  MAX_LINT_THREADS,
  availableMemory,
  eslintCommand,
  eslintEnv,
  eslintNodeOptions,
  lintConcurrency,
  runLint,
} from "./lint";

const roots: string[] = [];

afterEach(() => {
  mock.restore();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

type Ending = { code: number; signal: string | null };

/** Available memory that gives three lint threads. */
const THREE_THREADS = LINT_RESERVE_BYTES + 3 * LINT_THREAD_BYTES;

/** Runs ESLint as a script of endings; a run past the script fails the test. */
async function lintWith(endings: Ending[], available = THREE_THREADS) {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  spyOn(console, "log").mockImplementation(keep);
  spyOn(console, "error").mockImplementation(keep);
  const threads: string[] = [];
  const run: EslintRun = async (concurrency) => {
    threads.push(concurrency);
    const ending = endings[threads.length - 1];
    if (!ending) throw new Error(`unexpected ESLint run ${threads.length}`);
    return ending;
  };
  const code = await runLint(false, run, available);
  return { code, threads, lines };
}

it("checks the entire tree in one process and supports fixes", () => {
  expect(eslintCommand(false)).toEqual([
    "bun",
    "x",
    "eslint",
    ".",
    "--concurrency=off",
  ]);
  expect(eslintCommand(true, "3")).toEqual([
    "bun",
    "x",
    "eslint",
    ".",
    "--concurrency=3",
    "--fix",
  ]);
});

it("preserves other Node options and supplies the lint heap limit", () => {
  expect(eslintNodeOptions("--trace-warnings")).toBe(
    "--trace-warnings --max-old-space-size=4096",
  );
});

it("reads MemAvailable, not MemFree", () => {
  expect(
    availableMemory(
      "MemTotal:       24608572 kB\nMemFree:        11821372 kB\nMemAvailable:   18143036 kB\n",
    ),
  ).toBe(18143036 * 1024);
  expect(availableMemory("MemTotal: 1 kB\nMemFree: 1 kB\n")).toBeUndefined();
});

it("adds a lint thread per budget above the reserve, from two to the cap", () => {
  const above = (threads: number) =>
    LINT_RESERVE_BYTES + threads * LINT_THREAD_BYTES;
  expect(lintConcurrency(undefined)).toBe("off");
  expect(lintConcurrency(0)).toBe("off");
  expect(lintConcurrency(above(2) - 1)).toBe("off");
  expect(lintConcurrency(above(2))).toBe("2");
  expect(lintConcurrency(above(3))).toBe("3");
  expect(lintConcurrency(above(MAX_LINT_THREADS + 10))).toBe(
    String(MAX_LINT_THREADS),
  );
});

it("reports a finding or an ESLint error from one run", async () => {
  expect(lintConcurrency(THREE_THREADS)).toBe("3");
  for (const code of [0, 1, 2, 127]) {
    const lint = await lintWith([{ code, signal: null }]);
    expect(lint.code).toBe(code);
    expect(lint.threads).toEqual(["3"]);
    expect(lint.lines).toHaveLength(1);
  }
});

it("runs ESLint once more with threads off after a crash", async () => {
  const crashes: Ending[] = [
    { code: 133, signal: "SIGTRAP" },
    { code: 134, signal: "SIGABRT" },
    { code: 128, signal: null },
    { code: 137, signal: null },
  ];
  for (const crash of crashes) {
    for (const verdict of [0, 1]) {
      const lint = await lintWith([crash, { code: verdict, signal: null }]);
      expect(lint.code).toBe(verdict);
      expect(lint.threads).toEqual(["3", "off"]);
      expect(lint.lines).toHaveLength(2);
      expect(lint.lines[1]).toContain(String(crash.code));
      if (crash.signal) expect(lint.lines[1]).toContain(crash.signal);
    }
  }
  const unthreaded = await lintWith(
    [crashes[0], { code: 0, signal: null }],
    LINT_RESERVE_BYTES,
  );
  expect(unthreaded.threads).toEqual(["off", "off"]);
  expect(unthreaded.code).toBe(0);
});

it("fails after a second crash, with no third run", async () => {
  const lint = await lintWith([
    { code: 133, signal: "SIGTRAP" },
    { code: 134, signal: "SIGABRT" },
  ]);
  expect(lint.code).toBe(134);
  expect(lint.threads).toEqual(["3", "off"]);
  expect(lint.lines).toHaveLength(3);
  expect(lint.lines[2]).toContain("134");
  expect(lint.lines[2]).toContain("SIGABRT");
});

// The heap report (task 53a41bd9): with a report, lint.ts marks each ESLint
// run in it and fails a lint whose last run lost a heap, since then ESLint may
// not have linted every file.
describe("the heap check", () => {
  const start = (pid: number, threadId: number) =>
    JSON.stringify({ start: true, pid, threadId });
  const end = (pid: number, threadId: number) =>
    JSON.stringify({ end: true, pid, threadId, peak: 1e8, limit: 4e9 });

  type Script = Ending & { heaps: string[] };

  /**
   * Runs ESLint as a script of endings, each with the report lines its heaps
   * write; `self` as when lint.ts loaded the preload itself.
   */
  async function lintReported(script: Script[], self = false) {
    const lines: string[] = [];
    const keep = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    spyOn(console, "log").mockImplementation(keep);
    spyOn(console, "error").mockImplementation(keep);
    let text = "";
    const report: LintReport = {
      self,
      read: () => text,
      append: (line) => {
        text += line;
      },
    };
    const threads: string[] = [];
    const marked: boolean[] = [];
    const run: EslintRun = async (concurrency) => {
      threads.push(concurrency);
      marked.push(text.endsWith(runMarker(concurrency)));
      const step = script[threads.length - 1];
      if (!step) throw new Error(`unexpected ESLint run ${threads.length}`);
      for (const line of step.heaps) text += `${line}\n`;
      return { code: step.code, signal: step.signal };
    };
    const code = await runLint(false, run, THREE_THREADS, report);
    return { code, threads, lines, marked, text };
  }

  it("passes a run whose heaps all reported, and marks the run first", async () => {
    const lint = await lintReported([
      {
        code: 0,
        signal: null,
        heaps: [start(1, 0), start(1, 1), end(1, 1), end(1, 0)],
      },
    ]);
    expect(lint.code).toBe(0);
    expect(lint.threads).toEqual(["3"]);
    expect(lint.marked).toEqual([true]);
    expect(lint.lines).toHaveLength(1);
  });

  it("fails a clean ESLint exit when a heap of the run did not report, and says why", async () => {
    const lint = await lintReported([
      { code: 0, signal: null, heaps: [start(1, 0), start(1, 1), end(1, 0)] },
    ]);
    expect(lint.code).toBe(1);
    expect(lint.threads).toEqual(["3"]);
    expect(lint.lines.length).toBeGreaterThan(1);
  });

  it("keeps ESLint's own failure when a heap did not report", async () => {
    for (const code of [1, 2]) {
      const lint = await lintReported([
        { code, signal: null, heaps: [start(1, 0), start(1, 1), end(1, 0)] },
      ]);
      expect(lint.code).toBe(code);
    }
  });

  it("judges only the last run after a crash, and marks the crash in the report", async () => {
    const lint = await lintReported([
      // The main thread crashed before it started a thread.
      { code: 133, signal: "SIGTRAP", heaps: [start(1, 0)] },
      { code: 0, signal: null, heaps: [start(2, 0), end(2, 0)] },
    ]);
    expect(lint.code).toBe(0);
    expect(lint.threads).toEqual(["3", "off"]);
    expect(lint.marked).toEqual([true, true]);
    expect(lint.text).toContain(
      start(1, 0) + "\n" + crashMarker("exit 133, SIGTRAP") + runMarker("off"),
    );
    expect(readHeapReport(lint.text)).toMatchObject({
      lost: 0,
      crashes: ["exit 133, SIGTRAP"],
    });
    // A lost heap in the retry still fails it.
    const lost = await lintReported([
      { code: 133, signal: "SIGTRAP", heaps: [start(1, 0)] },
      { code: 0, signal: null, heaps: [start(2, 0), start(2, 1), end(2, 0)] },
    ]);
    expect(lost.code).toBe(1);
  });

  it("fails when no heap started although the caller asked for a report", async () => {
    const lint = await lintReported([{ code: 0, signal: null, heaps: [] }]);
    expect(lint.code).toBe(1);
    expect(lint.lines.length).toBeGreaterThan(1);
  });

  it("only notes no heap when lint.ts loaded the preload itself", async () => {
    // ESLint under Bun, with no Node on the machine, loads no preload.
    const lint = await lintReported(
      [{ code: 0, signal: null, heaps: [] }],
      true,
    );
    expect(lint.code).toBe(0);
    expect(lint.lines.length).toBeGreaterThan(1);
    const failed = await lintReported(
      [{ code: 1, signal: null, heaps: [] }],
      true,
    );
    expect(failed.code).toBe(1);
    // A lost heap fails a self-loaded report too.
    const lost = await lintReported(
      [{ code: 0, signal: null, heaps: [start(1, 0)] }],
      true,
    );
    expect(lost.code).toBe(1);
  });
});

describe("the ESLint environment in a real Node run", () => {
  // Node, not Bun: Bun ignores NODE_OPTIONS --require.
  async function node(env: Record<string, string>): Promise<number> {
    const path = Bun.which("node");
    expect(path).not.toBeNull();
    const child = Bun.spawn([path!, "-e", "0;"], {
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    return child.exited;
  }

  function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), "lint-test-"));
    roots.push(root);
    return root;
  }

  it("keeps the environment and adds the heap cap", () => {
    const env = eslintEnv({ PATH: "/x/bin", NODE_OPTIONS: "--trace-warnings" });
    expect(env.PATH).toBe("/x/bin");
    expect(env.NODE_OPTIONS).toContain("--trace-warnings");
    expect(env.NODE_OPTIONS).toContain("--max-old-space-size=4096");
  });

  it("loads the preload when lint.ts reports itself", async () => {
    const file = join(scratch(), "self.heap");
    const env = eslintEnv(
      { ...process.env, ISOMUX_HEAP_REPORT: undefined },
      file,
    );
    expect(env.ISOMUX_HEAP_REPORT).toBe(file);
    expect(await node(env)).toBe(0);
    expect(readHeapReport(readFileSync(file, "utf8"))).toMatchObject({
      heaps: 1,
      lost: 0,
    });
  });

  // Node loads one --require path once, so a second copy of the caller's
  // preload would still give one start line: this case guards the caller's
  // report reaching ESLint's Node, not a double load.
  it("keeps the caller's report and preload", async () => {
    const file = join(scratch(), "ci.heap");
    const caller = heapEnv(file, process.env.NODE_OPTIONS);
    const env = eslintEnv({ ...process.env, ...caller });
    expect(env.ISOMUX_HEAP_REPORT).toBe(file);
    expect(await node(env)).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(readHeapReport(text)).toMatchObject({ heaps: 1, lost: 0 });
  });
});
