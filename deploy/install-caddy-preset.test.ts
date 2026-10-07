// deploy/install.sh - install_packages masks caddy before apt on a box whose
// office it cannot verify, which includes a clean host where caddy is not
// installed yet. caddy's postinst then fails to preset the masked unit,
// ignores the failure, and prints two error lines. install_packages drops
// exactly those lines with drop_output_lines.
//
// The two lines below are what caddy 2.11.7's postinst printed in a docker
// ubuntu:24.04 run with the unit masked before the install (2026-10-08).
// drop_output_lines is extracted with sed (as in install-apt-conffiles.test.ts)
// and run under the installer's shell options. Nothing is installed. Zero LLM.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { spawnSync } from "child_process";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;
const SRC = readFileSync(INSTALL_SH, "utf8");

const PRESET_LINES = [
  "Failed to preset unit, unit /etc/systemd/system/caddy.service is masked.",
  "/usr/bin/deb-systemd-helper: error: systemctl preset failed on caddy.service: No such file or directory",
];
const KEPT_LINES = [
  "Setting up caddy (2.11.7) ...",
  "dpkg: error processing package caddy (--configure):",
  "Failed to preset unit, unit /etc/systemd/system/nginx.service is masked.",
];

function installPackagesBody(): string {
  const start = SRC.indexOf("\ninstall_packages() {");
  return SRC.slice(start, SRC.indexOf("\n}\n", start));
}

function presetPattern(): string {
  const match = installPackagesBody().match(/drop_output_lines '([^']+)'/);
  if (!match)
    throw new Error("install_packages does not call drop_output_lines");
  return match[1]!;
}

// Runs drop_output_lines around a command that prints `lines` (alternating
// stdout and stderr) and exits with `status`.
function runFilter(pattern: string, lines: string[], status: number) {
  const script = `
set -Eeuo pipefail
eval "$(sed -n '/^drop_output_lines()/,/^}/p' "$INSTALL_SH")"
emit() {
  local i=0 line
  for line in "$@"; do
    if (( i % 2 )); then printf '%s\\n' "$line" >&2; else printf '%s\\n' "$line"; fi
    i=$((i + 1))
  done
  return "$STATUS"
}
rc=0
drop_output_lines "$PATTERN" emit "$@" || rc=$?
echo "RC: $rc"
`;
  const res = spawnSync("bash", ["-c", script, "bash", ...lines], {
    env: {
      ...process.env,
      INSTALL_SH,
      PATTERN: pattern,
      STATUS: String(status),
    },
    encoding: "utf8",
  });
  return { stdout: res.stdout, stderr: res.stderr };
}

describe("install.sh: caddy's preset error on a masked unit", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    it(`drops each postinst line from ${stream} and keeps every other line on its own stream`, () => {
      // emit alternates stdout (even index) and stderr (odd index).
      const lines =
        stream === "stdout"
          ? [PRESET_LINES[0]!, KEPT_LINES[0]!, PRESET_LINES[1]!, KEPT_LINES[1]!]
          : [
              KEPT_LINES[0]!,
              PRESET_LINES[0]!,
              KEPT_LINES[1]!,
              PRESET_LINES[1]!,
            ];
      lines.push(KEPT_LINES[2]!);
      const out = runFilter(presetPattern(), lines, 0);
      for (const line of PRESET_LINES) {
        expect(out.stdout).not.toContain(line);
        expect(out.stderr).not.toContain(line);
      }
      lines.forEach((line, i) => {
        if (PRESET_LINES.includes(line)) return;
        const own = i % 2 ? out.stderr : out.stdout;
        const other = i % 2 ? out.stdout : out.stderr;
        expect(own).toContain(line);
        expect(other).not.toContain(line);
      });
      expect(out.stdout).toContain("RC: 0");
    });
  }

  it("returns the command's failure status", () => {
    const { stdout } = runFilter(presetPattern(), [...PRESET_LINES], 7);
    expect(stdout).toContain("RC: 7");
  });

  it("filters only the caddy install that runs while caddy is masked", () => {
    const body = installPackagesBody();
    const masked = body.indexOf("if [[ -n $CADDY_MASKED ]]; then");
    const call = body.indexOf("drop_output_lines '");
    const target = body.indexOf("apt_install caddy nodejs", call);
    expect(masked).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(masked);
    expect(target).toBeGreaterThan(call);
    expect(body.indexOf("\n    else\n", call)).toBeGreaterThan(target);
  });
});
