import { afterEach, expect, it, mock, spyOn } from "bun:test";
import {
  type EslintRun,
  LINT_RESERVE_BYTES,
  LINT_THREAD_BYTES,
  MAX_LINT_THREADS,
  availableMemory,
  eslintCommand,
  eslintNodeOptions,
  lintConcurrency,
  runLint,
} from "./lint";

afterEach(() => {
  mock.restore();
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
