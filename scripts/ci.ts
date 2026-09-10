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

type StageName =
  | "format:check"
  | "lint"
  | "tsc"
  | "build:ui"
  | "bun test"
  | "ci:web";

type StageResult = {
  name: StageName;
  log: string;
  seconds: number;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  reason?: string;
};

const stages: Array<{ name: StageName; command: string[] }> = [
  { name: "format:check", command: ["bun", "run", "format:check"] },
  { name: "lint", command: ["bun", "run", "lint"] },
  { name: "tsc", command: ["bun", "x", "tsc", "--noEmit"] },
  { name: "build:ui", command: ["bun", "run", "build:ui"] },
  { name: "bun test", command: ["bun", "test"] },
  { name: "ci:web", command: ["bun", "run", "ci:web"] },
];

// Twice the latest completed bun test STEP (not the whole battery):
// 1153.47s on 2026-09-10,
// /tmp/isomux-pre-push-20260910T041043.log (load averages not recorded).
export const BUN_TEST_CEILING_MS = 2 * 1_153_470;
export function ceilingFor(name: StageName): number | undefined {
  return name === "bun test" ? BUN_TEST_CEILING_MS : undefined;
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
    return tail.subarray(0, count).toString("utf8").trimEnd().split(/\r?\n/).at(-1) || "(no output)";
  } finally {
    closeSync(fd);
  }
}

export async function runStage(
  name: StageName,
  command: string[],
  log: string,
  timeoutMs = ceilingFor(name),
  waitForExit: (child: ReturnType<typeof Bun.spawn>) => Promise<number> = (child) => child.exited,
): Promise<StageResult> {
  const fd = openSync(log, "w");
  const started = performance.now();
  console.log(`→ ${name}`);

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let exitCode: number;
  try {
    child = Bun.spawn(command, { stdout: fd, stderr: fd, detached: true });
    children.add(child);
    const runningChild = child;
    const deadline = timeoutMs === undefined ? new Promise<number>(() => {}) : new Promise<number>((resolve, reject) => {
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
  };
}

function definition(name: StageName): { name: StageName; command: string[] } {
  return stages.find((stage) => stage.name === name)!;
}

function printLog(result: StageResult): void {
  console.log(`\n=== ${result.name} output ===`);
  const bytes = readFileSync(result.log);
  if (bytes.length > 0) process.stdout.write(bytes);
  if (bytes.length > 0 && bytes.at(-1) !== 10) process.stdout.write("\n");
}

function printSummary(results: StageResult[], seconds: number): void {
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
}

async function main(): Promise<void> {
  const logDir = mkdtempSync(join(tmpdir(), "isomux-ci-"));
  process.once("SIGINT", () => stopChildren("SIGINT"));
  process.once("SIGTERM", () => stopChildren("SIGTERM"));
  const stage = (name: StageName) => runStage(
    name,
    definition(name).command,
    join(logDir, `${stages.findIndex((entry) => entry.name === name)}.log`),
  );
  const started = performance.now();

  try {
    const formatPromise = stage("format:check");
    const lintPromise = stage("lint");
    const tscPromise = stage("tsc");
    const buildPromise = stage("build:ui");
    const webPromise = stage("ci:web");
    const testPromise = buildPromise.then((build) => {
      if (build.status === "passed") {
        return stage("bun test");
      }
      console.log("↷ bun test skipped (build:ui failed)");
      return {
        name: "bun test" as const,
        log: join(logDir, "4.log"),
        seconds: 0,
        status: "skipped" as const,
        reason: "build:ui failed",
      };
    });

    const results = await Promise.all([
      formatPromise,
      lintPromise,
      tscPromise,
      buildPromise,
      testPromise,
      webPromise,
    ]);
    const seconds = (performance.now() - started) / 1_000;
    const failed = results.filter((result) => result.status === "failed");

    for (const result of results) {
      if (result.status === "passed") printLog(result);
    }
    printSummary(results, seconds);
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
