// deploy/install.sh - single steps RUN against PATH stubs and temp roots:
// the hosted-kind marker, the two root-reachability gates, the browser step
// and the systemd user manager. Each function is extracted from the installer
// (its FIRST definition: install.sh embeds other scripts in heredocs that
// define their own run / write_file / log / as_service_user), its absolute
// paths are rewritten into a temp root, and the commands it calls are stubs
// that record their argv. Nothing is installed. Zero LLM.

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
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { spawnSync } from "child_process";

const SRC = readFileSync(new URL("./install.sh", import.meta.url), "utf8");

/** The FIRST definition of a multi-line function, through its closing brace. */
function extract(fn: string): string {
  const start = SRC.search(new RegExp(`^${fn}\\(\\) \\{$`, "m"));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SRC.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end + 3);
}

/** The installer's top-level `NAME=value` line (the first one in the file). */
function constant(name: string): string {
  const m = SRC.match(new RegExp(`^${name}=.*$`, "m"));
  expect(m).not.toBeNull();
  return m![0];
}

/** Rewrite an absolute path, proving it is there first. */
function localize(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replaceAll(from, to);
}

let base: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "isomux-install-steps-test-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A PATH stub that appends `name argv` to $CALLS, then runs `body`. */
function stub(bin: string, name: string, body = "") {
  const p = join(bin, name);
  writeFileSync(
    p,
    `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS"\n${body}\n`,
  );
  chmodSync(p, 0o755);
}

interface Run {
  code: number;
  out: string;
  calls: string[];
  reachedEnd: boolean;
  warnings: string[];
  errTraps: string[];
}

function newCase(): { dir: string; bin: string; calls: string } {
  const dir = mkdtempSync(join(base, "case-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  return { dir, bin, calls };
}

// Shared shell around every step: strict mode with the installer's ERR trap
// shape, and step / log / die that record instead of reporting.
function runSteps(
  c: { bin: string; calls: string },
  body: string,
  env: Record<string, string> = {},
): Run {
  const script = `
set -Eeuo pipefail
trap 'echo "ERR-TRAP: $BASH_COMMAND" >&2' ERR
DRY_RUN=""
step() { echo "step $1" >> "$CALLS"; }
log() { echo "LOG: $*"; }
die() { echo "die $*" >> "$CALLS"; exit 1; }
${body}
echo "REACHED-END"
`;
  const res = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      ...env,
      PATH: `${c.bin}:${process.env.PATH}`,
      CALLS: c.calls,
    },
    encoding: "utf8",
  });
  const out = `${res.stdout}${res.stderr}`;
  const lines = out.split("\n");
  return {
    code: res.status ?? -1,
    out,
    calls: readFileSync(c.calls, "utf8").split("\n").filter(Boolean),
    reachedEnd: lines.includes("REACHED-END"),
    warnings: lines.filter((l) => l.startsWith("LOG: warning: ")),
    errTraps: lines.filter((l) => l.startsWith("ERR-TRAP: ")),
  };
}

const firstIndex = (calls: string[], prefix: string) =>
  calls.findIndex((l) => l.startsWith(prefix));

describe("install.sh sync_install_kind: the hosted marker follows enrollment", () => {
  function runSync(opts: { enrolled: boolean; staleMarker?: boolean }) {
    const c = newCase();
    const etc = join(c.dir, "etc", "isomux");
    const marker = join(etc, "install-kind");
    if (opts.enrolled) {
      mkdirSync(join(etc, "renewal"), { recursive: true, mode: 0o700 });
      writeFileSync(join(etc, "renewal", "enrollment.json"), "{}");
    }
    if (opts.staleMarker) {
      mkdirSync(etc, { recursive: true });
      writeFileSync(marker, "hosted\n");
    }
    // -o/-g root need root; the mode is what this test reads.
    stub(
      c.bin,
      "install",
      `args=(); while (($#)); do case $1 in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done
exec /usr/bin/install "\${args[@]}"`,
    );
    stub(c.bin, "rm", `exec /usr/bin/rm "$@"`);
    const fn = localize(extract("sync_install_kind"), "/etc/isomux", etc);
    const kind = localize(constant("INSTALL_KIND_FILE"), "/etc/isomux", etc);
    // A restrictive root umask must not leave the marker unreadable.
    const r = runSteps(
      c,
      `umask 077
${kind}
${extract("run")}${extract("write_file")}${fn}
sync_install_kind`,
    );
    return { ...r, marker };
  }

  it("writes `hosted`, mode 644, on an enrolled box", () => {
    const r = runSync({ enrolled: true });
    expect(r.code).toBe(0);
    expect(r.reachedEnd).toBe(true);
    expect(readFileSync(r.marker, "utf8")).toBe("hosted\n");
    expect(statSync(r.marker).mode & 0o777).toBe(0o644);
  });

  it("removes a stale marker once the box is no longer enrolled", () => {
    const r = runSync({ enrolled: false, staleMarker: true });
    expect(r.code).toBe(0);
    expect(r.reachedEnd).toBe(true);
    expect(r.calls).toContain(`rm -f ${r.marker}`);
    expect(existsSync(r.marker)).toBe(false);
  });
});

// Both gates read one exit code from `isomux-harden-ssh --check`: 0 passes,
// 1 is a failed check, anything else is a check that could not decide, and
// both of those stop the install. 10 is "hardening skipped" for --apply
// (harden_ssh), but a gate gives it no such pass: it lands in the
// could-not-decide arm.
describe("install.sh root-reachability gates: only a passing check continues", () => {
  function runGate(gate: string, rc: number) {
    const c = newCase();
    stub(c.bin, "isomux-harden-ssh", `exit ${rc}`);
    return runSteps(
      c,
      `HARDEN_TOOL="${join(c.bin, "isomux-harden-ssh")}"
SERVICE_USER=isomux
${extract(gate)}
${gate}`,
    );
  }

  for (const gate of ["check_root_reachability", "assert_hardening"]) {
    it(`${gate} continues when the check passes`, () => {
      const r = runGate(gate, 0);
      expect(r.code).toBe(0);
      expect(r.reachedEnd).toBe(true);
      expect(r.calls).toEqual([
        `step ${gate.replaceAll("_", "-")}`,
        "isomux-harden-ssh --check",
      ]);
    });

    it.each([1, 2, 10, 127])(`${gate} stops the install on rc %d`, (rc) => {
      const r = runGate(gate, rc);
      expect(r.code).toBe(1);
      expect(r.reachedEnd).toBe(false);
      expect(r.calls).toHaveLength(3);
      expect(r.calls[1]).toBe("isomux-harden-ssh --check");
      expect(r.calls[2]).toStartWith("die ");
    });
  }
});

// Non-fatal throughout: every failure warns and the install goes on.
describe("install.sh browser step: a missing or broken browser only warns", () => {
  interface BrowserOpts {
    arch?: string;
    curlFails?: boolean;
    aptFails?: boolean;
    noPng?: boolean;
  }

  function runBrowser(opts: BrowserOpts) {
    const c = newCase();
    const usrBin = join(c.dir, "usr", "bin");
    mkdirSync(usrBin, { recursive: true });
    const chrome = join(usrBin, "google-chrome");
    // The browser apt_install puts in place: answers --version, and writes a
    // PNG to --screenshot= unless the case says it cannot capture.
    const chromeStub = join(c.dir, "chrome-stub");
    writeFileSync(
      chromeStub,
      `#!/usr/bin/env bash
echo "google-chrome $*" >> "$CALLS"
[[ $1 == --version ]] && { echo "Google Chrome 1.0"; exit 0; }
for a in "$@"; do
  [[ $a == --screenshot=* && -z \${NO_PNG:-} ]] && printf 'PNG' > "\${a#--screenshot=}"
done
exit 0
`,
    );
    chmodSync(chromeStub, 0o755);
    stub(c.bin, "dpkg", `echo "${opts.arch ?? "amd64"}"`);
    stub(
      c.bin,
      "curl",
      `[[ -z \${CURL_FAILS:-} ]] || exit 22
while (($#)); do [[ $1 == -o ]] && echo deb > "$2"; shift; done`,
    );
    // runuser -u USER -- CMD...: runs CMD here, so the real as_service_user
    // is what builds the probe's command line.
    stub(c.bin, "runuser", `shift 2; [[ \${1:-} == -- ]] && shift; exec "$@"`);
    stub(c.bin, "chown");
    stub(c.bin, "snap");
    const path = localize(
      constant("CHROME_PATH"),
      "/usr/bin/google-chrome",
      chrome,
    );
    const r = runSteps(
      c,
      `SERVICE_USER=isomux
SERVICE_HOME=/home/isomux
${path}
${constant("CHROME_DEB_URL")}
${extract("as_service_user")}${extract("install_browser")}${extract("verify_browser")}
apt_install() {
  echo "apt_install $*" >> "$CALLS"
  [[ -z \${APT_FAILS:-} ]] || return 100
  install -m 755 "${chromeStub}" "$CHROME_PATH"
}
install_browser`,
      {
        ...(opts.curlFails ? { CURL_FAILS: "1" } : {}),
        ...(opts.aptFails ? { APT_FAILS: "1" } : {}),
        ...(opts.noPng ? { NO_PNG: "1" } : {}),
      },
    );
    // The .deb curl was told to write to, so a case can check it is gone.
    const curlCall = r.calls.find((l) => l.startsWith("curl "));
    const deb = curlCall?.match(/ -o (\S+)/)?.[1] ?? null;
    return { ...r, chrome, deb };
  }

  // Every row: the install carries on, the ERR trap never fires, and snap is
  // never the way in.
  function expectCarriesOn(r: Run) {
    expect(r.code).toBe(0);
    expect(r.reachedEnd).toBe(true);
    expect(r.errTraps).toEqual([]);
    expect(r.calls.filter((l) => l.startsWith("snap "))).toEqual([]);
  }

  it("warns on an architecture Chrome does not ship, before any download", () => {
    const r = runBrowser({ arch: "arm64" });
    expectCarriesOn(r);
    expect(r.calls).toContain("dpkg --print-architecture");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("arm64");
    expect(firstIndex(r.calls, "curl ")).toBe(-1);
  });

  it("warns when the download fails, and installs nothing", () => {
    const r = runBrowser({ curlFails: true });
    expectCarriesOn(r);
    expect(r.deb).not.toBeNull();
    expect(existsSync(r.deb!)).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(firstIndex(r.calls, "apt_install ")).toBe(-1);
  });

  it("warns when the package install fails, and runs no probe", () => {
    const r = runBrowser({ aptFails: true });
    expectCarriesOn(r);
    expect(r.calls).toContain(`apt_install ${r.deb}`);
    expect(existsSync(r.deb!)).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(firstIndex(r.calls, "runuser ")).toBe(-1);
  });

  it("warns when the installed browser produces no screenshot", () => {
    const r = runBrowser({ noPng: true });
    expectCarriesOn(r);
    expect(firstIndex(r.calls, "runuser ")).toBeGreaterThan(-1);
    expect(r.warnings).toHaveLength(1);
    expect(r.calls).not.toContain("google-chrome --version");
  });

  it("on success, proves a capture as the service user", () => {
    const r = runBrowser({});
    expectCarriesOn(r);
    expect(r.warnings).toEqual([]);
    expect(existsSync(r.deb!)).toBe(false);
    const probe = r.calls.find((l) => l.startsWith("runuser "));
    expect(probe).toStartWith(
      `runuser -u isomux -- env HOME=/home/isomux timeout 60 ${r.chrome} --headless=new --screenshot=`,
    );
    // The capture came first; --version is only asked for the ready line.
    const shot = firstIndex(r.calls, "google-chrome --headless=new");
    expect(shot).toBeGreaterThan(firstIndex(r.calls, "runuser "));
    expect(r.calls.indexOf("google-chrome --version")).toBeGreaterThan(shot);
  });
});

describe("install.sh configure_user_manager: linger, the bus address, a probe that must answer", () => {
  const TIMEOUT_S = 2;

  /** reachAfter: the probe attempt that first answers; null never answers. */
  function runUserManager(reachAfter: number | null) {
    const c = newCase();
    const units = join(c.dir, "system");
    mkdirSync(units);
    // The service unit this step must leave alone.
    const unit = join(units, "isomux.service");
    writeFileSync(unit, "[Service]\nExecStart=/opt/isomux/start\n");
    stub(c.bin, "id", "echo 4242");
    stub(c.bin, "loginctl");
    stub(c.bin, "systemctl");
    stub(c.bin, "sleep");
    const attempts = join(c.dir, "attempts");
    stub(
      c.bin,
      "runuser",
      `echo x >> "${attempts}"
n=$(wc -l < "${attempts}")
[[ -n "${reachAfter ?? ""}" ]] && ((n >= ${reachAfter ?? 0}))`,
    );
    const dropinLine = localize(
      constant("USER_MANAGER_DROPIN"),
      "/etc/systemd/system",
      units,
    );
    // The real write_file, wrapped so every path written is on record.
    const writeFile = extract("write_file").replace(
      "write_file() {",
      "real_write_file() {",
    );
    const r = runSteps(
      c,
      `SERVICE_USER=isomux-svc
SERVICE_HOME=/home/isomux-svc
${dropinLine}
USER_MANAGER_TIMEOUT_S=${TIMEOUT_S}
${writeFile}
write_file() { echo "write_file $1" >> "$CALLS"; real_write_file "$@"; }
${extract("user_manager_reachable")}${extract("configure_user_manager")}
configure_user_manager`,
      // Root's own bus must not reach the probe.
      { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus" },
    );
    const dropin = join(units, "isomux.service.d", "10-user-manager.conf");
    const files = (readdirSync(units, { recursive: true }) as string[])
      .map((f) => join(units, f))
      .filter((f) => statSync(f).isFile())
      .map((f) => relative(units, f))
      .sort();
    return { ...r, dropin, unit, files };
  }

  const probes = (calls: string[]) =>
    calls.filter((l) => l.startsWith("runuser "));

  it("enables linger, writes only the drop-in, reloads, and goes on once the bus answers", () => {
    const r = runUserManager(1);
    expect(r.code).toBe(0);
    expect(r.reachedEnd).toBe(true);
    expect(r.calls).toContain("id -u isomux-svc");
    const linger = r.calls.indexOf("loginctl enable-linger isomux-svc");
    const write = r.calls.indexOf(`write_file ${r.dropin}`);
    const reload = r.calls.indexOf("systemctl daemon-reload");
    expect(linger).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(linger);
    expect(reload).toBeGreaterThan(write);
    expect(firstIndex(r.calls, "runuser ")).toBeGreaterThan(reload);

    // The drop-in is the only file written; the unit is untouched.
    expect(r.calls.filter((l) => l.startsWith("write_file "))).toEqual([
      `write_file ${r.dropin}`,
    ]);
    expect(r.files).toEqual([
      "isomux.service",
      join("isomux.service.d", "10-user-manager.conf"),
    ]);
    expect(readFileSync(r.unit, "utf8")).toBe(
      "[Service]\nExecStart=/opt/isomux/start\n",
    );
    const lines = readFileSync(r.dropin, "utf8").split("\n");
    expect(lines).toContain("[Service]");
    expect(lines).toContain("Environment=XDG_RUNTIME_DIR=/run/user/4242");

    // The probe runs as the service user, from a scrubbed environment.
    expect(probes(r.calls)).toEqual([
      "runuser -u isomux-svc -- env -i HOME=/home/isomux-svc XDG_RUNTIME_DIR=/run/user/4242 /usr/bin/systemctl --user show-environment",
    ]);
    expect(r.calls.join("\n")).not.toContain("DBUS");
    expect(firstIndex(r.calls, "die ")).toBe(-1);
  });

  it("waits for a user manager that comes up late", () => {
    const r = runUserManager(TIMEOUT_S + 1);
    expect(r.code).toBe(0);
    expect(r.reachedEnd).toBe(true);
    expect(probes(r.calls)).toHaveLength(TIMEOUT_S + 1);
    expect(r.calls.filter((l) => l === "sleep 1")).toHaveLength(TIMEOUT_S);
    expect(firstIndex(r.calls, "die ")).toBe(-1);
  });

  it("stops the run when the bus never answers within the timeout", () => {
    const r = runUserManager(null);
    expect(r.code).toBe(1);
    expect(r.reachedEnd).toBe(false);
    expect(probes(r.calls)).toHaveLength(TIMEOUT_S + 1);
    expect(r.calls.filter((l) => l === "sleep 1")).toHaveLength(TIMEOUT_S);
    expect(r.calls.at(-1)).toStartWith("die ");
    expect(r.calls.at(-2)).toStartWith("runuser ");
  });
});
