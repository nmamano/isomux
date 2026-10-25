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
} from "./temp-root.ts";

const MODULE = join(import.meta.dir, "temp-root.ts");
const FIXTURE = join(import.meta.dir, "temp-root.fixture.ts");
const REPO = join(import.meta.dir, "..", "..");
const RUN_NAME = /^isomux-run-(\d+)-[A-Za-z0-9]{6}$/;
const linux = process.platform === "linux";

const scratch: string[] = [];
const procs: number[] = [];

afterEach(() => {
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

// A run folder made by a process that has exited: the real producer, so the
// owner record is whatever createTestTempRoot writes.
function deadRoot(base: string): string {
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      `import { createTestTempRoot } from ${JSON.stringify(MODULE)};` +
        `console.log(createTestTempRoot(${JSON.stringify(base)}));`,
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

describe("createTestTempRoot", () => {
  it("makes a traversable run folder for this process, directly in the real base", () => {
    const base = scratchDir();
    const link = join(scratchDir(), "base-link");
    symlinkSync(base, link);
    const root = createTestTempRoot(link);
    expect(dirname(root)).toBe(base);
    expect(RUN_NAME.exec(basename(root))?.[1]).toBe(String(process.pid));
    expect(statSync(root).isDirectory()).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o755);
  });
});

describe.skipIf(!linux)("sweepStaleTestTempRoots: which folders", () => {
  it("removes the folder of a run that is gone and keeps the folder of a live run", () => {
    const base = scratchDir();
    const dead = deadRoot(base);
    writeFileSync(join(dead, "leftover"), "x");
    const live = createTestTempRoot(base);
    const result = sweepStaleTestTempRoots(base);
    expect(result.removed).toEqual([dead]);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    // Twice in a row: the second sweep finds nothing.
    expect(sweepStaleTestTempRoots(base).removed).toEqual([]);
  });

  it("reads a reused pid (a live process with another start time) as gone", () => {
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
    const live = createTestTempRoot(base);
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
    const root = createTestTempRoot(base);
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
    const root = createTestTempRoot(base);
    const nested = join(root, `isomux-run-${process.pid}-nestd1`);
    mkdirSync(nested);
    const foreignName = join(base, "isomux-test-home-abcdef");
    mkdirSync(foreignName);
    const elsewhere = createTestTempRoot(otherBase);
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

    first.kill("SIGKILL");
    await first.exited;
    // What the killed run left: its folder and its helper.
    expect(existsSync(root)).toBe(true);
    expect(alive(helper)).toBe(true);

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
