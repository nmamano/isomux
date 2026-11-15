import {
  appendFileSync,
  closeSync,
  fstatSync,
  readSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
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
  | "container"
  | "install smoke"
  | "audit";

type StageResult = {
  name: StageName;
  log: string;
  seconds: number;
  /** warned: a warnOnly stage that did not pass. It does not fail CI. */
  status: "passed" | "failed" | "warned" | "skipped";
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
  /** A stage that does not pass warns: it never fails CI. */
  warnOnly?: boolean;
  /**
   * The stage command's exit code for an infra failure: the stage then runs
   * once more, with its own ceiling. Its log's cause lines go in the reason.
   */
  retryOnExit?: number;
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
  {
    name: "ci:web",
    command: ["bun", "run", "ci:web"],
    // A gate run on the remote runs it too (scripts/ci-remote.sh --gate):
    // 1.79 GiB peak for its whole cgroup, 2026-11-04, task 2cd2741a.
    peakRss: 3 * 1024 ** 3,
  },
  // The release image check (build, smoke, Compose) on the committed HEAD.
  // The release workflow runs the same scripts; without this stage they
  // drifted and two release tags published no image.
  { name: "container", command: ["bash", "deploy/container/check.sh", "HEAD"] },
  // deploy/install.sh on a server image that already holds its apt packages,
  // through the server routes it calls (claim, public access, invite), then
  // the office checks. No path filter decides when it runs: a server change
  // the installer depends on broke fresh installs and passed CI (task
  // d5249443).
  {
    name: "install smoke",
    command: ["bash", "scripts/install-smoke/run.sh", "installer-gate", "HEAD"],
    // run.sh exits 75 when a step failed on the network or the box, not on
    // isomux (its "cause:" line says which); a product failure exits 1 and
    // a wall-clock kill has no cause, so neither runs again (task d381f3e2).
    retryOnExit: 75,
  },
  // Critical and high advisories in the runtime dependencies of both
  // lockfiles. It reads the registry's advisory list, which changes with no
  // commit here, so it warns and never fails CI (task c33cb42f).
  { name: "audit", command: ["bun", "run", "audit:runtime"], warnOnly: true },
];

// Twice the latest completed bun test STEP (not the whole battery):
// 1153.47s on 2026-09-10,
// /tmp/isomux-pre-push-20260910T041043.log (load averages not recorded).
export const BUN_TEST_CEILING_MS = 2 * 1_153_470;
// Twice a measured `bun run test:opencode:ci`: 132.02s on 2026-10-19,
// /tmp/t-feafdecb/ceil.log (load average 1.26 at the start).
const OPENCODE_LIVE_CEILING_MS = 2 * 132_020;
// Twice a measured install smoke stage with a cold box image (the image
// layer of apt packages rebuilt, as after a package list change): 174s on an
// idle remote on 2026-11-07, /tmp/t-d5249443/gate1.log there. With the layer
// cached, the stage took 96.70s in a full ci:remote run on 2026-11-07,
// /tmp/t-d5249443/ci.log (load average 6.68 at the end).
const INSTALL_SMOKE_CEILING_MS = 2 * 174_000;
// The audit stage asks the npm registry twice: under a second each on
// 2026-11-08 (/tmp/t-c33cb42f/ar.log). The limit only stops a registry that
// does not answer from holding CI open.
const AUDIT_CEILING_MS = 120_000;
export function ceilingFor(name: StageName): number | undefined {
  if (name === "bun test") return BUN_TEST_CEILING_MS;
  if (name === "opencode live") return OPENCODE_LIVE_CEILING_MS;
  if (name === "install smoke") return INSTALL_SMOKE_CEILING_MS;
  if (name === "audit") return AUDIT_CEILING_MS;
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

/** One run of a stage command, its output written to `log` (`flags` "w" or "a"). */
type Try = {
  exitCode: number;
  timedOut: boolean;
  peakRssBytes?: number;
};

async function runTry(
  command: string[],
  log: string,
  flags: "w" | "a",
  timeoutMs: number | undefined,
  waitForExit: (child: ReturnType<typeof Bun.spawn>) => Promise<number>,
  env?: Record<string, string>,
): Promise<Try> {
  const fd = openSync(log, flags);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
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
    const exitCode = await Promise.race([waitForExit(child), deadline]);
    // wait4 reports the largest of the child and its waited descendants.
    return { exitCode, timedOut, peakRssBytes: child.resourceUsage()?.maxRSS };
  } finally {
    clearTimeout(timer);
    if (child) children.delete(child);
    closeSync(fd);
  }
}

// The last cause line in a stage log (scripts/install-smoke/run.sh prints one
// per failed step) from byte `from` on, without its prefix.
function causeIn(log: string, from = 0): string | undefined {
  let text = "";
  try {
    text = readFileSync(log).subarray(from).toString("utf8");
  } catch {
    return undefined;
  }
  const causes = [...text.matchAll(/^\[smoke:[^\]]+\] cause: (.+)$/gm)];
  return causes.at(-1)?.[1];
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
  warnOnly: boolean = definition(name).warnOnly ?? false,
): Promise<StageResult> {
  const started = performance.now();
  const retryOnExit = definition(name).retryOnExit;
  console.log(`→ ${name}`);

  const limit = () =>
    `wall-clock limit ${timeoutMs}ms exceeded; last test line: ${lastTestLine(log)}`;
  // What one try of a stage with cause classes ended with.
  const outcome = (attempt: Try, cause: string | undefined) =>
    attempt.timedOut
      ? `cause: timeout; ${limit()}`
      : `cause: ${cause ?? "not recorded"}`;

  const first = await runTry(command, log, "w", timeoutMs, waitForExit, env);
  let last = first;
  let reason: string | undefined;
  if (
    retryOnExit !== undefined &&
    !first.timedOut &&
    first.exitCode === retryOnExit &&
    !interruptedSignal
  ) {
    // An infra failure (the stage's own exit code for it): one more try,
    // with its own ceiling. The log keeps both tries.
    const firstOutcome = outcome(first, causeIn(log));
    console.log(`↻ ${name}: infra failure (${firstOutcome}); one more try`);
    appendFileSync(log, `\n=== ${name}: try 2 (try 1: ${firstOutcome}) ===\n`);
    // Try 2's cause comes from its own output only.
    const tryTwoStart = statSync(log).size;
    last = await runTry(command, log, "a", timeoutMs, waitForExit, env);
    const secondOutcome = outcome(last, causeIn(log, tryTwoStart));
    reason =
      !last.timedOut && last.exitCode === 0
        ? `passed on try 2; try 1: ${firstOutcome}`
        : `try 1: ${firstOutcome}; try 2: ${secondOutcome}`;
  } else if (last.timedOut) {
    reason = retryOnExit === undefined ? limit() : outcome(last, undefined);
  } else if (retryOnExit !== undefined && last.exitCode !== 0) {
    const cause = causeIn(log);
    if (cause !== undefined) reason = `cause: ${cause}`;
  }
  const peakRssBytes =
    first === last || first.peakRssBytes === undefined
      ? last.peakRssBytes
      : Math.max(first.peakRssBytes, last.peakRssBytes ?? 0);
  const { exitCode, timedOut } = last;
  const seconds = (performance.now() - started) / 1_000;
  const passed = !timedOut && exitCode === 0;
  const mark = warnOnly ? "!" : "✗";
  const verb = warnOnly ? "warned" : "failed";
  console.log(
    passed
      ? `✓ ${name} ${seconds.toFixed(2)}s${reason ? ` (${reason})` : ""}`
      : timedOut
        ? `${mark} ${name} ${verb} (${reason})`
        : `${mark} ${name} ${verb} (exit ${exitCode}) ${seconds.toFixed(2)}s${reason ? ` (${reason})` : ""}`,
  );

  return {
    name,
    log,
    seconds,
    status: passed ? "passed" : warnOnly ? "warned" : "failed",
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

/**
 * The verdict of one CI run: `failed` decides the exit code and the
 * "CI failed" line; `shown` lists, in result order, the stages whose logs
 * print after the summary (the failed and the warned ones).
 */
export function ciVerdict(results: StageResult[]): {
  failed: StageResult[];
  shown: StageResult[];
} {
  return {
    failed: results.filter((result) => result.status === "failed"),
    shown: results.filter(
      (result) => result.status === "failed" || result.status === "warned",
    ),
  };
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
  const installSmoke = docker
    ? stage("install smoke")
    : skipped("install smoke", "no Docker");
  // Needs neither the UI build nor Docker, and gates nothing: it only warns.
  const audit = stage("audit");
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
    installSmoke,
    audit,
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
    const { failed, shown } = ciVerdict(results);

    for (const result of results) {
      if (result.status === "passed") printLog(result);
    }
    printSummary(results, seconds, heapFor);
    for (const result of shown) printLog(result);

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
