// deploy/install.sh - apt_install: an operator's hand-edited package config
// files survive a package run, and they are told it happened.
//
// The failure this exists for was reproduced on a live box: with a hand-edited
// /etc/caddy/Caddyfile, dpkg stops to ask which version to keep, finds nothing
// on stdin, and the run dies with "end of file on stdin at conffile prompt" -
// during an update's dependency phase, where the operator least wants it.
// DEBIAN_FRONTEND=noninteractive does not prevent that; -o
// Dpkg::Options::=--force-confold does, by keeping what is on the box.
//
// apt_install and report_kept_conffiles are extracted with sed (as in
// install-deps-mode.test.ts) and driven against an apt-get stub that behaves
// the way dpkg does: with the option it keeps the operator's file and parks the
// package's version as <file>.dpkg-dist, without it it dies at the prompt. So
// removing the option fails this file rather than a customer's update. Nothing
// is installed. Zero LLM.
//
// The stub BACKDATES the marker it writes, because real dpkg does. It unpacks
// the packaged conffile with the timestamp inside the .deb and renames that
// file into place, so a marker written seconds ago carries the archive's date -
// verified against real dpkg, a 2020 archive member produced a 2020-dated
// .dpkg-dist during a 2026 run. A stub that wrote the marker at "now" would let
// a detector keyed on "newer than the start of this run" pass here and miss
// every real package on a customer's box; the first version of this code did
// exactly that.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  chmodSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;
const SRC = readFileSync(INSTALL_SH, "utf8");

const OPERATOR_EDIT = "# hand-edited by the operator, months ago\n";
const PACKAGE_DEFAULT = "# the package's own version\n";
// What a marker from a previous package run looks like: dated from inside that
// .deb, so years old.
const OLD_MARKER_TIME = new Date("2020-02-02T02:02:00Z");

let base: string;
let bin: string;
let etc: string;
let conffile: string;

// apt-get stub standing in for dpkg's conffile handling.
//   --force-confold present -> keep the file that is there, park the package's
//                              version next to it as <file>.dpkg-dist, exit 0
//   absent                  -> what really happens: the prompt reads EOF and
//                              the run dies
// APT_FAIL=1 makes the install itself fail AFTER the conffile decision, which
// is the shape of a package that unpacks and then fails to configure.
function writeAptStub() {
  writeFileSync(
    join(bin, "apt-get"),
    `#!/usr/bin/env bash
printf '%s\\n' "apt-get $*" >> "$STUB_LOG"
[[ " $* " == *" install "* ]] || exit 0
if [[ " $* " != *" -o Dpkg::Options::=--force-confold "* ]]; then
  echo "Configuration file '\${CONFFILE}'" >&2
  echo "dpkg: error processing package caddy (--configure):" >&2
  echo " end of file on stdin at conffile prompt" >&2
  exit 1
fi
if [[ -n \${KEEPS_CONFFILE:-} ]]; then
  printf '%s' "\${MARKER_BODY}" > "\${CONFFILE}.dpkg-dist"
  # The archive's timestamp, not now. This is what real dpkg leaves behind.
  touch -t 202002020202 "\${CONFFILE}.dpkg-dist"
fi
exit \${APT_FAIL:-0}
`,
  );
  chmodSync(join(bin, "apt-get"), 0o755);
}

interface Run {
  out: string;
  code: number;
  calls: string[];
}

function runAptInstall(
  opts: {
    keepsConffile?: boolean;
    aptFails?: boolean;
    dryRun?: boolean;
    packages?: string[];
    markerBody?: string;
  } = {},
): Run {
  const stubLog = join(base, "stub.log");
  rmSync(stubLog, { force: true });
  const script = `
set -Eeuo pipefail
eval "$(grep -m1 '^APT_LOCK_TIMEOUT_SECONDS=' "$INSTALL_SH")"
eval "$(grep -m1 '^APT_LOCK_POLL_SECONDS=' "$INSTALL_SH")"
eval "$(sed -n '/^package_manager_locked()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^wait_for_package_manager()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^apt_get()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^apt_install()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^conffile_markers()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^report_kept_conffiles()/,/^}/p' "$INSTALL_SH")"
log() { printf 'LOG: %s\\n' "$*"; }
run() { "$@"; }
DRY_RUN="${opts.dryRun ? "1" : ""}"
CONFFILE_ROOT="${etc}"
rc=0
apt_install ${(opts.packages ?? ["caddy"]).join(" ")} || rc=$?
echo "RC: $rc"
exit "$rc"
`;
  const res = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      INSTALL_SH,
      STUB_LOG: stubLog,
      CONFFILE: conffile,
      ...(opts.keepsConffile ? { KEEPS_CONFFILE: "1" } : {}),
      ...(opts.aptFails ? { APT_FAIL: "1" } : {}),
      MARKER_BODY: opts.markerBody ?? PACKAGE_DEFAULT,
    },
    encoding: "utf8",
  });
  return {
    out: `${res.stdout}${res.stderr}`,
    code: res.status ?? -1,
    calls: existsSync(stubLog)
      ? readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean)
      : [],
  };
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "isomux-conffile-test-"));
  bin = join(base, "bin");
  etc = join(base, "etc");
  mkdirSync(bin);
  mkdirSync(join(etc, "caddy"), { recursive: true });
  conffile = join(etc, "caddy", "Caddyfile");
  writeAptStub();
});

beforeEach(() => {
  rmSync(`${conffile}.dpkg-dist`, { force: true });
  writeFileSync(conffile, OPERATOR_EDIT);
  // Backdate the operator's file: the report must pick out what dpkg wrote
  // during THIS run, not every .dpkg-dist that has ever been left in /etc.
  const old = new Date(Date.now() - 60_000);
  utimesSync(conffile, old, old);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("install.sh apt_install: operator edits survive a package run", () => {
  it("keeps the operator's file instead of dying at the conffile prompt", () => {
    const r = runAptInstall({ keepsConffile: true });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("end of file on stdin at conffile prompt");
    // The edit is still the edit.
    expect(readFileSync(conffile, "utf8")).toBe(OPERATOR_EDIT);
    // And the package's version is parked next to it, unapplied.
    expect(readFileSync(`${conffile}.dpkg-dist`, "utf8")).toBe(PACKAGE_DEFAULT);
  });

  it("passes the option on every package run", () => {
    const r = runAptInstall({ packages: ["caddy", "nodejs"] });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toContain("-o Dpkg::Options::=--force-confold");
    expect(r.calls[0]).toContain("install -y");
    expect(r.calls[0]).toContain("caddy nodejs");
  });

  it("names each file it kept, and where the packaged version went", () => {
    const r = runAptInstall({ keepsConffile: true });
    expect(r.out).toContain("apt shipped a new version of 1 package config");
    expect(r.out).toContain("your version was kept");
    expect(r.out).toContain(".dpkg-dist");
    // The path itself, so the operator knows which file to go and look at.
    expect(r.out).toContain(`LOG:   ${conffile}`);
    // Named without its marker suffix: that is the file they edited.
    expect(r.out).not.toContain(`LOG:   ${conffile}.dpkg-dist`);
  });

  it("says nothing when it kept nothing", () => {
    const r = runAptInstall();
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("package config");
    expect(existsSync(`${conffile}.dpkg-dist`)).toBe(false);
  });

  it("reports a marker dpkg backdated to the archive's timestamp", () => {
    // The regression that matters: the marker's mtime is the date inside the
    // .deb, so it is normally OLDER than the moment the run started. Detection
    // has to be "what changed", never "what is newer than now".
    const r = runAptInstall({ keepsConffile: true });
    expect(r.out).toContain(`LOG:   ${conffile}`);
    const marker = statSync(`${conffile}.dpkg-dist`);
    expect(marker.mtime.getUTCFullYear()).toBe(2020);
    expect(marker.mtimeMs).toBeLessThan(Date.now() - 60_000);
  });

  it("ignores a .dpkg-dist left behind by an earlier run", () => {
    // Already there before this run and untouched by it, so it has been
    // reported once already. Repeating it every run trains the operator to
    // ignore the message.
    writeFileSync(`${conffile}.dpkg-dist`, PACKAGE_DEFAULT);
    utimesSync(`${conffile}.dpkg-dist`, OLD_MARKER_TIME, OLD_MARKER_TIME);
    const r = runAptInstall();
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("package config");
  });

  it("reports a marker that this run overwrote", () => {
    // Same path as an earlier run's marker, new packaged content. Path
    // existence alone cannot tell the two apart, so a scan that only asked
    // "is there a .dpkg-dist here" would stay quiet about a fresh decision.
    writeFileSync(`${conffile}.dpkg-dist`, "# a much older packaged version\n");
    utimesSync(`${conffile}.dpkg-dist`, OLD_MARKER_TIME, OLD_MARKER_TIME);
    const r = runAptInstall({
      keepsConffile: true,
      markerBody: "# the newly shipped packaged version\n",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`LOG:   ${conffile}`);
    expect(readFileSync(conffile, "utf8")).toBe(OPERATOR_EDIT);
  });

  it("still fails the install when apt fails, and still reports", () => {
    // The report is not allowed to swallow the failure: a dependency sync that
    // half-installed has to reach report_failure and the rollback ladder.
    const r = runAptInstall({ keepsConffile: true, aptFails: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain("RC: 1");
    expect(r.out).toContain(`LOG:   ${conffile}`);
  });

  it("changes nothing in dry-run mode", () => {
    const r = runAptInstall({ dryRun: true });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(0);
    expect(r.out).toContain("DRY-RUN: apt-get install -y");
    expect(r.out).toContain("-o Dpkg::Options::=--force-confold");
  });
});

describe("install.sh: every package run goes through apt_install", () => {
  it("has no bare apt-get install left", () => {
    // A call added later that skips the helper reintroduces the exact failure
    // this lane fixed, on the one box that has edited configs. Line
    // continuations are folded first, so a call whose option sits on the next
    // line still counts as carrying it. Only command positions are considered:
    // "apt-get install" inside a message to the operator is prose.
    const bare = SRC.replace(/\\\n\s*/g, " ")
      .split("\n")
      .filter((l) =>
        /^\s*(if !\s+)?(run\s+)?([A-Z_]+=\S+\s+)*apt-get install/.test(l),
      )
      .filter((l) => !l.includes("Dpkg::Options::=--force-confold"));
    expect(bare).toEqual([]);
  });

  it("installs the packages through the helper", () => {
    expect(SRC).toMatch(/apt_install[^\n]*\bpolkitd\b/);
    expect(SRC).toMatch(/apt_install[^\n]*\bnodejs\b/);
  });
});
