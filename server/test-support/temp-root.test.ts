// The per-run temp folder (task 1ea8ab19). The preload gives each test process
// one folder under the OS temp dir and points TMPDIR at it; the next run
// removes the folders of runs that are gone, and stops the processes those
// runs left behind. Zero LLM.
//
// The sweep scans every process of this user on the box. While you change
// temp-root.ts, run this file in its own PID namespace, so a wrong kill rule
// cannot reach the office:
//   bwrap --dev-bind / / --unshare-pid --proc /proc bun test <this file>

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import {
  createTestTempRoot,
  removeTestTempRoot,
  sweepStaleTestTempRoots,
  testTempBase,
} from "./temp-root.ts";

const MODULE = join(import.meta.dir, "temp-root.ts");
const FIXTURE = join(import.meta.dir, "temp-root.fixture.ts");
const REPO = join(import.meta.dir, "..", "..");
const RUN_NAME = /^isomux-run-(\d+)-[A-Za-z0-9]{6}$/;
const linux = process.platform === "linux";

const scratch: string[] = [];
const procs: number[] = [];
const listeners: Bun.TCPSocketListener<undefined>[] = [];

afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop(true);
  for (const pid of procs.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of scratch.splice(0)) {
    spawnSync("chmod", ["-R", "u+rwx", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "isomux-temp-root-")));
  scratch.push(dir);
  return dir;
}

// Alive and not a zombie.
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await Bun.sleep(20);
  }
  return false;
}

// Field 22 of /proc/<pid>/stat: the process start time.
function startTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

// A pid whose process has exited and was reaped.
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

// A live process that is our child.
function liveChild(): number {
  const proc = Bun.spawn(["sleep", "1000"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  procs.push(proc.pid);
  return proc.pid;
}

// A listener that this process holds until the test ends.
function listenOn(
  hostname: string,
  port: number,
): Bun.TCPSocketListener<undefined> {
  const listener = Bun.listen({ hostname, port, socket: { data() {} } });
  listeners.push(listener);
  return listener;
}

// A port on 127.0.0.1 that this process holds, as a run holds its sentinel.
function heldPort(): { port: number; release: () => void } {
  const listener = listenOn("127.0.0.1", 0);
  return { port: listener.port, release: () => listener.stop(true) };
}

// Whether some process listens on 127.0.0.1:<port>.
function portTaken(port: number): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(
      true,
    );
    return false;
  } catch {
    return true;
  }
}

// A port on 127.0.0.1 that nobody holds: the sentinel of a run that is gone.
function freePort(): number {
  const { port, release } = heldPort();
  release();
  return port;
}

function namePid(root: string): number {
  return Number(RUN_NAME.exec(basename(root))![1]);
}

// A run folder made by a process that has exited: the real producer, so the
// owner record is whatever createTestTempRoot writes. By default its sentinel
// port is free, as when the run is gone.
function deadRoot(base: string, sentinelPort = freePort()): string {
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      `import { createTestTempRoot } from ${JSON.stringify(MODULE)};` +
        `console.log(createTestTempRoot(${JSON.stringify(base)}, ${sentinelPort}));`,
    ],
    { cwd: base, encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

// A process that is not our child (its shell exits), with the given
// environment and working folder.
function orphan(
  command: string,
  opts: { env?: Record<string, string>; cwd?: string } = {},
): number {
  const r = spawnSync("sh", ["-c", `${command} >/dev/null 2>&1 & echo $!`], {
    cwd: opts.cwd ?? "/",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...opts.env },
    encoding: "utf8",
  });
  const pid = Number(r.stdout.trim());
  expect(pid > 0, r.stderr).toBe(true);
  procs.push(pid);
  expect(alive(pid)).toBe(true);
  return pid;
}

// A Unix socket path must fit in 104 bytes on macOS, and its per-user temp
// dir is already ~50 (task dc88b94d).
describe("testTempBase", () => {
  it("is the real /tmp on macOS, whatever the OS temp dir is", () => {
    const macTemp = "/private/var/folders/20/jp1_0n3n7kndh6rnbqb5344m0000gn/T";
    expect(testTempBase("darwin", macTemp)).toBe(realpathSync("/tmp"));
    expect(testTempBase("darwin", scratchDir())).toBe(realpathSync("/tmp"));
  });

  it("is the real OS temp dir elsewhere", () => {
    const base = scratchDir();
    const link = join(scratchDir(), "temp-link");
    symlinkSync(base, link);
    expect(testTempBase("linux", link)).toBe(base);
  });
});

describe("createTestTempRoot", () => {
  it("makes a traversable run folder for this process, directly in the real base", () => {
    const base = scratchDir();
    const link = join(scratchDir(), "base-link");
    symlinkSync(base, link);
    const root = createTestTempRoot(link, heldPort().port);
    expect(dirname(root)).toBe(base);
    expect(RUN_NAME.exec(basename(root))?.[1]).toBe(String(process.pid));
    expect(statSync(root).isDirectory()).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o755);
  });

  // Runs of older code share the temp dir (other worktrees, other PID
  // namespaces) and read only this record: a record they cannot parse reads
  // as a gone run there, and they would remove a live run's folder.
  it("writes the owner record that older code reads: the pid and the sentinel port", () => {
    const port = heldPort().port;
    const root = createTestTempRoot(scratchDir(), port);
    expect(readFileSync(join(root, "owner"), "utf8")).toBe(
      `${process.pid} port ${port}`,
    );
  });
});

describe.skipIf(!linux)("sweepStaleTestTempRoots: which folders", () => {
  it("removes the folder of a run that is gone and keeps the folder of a live run", () => {
    const base = scratchDir();
    const dead = deadRoot(base);
    writeFileSync(join(dead, "leftover"), "x");
    const live = createTestTempRoot(base, heldPort().port);
    const result = sweepStaleTestTempRoots(base);
    expect(result.removed).toEqual([dead]);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    // Twice in a row: the second sweep finds nothing.
    expect(sweepStaleTestTempRoots(base).removed).toEqual([]);
  });

  // Under process isolation (0bb182e8) each agent runs in its own PID
  // namespace and /tmp is shared, so the pid of a live run in another
  // namespace reads as gone here, or as some other process. Its sentinel port
  // on 127.0.0.1 is held across namespaces until the run dies.
  it("keeps the folder of a run whose pid is gone here while its sentinel port is held, and removes it once the port is free", () => {
    const base = scratchDir();
    const sentinel = heldPort();
    const root = deadRoot(base, sentinel.port);
    expect(alive(namePid(root))).toBe(false);
    expect(sweepStaleTestTempRoots(base).removed).toEqual([]);
    expect(existsSync(root)).toBe(true);
    sentinel.release();
    expect(sweepStaleTestTempRoots(base).removed).toEqual([root]);
    expect(existsSync(root)).toBe(false);
  });

  // Under CI load many runs start at once, and each claims the lowest free
  // port block: a run that starts after another was killed can take the
  // killed run's sentinel port (task c4f6c7a1).
  it("removes the folder of a run whose sentinel port another socket now holds, and keeps the run whose own socket holds its port", () => {
    const base = scratchDir();
    const killed = heldPort();
    const root = createTestTempRoot(base, killed.port);
    killed.release();
    listenOn("127.0.0.1", killed.port);
    const live = createTestTempRoot(base, heldPort().port);
    const result = sweepStaleTestTempRoots(base);
    expect(result.removed).toEqual([root]);
    expect(existsSync(live)).toBe(true);
  });

  // Other addresses can listen on the sentinel's port number, for example a
  // dev server on a LAN address. Only the run's own socket on 127.0.0.1 says
  // whether the run lives. The decoys sit on both sides of it in the kernel's
  // socket table.
  it("judges a run by its own socket, not by listeners on other addresses with the same port", () => {
    const base = scratchDir();
    const decoys = (port: number) =>
      [2, 3, 4, 5, 6, 7, 8, 9].map((n) => listenOn(`127.0.0.${n}`, port));
    // Its socket lives, the other listeners are gone.
    const ownLives = heldPort();
    const ownLivesDecoys = decoys(ownLives.port);
    const kept = createTestTempRoot(base, ownLives.port);
    for (const decoy of ownLivesDecoys) decoy.stop(true);
    // Its socket is gone and a later socket took its port on 127.0.0.1, the
    // other listeners live.
    const ownGone = heldPort();
    decoys(ownGone.port);
    const removed = createTestTempRoot(base, ownGone.port);
    ownGone.release();
    listenOn("127.0.0.1", ownGone.port);
    const result = sweepStaleTestTempRoots(base);
    expect(result.removed).toEqual([removed]);
    expect(existsSync(kept)).toBe(true);
  });

  // A record without a readable socket identity, as older code writes it (no
  // file next to the owner record) or as a damaged one reads.
  it("judges a record without a socket identity by its sentinel port", () => {
    const base = scratchDir();
    function portRecord(port: number, suffix: string, socket?: string) {
      const root = join(base, `isomux-run-${process.pid}-${suffix}`);
      mkdirSync(root);
      if (socket !== undefined) writeFileSync(join(root, "socket"), socket);
      writeFileSync(join(root, "owner"), `${process.pid} port ${port}`);
      return root;
    }
    const held = heldPort().port;
    const keep = [
      portRecord(held, "older1"),
      portRecord(held, "badsk1", "not an inode"),
      portRecord(held, "badsk2", ""),
    ];
    const gone = [
      portRecord(freePort(), "older2"),
      portRecord(freePort(), "badsk3", "not an inode"),
    ];
    const result = sweepStaleTestTempRoots(base);
    expect([...result.removed].sort()).toEqual([...gone].sort());
    for (const dir of keep) expect(existsSync(dir), dir).toBe(true);
  });

  it("reads a folder whose pid lives here but whose sentinel port is free as gone, and leaves that process alone", () => {
    const base = scratchDir();
    const other = liveChild();
    // The producer's record, moved to the live pid: a pid from another
    // namespace, or one a new process took over.
    function rootOf(sentinelPort: number, suffix: string): string {
      const made = deadRoot(base, sentinelPort);
      const root = join(base, `isomux-run-${other}-${suffix}`);
      renameSync(made, root);
      const owner = join(root, "owner");
      writeFileSync(
        owner,
        readFileSync(owner, "utf8").replace(/^\d+/, String(other)),
      );
      return root;
    }
    const gone = rootOf(freePort(), "free01");
    // Control in the same sweep: the same pid with its port held.
    const held = rootOf(heldPort().port, "held01");
    const result = sweepStaleTestTempRoots(base);
    expect(result.removed).toEqual([gone]);
    expect(existsSync(held)).toBe(true);
    expect(result.killed).not.toContain(other);
    expect(alive(other)).toBe(true);
  });

  // A record without a port, as a run of older code writes it.
  it("reads a reused pid in a legacy record (a live process with another start time) as gone", () => {
    const base = scratchDir();
    const reuser = liveChild();
    const made = deadRoot(base);
    const suffix = basename(made).split("-").pop()!;
    const root = join(base, `isomux-run-${reuser}-${suffix}`);
    renameSync(made, root);
    writeFileSync(
      join(root, "owner"),
      `${reuser} ${Number(startTime(reuser)) + 1}`,
    );
    const control = join(base, `isomux-run-${reuser}-ctrl01`);
    mkdirSync(control);
    writeFileSync(join(control, "owner"), `${reuser} ${startTime(reuser)}`);
    const result = sweepStaleTestTempRoots(base);
    expect(result.removed).toEqual([root]);
    expect(existsSync(control)).toBe(true);
    // The process that reused the pid is not part of the dead run.
    expect(result.killed).not.toContain(reuser);
    expect(alive(reuser)).toBe(true);
  });

  it("keeps a folder whose owner record is missing, partial or names another pid while its pid is alive", async () => {
    const base = scratchDir();
    const live = liveChild();
    const dead = await deadPid();
    const keep = {
      noOwner: join(base, `isomux-run-${live}-nownr1`),
      partial: join(base, `isomux-run-${live}-prtl01`),
      empty: join(base, `isomux-run-${live}-empty1`),
      onlyTmp: join(base, `isomux-run-${live}-otmp01`),
      ownerDead: join(base, `isomux-run-${live}-odead1`),
      nameDead: join(base, `isomux-run-${dead}-ndead1`),
      // Port 0 always binds: read as a port, it would say the run is gone.
      portZero: join(base, `isomux-run-${live}-port00`),
      nameDeadFreePort: join(base, `isomux-run-${dead}-ndead2`),
    };
    for (const dir of Object.values(keep)) mkdirSync(dir);
    writeFileSync(join(keep.partial, "owner"), `${live}`);
    writeFileSync(join(keep.empty, "owner"), "");
    writeFileSync(
      join(keep.onlyTmp, "owner.tmp"),
      `${live} ${startTime(live)}`,
    );
    writeFileSync(join(keep.ownerDead, "owner"), `${dead} 1`);
    writeFileSync(join(keep.nameDead, "owner"), `${live} ${startTime(live)}`);
    writeFileSync(join(keep.portZero, "owner"), `${live} port 0`);
    writeFileSync(
      join(keep.nameDeadFreePort, "owner"),
      `${live} port ${freePort()}`,
    );
    // Control in the same sweep: a dead run with no owner record (killed
    // between mkdtemp and the record) is removed.
    const control = join(base, `isomux-run-${dead}-ctrl02`);
    mkdirSync(control);
    const result = sweepStaleTestTempRoots(base);
    expect(result.removed).toEqual([control]);
    for (const dir of Object.values(keep))
      expect(existsSync(dir), dir).toBe(true);
  });

  it("leaves names that are not run folders, plain files and symlinks", async () => {
    const base = scratchDir();
    const outside = scratchDir();
    writeFileSync(join(outside, "precious"), "x");
    const dead = await deadPid();
    const foreign = [
      `isomux-run-${dead}-abcde`,
      `isomux-run-${dead}-abcdefg`,
      `isomux-run-x${dead}-abcdef`,
      `isomux-runs-${dead}-abcdef`,
      `xisomux-run-${dead}-abcdef`,
      "isomux-test-home-abcdef",
      "isomux-opencode-supervisor-abcdef",
    ].map((name) => join(base, name));
    for (const dir of foreign) mkdirSync(dir);
    const file = join(base, `isomux-run-${dead}-file01`);
    writeFileSync(file, "x");
    const link = join(base, `isomux-run-${dead}-link01`);
    symlinkSync(outside, link);
    const control = join(base, `isomux-run-${dead}-ctrl03`);
    mkdirSync(control);
    const result = sweepStaleTestTempRoots(base);
    expect(result.removed).toEqual([control]);
    for (const dir of foreign) expect(existsSync(dir), dir).toBe(true);
    expect(statSync(file).isFile()).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(readFileSync(join(outside, "precious"), "utf8")).toBe("x");
  });

  it("goes on past a folder it cannot remove and names it", () => {
    const base = scratchDir();
    const stuck = deadRoot(base);
    mkdirSync(join(stuck, "locked"));
    writeFileSync(join(stuck, "locked", "f"), "x");
    chmodSync(join(stuck, "locked"), 0o500);
    const other = deadRoot(base);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = sweepStaleTestTempRoots(base);
      expect(result.removed).toEqual([other]);
      expect(existsSync(stuck)).toBe(true);
      expect(
        errors.mock.calls.some((call) => call.join(" ").includes(stuck)),
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});

describe.skipIf(!linux)("sweepStaleTestTempRoots: which processes", () => {
  it("stops the processes that hold a path in a dead run's folder, and only those", async () => {
    const base = scratchDir();
    const dead = deadRoot(base);
    mkdirSync(join(dead, "work"));
    writeFileSync(join(dead, "log"), "");
    const live = createTestTempRoot(base, heldPort().port);
    const stopped = {
      // The OpenCode supervisor case: a server whose TMPDIR is in its profile.
      tmpdir: orphan("sleep 1000", { env: { TMPDIR: join(dead, "p", "tmp") } }),
      otherVariable: orphan("sleep 1000", {
        env: { ISOMUX_HOME: join(dead, "home") },
      }),
      cwd: orphan("sleep 1000", { cwd: join(dead, "work") }),
    };
    const left = {
      // Names the folder on its command line only, like an agent's tail -f.
      commandLine: orphan(`tail -f ${join(dead, "log")}`),
      siblingPrefix: orphan("sleep 1000", { env: { TMPDIR: `${dead}x/tmp` } }),
      liveRun: orphan("sleep 1000", { env: { TMPDIR: join(live, "tmp") } }),
      unrelated: orphan("sleep 1000"),
    };
    const result = sweepStaleTestTempRoots(base);
    expect(result.removed).toEqual([dead]);
    expect([...result.killed].sort()).toEqual(Object.values(stopped).sort());
    for (const [name, pid] of Object.entries(stopped))
      expect(await gone(pid), name).toBe(true);
    for (const [name, pid] of Object.entries(left))
      expect(alive(pid), name).toBe(true);
    expect(existsSync(live)).toBe(true);
  });

  it("never stops the sweeping process or its parents, even when they hold a path in the dead folder", () => {
    const base = scratchDir();
    const dead = deadRoot(base);
    mkdirSync(join(dead, "t"));
    const script =
      `import { sweepStaleTestTempRoots } from ${JSON.stringify(MODULE)};` +
      `console.log(JSON.stringify(sweepStaleTestTempRoots(${JSON.stringify(base)})));`;
    const r = spawnSync(
      "sh",
      ["-c", '"$SWEEP_BUN" -e "$SWEEP_SCRIPT"; echo parent-survived'],
      {
        cwd: join(dead, "t"),
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TMPDIR: join(dead, "t"),
          SWEEP_BUN: process.execPath,
          SWEEP_SCRIPT: script,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(r.signal, r.stderr).toBeNull();
    const [json, tail] = r.stdout.trim().split("\n");
    expect(tail).toBe("parent-survived");
    expect(JSON.parse(json)).toEqual({ removed: [dead], killed: [] });
  });
});

describe("removeTestTempRoot", () => {
  it("removes this run's folder with its contents", () => {
    const base = scratchDir();
    const root = createTestTempRoot(base, heldPort().port);
    mkdirSync(join(root, "home", "deep"), { recursive: true });
    writeFileSync(join(root, "home", "deep", "f"), "x");
    removeTestTempRoot(base, root);
    expect(existsSync(root)).toBe(false);
  });

  it("refuses anything that is not a run folder directly in the base", () => {
    const base = scratchDir();
    const otherBase = scratchDir();
    const outside = scratchDir();
    writeFileSync(join(outside, "precious"), "x");
    const root = createTestTempRoot(base, heldPort().port);
    const nested = join(root, `isomux-run-${process.pid}-nestd1`);
    mkdirSync(nested);
    const foreignName = join(base, "isomux-test-home-abcdef");
    mkdirSync(foreignName);
    const elsewhere = createTestTempRoot(otherBase, heldPort().port);
    const link = join(base, `isomux-run-${process.pid}-link02`);
    symlinkSync(outside, link);
    for (const target of [nested, foreignName, elsewhere, link, base]) {
      expect(() => removeTestTempRoot(base, target), target).toThrow();
      expect(existsSync(target), target).toBe(true);
    }
    expect(readFileSync(join(outside, "precious"), "utf8")).toBe("x");
    expect(existsSync(root)).toBe(true);
  });
});

// Through the preload: a real `bun test` that is killed, then a second run.
describe.skipIf(!linux)("preload", () => {
  function childEnv(extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (
        v !== undefined &&
        !k.startsWith("ISOMUX_TEST_") &&
        k !== "ISOMUX_HOME" &&
        k !== "TMPDIR"
      )
        env[k] = v;
    }
    return { ...env, ...extra };
  }

  async function readWhenWritten(
    path: string,
  ): Promise<Record<string, unknown>> {
    for (let i = 0; i < 500; i++) {
      if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
      await Bun.sleep(20);
    }
    throw new Error(`fixture never wrote ${path}`);
  }

  it("gives a run its own folder, and the next run removes a killed run's folder and helper", async () => {
    const base = scratchDir();
    const out = scratchDir();
    const first = Bun.spawn([process.execPath, "test", FIXTURE], {
      cwd: REPO,
      env: childEnv({
        TMPDIR: base,
        TEMP_ROOT_FIXTURE_OUT: join(out, "first.json"),
        TEMP_ROOT_FIXTURE_HOLD: "1",
      }),
      stdio: ["ignore", "ignore", "ignore"],
    });
    procs.push(first.pid);
    const held = await readWhenWritten(join(out, "first.json"));
    const root = held.tmpdir as string;
    const helper = held.helper as number;
    procs.push(helper);
    expect(dirname(root)).toBe(base);
    expect(RUN_NAME.exec(basename(root))?.[1]).toBe(String(held.pid));
    expect(held.TMPDIR).toBe(root);
    expect(held.home).toBe(join(root, "home"));
    // A sweep while the run lives keeps its folder: the preload recorded the
    // sentinel port the run holds.
    expect(sweepStaleTestTempRoots(base).removed).toEqual([]);
    expect(existsSync(root)).toBe(true);

    first.kill("SIGKILL");
    await first.exited;
    // What the killed run left: its folder and its helper.
    expect(existsSync(root)).toBe(true);
    expect(alive(helper)).toBe(true);
    // Under CI load another run can claim the killed run's free sentinel port
    // before the next run sweeps (task c4f6c7a1). Take it here, so the sweep
    // always sees it held by a socket that is not the killed run's.
    const sentinel = Number(
      / port (\d+)$/.exec(readFileSync(join(root, "owner"), "utf8"))![1],
    );
    try {
      listenOn("127.0.0.1", sentinel);
    } catch {
      // another process took it first: the same condition
    }
    expect(portTaken(sentinel)).toBe(true);

    const second = Bun.spawn([process.execPath, "test", FIXTURE], {
      cwd: REPO,
      env: childEnv({
        TMPDIR: base,
        TEMP_ROOT_FIXTURE_OUT: join(out, "second.json"),
      }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    const code = await second.exited;
    expect(code, await new Response(second.stderr).text()).toBe(0);
    const ran = await readWhenWritten(join(out, "second.json"));
    expect(dirname(ran.tmpdir as string)).toBe(base);
    expect(ran.tmpdir).not.toBe(root);
    expect(existsSync(root)).toBe(false);
    expect(await gone(helper)).toBe(true);
    // The finished run removed its own folder too.
    expect(readdirSync(base)).toEqual([]);
  }, 60_000);
});
