// deploy/install.sh ISOMUX_DEPS_ONLY mode - the behavior scripts/update.sh
// leans on during an update. snapshot_caddy_state, restore_caddy_state,
// deps_only and report_failure are extracted from the installer with sed (as in
// install-resolve-ref.test.ts) and driven against a STATEFUL systemctl stub
// that holds real active/enabled state, so the invariant is exercised rather
// than pattern-matched: a dependency sync leaves the proxy exactly as it found
// it, in both directions, on success and after a failed package run. The
// install_packages stub can mutate Caddy the way apt does (masking it on an
// unclaimed box, or a maintainer script starting it on a claimed one).
// Nothing is installed. Zero LLM.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;

let base: string;
let bin: string;

// systemctl stub with real state: start/stop/enable/disable move it, and
// is-active/is-enabled report it. FAIL_VERB makes one verb fail, standing in
// for a systemd that refuses to bring the proxy back.
function writeSystemctlStub() {
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
# First non-flag argument is the verb (calls carry -q).
verb=""
for a in "$@"; do
  [[ $a == -* ]] || { verb=$a; break; }
done
if [[ $verb == cat ]]; then
  [[ $(cat "$UNIT_FILE") == present ]] || exit 4
  exit 0
fi
if [[ -n \${FAIL_VERB:-} && $verb == \${FAIL_VERB} ]]; then exit 1; fi
case "$verb" in
  start) echo active > "$ACTIVE_FILE" ;;
  stop) echo inactive > "$ACTIVE_FILE" ;;
  enable) echo enabled > "$ENABLED_FILE" ;;
  disable) echo disabled > "$ENABLED_FILE" ;;
  is-active) [[ $(cat "$ACTIVE_FILE") == active ]] || exit 3 ;;
  is-enabled) [[ $(cat "$ENABLED_FILE") == enabled ]] || exit 1 ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "systemctl"), 0o755);
}

interface Run {
  calls: string[];
  out: string;
  code: number;
  active: boolean;
  enabled: boolean;
  unit: boolean;
  // The step names and stubbed stages deps_only reached, in order.
  stages: string[];
}

// The stubs below echo these names first on their line.
const STAGES = [
  "install_packages",
  "converge_bun",
  "configure_oom_protection",
  "backfill_firewall_record",
  "restore_recorded_firewall_rules",
  "install_hardening_verifier",
  "verify-hardening",
  "install_browser",
  "configure_codex_sandbox",
  "configure_user_manager",
  "refresh_hosted_tls_renewal",
  "migrate_caddy_access_log",
  "write_loopback_bind_if_proxied",
  "write_update_outcome",
];

// Full-install steps a dependency sync must never run. Each is a tripwire
// that prints FORBIDDEN:<name>; every run asserts none fired.
const FORBIDDEN = [
  "preflight",
  "sync_install_kind",
  "configure_firewall",
  "harden_ssh",
  "enable_auto_updates",
  "create_service_user",
  "check_root_reachability",
  "fetch_isomux",
  "install_bun",
  "build_isomux",
  "link_bundled_claude",
  "install_updater",
  "install_service",
  "wait_for_server",
  "assert_hardening",
  "claim_owner",
  "configure_public_access",
  "mint_invite",
  "configure_caddy",
  "apply_proxy_settings",
  "report",
];

// aptDoes: what install_packages does to caddy before returning.
//   mask    the unverifiable-office path (stop + disable)
//   adopt   a package upgrade whose maintainer script starts and enables it
//   install the package was missing and the dependency step installs it, unit
//           and all, started and enabled the way a fresh .deb leaves it
//   purge   the unit disappears under us
function runDepsMode(opts: {
  active: boolean;
  enabled: boolean;
  aptDoes?: "nothing" | "mask" | "adopt" | "install" | "purge";
  packagesFail?: boolean;
  failVerb?: string;
  noCaddyUnit?: boolean;
  migrationFails?: boolean;
  frontDoorHealthy?: boolean;
  convergeFails?: boolean;
  // Caddyfile carries the installer marker; the verifier exits with this.
  markerVerifyRc?: number;
}): Run {
  const stubLog = join(base, "stub.log");
  const activeFile = join(base, "caddy-active");
  const enabledFile = join(base, "caddy-enabled");
  const unitFile = join(base, "caddy-unit");
  const caddyfile = join(base, "Caddyfile");
  rmSync(stubLog, { force: true });
  writeFileSync(activeFile, opts.active ? "active\n" : "inactive\n");
  writeFileSync(enabledFile, opts.enabled ? "enabled\n" : "disabled\n");
  writeFileSync(unitFile, opts.noCaddyUnit ? "absent\n" : "present\n");
  writeFileSync(
    caddyfile,
    opts.markerVerifyRc === undefined ? "office.example.com\n" : "# marker\n",
  );
  const apt =
    opts.aptDoes === "mask"
      ? "systemctl stop caddy; systemctl disable caddy"
      : opts.aptDoes === "adopt"
        ? "systemctl start caddy; systemctl enable caddy"
        : opts.aptDoes === "install"
          ? `echo present > "${unitFile}"; systemctl start caddy; systemctl enable caddy`
          : opts.aptDoes === "purge"
            ? `echo absent > "${unitFile}"`
            : "true";
  const script = `
eval "$(grep -m1 '^caddy_unit_present()' "$INSTALL_SH")"
eval "$(sed -n '/^snapshot_caddy_state()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^restore_caddy_state()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^deps_only()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^report_failure()/,/^}/p' "$INSTALL_SH")"
CADDY_PRIOR_ACTIVE=""
CADDY_PRIOR_ENABLED=""
CADDY_SNAPSHOT_ARMED=""
CADDY_MASKED=""
CURRENT_STEP=deps
DRY_RUN=""
ISOMUX_DEPS_ONLY=1
FAILURE_SENTINEL=""
INSTALL_CALLBACK_URL=""
SERVICE_USER=$(id -un)
CADDY_MARKER="# marker"
CADDYFILE=${JSON.stringify(caddyfile)}
VERIFY_HARDENING_TOOL=verify-hardening
log() { echo "LOG: $*"; }
step() { CURRENT_STEP=$1; echo "STEP:$1"; }
for f in ${FORBIDDEN.join(" ")}; do eval "$f() { echo FORBIDDEN:$f; }"; done
# Non-exiting for the guards (root/apt/service-user never hold in a test
# process; those are pinned in install-sh.test.ts), but deps_only's own die
# calls must still stop it - so mark and exit on the ones that matter.
die() { echo "DIE: $*"; case "$*" in *[Cc]addy*) exit 1 ;; esac; }
install_packages() { echo "install_packages"; ${apt}; ${opts.packagesFail ? "report_failure; exit 1" : "true"}; }
configure_oom_protection() { echo "configure_oom_protection $*"; echo "configure_oom_protection $*" >> "$STUB_LOG"; :; }
outcome_add() { echo "OUTCOME: $*"; }
install_browser() { echo "install_browser"; }
configure_codex_sandbox() { echo "configure_codex_sandbox"; }
configure_user_manager() { echo "configure_user_manager"; }
backfill_firewall_record() { echo "backfill_firewall_record"; }
restore_recorded_firewall_rules() { echo "restore_recorded_firewall_rules"; }
install_hardening_verifier() { echo "install_hardening_verifier"; }
verify-hardening() { echo "verify-hardening $*"; return ${opts.markerVerifyRc ?? 0}; }
refresh_hosted_tls_renewal() { echo "refresh_hosted_tls_renewal"; }
migrate_caddy_access_log() { echo "migrate_caddy_access_log"; ${opts.migrationFails ? "return 1" : ":"}; }
verify_caddy_front_door() { ${opts.frontDoorHealthy === false ? "return 1" : "return 0"}; }
write_loopback_bind_if_proxied() { echo "write_loopback_bind_if_proxied"; }
write_update_outcome() { echo "write_update_outcome"; }
converge_bun() { echo "converge_bun $*"; ${opts.convergeFails ? "exit 1" : ":"}; }
BUN_VERSION=7.7.7
BUN_LINK=/usr/local/bin/bun
BUN_DIR=/usr/local/lib/isomux/bun
deps_only
`;
  const res = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      INSTALL_SH,
      STUB_LOG: stubLog,
      ACTIVE_FILE: activeFile,
      ENABLED_FILE: enabledFile,
      UNIT_FILE: unitFile,
      ...(opts.failVerb ? { FAIL_VERB: opts.failVerb } : {}),
    },
    encoding: "utf8",
  });
  const out = `${res.stdout}${res.stderr}`;
  // No full-install step ran, and no call fell through to a missing stub.
  expect(out).not.toContain("FORBIDDEN:");
  expect(out).not.toContain("command not found");
  return {
    calls: existsSync(stubLog)
      ? readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean)
      : [],
    out,
    code: res.status ?? -1,
    active: readFileSync(activeFile, "utf8").trim() === "active",
    enabled: readFileSync(enabledFile, "utf8").trim() === "enabled",
    unit: readFileSync(unitFile, "utf8").trim() === "present",
    stages: out
      .split("\n")
      .map((line) => line.split(" ")[0])
      .filter((word) => word.startsWith("STEP:") || STAGES.includes(word)),
  };
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "isomux-deps-mode-test-"));
  bin = join(base, "bin");
  mkdirSync(bin);
  writeSystemctlStub();
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("install.sh deps-only mode: Caddy is left as it was found", () => {
  it("brings back a running proxy that the package step took down", () => {
    // The unclaimed-office path: install_packages stops and disables Caddy so
    // apt cannot start it, and no configure_caddy follows in this mode.
    const r = runDepsMode({ active: true, enabled: true, aptDoes: "mask" });
    expect(r.active).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.code).toBe(0);
    // Everything a sync runs, in order. No Caddyfile marker, so no firewall
    // or hardening check.
    expect(r.stages).toEqual([
      "STEP:preflight-deps",
      "install_packages",
      "converge_bun",
      "configure_oom_protection",
      "install_browser",
      "configure_codex_sandbox",
      "configure_user_manager",
      "refresh_hosted_tls_renewal",
      "migrate_caddy_access_log",
      "write_loopback_bind_if_proxied",
      "write_update_outcome",
      "STEP:report",
    ]);
    expect(r.out).toContain("configure_oom_protection update");
    expect(r.calls.indexOf("configure_oom_protection update")).toBeGreaterThan(
      r.calls.indexOf("systemctl start caddy"),
    );
  });

  it("checks the firewall and hardening on a box the installer configured, and only warns on a failed check", () => {
    const r = runDepsMode({ active: true, enabled: true, markerVerifyRc: 1 });
    expect(r.code).toBe(0);
    expect(r.stages).toEqual([
      "STEP:preflight-deps",
      "install_packages",
      "converge_bun",
      "configure_oom_protection",
      "backfill_firewall_record",
      "restore_recorded_firewall_rules",
      "install_hardening_verifier",
      "verify-hardening",
      "install_browser",
      "configure_codex_sandbox",
      "configure_user_manager",
      "refresh_hosted_tls_renewal",
      "migrate_caddy_access_log",
      "write_loopback_bind_if_proxied",
      "write_update_outcome",
      "STEP:report",
    ]);
    expect(r.out).toContain("verify-hardening --check");
    expect(r.out).toMatch(/^LOG: ISOMUX_UPDATE_WARNING=\S/m);
    // The die stub only exits on Caddy, so past the guards none may fire.
    expect(r.out.slice(r.out.indexOf("install_packages"))).not.toContain(
      "DIE:",
    );
  });

  it("covers every full-install step: run by a sync or a tripwire", () => {
    // A new step in main() has to be placed on one side, so the tripwire
    // list cannot fall behind the installer.
    // The last main() is the installer's own; the earlier ones sit in
    // embedded helper scripts. It is the one the file ends by calling.
    const src = readFileSync(INSTALL_SH, "utf8");
    const tail = src.slice(src.lastIndexOf("\nmain() {\n"));
    expect(tail).toMatch(/\n\}\n\nmain "\$@"\n$/);
    const calls = tail.match(/^ {2}[a-z_]+$/gm)!.map((l) => l.trim());
    const steps = calls.slice(calls.indexOf("preflight"));
    expect(steps.length).toBeGreaterThan(20);
    expect(
      steps.filter((s) => !STAGES.includes(s) && !FORBIDDEN.includes(s)),
    ).toEqual([]);
  });

  it("switches the system Bun to the release's pin after the packages are in", () => {
    // The first update that carries side-by-side Bun installs runs the OLD
    // installed updater, which only knows deps-only: this call is what moves
    // those boxes to the pinned Bun on that update rather than the next one.
    // After install_packages, which installs unzip.
    const r = runDepsMode({ active: true, enabled: true });
    const converge = r.out.indexOf(
      "converge_bun 7.7.7 /usr/local/bin/bun /usr/local/lib/isomux/bun",
    );
    expect(converge).toBeGreaterThan(-1);
    expect(converge).toBeGreaterThan(r.out.indexOf("install_packages"));
  });

  it("puts the proxy back before a Bun switch that can fail", () => {
    // converge_bun dies on a failed download or checksum. The package step
    // may have masked Caddy by then, and a sync that dies before restoring it
    // leaves the office's public URL down.
    const r = runDepsMode({
      active: true,
      enabled: true,
      aptDoes: "mask",
      convergeFails: true,
    });
    expect(r.out).toContain("converge_bun");
    expect(r.code).not.toBe(0);
    expect(r.active).toBe(true);
    expect(r.enabled).toBe(true);
  });

  it("turns back off a proxy the package step started", () => {
    // The claimed-office path leaves Caddy unmasked, so a package upgrade's
    // maintainer script can start and enable a proxy the operator had off.
    // Restoration has to move in that direction too.
    const r = runDepsMode({ active: false, enabled: false, aptDoes: "adopt" });
    expect(r.active).toBe(false);
    expect(r.enabled).toBe(false);
    expect(r.calls).toContain("systemctl stop caddy");
    expect(r.calls).toContain("systemctl disable caddy");
  });

  it("keeps an enabled-but-stopped proxy enabled and stopped", () => {
    const r = runDepsMode({ active: false, enabled: true, aptDoes: "adopt" });
    expect(r.active).toBe(false);
    expect(r.enabled).toBe(true);
  });

  it("restores the proxy after a failed package run too", () => {
    // The dangerous path: install_packages has already stopped and disabled
    // Caddy by the time apt dies, and report_failure used to only unmask.
    const r = runDepsMode({
      active: true,
      enabled: true,
      aptDoes: "mask",
      packagesFail: true,
    });
    expect(r.active).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.out).not.toContain("install_browser");
  });

  it("fails the sync when the proxy cannot be brought back", () => {
    // Reporting "dependencies are up to date" while the office is unreachable
    // is the outcome to avoid: the update would carry on regardless.
    const r = runDepsMode({
      active: true,
      enabled: true,
      aptDoes: "mask",
      failVerb: "start",
    });
    expect(r.out).toContain("could not restore caddy");
    expect(r.out).not.toContain("install_browser");
    expect(r.out).not.toContain("system dependencies are up to date");
    expect(r.code).not.toBe(0);
  });

  it("touches nothing when there was no caddy unit and still isn't", () => {
    // Restoration must not try to stop and disable a unit that does not
    // exist, which would fail the sync over nothing.
    const r = runDepsMode({ active: false, enabled: false, noCaddyUnit: true });
    expect(
      r.calls.filter((c) => /(start|stop|enable|disable) caddy/.test(c)),
    ).toEqual([]);
    expect(r.out).toContain("install_browser");
    expect(r.out).toContain("system dependencies are up to date");
  });

  it("does not hand the box a proxy it did not have", () => {
    // The dependency step installs caddy, so a box whose package was purged
    // (managed Caddyfile and claimed office still in place, so the claim check
    // passes and nothing gets masked) would otherwise come out of a sync
    // serving. The package stays installed; the proxy does not run.
    const r = runDepsMode({
      active: false,
      enabled: false,
      noCaddyUnit: true,
      aptDoes: "install",
    });
    expect(r.unit).toBe(true);
    expect(r.active).toBe(false);
    expect(r.enabled).toBe(false);
    expect(r.calls).toContain("systemctl stop caddy");
    expect(r.calls).toContain("systemctl disable caddy");
    expect(r.out).toContain("system dependencies are up to date");
  });

  it("fails when the unit it snapshotted is gone afterwards", () => {
    // Nothing here can put back a unit the package step removed, so the sync
    // must say so rather than report success over a missing proxy.
    const r = runDepsMode({ active: true, enabled: true, aptDoes: "purge" });
    expect(r.out).toContain("could not restore caddy");
    expect(r.out).not.toContain("install_browser");
    expect(r.code).not.toBe(0);
  });

  it("fails when migration reports failure and an active unit has no serving front door", () => {
    const r = runDepsMode({
      active: true,
      enabled: true,
      migrationFails: true,
      frontDoorHealthy: false,
    });
    expect(r.active).toBe(true);
    expect(r.out).toContain(
      "Caddy access logging was not added and Caddy is down",
    );
    expect(r.out).not.toContain("system dependencies are up to date");
    expect(r.code).not.toBe(0);
  });
});

// The installer's own one-line helpers, from its top-level Helpers section
// (embedded scripts further down define their own log and warn).
function topLevelHelpers(): string {
  const src = readFileSync(INSTALL_SH, "utf8");
  const start = src.indexOf("\n# --- Helpers -");
  const end = src.indexOf("\n# --- Steps -");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const defs = src.slice(start, end).match(/^(?:log|warn)\(\) \{.*\}$/gm);
  expect(defs?.some((d) => d.startsWith("log() "))).toBe(true);
  return defs!.join("\n");
}

function runGithubCliInstall(fail: "curl" | "update" | "install" | "none") {
  const root = mkdtempSync(join(tmpdir(), "isomux-gh-install-test-"));
  const keyring = join(root, "keyrings", "githubcli-archive-keyring.gpg");
  const source = join(root, "sources", "github-cli.list");
  const aptLog = join(root, "apt-get.log");
  mkdirSync(join(root, "keyrings"));
  mkdirSync(join(root, "sources"));
  writeFileSync(source, "stale source\n");
  const functionSource = readFileSync(INSTALL_SH, "utf8")
    .match(/^install_github_cli\(\) \{[\s\S]*?^\}/m)?.[0]
    ?.replaceAll("/usr/share/keyrings/githubcli-archive-keyring.gpg", keyring)
    .replaceAll("/etc/apt/sources.list.d/github-cli.list", source)
    .replaceAll(
      "/usr/share/keyrings/.githubcli-keyring.XXXXXXXXXX",
      join(root, "keyrings", ".githubcli-keyring.XXXXXXXXXX"),
    )
    .replaceAll(
      "/etc/apt/sources.list.d/.github-cli.XXXXXXXXXX",
      join(root, "sources", ".github-cli.XXXXXXXXXX"),
    );
  expect(functionSource).toBeDefined();
  // log (and warn, if the installer ever defines one) are the real ones.
  const script = `
${functionSource}
${topLevelHelpers()}
DRY_RUN=""
apt_install() { echo "APT_INSTALL: $*"; [[ ${JSON.stringify(fail)} != install ]]; }
apt_get() { apt-get "$@"; }
curl() { [[ ${JSON.stringify(fail)} != curl ]] || return 1; printf key; }
dpkg() { printf amd64; }
apt-get() { printf '%s\\n' "$@" >> ${JSON.stringify(aptLog)}; [[ ${JSON.stringify(fail)} != update ]]; }
install_github_cli
`;
  const res = spawnSync("bash", ["-Eeuo", "pipefail", "-c", script], {
    encoding: "utf8",
  });
  const result = {
    code: res.status ?? -1,
    out: `${res.stdout}${res.stderr}`,
    keyring: existsSync(keyring),
    source: existsSync(source) ? readFileSync(source, "utf8") : null,
    aptArgs: existsSync(aptLog)
      ? readFileSync(aptLog, "utf8").split("\n").filter(Boolean)
      : [],
    keyringPath: keyring,
    sourcePath: source,
  };
  rmSync(root, { recursive: true, force: true });
  return result;
}

// An installer warning, by its structure rather than its wording.
const WARNING = /^\[isomux-install\] warning: \S/m;

describe("install.sh GitHub CLI repository failure", () => {
  it("removes the source when the key fetch fails", () => {
    const r = runGithubCliInstall("curl");
    expect({ code: r.code, out: r.out }).toEqual({
      code: 0,
      out: expect.stringMatching(WARNING),
    });
    expect(r.source).toBeNull();
    expect(r.aptArgs).toEqual([]);
  });

  it("removes the source when its apt update fails", () => {
    const r = runGithubCliInstall("update");
    expect({ code: r.code, out: r.out }).toEqual({
      code: 0,
      out: expect.stringMatching(WARNING),
    });
    expect(r.source).toBeNull();
    expect(r.keyring).toBe(true);
    expect(r.out).not.toContain("APT_INSTALL:");
  });

  it("installs gh after an update of its repository alone", () => {
    const r = runGithubCliInstall("none");
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(WARNING);
    // The source names the key that verifies it.
    expect(r.source).toMatch(
      new RegExp(`^deb \\[[^\\]]*signed-by=${r.keyringPath}[\\] ]`),
    );
    // One-source update: only this list, and the other repositories' cached
    // lists stay (a plain one-source update deletes them, breaking the
    // package installs that follow).
    const opts = r.aptArgs.flatMap((a, i) =>
      r.aptArgs[i - 1] === "-o" ? [a] : [],
    );
    expect(r.aptArgs).toContain("update");
    expect(opts).toContain(`Dir::Etc::sourcelist=${r.sourcePath}`);
    expect(opts).toContain("Dir::Etc::sourceparts=/dev/null");
    expect(opts).toContain("APT::Get::List-Cleanup=0");
    expect(r.out).toContain("APT_INSTALL: gh");
  });

  it("keeps the source and continues when the package install fails", () => {
    const r = runGithubCliInstall("install");
    expect({ code: r.code, out: r.out }).toEqual({
      code: 0,
      out: expect.stringMatching(WARNING),
    });
    expect(r.source).not.toBeNull();
    expect(r.out).toContain("APT_INSTALL: gh");
  });
});

describe("install.sh deps-only entry", () => {
  // The real installer as this (non-root) user, with no DOMAIN: the step
  // names it reaches show which path took the run.
  function stepsReached(depsOnly: string) {
    expect(process.getuid?.()).not.toBe(0);
    const res = spawnSync("bash", [INSTALL_SH], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: base,
        TMPDIR: base,
        ISOMUX_DEPS_ONLY: depsOnly,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    return {
      code: res.status,
      steps: [...`${res.stdout}`.matchAll(/--- step: (\S+)/g)].map((m) => m[1]),
    };
  }

  it("ISOMUX_DEPS_ONLY=1 is taken before the full install's preflight", () => {
    // Refused for want of root at its own step, not at preflight.
    expect(stepsReached("1")).toEqual({ code: 1, steps: ["preflight-deps"] });
  });

  it("any other value runs the full install", () => {
    expect(stepsReached("yes")).toEqual({ code: 1, steps: ["preflight"] });
  });
});

describe("install.sh protocol markers", () => {
  it("carries the exact lines scripts/update.sh probes for", () => {
    // An installer without them gets skipped; one that only mentions them
    // would run a full install on a live box. The patterns come from
    // update.sh itself, so the two files cannot drift apart.
    const update = readFileSync(
      new URL("../scripts/update.sh", import.meta.url),
      "utf8",
    );
    const patterns = [
      ...update.matchAll(/grep -qx '(ISOMUX_INSTALL_[A-Z_]+=[0-9]+)'/g),
    ].map((m) => m[1]);
    expect(patterns.sort()).toEqual([
      "ISOMUX_INSTALL_BUN_MODE_VERSION=1",
      "ISOMUX_INSTALL_DEPS_MODE_VERSION=1",
    ]);
    for (const pattern of patterns) {
      expect({
        pattern,
        status: spawnSync("grep", ["-qx", pattern, INSTALL_SH]).status,
      }).toEqual({ pattern, status: 0 });
    }
  });
});
