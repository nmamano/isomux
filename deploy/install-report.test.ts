// deploy/install.sh — the final report's handling of the owner invite.
//
// The invite is a live credential. Printed to a terminal it is read once and
// gone; printed into cloud-init's log, a `| tee`, or an agent's transcript it
// sits there. So report() prints the link only when stdout is a terminal, and
// names the file it saved it to otherwise. Both branches are RUN here, the
// terminal one through a real pty (`script`), so the test exercises the actual
// `[[ -t 1 ]]` decision rather than pattern-matching the source. Nothing is
// installed. Zero LLM.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;
const SRC = readFileSync(INSTALL_SH, "utf8");

const INVITE = "https://office.example.com/i/SECRET-INVITE-TOKEN";
const INVITE_FILE = "/var/lib/isomux-install/invite-url";

let base: string;

// report() with everything around it stubbed: the real function, the real
// output_is_watched, fake state.
function driver(): string {
  return `
set -Eeuo pipefail
eval "$(sed -n '/^report()/,/^}/p' "${INSTALL_SH}")"
eval "$(sed -n '/^output_is_watched()/,/^}/p' "${INSTALL_SH}")"
log() { printf '[isomux-install] %s\\n' "$*"; }
step() { :; }
FAILURE_SENTINEL=""
DOMAIN=office.example.com
INVITE_URL=${INVITE}
INVITE_FILE=${INVITE_FILE}
RESOLVED_OWNER_NAME=Owner
SSH_HARDENING_SKIPPED=""
INSTALL_CALLBACK_URL=""
DRY_RUN=""
report
`;
}

/** Run report() with stdout on a pipe (no terminal) or on a real pty. */
function runReport(onATerminal: boolean): string {
  const path = join(base, "driver.sh");
  writeFileSync(path, driver());
  const res = onATerminal
    ? // script(1) gives the child a real pty, so `[[ -t 1 ]]` is true for the
      // same reason it is true for an operator watching over ssh.
      spawnSync("script", ["-qec", `bash ${path}`, "/dev/null"], {
        encoding: "utf8",
      })
    : spawnSync("bash", [path], { encoding: "utf8" });
  expect(res.status).toBe(0);
  // A pty echoes CRLF; normalize so the assertions read the same either way.
  return `${res.stdout}${res.stderr}`.replaceAll("\r", "");
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "isomux-install-report-test-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("install.sh report(): the owner invite", () => {
  it("prints the link when a terminal is watching", () => {
    const out = runReport(true);
    expect(out).toContain(`Owner invite: ${INVITE}`);
    expect(out).toContain("single-use and valid for 24 hours");
    // Still says where it was saved, so the operator can find it again.
    expect(out).toContain(INVITE_FILE);
  });

  it("names the file instead of the link when nothing is watching", () => {
    const out = runReport(false);
    // The credential itself must not be in output that lands on disk.
    expect(out).not.toContain(INVITE);
    expect(out).not.toContain("SECRET-INVITE-TOKEN");
    expect(out).toContain(`Owner invite: saved at ${INVITE_FILE}`);
    // And the operator is told how to read it.
    expect(out).toContain(`cat ${INVITE_FILE}`);
    expect(out).toContain("single-use and valid for 24 hours");
  });

  it("says the same things either way, apart from the link", () => {
    for (const out of [runReport(true), runReport(false)]) {
      expect(out).toContain("Isomux is installed.");
      expect(out).toContain("Office URL:   https://office.example.com");
      expect(out).toContain('"Owner" (changeable later)');
      expect(out).toContain("To mint a fresh one, re-run this installer.");
    }
  });

  it("decides on stdout being a terminal, nothing else", () => {
    // A guess based on an env var (CI=, TERM=dumb) would be wrong for an agent
    // running the installer over ssh, which is the case this exists for.
    expect(SRC).toContain("output_is_watched() { [[ -t 1 ]]; }");
  });

  it("still hands the full link to the callback channel", () => {
    // INSTALL_CALLBACK_URL is how the hosted flow delivers the invite. Muting
    // the printed link must not mute that, or an unattended install has no way
    // to hand the office over.
    const fn = SRC.slice(
      SRC.indexOf("report() {"),
      SRC.indexOf("\ndeps_only() {"),
    );
    expect(fn).toContain('jq -n --arg url "$INVITE_URL"');
  });
});
