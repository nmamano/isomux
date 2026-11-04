// Runs the `bun test` suite as several `bun test` processes at once. In one
// process the suite took 276 s on a 28-thread desktop (2026-10-06) and left
// most threads idle.
//
// Processes do not share state: the preload gives each one its own ISOMUX_HOME
// and app port block, and control-plane/testing/pg.ts names its schemas by pid.
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  type Stats,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative } from "node:path";

// Bun's rule (1.3.11): a name with one of these suffixes and a JS or TS
// extension, outside node_modules and dot directories. Bun follows symbolic
// links and runs a file that two paths reach once. It fails on a broken link,
// so a broken link stays in the list and its process fails too. The walk stops
// at a link back to a directory it is in; bun's own scan of such a loop is not
// stable (task ec7fb691).
export const TEST_FILE =
  /(\.test|_test|\.spec|_spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

export function testFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, ancestors: Set<string>) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      let target: Stats | undefined;
      try {
        target = statSync(path);
      } catch {
        // A broken link.
      }
      if (target?.isDirectory()) {
        const real = realpathSync(path);
        if (
          !entry.name.startsWith(".") &&
          entry.name !== "node_modules" &&
          !ancestors.has(real)
        )
          walk(path, new Set(ancestors).add(real));
      } else if (target?.isFile() !== false && TEST_FILE.test(entry.name)) {
        found.push(relative(root, path));
      }
    }
  };
  walk(root, new Set([realpathSync(root)]));
  const seen = new Set<string>();
  return found.sort().filter((file) => {
    let real: string;
    try {
      real = realpathSync(join(root, file));
    } catch {
      return true;
    }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

// Half the threads: a test process also runs the servers, shells and git
// children of its tests.
export const MAX_WORKERS = 8;
export function workerCount(threads = availableParallelism()): number {
  return Math.max(1, Math.min(MAX_WORKERS, Math.floor(threads / 2)));
}

// The DOM files share a few processes: in a process of its own a DOM file
// took three to five times as long (2026-10-07), because each process loads
// the UI module graph once, and ui/test-support/dom.ts caps each file at 5 s.
// In one process for all of them, the DOM files set the suite's wall time
// (287 files, 180 s on a loaded 8-thread box, 2026-11-02; no file got slower
// later in the process). The first UI file of each DOM process loads the
// graph inside its 5 s cap, so a cap red in that file can be the cold start.
// Every other file gets a process of its own, so a slow file never waits
// behind others.
const DOM_FILE = /\.dom\.test\.[a-z]+$/;

// These files rebuild site/docs (build-docs deletes the directory first),
// so in two processes at once one reads pages the other has just removed
// (red in CI on 2026-10-07). They share one process.
export const DOCS_BUILD_FILES = [
  "scripts/hosting-docs.test.ts",
  "scripts/indexnow.test.ts",
  "scripts/site-i18n-check.test.ts",
  "scripts/use-cases-docs.test.ts",
];

/**
 * DOM files per process, before the worker count caps the processes. Each
 * extra process costs about 11 s of cold start against a process of about
 * 50 s (four processes of 72 files, 2026-11-02).
 */
export const DOM_FILES_PER_PROCESS = 72;

/**
 * The files of each process, the DOM processes first: they are the longest.
 * The DOM files are dealt round-robin in input order, so the files of one
 * directory, which often cost the same, spread over the processes.
 */
export function plan(files: string[], workers: number): string[][] {
  const domFiles = files.filter((file) => DOM_FILE.test(file));
  const count = Math.min(
    workers,
    Math.ceil(domFiles.length / DOM_FILES_PER_PROCESS),
  );
  const dom = Array.from({ length: count }, (_, process) =>
    domFiles.filter((_, index) => index % count === process),
  );
  const docs = files.filter((file) => DOCS_BUILD_FILES.includes(file));
  const rest = files
    .filter((file) => !DOM_FILE.test(file) && !docs.includes(file))
    .map((file) => [file]);
  return [...dom, ...(docs.length > 0 ? [docs] : []), ...rest];
}

export type Counts = {
  pass: number;
  skip: number;
  todo: number;
  fail: number;
  tests: number;
  files: number;
};

export type FileResult = {
  files: string[];
  exitCode: number;
  seconds: number;
  counts: Counts | undefined;
};

const noCounts = (): Counts => ({
  pass: 0,
  skip: 0,
  todo: 0,
  fail: 0,
  tests: 0,
  files: 0,
});

const COUNT_LINE = /^\s*(\d+) (pass|skip|todo|fail)$/;
const RAN_LINE = /^Ran (\d+) tests? across (\d+) files?\./;

/** The counts one process printed, or undefined when it printed no summary. */
export function parseCounts(output: string): Counts | undefined {
  const counts = noCounts();
  let ran = false;
  for (const line of output.split(/\r?\n/)) {
    const count = COUNT_LINE.exec(line);
    if (count) counts[count[2] as keyof Counts] = Number(count[1]);
    const summary = RAN_LINE.exec(line);
    if (summary) {
      ran = true;
      counts.tests = Number(summary[1]);
      counts.files = Number(summary[2]);
    }
  }
  return ran ? counts : undefined;
}

// An error between tests exits 1 with no failed test.
export function failed(result: FileResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.counts === undefined ||
    result.counts.fail > 0
  );
}

export function total(results: FileResult[]): Counts {
  const sum = noCounts();
  for (const { counts } of results) {
    if (!counts) continue;
    for (const key of Object.keys(sum) as Array<keyof Counts>)
      sum[key] += counts[key];
  }
  return sum;
}

const label = (files: string[]) =>
  files.length === 1 ? files[0] : `${files[0]} and ${files.length - 1} more`;

async function runFiles(
  files: string[],
  log: string,
): Promise<FileResult & { output: string }> {
  const started = performance.now();
  // One file for both streams keeps their order.
  const fd = openSync(log, "w");
  let exitCode: number;
  try {
    exitCode = await Bun.spawn(["bun", "test", ...files.map((f) => `./${f}`)], {
      stdout: fd,
      stderr: fd,
    }).exited;
  } finally {
    closeSync(fd);
  }
  const output = readFileSync(log, "utf8");
  return {
    files,
    exitCode,
    seconds: (performance.now() - started) / 1_000,
    counts: parseCounts(output),
    output,
  };
}

async function main(): Promise<void> {
  const files = testFiles(process.cwd());
  if (files.length === 0) {
    // bun test exits 1 here too: a suite that found nothing did not pass.
    console.error(`no test files under ${process.cwd()}`);
    process.exitCode = 1;
    return;
  }
  const workers = workerCount();
  const queue = plan(files, workers);
  const logs = mkdtempSync(join(tmpdir(), "isomux-test-shards-"));
  const started = performance.now();
  console.log(
    `${files.length} test files in ${queue.length} processes, ${workers} at a time`,
  );

  const results: FileResult[] = [];
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: workers }, async (_, worker) => {
        while (next < queue.length) {
          const { output, ...result } = await runFiles(
            queue[next++],
            join(logs, `${worker}.log`),
          );
          // One write per process, so outputs never interleave.
          process.stdout.write(
            `\n# ${label(result.files)} [${result.seconds.toFixed(2)}s]\n` +
              (output.endsWith("\n") ? output : `${output}\n`),
          );
          results.push(result);
        }
      }),
    );
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }

  const seconds = (performance.now() - started) / 1_000;
  const slowest = [...results].sort((a, b) => b.seconds - a.seconds);
  console.log("\nslowest processes:");
  for (const result of slowest.slice(0, 5))
    console.log(`  ${result.seconds.toFixed(2)}s ${label(result.files)}`);
  const red = results.filter(failed);
  for (const result of red)
    console.log(
      `✗ ${label(result.files)} (exit ${result.exitCode}${result.counts ? "" : ", no summary"})`,
    );
  const sum = total(results);
  console.log("");
  for (const key of ["pass", "skip", "todo", "fail"] as const)
    if (key !== "todo" || sum.todo > 0) console.log(` ${sum[key]} ${key}`);
  console.log(
    `Ran ${sum.tests} tests across ${sum.files} files. [${seconds.toFixed(2)}s]`,
  );
  if (red.length > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
