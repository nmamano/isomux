// Real-process lifecycle tests for JsonRpcLiteClient.close().
//
// These spawn ACTUAL OS processes (not a FakeBackend / JS stub) on purpose: the
// bug they guard against is a leaked subprocess — a `close()` that drops the
// session object server-side but leaves the codex child (and its native
// grandchild) hung in the kernel, never reclaiming ~165MB. A JS no-op stub
// cannot observe that; only a real pid can. We point `codexBin` at a tiny bash
// script that behaves like a stubborn subprocess and assert the pids are gone.
import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JsonRpcLiteClient } from "./client.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

// pid liveness probe. signal 0 performs error checking without delivering a
// signal: it throws ESRCH once the process (and its zombie) is fully reaped.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (pred()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Write a fake "codex" launcher: a bash script that forks a grandchild sleeper
// (modeling the native codex process the real launcher spawns), reports the
// grandchild pid to a file, then parks. `trapMode==="ignore"` makes it ignore
// SIGTERM, forcing the SIGKILL escalation; otherwise SIGTERM (the default
// disposition) takes it down promptly.
function writeFakeLauncher(dir: string): string {
  const script = join(dir, "fake-codex.sh");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "ignore" ]; then trap "" TERM INT; fi',
      "sleep 600 &",
      'echo "$!" > "$GC_PIDFILE"',
      "wait",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return script;
}

function makeClient(args: string[]): {
  client: JsonRpcLiteClient;
  pidFile: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "codex-client-test-"));
  tmpDirs.push(dir);
  const pidFile = join(dir, "grandchild.pid");
  const bin = writeFakeLauncher(dir);
  const client = new JsonRpcLiteClient({
    codexBin: bin,
    args,
    cwd: dir,
    // Full env so the script finds bash/sleep on PATH; GC_PIDFILE tells the
    // fake where to report its grandchild pid.
    env: { ...process.env, GC_PIDFILE: pidFile },
  });
  return { client, pidFile };
}

async function readGrandchildPid(pidFile: string): Promise<number> {
  const ok = await waitFor(() => {
    try {
      return readFileSync(pidFile, "utf8").trim().length > 0;
    } catch {
      return false;
    }
  }, 4000);
  if (!ok) throw new Error("grandchild never reported its pid");
  return Number(readFileSync(pidFile, "utf8").trim());
}

describe("JsonRpcLiteClient.close — real process reaping", () => {
  it("SIGKILL-escalates a SIGTERM-ignoring child AND reaps the native grandchild", async () => {
    const { client, pidFile } = makeClient(["ignore"]);
    client.start();
    const launcherPid = client.pid();
    expect(launcherPid).toBeDefined();
    const grandchildPid = await readGrandchildPid(pidFile);

    // Both alive before close.
    expect(isAlive(launcherPid!)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    await client.close();

    // The child ignores SIGTERM, so its death proves the SIGKILL escalation
    // fired; the grandchild's death proves the kill reached the whole process
    // group (it shares the detached launcher's group), not just the launcher.
    const launcherGone = await waitFor(() => !isAlive(launcherPid!), 6000);
    const grandchildGone = await waitFor(() => !isAlive(grandchildPid), 6000);
    expect(launcherGone).toBe(true);
    expect(grandchildGone).toBe(true);
  }, 10000);

  it("reaps a well-behaved child (and grandchild) on SIGTERM, before the SIGKILL grace elapses", async () => {
    const { client, pidFile } = makeClient(["default"]);
    client.start();
    const launcherPid = client.pid();
    const grandchildPid = await readGrandchildPid(pidFile);
    expect(isAlive(launcherPid!)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    await client.close();

    // SIGTERM (default disposition) takes the group down well under the 2s
    // SIGKILL grace — assert it's gone fast so a regression that relies only
    // on the slow escalation would still be caught here.
    const gone = await waitFor(
      () => !isAlive(launcherPid!) && !isAlive(grandchildPid),
      1500,
    );
    expect(gone).toBe(true);
  }, 10000);
});
