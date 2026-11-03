import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashMarker, heapEnv, readHeapReport, runMarker } from "./heap-report";

const ESLINT_HEAP_MB = 4_096;

const GIB = 1024 ** 3;
// ESLint threads cost memory, and parallel CI stages once had earlyoom kill
// agents on a busy box. Measured 2026-11-02 on the whole tree: no threads
// peaked at 3.8 GiB, two at 6.4 GiB, four at 10.4 GiB (each thread builds its
// own TypeScript program); a desktop `bun run ci` with no lint threads took
// 5.65 GiB of available memory (2026-10-07). LINT_THREAD_BYTES is a budget
// below a thread's real cost (about 2.2 GiB); the reserve carries the margin
// and keeps the rest of CI and the machine clear of the threads: four threads
// start only with 21 GiB available and leave more than 10 GiB.
export const LINT_RESERVE_BYTES = 16 * GIB;
export const LINT_THREAD_BYTES = 1.25 * GIB;
export const MAX_LINT_THREADS = 4;

/** MemAvailable from /proc/meminfo, or undefined where there is none. */
export function availableMemory(meminfo?: string): number | undefined {
  if (meminfo === undefined) {
    try {
      meminfo = readFileSync("/proc/meminfo", "utf8");
    } catch {
      return undefined;
    }
  }
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  return match ? Number(match[1]) * 1024 : undefined;
}

/** ESLint threads for this much available memory: "off" below two. */
export function lintConcurrency(available: number | undefined): string {
  if (available === undefined) return "off";
  const threads = Math.min(
    MAX_LINT_THREADS,
    Math.floor((available - LINT_RESERVE_BYTES) / LINT_THREAD_BYTES),
  );
  return threads >= 2 ? String(threads) : "off";
}

export function eslintCommand(fix: boolean, concurrency = "off"): string[] {
  return [
    "bun",
    "x",
    "eslint",
    ".",
    `--concurrency=${concurrency}`,
    ...(fix ? ["--fix"] : []),
  ];
}

export function eslintNodeOptions(existing?: string): string {
  return [existing, `--max-old-space-size=${ESLINT_HEAP_MB}`]
    .filter(Boolean)
    .join(" ");
}

/**
 * The environment of an ESLint process: the heap cap after `env`'s
 * NODE_OPTIONS and, with `selfReport`, the heap preload reporting to that path.
 */
export function eslintEnv(
  env: Record<string, string | undefined>,
  selfReport?: string,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (value !== undefined) kept[key] = value;
  const self = selfReport ? heapEnv(selfReport, env.NODE_OPTIONS) : {};
  return {
    ...kept,
    ...self,
    NODE_OPTIONS: eslintNodeOptions(self.NODE_OPTIONS ?? env.NODE_OPTIONS),
  };
}

/**
 * The heap report of a lint: `self` when lint.ts loaded the preload itself
 * (no ISOMUX_HEAP_REPORT from the caller).
 */
export type LintReport = {
  self: boolean;
  read: () => string;
  append: (line: string) => void;
};

/** How one ESLint process ended. `signal` is set when a signal killed it. */
export type EslintRun = (
  concurrency: string,
) => Promise<{ code: number; signal: string | null }>;

// ESLint exits 0, 1 (findings) or 2 (config error). 128 or more means the
// process died before it reported, as when V8 aborted an ESLint thread on
// Node 24.22.1 in CI (2026-10-23, task 2e705692); Bun reports a signal death
// as 128 plus the signal number.
const CRASH_EXIT = 128;

function exitText(result: { code: number; signal: string | null }): string {
  return result.signal
    ? `exit ${result.code}, ${result.signal}`
    : `exit ${result.code}`;
}

function spawnEslint(fix: boolean, selfReport?: string): EslintRun {
  return async (concurrency) => {
    const child = Bun.spawn(eslintCommand(fix, concurrency), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: eslintEnv(process.env, selfReport),
    });
    const code = await child.exited;
    return { code, signal: child.signalCode };
  };
}

/**
 * The verdict of the last ESLint run from its part of the heap report. Every
 * heap of a clean run reported means every thread left its file loop, so
 * ESLint linted every file; a heap that did not report fails the lint.
 */
function heapVerdict(code: number, text: string, self: boolean): number {
  if (code !== 0) return code;
  const use = readHeapReport(text);
  if (use === undefined) {
    if (self) {
      // ESLint under Bun (no Node on the machine) loads no preload.
      console.log("eslint heap: no report; ESLint may not have run under Node");
      return 0;
    }
    console.error(
      "eslint heap: no heap reported, so this lint cannot show it checked every file",
    );
    return 1;
  }
  if (use.lost === 0) return 0;
  console.error(
    `eslint heap: ${use.lost} ${use.lost === 1 ? "heap" : "heaps"} did not report, so ESLint may not have checked every file`,
  );
  return 1;
}

export async function runLint(
  fix: boolean,
  run: EslintRun = spawnEslint(fix),
  available: number | undefined = availableMemory(),
  report?: LintReport,
): Promise<number> {
  // Markers go in only between ESLint runs, so no write races a heap's.
  let runStart = 0;
  const marked: EslintRun = async (threads) => {
    report?.append(runMarker(threads));
    runStart = report?.read().length ?? 0;
    return run(threads);
  };
  const verdict = (code: number) =>
    report
      ? heapVerdict(code, report.read().slice(runStart), report.self)
      : code;
  const concurrency = lintConcurrency(available);
  console.log(
    `eslint threads: ${concurrency}` +
      (available === undefined
        ? " (available memory unknown)"
        : ` (${(available / GIB).toFixed(1)} GiB available)`),
  );
  const first = await marked(concurrency);
  if (first.code < CRASH_EXIT) return verdict(first.code);
  console.error(
    `eslint crashed (${exitText(first)}), not a lint finding; running it again with threads off`,
  );
  report?.append(crashMarker(exitText(first)));
  const second = await marked("off");
  if (second.code >= CRASH_EXIT)
    console.error(`eslint crashed again (${exitText(second)})`);
  return verdict(second.code);
}

/** The heap report at `path`; `self` when lint.ts asked for it. */
function fileReport(path: string, self: boolean): LintReport {
  return {
    self,
    read: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    },
    append: (line) => appendFileSync(path, line),
  };
}

if (import.meta.main) {
  const fix = process.argv.includes("--fix");
  // CI (scripts/ci.ts) sets the report and loads the preload; otherwise, as
  // on GitHub, lint.ts loads it itself into a report of its own.
  const given = process.env.ISOMUX_HEAP_REPORT;
  const dir = given ? undefined : mkdtempSync(join(tmpdir(), "isomux-lint-"));
  const path = given ?? join(dir!, "heap.jsonl");
  try {
    process.exitCode = await runLint(
      fix,
      spawnEslint(fix, given ? undefined : path),
      availableMemory(),
      fileReport(path, !given),
    );
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
