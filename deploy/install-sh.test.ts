// deploy/install.sh — content pins for the in-UI update-trigger escalation.
// install.sh has no unprivileged execution harness (preflight requires root),
// so these tests pin the SOURCE of the security-load-bearing pieces instead:
// the polkit rule (extracted and exercised as a real RegExp), the root-owned
// template unit, and the ordering that keeps them inside the guarded
// updater-install step. A loosened regex or a widened grant fails here before
// any reviewer has to notice it. Zero execution, zero LLM.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";

const SRC = readFileSync(new URL("./install.sh", import.meta.url), "utf8");

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
});
