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
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { createAppRegistry } from "../server/app-registry.ts";
import { MEMBER_OS_USERS_FILE } from "../server/member-os-users.ts";
import { applyLockEffects } from "../server/locked-office.ts";
import {
  LOCK_MARKER_FILE,
  LOCKDOWN_APPS_FILE,
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
// The root-owned record of the member OS users whose linger lockdown --stop
// turned off, next to the root marker: the protocol between lock and unlock.
const MEMBER_RECORD = "lockdown-members";

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
  /** isomux-member-user's etc dir: one <user>.env per member OS user. */
  memberEtc: string;
  /** systemd's linger dir: one empty file per user whose linger is on. */
  linger: string;
  /** The passwd entries `getent` knows besides the service user. */
  passwd: string;
  /** Lines "<verb> <user>" (or "stop user@<uid>.service") that fail. */
  failFile: string;
  env: Record<string, string>;
  run(args: string[]): Promise<{ code: number; out: string }>;
  calls(): string[];
  /** Every loginctl call, as "<args> recorded=<yes|no>": whether the user
   *  was in the member record at the call. */
  loginctl(): string[];
}

function stub(binDir: string, name: string, body: string): void {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function rig(
  opts: { uid?: number; compromised?: boolean; failRecordWrite?: boolean } = {},
): Rig {
  dir = mkdtempSync(join(tmpdir(), "rescue-root-test-"));
  const bin = join(dir, "bin");
  const proc = join(dir, "proc");
  mkdirSync(proc);
  const stateRoot = join(dir, "home", ".isomux");
  const etc = join(dir, "etc");
  const conf = join(dir, "update.conf");
  const log = join(dir, "calls.log");
  const unitFile = join(dir, "unit");
  const memberEtc = join(dir, "member-runner");
  const linger = join(dir, "linger");
  const passwd = join(dir, "passwd");
  const failFile = join(dir, "fail");
  const record = join(etc, MEMBER_RECORD);
  for (const d of [bin, stateRoot, etc, memberEtc, linger])
    mkdirSync(d, { recursive: true });
  writeFileSync(unitFile, "active enabled\n");
  writeFileSync(log, "");
  writeFileSync(passwd, "");
  writeFileSync(failFile, "");
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
  // The service user, and the member OS users of the fixture's passwd.
  stub(
    bin,
    "getent",
    `[[ "$1" == passwd ]] || exit 2
if [[ "$2" == ${JSON.stringify(me.username)} ]]; then
  echo "$2:x:${me.uid}:${me.gid}::${join(dir, "home")}:/bin/bash"; exit 0
fi
awk -F: -v n="$2" '$1 == n { print; found = 1 } END { exit !found }' ${passwd} || exit 2`,
  );
  // loginctl enable-linger/disable-linger <user>: the linger file, as logind
  // keeps it. Each call is logged with whether the user was in the member
  // record at that moment.
  stub(
    bin,
    "loginctl",
    `recorded=no
[[ -f ${record} ]] && grep -qxF -- "$2" ${record} && recorded=yes
echo "loginctl $* recorded=$recorded" >> ${log}
grep -qxF -- "$*" ${failFile} && { echo "loginctl: failed" >&2; exit 1; }
case $1 in
  enable-linger) touch ${linger}/"$2" ;;
  disable-linger) rm -f ${linger}/"$2" ;;
esac
exit 0`,
  );
  if (opts.failRecordWrite)
    // Every write that lands on the member record fails, as on a full disk.
    stub(
      bin,
      "mv",
      `for last; do :; done
[[ $last == ${record} ]] && { echo "mv: no space left" >&2; exit 1; }
exec /usr/bin/mv "$@"`,
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
    `# An app unit, in the service user's manager: logged apart with the bus
# environment it was reached through, every unit loaded, running, enabled.
if [[ " $* " == *" isomux-app-"* ]]; then
  echo "app XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR-unset} DBUS_SESSION_BUS_ADDRESS=\${DBUS_SESSION_BUS_ADDRESS-unset} $*" >> ${log}
  for a in "$@"; do
    [[ $a == isomux-app-* ]] || continue
    case " $* " in
      *" is-enabled "*) echo enabled ;;
      *" show "*) printf 'Id=%s\\nLoadState=loaded\\nActiveState=active\\nSubState=running\\nNRestarts=0\\n\\n' "$a" ;;
    esac
  done
  exit 0
fi
# A member OS user's manager (user@<uid>.service): logged, never the office.
if [[ " $* " == *" user@"* ]]; then
  echo "systemctl $*" >> ${log}
  grep -qxF -- "$*" ${failFile} && { echo "systemctl: failed" >&2; exit 1; }
  exit 0
fi
echo "systemctl $*" >> ${log}
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
    // Never the box's own /etc/isomux/member-runner or linger dir.
    ISOMUX_RESCUE_MEMBER_ETC: memberEtc,
    ISOMUX_RESCUE_LINGER_DIR: linger,
  };
  return {
    stateRoot,
    etc,
    proc,
    conf,
    log,
    unitFile,
    memberEtc,
    linger,
    passwd,
    failFile,
    env,
    loginctl: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("loginctl "))
        .map((l) => l.replace(/^loginctl /, "")),
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
// in the fake /proc with `officePid` in its environ. `padding` bytes of other
// variables follow the marker.
function leftover(
  r: Rig,
  officePid: string,
  uid = userInfo().uid,
  padding = 0,
): Subprocess {
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
    `PATH=/usr/bin\0ISOMUX_OFFICE_PID=${officePid}\0` + paddingVars(padding),
  );
  return child;
}

// NUL-separated variables of about `bytes` bytes in total.
function paddingVars(bytes: number): string {
  const one = `PAD=${"x".repeat(1019)}\0`;
  return one.repeat(Math.ceil(bytes / one.length));
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
  // The marker near the start of a 1 MB environ: a reader that stops at the
  // match must still count it (task 8e6cd05d: `tr | grep -q` under pipefail
  // read this one as no match).
  const oursLarge = leftover(r, OFFICE_PID, userInfo().uid, 1 << 20);
  const largeEnviron = readFileSync(
    join(r.proc, String(oursLarge.pid), "environ"),
    "latin1",
  );
  expect({
    markerAt: largeEnviron.indexOf(`ISOMUX_OFFICE_PID=${OFFICE_PID}\0`),
    overOneMiB: largeEnviron.length > 1 << 20,
  }).toEqual({ markerAt: "PATH=/usr/bin\0".length, overOneMiB: true });
  // Another office of the same user, and another user's process.
  const other = leftover(r, "987654322");
  const otherUser = leftover(r, OFFICE_PID, userInfo().uid + 1);
  const lock = await r.run(["lockdown", "--reason", "leaked PAT"]);
  if (lock.code !== 0) console.error(lock.out);
  // The kills land before the wrapper returns; give the exit a moment.
  await Promise.race([
    Promise.all([ours.exited, oursLarge.exited]),
    Bun.sleep(2_000),
  ]);

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
    oursLargeAlive: alive(oursLarge),
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
    oursLargeAlive: false,
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

// A lock with --stop starts no locked office: the wrapper runs the lock's
// effects as the service user, and the app units live in that user's
// manager, which systemctl --user reaches through XDG_RUNTIME_DIR alone
// (deploy/install.sh user_manager_reachable). Root's own bus address must
// not leak in (task 367596bc).
test("lockdown --stop as root runs the lock-effects step, which stops and disables the office's apps through the service user's manager, never root's bus", async () => {
  const r = rig();
  createAppRegistry({
    dir: join(r.stateRoot, "apps"),
    probePort: () => true,
  }).register({
    name: "board",
    command: "true",
    cwd: r.stateRoot,
    userId: null,
    username: null,
    createdBy: "test",
  });
  r.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/0/bus";
  r.env.XDG_RUNTIME_DIR = "/run/user/0";
  const lock = await r.run(["lockdown", "--stop", "--reason", "x"]);
  if (lock.code !== 0) console.error(lock.out);
  const lines = readFileSync(r.log, "utf8").split("\n");
  const app = lines.filter((l) => l.startsWith("app "));
  const env = `XDG_RUNTIME_DIR=/run/user/${userInfo().uid} DBUS_SESSION_BUS_ADDRESS=unset`;
  expect({
    code: lock.code,
    step: lines.some(
      (l) => l.startsWith("runuser ") && / _step lock-effects( |$)/.test(l),
    ),
    // Every app call went to the service user's manager.
    wrongBus: app.filter((l) => !l.startsWith(`app ${env} --user `)),
    stopped: app.some((l) => / stop isomux-app-board\.service$/.test(l)),
    disabled: app.some((l) => / disable isomux-app-board\.service$/.test(l)),
    calls: r.calls(),
  }).toEqual({
    code: 0,
    step: true,
    wrongBus: [],
    stopped: true,
    disabled: true,
    calls: [`stop ${SERVICE}`, `disable ${SERVICE}`],
  });
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

// An isolated member's apps run under their own user manager, which their
// linger starts at every boot and which starts every enabled unit of theirs.
// lockdown --stop runs no locked office to stop them through their runner, so
// root turns their linger off and stops the manager, and the unlock turns the
// linger on again (task 367596bc part 2).
describe("lockdown --stop and the member OS users' apps", () => {
  // A member OS user as isomux-member-user enable leaves one: the .env that
  // ties them to an office, a passwd entry, and linger on.
  function member(
    r: Rig,
    name: string,
    uid: number,
    opts: { officeUid?: number; linger?: boolean; passwd?: boolean } = {},
  ): void {
    writeFileSync(
      join(r.memberEtc, `${name}.env`),
      `ISOMUX_OFFICE_UID=${opts.officeUid ?? userInfo().uid}\n`,
    );
    if (opts.passwd ?? true)
      writeFileSync(
        r.passwd,
        readFileSync(r.passwd, "utf8") +
          `${name}:x:${uid}:${uid}::/home/${name}:/bin/bash\n`,
      );
    if (opts.linger ?? true) writeFileSync(join(r.linger, name), "");
  }

  const record = (r: Rig): string[] | null => {
    const path = join(r.etc, MEMBER_RECORD);
    return existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter(Boolean).sort()
      : null;
  };
  const lingering = (r: Rig): string[] => readdirSync(r.linger).sort();
  const managerStops = (r: Rig): string[] =>
    r
      .calls()
      .filter((c) => c.includes("user@"))
      .sort();
  const officeCalls = (r: Rig): string[] =>
    r.calls().filter((c) => !c.includes("user@"));
  const fail = (r: Rig, ...lines: string[]) =>
    writeFileSync(r.failFile, lines.map((l) => `${l}\n`).join(""));

  test("turns off the linger of this office's members whose linger is on, after it recorded them, stops the user manager of every member of this office, and still disables the office", async () => {
    const r = rig();
    member(r, "mem-ann", 60001);
    // A member with linger off: a session can still hold their manager up.
    member(r, "mem-cat", 60003, { linger: false });
    // Another office's member, a user passwd does not know, and names that
    // are no user name (the second would read as an option).
    member(r, "mem-other", 60004, { officeUid: userInfo().uid + 1 });
    member(r, "mem-ghost", 60005, { passwd: false });
    member(r, "Bad.Name", 60006);
    member(r, "-x", 60007);
    const lock = await r.run(["lockdown", "--stop", "--reason", "x"]);
    if (lock.code !== 0) console.error(lock.out);
    const recordMode = existsSync(join(r.etc, MEMBER_RECORD))
      ? statSync(join(r.etc, MEMBER_RECORD)).mode & 0o777
      : null;
    expect({
      code: lock.code,
      loginctl: r.loginctl(),
      managerStops: managerStops(r),
      record: record(r),
      recordMode,
      lingering: lingering(r),
      office: officeCalls(r),
      unit: readFileSync(r.unitFile, "utf8").trim(),
    }).toEqual({
      code: 0,
      loginctl: ["disable-linger mem-ann recorded=yes"],
      managerStops: ["stop user@60001.service", "stop user@60003.service"],
      record: ["mem-ann"],
      recordMode: 0o644,
      lingering: ["-x", "Bad.Name", "mem-ghost", "mem-other"].sort(),
      office: [`stop ${SERVICE}`, `disable ${SERVICE}`],
      unit: "inactive disabled",
    });
  });

  test("a second lockdown --stop keeps the members the first one recorded and adds the new ones", async () => {
    const r = rig();
    member(r, "mem-ann", 60001);
    expect((await r.run(["lockdown", "--stop", "--reason", "x"])).code).toBe(0);
    expect(record(r)).toEqual(["mem-ann"]);
    member(r, "mem-bob", 60002);
    const again = await r.run(["lockdown", "--stop", "--reason", "y"]);
    if (again.code !== 0) console.error(again.out);
    expect({
      code: again.code,
      record: record(r),
      loginctl: r.loginctl(),
      lingering: lingering(r),
    }).toEqual({
      code: 0,
      record: ["mem-ann", "mem-bob"],
      loginctl: [
        "disable-linger mem-ann recorded=yes",
        "disable-linger mem-bob recorded=yes",
      ],
      lingering: [],
    });
  });

  test("lockdown without --stop leaves the members' linger and managers alone: the locked office stops their apps through their runners", async () => {
    const r = rig();
    member(r, "mem-ann", 60001);
    const lock = await r.run(["lockdown", "--reason", "x"]);
    if (lock.code !== 0) console.error(lock.out);
    expect({
      code: lock.code,
      loginctl: r.loginctl(),
      managerStops: managerStops(r),
      record: record(r),
      lingering: lingering(r),
    }).toEqual({
      code: 0,
      loginctl: [],
      managerStops: [],
      record: null,
      lingering: ["mem-ann"],
    });
  });

  test("a member whose linger or manager does not stop is named, and the lock stops the others and still disables the office", async () => {
    const r = rig();
    member(r, "mem-ann", 60001);
    member(r, "mem-bob", 60002);
    member(r, "mem-cat", 60003);
    fail(r, "disable-linger mem-ann", "stop user@60002.service");
    const lock = await r.run(["lockdown", "--stop", "--reason", "x"]);
    if (lock.code !== 0) console.error(lock.out);
    expect({
      code: lock.code,
      annNamed: lock.out.includes("mem-ann"),
      bobNamed: lock.out.includes("mem-bob"),
      managerStops: managerStops(r),
      // All three had linger on: the unlock turns it on for each.
      record: record(r),
      lingering: lingering(r),
      unit: readFileSync(r.unitFile, "utf8").trim(),
    }).toEqual({
      code: 0,
      annNamed: true,
      bobNamed: true,
      managerStops: [
        "stop user@60001.service",
        "stop user@60002.service",
        "stop user@60003.service",
      ],
      record: ["mem-ann", "mem-bob", "mem-cat"],
      lingering: ["mem-ann"],
      unit: "inactive disabled",
    });
  });

  test("a member record that does not write: the members are still stopped, and the output names the command that turns each one's linger on again", async () => {
    const r = rig({ failRecordWrite: true });
    member(r, "mem-ann", 60001);
    const lock = await r.run(["lockdown", "--stop", "--reason", "x"]);
    if (lock.code !== 0) console.error(lock.out);
    expect({
      code: lock.code,
      // The write did fail: no record.
      record: record(r),
      loginctl: r.loginctl(),
      managerStops: managerStops(r),
      command: lock.out.includes("loginctl enable-linger mem-ann"),
      unit: readFileSync(r.unitFile, "utf8").trim(),
    }).toEqual({
      code: 0,
      record: null,
      loginctl: ["disable-linger mem-ann recorded=no"],
      managerStops: ["stop user@60001.service"],
      command: true,
      unit: "inactive disabled",
    });
  });

  test("unlock turns linger on again for each recorded member still of this office, removes the record and starts the office", async () => {
    const r = rig();
    member(r, "mem-ann", 60001);
    member(r, "mem-bob", 60002);
    expect((await r.run(["lockdown", "--stop", "--reason", "x"])).code).toBe(0);
    expect(record(r)).toEqual(["mem-ann", "mem-bob"]);
    // isomux-member-user disable during the lock: bob's .env is gone, and
    // the unlock must not give him linger back.
    rmSync(join(r.memberEtc, "mem-bob.env"));
    writeFileSync(r.log, "");
    const unlock = await r.run(["unlock"]);
    if (unlock.code !== 0) console.error(unlock.out);
    expect({
      code: unlock.code,
      loginctl: r.loginctl(),
      lingering: lingering(r),
      record: record(r),
      unit: readFileSync(r.unitFile, "utf8").trim(),
    }).toEqual({
      code: 0,
      loginctl: ["enable-linger mem-ann recorded=yes"],
      lingering: ["mem-ann"],
      record: null,
      unit: "active enabled",
    });
  });

  test("an unlock whose enable-linger fails names the command to run, and still removes the record and starts the office", async () => {
    const r = rig();
    member(r, "mem-ann", 60001);
    member(r, "mem-bob", 60002);
    expect((await r.run(["lockdown", "--stop", "--reason", "x"])).code).toBe(0);
    fail(r, "enable-linger mem-ann");
    writeFileSync(r.log, "");
    const unlock = await r.run(["unlock"]);
    if (unlock.code !== 0) console.error(unlock.out);
    expect({
      code: unlock.code,
      command: unlock.out.includes("loginctl enable-linger mem-ann"),
      // The other member is still tried.
      lingering: lingering(r),
      record: record(r),
      unit: readFileSync(r.unitFile, "utf8").trim(),
    }).toEqual({
      code: 0,
      command: true,
      lingering: ["mem-bob"],
      record: null,
      unit: "active enabled",
    });
  });
});

// Without --stop the locked office's boot stops an isolated member's apps
// through their runner (server/locked-member-apps.ts) and records them, so
// the first normal boot after the unlock starts them again. Whatever the host
// command does first must leave that record to the locked boot for her apps
// (task 367596bc part 2).
test("lockdown without --stop: the locked boot that follows records the isolated member's app it stops, with the office's, for the unlock", async () => {
  const r = rig();
  const registry = createAppRegistry({
    dir: join(r.stateRoot, "apps"),
    probePort: () => true,
  });
  for (const [name, userId] of [
    ["board", null],
    ["iso", "u-iso"],
  ] as const)
    registry.register({
      name,
      command: "true",
      cwd: r.stateRoot,
      userId,
      username: null,
      createdBy: "test",
    });
  writeFileSync(
    join(r.stateRoot, MEMBER_OS_USERS_FILE),
    JSON.stringify({ "u-iso": { name: "mem-iso", uid: 60001 } }),
  );
  const lock = await r.run(["lockdown", "--reason", "x"]);
  if (lock.code !== 0) console.error(lock.out);
  expect(lock.code).toBe(0);
  // The locked boot (startLockedOffice): its router reaches both apps, the
  // office's through the office's manager and hers through her runner, and
  // both run (the box boot or her manager may have started them).
  const stopped: string[] = [];
  applyLockEffects({
    stateRoot: r.stateRoot,
    apps: {
      list: () => ["board", "iso"],
      isActive: (name) => !stopped.includes(name),
      stop: (name) => void stopped.push(name),
      start: () => {},
    },
    exportBaseDir: null,
    now: new Date(),
  });
  const path = join(r.stateRoot, LOCKDOWN_APPS_FILE);
  const recorded = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as string[]).sort()
    : null;
  expect({ stopped: stopped.sort(), recorded }).toEqual({
    stopped: ["board", "iso"],
    recorded: ["board", "iso"],
  });
});

test("export as root: makes the dir 0700 for the service user, runs the export step as that user, and refuses a dir that exists", async () => {
  const r = rig();
  mkdirSync(join(r.stateRoot, "memory"));
  writeFileSync(join(r.stateRoot, "memory", "office.md"), "kept-memory-line");
  const out = join(dir, "export-out");
  const res = await r.run(["export", out]);
  if (res.code !== 0) console.error(res.out);
  const runuser = readFileSync(r.log, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("runuser "));
  expect({
    code: res.code,
    mode: existsSync(out) ? statSync(out).mode & 0o777 : null,
    uid: existsSync(out) ? statSync(out).uid : null,
    memory: existsSync(join(out, "memory", "office.md"))
      ? readFileSync(join(out, "memory", "office.md"), "utf8")
      : null,
    step: runuser.some((l) => l.includes(`_step export ${out}`)),
    calls: r.calls(),
  }).toEqual({
    code: 0,
    mode: 0o700,
    uid: userInfo().uid,
    memory: "kept-memory-line",
    step: true,
    calls: [],
  });

  writeFileSync(r.log, "");
  const again = await r.run(["export", out]);
  expect({
    refused: again.code !== 0,
    runuser: readFileSync(r.log, "utf8").includes("_step export"),
  }).toEqual({ refused: true, runuser: false });
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

// The updater's root-owned folder and a stand-in for the installed updater,
// which records its arguments and exits with the code in updater-code.
function withUpdater(
  r: Rig,
  opts: { installed?: string; previous?: string; tags?: string[] } = {},
): {
  statusDir: string;
  calls: () => string[];
  exitWith: (code: number) => void;
} {
  const statusDir = join(dir, "status");
  mkdirSync(statusDir, { recursive: true });
  const callsFile = join(dir, "updater-calls");
  const codeFile = join(dir, "updater-code");
  writeFileSync(codeFile, "0\n");
  const updater = join(dir, "isomux-update");
  writeFileSync(
    updater,
    `#!/usr/bin/env bash\necho "$*" >> ${callsFile}\nexit "$(cat ${codeFile})"\n`,
  );
  chmodSync(updater, 0o755);
  writeFileSync(
    r.conf,
    readFileSync(r.conf, "utf8") +
      `STATUS_DIR=${statusDir}\nUPDATER_PATH=${updater}\n`,
  );
  if (opts.installed)
    writeFileSync(join(statusDir, "installed-release"), opts.installed + "\n");
  if (opts.previous)
    writeFileSync(join(statusDir, "previous-release"), opts.previous + "\n");
  if (opts.tags) {
    const trust = join(statusDir, "trust.git");
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(
        [
          "git",
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=T",
          "-C",
          trust,
          ...args,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    };
    mkdirSync(trust);
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "c");
    for (const tag of opts.tags) git("tag", tag);
  }
  return {
    statusDir,
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)
        : [],
    exitWith: (code) => writeFileSync(codeFile, `${code}\n`),
  };
}

describe("rollback", () => {
  test("runs the installed updater on the release the last update replaced, with the downgrade flag, and returns its exit code", async () => {
    const r = rig();
    const u = withUpdater(r, {
      installed: "v2026.11.6",
      previous: "v2026.11.5",
    });
    const ok = await r.run(["rollback"]);
    if (ok.code !== 0) console.error(ok.out);
    u.exitWith(3);
    const failed = await r.run(["rollback"]);
    expect({
      ok: ok.code,
      failed: failed.code,
      calls: u.calls(),
      // The updater does the stop and start, not the wrapper.
      systemctl: r.calls(),
    }).toEqual({
      ok: 0,
      failed: 3,
      calls: ["v2026.11.5 --allow-downgrade", "v2026.11.5 --allow-downgrade"],
      systemctl: [],
    });
  });

  test("a release named on the command line wins over the record", async () => {
    const r = rig();
    const u = withUpdater(r, {
      installed: "v2026.11.6",
      previous: "v2026.11.5",
    });
    expect((await r.run(["rollback", "v2026.11.4"])).code).toBe(0);
    expect(u.calls()).toEqual(["v2026.11.4 --allow-downgrade"]);
  });

  test("without a record it takes the newest release in the trust repo older than the installed one", async () => {
    const r = rig();
    const u = withUpdater(r, {
      installed: "v2026.11.6",
      tags: [
        "v2026.11.3",
        "v2026.11.5",
        "v2026.11.5.1",
        "v2026.11.6",
        "v2026.11.7",
        "not-a-release",
      ],
    });
    expect((await r.run(["rollback"])).code).toBe(0);
    expect(u.calls()).toEqual(["v2026.11.5.1 --allow-downgrade"]);
  });

  test("a record that is not a release tag is not a target", async () => {
    const r = rig();
    const u = withUpdater(r, {
      installed: "v2026.11.6",
      previous: "--help",
      tags: ["v2026.11.4", "v2026.11.6"],
    });
    expect((await r.run(["rollback"])).code).toBe(0);
    expect(u.calls()).toEqual(["v2026.11.4 --allow-downgrade"]);
  });

  type Refusal = [string, Parameters<typeof withUpdater>[1], string[], string?];
  const refusals: Refusal[] = [
    [
      "a name that is not a release tag",
      { installed: "v2026.11.6" },
      ["rollback", "main"],
    ],
    [
      "a flag in place of the release",
      { installed: "v2026.11.6" },
      ["rollback", "--allow-downgrade"],
    ],
    [
      "the installed release itself",
      { installed: "v2026.11.6", previous: "v2026.11.6" },
      ["rollback"],
    ],
    [
      "no record and no older release",
      { installed: "v2026.11.6", tags: ["v2026.11.6"] },
      ["rollback"],
    ],
    [
      "an office that lockdown --stop disabled",
      { installed: "v2026.11.6", previous: "v2026.11.5" },
      ["rollback"],
      "inactive disabled",
    ],
  ];
  for (const [name, setup, args, unit] of refusals) {
    test(`refuses ${name}, and the updater never runs`, async () => {
      const r = rig();
      const u = withUpdater(r, setup);
      if (unit) writeFileSync(r.unitFile, unit + "\n");
      const res = await r.run(args);
      expect({
        refused: res.code !== 0,
        calls: u.calls(),
        systemctl: r.calls(),
      }).toEqual({
        refused: true,
        calls: [],
        systemctl: [],
      });
    });
  }

  test("the way back it prints is the updater on the release it left, which every version has", async () => {
    const r = rig();
    withUpdater(r, { installed: "v2026.11.6", previous: "v2026.11.5" });
    const res = await r.run(["rollback"]);
    expect(res.out).toContain("isomux-update v2026.11.6");
  });
});

describe("report", () => {
  test("root reads the journal and the updater's records and the service user writes the file, 0600", async () => {
    const r = rig();
    const u = withUpdater(r, {
      installed: "v2026.11.6",
      previous: "v2026.11.5",
    });
    writeFileSync(
      join(u.statusDir, "status.json"),
      JSON.stringify({ result: "failed", message: "update-result-canary" }),
    );
    const file = join(dir, "incident.md");
    const res = await r.run(["report", file, "--note", "note-canary"]);
    if (res.code !== 0) console.error(res.out);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const step = readFileSync(r.log, "utf8")
      .split("\n")
      .find((l) => l.startsWith("runuser ") && l.includes("_step report"));
    expect({
      code: res.code,
      mode: existsSync(file) ? statSync(file).mode & 0o777 : null,
      uid: existsSync(file) ? statSync(file).uid : null,
      journal: text.includes("journal line"),
      release: text.includes("v2026.11.6"),
      previous: text.includes("v2026.11.5"),
      result: text.includes("update-result-canary"),
      note: text.includes("note-canary"),
      viaStdin: step?.includes("--journal-stdin") ?? false,
      systemctl: r.calls(),
    }).toEqual({
      code: 0,
      mode: 0o600,
      uid: userInfo().uid,
      journal: true,
      release: true,
      previous: true,
      result: true,
      note: true,
      viaStdin: true,
      systemctl: [],
    });
  });

  test("refuses a file inside the state root", async () => {
    const r = rig();
    withUpdater(r, { installed: "v2026.11.6" });
    const file = join(r.stateRoot, "incident.md");
    const res = await r.run(["report", file]);
    expect({ refused: res.code !== 0, made: existsSync(file) }).toEqual({
      refused: true,
      made: false,
    });
  });
});

test("status passes the installed release root read to the service user's status", async () => {
  const r = rig();
  withUpdater(r, { installed: "v2026.11.6" });
  await r.run(["status"]);
  const step = readFileSync(r.log, "utf8")
    .split("\n")
    .find((l) => l.startsWith("runuser ") && / status( |$)/.test(l));
  expect(step).toContain("--release v2026.11.6");
});
