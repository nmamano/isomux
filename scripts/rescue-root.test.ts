// scripts/rescue-root.sh, the root wrapper (task cdd7883d), driven with PATH
// stubs: `id` says root, `runuser` runs the rest of its line as this user,
// `systemctl` keeps a unit state in a file (its stop rewrites sessions.json as
// the server does), `curl` answers /readyz from the marker, and `getent` and
// `journalctl` answer from the fixture. scripts/rescue.ts runs for real in the
// checkout, so the state-root steps are the real ones.
//
// The leftover scan never reads the real /proc here: a regression that
// widened its rule would end every process of this user that carries an
// office marker, which outside an agent's own PID namespace is every agent of
// the live office (a widened mutant did end this test's own siblings,
// 2026-11-06). ISOMUX_RESCUE_PROC points it at a fake tree whose entries are
// real `sleep` children: their fake environ carries the marker, their real one
// does not, so only the wrapper's kill can end them.

import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  LOCK_MARKER_FILE,
  LOCKDOWN_DIR_PREFIX,
  QUARANTINED_FILES,
  ROOT_MARKER_FILE,
  readLockState,
} from "../server/lockdown.ts";

// The wrapper waits a real 2 s between its TERM and KILL passes.
setDefaultTimeout(30_000);

const REPO = join(import.meta.dir, "..");
const WRAPPER = join(import.meta.dir, "rescue-root.sh");
// Not "isomux": a test run from an agent shell sits in isomux.service's group,
// and the wrapper refuses to run there.
const SERVICE = "isomux-t-rescue-root";
// A main pid no live office has. Every leftover carries it.
const OFFICE_PID = "987654321";

let dir = "";
const children: Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

interface Rig {
  stateRoot: string;
  etc: string;
  proc: string;
  conf: string;
  log: string;
  unitFile: string;
  env: Record<string, string>;
  run(args: string[]): Promise<{ code: number; out: string }>;
  calls(): string[];
}

function stub(binDir: string, name: string, body: string): void {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function rig(opts: { uid?: number; compromised?: boolean } = {}): Rig {
  dir = mkdtempSync(join(tmpdir(), "rescue-root-test-"));
  const bin = join(dir, "bin");
  const proc = join(dir, "proc");
  mkdirSync(proc);
  const stateRoot = join(dir, "home", ".isomux");
  const etc = join(dir, "etc");
  const conf = join(dir, "update.conf");
  const log = join(dir, "calls.log");
  const unitFile = join(dir, "unit");
  for (const d of [bin, stateRoot, etc]) mkdirSync(d, { recursive: true });
  writeFileSync(unitFile, "active enabled\n");
  writeFileSync(log, "");
  const me = userInfo();
  writeFileSync(
    conf,
    [
      "REPO_DIR=" + REPO,
      "SERVICE_NAME=" + SERVICE,
      "SERVICE_KIND=system",
      "SERVICE_USER=" + me.username,
      "STATE_ROOT=" + stateRoot,
      "BUN=" + process.execPath,
      "BASE_URL=http://127.0.0.1:1",
      "",
    ].join("\n"),
  );
  const uid = opts.uid ?? 0;
  stub(
    bin,
    "id",
    `if [[ "$1" == -u && $# -eq 1 ]]; then echo ${uid}; else exec /usr/bin/id "$@"; fi`,
  );
  stub(
    bin,
    "getent",
    `[[ "$1" == passwd ]] && echo "$2:x:${me.uid}:${me.gid}::${join(dir, "home")}:/bin/bash"`,
  );
  // runuser -u <user> -- <command...>: the command, as this user. With
  // `compromised`, the checkout's code is an attacker's: every step it runs
  // does nothing, succeeds, and prints a marker body for another state root.
  stub(
    bin,
    "runuser",
    `echo "runuser $*" >> ${log}
while [[ $# -gt 0 && "$1" != -- ]]; do shift; done; shift
${
  opts.compromised
    ? `echo '{"since":"2026-11-06T10:00:00.000Z","reason":"","by":"host","stateRoot":"/nowhere"}'; exit 0`
    : ""
}
exec "$@"`,
  );
  stub(
    bin,
    "systemctl",
    `echo "systemctl $*" >> ${log}
read -r state enabled < ${unitFile}
verb=""
for a in "$@"; do case $a in stop|start|restart|enable|disable|is-active|is-enabled|show) verb=$a; break;; esac; done
now=0; [[ " $* " == *" --now "* ]] && now=1
stop_unit() { if [[ $state == active ]]; then echo flushed > ${join(stateRoot, "sessions.json")}; fi; state=inactive; }
case $verb in
  is-active) echo "$state"; [[ $state == active ]]; exit ;;
  is-enabled) echo "$enabled"; [[ $enabled == enabled ]]; exit ;;
  show) echo ${OFFICE_PID}; exit 0 ;;
  stop) stop_unit ;;
  start) state=active ;;
  restart) stop_unit; state=active ;;
  enable) enabled=enabled; ((now)) && state=active ;;
  disable) enabled=disabled; ((now)) && stop_unit ;;
esac
echo "$state $enabled" > ${unitFile}`,
  );
  stub(
    bin,
    "curl",
    `read -r state enabled < ${unitFile}
[[ $state == active ]] || exit 7
if [[ -e ${join(stateRoot, LOCK_MARKER_FILE)} || -e ${join(etc, ROOT_MARKER_FILE)} ]]; then echo locked; else echo ok; fi`,
  );
  stub(bin, "journalctl", `echo "journal line"`);
  const env = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: join(dir, "home"),
    ISOMUX_RESCUE_CONF: conf,
    ISOMUX_RESCUE_ROOT_MARKER_DIR: etc,
    ISOMUX_RESCUE_PROC: proc,
  };
  return {
    stateRoot,
    etc,
    proc,
    conf,
    log,
    unitFile,
    env,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("systemctl "))
        .map((l) => l.replace(/^systemctl /, ""))
        .filter((l) => !/^(is-active|is-enabled|show)\b/.test(l)),
    run: async (args) => {
      const p = Bun.spawn(["bash", WRAPPER, ...args], {
        cwd: dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { code, out: out + err };
    },
  };
}

// A real child of this user with no marker in its real environment, listed
// in the fake /proc with `officePid` in its environ.
function leftover(r: Rig, officePid: string, uid = userInfo().uid): Subprocess {
  const child = Bun.spawn(["sleep", "300"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(child);
  const entry = join(r.proc, String(child.pid));
  mkdirSync(entry);
  writeFileSync(
    join(entry, "status"),
    `Name:\tsleep\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
  );
  writeFileSync(
    join(entry, "environ"),
    `PATH=/usr/bin\0ISOMUX_OFFICE_PID=${officePid}\0`,
  );
  return child;
}

function alive(child: Subprocess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function lockdownAudits(stateRoot: string): string[] {
  const path = join(stateRoot, "office.sqlite");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return (
      db.query("SELECT operation FROM audit ORDER BY sequence").all() as {
        operation: string;
      }[]
    ).map((r) => r.operation);
  } finally {
    db.close();
  }
}

test("lockdown as root: both markers, the stop, the audit, this office's leftovers ended, the credentials the stop flushed moved aside, started locked; status then exits 2", async () => {
  const r = rig();
  for (const name of QUARANTINED_FILES)
    writeFileSync(join(r.stateRoot, name), `before ${name}`);
  const ours = leftover(r, OFFICE_PID);
  // Another office of the same user, and another user's process.
  const other = leftover(r, "987654322");
  const otherUser = leftover(r, OFFICE_PID, userInfo().uid + 1);
  const lock = await r.run(["lockdown", "--reason", "leaked PAT"]);
  if (lock.code !== 0) console.error(lock.out);
  // The kills land before the wrapper returns; give the exit a moment.
  await Promise.race([ours.exited, Bun.sleep(2_000)]);

  const state = readLockState(r.stateRoot, r.etc);
  const moved = readdirSync(r.stateRoot).filter((n) =>
    n.startsWith(LOCKDOWN_DIR_PREFIX),
  );
  expect({
    code: lock.code,
    markers: state.markers.map((m) => m.path).sort(),
    // Stopped, then started (locked).
    calls: r.calls(),
    audits: lockdownAudits(r.stateRoot),
    oursAlive: alive(ours),
    otherAlive: alive(other),
    otherUserAlive: alive(otherUser),
    leftInRoot: QUARANTINED_FILES.filter((n) =>
      existsSync(join(r.stateRoot, n)),
    ),
    movedDirs: moved.length,
  }).toEqual({
    code: 0,
    markers: [
      join(r.etc, ROOT_MARKER_FILE),
      join(r.stateRoot, LOCK_MARKER_FILE),
    ].sort(),
    calls: [`stop ${SERVICE}`, `start ${SERVICE}`],
    audits: ["office.lockdown"],
    oursAlive: false,
    otherAlive: true,
    otherUserAlive: true,
    leftInRoot: [],
    movedDirs: 1,
  });
  expect(
    readFileSync(join(r.stateRoot, moved[0], "sessions.json"), "utf8").trim(),
  ).toBe("flushed");
  // The root marker is root's: the service user cannot remove it.
  const rootMarker = state.markers.find(
    (m) => m.path === join(r.etc, ROOT_MARKER_FILE),
  );
  expect(rootMarker?.marker?.stateRoot).toBeDefined();

  const status = await r.run(["status"]);
  expect(status.code).toBe(2);
});

// The checkout belongs to the service user, so on a root install everything
// the wrapper runs through runuser is that user's code. The root marker is
// the one part of the lock that user cannot undo, so root must not take its
// content from that code: a compromised checkout would name another state
// root, and the office would boot unlocked once it removed its own marker.
test("the root marker locks this office even when the checkout's code is an attacker's", async () => {
  const r = rig({ compromised: true });
  await r.run(["lockdown", "--reason", "x"]);
  // The attacker's steps wrote no state marker; what the server reads at
  // boot is the root marker alone, and it names this office.
  expect(existsSync(join(r.stateRoot, LOCK_MARKER_FILE))).toBe(false);
  const state = readLockState(r.stateRoot, r.etc);
  expect({
    locked: state.locked,
    paths: state.markers.map((m) => m.path),
    names: state.markers[0]?.marker?.stateRoot,
  }).toEqual({
    locked: true,
    paths: [join(r.etc, ROOT_MARKER_FILE)],
    names: r.stateRoot,
  });
});

test("unlock as root removes both markers, audits and starts the office", async () => {
  const r = rig();
  expect((await r.run(["lockdown", "--stop", "--reason", "x"])).code).toBe(0);
  expect(readFileSync(r.unitFile, "utf8").trim()).toBe("inactive disabled");
  const unlock = await r.run(["unlock"]);
  if (unlock.code !== 0) console.error(unlock.out);
  expect({
    code: unlock.code,
    locked: readLockState(r.stateRoot, r.etc).locked,
    unit: readFileSync(r.unitFile, "utf8").trim(),
    audits: lockdownAudits(r.stateRoot),
  }).toEqual({
    code: 0,
    locked: false,
    unit: "active enabled",
    audits: ["office.lockdown", "office.unlock"],
  });
});

test("refuses to run as anyone but root, before any step", async () => {
  const r = rig({ uid: 1000 });
  const lock = await r.run(["lockdown", "--reason", "x"]);
  expect({
    refused: lock.code !== 0,
    calls: r.calls(),
    runuser: readFileSync(r.log, "utf8").includes("runuser"),
    locked: readLockState(r.stateRoot, r.etc).locked,
  }).toEqual({ refused: true, calls: [], runuser: false, locked: false });
});
