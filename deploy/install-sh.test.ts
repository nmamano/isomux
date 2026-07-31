// deploy/install.sh — content pins for the in-UI update-trigger escalation.
// install.sh has no unprivileged execution harness (preflight requires root),
// so these tests pin the SOURCE of the security-load-bearing pieces instead:
// the polkit rule (extracted and exercised as a real RegExp), the root-owned
// template unit, and the ordering that keeps them inside the guarded
// updater-install step. A loosened regex or a widened grant fails here before
// any reviewer has to notice it. Zero execution, zero LLM.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { EMBEDDED, embed } from "../scripts/embed-deploy-scripts.ts";

const SRC = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const repoFile = (p: string) =>
  readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** Position of a step's call inside main(), for ordering assertions. */
function stepIndex(name: string): number {
  const idx = SRC.indexOf(`\n  ${name}\n`, SRC.lastIndexOf("\nmain() {"));
  expect(idx).toBeGreaterThan(-1);
  return idx;
}

// The polkit unit-name pattern as written in the heredoc. Bash expands `\$`
// to `$` when writing the file (unquoted heredoc), so unescape exactly that
// to get the regex polkitd will evaluate.
function extractPolkitUnitRegex(): RegExp {
  const m = /^\s*\/(\^isomux-update@[^/]+)\/\.test\(/m.exec(SRC);
  if (!m) throw new Error("polkit unit regex not found in install.sh");
  return new RegExp(m[1].replaceAll("\\$", "$"));
}

describe("install.sh escalation: polkit rule", () => {
  it("grants only manage-units, only verb start, only the service user", () => {
    expect(SRC).toContain(
      'action.id === "org.freedesktop.systemd1.manage-units"',
    );
    expect(SRC).toContain('subject.user === "$SERVICE_USER"');
    expect(SRC).toContain('action.lookup("verb") === "start"');
    expect(SRC).toContain("polkit.Result.YES");
    // No blanket grant anywhere in the rule.
    expect(SRC).not.toContain("polkit.Result.AUTH_SELF");
  });

  it("the unit regex accepts exactly CalVer template instances", () => {
    const re = extractPolkitUnitRegex();
    for (const unit of [
      "isomux-update@v2026.7.19.service",
      "isomux-update@v2026.7.19.2.service",
      "isomux-update@v2026.12.31.service",
    ]) {
      expect(re.test(unit)).toBe(true);
    }
    for (const unit of [
      "evil.service",
      "isomux.service",
      "isomux-update@main.service",
      "isomux-update@v1.0.service",
      "isomux-update@v2026.7.19.service evil.service", // space smuggling
      "isomux-update@v2026.7.19.service.evil", // suffix smuggling
      "isomux-update@v2026.7.19", // not the .service form systemd checks
      "Xisomux-update@v2026.7.19.service", // unanchored-prefix probe
    ]) {
      expect(re.test(unit)).toBe(false);
    }
  });

  it("the CalVer core matches the updater's and version.ts's tag shape", () => {
    // One channel, one grammar: the polkit pattern must accept exactly the
    // tags scripts/update.sh (CALVER_RE) and server/version.ts
    // (CALVER_RELEASE_RE) accept, or an update could be startable but
    // refused — or worse, refusable but startable.
    expect(SRC).toContain(
      "isomux-update@v[0-9]{4}\\.[0-9]{1,2}\\.[0-9]{1,2}(\\.[0-9]+)?\\.service",
    );
    const updateSh = readFileSync(
      new URL("../scripts/update.sh", import.meta.url),
      "utf8",
    );
    expect(updateSh).toContain(
      "^v[0-9]{4}\\.[0-9]{1,2}\\.[0-9]{1,2}(\\.[0-9]+)?$",
    );
  });
});

describe("install.sh escalation: template unit + placement", () => {
  it("root-owned oneshot template running the installed updater on %i", () => {
    expect(SRC).toContain(
      "write_file /etc/systemd/system/isomux-update@.service 644",
    );
    expect(SRC).toContain("Type=oneshot");
    expect(SRC).toContain("ExecStart=$UPDATER_PATH %i");
    // On-demand only: no [Install] section, nothing enables it at boot.
    const unitHeredoc = SRC.slice(
      SRC.indexOf("write_file /etc/systemd/system/isomux-update@.service"),
      SRC.indexOf("50-isomux-update.rules"),
    );
    expect(unitHeredoc).not.toContain("[Install]");
    expect(unitHeredoc).not.toContain("WantedBy");
  });

  it("written inside the guarded updater step, daemon-reload after", () => {
    const guard = SRC.indexOf("skipping updater installation");
    const updater = SRC.indexOf('install -m 755 "$tmp" "$UPDATER_PATH"');
    const unit = SRC.indexOf(
      "write_file /etc/systemd/system/isomux-update@.service",
    );
    const rule = SRC.indexOf("50-isomux-update.rules");
    const reload = SRC.indexOf("systemctl daemon-reload", unit);
    for (const idx of [guard, updater, unit, rule, reload]) {
      expect(idx).toBeGreaterThan(-1);
    }
    // Guarded (no updater in the ref → none of the escalation pieces), and
    // daemon-reload only after both files are in place.
    expect(guard).toBeLessThan(unit);
    expect(updater).toBeLessThan(unit);
    expect(unit).toBeLessThan(rule);
    expect(rule).toBeLessThan(reload);
  });

  it("polkitd is in the apt package list (minimal images may lack it)", () => {
    expect(SRC).toMatch(/apt-get install -y[^\n]*\bpolkitd\b/);
  });

  it("nodejs comes from NodeSource (the PTY sidecar needs current real Node)", () => {
    // Not Ubuntu's apt nodejs: v18 breaks node-gyp@latest, which the
    // node-pty rebuild runs under whatever real node is on PATH.
    expect(SRC).toContain("deb.nodesource.com/node_24.x");
    expect(SRC).toMatch(/apt-get install -y[^\n]*\bnodejs\b/);
  });

  it("installs a browser from Chrome's .deb, never snap, and verifies a capture", () => {
    // snap chromium installs cleanly and then cannot screenshot on a headless
    // server, so an installer that reaches for it would look successful and
    // still ship preview-url dead. Pin the .deb source, the verification, and
    // the never-snap rule.
    expect(SRC).toContain(
      "CHROME_DEB_URL=https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb",
    );
    expect(SRC).toContain("CHROME_PATH=/usr/bin/google-chrome");
    expect(SRC).not.toMatch(/^\s*(run )?snap\b/m); // never invoked, only warned about
    // The verification runs a real capture as the SERVICE USER (Chrome refuses
    // to run as root without --no-sandbox, and the service user is who will
    // actually launch it), and checks a PNG landed.
    expect(SRC).toMatch(/as_service_user timeout 60 "\$CHROME_PATH"/);
    expect(SRC).toContain("[[ -s $probe/probe.png ]]");
    // Ordered after create_service_user (the probe needs that account) and
    // before the build, so the warning is visible early in the output. Scoped
    // to main's body: deps_only calls install_browser too.
    const body = SRC.slice(SRC.lastIndexOf("\nmain() {"));
    const createUser = body.indexOf("  create_service_user\n");
    const browser = body.indexOf("  install_browser\n");
    const fetch = body.indexOf("  fetch_isomux\n");
    expect(createUser).toBeGreaterThan(-1);
    expect(browser).toBeGreaterThan(createUser);
    expect(fetch).toBeGreaterThan(browser);
  });

  it("a missing or broken browser warns instead of failing the install", () => {
    // Page previews are the only thing a browser gates; losing them must not
    // abandon an otherwise complete install.
    const fn = SRC.slice(
      SRC.indexOf("install_browser() {"),
      SRC.indexOf("# Default ISOMUX_REF:"),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).not.toContain("die ");
    for (const warning of [
      "could not download Google Chrome",
      "installing the Google Chrome package failed",
      "produced no screenshot in a headless test run",
      "ships no $arch Linux build",
    ]) {
      expect(fn).toContain(warning);
    }
  });

  it("the service unit names an entry point every release has", () => {
    // This installer is fetched from main but installs a RELEASE, so the unit
    // may only name a path that exists in older releases too. server/index.ts
    // is the back-compat shim kept for exactly this; naming the newer
    // server/isomux-office.ts made a fresh install of v2026.7.23 crash-loop
    // with "Module not found".
    expect(SRC).toContain("ExecStart=/usr/local/bin/bun run server/index.ts");
    expect(SRC).not.toContain("bun run server/isomux-office.ts");
  });

  it("deps-only mode installs dependencies and nothing else", () => {
    // scripts/update.sh runs the target release's installer with
    // ISOMUX_DEPS_ONLY=1 on a LIVE box, so this mode must stay narrow: box
    // policy (firewall, SSH, unattended upgrades), the runtime (bun), and
    // everything that decides the box's identity stay out of it.
    const fn = SRC.slice(
      SRC.indexOf("deps_only() {"),
      SRC.lastIndexOf("\nmain() {"),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain("install_packages");
    expect(fn).toContain("install_browser");
    // Calls only: the comments name steps they explain.
    const calls = fn
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    for (const excluded of [
      "install_bun",
      "configure_firewall",
      "harden_ssh",
      "enable_auto_updates",
      "fetch_isomux",
      "build_isomux",
      "install_service",
      "claim_owner",
      "configure_caddy",
      "mint_invite",
    ]) {
      expect(calls).not.toContain(excluded);
    }
    // Root only: it installs system packages.
    expect(fn).toMatch(/\$EUID -eq 0 \]\] \|\| die/);
    // install_packages can take caddy down (unverifiable office) or let apt
    // bring it up (verified one); either way deps mode puts it back, and a
    // sync that cannot is a failed sync. Behavior lives in
    // install-deps-mode.test.ts; this only pins that the wiring is present.
    expect(calls).toContain("snapshot_caddy_state");
    expect(calls).toMatch(/restore_caddy_state \|\|\n\s*die /);
    // The failure path restores too: report_failure only unmasked before.
    const onFailure = SRC.slice(
      SRC.indexOf("report_failure() {"),
      SRC.indexOf("die() {"),
    );
    expect(onFailure).toContain("restore_caddy_state");
    // Only the documented value activates the mode.
    expect(SRC).toContain("if [[ $ISOMUX_DEPS_ONLY == 1 ]]; then");
    // The protocol marker scripts/update.sh probes for, as an exact
    // assignment on its own line.
    expect(SRC).toMatch(/^ISOMUX_INSTALL_DEPS_MODE_VERSION=1$/m);
    // Taken before anything else, so DOMAIN and the rest of preflight are
    // never required for a dependency sync.
    const branch = SRC.indexOf("if [[ $ISOMUX_DEPS_ONLY == 1 ]]; then");
    expect(branch).toBeGreaterThan(SRC.lastIndexOf("\nmain() {"));
    expect(branch).toBeLessThan(SRC.indexOf("  preflight\n"));
  });

  it("ships the helper scripts byte-for-byte, not a drifted copy", () => {
    // install.sh is fetched on its own by curl | bash, so what it installs on
    // the box has to be inside it. A copy that drifts from the repo file is
    // worse than no copy: reviewers read the file, boxes run the copy.
    expect(embed(SRC, repoFile)).toBe(SRC);
    for (const { path, delimiter } of EMBEDDED) {
      expect(SRC).toContain(`<<'${delimiter}'`);
      expect(SRC).toContain(repoFile(path).trimEnd());
    }
  });

  it("build step rebuilds node-pty when its native binding is missing", () => {
    // A resumed install can skip node-pty's build script; the guard must
    // check for the compiled binding, remove the package AS THE SERVICE USER
    // (not root), re-run the install, and die if the binding is still absent.
    expect(SRC).toContain("node_modules/node-pty/build/Release/pty.node");
    expect(SRC).toMatch(/! -f \$pty_binding/);
    const rm = SRC.indexOf(
      'run_as_service_user rm -rf "$INSTALL_DIR/node_modules/node-pty"',
    );
    expect(rm).toBeGreaterThan(-1);
    const reinstall = SRC.indexOf("bun install --frozen-lockfile", rm);
    const fatal = SRC.search(/-f \$pty_binding[^\n]*\|\|\n\s*die /);
    expect(reinstall).toBeGreaterThan(rm);
    expect(fatal).toBeGreaterThan(reinstall);
  });
});

describe("install.sh: the box cannot ship with agents able to reach root", () => {
  it("gates the install twice, before the build and before the owner exists", () => {
    // First gate right after the account exists, so a doomed box fails in
    // seconds. Second gate on the finished box BEFORE claim_owner, so a box
    // that fails leaves no owner, no invite link and no success callback.
    expect(stepIndex("create_service_user")).toBeLessThan(
      stepIndex("check_root_reachability"),
    );
    expect(stepIndex("check_root_reachability")).toBeLessThan(
      stepIndex("fetch_isomux"),
    );
    expect(stepIndex("wait_for_server")).toBeLessThan(
      stepIndex("assert_hardening"),
    );
    expect(stepIndex("assert_hardening")).toBeLessThan(
      stepIndex("claim_owner"),
    );
  });

  it("both gates stop on a failed check AND on one that could not decide", () => {
    // "Could not tell" is not a pass: a box is not hardened just because the
    // check did not run.
    for (const gate of ["check_root_reachability", "assert_hardening"]) {
      const body = SRC.slice(
        SRC.indexOf(`${gate}() {`),
        SRC.indexOf("\n}\n", SRC.indexOf(`${gate}() {`)),
      );
      expect(body).toContain('"$HARDEN_TOOL" --check || rc=$?');
      expect(body).toMatch(/1\) die /);
      expect(body).toMatch(/\*\) die /);
    }
  });

  it("has no escape hatch for either gate", () => {
    // The installer's whole environment surface is its parameter block; an
    // opt-out would have to live there. It deliberately does not: the installs
    // that would set it are the ones that most need the check.
    const params = SRC.match(/^[A-Z_]+="\$\{[A-Z_]+:-[^}]*\}"$/gm) ?? [];
    expect(params.length).toBeGreaterThan(4);
    expect(params.join("\n")).not.toMatch(
      /SKIP|FORCE|ALLOW|IGNORE|OVERRIDE|UNSAFE/,
    );
  });

  it("installs the ssh client the check needs", () => {
    expect(SRC).toMatch(/apt-get install -y[^\n]*\bopenssh-client\b/);
  });

  it("leaves the operator a command to re-run, and points at it", () => {
    // The hardening is skipped on a box with no SSH key yet, and whoever adds
    // a key later will not re-run a whole installer.
    expect(SRC).toContain("HARDEN_TOOL=/usr/local/sbin/isomux-harden-ssh");
    expect(SRC).toContain('write_file "$HARDEN_TOOL" 755');
    expect(SRC).toContain("sudo isomux-harden-ssh");
    const report = SRC.slice(SRC.indexOf("report() {"));
    expect(report).toContain("SSH_HARDENING_SKIPPED");
  });
});

describe("install.sh: the managed Caddyfile", () => {
  it("turns the admin API off, in a global block ahead of the site block", () => {
    // Caddy's admin API listens on 127.0.0.1:2019 by default and rewrites the
    // proxy config with no credential. Loopback is not a trust boundary here:
    // agents run on this box, and an SSRF bug in anything they build reaches it.
    // Not the usual "up to the next \n}\n": the Caddyfile heredoc has its own
    // closing braces at column 0. Slice to the next function instead.
    const body = SRC.slice(
      SRC.indexOf("configure_caddy() {"),
      SRC.indexOf("\nreport() {"),
    );
    expect(body).toContain("admin off");
    // Caddy only accepts global options as the FIRST block in the file.
    expect(body.indexOf("admin off")).toBeLessThan(body.indexOf("$DOMAIN {"));
    // Still the same office it proxies to.
    expect(body).toContain("reverse_proxy 127.0.0.1:4000");
  });
});

describe("install.sh: out-of-memory protection", () => {
  it("installs and runs the protection script, without failing the install", () => {
    expect(SRC).toContain("OOM_TOOL=/usr/local/sbin/isomux-oom-protect");
    expect(SRC).toContain('write_file "$OOM_TOOL" 755');
    // Slice from the end of the embedded script: the heredoc body is full of
    // function bodies that would end the slice early.
    const afterHeredoc = SRC.lastIndexOf("\nISOMUX_OOM_PROTECT_SH\n");
    const fn = SRC.slice(afterHeredoc, SRC.indexOf("\n}\n", afterHeredoc));
    expect(fn).not.toContain("die ");
    expect(fn).toContain("warning: out-of-memory protection");
  });

  it("runs before the build, which is the memory-hungry part", () => {
    expect(stepIndex("configure_oom_protection")).toBeLessThan(
      stepIndex("build_isomux"),
    );
  });

  it("puts the office server in the kill-last tier", () => {
    const unit = SRC.slice(
      SRC.indexOf("write_file /etc/systemd/system/isomux.service 644"),
      SRC.indexOf(
        "run systemctl daemon-reload",
        SRC.indexOf("install_service"),
      ),
    );
    expect(unit).toContain("OOMScoreAdjust=-500");
  });
});
