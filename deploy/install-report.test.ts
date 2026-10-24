// deploy/install.sh - the final report's handling of the owner invite.
//
// The invite is a live credential. Printed to a terminal it is read once and
// gone; printed into cloud-init's log, a `| tee`, or an agent's transcript it
// sits there. So report() prints the link only when stdout is a terminal, and
// names the file it saved it to otherwise. Both branches are RUN here, the
// terminal one through a real pty (`script`), so the test exercises the actual
// `[[ -t 1 ]]` decision rather than pattern-matching the source. Nothing is
// installed. Zero LLM.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { spawnSync } from "child_process";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;
const SRC = readFileSync(INSTALL_SH, "utf8");

const INVITE = "https://office.example.com/i/SECRET-INVITE-TOKEN";
const INVITE_FILE = "/var/lib/isomux-install/invite-url";

let base: string;

// The command the report tells the operator to run once a key is on the box.
const HARDEN_TOOL = SRC.match(/^HARDEN_TOOL=(\S+)$/m)?.[1] ?? "";

interface ReportOptions {
  sshHardeningSkipped?: boolean;
  callbackUrl?: string;
}

// report() with everything around it stubbed: the real function, the real
// output_is_watched, fake state. curl is a stub on PATH that saves its argv and
// its stdin.
function driver(opts: ReportOptions): string {
  return `
set -Eeuo pipefail
eval "$(sed -n '/^report()/,/^}/p' "${INSTALL_SH}")"
eval "$(sed -n '/^output_is_watched()/,/^}/p' "${INSTALL_SH}")"
log() { printf '[isomux-install] %s\\n' "$*"; }
step() { :; }
PATH=${join(base, "bin")}:$PATH
FAILURE_SENTINEL=""
DOMAIN=office.example.com
INVITE_URL=${INVITE}
INVITE_FILE=${INVITE_FILE}
RESOLVED_OWNER_NAME=Owner
SSH_HARDENING_SKIPPED=${opts.sshHardeningSkipped ? "1" : '""'}
INSTALL_CALLBACK_URL=${opts.callbackUrl ?? '""'}
DRY_RUN=""
report
`;
}

/** Run report() with stdout on a pipe (no terminal) or on a real pty. */
function runReport(onATerminal: boolean, opts: ReportOptions = {}): string {
  const path = join(base, "driver.sh");
  writeFileSync(path, driver(opts));
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
  mkdirSync(join(base, "bin"));
  writeFileSync(
    join(base, "bin", "curl"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >"${base}/curl.argv"\ncat >"${base}/curl.stdin"\n`,
    { mode: 0o755 },
  );
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

  it("still hands the full link to the callback channel", () => {
    // INSTALL_CALLBACK_URL is how the hosted flow delivers the invite. Muting
    // the printed link must not mute that, or an unattended install has no way
    // to hand the office over. The link goes through stdin: argv shows in ps.
    const url = "https://cb.example/install";
    runReport(false, { callbackUrl: url });
    const argv = readFileSync(join(base, "curl.argv"), "utf8").split("\n");
    expect(argv).toContain(url);
    expect(argv.join(" ")).not.toContain("SECRET-INVITE-TOKEN");
    const body = JSON.parse(readFileSync(join(base, "curl.stdin"), "utf8"));
    expect(body).toEqual({ inviteUrl: INVITE, status: "ok" });
  });

  it("names the hardening command only when hardening was skipped", () => {
    // A box with no SSH key yet keeps password logins; whoever adds a key
    // later needs the one command to run, not a whole installer.
    const tool = basename(HARDEN_TOOL);
    expect(tool).not.toBe("");
    expect(runReport(false, { sshHardeningSkipped: true })).toContain(
      `sudo ${tool}`,
    );
    expect(runReport(false)).not.toContain(tool);
  });
});
