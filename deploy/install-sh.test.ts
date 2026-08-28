// deploy/install.sh - content pins for the in-UI update-trigger escalation.
// install.sh has no unprivileged execution harness (preflight requires root),
// so these tests pin the SOURCE of the security-load-bearing pieces instead:
// the polkit rule (extracted and exercised as a real RegExp), the root-owned
// template unit, and the ordering that keeps them inside the guarded
// updater-install step. A loosened regex or a widened grant fails here before
// any reviewer has to notice it. Zero execution, zero LLM.

import { describe, it, expect } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { EMBEDDED, embed } from "../scripts/embed-deploy-scripts.ts";
import { AGENT_OOM_SCORE_ADJ } from "../server/oom-stamp.ts";
import { TLS_ASK_PATH } from "../server/tls-ask.ts";

const SRC = readFileSync(new URL("./install.sh", import.meta.url), "utf8");

/** The isomux.service unit body the installer writes. */
const serviceUnit = () =>
  SRC.slice(
    SRC.indexOf("write_file /etc/systemd/system/isomux.service 644"),
    SRC.indexOf("run systemctl daemon-reload", SRC.indexOf("install_service")),
  );
const repoFile = (p: string) =>
  readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** Shell/profile source with whole-line comments removed. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

/** Position of a step's call inside main(), for ordering assertions. */
function stepIndex(name: string): number {
  const idx = SRC.indexOf(`\n  ${name}\n`, SRC.lastIndexOf("\nmain() {"));
  expect(idx).toBeGreaterThan(-1);
  return idx;
}

describe("install.sh hosted identity and Claude CLI", () => {
  it("projects root-only enrollment into a readable marker in both directions", () => {
    expect(SRC).not.toContain("INSTALL_KIND=");
    expect(SRC).toContain("[[ -f /etc/isomux/renewal/enrollment.json ]]");
    expect(SRC).toContain("install -d -m 0755 -o root -g root /etc/isomux");
    expect(SRC).toContain('write_file "$INSTALL_KIND_FILE" 644');
    expect(SRC).toContain('run rm -f "$INSTALL_KIND_FILE"');
    expect(SRC).toContain("INSTALL_KIND_FILE=/etc/isomux/install-kind");
    expect(stepIndex("sync_install_kind")).toBeLessThan(
      stepIndex("install_service"),
    );
    const deps = SRC.slice(
      SRC.indexOf("deps_only() {"),
      SRC.indexOf("main() {"),
    );
    expect(deps).not.toContain("sync_install_kind");
  });

  it("installs Claude globally before service start, but not during updates", () => {
    expect(SRC).toContain("npm install -g @anthropic-ai/claude-code");
    expect(SRC).toContain("PATH=$service_path");
    expect(SRC).toContain("command -v claude");
    expect(stepIndex("install_claude_cli")).toBeLessThan(
      stepIndex("install_service"),
    );
    const deps = SRC.slice(
      SRC.indexOf("deps_only() {"),
      SRC.indexOf("main() {"),
    );
    expect(deps).not.toContain("install_claude_cli");
  });
});

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
    // refused - or worse, refusable but startable.
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
    expect(SRC).toMatch(/apt_install[^\n]*\bpolkitd\b/);
  });

  it("nodejs comes from NodeSource (the PTY sidecar needs current real Node)", () => {
    // Not Ubuntu's apt nodejs: v18 breaks node-gyp@latest, which the
    // node-pty rebuild runs under whatever real node is on PATH.
    expect(SRC).toContain("deb.nodesource.com/node_24.x");
    expect(SRC).toMatch(/apt_install[^\n]*\bnodejs\b/);
  });

  it("uses GitHub's scoped apt repository for GitHub CLI", () => {
    expect(SRC).toContain(
      "https://cli.github.com/packages/githubcli-archive-keyring.gpg",
    );
    expect(SRC).toContain(
      "signed-by=%s] https://cli.github.com/packages stable main",
    );
    expect(SRC).toContain("-o APT::Get::List-Cleanup=0");
    expect(SRC).toMatch(/apt_install[^\n]*\bgh\b/);
  });

  it("reports the GitHub CLI repository and package in dry-run mode", () => {
    expect(SRC).toContain(
      "DRY-RUN: would add the GitHub CLI apt repository and install gh",
    );
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

  it("makes codex's bubblewrap sandbox work, without weakening the box", () => {
    // Behavior lives in install-codex-sandbox.test.ts, which RUNS the step.
    // Pinned here: the placement, and the two shortcuts that must never appear
    // - a permissive profile, or turning the kernel restriction off box-wide -
    // since both make the symptom go away on a box that then runs arbitrary
    // agent commands with user namespaces wide open.
    // Comments stripped: the step's own comment names both shortcuts in order
    // to rule them out, and the vendored profile keeps upstream's commentary.
    const code = stripComments(SRC);
    expect(code).not.toContain("flags=(unconfined)");
    expect(code).not.toMatch(
      /sysctl[^\n]*apparmor_restrict_unprivileged_userns/,
    );
    expect(code).toContain("audit deny capability");
    // The smoke test runs as the service user: root is exempt from the
    // restriction, so as root it would pass on a box where codex cannot start.
    expect(SRC).toContain(
      "as_service_user bwrap --unshare-net --dev-bind / / /bin/true",
    );
    // After create_service_user (the probe needs that account) and before the
    // build, like the browser step. Scoped to main's body: deps_only calls it
    // too.
    const body = SRC.slice(SRC.lastIndexOf("\nmain() {"));
    const createUser = body.indexOf("  create_service_user\n");
    const sandbox = body.indexOf("  configure_codex_sandbox\n");
    const fetch = body.indexOf("  fetch_isomux\n");
    expect(createUser).toBeGreaterThan(-1);
    expect(sandbox).toBeGreaterThan(createUser);
    expect(fetch).toBeGreaterThan(sandbox);
  });

  it("the service unit names the distinctive release entry point", () => {
    // Fresh installs resolve to v2026.8.22 or newer, which contains this path.
    // Dependency-only updates do not rewrite older units, so those units keep
    // using the server/index.ts back-compat shim.
    expect(SRC).toContain(
      "ExecStart=/usr/local/bin/bun run server/isomux-office.ts",
    );
  });

  it("deps-only mode installs dependencies and nothing else", () => {
    // scripts/update.sh runs the target release's installer with
    // ISOMUX_DEPS_ONLY=1 runs on a LIVE box. It may refresh and run a read-only
    // hardening verifier, but box-policy mutation (firewall, SSH, unattended
    // upgrades), the runtime (bun), and identity changes stay out of it.
    const fn = SRC.slice(
      SRC.indexOf("deps_only() {"),
      SRC.lastIndexOf("\nmain() {"),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain("install_packages");
    expect(fn).toContain("install_browser");
    // A release can newly require a working codex sandbox, and the step is a
    // no-op on a box that already has one.
    expect(fn).toContain("configure_codex_sandbox");
    expect(fn).toContain("install_hardening_verifier");
    expect(fn).toContain('"$VERIFY_HARDENING_TOOL" --check');
    expect(fn).toContain("migrate_caddy_access_log");
    expect(fn).toContain("write_loopback_bind_if_proxied");
    expect(fn.indexOf("restore_caddy_state")).toBeLessThan(
      fn.indexOf("write_loopback_bind_if_proxied"),
    );
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
    // install.sh is downloaded and run on its own, so what it installs on
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
    expect(SRC).toMatch(/apt_install[^\n]*\bopenssh-client\b/);
  });

  it("installs ffmpeg for agent workloads", () => {
    expect(SRC).toMatch(/apt_install[^\n]*\bffmpeg\b/);
  });

  it("installs command-line utilities for agent workloads", () => {
    expect(SRC).toMatch(/apt_install[^\n]*\bripgrep\b/);
    expect(SRC).toMatch(/apt_install[^\n]*\btmux\b/);
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

// The managed Caddyfile, rendered the way configure_caddy renders it. The
// heredoc expands exactly two variables, which the assertion below pins - so a
// literal substitution here IS the file the installer writes, and every claim
// about placement can be made per site block rather than per file.
function renderCaddyfile(
  domain: string,
  kind: "hosted" | "self-hosted" = "self-hosted",
  accessLog = true,
): string {
  const renderer = SRC.indexOf(
    accessLog
      ? "render_caddyfile() {"
      : "render_caddyfile_without_access_log() {",
  );
  const first = SRC.indexOf('cat >"$output" <<EOF\n', renderer);
  const from =
    kind === "hosted"
      ? first
      : SRC.indexOf('cat >"$output" <<EOF\n', first + 1);
  const open = 'cat >"$output" <<EOF\n';
  expect(from).toBeGreaterThan(-1);
  const body = SRC.slice(from + open.length, SRC.indexOf("\nEOF\n", from) + 1);
  expect(new Set(body.match(/\$[A-Za-z_]+/g))).toEqual(
    new Set(["$CADDY_MARKER", "$domain"]),
  );
  return body
    .replaceAll("$CADDY_MARKER", CADDY_MARKER)
    .replaceAll("$domain", domain)
    .replaceAll("\\${", "${");
}

const CADDY_MARKER = "# Managed by the isomux installer";

// One top-level block out of the rendered file. Nested directives are indented
// with tabs, so a site ends at the first `}` in column zero.
function block(rendered: string, header: string): string {
  // The global block has no header - it is the bare `{` after the marker line.
  const from = rendered.indexOf(header === "" ? "\n{\n" : `\n${header} {\n`);
  expect({ header, found: from > -1 }).toEqual({ header, found: true });
  return rendered.slice(from, rendered.indexOf("\n}\n", from) + 3);
}

describe("install.sh: the managed Caddyfile", () => {
  it("pins both pre-log renderings used as the migration ownership proof", () => {
    const sha = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    expect(sha(renderCaddyfile("office.example", "hosted", false))).toBe(
      "09f4544624d0412cc03dfbfdd44b20bce34529761792a6823b29cb24c9ff85d4",
    );
    expect(sha(renderCaddyfile("office.example", "self-hosted", false))).toBe(
      "fa001a042800a0805c71dc3a70933b6b4915615f85b98b5d5ca0ecbac7332fa0",
    );
  });

  it("keeps bounded 14-day logs and redacts both URL credential forms", () => {
    for (const kind of ["hosted", "self-hosted"] as const) {
      const rendered = renderCaddyfile("office.example", kind);
      for (const header of ["office.example", "*.office.example"]) {
        const site = block(rendered, header);
        expect(site).toContain("roll_size 10MiB");
        expect(site).toContain("roll_interval 24h");
        expect(site).toContain("roll_keep 14");
        expect(site).toContain("roll_keep_for 312h");
        expect(site).not.toContain("log_credentials");
        const filters = site.match(/request>uri regexp[^\n]+/g) ?? [];
        expect(filters).toHaveLength(1);
        expect(filters[0]).toContain("(/i/)[^/?#]+");
        expect(filters[0]).toContain("([?&]code=)[^&#]*");

        const pattern = /(\/i\/)[^/?#]+|([?&]code=)[^&#]*/g;
        const replacement = "$1$2<redacted>";
        expect("/i/live-invite?next=/".replace(pattern, replacement)).toBe(
          "/i/<redacted>?next=/",
        );
        expect(
          "/__isomux/auth?code=live-code&return=%2F".replace(
            pattern,
            replacement,
          ),
        ).toBe("/__isomux/auth?code=<redacted>&return=%2F");
      }
    }
  });

  it("writes networkBind only after Caddy succeeds", () => {
    const main = SRC.slice(SRC.lastIndexOf("\nmain() {"));
    expect(main.indexOf("  configure_caddy\n")).toBeGreaterThan(-1);
    expect(main.indexOf("  write_loopback_bind_if_proxied\n")).toBeGreaterThan(
      main.indexOf("  configure_caddy\n"),
    );
    const writer = SRC.slice(
      SRC.indexOf("write_loopback_bind_if_proxied() {"),
      SRC.indexOf("\nconfigure_caddy() {"),
    );
    expect(writer).toContain("systemctl is-active --quiet caddy");
    expect(writer).toContain("reverse_proxy");
    expect(writer).toContain('has("networkBind")');
    expect(writer).toContain("run_as_service_user");
    expect(writer).toContain("chmod --reference");
  });

  it("reports box-side certificate failure and recovery with its one-office credential", () => {
    const helper = SRC.slice(
      SRC.indexOf("install_hosted_tls_renewal() {"),
      SRC.indexOf(
        "\nRENEW_HELPER",
        SRC.indexOf("install_hosted_tls_renewal() {"),
      ),
    );
    expect(helper).toContain("status_endpoint=${endpoint%/renew}/status");
    expect(helper).toContain("report_status failed || true");
    expect(helper.match(/report_status ok/g)?.length).toBe(2);
    expect(helper).toContain(
      "trap 'rc=$?; trap - ERR; report_status failed || true; exit \"$rc\"' ERR",
    );
  });

  it("turns the admin API off, in a global block ahead of the site block", () => {
    // Caddy's admin API listens on 127.0.0.1:2019 by default and rewrites the
    // proxy config with no credential. Loopback is not a trust boundary here:
    // agents run on this box, and an SSRF bug in anything they build reaches it.
    // Not the usual "up to the next \n}\n": the Caddyfile heredoc has its own
    // closing braces at column 0. Slice to the next function instead.
    const rendered = renderCaddyfile("office.example");
    expect(rendered).toContain("admin off");
    // Caddy only accepts global options as the FIRST block in the file.
    expect(rendered.indexOf("admin off")).toBeLessThan(
      rendered.indexOf("office.example {"),
    );
    // Still the same office it proxies to.
    expect(rendered).toContain("reverse_proxy 127.0.0.1:4000");
  });

  it("uses one explicit hosted wildcard certificate and a request-time gate", () => {
    const hosted = renderCaddyfile("office.example", "hosted");
    expect(hosted).toContain(
      "tls /etc/isomux/tls/cert.pem /etc/isomux/tls/key.pem",
    );
    expect(hosted).toContain("forward_auth 127.0.0.1:4000");
    expect(hosted).toContain(`uri ${TLS_ASK_PATH}?domain={http.request.host}`);
    expect(hosted).not.toContain("on_demand");
  });

  it("refuses a root-only key before replacing the Caddyfile", () => {
    const body = SRC.slice(
      SRC.indexOf("install_caddyfile_transaction() {"),
      SRC.indexOf("\nconfigure_caddy() {"),
    );
    expect(body).toContain("assert_caddy_file /etc/isomux/tls/key.pem");
    expect(
      body.indexOf("assert_caddy_file /etc/isomux/tls/key.pem"),
    ).toBeLessThan(body.indexOf('mv -f "$rendered" "$final"'));
    const validator = SRC.slice(
      SRC.indexOf("assert_caddy_file() {"),
      SRC.indexOf("\nconfigure_caddy() {"),
    );
    const dir = mkdtempSync(join(tmpdir(), "isomux-caddy-access-"));
    const key = join(dir, "key.pem");
    writeFileSync(key, "not a key", { mode: 0o600 });
    const proc = Bun.spawnSync([
      "bash",
      "-c",
      `${validator}\nlog(){ :; }\nassert_caddy_file "$1"`,
      "bash",
      key,
    ]);
    rmSync(dir, { recursive: true, force: true });
    expect(proc.exitCode).not.toBe(0);
  });

  // Slice 7. The installer writes the WHOLE file, so "idempotent" means
  // "renders the same bytes every time" - there is no append path and no
  // partial edit to converge.
  it("renders deterministically, which is what makes a re-run a no-op", () => {
    expect(renderCaddyfile("office.example")).toBe(
      renderCaddyfile("office.example"),
    );
    // The domain is the only thing that varies.
    expect(renderCaddyfile("other.example").replaceAll("other", "office")).toBe(
      renderCaddyfile("office.example"),
    );
    const body = SRC.slice(
      SRC.indexOf("configure_caddy() {"),
      SRC.indexOf("\nreport() {"),
    );
    expect(body).not.toContain(">>");
  });

  it("has exactly one marker, one global block and one block per site", () => {
    for (const kind of ["hosted", "self-hosted"] as const) {
      const rendered = renderCaddyfile("office.example", kind);
      expect(rendered.split(CADDY_MARKER).length - 1).toBe(1);
      expect(rendered.startsWith(`${CADDY_MARKER}\n`)).toBe(true);
      expect(rendered.match(/^\S*\s?{$/gm)).toEqual([
        "{",
        "office.example {",
        "*.office.example {",
      ]);
      expect(block(rendered, "")).toContain("admin off");
      expect(block(rendered, "office.example")).toContain(
        `respond ${TLS_ASK_PATH} 404`,
      );
      expect(block(rendered, "office.example")).toContain(
        "reverse_proxy 127.0.0.1:4000",
      );
      expect(block(rendered, "*.office.example")).toContain(
        "reverse_proxy 127.0.0.1:4000",
      );
    }
  });

  it("gates on-demand certificates on the office's own ask endpoint", () => {
    const global = block(renderCaddyfile("office.example"), "");
    expect(global).toContain("on_demand_tls {");
    // The URL the terminator calls must be the route the office actually
    // serves; this fails if either side is renamed alone.
    expect(global).toContain(`ask http://127.0.0.1:4000${TLS_ASK_PATH}`);
  });

  it("puts on-demand TLS on the wildcard site ONLY", () => {
    const rendered = renderCaddyfile("office.example");
    const office = block(rendered, "office.example");
    const wildcard = block(rendered, "*.office.example");
    // The office keeps ordinary automatic HTTPS: it has a name, an A record and
    // a certificate obtained at startup, and nothing about it is on demand.
    expect(office).not.toContain("on_demand");
    expect(wildcard).toContain("tls {");
    expect(wildcard).toContain("on_demand");
    // Both still proxy the office socket - the app arm is the office's own
    // code, on the same listener.
    expect(office).toContain("reverse_proxy 127.0.0.1:4000");
    expect(wildcard).toContain("reverse_proxy 127.0.0.1:4000");
  });

  it("hides the ask endpoint on the office site and NOT on the wildcard", () => {
    const rendered = renderCaddyfile("office.example");
    // Caddy calls the ask URL over loopback, never through a site block, so
    // refusing that exact path at the edge costs nothing and stops a stranger
    // asking the office which apps exist.
    expect(block(rendered, "office.example")).toContain(
      `respond ${TLS_ASK_PATH} 404`,
    );
    // The wildcard must NOT carry it: an app host serves its sign-in handshake
    // under the same prefix.
    expect(block(rendered, "*.office.example")).not.toContain("respond");
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
    expect(serviceUnit()).toContain("OOMScoreAdjust=-500");
  });

  it("installs a RAM-derived office cap before the memory-hungry build", () => {
    expect(SRC).toContain(
      "OFFICE_MEMORY_DROPIN=/etc/systemd/system/isomux.service.d/20-memory.conf",
    );
    expect(SRC).toContain("configure_office_memory_cap");
    expect(SRC).toContain("MemoryMax=${memory_max_mib}M");
    expect(SRC).toContain("MemoryHigh=${memory_high_mib}M");
    expect(SRC).toContain("MemorySwapMax=${OFFICE_SWAP_MAX_MIB}M");
    expect(SRC).toContain("OFFICE_MEMORY_MIN_MIB=4096");
    expect(stepIndex("configure_oom_protection")).toBeLessThan(
      stepIndex("build_isomux"),
    );
  });

  // Task e05a5cd4. Seven variants of a sacrificial unit shaped like the office
  // were measured (internal-docs/sizing-tiers-benchmark-results.md, "The blast
  // radius, measured"); exactly one contained an OOM kill to a single agent,
  // and it needed BOTH of the halves pinned here. Either alone recycles the
  // whole office, which is the incident this came from - so both live in one
  // test, with the reason, rather than as two facts nobody connects.
  it("survives one agent being OOM-killed, which needs the policy AND the stamp", () => {
    // Half one: systemd must not stop the unit when a process inside it is
    // OOM-killed. The default, `stop`, plus Restart=always recycles every
    // agent on the box.
    expect(serviceUnit()).toContain("OOMPolicy=continue");
    expect(serviceUnit()).toContain("Restart=always");

    // Half two: the server raises its own descendants ABOVE itself, so the
    // kernel takes an agent and not the MainPID. `continue` cannot save a unit
    // whose MainPID dies, so without a positive stamp the line above buys
    // nothing.
    expect(AGENT_OOM_SCORE_ADJ).toBeGreaterThan(0);
  });

  // The other way an OOM spike ends the office for good: Restart=always stops
  // meaning always once systemd's default rate limit is hit, and a spike can
  // spend five starts in seconds. Measured on a box under earlyoom pressure,
  // systemd-resolved did exactly that and stayed failed for three hours.
  it("keeps restarting after a burst, instead of giving up for good", () => {
    expect(serviceUnit()).toContain("StartLimitIntervalSec=0");
    // Unbounded retries need a backoff, or a unit that cannot start spins.
    expect(serviceUnit()).toMatch(/^RestartSec=[1-9]/m);
  });
});

// Agents' apps run as systemd USER units of the service account, and this
// installer builds the one environment where `systemctl --user` cannot work at
// all: a service account nobody logs into, so no user manager and no bus. What
// is pinned here is the recipe that fixes it - linger, the bus address in the
// service's environment, and a check that refuses to call it done on faith.
describe("install.sh: the systemd user manager agents' apps run on", () => {
  const fnBody = (name: string) => {
    const start = SRC.indexOf(`${name}() {`);
    expect(start).toBeGreaterThan(-1);
    return SRC.slice(start, SRC.indexOf("\n}\n", start));
  };

  it("enables linger, so the account has a user manager with nobody logged in", () => {
    expect(fnBody("configure_user_manager")).toContain(
      'loginctl enable-linger "$SERVICE_USER"',
    );
  });

  it("hands the service the address of that account's bus", () => {
    // A system unit inherits no XDG_RUNTIME_DIR, and systemd's bus client
    // derives the user bus from it. Without this line every app operation ends
    // at "Failed to connect to bus".
    expect(SRC).toContain(
      "USER_MANAGER_DROPIN=/etc/systemd/system/isomux.service.d/10-user-manager.conf",
    );
    const fn = fnBody("configure_user_manager");
    expect(fn).toContain('uid=$(id -u "$SERVICE_USER")');
    expect(fn).toContain(
      'install -d -m 755 "$(dirname "$USER_MANAGER_DROPIN")"',
    );
    expect(fn).toContain('write_file "$USER_MANAGER_DROPIN" 644');
    expect(fn).toContain("Environment=XDG_RUNTIME_DIR=/run/user/$uid");
    // systemd reads a new drop-in only after a reload.
    expect(fn.indexOf("systemctl daemon-reload")).toBeGreaterThan(
      fn.indexOf('write_file "$USER_MANAGER_DROPIN"'),
    );
  });

  it("adds a drop-in and never rewrites the service unit", () => {
    // deps_only runs this on a live box mid-update. A rewrite there would
    // discard whatever the operator had edited into the unit, and would leave
    // two copies of the environment contract free to drift apart.
    expect(fnBody("configure_user_manager")).not.toContain(
      "write_file /etc/systemd/system/isomux.service ",
    );
    expect(serviceUnit()).not.toContain("XDG_RUNTIME_DIR");
  });

  it("proves the bus answers from the service's environment, not root's", () => {
    // Root runs the installer with a working bus of its own, so a probe that
    // inherited root's environment would pass on a box where the service -
    // which inherits neither XDG_RUNTIME_DIR nor DBUS_SESSION_BUS_ADDRESS -
    // cannot connect. `env -i` is what makes the check mean anything.
    const probe = fnBody("user_manager_reachable");
    expect(probe).toContain('runuser -u "$SERVICE_USER" -- env -i');
    expect(probe).toContain('"XDG_RUNTIME_DIR=/run/user/$1"');
    expect(probe).toContain("/usr/bin/systemctl --user show-environment");
    expect(probe).not.toContain("DBUS_SESSION_BUS_ADDRESS");
  });

  it("stops the run rather than report success with an unreachable bus", () => {
    // Not the browser's warn-and-carry-on: this is the transport a shipped
    // feature runs on, so a box that reported success with it broken would
    // fail every app operation with nothing in the install output that said
    // so. enable-linger returns before logind has finished bringing the user
    // manager up, hence a bounded wait rather than one check.
    const fn = fnBody("configure_user_manager");
    expect(SRC).toMatch(/^USER_MANAGER_TIMEOUT_S=\d+$/m);
    expect(fn).toContain("until user_manager_reachable");
    expect(fn).toMatch(/\(\(waited < USER_MANAGER_TIMEOUT_S\)\) \|\|\s+die /);
  });

  it("runs before the service starts, and converges boxes that predate apps", () => {
    expect(stepIndex("create_service_user")).toBeLessThan(
      stepIndex("configure_user_manager"),
    );
    expect(stepIndex("configure_user_manager")).toBeLessThan(
      stepIndex("install_service"),
    );
    // An existing install has neither linger nor the drop-in, and nobody is
    // going to run a manual step on every box: the dependency sync the updater
    // runs from the target release is the one root-run path that reaches them.
    expect(fnBody("deps_only")).toContain("\n  configure_user_manager\n");
  });
});

// The one piece of install.sh that reads the office's session cookie. It runs
// the REAL awk program out of the source against synthetic jars, because the
// property that matters is a behavior (which name wins), not a substring.
describe("install.sh - session cookie jar parse", () => {
  const awkProgram = (() => {
    const start = SRC.indexOf("raw=$(awk '");
    expect(start).toBeGreaterThan(-1);
    const from = start + "raw=$(awk '".length;
    const end = SRC.indexOf("'", from);
    expect(end).toBeGreaterThan(from);
    return SRC.slice(from, end);
  })();

  async function runAwk(jar: string): Promise<string> {
    const path = `${process.env.TMPDIR ?? "/tmp"}/isomux-cookiejar-${Bun.hash(jar)}.txt`;
    await Bun.write(path, jar);
    const proc = Bun.spawn(["awk", awkProgram, path], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  }

  // Netscape jar rows: domain, flag, path, secure, expiry, NAME, VALUE.
  const row = (name: string, value: string) =>
    `#HttpOnly_127.0.0.1\tFALSE\t/\tTRUE\t9999999999\t${name}\t${value}`;
  const HOST = "__Host-isomux_session";
  const LEGACY = "isomux_session";

  it("prefers the __Host- name over the legacy one, in either row order", async () => {
    // curl writes both when a jar outlives the office's move to HTTPS. The
    // prefix that wins here has to be the one the server itself selects, or
    // the installer resolves the wrong session and mints an invite for the
    // wrong user.
    expect(
      await runAwk(`${row(HOST, "HOSTVAL")}\n${row(LEGACY, "OLDVAL")}\n`),
    ).toBe("HOSTVAL");
    expect(
      await runAwk(`${row(LEGACY, "OLDVAL")}\n${row(HOST, "HOSTVAL")}\n`),
    ).toBe("HOSTVAL");
  });

  it("still reads a legacy-only jar - every pre-HTTPS install has one", async () => {
    expect(await runAwk(`${row(LEGACY, "OLDVAL")}\n`)).toBe("OLDVAL");
  });

  it("reads a __Host--only jar", async () => {
    expect(await runAwk(`${row(HOST, "HOSTVAL")}\n`)).toBe("HOSTVAL");
  });

  it("is empty when the jar holds no session cookie, so the caller can die", async () => {
    expect(await runAwk(`${row("other_cookie", "X")}\n`)).toBe("");
  });
});

// The unit heredoc is UNQUOTED, because it expands $SERVICE_USER, $SERVICE_HOME
// and $INSTALL_DIR. That also means everything else inside it is expanded - and
// on 2026-08-03 two comment lines arrived carrying backticks. Bash ran them:
// `systemctl restart isomux` executed before the unit existed, the installer's
// own failure log was captured as the substitution's output and spliced into
// the file, and systemd rejected the result with "Bad message" on every FRESH
// install. Re-installs kept working (the restart succeeded and printed
// nothing), which is why it survived six days unnoticed.
//
// Rendering the unit is the only way to catch this class: reading the source
// cannot tell an expanded backtick from a literal one.
describe("install.sh: the systemd unit renders cleanly", () => {
  // Pull the heredoc body straight out of the source and let bash expand it
  // exactly as the installer would, with the three variables the unit needs.
  //
  // Rendered with an EMPTY PATH and shell builtins only (read, printf), which
  // is what makes this deterministic: any command substitution left in the body
  // has nothing to exec, so it lands on stderr as "command not found". On a box
  // that happens to HAVE the command - this one runs isomux.service - a
  // backticked "systemctl restart isomux" would succeed and print nothing, and
  // the render would look perfectly clean. That environment dependence is
  // exactly how the real bug hid: it broke fresh installs and spared re-installs.
  function renderUnit(source: string): { unit: string; stderr: string } {
    const start = source.indexOf(
      "write_file /etc/systemd/system/isomux.service 644 <<EOF",
    );
    expect(start).toBeGreaterThan(-1);
    const bodyStart = source.indexOf("\n", start) + 1;
    const end = source.indexOf("\nEOF\n", bodyStart);
    expect(end).toBeGreaterThan(bodyStart);
    const body = source.slice(bodyStart, end);
    const script =
      `SERVICE_USER=isomux\nSERVICE_HOME=/home/isomux\nINSTALL_DIR=/opt/isomux\n` +
      `IFS= read -r -d '' rendered <<EOF\n${body}\nEOF\nprintf '%s' "$rendered"\n`;
    const proc = Bun.spawnSync(["bash", "-c", script], { env: { PATH: "" } });
    return {
      unit: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  }

  const { unit, stderr: renderStderr } = renderUnit(SRC);

  // The deterministic detector: with no PATH, a body that still executes
  // something cannot stay quiet.
  it("executes nothing while being rendered", () => {
    expect(renderStderr).toBe("");
  });

  it("expands the three variables it is unquoted for", () => {
    expect(unit).toContain("User=isomux");
    expect(unit).toContain("Environment=HOME=/home/isomux");
    expect(unit).toContain("WorkingDirectory=/opt/isomux");
  });

  // The portable core of the check: no line may carry this installer's log
  // prefix, which can only get in there by a command substitution running.
  it("carries no command-substitution artifacts", () => {
    expect(unit).not.toContain("[isomux-install]");
    expect(unit).not.toContain("command not found");
    expect(unit).not.toContain("Failed to");
  });

  it("keeps every line a comment, a section header or a directive", () => {
    for (const line of unit.split("\n")) {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue;
      expect(t).toMatch(/^(\[[A-Za-z]+\]|[A-Za-z][A-Za-z0-9]*=)/);
    }
  });

  // The source-level guard, so the hazard is caught before a render is needed.
  it("has no backticks or command substitution in the heredoc body", () => {
    const start = SRC.indexOf(
      "write_file /etc/systemd/system/isomux.service 644 <<EOF",
    );
    const bodyStart = SRC.indexOf("\n", start) + 1;
    const body = SRC.slice(bodyStart, SRC.indexOf("\nEOF\n", bodyStart));
    expect(body).not.toContain("`");
    expect(body).not.toContain("$(");
  });

  // systemd's own verdict where the tool exists. The EXIT STATUS is the
  // verdict; filtering stderr for two phrases would pass a unit systemd
  // rejected for a third reason.
  //
  // Two diagnostics are environment-only and are tolerated by name, because
  // they describe THIS machine rather than the unit: the isomux service account
  // does not exist on a dev box, and neither does the bun binary the unit
  // execs. Both are facts about where the test runs. Every other complaint
  // fails the test, and the tolerated ones are matched narrowly enough that a
  // real defect cannot hide behind them.
  it("passes systemd-analyze verify, where available", () => {
    const probe = Bun.spawnSync(["bash", "-c", "command -v systemd-analyze"]);
    if (probe.exitCode !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "isomux-unit-"));
    const file = join(dir, "isomux.service");
    writeFileSync(file, unit);
    const proc = Bun.spawnSync(["systemd-analyze", "verify", file]);
    const stderr = new TextDecoder().decode(proc.stderr);
    rmSync(dir, { recursive: true, force: true });

    const complaints = stderr
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter(
        (l) =>
          !/\b(User|Group)\b.*isomux.*(not found|does not exist)/i.test(l) &&
          !/Command .*bun is not executable: No such file or directory/i.test(
            l,
          ),
      );
    expect(complaints).toEqual([]);
    if (stderr === "") expect(proc.exitCode).toBe(0);
  });
});

// The backtick defect is a CLASS, not one line, and it can exist at two stages.
//
// Stage 1 is what install.sh's own shell expands. Stage 2 is what the helper
// scripts it GENERATES expand when they later run: quoting the outer delimiter
// makes those bodies literal to install.sh, which protects them then, and
// protects them not at all once the helper is installed and executed under its
// own shell.
//
// Backticks inside a heredoc that will be expanded are never intentional here -
// if substitution is wanted, $( ) says so visibly - and command substitution in
// COMMENT text is always a mistake.
describe("install.sh: no heredoc executes its own comments", () => {
  interface Block {
    startLine: number;
    delimiter: string;
    quoted: boolean;
    body: string[];
  }

  /** All heredocs in one shell body, every delimiter form. */
  function heredocs(lines: string[]): Block[] {
    const start = /<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/;
    const out: Block[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = start.exec(lines[i]);
      if (!m) continue;
      const dash = m[1] === "-";
      const delimiter = m[3];
      let j = i + 1;
      while (j < lines.length) {
        const t = dash ? lines[j].trim() : lines[j];
        if (t === delimiter) break;
        j++;
      }
      out.push({
        startLine: i + 1,
        delimiter,
        quoted: m[2] !== "",
        body: lines.slice(i + 1, j),
      });
      i = j;
    }
    return out;
  }

  function hazards(body: string[]): string[] {
    const found: string[] = [];
    for (const line of body) {
      if (line.includes("`")) found.push(`backtick: ${line.trim()}`);
      if (/^\s*#/.test(line) && line.includes("$(")) {
        found.push(`substitution in a comment: ${line.trim()}`);
      }
    }
    return found;
  }

  const srcLines = SRC.split("\n");
  const stage1 = heredocs(srcLines);

  it("finds the heredocs it claims to (all delimiter forms)", () => {
    // Pins the scan itself, so a future edit that adds one is visible here
    // rather than silently outside the checks below.
    expect(stage1.length).toBeGreaterThanOrEqual(10);
    expect(stage1.some((b) => b.quoted)).toBe(true);
    expect(stage1.some((b) => !b.quoted)).toBe(true);
  });

  it("stage 1: nothing install.sh expands carries a backtick or a substituted comment", () => {
    const bad = stage1
      .filter((b) => !b.quoted)
      .flatMap((b) =>
        hazards(b.body).map(
          (h) => `line ${b.startLine} (${b.delimiter}): ${h}`,
        ),
      );
    expect(bad).toEqual([]);
  });

  // The recursion the first version of this scan missed.
  it("stage 2: nothing a GENERATED helper expands carries one either", () => {
    const bad: string[] = [];
    for (const outer of stage1.filter((b) => b.quoted)) {
      for (const inner of heredocs(outer.body)) {
        if (inner.quoted) continue; // literal when the helper runs too
        for (const h of hazards(inner.body)) {
          bad.push(
            `${outer.delimiter} line ${outer.startLine + inner.startLine} (${inner.delimiter}): ${h}`,
          );
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("stage 2 actually descends - the helpers really do contain heredocs", () => {
    // Otherwise the test above would pass by finding nothing to look at.
    const inner = stage1
      .filter((b) => b.quoted)
      .flatMap((b) => heredocs(b.body));
    expect(inner.length).toBeGreaterThan(0);
    expect(inner.some((b) => !b.quoted)).toBe(true);
  });
});
