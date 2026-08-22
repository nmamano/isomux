import {
  closeSync,
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

const logDir = mkdtempSync(join(tmpdir(), "isomux-ci-"));
const children = new Set<ReturnType<typeof Bun.spawn>>();
let interruptedSignal: NodeJS.Signals | undefined;

function stopChildren(signal: NodeJS.Signals): void {
  interruptedSignal = signal;
  for (const child of children) child.kill(signal);
}

process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));

async function runStage(
  name: StageName,
  command: string[],
): Promise<StageResult> {
  const log = join(
    logDir,
    `${stages.findIndex((stage) => stage.name === name)}.log`,
  );
  const fd = openSync(log, "w");
  const started = performance.now();
  console.log(`→ ${name}`);

  const child = Bun.spawn(command, { stdout: fd, stderr: fd });
  children.add(child);
  const exitCode = await child.exited;
  children.delete(child);
  closeSync(fd);
  const seconds = (performance.now() - started) / 1_000;
  console.log(
    exitCode === 0
      ? `✓ ${name} ${seconds.toFixed(2)}s`
      : `✗ ${name} failed (exit ${exitCode}) ${seconds.toFixed(2)}s`,
  );

  return {
    name,
    log,
    seconds,
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
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
        : `${result.status} (exit ${result.exitCode})`;
    console.log(
      `${result.name.padEnd(14)} ${detail.padEnd(32)} ${result.seconds.toFixed(2)}s`,
    );
  }
  console.log(`${"total".padEnd(14)} ${seconds.toFixed(2)}s`);
}

const started = performance.now();

try {
  const formatPromise = runStage(
    definition("format:check").name,
    definition("format:check").command,
  );
  const lintPromise = runStage(
    definition("lint").name,
    definition("lint").command,
  );
  const tscPromise = runStage(
    definition("tsc").name,
    definition("tsc").command,
  );
  const buildPromise = runStage(
    definition("build:ui").name,
    definition("build:ui").command,
  );
  const webPromise = runStage(
    definition("ci:web").name,
    definition("ci:web").command,
  );
  const testPromise = buildPromise.then((build) => {
    if (build.status === "passed") {
      return runStage(
        definition("bun test").name,
        definition("bun test").command,
      );
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
