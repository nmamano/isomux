import {
  closeSync,
  fstatSync,
  readSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heapEnv, heapLines, readHeapReport, rssLines } from "./heap-report";

type StageName =
  | "format:check"
  | "lint"
  | "tsc"
  | "build:ui"
  | "bun test"
  | "opencode live"
  | "ci:web"
  | "container";

type StageResult = {
  name: StageName;
  log: string;
  seconds: number;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  reason?: string;
  /** The largest RSS of the stage's processes, in bytes. */
  peakRssBytes?: number;
};

type Stage = {
  name: StageName;
  command: string[];
  /** The summary reports the stage's heap use (scripts/heap-report.ts). */
  heap?: boolean;
  /** The summary reports the stage's peak RSS against this budget, in bytes. */
  peakRss?: number;
};

export const stages: Stage[] = [
  { name: "format:check", command: ["bun", "run", "format:check"] },
  // scripts/lint.ts sets ESLint's heap cap, and fails a lint whose last ESLint
  // run has a heap that did not report.
  { name: "lint", command: ["bun", "run", "lint"], heap: true },
  {
    name: "tsc",
    // The native compiler (TS 7): no Node heap, so the summary reports the
    // peak RSS of its largest partition (scripts/typecheck.ts) against a
    // remote gate slot (GATE_SLOTS in scripts/ci-remote.sh).
    command: ["bun", "run", "typecheck"],
    peakRss: 3 * 1024 ** 3,
  },
  { name: "build:ui", command: ["bun", "run", "build:ui"] },
  { name: "bun test", command: ["bun", "scripts/test-shards.ts"] },
  // The OpenCode live tier on a pinned server and mock providers: no key, no
  // model credits. It runs after bun test, never beside it: its first-reply
  // waits fail under load.
  { name: "opencode live", command: ["bun", "run", "test:opencode:ci"] },
  { name: "ci:web", command: ["bun", "run", "ci:web"] },
  // The release image check (build, smoke, Compose) on the committed HEAD.
  // The release workflow runs the same scripts; without this stage they
  // drifted and two release tags published no image.
  { name: "container", command: ["bash", "deploy/container/check.sh", "HEAD"] },
];

// Twice the latest completed bun test STEP (not the whole battery):
// 1153.47s on 2026-09-10,
// /tmp/isomux-pre-push-20260910T041043.log (load averages not recorded).
export const BUN_TEST_CEILING_MS = 2 * 1_153_470;
// Twice a measured `bun run test:opencode:ci`: 132.02s on 2026-10-19,
// /tmp/t-feafdecb/ceil.log (load average 1.26 at the start).
const OPENCODE_LIVE_CEILING_MS = 2 * 132_020;
export function ceilingFor(name: StageName): number | undefined {
  if (name === "bun test") return BUN_TEST_CEILING_MS;
  if (name === "opencode live") return OPENCODE_LIVE_CEILING_MS;
  return undefined;
}

const children = new Set<ReturnType<typeof Bun.spawn>>();
let interruptedSignal: NodeJS.Signals | undefined;

function stopChildren(signal: NodeJS.Signals): void {
  interruptedSignal = signal;
  for (const child of children) killStage(child, signal);
}

function processGroup(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm can contain spaces and parentheses; fields after it start at state.
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return undefined;
  }
}

export function killStage(
  child: ReturnType<typeof Bun.spawn>,
  signal: NodeJS.Signals,
): void {
  const pgid = processGroup(child.pid);
  const ownPgid = processGroup(process.pid);
  try {
    if (pgid === child.pid && ownPgid !== undefined && pgid !== ownPgid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function lastTestLine(log: string): string {
  const fd = openSync(log, "r");
  try {
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 8192));
    const count = readSync(fd, tail, 0, tail.length, size - tail.length);
    return (
      tail
        .subarray(0, count)
        .toString("utf8")
        .trimEnd()
        .split(/\r?\n/)
        .at(-1) || "(no output)"
    );
  } finally {
    closeSync(fd);
  }
}

export async function runStage(
  name: StageName,
  command: string[],
  log: string,
  timeoutMs = ceilingFor(name),
  waitForExit: (child: ReturnType<typeof Bun.spawn>) => Promise<number> = (
    child,
  ) => child.exited,
  env?: Record<string, string>,
): Promise<StageResult> {
  const fd = openSync(log, "w");
  const started = performance.now();
  console.log(`→ ${name}`);

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let exitCode: number;
  let peakRssBytes: number | undefined;
  try {
    child = Bun.spawn(command, {
      stdout: fd,
      stderr: fd,
      detached: true,
      env: env ? { ...process.env, ...env } : undefined,
    });
    children.add(child);
    const runningChild = child;
    const deadline =
      timeoutMs === undefined
        ? new Promise<number>(() => {})
        : new Promise<number>((resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              try {
                // Kill descendants too, including shells blocked in synchronous calls.
                killStage(runningChild, "SIGKILL");
                // A missed exit notification must not hold CI open after the deadline.
                runningChild.unref();
                resolve(124);
              } catch (error) {
                reject(error);
              }
            }, timeoutMs);
          });
    exitCode = await Promise.race([waitForExit(child), deadline]);
    // wait4 reports the largest of the child and its waited descendants.
    peakRssBytes = child.resourceUsage()?.maxRSS;
  } finally {
    clearTimeout(timer);
    if (child) children.delete(child);
    closeSync(fd);
  }
  const reason = timedOut
    ? `wall-clock limit ${timeoutMs}ms exceeded; last test line: ${lastTestLine(log)}`
    : undefined;
  const seconds = (performance.now() - started) / 1_000;
  console.log(
    timedOut
      ? `✗ ${name} failed (${reason})`
      : exitCode === 0
        ? `✓ ${name} ${seconds.toFixed(2)}s`
        : `✗ ${name} failed (exit ${exitCode}) ${seconds.toFixed(2)}s`,
  );

  return {
    name,
    log,
    seconds,
    status: !timedOut && exitCode === 0 ? "passed" : "failed",
    exitCode,
    reason,
    peakRssBytes,
  };
}

function definition(name: StageName): Stage {
  return stages.find((stage) => stage.name === name)!;
}

/**
 * The extra environment of one stage: for a heap stage, the heap report to
 * `reportPath` after the inherited NODE_OPTIONS. Undefined for other stages.
 */
export function stageEnv(
  stage: Stage,
  reportPath: string,
  inherited = process.env.NODE_OPTIONS,
): Record<string, string> | undefined {
  return stage.heap ? heapEnv(reportPath, inherited) : undefined;
}

function printLog(result: StageResult): void {
  console.log(`\n=== ${result.name} output ===`);
  const bytes = readFileSync(result.log);
  if (bytes.length > 0) process.stdout.write(bytes);
  if (bytes.length > 0 && bytes.at(-1) !== 10) process.stdout.write("\n");
}

export function printSummary(
  results: StageResult[],
  seconds: number,
  heapFor: (name: StageName) => string,
): void {
  console.log("\n=== CI summary ===");
  for (const result of results) {
    const detail =
      result.status === "skipped"
        ? `skipped (${result.reason})`
        : `${result.status} (exit ${result.exitCode}${result.reason ? `; ${result.reason}` : ""})`;
    console.log(
      `${result.name.padEnd(14)} ${detail.padEnd(32)} ${result.seconds.toFixed(2)}s`,
    );
  }
  console.log(`${"total".padEnd(14)} ${seconds.toFixed(2)}s`);
  for (const result of results) {
    if (result.status === "skipped") continue;
    const { heap, peakRss } = definition(result.name);
    if (peakRss !== undefined)
      for (const line of rssLines(result.name, result.peakRssBytes, peakRss))
        console.log(line);
    if (!heap) continue;
    let report = "";
    try {
      report = readFileSync(heapFor(result.name), "utf8");
    } catch {
      // No heap started: readHeapReport reads that as no report.
    }
    for (const line of heapLines(result.name, readHeapReport(report)))
      console.log(line);
  }
}

// A usable Docker is a CLI that reaches its daemon.
export function hasDocker(PATH = process.env.PATH ?? ""): boolean {
  const docker = Bun.which("docker", { PATH });
  if (docker === null) return false;
  return (
    Bun.spawnSync([docker, "version"], { stdout: "ignore", stderr: "ignore" })
      .exitCode === 0
  );
}

export async function runPipeline(
  stage: (name: StageName) => Promise<StageResult>,
  logFor: (name: StageName) => string,
  docker: boolean,
): Promise<StageResult[]> {
  const skipped = (name: StageName, reason: string): StageResult => {
    console.log(`↷ ${name} skipped (${reason})`);
    return { name, log: logFor(name), seconds: 0, status: "skipped", reason };
  };
  const format = stage("format:check");
  const lint = stage("lint");
  const types = stage("tsc");
  // Only this stage builds the UI/extension archive; tests wait for its result.
  const build = stage("build:ui");
  const web = stage("ci:web");
  // ci:remote and GitHub always have Docker; only a local run can lack it.
  const container = docker
    ? stage("container")
    : skipped("container", "no Docker");
  const tests = build.then((result): Promise<StageResult> | StageResult =>
    result.status === "passed"
      ? stage("bun test")
      : skipped("bun test", "build:ui failed"),
  );
  const openCode = tests.then((result): Promise<StageResult> | StageResult =>
    result.status === "passed"
      ? stage("opencode live")
      : skipped("opencode live", `bun test ${result.status}`),
  );
  return Promise.all([
    format,
    lint,
    types,
    build,
    tests,
    openCode,
    web,
    container,
  ]);
}

async function main(): Promise<void> {
  const logDir = mkdtempSync(join(tmpdir(), "isomux-ci-"));
  process.once("SIGINT", () => stopChildren("SIGINT"));
  process.once("SIGTERM", () => stopChildren("SIGTERM"));
  const logFor = (name: StageName) =>
    join(logDir, `${stages.findIndex((entry) => entry.name === name)}.log`);
  const heapFor = (name: StageName) => `${logFor(name)}.heap`;
  const stage = (name: StageName) =>
    runStage(
      name,
      definition(name).command,
      logFor(name),
      undefined,
      undefined,
      stageEnv(definition(name), heapFor(name)),
    );
  const started = performance.now();

  try {
    const results = await runPipeline(stage, logFor, hasDocker());
    const seconds = (performance.now() - started) / 1_000;
    const failed = results.filter((result) => result.status === "failed");

    for (const result of results) {
      if (result.status === "passed") printLog(result);
    }
    printSummary(results, seconds, heapFor);
    for (const result of failed) printLog(result);

    if (failed.length > 0 || interruptedSignal) {
      const names = failed.map((result) => result.name).join(", ");
      console.error(
        interruptedSignal
          ? `\nCI interrupted by ${interruptedSignal}`
          : `\nCI failed: ${names}`,
      );
      process.exitCode = interruptedSignal === "SIGINT" ? 130 : 1;
    }
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
