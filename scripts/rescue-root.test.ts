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
