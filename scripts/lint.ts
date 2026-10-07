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

export async function runLint(fix: boolean): Promise<number> {
  const available = availableMemory();
  const concurrency = lintConcurrency(available);
  console.log(
    `eslint threads: ${concurrency}` +
      (available === undefined
        ? " (available memory unknown)"
        : ` (${(available / GIB).toFixed(1)} GiB available)`),
  );
  const child = Bun.spawn(eslintCommand(fix, concurrency), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: eslintNodeOptions(process.env.NODE_OPTIONS),
    },
  });
  return child.exited;
}

if (import.meta.main)
  process.exitCode = await runLint(process.argv.includes("--fix"));
