// One temp folder per test process (task 1ea8ab19). The preload creates it
// under the OS temp dir (/tmp on macOS) and points TMPDIR at it, so every tmpdir() caller in
// the run writes inside it. A run that is killed leaves it behind; the next
// run's preload removes it, and stops the processes the killed run left.
//
// IMPORTANT: like temp-state.ts, this file must not import server/config.ts
// (see preload.ts). It pulls in only fs/os/path.

import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  chmodSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, resolve, sep } from "path";

export type SweepResult = { removed: string[]; killed: number[] };

const RUN_PREFIX = "isomux-run-";
const RUN_NAME = /^isomux-run-(\d+)-[A-Za-z0-9]{6}$/;
const linux = process.platform === "linux";

// The fields of /proc/<pid>/stat after the command name, which can itself
// hold spaces and parentheses. Index 0 is the state, 1 the parent pid, 19 the
// start time (field 22). Null when the process is gone.
function statFields(pid: number | "self"): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// What the owner file says: "<pid> <start time>" on Linux, "<pid>" elsewhere.
// Null when it is missing, partial or unreadable.
function readOwner(root: string): { pid: number; start?: string } | null {
  let text: string;
  try {
    text = readFileSync(join(root, "owner"), "utf8");
  } catch {
    return null;
  }
  const match = (linux ? /^(\d+) (\d+)$/ : /^(\d+)(?: (\d+))?$/).exec(text);
  return match ? { pid: Number(match[1]), start: match[2] } : null;
}

// The folder that holds the run folders: the OS temp dir, or /tmp on macOS,
// whose per-user temp dir is ~50 bytes and leaves too little of the 104-byte
// socket path limit.
export function testTempBase(
  platform: NodeJS.Platform,
  osTemp: string,
): string {
  return realpathSync(platform === "darwin" ? "/tmp" : osTemp);
}

// Make `<base>/isomux-run-<pid>-XXXXXX` and record its owner. Returns the
// realpath of the new folder.
export function createTestTempRoot(base: string): string {
  const root = mkdtempSync(
    join(realpathSync(base), `${RUN_PREFIX}${process.pid}-`),
  );
  // Traversable, like the OS temp dir: some tests need their files in
  // directories other users can enter.
  chmodSync(root, 0o755);
  const start = linux ? statFields("self")?.[19] : undefined;
  const owner = start ? `${process.pid} ${start}` : `${process.pid}`;
  // Written whole or not at all: a torn record must not read as another run.
  writeFileSync(join(root, "owner.tmp"), owner);
  renameSync(join(root, "owner.tmp"), join(root, "owner"));
  return root;
}

// A run folder is stale when its owner is gone. A pid that a new process took
// over reads as gone through the start time. A record that names another pid
// is not ours to judge, and a missing or partial one may be mid-write, so
// both count as alive while the name's pid lives.
function isStale(root: string, namePid: number): boolean {
  const owner = readOwner(root);
  if (owner === null) return !pidAlive(namePid);
  if (owner.pid !== namePid) return false;
  if (!pidAlive(namePid)) return true;
  if (!linux || owner.start === undefined) return false;
  const start = statFields(namePid)?.[19];
  return start !== undefined && start !== owner.start;
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

// This process and its parents, which the sweep never stops.
function selfAndAncestors(): Set<number> {
  const pids = new Set<number>([process.pid]);
  let pid = process.ppid;
  while (pid > 1 && !pids.has(pid)) {
    pids.add(pid);
    const parent = Number(statFields(pid)?.[1]);
    if (!Number.isInteger(parent)) break;
    pid = parent;
  }
  return pids;
}

// The processes of this user that hold a path in one of `roots`: an
// environment value or the working folder. A command line does not count:
// it also names paths for a bystander (an agent's tail -f on a log).
function holders(roots: string[]): number[] {
  const uid = process.getuid?.();
  const spared = selfAndAncestors();
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (spared.has(pid)) continue;
    try {
      if (statSync(`/proc/${entry}`).uid !== uid) continue;
      const holds = (path: string) => roots.some((root) => inside(path, root));
      let held = false;
      try {
        held = holds(readlinkSync(`/proc/${entry}/cwd`));
      } catch {
        // no cwd to read (kernel thread, or gone)
      }
      if (!held) {
        for (const pair of readFileSync(`/proc/${entry}/environ`, "utf8").split(
          "\0",
        )) {
          const eq = pair.indexOf("=");
          if (eq > 0 && holds(pair.slice(eq + 1))) {
            held = true;
            break;
          }
        }
      }
      if (held) found.push(pid);
    } catch {
      // the process went away, or is not readable: not ours
    }
  }
  return found;
}

// Remove every run folder in `base` whose owner process is gone, after
// stopping the processes that still hold a path inside it.
export function sweepStaleTestTempRoots(base: string): SweepResult {
  const realBase = realpathSync(base);
  const uid = process.getuid?.();
  const stale: string[] = [];
  for (const name of readdirSync(realBase)) {
    const match = RUN_NAME.exec(name);
    if (!match) continue;
    const root = join(realBase, name);
    try {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid))
        continue;
      if (isStale(root, Number(match[1]))) stale.push(root);
    } catch {
      // gone since the readdir
    }
  }
  const result: SweepResult = { removed: [], killed: [] };
  if (stale.length === 0) return result;
  if (linux) {
    for (const pid of holders(stale)) {
      try {
        process.kill(pid, "SIGKILL");
        result.killed.push(pid);
      } catch {
        // already gone
      }
    }
  }
  for (const root of stale) {
    try {
      rmSync(root, { recursive: true, force: true });
      result.removed.push(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? String(err);
      console.error(`[test preload] could not remove ${root}: ${code}`);
    }
  }
  return result;
}

// Remove this process's own run folder at the end of a run. Refuses anything
// that is not a run folder directly in `base`.
export function removeTestTempRoot(base: string, root: string): void {
  const realBase = realpathSync(base);
  const target = resolve(root);
  const match = RUN_NAME.exec(basename(target));
  if (
    dirname(target) !== realBase ||
    match === null ||
    Number(match[1]) !== process.pid ||
    !lstatSync(target).isDirectory()
  ) {
    throw new Error(
      `Refusing to delete ${root}: not this run's folder in ${realBase}.`,
    );
  }
  rmSync(target, { recursive: true, force: true });
}
