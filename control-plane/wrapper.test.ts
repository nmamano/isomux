// The wrapper protocol, exercised for real against a fake installer.
//
// No box is involved: bash, flock, setsid and /proc all work the same here, so
// generation isolation, exit capture, single-flight and crash detection are all
// provable locally. That matters because these are the invariants a live run
// cannot easily be made to violate on demand.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WRAPPER = path.join(import.meta.dir, "wrapper.sh");

let root = "";
let bin = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "isomux-cp-wrap-"));
  bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const runRoot = () => path.join(root, "state");

async function wrapper(
  args: string[],
  opts: { script?: string; timeoutS?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", opts.script ?? WRAPPER, ...args], {
    env: {
      ...process.env,
      ISOMUX_CP_ROOT: runRoot(),
      PUBLISH_TIMEOUT_S: String(opts.timeoutS ?? 10),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** A stand-in installer: emits the same `--- step:` markers install.sh does. */
function fakeInstaller(name: string, body: string): string {
  const p = path.join(bin, name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return p;
}

function readRun(runId: string, file: string): string {
  return fs
    .readFileSync(path.join(runRoot(), "runs", runId, file), "utf8")
    .trim();
}

/**
 * Wait until a run is genuinely over.
 *
 * The exit file appears from INSIDE the EXIT trap, so the supervisor is still
 * running - and still holding the lock - at that moment. A test that only
 * waited for the file would race the lock release and fail intermittently,
 * which is exactly what it did once before this waited for the process too.
 */
async function waitForExit(runId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const dir = path.join(runRoot(), "runs", runId);
  const exitFile = path.join(dir, "exit");
  while (Date.now() < deadline) {
    if (fs.existsSync(exitFile) && !supervisorAlive(dir)) return;
    await Bun.sleep(50);
  }
  throw new Error(`run ${runId} never finished`);
}

function supervisorAlive(dir: string): boolean {
  try {
    process.kill(
      Number(fs.readFileSync(path.join(dir, "pid"), "utf8").trim()),
      0,
    );
    return true;
  } catch {
    return false;
  }
}

describe("launch and publication", () => {
  test("the launcher confirms only a complete, published generation", async () => {
    const inst = fakeInstaller(
      "ok.sh",
      `echo "--- step: preflight"; sleep 0.3; echo "--- step: report"`,
    );
    const res = await wrapper(["launch", "r1", "bash", inst]);
    expect(res.stdout.trim()).toBe("CONFIRMED r1");

    // current points at us, and pid/started were complete BEFORE it did.
    const current = fs.readlinkSync(path.join(runRoot(), "current"));
    expect(current).toBe(path.join(runRoot(), "runs", "r1"));
    expect(readRun("r1", "pid")).toMatch(/^\d+$/);
    expect(readRun("r1", "started")).toMatch(/startticks=\d+/);
  });

  // The launcher must never report success for a supervisor that died before
  // publishing. The double writes pid and started, then exits.
  test("a supervisor that dies before publication is a FAILED launch", async () => {
    const doubled = path.join(root, "wrapper-dies.sh");
    fs.writeFileSync(
      doubled,
      fs
        .readFileSync(WRAPPER, "utf8")
        .replace('touch "$RUN_DIR/log"', "exit 9"),
    );
    const inst = fakeInstaller("never.sh", "true");
    const res = await wrapper(["launch", "r2", "bash", inst], {
      script: doubled,
      timeoutS: 8,
    });
    expect(res.stdout).toContain("FAILED");
    expect(fs.existsSync(path.join(runRoot(), "current"))).toBe(false);
  });

  test("a second generation with the same runId is refused", async () => {
    const inst = fakeInstaller("quick.sh", "true");
    await wrapper(["launch", "r3", "bash", inst]);
    await waitForExit("r3");
    const again = await wrapper(["launch", "r3", "bash", inst]);
    expect(again.stdout).toContain("FAILED");
  });
});

describe("exit capture", () => {
  // M2. The trap body is single-quoted so $? is read when the trap FIRES.
  // Double-quoting expands it at installation time and records whatever ran
  // before the trap was set - which is almost always 0, i.e. a failed install
  // reported as a success.
  test("records the installer's real exit status, not the status at trap time", async () => {
    const inst = fakeInstaller(
      "fail7.sh",
      `echo "--- step: preflight"; exit 7`,
    );
    await wrapper(["launch", "r4", "bash", inst]);
    await waitForExit("r4");
    expect(readRun("r4", "exit")).toBe("7");

    const tick = await wrapper(["tick"]);
    expect(tick.stdout).toContain("state=finished");
    expect(tick.stdout).toContain("exit=7");
    expect(tick.stdout).toContain("step=preflight");
  });

  test("the log is appended, never truncated, so a failure stays readable", async () => {
    const inst = fakeInstaller(
      "noisy.sh",
      `echo "--- step: one"; echo "--- step: two"; exit 3`,
    );
    await wrapper(["launch", "r5", "bash", inst]);
    await waitForExit("r5");
    const log = readRun("r5", "log");
    expect(log).toContain("--- step: one");
    expect(log).toContain("--- step: two");
  });
});

describe("single flight", () => {
  test("a second launch is refused while a run holds the lock", async () => {
    const inst = fakeInstaller("slow.sh", `echo "--- step: slow"; sleep 3`);
    await wrapper(["launch", "r6", "bash", inst]);
    const second = await wrapper(["launch", "r7", "bash", inst], {
      timeoutS: 2,
    });
    expect(second.stdout).toContain("LOCKED");
  });

  // The reason the supervisor runs the installer with 9>&-. Without it, a
  // background child of the installer inherits the lock fd and holds
  // single-flight shut long after the installer itself has exited.
  test("the lock is released when the SUPERVISOR finishes, even if the installer forked a survivor", async () => {
    const survivor = path.join(root, "survivor.marker");
    const inst = fakeInstaller(
      "forker.sh",
      `( sleep 5; touch ${survivor} ) & echo "--- step: forked"; exit 0`,
    );
    await wrapper(["launch", "r8", "bash", inst]);
    await waitForExit("r8");

    // The forked child is still alive here; the lock must not be.
    const inst2 = fakeInstaller("after.sh", "true");
    const second = await wrapper(["launch", "r9", "bash", inst2]);
    expect(second.stdout.trim()).toBe("CONFIRMED r9");
  });
});

describe("tick", () => {
  test("reports no generation before anything runs", async () => {
    const res = await wrapper(["tick"]);
    expect(res.stdout.trim()).toBe("state=none");
  });

  test("reports a running generation with its last step", async () => {
    const inst = fakeInstaller(
      "running.sh",
      `echo "--- step: build-isomux"; sleep 3`,
    );
    await wrapper(["launch", "r10", "bash", inst]);
    await Bun.sleep(300);
    const tick = await wrapper(["tick"]);
    expect(tick.stdout).toContain("state=running");
    expect(tick.stdout).toContain("step=build-isomux");
  });

  test("a killed supervisor with no exit file is a crash, not progress", async () => {
    const inst = fakeInstaller(
      "victim.sh",
      `echo "--- step: fetch-isomux"; sleep 30`,
    );
    await wrapper(["launch", "r11", "bash", inst]);
    await Bun.sleep(300);
    const pid = Number(readRun("r11", "pid"));
    process.kill(pid, "SIGKILL");
    await Bun.sleep(200);
    const tick = await wrapper(["tick"]);
    expect(tick.stdout).toContain("state=crashed");
    expect(tick.stdout).toContain("step=fetch-isomux");
  });

  // A pid on its own can be reused. The recorded start ticks bind the pid to
  // THIS generation, so a stranger holding that number cannot make a dead run
  // look alive.
  test("a live pid with different start ticks is a reused pid, not our run", async () => {
    const inst = fakeInstaller(
      "gone.sh",
      `echo "--- step: install-bun"; sleep 30`,
    );
    await wrapper(["launch", "r12", "bash", inst]);
    await Bun.sleep(300);
    const pid = Number(readRun("r12", "pid"));
    process.kill(pid, "SIGKILL");
    await Bun.sleep(200);

    // Point the generation at a pid that is very much alive - our own - while
    // leaving the recorded start ticks as they were.
    const dir = path.join(runRoot(), "runs", "r12");
    fs.writeFileSync(path.join(dir, "pid"), `${process.pid}\n`);
    fs.rmSync(path.join(dir, "exit"), { force: true });

    const tick = await wrapper(["tick"]);
    expect(tick.stdout).toContain("state=crashed");
  });
});
