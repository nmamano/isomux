// deploy/install.sh configure_codex_sandbox - the step that makes codex's
// bubblewrap sandbox actually start on an Ubuntu 24.04 box. The functions are
// extracted from the installer with sed (as in install-deps-mode.test.ts) and
// RUN against stubs that reproduce the real failure: a `bwrap` that refuses to
// unshare until an AppArmor profile is loaded, an `apparmor_parser` that
// "loads" one, and an apt that can install packages or not. So the probe gate
// is exercised, not pattern-matched - a box where bwrap works is proven
// untouched, and a box where it does not is proven to end up with the
// two-stage profile rather than a weakened policy. Nothing is installed.
// Zero LLM.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;

let base: string;
/** /usr/bin with bwrap removed - see makeShadowPath. */
let shadow: string;

// This box may well have a working bwrap of its own, and "the binary is
// missing" is one of the cases under test. So the script runs on a PATH built
// from a symlink farm of /usr/bin minus bwrap, and nothing else: whether bwrap
// exists is then entirely the test's to decide.
function makeShadowPath() {
  shadow = join(base, "usr-bin");
  mkdirSync(shadow);
  for (const entry of readdirSync("/usr/bin")) {
    if (entry === "bwrap") continue;
    try {
      symlinkSync(join("/usr/bin", entry), join(shadow, entry));
    } catch {
      // A name that already exists here is fine; nothing else matters.
    }
  }
}

function stub(dir: string, name: string, body: string) {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}`);
  chmodSync(p, 0o755);
}

// bwrap fails exactly the way the real one does under
// kernel.apparmor_restrict_unprivileged_userns=1, until the profile is loaded.
const BWRAP_STUB = `
echo "bwrap $*" >> "$STUB_LOG"
[[ $(cat "$AA_LOADED") == 1 ]] && exit 0
echo "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" >&2
exit 1
`;

const PARSER_STUB = `
echo "apparmor_parser $*" >> "$STUB_LOG"
if [[ -n \${PARSER_FAILS:-} ]]; then
  echo "AppArmor parser error for $2" >&2
  exit 1
fi
echo 1 > "$AA_LOADED"
exit 0
`;

// runuser -u USER -- env HOME=... CMD...  Runs the command here, so
// as_service_user itself is under test rather than replaced.
const RUNUSER_STUB = `
shift 2
[[ \${1:-} == -- ]] && shift
exec "$@"
`;

interface Run {
  calls: string[];
  out: string;
  code: number;
  /** Contents of the profile the step put in place, or null. */
  profile: string | null;
  reachedEnd: boolean;
}

interface Opts {
  /** bwrap works from the start (no AppArmor problem at all). */
  bwrapWorks?: boolean;
  /** bwrap binary is absent until apt installs it. */
  bwrapMissing?: boolean;
  /** /proc knob: 1 restricted, 0 not, "absent" for a kernel without it. */
  userns?: "1" | "0" | "absent";
  /** apparmor-profiles ships the profile to copy. */
  packagedProfile?: boolean;
  /** apt-get install fails for every package. */
  aptFails?: boolean;
  /** apparmor_parser refuses to load the profile. */
  parserFails?: boolean;
  /** bwrap keeps failing even once the profile is loaded. */
  neverWorks?: boolean;
  /** An /etc/apparmor.d copy is already there before the step runs. */
  preexistingProfile?: string;
  /** The operator disabled the profile via /etc/apparmor.d/disable. */
  disabled?: boolean;
  /** `install` fails, standing in for a copy that cannot land. */
  installFails?: boolean;
  /** `install` succeeds but leaves a file that cannot be written to. */
  installMakesUnwritable?: boolean;
  /** The profile's directory does not exist, so writing it cannot work. */
  unwritableProfileDir?: boolean;
  dryRun?: boolean;
}

function runStep(opts: Opts): Run {
  const dir = mkdtempSync(join(base, "case-"));
  const bin = join(dir, "bin");
  const etc = join(dir, "apparmor.d");
  const extras = join(dir, "extra-profiles");
  mkdirSync(bin);
  mkdirSync(etc);
  mkdirSync(extras);

  const stubLog = join(dir, "stub.log");
  const aaLoaded = join(dir, "aa-loaded");
  const profile = opts.unwritableProfileDir
    ? join(etc, "no-such-dir", "bwrap-userns-restrict")
    : join(etc, "bwrap-userns-restrict");
  const packaged = join(extras, "bwrap-userns-restrict");
  const sysctl = join(dir, "userns-knob");
  const disableDir = join(etc, "disable");
  const disabled = join(disableDir, "bwrap-userns-restrict");
  if (opts.disabled) {
    // What aa-disable actually leaves behind: a relative symlink to the
    // profile. Its target does not exist yet on the box this step runs on,
    // so the link is dangling - the case a plain -e test gets wrong.
    mkdirSync(disableDir);
    symlinkSync("../bwrap-userns-restrict", disabled);
  }

  writeFileSync(stubLog, "");
  // "Loaded" starts true only when bwrap is supposed to work already; the
  // neverWorks case pins it false so even a load does not help.
  writeFileSync(aaLoaded, opts.bwrapWorks ? "1\n" : "0\n");
  if ((opts.userns ?? "1") !== "absent")
    writeFileSync(sysctl, `${opts.userns ?? "1"}\n`);
  if (opts.packagedProfile) writeFileSync(packaged, "# packaged profile\n");
  if (opts.preexistingProfile) writeFileSync(profile, opts.preexistingProfile);

  if (!opts.bwrapMissing) stub(bin, "bwrap", BWRAP_STUB);
  stub(bin, "runuser", RUNUSER_STUB);
  if (opts.installFails) {
    stub(
      bin,
      "install",
      'echo "install: cannot create regular file" >&2\nexit 1\n',
    );
  }
  // Reports success and leaves a read-only file, so the create guard passes
  // and the write that follows it fails. The directory stays writable, so the
  // step's cleanup can still remove what it made.
  if (opts.installMakesUnwritable) {
    stub(bin, "install", 'p="${@: -1}"\n: > "$p"\nchmod 444 "$p"\nexit 0\n');
  }
  stub(
    bin,
    "apparmor_parser",
    opts.neverWorks
      ? PARSER_STUB.replace('echo 1 > "$AA_LOADED"', "true")
      : PARSER_STUB,
  );
  // apt-get install: logs, and delivers the package's files unless told to
  // fail. Installing bubblewrap is what makes the bwrap binary appear.
  stub(
    bin,
    "apt-get",
    `
echo "apt-get $*" >> "$STUB_LOG"
[[ -n \${APT_FAILS:-} ]] && exit 100
for pkg in "$@"; do
  case "$pkg" in
    bubblewrap) cp "$BWRAP_SRC" "${bin}/bwrap"; chmod 755 "${bin}/bwrap" ;;
  esac
done
exit 0
`,
  );
  // The bubblewrap "package" content, kept outside PATH until apt installs it.
  const bwrapSrc = join(dir, "bwrap.src");
  writeFileSync(bwrapSrc, `#!/usr/bin/env bash\n${BWRAP_STUB}`);
  chmodSync(bwrapSrc, 0o755);

  const script = `
set -Eeuo pipefail
# FIRST definition only: install.sh also carries deploy/harden-ssh.sh and
# deploy/oom-protect.sh inside heredocs, and those define their own
# as_service_user / run / write_file. A plain sed range would eval the
# embedded copy over the installer's own and test the wrong function.
extract() { awk -v fn="$1() {" 'index($0, fn) == 1 {f = 1} f {print} f && /^}$/ {exit}' "$INSTALL_SH"; }
for fn in run as_service_user write_file configure_codex_sandbox \
  bwrap_smoke_test userns_restricted install_bwrap_profile; do
  eval "$(extract "$fn")"
done
# The heredoc body has its own column-0 braces, so this range ends at the
# delimiter and the closing brace is added back.
eval "$(sed -n '/^vendored_bwrap_profile()/,/^ISOMUX_BWRAP_USERNS_RESTRICT$/p' "$INSTALL_SH"; echo '}')"
SERVICE_USER=$(id -un)
SERVICE_HOME=$HOME
DRY_RUN="${opts.dryRun ? "1" : ""}"
BWRAP_PROFILE_NAME=bwrap-userns-restrict
BWRAP_PROFILE="${profile}"
BWRAP_PROFILE_DISABLED="${disabled}"
BWRAP_PROFILE_PACKAGED="${packaged}"
USERNS_RESTRICT_SYSCTL="${sysctl}"
log() { echo "LOG: $*"; }
step() { echo "STEP: $1"; }
die() { echo "DIE: $*"; exit 1; }
apt_install() { apt-get install -y "$@"; }
configure_codex_sandbox
echo "REACHED-END"
`;
  const res = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${shadow}`,
      INSTALL_SH,
      STUB_LOG: stubLog,
      AA_LOADED: aaLoaded,
      BWRAP_SRC: bwrapSrc,
      ...(opts.aptFails ? { APT_FAILS: "1" } : {}),
      ...(opts.parserFails ? { PARSER_FAILS: "1" } : {}),
    },
    encoding: "utf8",
  });
  const out = `${res.stdout}${res.stderr}`;
  return {
    calls: readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean),
    out,
    code: res.status ?? -1,
    profile: existsSync(profile) ? readFileSync(profile, "utf8") : null,
    reachedEnd: out.includes("REACHED-END"),
  };
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "isomux-codex-sandbox-test-"));
  makeShadowPath();
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("install.sh codex sandbox: the probe decides", () => {
  it("touches nothing when bwrap already works", () => {
    // A future Ubuntu that fixes this upstream, or a distro that never had the
    // restriction: the installer has no business loading AppArmor policy there.
    const r = runStep({ bwrapWorks: true });
    expect(r.out).toContain("codex sandbox ready: bwrap works for");
    expect(r.profile).toBeNull();
    expect(r.calls.filter((c) => c.startsWith("apparmor_parser"))).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith("apt-get"))).toEqual([]);
    expect(r.reachedEnd).toBe(true);
  });

  it("installs bubblewrap when the binary is missing", () => {
    const r = runStep({ bwrapMissing: true, bwrapWorks: true });
    expect(r.calls.some((c) => /apt-get install .*bubblewrap/.test(c))).toBe(
      true,
    );
    expect(r.out).toContain("codex sandbox ready");
    expect(r.profile).toBeNull();
  });

  it("enables the packaged profile when the userns restriction is the cause", () => {
    // The verified recipe: apt-get the profiles package, copy the one profile
    // into /etc/apparmor.d, reload it, and re-run the same smoke test.
    const r = runStep({ userns: "1", packagedProfile: true });
    expect(
      r.calls.some((c) => /apt-get install .*apparmor-profiles/.test(c)),
    ).toBe(true);
    expect(r.profile).toBe("# packaged profile\n");
    expect(r.calls.some((c) => c.startsWith("apparmor_parser -r"))).toBe(true);
    expect(r.out).toContain(
      "codex sandbox ready: loaded the bwrap-userns-restrict AppArmor profile",
    );
    // Only this profile. The package's other extras stay where they are.
    expect(r.calls.filter((c) => c.startsWith("apparmor_parser")).length).toBe(
      1,
    );
  });

  it("falls back to the vendored two-stage profile when the package has none", () => {
    const r = runStep({ userns: "1", packagedProfile: false });
    expect(r.profile).toContain("profile bwrap /usr/bin/bwrap");
    expect(r.profile).toContain("profile unpriv_bwrap");
    // The whole point: bwrap's children lose capabilities, so bwrap is not a
    // way around the box-wide restriction.
    expect(r.profile).toContain("audit deny capability");
    expect(r.profile).toContain("allow px /** -> bwrap//&unpriv_bwrap");
    expect(r.profile).not.toContain("flags=(unconfined)");
    expect(r.out).toContain("installed its vendored copy of the upstream one");
    expect(r.out).toContain("codex sandbox ready");
  });

  it("never weakens policy when AppArmor is not the cause", () => {
    // bwrap broken on a box that does not restrict user namespaces means
    // something else is wrong; loading policy would not fix it, and turning
    // policy off to make the message stop is the thing not to do.
    for (const userns of ["0", "absent"] as const) {
      const r = runStep({ userns });
      expect(r.profile).toBeNull();
      expect(r.calls.filter((c) => c.startsWith("apparmor_parser"))).toEqual(
        [],
      );
      expect(r.out).toContain("AppArmor policy is not the cause");
      // The real diagnostic, not a generic "sandbox unavailable".
      expect(r.out).toContain("Failed RTM_NEWADDR: Operation not permitted");
      expect(r.reachedEnd).toBe(true);
    }
  });

  it("does not overwrite a profile already in /etc/apparmor.d", () => {
    // It may be the operator's, and the step's job is to get bwrap working,
    // not to own that file.
    const mine = "# the operator's own copy\n";
    const r = runStep({
      userns: "1",
      packagedProfile: true,
      preexistingProfile: mine,
    });
    expect(r.profile).toBe(mine);
    expect(r.calls.some((c) => c.startsWith("apparmor_parser -r"))).toBe(true);
    expect(r.out).toContain("reloading the AppArmor profile already at");
  });

  it("leaves a profile the operator disabled disabled", () => {
    // apparmor_parser -r ignores /etc/apparmor.d/disable, so without this
    // check the step would silently undo an explicit opt-out.
    const r = runStep({ userns: "1", packagedProfile: true, disabled: true });
    expect(r.calls.filter((c) => c.startsWith("apparmor_parser"))).toEqual([]);
    expect(r.profile).toBeNull();
    expect(r.out).toContain("Leaving it disabled");
    expect(r.reachedEnd).toBe(true);
    expect(r.code).toBe(0);
  });

  it("re-running on a fixed box does nothing at all", () => {
    // install.sh re-runs on update, and the dependency-sync mode runs it on a
    // live box. A second pass must be a no-op, which the probe gives for free.
    const first = runStep({ userns: "1", packagedProfile: true });
    expect(first.out).toContain("codex sandbox ready: loaded the");
    const second = runStep({
      userns: "1",
      packagedProfile: true,
      bwrapWorks: true,
    });
    expect(second.calls.filter((c) => c.startsWith("apparmor_parser"))).toEqual(
      [],
    );
    expect(second.profile).toBeNull();
  });

  it("does nothing in dry-run mode", () => {
    const r = runStep({ userns: "1", packagedProfile: true, dryRun: true });
    expect(r.calls).toEqual([]);
    expect(r.profile).toBeNull();
    expect(r.out).toContain("DRY-RUN: would install bubblewrap");
  });
});

describe("install.sh codex sandbox: a broken sandbox is a warning, not a failed install", () => {
  // An office without a working bubblewrap still runs everything else, so none
  // of these may abandon the install - or, in dependency-sync mode, an update.
  it("survives an apt that cannot install the packages", () => {
    const r = runStep({ bwrapMissing: true, aptFails: true });
    expect(r.out).toContain("could not install the bubblewrap package");
    expect(r.reachedEnd).toBe(true);
    expect(r.code).toBe(0);
  });

  it("names the copy as what failed, not the parser", () => {
    // The caller runs this function as `install_bwrap_profile || return 0`,
    // which switches errexit off inside it. Unguarded, a failed copy would
    // fall through and the operator would be told the PARSER could not read a
    // file - never that the copy is what broke.
    const r = runStep({
      userns: "1",
      packagedProfile: true,
      installFails: true,
    });
    // The diagnostic has to be IN the warning line, not merely somewhere in
    // the output: a capture that misses it would still leave install's own
    // stderr loose in the log and look fine.
    expect(r.out).toMatch(
      /LOG: warning: could not copy the bwrap-userns-restrict[^\n]*install said: install: cannot create regular file/,
    );
    expect(r.out).not.toContain("apparmor_parser said");
    expect(r.out).not.toContain("enabled Ubuntu's packaged");
    expect(r.calls.filter((c) => c.startsWith("apparmor_parser"))).toEqual([]);
    expect(r.reachedEnd).toBe(true);
    expect(r.code).toBe(0);
  });

  // The vendored branch creates the file and fills it as two separate
  // commands, and errexit is off in here. write_file does the same two things
  // and returns only the SECOND one's status, so a failed create followed by a
  // successful write returns 0 - which is why this path no longer goes through
  // it. One case per guard.
  it("names the create as what failed, on the vendored path", () => {
    // The masking case: a writable parent, so a create failure would be
    // followed by a write that succeeds and reports the whole thing fine.
    const r = runStep({
      userns: "1",
      packagedProfile: false,
      installFails: true,
    });
    expect(r.out).toMatch(
      /LOG: warning: could not create[^\n]*install said: install: cannot create regular file/,
    );
    expect(r.out).not.toContain("apparmor_parser said");
    expect(r.out).not.toContain("installed its vendored copy");
    expect(r.profile).toBeNull();
    expect(r.calls.filter((c) => c.startsWith("apparmor_parser"))).toEqual([]);
    expect(r.reachedEnd).toBe(true);
    expect(r.code).toBe(0);
  });

  it("names the write as what failed, and leaves no empty profile behind", () => {
    // A create that reports success without producing the file, and a
    // directory that then refuses the write. The file must not be left for the
    // next run to find and hand to the parser.
    const r = runStep({
      userns: "1",
      packagedProfile: false,
      installMakesUnwritable: true,
    });
    expect(r.out).toMatch(
      /LOG: warning: could not write the vendored bwrap-userns-restrict[^\n]*The error was:[^\n]*Permission denied/,
    );
    expect(r.out).not.toContain("apparmor_parser said");
    expect(r.out).not.toContain("installed its vendored copy");
    expect(r.profile).toBeNull();
    expect(r.calls.filter((c) => c.startsWith("apparmor_parser"))).toEqual([]);
    expect(r.reachedEnd).toBe(true);
    expect(r.code).toBe(0);
  });

  it("reports a profile directory that does not exist", () => {
    const r = runStep({
      userns: "1",
      packagedProfile: false,
      unwritableProfileDir: true,
    });
    expect(r.out).toContain("could not create");
    expect(r.out).not.toContain("apparmor_parser said");
    expect(r.calls.filter((c) => c.startsWith("apparmor_parser"))).toEqual([]);
    expect(r.reachedEnd).toBe(true);
    expect(r.code).toBe(0);
  });

  it("survives an apparmor_parser that refuses the profile", () => {
    const r = runStep({
      userns: "1",
      packagedProfile: true,
      parserFails: true,
    });
    expect(r.out).toContain("could not load the AppArmor profile");
    // Says what the parser said, and does not claim the sandbox is ready.
    expect(r.out).toContain("AppArmor parser error");
    expect(r.out).not.toContain("codex sandbox ready");
    expect(r.reachedEnd).toBe(true);
    expect(r.code).toBe(0);
  });

  it("survives a bwrap that still fails once the profile is loaded", () => {
    const r = runStep({ userns: "1", packagedProfile: true, neverWorks: true });
    expect(r.out).toContain("still does not work for");
    expect(r.out).toContain("Failed RTM_NEWADDR: Operation not permitted");
    expect(r.reachedEnd).toBe(true);
    expect(r.code).toBe(0);
  });

  it("has no die anywhere in the step", () => {
    const src = readFileSync(INSTALL_SH, "utf8");
    const fn = src.slice(
      src.indexOf("configure_codex_sandbox() {"),
      src.indexOf("# Default ISOMUX_REF:"),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).not.toContain("die ");
    // Never the two shortcuts that make the symptom go away. Comments
    // stripped: the step's own comment names both in order to rule them out.
    const code = fn
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toContain("flags=(unconfined)");
    expect(code).not.toContain("apparmor_restrict_unprivileged_userns=0");
    expect(code).not.toMatch(
      /sysctl[^\n]*apparmor_restrict_unprivileged_userns/,
    );
  });
});
