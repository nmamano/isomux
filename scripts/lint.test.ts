import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashMarker, heapEnv, readHeapReport, runMarker } from "./heap-report";
import {
  type EslintRun,
  type LintReport,
  type LintTarget,
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
async function lintWith(
  endings: Ending[],
  available = THREE_THREADS,
  target: LintTarget = "repo",
) {
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
  const code = await runLint(false, run, available, undefined, target);
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

it("reports a clean run, a finding or another error from one run", async () => {
  expect(lintConcurrency(THREE_THREADS)).toBe("3");
  for (const code of [0, 1, 127]) {
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

// ESLint exits 2 on an internal error too: in CI a fresh thread once threw a
// TypeError while it loaded typescript.js, and the same commit then passed
// (task 18fab35d). Exit 2 runs again like a crash.
it("runs ESLint once more with threads off after an exit 2", async () => {
  for (const verdict of [0, 1]) {
    const lint = await lintWith([
      { code: 2, signal: null },
      { code: verdict, signal: null },
    ]);
    expect(lint.code).toBe(verdict);
    expect(lint.threads).toEqual(["3", "off"]);
    expect(lint.lines).toHaveLength(2);
  }
  const unthreaded = await lintWith(
    [
      { code: 2, signal: null },
      { code: 0, signal: null },
    ],
    LINT_RESERVE_BYTES,
  );
  expect(unthreaded.threads).toEqual(["off", "off"]);
  expect(unthreaded.code).toBe(0);
});

it("fails when the run after an exit 2 or a crash fails the same way, with no third run", async () => {
  const twice = await lintWith([
    { code: 2, signal: null },
    { code: 2, signal: null },
  ]);
  expect(twice.code).toBe(2);
  expect(twice.threads).toEqual(["3", "off"]);
  // A line says the run after the exit 2 failed too.
  expect(twice.lines).toHaveLength(3);
  const crashAfter = await lintWith([
    { code: 2, signal: null },
    { code: 134, signal: "SIGABRT" },
  ]);
  expect(crashAfter.code).toBe(134);
  expect(crashAfter.threads).toEqual(["3", "off"]);
  expect(crashAfter.lines).toHaveLength(3);
  expect(crashAfter.lines[2]).toContain("SIGABRT");
  const exit2After = await lintWith([
    { code: 133, signal: "SIGTRAP" },
    { code: 2, signal: null },
  ]);
  expect(exit2After.code).toBe(2);
  expect(exit2After.threads).toEqual(["3", "off"]);
  expect(exit2After.lines).toHaveLength(3);
});

// ci:web lints the web app with it, on a remote gate slot of about 3 GiB
// (task 3a48aba3): threads stay off however much memory is free.
it("lints the web app unthreaded, and once more after a crash or an exit 2", async () => {
  for (const code of [0, 1]) {
    const lint = await lintWith([{ code, signal: null }], THREE_THREADS, "web");
    expect(lint.code).toBe(code);
    expect(lint.threads).toEqual(["off"]);
  }
  const crash = await lintWith(
    [
      { code: 133, signal: "SIGTRAP" },
      { code: 1, signal: null },
    ],
    THREE_THREADS,
    "web",
  );
  expect(crash.code).toBe(1);
  expect(crash.threads).toEqual(["off", "off"]);
  expect(crash.lines[1]).toContain("133");
  const twice = await lintWith(
    [
      { code: 134, signal: "SIGABRT" },
      { code: 134, signal: "SIGABRT" },
    ],
    THREE_THREADS,
    "web",
  );
  expect(twice.code).toBe(134);
  expect(twice.threads).toEqual(["off", "off"]);
  const exit2 = await lintWith(
    [
      { code: 2, signal: null },
      { code: 1, signal: null },
    ],
    THREE_THREADS,
    "web",
  );
  expect(exit2.code).toBe(1);
  expect(exit2.threads).toEqual(["off", "off"]);
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
    const lost = [start(1, 0), start(1, 1), end(1, 0)];
    const finding = await lintReported([
      { code: 1, signal: null, heaps: lost },
    ]);
    expect(finding.code).toBe(1);
    // An exit 2 runs again; the run after it ends with exit 2 too.
    const error = await lintReported([
      { code: 2, signal: null, heaps: lost },
      { code: 2, signal: null, heaps: lost },
    ]);
    expect(error.code).toBe(2);
    expect(error.threads).toEqual(["3", "off"]);
  });

  it("judges only the last run after an exit 2, and marks it in the report", async () => {
    const lint = await lintReported([
      // The thread that threw started, and ESLint ended before its end line.
      { code: 2, signal: null, heaps: [start(1, 0), start(1, 1), end(1, 0)] },
      { code: 0, signal: null, heaps: [start(2, 0), end(2, 0)] },
    ]);
    expect(lint.code).toBe(0);
    expect(lint.threads).toEqual(["3", "off"]);
    expect(lint.marked).toEqual([true, true]);
    expect(lint.text).toContain(
      end(1, 0) + "\n" + crashMarker("exit 2") + runMarker("off"),
    );
    expect(readHeapReport(lint.text)).toMatchObject({
      lost: 0,
      crashes: ["exit 2"],
    });
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

// `bun run lint:web` as ci:web runs it (task 3a48aba3): the package script,
// through lint.ts, with ESLint replaced by a `bun x` that ends as told.
describe("lint:web", () => {
  const repoRoot = join(import.meta.dirname, "..");
  const script = (
    JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts["lint:web"];

  /** Runs the lint:web script with `args`; each `bun x` exits the next code. */
  async function lintWeb(codes: number[], args = "") {
    const dir = mkdtempSync(join(tmpdir(), "lint-web-test-"));
    roots.push(dir);
    writeFileSync(join(dir, "codes"), codes.join("\n") + "\n");
    writeFileSync(join(dir, "calls"), "");
    const fake = join(dir, "bin");
    mkdirSync(fake);
    writeFileSync(
      join(fake, "bun"),
      [
        "#!/bin/sh",
        'if [ "$1" = x ]; then',
        '  echo "$*" >> "$LINT_FAKE/calls"',
        '  n=$(wc -l < "$LINT_FAKE/calls")',
        '  exit "$(sed -n "${n}p" "$LINT_FAKE/codes")"',
        "fi",
        'exec "$LINT_REAL_BUN" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(join(fake, "bun"), 0o755);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && key !== "ISOMUX_HEAP_REPORT") env[key] = value;
    // No ESLint on this PATH: only the fake can answer.
    env.PATH = `${fake}:/usr/bin:/bin`;
    env.LINT_FAKE = dir;
    env.LINT_REAL_BUN = process.execPath;
    const child = Bun.spawn(["sh", "-c", `${script} ${args}`], {
      cwd: repoRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const calls = readFileSync(join(dir, "calls"), "utf8")
      .split("\n")
      .filter(Boolean);
    return { code, calls };
  }

  const web =
    "x eslint --config control-plane/web/eslint.config.mjs control-plane/web";

  it("lints the web app once, and once more after a crash or an exit 2", async () => {
    const crash = await lintWeb([134, 0]);
    expect(crash.calls).toEqual([
      `${web} --concurrency=off`,
      `${web} --concurrency=off`,
    ]);
    expect(crash.code).toBe(0);
    const finding = await lintWeb([1]);
    expect(finding.calls).toEqual([`${web} --concurrency=off`]);
    expect(finding.code).toBe(1);
    const error = await lintWeb([2, 0]);
    expect(error.calls).toEqual([
      `${web} --concurrency=off`,
      `${web} --concurrency=off`,
    ]);
    expect(error.code).toBe(0);
    const errorTwice = await lintWeb([2, 2]);
    expect(errorTwice.calls).toHaveLength(2);
    expect(errorTwice.code).toBe(2);
  });

  it("passes --fix on", async () => {
    const fix = await lintWeb([0], "--fix");
    expect(fix.calls).toEqual([`${web} --concurrency=off --fix`]);
    expect(fix.code).toBe(0);
  });
});
