// The office boot does not wait for the Codex safety-hook preparation: the
// preparation builds the hook and starts a scratch Codex, seconds that a
// loaded box stretches (task 3649ad70). A Codex start waits for it instead.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const ENTRY = join(import.meta.dir, "isomux-office.ts");
const PRELOAD = join(
  import.meta.dir,
  "test-support",
  "hang-codex-hook-build-preload.ts",
);
const READY_BUDGET_MS = 20_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the office serves while the Codex hook preparation still runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-codex-prep-"));
  const home = join(dir, "home");
  const scratch = join(dir, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  const pidFile = join(dir, "build.pid");
  // A fresh state root has no hook, so the preparation starts with the build
  // that the preload makes hang. Not the test's own environment: an office
  // started from an agent shell would read the live office's settings.
  const office = Bun.spawn([process.execPath, "--preload", PRELOAD, ENTRY], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      ISOMUX_HOME: join(home, ".isomux"),
      ISOMUX_BACKUP_DIR: join(dir, "backups"),
      XDG_CONFIG_HOME: join(home, ".config"),
      TMPDIR: scratch,
      PORT: "0",
      HANG_PID_FILE: pidFile,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk);
  };
  void collect(office.stdout);
  void collect(office.stderr);
  const buildPid = () => {
    try {
      return Number(readFileSync(pidFile, "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  };
  try {
    // Ready, and the build started: either may come first.
    const deadline = performance.now() + READY_BUDGET_MS;
    let port = 0;
    while (performance.now() < deadline && office.exitCode === null) {
      port = Number(/running at http:\/\/localhost:(\d+)/.exec(output)?.[1]);
      if (port && buildPid()) break;
      await Bun.sleep(50);
    }
    const build = buildPid();
    const ready = port
      ? (await fetch(`http://127.0.0.1:${port}/readyz`)).status
      : null;
    if (!ready || !build) console.error(output.slice(-3000));
    expect({
      buildStarted: build > 0,
      ready,
      buildStillRuns: build > 0 && alive(build),
    }).toEqual({ buildStarted: true, ready: 200, buildStillRuns: true });
  } finally {
    office.kill("SIGKILL");
    await office.exited;
    // Read after the office is gone: a build it started late is killed too.
    const build = buildPid();
    if (build > 0 && alive(build)) process.kill(build, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
