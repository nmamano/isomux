// "The box answers SSH" is not "the box is ready to be provisioned".
//
// A fresh Ubuntu cloud image runs apt on boot. Measured 2026-08-09: SSH
// authenticated 88s after the rebuild, and apt still held
// /var/lib/dpkg/lock-frontend at T+2min - the installer launched into that and
// died with "Could not get lock" before it had done anything.
//
// The detector reads /proc/locks, which is the kernel's own table and needs no
// package installed. This test holds a REAL POSIX lock, the same kind dpkg
// takes, so it proves the mechanism rather than a mock of it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { composeRemoteScript } from "./driver.ts";

let dir = "";
let script = "";
let lockFile = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "isomux-cp-apt-"));
  script = path.join(dir, "wait-apt.sh");
  lockFile = path.join(dir, "lock-frontend");
  fs.writeFileSync(lockFile, "");
  fs.writeFileSync(script, composeRemoteScript(["remote/wait-apt.sh"]), {
    mode: 0o755,
  });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Async spawn throughout: spawnSync alongside an already-running child gives
// back a null exit code and empty output in Bun, which looks exactly like a
// broken detector and is not.
async function runWait(timeoutS: number) {
  const proc = Bun.spawn(["bash", script, String(timeoutS), "1"], {
    env: { ...process.env, ISOMUX_APT_LOCKS: lockFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { code, stdout };
}

/** Hold a real fcntl lock, the way dpkg does, for `ms` and then release. */
function holdPosixLock(ms: number) {
  return Bun.spawn([
    "python3",
    "-c",
    `import fcntl,os,time\nfd=os.open(${JSON.stringify(lockFile)},os.O_RDWR)\nfcntl.lockf(fd,fcntl.LOCK_EX)\ntime.sleep(${ms / 1000})\nos.close(fd)`,
  ]);
}

describe("waiting for the box's own package work", () => {
  test("an unlocked box is ready immediately", async () => {
    const r = await runWait(30);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("RESULT: ready");
  });

  test("a held dpkg-style lock is seen as busy, and times out rather than lying", async () => {
    const holder = holdPosixLock(30_000);
    await Bun.sleep(400);
    const r = await runWait(5);
    holder.kill();
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("still-busy");
    expect(r.stdout).toContain("kernel lock");
  }, 20_000);

  test("it becomes ready once the lock is released", async () => {
    const holder = holdPosixLock(2500);
    await Bun.sleep(300);
    const r = await runWait(60);
    holder.kill();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("RESULT: ready");
    // It really waited rather than passing straight through.
    expect(r.stdout).not.toContain("waited 0s");
  }, 20_000);
});
