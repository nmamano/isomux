// The CI heap report (task 06ef6918): scripts/heap-preload.cjs writes a start
// line when a Node heap starts and an end line when it exits, and the CI
// summary reads them. The report format is the contract between the two:
//   start: {"start":true,"pid":1,"threadId":0}
//   end:   {"end":true,"pid":1,"threadId":0,"peak":<bytes>,"limit":<bytes>}
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printSummary, runStage, stageEnv, stages } from "./ci";
import {
  HEAP_WARN_RATIO,
  heapEnv,
  heapLines,
  readHeapReport,
  type HeapUse,
} from "./heap-report";
import { eslintNodeOptions } from "./lint";

const PRELOAD = join(import.meta.dir, "heap-preload.cjs");
const MIB = 2 ** 20;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "heap-report-test-"));
  roots.push(root);
  return root;
}

const start = (pid: number, threadId: number) =>
  JSON.stringify({ start: true, pid, threadId });
const end = (pid: number, threadId: number, peak: number, limit: number) =>
  JSON.stringify({ end: true, pid, threadId, peak, limit });
const report = (...lines: string[]) => lines.map((l) => `${l}\n`).join("");

function use(peakBytes: number, limitBytes: number, lost = 0): HeapUse {
  return { peakBytes, limitBytes, heaps: 1, lost };
}

// Node, not Bun: Bun ignores NODE_OPTIONS --require.
function node(): string {
  const path = Bun.which("node");
  expect(path).not.toBeNull();
  return path!;
}

// One Node run of `script` with the heap env; core dumps off, so an abort
// leaves no core file behind.
async function runNode(
  script: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(
    ["bash", "-c", 'ulimit -c 0; exec "$0" -e "$1"', node(), script],
    {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { code, stdout };
}

describe("readHeapReport", () => {
  it("reads no report from empty text", () => {
    expect(readHeapReport("")).toBeUndefined();
  });

  it("picks the worst heap by its share of its own limit, not by bytes", () => {
    const text = report(
      start(7, 0),
      start(7, 1),
      // 60% of a small limit.
      end(7, 1, 600 * MIB, 1000 * MIB),
      // More bytes, but 25% of a large one.
      end(7, 0, 1000 * MIB, 4000 * MIB),
    );
    expect(readHeapReport(text)).toEqual({
      peakBytes: 600 * MIB,
      limitBytes: 1000 * MIB,
      heaps: 2,
      lost: 0,
    });
  });

  it("counts a heap that started and never ended as lost, pairing by process and thread", () => {
    // The lint retry: the first ESLint process lost a thread (threadId 1);
    // the second process reuses threadIds 0 and 1 and ends both.
    const text = report(
      start(10, 0),
      start(10, 1),
      end(10, 0, 100 * MIB, 4000 * MIB),
      start(11, 0),
      start(11, 1),
      end(11, 0, 200 * MIB, 4000 * MIB),
      end(11, 1, 300 * MIB, 4000 * MIB),
    );
    expect(readHeapReport(text)).toMatchObject({
      peakBytes: 300 * MIB,
      heaps: 3,
      lost: 1,
    });
  });

  it("reports only lost heaps when none ended", () => {
    expect(readHeapReport(report(start(3, 0)))).toMatchObject({
      heaps: 0,
      lost: 1,
    });
  });

  it("skips a line it cannot read and keeps the rest", () => {
    const text = report(
      start(5, 0),
      "not json",
      '{"end":true,"pid":5',
      end(5, 0, 10 * MIB, 100 * MIB),
    );
    expect(readHeapReport(text)).toEqual({
      peakBytes: 10 * MIB,
      limitBytes: 100 * MIB,
      heaps: 1,
      lost: 0,
    });
  });
});

describe("heapLines", () => {
  it("one line that names the stage and its share, with no warning below the ratio", () => {
    const lines = heapLines("lint", use(600 * MIB, 1000 * MIB));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("lint");
    expect(lines[0]).toMatch(/\b60%/);
    // Just under the ratio still has no warning.
    expect(
      heapLines("tsc", use(HEAP_WARN_RATIO * 1000 * MIB - 1, 1000 * MIB)),
    ).toHaveLength(1);
  });

  it("adds a warning line at the ratio and above", () => {
    for (const share of [HEAP_WARN_RATIO, 0.95]) {
      const lines = heapLines("tsc", use(share * 1000 * MIB, 1000 * MIB));
      expect({ share, lines: lines.length }).toEqual({ share, lines: 2 });
      expect(lines[1]).toContain("tsc");
    }
  });

  it("warns when a heap was lost, also when the worst finished heap is low", () => {
    const lines = heapLines("lint", use(100 * MIB, 1000 * MIB, 1));
    expect(lines.length).toBeGreaterThan(1);
  });

  it("warns when no heap reported at all", () => {
    const lines = heapLines("tsc", undefined);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("tsc");
    // Only a start line: the same as no report, never a share of nothing.
    expect(heapLines("tsc", readHeapReport(report(start(1, 0))))).toEqual(
      lines,
    );
  });
});

describe("heapEnv", () => {
  it("names the report file and adds the quoted preload to the existing options", () => {
    const env = heapEnv("/r/x.heap", "--max-old-space-size=4096");
    expect(env.ISOMUX_HEAP_REPORT).toBe("/r/x.heap");
    expect(env.NODE_OPTIONS).toContain("--max-old-space-size=4096");
    expect(env.NODE_OPTIONS).toContain(`--require "${PRELOAD}"`);
    expect(heapEnv("/r/x.heap").NODE_OPTIONS).toBe(`--require "${PRELOAD}"`);
  });
});

describe("the preload in a real Node run", () => {
  it("writes a start and an end line, with the heap held at exit and a limit that follows the cap", async () => {
    const dir = scratch();
    // About 52 MB of doubles on the heap, held until exit.
    const hold = "globalThis.keep = new Array(6_500_000).fill(0.5);";
    const limits: number[] = [];
    for (const cap of [128, 256]) {
      const file = join(dir, `${cap}.heap`);
      const run = await runNode(
        hold,
        heapEnv(file, `--max-old-space-size=${cap}`),
      );
      expect(run.code).toBe(0);
      const text = readFileSync(file, "utf8");
      expect(text.trim().split("\n")).toHaveLength(2);
      const got = readHeapReport(text)!;
      expect({ heaps: got.heaps, lost: got.lost }).toEqual({
        heaps: 1,
        lost: 0,
      });
      expect(got.peakBytes).toBeGreaterThanOrEqual(6_500_000 * 8);
      limits.push(got.limitBytes);
    }
    // The young generation is the same in both runs.
    expect(limits[1] - limits[0]).toBe(128 * MIB);
  });

  it("keeps a full-GC peak from before exit when the heap shrank by then", async () => {
    const dir = scratch();
    const file = join(dir, "peak.heap");
    // Hold about 80 MB through full GCs (promoted garbage under a small cap
    // forces them), then drop it before exit.
    const script = [
      "let big = new Array(10_000_000).fill(0.5);",
      "const ring = [];",
      "for (let i = 0; i < 400; i++) ring[i % 8] = new Array(50_000).fill(0.5);",
      "big = null;",
    ].join("\n");
    const run = await runNode(
      script,
      heapEnv(file, "--max-old-space-size=160"),
    );
    expect(run.code).toBe(0);
    expect(
      readHeapReport(readFileSync(file, "utf8"))!.peakBytes,
    ).toBeGreaterThanOrEqual(10_000_000 * 8);
  });

  it("keeps the exit code of a process that calls process.exit", async () => {
    const dir = scratch();
    const file = join(dir, "exit.heap");
    const run = await runNode("process.exit(3);", heapEnv(file));
    expect(run.code).toBe(3);
    expect(readHeapReport(readFileSync(file, "utf8"))).toMatchObject({
      heaps: 1,
      lost: 0,
    });
  });

  it("a worker thread writes its own lines with its own limit", async () => {
    const dir = scratch();
    const file = join(dir, "worker.heap");
    // The worker holds about 8 MB under a 16 MB old space: its share is the
    // worst, far above the main thread's. No cap flag: --max-old-space-size
    // overrides a worker's resourceLimits (Node 24), as in ESLint's threads.
    const script = [
      "const { Worker } = require('node:worker_threads');",
      "new Worker(",
      "  'globalThis.keep = new Array(1_000_000).fill(0.5);',",
      "  { eval: true, resourceLimits: { maxOldGenerationSizeMb: 16 } },",
      ");",
    ].join("\n");
    const run = await runNode(script, heapEnv(file));
    expect(run.code).toBe(0);
    const got = readHeapReport(readFileSync(file, "utf8"))!;
    expect({ heaps: got.heaps, lost: got.lost }).toEqual({ heaps: 2, lost: 0 });
    // The worker's own limit (16 MB old space plus its young generation),
    // not the main thread's (several GB).
    expect(got.limitBytes).toBeLessThan(512 * MIB);
    expect(got.peakBytes).toBeGreaterThanOrEqual(1_000_000 * 8);
  });

  it("a process that aborts leaves a start line with no end", async () => {
    const dir = scratch();
    const file = join(dir, "abort.heap");
    const run = await runNode("process.abort();", heapEnv(file));
    expect(run.code).not.toBe(0);
    expect(readHeapReport(readFileSync(file, "utf8"))).toMatchObject({
      heaps: 0,
      lost: 1,
    });
  });

  it("never changes the process's result when it cannot write the report", async () => {
    const dir = scratch();
    // A report folder that is gone, as when a run's temp folder is removed.
    const file = join(dir, "gone", "x.heap");
    const run = await runNode("console.log('ran');", heapEnv(file));
    expect({ code: run.code, stdout: run.stdout.trim() }).toEqual({
      code: 0,
      stdout: "ran",
    });
    // The folder goes away after the start line, before the end line.
    const later = join(dir, "later");
    mkdirSync(later);
    const late = await runNode(
      `require("node:fs").rmSync(${JSON.stringify(later)}, { recursive: true }); console.log("ran");`,
      heapEnv(join(later, "x.heap")),
    );
    expect({ code: late.code, stdout: late.stdout.trim() }).toEqual({
      code: 0,
      stdout: "ran",
    });
  });

  it("does nothing without a report file named", async () => {
    const dir = scratch();
    const run = await runNode("console.log('ran');", {
      NODE_OPTIONS: heapEnv(join(dir, "none.heap")).NODE_OPTIONS,
      ISOMUX_HEAP_REPORT: "",
    });
    expect({ code: run.code, stdout: run.stdout.trim() }).toEqual({
      code: 0,
      stdout: "ran",
    });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the CI stages", () => {
  const tsc = stages.find((s) => s.name === "tsc")!;
  const lint = stages.find((s) => s.name === "lint")!;

  it("only tsc and lint report heap; no other stage gets the report", () => {
    expect(stages.filter((s) => s.heap).map((s) => s.name)).toEqual([
      "lint",
      "tsc",
    ]);
    for (const stage of stages.filter((s) => !s.heap))
      expect({
        stage: stage.name,
        report: stageEnv(stage, "/r/x.heap")?.ISOMUX_HEAP_REPORT,
      }).toEqual({ stage: stage.name, report: undefined });
  });

  it("the tsc process gets its 4096 MB cap and the preload together", async () => {
    const dir = scratch();
    const file = join(dir, "tsc.heap");
    // The stage's own command, ending in --version instead of --noEmit: the
    // preload reaches tsc's Node through it (no NODE_OPTIONS in the argv).
    const command = [...tsc.command.slice(0, -1), "--version"];
    expect(tsc.command.at(-1)).toBe("--noEmit");
    const result = await runStage(
      "tsc",
      command,
      join(dir, "tsc.log"),
      undefined,
      undefined,
      stageEnv(tsc, file),
    );
    expect(result.status).toBe("passed");
    expect(existsSync(file)).toBe(true);
    expect(
      readHeapReport(readFileSync(file, "utf8"))!.heaps,
    ).toBeGreaterThanOrEqual(1);
    // The cap reaches Node beside the preload. Its heap limit cannot show it
    // here: on a machine with 16 GB or more, V8's default is also 4096 MB.
    const log = join(dir, "options.log");
    const shown = await runStage(
      "tsc",
      [node(), "-p", "process.env.NODE_OPTIONS"],
      log,
      undefined,
      undefined,
      stageEnv(tsc, join(dir, "options.heap")),
    );
    expect(shown.status).toBe("passed");
    const options = readFileSync(log, "utf8");
    expect(options).toContain("--max-old-space-size=4096");
    expect(options).toContain(`--require "${PRELOAD}"`);
  });

  it("the lint stage's options reach ESLint's Node with lint.ts's cap added", async () => {
    const dir = scratch();
    const file = join(dir, "lint.heap");
    const env = stageEnv(lint, file)!;
    expect(env.ISOMUX_HEAP_REPORT).toBe(file);
    // lint.ts appends its cap to the NODE_OPTIONS it inherits.
    const run = await runNode("0;", {
      ...env,
      NODE_OPTIONS: eslintNodeOptions(env.NODE_OPTIONS),
    });
    expect(run.code).toBe(0);
    expect(readHeapReport(readFileSync(file, "utf8"))).toMatchObject({
      heaps: 1,
      lost: 0,
    });
  });
});

describe("the CI summary", () => {
  // The lines printSummary writes, with heapFor naming one report per stage.
  function summary(
    results: Parameters<typeof printSummary>[0],
    dir: string,
  ): string[] {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(...String(line).split("\n"));
    try {
      printSummary(results, 1, (name) => join(dir, `${name}.heap`));
    } finally {
      console.log = log;
    }
    return lines;
  }
  const passed = (name: "format:check" | "lint" | "tsc") => ({
    name,
    log: "",
    seconds: 1,
    status: "passed" as const,
    exitCode: 0,
  });

  it("ends with the heap lines of each heap stage that ran, read from its report", () => {
    const dir = scratch();
    const text = report(start(1, 0), end(1, 0, 900 * MIB, 1000 * MIB));
    // A report for every stage: only the heap stages may print one.
    for (const name of ["format:check", "lint", "tsc"])
      writeFileSync(join(dir, `${name}.heap`), text);
    const lines = summary(
      [
        passed("format:check"),
        passed("lint"),
        { ...passed("tsc"), status: "skipped", reason: "x" },
      ],
      dir,
    );
    const lint = heapLines("lint", readHeapReport(text));
    // The condition the check rests on: a warning is due for this report.
    expect(lint.length).toBeGreaterThan(1);
    expect(lines.slice(-lint.length)).toEqual(lint);
    // Nothing from the skipped heap stage or the stage with no heap.
    const others = [
      ...heapLines("tsc", readHeapReport(text)),
      ...heapLines("format:check", readHeapReport(text)),
    ];
    expect(lines.filter((line) => others.includes(line))).toEqual([]);
  });

  it("reads a heap stage with no report file as no report", () => {
    const dir = scratch();
    const lines = summary(
      [{ ...passed("tsc"), status: "failed", exitCode: 1 }],
      dir,
    );
    const expected = heapLines("tsc", undefined);
    expect(lines.slice(-expected.length)).toEqual(expected);
  });
});
