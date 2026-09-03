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
}

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
}): Run {
  const stubLog = join(base, "stub.log");
  const activeFile = join(base, "caddy-active");
  const enabledFile = join(base, "caddy-enabled");
  const unitFile = join(base, "caddy-unit");
  rmSync(stubLog, { force: true });
  writeFileSync(activeFile, opts.active ? "active\n" : "inactive\n");
  writeFileSync(enabledFile, opts.enabled ? "enabled\n" : "disabled\n");
  writeFileSync(unitFile, opts.noCaddyUnit ? "absent\n" : "present\n");
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
log() { echo "LOG: $*"; }
step() { CURRENT_STEP=$1; }
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
migrate_caddy_access_log() { echo "migrate_caddy_access_log"; ${opts.migrationFails ? "return 1" : ":"}; }
verify_caddy_front_door() { ${opts.frontDoorHealthy === false ? "return 1" : "return 0"}; }
write_loopback_bind_if_proxied() { echo "write_loopback_bind_if_proxied"; }
write_update_outcome() { echo "write_update_outcome"; }
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
  return {
    calls: existsSync(stubLog)
      ? readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean)
      : [],
    out: `${res.stdout}${res.stderr}`,
    code: res.status ?? -1,
    active: readFileSync(activeFile, "utf8").trim() === "active",
    enabled: readFileSync(enabledFile, "utf8").trim() === "enabled",
    unit: readFileSync(unitFile, "utf8").trim() === "present",
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
    expect(r.out).toContain("install_browser");
    expect(r.out.indexOf("configure_oom_protection update")).toBeGreaterThan(
      r.out.indexOf("install_packages"),
    );
    expect(r.calls.indexOf("configure_oom_protection update")).toBeGreaterThan(
      r.calls.indexOf("systemctl start caddy"),
    );
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

function runGithubCliInstall(fail: "curl" | "update" | "install" | "none") {
  const root = mkdtempSync(join(tmpdir(), "isomux-gh-install-test-"));
  const keyring = join(root, "keyrings", "githubcli-archive-keyring.gpg");
  const source = join(root, "sources", "github-cli.list");
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
  const script = `
${functionSource}
DRY_RUN=""
log() { echo "LOG: $*"; }
warn() { echo "WARN: $*"; }
apt_install() { echo "APT_INSTALL: $*"; [[ ${JSON.stringify(fail)} != install ]]; }
apt_get() { apt-get "$@"; }
curl() { [[ ${JSON.stringify(fail)} != curl ]] || return 1; printf key; }
dpkg() { printf amd64; }
apt-get() { [[ ${JSON.stringify(fail)} != update ]]; }
install_github_cli
`;
  const res = spawnSync("bash", ["-Eeuo", "pipefail", "-c", script], {
    encoding: "utf8",
  });
  const result = {
    code: res.status ?? -1,
    out: `${res.stdout}${res.stderr}`,
    keyring: existsSync(keyring),
    source: existsSync(source),
  };
  rmSync(root, { recursive: true, force: true });
  return result;
}

describe("install.sh GitHub CLI repository failure", () => {
  it("removes the source when the key fetch fails", () => {
    const r = runGithubCliInstall("curl");
    expect(r.code).toBe(0);
    expect(r.source).toBe(false);
    expect(r.out).toContain("could not add the GitHub CLI apt repository");
  });

  it("removes the source when its apt update fails", () => {
    const r = runGithubCliInstall("update");
    expect(r.code).toBe(0);
    expect(r.source).toBe(false);
    expect(r.keyring).toBe(true);
    expect(r.out).toContain("could not add the GitHub CLI apt repository");
  });

  it("installs gh after its repository update succeeds", () => {
    const r = runGithubCliInstall("none");
    expect(r.code).toBe(0);
    expect(r.source).toBe(true);
    expect(r.out).toContain("APT_INSTALL: gh");
  });

  it("keeps the source and continues when the package install fails", () => {
    const r = runGithubCliInstall("install");
    expect(r.code).toBe(0);
    expect(r.source).toBe(true);
    expect(r.out).toContain("could not install GitHub CLI");
  });
});
