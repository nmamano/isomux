import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeSupervisor } from "./supervisor.ts";

// The record lock and process lifecycle on this host: flock(1) on Linux, the
// helper's own flock(2) on macOS. Linux-only details (/proc environ, cmdline)
// are covered in supervisor.test.ts.

const supervisors: OpenCodeSupervisor[] = [];
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    supervisors.splice(0).map((supervisor) => supervisor.shutdown()),
  );
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "isomux-opencode-lock-"));
  scratch.push(path);
  return path;
}

async function healthOnlyBinary(path: string) {
  const binary = join(path, "health-only-opencode");
  const launches = join(path, "launches");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(launches)}, process.pid + "\\n");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch(request) {
  if (new URL(request.url).pathname !== "/global/health")
    return new Response("not found", { status: 404 });
  return Response.json({ healthy: true, version: "1.18.35" });
}});
console.log("opencode server listening on http://127.0.0.1:" + server.port);
await new Promise(() => {});
`,
  );
  await chmod(binary, 0o700);
  return { binary, launches };
}

function supervisor(path: string, binary: string) {
  const created = new OpenCodeSupervisor({
    profileDir: join(path, "profile"),
    serverCwd: path,
    config: { autoupdate: false, share: "disabled" },
    binary,
  });
  supervisors.push(created);
  return created;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function launched(file: string): Promise<string[]> {
  return (await readFile(file, "utf8")).trim().split("\n");
}

describe("OpenCode server record lock", () => {
  it("starts one server for concurrent callers", async () => {
    const path = await root();
    const { binary, launches } = await healthOnlyBinary(path);
    const callers = Array.from({ length: 4 }, () => supervisor(path, binary));
    const leases = await Promise.all(callers.map((s) => s.acquire()));
    const pids = new Set(leases.map((lease) => lease.pid));
    expect(pids.size).toBe(1);
    expect(await launched(launches)).toEqual([String(leases[0].pid)]);
    for (const lease of leases) lease.release();
  }, 30_000);

  it("stops under the lock and starts again", async () => {
    const path = await root();
    const { binary, launches } = await healthOnlyBinary(path);
    const owner = supervisor(path, binary);
    const lease = await owner.acquire();
    const firstPid = lease.pid;
    lease.release();
    await owner.shutdown();
    for (let i = 0; i < 100 && alive(firstPid); i++) await Bun.sleep(20);
    expect(alive(firstPid)).toBe(false);
    const next = await supervisor(path, binary).acquire();
    expect(next.pid).not.toBe(firstPid);
    expect(await launched(launches)).toEqual([
      String(firstPid),
      String(next.pid),
    ]);
    next.release();
  }, 30_000);

  it("waits for another holder of the record lock", async () => {
    const path = await root();
    const { binary } = await healthOnlyBinary(path);
    const owner = supervisor(path, binary);
    const recordPath = join(path, "profile", "server.lock");
    await mkdir(join(path, "profile"), { recursive: true });
    // The holder keeps the lock until its stdin closes.
    const holder =
      process.platform === "darwin"
        ? Bun.spawn(
            [
              process.execPath,
              "-e",
              `const { lockDarwinFileUntilExit } = await import(${JSON.stringify(join(import.meta.dir, "darwin-libsystem.ts"))});
if (!lockDarwinFileUntilExit(${JSON.stringify(recordPath)})) process.exit(9);
console.log("locked");
await Bun.stdin.text();`,
            ],
            { stdin: "pipe", stdout: "pipe" },
          )
        : Bun.spawn(
            [
              "flock",
              "--exclusive",
              recordPath,
              "sh",
              "-c",
              "echo locked; cat > /dev/null",
            ],
            { stdin: "pipe", stdout: "pipe" },
          );
    const reader = holder.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value).trim()).toBe("locked");
    let released = false;
    let settled = false;
    const shutdown = owner.shutdown().then(() => {
      settled = true;
      return released;
    });
    await Bun.sleep(200);
    expect(settled, "shutdown still waits for the lock").toBe(false);
    released = true;
    await holder.stdin.end();
    expect(await shutdown, "shutdown ended after the holder let go").toBe(true);
    expect(await holder.exited).toBe(0);
  }, 30_000);

  it("never signals a process whose saved identity does not match", async () => {
    const path = await root();
    const profileDir = join(path, "profile");
    await mkdir(profileDir, { recursive: true });
    const recordPath = join(profileDir, "server.lock");
    const unrelated = Bun.spawn(["sleep", "30"]);
    await writeFile(
      recordPath,
      `${JSON.stringify({ pid: unrelated.pid, startTicks: "0" })}\n`,
    );
    const { binary } = await healthOnlyBinary(path);
    await supervisor(path, binary).shutdown();
    expect(await readFile(recordPath, "utf8"), "the stop ran").toBe("");
    expect(alive(unrelated.pid)).toBe(true);
    unrelated.kill();
    await unrelated.exited;
  });

  // The helper locks the record itself only on macOS (supervisor.ts). Here
  // the record's folder is missing, so the lock cannot be taken; the same
  // run without the self-lock starts a server, so the refusal is the lock's.
  it("refuses to start when it cannot take the lock", async () => {
    const path = await root();
    const helper = join(import.meta.dir, "start-server.ts");
    const { binary, launches } = await healthOnlyBinary(path);
    const config = join(path, "opencode.json");
    await writeFile(config, `${JSON.stringify({ autoupdate: false })}\n`);
    const run = (record: string, lock: "self" | undefined) =>
      Bun.spawn([process.execPath, "run", helper], {
        env: {
          ...process.env,
          OPENCODE_SERVER_LOCK: lock,
          OPENCODE_PROFILE_DIR: join(path, "profile"),
          OPENCODE_SERVER_RECORD: record,
          OPENCODE_BINARY: binary,
          OPENCODE_SERVER_PASSWORD: "test-only",
          OPENCODE_SERVER_CWD: path,
          OPENCODE_CONFIG: config,
          OPENCODE_SAFETY_ROOTS: JSON.stringify({
            home: path,
            env: { ISOMUX_HOME: join(path, "state") },
          }),
          OPENCODE_ENVIRONMENT_REVISION: "test",
          OPENCODE_CONFIG_REVISION: "test",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const missing = join(path, "missing", "server.lock");
    // A launched server cannot write its record here, so nothing else stops
    // it: this test does.
    try {
      expect(await run(missing, "self").exited).not.toBe(0);
      expect(await readFile(launches, "utf8").catch(() => "")).toBe("");
      // The control: without the self-lock, the same run launches a server.
      await run(missing, undefined).exited;
      expect(await launched(launches)).toHaveLength(1);
    } finally {
      for (const pid of await launched(launches).catch(() => []))
        if (pid) process.kill(Number(pid), "SIGKILL");
    }
  });
});
