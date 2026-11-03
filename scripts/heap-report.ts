import { join } from "node:path";

/** Warn when a heap reaches this share of its V8 limit. */
export const HEAP_WARN_RATIO = 0.8;

/**
 * The worst heap of one stage, from the preload's report. `heaps` counts the
 * heaps that reported at exit, in every run; `lost` counts those of the last
 * run that started and never reported, as when V8 aborts on its heap limit.
 */
export type HeapUse = {
  peakBytes: number;
  limitBytes: number;
  heaps: number;
  lost: number;
  /** How each crashed ESLint run before the last one ended, from its crash marker. */
  crashes: string[];
};

const PRELOAD = join(import.meta.dir, "heap-preload.cjs");
const GIB = 1024 ** 3;

type Line = {
  start?: boolean;
  end?: boolean;
  pid?: number;
  threadId?: number;
  peak?: number;
  limit?: number;
  run?: boolean;
  crashed?: string;
};

function parse(line: string): Line | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null
      ? (value as Line)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The report line lint.ts writes before each ESLint run. */
export function runMarker(threads: string): string {
  return `${JSON.stringify({ run: true, threads })}\n`;
}

/** The report line lint.ts writes after an ESLint run that crashed. */
export function crashMarker(ending: string): string {
  return `${JSON.stringify({ crashed: ending })}\n`;
}

/**
 * Reads the JSONL report of scripts/heap-preload.cjs. Run markers split it
 * into ESLint runs: `lost` counts the last run only, since an earlier run
 * that crashed and ran again is named in `crashes`. A report with no marker
 * is one run.
 */
export function readHeapReport(text: string): HeapUse | undefined {
  let started = new Set<string>();
  let ended = new Set<string>();
  let heaps = 0;
  const crashes: string[] = [];
  let worst: { peak: number; limit: number } | undefined;
  for (const line of text.split("\n")) {
    const entry = parse(line);
    if (!entry) continue;
    if (entry.run === true) {
      heaps += ended.size;
      started = new Set();
      ended = new Set();
      continue;
    }
    if (typeof entry.crashed === "string") {
      crashes.push(entry.crashed);
      continue;
    }
    // The lint retry reuses thread ids in a new process.
    const heap = `${entry.pid}/${entry.threadId}`;
    if (entry.start) started.add(heap);
    if (
      entry.end &&
      typeof entry.peak === "number" &&
      typeof entry.limit === "number" &&
      entry.limit > 0
    ) {
      ended.add(heap);
      if (!worst || entry.peak / entry.limit > worst.peak / worst.limit)
        worst = { peak: entry.peak, limit: entry.limit };
    }
  }
  heaps += ended.size;
  const lost = [...started].filter((heap) => !ended.has(heap)).length;
  if (heaps === 0 && lost === 0) return undefined;
  return {
    peakBytes: worst?.peak ?? 0,
    limitBytes: worst?.limit ?? 0,
    heaps,
    lost,
    crashes,
  };
}

const gib = (bytes: number) => `${(bytes / GIB).toFixed(2)} GiB`;

/** The summary line for one stage, and a warning line when one is due. */
export function heapLines(stage: string, use: HeapUse | undefined): string[] {
  const name = `${stage} heap`.padEnd(14);
  // A crashed run lost its heaps, and the run after it is the verdict.
  const crashes = (use?.crashes ?? []).map(
    (ending) => `⚠ ${stage}: ESLint crashed (${ending}) and ran again`,
  );
  if (!use || use.heaps === 0)
    return [
      `${name} no report`,
      `⚠ ${stage} heap: no heap reported; a heap may have hit its V8 limit`,
      ...crashes,
    ];
  const share = use.peakBytes / use.limitBytes;
  const lines = [
    `${name} ${gib(use.peakBytes)} of ${gib(use.limitBytes)} V8 limit (${Math.floor(share * 100)}%)` +
      (use.heaps > 1 ? `, worst of ${use.heaps} heaps` : ""),
  ];
  if (share >= HEAP_WARN_RATIO)
    lines.push(
      `⚠ ${stage} heap at ${Math.floor(share * 100)}% of its V8 limit: raise the cap or cut the use before it breaks CI`,
    );
  if (use.lost > 0)
    lines.push(
      `⚠ ${stage} heap: ${use.lost} ${use.lost === 1 ? "heap" : "heaps"} of the last run did not report; a heap may have hit its V8 limit`,
    );
  return [...lines, ...crashes];
}

/** The summary line for a stage's peak RSS, and a warning line when one is due. */
export function rssLines(
  stage: string,
  peakBytes: number | undefined,
  budgetBytes: number,
): string[] {
  const name = `${stage} memory`.padEnd(14);
  if (peakBytes === undefined)
    return [`${name} no report`, `⚠ ${stage} memory: no peak RSS reported`];
  const share = peakBytes / budgetBytes;
  const percent = Math.floor(share * 100);
  const lines = [
    `${name} ${gib(peakBytes)} peak RSS of ${gib(budgetBytes)} budget (${percent}%)`,
  ];
  if (share >= HEAP_WARN_RATIO)
    lines.push(
      `⚠ ${stage} memory at ${percent}% of its budget: cut the use, or raise the budget in scripts/ci.ts and re-size GATE_SLOTS in scripts/ci-remote.sh`,
    );
  return lines;
}

/** The environment that makes Node load the preload and report to a file. */
export function heapEnv(
  reportPath: string,
  nodeOptions?: string,
): Record<string, string> {
  return {
    ISOMUX_HEAP_REPORT: reportPath,
    NODE_OPTIONS: [nodeOptions, `--require "${PRELOAD}"`]
      .filter(Boolean)
      .join(" "),
  };
}
