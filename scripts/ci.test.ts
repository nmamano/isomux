import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN_TEST_CEILING_MS, ceilingFor, killStage } from "./ci";

const roots: string[] = [];
const descendants: string[] = [];
const CI = new URL("./ci.ts", import.meta.url).pathname;

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const file of descendants.splice(0)) {
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8").trim());
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fakeStep(
  command: string[],
  ceiling?: number,
  missingExit = false,
  fastTimers = false,
) {
  const root = mkdtempSync(join(tmpdir(), "isomux-ci-test-"));
  roots.push(root);
  const log = join(root, "step.log");
  const source = `
    import { runStage } from ${JSON.stringify(CI)};
    if (${fastTimers}) {
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, Math.min(delay, 600), ...args);
    }
    const result = await runStage("bun test", ${JSON.stringify(command)}, ${JSON.stringify(log)}, ${ceiling}${missingExit ? ", () => new Promise(() => {})" : ""});
    console.log("RESULT=" + JSON.stringify(result));
  `;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  // An independent deadline also catches a removed ceiling or an uncleared timer.
  const timer = setTimeout(() => killStage(proc, "SIGKILL"), 3_000);
  try {
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    const line = out.split("\n").find((entry) => entry.startsWith("RESULT="));
    expect(line).toBeDefined();
    return { result: JSON.parse(line!.slice(7)), out };
  } finally {
    clearTimeout(timer);
    killStage(proc, "SIGKILL");
  }
}

it("fails a slow step, reports its last line, and kills its grandchild", async () => {
  const root = mkdtempSync(join(tmpdir(), "isomux-ci-grandchild-"));
  roots.push(root);
  const pidFile = join(root, "pid");
  descendants.push(pidFile);
  const { result, out } = await fakeStep(
    [
      "sh",
      "-c",
      'sleep 60 & echo $! > "$1"; echo earlier; echo LAST_TEST_LINE >&2; wait',
      "sh",
      pidFile,
    ],
    600,
  );
  expect(result.status).toBe("failed");
  expect(result.exitCode).not.toBe(0);
  expect(result.reason).toBe(
    "wall-clock limit 600ms exceeded; last test line: LAST_TEST_LINE",
  );
  expect(out).toContain(`✗ bun test failed (${result.reason})`);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  expect(pid).toBeGreaterThan(0);
  // Signal delivery can lag the runner's return; observe death within a bound.
  const deadline = performance.now() + 5_000;
  while (alive(pid) && performance.now() < deadline) await Bun.sleep(10);
  // A killed orphan can be a zombie until PID 1 reaps it; it must not be running.
  expect(alive(pid)).toBe(false);
}, 15_000);

it("reports an empty timed-out log explicitly", async () => {
  const { result, out } = await fakeStep(["sleep", "60"], 600);
  expect(result.status).toBe("failed");
  expect(result.reason).toBe(
    "wall-clock limit 600ms exceeded; last test line: (no output)",
  );
  expect(out).toContain(result.reason);
}, 15_000);

it("preserves fast success and failure and clears the long ceiling timer", async () => {
  for (const code of [0, 7]) {
    const { result } = await fakeStep(["sh", "-c", `exit ${code}`], 60_000);
    expect(result.exitCode).toBe(code);
    expect(result.status).toBe(code === 0 ? "passed" : "failed");
    expect(result.reason).toBeUndefined();
  }
}, 15_000);

it("falls back to the child when it does not own its process group", async () => {
  const child = Bun.spawn(["sleep", "60"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill("SIGKILL");
  }, 1_000);
  try {
    killStage(child, "SIGKILL");
    expect(await child.exited).not.toBe(0);
    expect(expired).toBe(false);
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}, 10_000);

it("returns 124 even when the child exit notification never arrives", async () => {
  const { result } = await fakeStep(["sleep", "60"], 600, true);
  expect(result.exitCode).toBe(124);
  expect(result.status).toBe("failed");
  expect(result.reason).toBe(
    "wall-clock limit 600ms exceeded; last test line: (no output)",
  );
}, 15_000);

it("selects the real ceiling only for bun test and applies it by default", async () => {
  // Twice the recorded 2026-09-10 bun test step, in milliseconds.
  expect(BUN_TEST_CEILING_MS).toBe(2 * 1_153_470);
  expect(ceilingFor("bun test")).toBe(BUN_TEST_CEILING_MS);
  expect(ceilingFor("lint")).toBeUndefined();
  const root = mkdtempSync(join(tmpdir(), "isomux-ci-default-"));
  roots.push(root);
  const pidFile = join(root, "pid");
  descendants.push(pidFile);
  // Compress the clock in the isolated runner, keeping the real default argument.
  const { result } = await fakeStep(
    ["sh", "-c", 'echo $$ > "$1"; exec sleep 60', "sh", pidFile],
    undefined,
    false,
    true,
  );
  expect(result.exitCode).toBe(124);
  expect(result.status).toBe("failed");
  expect(result.reason).toBe(
    `wall-clock limit ${BUN_TEST_CEILING_MS}ms exceeded; last test line: (no output)`,
  );
}, 15_000);
