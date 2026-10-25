import { readFileSync } from "node:fs";

const ESLINT_HEAP_MB = 4_096;

const GIB = 1024 ** 3;
// ESLint threads cost memory, and parallel CI stages once had earlyoom kill
// agents on a busy box. Measured 2026-10-07 on the whole tree: no threads
// peaked at 3.3 GiB, four at 7.5 GiB, so about 1.05 GiB a thread; a desktop
// `bun run ci` with no lint threads took 5.65 GiB of available memory. The
// reserve keeps the rest of CI and the machine clear of the threads.
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

function spawnEslint(fix: boolean): EslintRun {
  return async (concurrency) => {
    const child = Bun.spawn(eslintCommand(fix, concurrency), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        NODE_OPTIONS: eslintNodeOptions(process.env.NODE_OPTIONS),
      },
    });
    const code = await child.exited;
    return { code, signal: child.signalCode };
  };
}

export async function runLint(
  fix: boolean,
  run: EslintRun = spawnEslint(fix),
  available: number | undefined = availableMemory(),
): Promise<number> {
  const concurrency = lintConcurrency(available);
  console.log(
    `eslint threads: ${concurrency}` +
      (available === undefined
        ? " (available memory unknown)"
        : ` (${(available / GIB).toFixed(1)} GiB available)`),
  );
  const first = await run(concurrency);
  if (first.code < CRASH_EXIT) return first.code;
  console.error(
    `eslint crashed (${exitText(first)}), not a lint finding; running it again with threads off`,
  );
  const second = await run("off");
  if (second.code >= CRASH_EXIT)
    console.error(`eslint crashed again (${exitText(second)})`);
  return second.code;
}

if (import.meta.main)
  process.exitCode = await runLint(process.argv.includes("--fix"));
