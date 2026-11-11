// deploy/install.sh apt limits: a stalled package mirror ends with a reason.
//
// On 2026-11-10 most addresses of archive.ubuntu.com and security.ubuntu.com
// sent nothing and the rest about 15 KB/s. apt then retries each file for
// minutes, prints only Ign:/Err: lines, and `apt-get update` exits 0 with old
// lists, so the installer went on without a word about the host it waited on.
//
// What these cases hold the installer to:
//   - every apt call carries apt's per-host timeout, set explicitly;
//   - every apt call that downloads has an overall limit, and the limit stops
//     apt and its children;
//   - the limit never covers dpkg: an install downloads first (limited) and
//     then installs from the cache (unlimited), so a stop cannot leave
//     "dpkg was interrupted";
//   - after a failure or a stop, one installer line names each host apt
//     could not download from, and no host that answered.
//
// The installer's definitions are sourced without its main (as in
// install-deps-skip.test.ts); apt-get, lslocks and mktemp are stand-ins on
// PATH, timeout is the real one. Nothing is installed. Zero LLM.

import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;
const OOM_SH = new URL("./oom-protect.sh", import.meta.url).pathname;
const SOURCE = readFileSync(INSTALL_SH, "utf8");
const DEFINITIONS = SOURCE.slice(0, SOURCE.lastIndexOf('\nmain "$@"'));
const HOST_TIMEOUT =
  SOURCE.match(/^APT_HOST_TIMEOUT_SECONDS=(\d+)$/m)?.[1] ?? "";
const INSTALLER_LINE = "[isomux-install] ";
// A process this file starts and must not outlive the limit: its command line
// carries this marker.
const MARKER = "600.4242";

// The real-apt case needs apt-get and dpkg-deb (any Debian or Ubuntu host).
const REAL_APT =
  existsSync("/usr/bin/apt-get") && existsSync("/usr/bin/dpkg-deb");

// The limit cases wait out a 1 s limit and a 1 s grace on purpose.
setDefaultTimeout(20_000);

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

interface Case {
  // Body of the apt-get stand-in. It runs after the call is recorded; $FIX is
  // the fixture directory.
  apt: string;
  // Shell run with the installer's definitions in scope.
  body: string;
  maxSeconds?: number;
  lockBusy?: boolean;
  dryRun?: boolean;
}

function runCase(c: Case) {
  const fix = mkdtempSync(join(tmpdir(), "isomux-apt-limits-"));
  fixtures.push(fix);
  const bin = join(fix, "bin");
  const tmp = join(fix, "tmp");
  mkdirSync(bin);
  mkdirSync(tmp);
  writeFileSync(join(fix, "calls"), "");
  writeFileSync(join(fix, "temps"), "");
  writeFileSync(join(fix, "pids"), "");
  stub(bin, "apt-get", `printf '%s\\n' "$*" >> "$FIX/calls"\n${c.apt}`);
  stub(
    bin,
    "lslocks",
    c.lockBusy ? "echo /var/lib/dpkg/lock-frontend" : "exit 0",
  );
  // The real mktemp, with every path it hands out recorded, so a case can
  // check that each one is gone afterwards.
  stub(
    bin,
    "mktemp",
    `p=$(/usr/bin/mktemp "$@") || exit
printf '%s\\n' "$p" >> "$FIX/temps"
printf '%s\\n' "$p"`,
  );
  const script = `${DEFINITIONS}
trap - ERR
# Only the temp files of the case itself: sourcing makes one of its own.
: > "$FIX/temps"
DRY_RUN="${c.dryRun ? "1" : ""}"
CONFFILE_ROOT="$FIX/etc"
APT_LOCK_TIMEOUT_SECONDS=0
APT_MAX_SECONDS=${c.maxSeconds ?? 60}
APT_KILL_GRACE_SECONDS=1
${c.body}
`;
  // A file, not -c: the installer is larger than one argument may be.
  writeFileSync(join(fix, "run.sh"), script);
  // A monotonic clock: the wall clock can step back during a case (task
  // 37728939: an NTP step gave 2.983 s for a 3 s sleep).
  const started = performance.now();
  const res = spawnSync("bash", [join(fix, "run.sh")], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: fix,
      TMPDIR: tmp,
      FIX: fix,
    },
    encoding: "utf8",
    // Far above every case's own bound, so a red case fails on its assertion.
    timeout: 12_000,
    killSignal: "SIGKILL",
  });
  const seconds = (performance.now() - started) / 1000;
  const lines = (f: string) =>
    readFileSync(join(fix, f), "utf8").split("\n").filter(Boolean);
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  // The installer's own lines, from either stream.
  const installer = `${stdout}\n${stderr}`
    .split("\n")
    .filter((l) => l.startsWith(INSTALLER_LINE));
  // Stand-in processes still running: their pid is recorded and their command
  // line still carries the marker.
  const alive = lines("pids").filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(MARKER);
    } catch {
      return false;
    }
  });
  // Never leave a stand-in running after a red case.
  for (const pid of alive) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return {
    code: res.status,
    signal: res.signal,
    stdout,
    stderr,
    installer,
    calls: lines("calls"),
    leftTemps: lines("temps").filter((p) => existsSync(p)),
    alive,
    seconds,
    fix,
  };
}

// The installer lines that name a host.
function naming(r: { installer: string[] }, host: string) {
  return r.installer.filter((l) => l.includes(host));
}

// Each host appears in exactly one installer line, once, and it is the same
// line for all of them.
function expectOneLineNaming(r: { installer: string[] }, hosts: string[]) {
  const named = r.installer.filter((l) => hosts.some((h) => l.includes(h)));
  expect(named).toHaveLength(1);
  for (const h of hosts) expect(named[0].split(h).length - 1).toBe(1);
}

// An apt-get stand-in that runs until the limit stops it, and survives a
// polite stop: only the kill after the grace ends it (an ignored TERM
// survives exec). Real apt's download methods end with apt-get.
const HANG = `trap '' TERM
echo $$ >> "$FIX/pids"
exec sleep ${MARKER}`;

const UPDATE_FAILS = `cat <<'OUT'
Hit:1 http://good.example/ubuntu noble InRelease
Ign:2 http://a.example/ubuntu noble-updates InRelease
Err:2 http://a.example/ubuntu noble-updates InRelease
  Connection failed [IP: 192.0.2.1 80]
Err:3 http://a.example/ubuntu noble-backports InRelease
  Connection failed [IP: 192.0.2.1 80]
Err:4 http://b.example/ubuntu noble-security InRelease
  Could not connect to b.example:80 (192.0.2.2), connection timed out
Reading package lists...
OUT
cat >&2 <<'OUT'
W: Failed to fetch http://a.example/ubuntu/dists/noble-updates/InRelease  Connection failed [IP: 192.0.2.1 80]
W: Failed to fetch http://a.example/ubuntu/dists/noble-backports/InRelease  Connection failed [IP: 192.0.2.1 80]
W: Failed to fetch http://b.example/ubuntu/dists/noble-security/InRelease  Could not connect to b.example:80 (192.0.2.2), connection timed out
W: Some index files failed to download. They have been ignored, or old ones used instead.
OUT
exit 0`;

const has = (call: string, arg: string) => ` ${call} `.includes(` ${arg} `);

describe("install.sh apt limits: every apt call has a per-host timeout", () => {
  it("the installer sets apt's per-host timeout to a positive number", () => {
    expect(Number(HOST_TIMEOUT)).toBeGreaterThan(0);
  });

  it("the refresh and both halves of an install carry it for http and https", () => {
    const r = runCase({
      apt: "exit 0",
      body: "refresh_apt_lists\napt_install foo",
    });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(3);
    for (const call of r.calls) {
      expect(has(call, `Acquire::http::Timeout=${HOST_TIMEOUT}`)).toBe(true);
      expect(has(call, `Acquire::https::Timeout=${HOST_TIMEOUT}`)).toBe(true);
    }
  });
});

describe("install.sh apt limits: an install downloads first, then installs from the cache", () => {
  it("downloads only, then installs with the operator's config files kept", () => {
    const r = runCase({
      apt: "exit 0",
      body: 'APT_LISTS_FRESH=1\napt_install foo "$FIX/local.deb"',
    });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(2);
    const [fetch, install] = r.calls;
    for (const call of r.calls) {
      expect(has(call, "install")).toBe(true);
      expect(has(call, "foo")).toBe(true);
      expect(has(call, `${r.fix}/local.deb`)).toBe(true);
    }
    expect(has(fetch, "--download-only")).toBe(true);
    expect(has(fetch, "--no-download")).toBe(false);
    // No --no-download: with it, apt never sets a local .deb's path and the
    // install fails (the install smoke, 2026-11-10).
    expect(has(install, "--no-download")).toBe(false);
    expect(has(install, "--download-only")).toBe(false);
    expect(has(install, "Dpkg::Options::=--force-confold")).toBe(true);
  });

  it("the limit never stops the install from the cache", () => {
    const r = runCase({
      maxSeconds: 1,
      apt: `if [[ " $* " != *" --download-only "* ]]; then
  sleep 3
  echo done > "$FIX/installed"
fi
exit 0`,
      body: "APT_LISTS_FRESH=1\napt_install foo",
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(r.fix, "installed"))).toBe(true);
    expect(r.seconds).toBeGreaterThanOrEqual(3);
  });

  // The stand-in apt-get above cannot tell whether real apt accepts the calls.
  // This case runs the real apt-get on a scratch apt root: no sources, no
  // network, dpkg replaced by /bin/true, so nothing is installed. A local .deb
  // is how the installer installs caddy.
  it.skipIf(!REAL_APT)("real apt installs a local .deb", () => {
    const r = runCase({
      apt: `S="$FIX/apt"
/usr/bin/apt-get -o Dir::State="$S/state" -o Dir::State::status="$S/state/status" \
  -o Dir::Cache="$S/cache" -o Dir::Etc="$S/etc" -o Dir::Log="$S/log" \
  -o Debug::NoLocking=1 -o Dir::Bin::dpkg=/bin/true "$@"
rc=$?
echo $rc >> "$FIX/rcs"
exit $rc`,
      body: `S="$FIX/apt"
mkdir -p "$S/state/lists/partial" "$S/cache/archives/partial" "$S/log" \
  "$S/etc/apt.conf.d" "$S/etc/preferences.d" "$S/etc/sources.list.d" "$FIX/pkg/DEBIAN"
: > "$S/state/status"
: > "$S/etc/sources.list"
printf '%s\n' 'Package: isomux-probe' 'Version: 1.0' 'Architecture: all' \
  'Maintainer: x <x@example.com>' 'Description: probe' > "$FIX/pkg/DEBIAN/control"
dpkg-deb --build "$FIX/pkg" "$FIX/probe.deb" >/dev/null
APT_LISTS_FRESH=1
rc=0
apt_install "$FIX/probe.deb" || rc=$?
echo RC=$rc`,
    });
    // Both halves reached real apt: the download half did not stop the run.
    expect(r.calls).toHaveLength(2);
    expect(r.calls.every((c) => has(c, `${r.fix}/probe.deb`))).toBe(true);
    // apt's own errors first, so a red run says why apt refused.
    const aptErrors = r.stderr.split("\n").filter((l) => l.startsWith("E: "));
    expect(aptErrors).toEqual([]);
    const rcs = readFileSync(join(r.fix, "rcs"), "utf8");
    expect(rcs.split("\n").filter(Boolean)).toEqual(["0", "0"]);
    expect(r.stdout).toContain("RC=0");
  });

  it("does not install when the download fails, and names the host", () => {
    const r = runCase({
      apt: `echo "Get:1 http://good.example/ubuntu noble/main amd64 bar 1.0 [10 kB]"
echo "Err:2 http://mirror.example/ubuntu noble/main amd64 foo 1.0"
echo "  404  Not Found [IP: 192.0.2.3 80]"
echo "E: Failed to fetch http://mirror.example/ubuntu/pool/main/f/foo/foo_1.0_amd64.deb  404  Not Found [IP: 192.0.2.3 80]" >&2
exit 100`,
      body: "APT_LISTS_FRESH=1\nrc=0\napt_install foo || rc=$?\necho RC=$rc",
    });
    expect(r.stdout).toContain("RC=100");
    expect(r.calls).toHaveLength(1);
    expect(has(r.calls[0], "--download-only")).toBe(true);
    expectOneLineNaming(r, ["mirror.example"]);
    expect(naming(r, "good.example")).toEqual([]);
  });

  it("names the host before a failed install stops a run under set -e", () => {
    // install_packages calls apt_install bare: errexit is live inside it.
    const r = runCase({
      apt: `echo "E: Failed to fetch http://mirror.example/ubuntu/pool/main/f/foo/foo_1.0_amd64.deb  404  Not Found" >&2
exit 100`,
      body: "APT_LISTS_FRESH=1\napt_install foo\necho REACHED",
    });
    expect(r.code).toBe(100);
    expect(r.stdout).not.toContain("REACHED");
    expectOneLineNaming(r, ["mirror.example"]);
    expect(r.leftTemps).toEqual([]);
  });
});

describe("install.sh apt limits: a refresh that could not reach a host says which", () => {
  it("goes on, keeps apt's own lines on their streams, and names each failed host once", () => {
    const r = runCase({
      apt: UPDATE_FAILS,
      body: "refresh_apt_lists\necho REACHED fresh=$APT_LISTS_FRESH",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("REACHED fresh=1");
    // The operator still sees what apt printed, where apt printed it.
    expect(r.stdout).toContain("Err:4 http://b.example/ubuntu");
    expect(r.stderr).toContain("W: Failed to fetch http://b.example/");
    expect(r.stdout).not.toContain("W: Failed to fetch");
    expectOneLineNaming(r, ["a.example", "b.example"]);
    expect(naming(r, "good.example")).toEqual([]);
    expect(r.leftTemps).toEqual([]);
  });

  // A signature error is an Err: line with no "Failed to fetch": the download
  // worked, so blaming the network or the mirror would send the operator the
  // wrong way (for example after a repository rotates its key).
  it("names no host for a repository whose signature apt cannot check", () => {
    const r = runCase({
      apt: `cat <<'OUT'
Hit:1 http://good.example/ubuntu noble InRelease
Get:2 https://keys.example/packages stable InRelease [3917 B]
Err:2 https://keys.example/packages stable InRelease
  The following signatures couldn't be verified because the public key is not available: NO_PUBKEY 23F3D4EA75716059
Reading package lists...
OUT
cat >&2 <<'OUT'
W: GPG error: https://keys.example/packages stable InRelease: The following signatures couldn't be verified because the public key is not available: NO_PUBKEY 23F3D4EA75716059
E: The repository 'https://keys.example/packages stable InRelease' is not signed.
OUT
exit 100`,
      body: "rc=0\nrefresh_apt_lists || rc=$?\necho RC=$rc",
    });
    expect(r.stdout).toContain("RC=100");
    // apt's own lines still say what happened.
    expect(r.stderr).toContain("NO_PUBKEY");
    expect(naming(r, "keys.example")).toEqual([]);
    expect(naming(r, "good.example")).toEqual([]);
  });

  it("says nothing about hosts when every host answered", () => {
    const r = runCase({
      apt: `echo "Hit:1 http://good.example/ubuntu noble InRelease"
echo "Get:2 http://good.example/ubuntu noble-updates InRelease [126 kB]"
echo "Reading package lists..."
exit 0`,
      body: "refresh_apt_lists",
    });
    expect(r.code).toBe(0);
    expect(naming(r, "good.example")).toEqual([]);
    expect(r.leftTemps).toEqual([]);
  });

  it("keeps the lock-busy path: status 100 and no apt call", () => {
    const r = runCase({
      lockBusy: true,
      apt: "exit 0",
      body: "rc=0\nrefresh_apt_lists || rc=$?\necho RC=$rc",
    });
    expect(r.stdout).toContain("RC=100");
    expect(r.calls).toEqual([]);
  });

  it("a dry run calls no apt", () => {
    const r = runCase({
      dryRun: true,
      apt: "exit 0",
      body: "refresh_apt_lists\napt_install foo",
    });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
  });
});

describe("install.sh apt limits: the overall limit stops a download that never ends", () => {
  it("stops an install's download and names the hosts it waited on", () => {
    const r = runCase({
      maxSeconds: 1,
      // done.example: a download that started before a file apt went on
      // from (the Hit: after it), so apt was no longer waiting on it.
      apt: `cat <<'OUT'
Get:1 http://done.example/ubuntu noble InRelease [126 kB]
Hit:1 http://good.example/ubuntu noble InRelease
Get:2 /tmp/somewhere/probe.deb probe 1.0 [1 kB]
Get:3 http://slow.example/ubuntu noble/universe amd64 ffmpeg 7.0 [1800 kB]
Ign:4 http://silent.example/ubuntu noble/main amd64 tmux 3.4
OUT
${HANG}`,
      body: 'APT_LISTS_FRESH=1\nrc=0\napt_install foo "$FIX/probe.deb" || rc=$?\necho RC=$rc',
    });
    // Limit 1 s, grace 1 s; far below the stand-in's own end. First, so a
    // run with no limit reads as one.
    expect(r.seconds).toBeLessThan(10);
    const rc = Number(r.stdout.match(/RC=(\d+)/)?.[1]);
    expect([124, 137]).toContain(rc);
    expect(r.alive).toEqual([]);
    // The stand-in really ran.
    expect(
      readFileSync(join(r.fix, "pids"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
    // Nothing is installed after a stopped download.
    expect(r.calls).toHaveLength(1);
    expectOneLineNaming(r, ["slow.example", "silent.example"]);
    expect(naming(r, "good.example")).toEqual([]);
    expect(naming(r, "done.example")).toEqual([]);
    expect(naming(r, "probe.deb")).toEqual([]);
    expect(r.leftTemps).toEqual([]);
  });

  it("names the hosts of the sources in use when apt printed nothing before the stop", () => {
    const r = runCase({
      maxSeconds: 1,
      apt: `if [[ " $* " == *" indextargets "* ]]; then
  printf '%s\\n' http://cli.example/packages http://cli.example/packages
  exit 0
fi
${HANG}`,
      body: `rc=0
apt_fetch update -y -o "Dir::Etc::sourcelist=$FIX/gh.list" -o Dir::Etc::sourceparts=/dev/null -o APT::Get::List-Cleanup=0 || rc=$?
echo RC=$rc`,
    });
    expect(r.seconds).toBeLessThan(10);
    const rc = Number(r.stdout.match(/RC=(\d+)/)?.[1]);
    expect([124, 137]).toContain(rc);
    expect(r.alive).toEqual([]);
    // The lookup asks about the same sources as the call that was stopped.
    const lookup = r.calls.filter((c) => has(c, "indextargets"));
    expect(lookup).toHaveLength(1);
    expect(has(lookup[0], `Dir::Etc::sourcelist=${r.fix}/gh.list`)).toBe(true);
    expect(has(lookup[0], "Dir::Etc::sourceparts=/dev/null")).toBe(true);
    expectOneLineNaming(r, ["cli.example"]);
    expect(r.leftTemps).toEqual([]);
  });
});

// Ctrl-C at the terminal sends SIGINT to the terminal's foreground process
// group. An operator who sees a stalled mirror must still be able to stop the
// installer: a limit that moves apt into a process group of its own keeps the
// signal from apt, and the installer then waits for apt to end on its own.
describe("install.sh apt limits: Ctrl-C still stops a download", () => {
  it("ends the run at once when the foreground group gets SIGINT", async () => {
    const fix = mkdtempSync(join(tmpdir(), "isomux-apt-limits-int-"));
    fixtures.push(fix);
    const bin = join(fix, "bin");
    mkdirSync(bin);
    writeFileSync(join(fix, "pids"), "");
    stub(bin, "apt-get", `echo $$ >> "$FIX/pids"\nexec sleep ${MARKER}`);
    stub(bin, "lslocks", "exit 0");
    writeFileSync(
      join(fix, "run.sh"),
      `${DEFINITIONS}
trap - ERR
DRY_RUN=""
APT_LOCK_TIMEOUT_SECONDS=0
APT_MAX_SECONDS=60
APT_KILL_GRACE_SECONDS=1
refresh_apt_lists
`,
    );
    // detached: the run leads a process group of its own, like a job at a
    // terminal, so the whole group can be signalled.
    const child = spawn("bash", [join(fix, "run.sh")], {
      detached: true,
      stdio: "ignore",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: fix, FIX: fix },
    });
    const exited = new Promise<boolean>((resolve) =>
      child.on("exit", () => resolve(true)),
    );
    const pids = () =>
      readFileSync(join(fix, "pids"), "utf8").split("\n").filter(Boolean);
    const ready = performance.now() + 5_000;
    while (pids().length === 0 && performance.now() < ready)
      await Bun.sleep(50);
    // The condition the case needs: apt is running when the signal comes.
    expect(pids()).toHaveLength(1);
    const started = performance.now();
    process.kill(-child.pid!, "SIGINT");
    const ended = await Promise.race([
      exited,
      Bun.sleep(8_000).then(() => false),
    ]);
    const seconds = (performance.now() - started) / 1000;
    const alive = pids().filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(MARKER);
      } catch {
        return false;
      }
    });
    // Never leave the run or a stand-in behind after a red case.
    for (const target of [-child.pid!, ...alive.map(Number)]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    expect(ended).toBe(true);
    expect(seconds).toBeLessThan(5);
    expect(alive).toEqual([]);
  });
});

// isomux-oom-protect installs earlyoom with its own apt-get call, in its own
// script and in the copy install.sh carries.
describe("oom-protect: the earlyoom install has the same limits", () => {
  function runEarlyoom(source: string, apt: string) {
    const fix = mkdtempSync(join(tmpdir(), "isomux-apt-limits-oom-"));
    fixtures.push(fix);
    const bin = join(fix, "bin");
    mkdirSync(bin);
    writeFileSync(join(fix, "calls"), "");
    writeFileSync(join(fix, "pids"), "");
    stub(bin, "apt-get", `printf 'apt-get %s\\n' "$*" >> "$FIX/calls"\n${apt}`);
    // The real timeout, recorded, with its limit cut to 1 s so a stall ends
    // inside the test.
    stub(
      bin,
      "timeout",
      `printf 'timeout %s\\n' "$*" >> "$FIX/calls"
opts=()
while [[ $1 == -* ]]; do opts+=("$1"); shift; done
shift
exec /usr/bin/timeout "\${opts[@]}" 1 "$@"`,
    );
    const text = readFileSync(source, "utf8");
    const fn = text.match(/^install_earlyoom\(\) \{[\s\S]*?^\}$/m)?.[0] ?? "";
    expect(fn).toContain("command -v earlyoom");
    const script = `
set -Eeuo pipefail
DRY_RUN=""
log() { echo "LOG: $*"; }
warn() { log "warning: $*"; }
wait_for_package_manager() { :; }
APT_LOCK_TIMEOUT_SECONDS=120
${fn.replace("command -v earlyoom", "command -v earlyoom-not-on-this-box")}
rc=0
install_earlyoom || rc=$?
echo RC=$rc
`;
    const started = performance.now();
    const res = spawnSync("bash", ["-c", script], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: fix, FIX: fix },
      encoding: "utf8",
      timeout: 12_000,
      killSignal: "SIGKILL",
    });
    // Never leave a stand-in running after a red case.
    for (const pid of readFileSync(join(fix, "pids"), "utf8").split("\n")) {
      try {
        if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(MARKER))
          process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    return {
      stdout: res.stdout ?? "",
      calls: readFileSync(join(fix, "calls"), "utf8")
        .split("\n")
        .filter(Boolean),
      seconds: (performance.now() - started) / 1000,
    };
  }

  // install.sh carries oom-protect.sh in a heredoc: check both copies.
  for (const [label, source] of [
    ["oom-protect.sh", OOM_SH],
    ["install.sh's copy", INSTALL_SH],
  ] as const) {
    it(`${label}: downloads under a limit, then installs without one`, () => {
      const r = runEarlyoom(source, "exit 0");
      expect(r.stdout).toContain("RC=0");
      const apt = r.calls.filter((c) => c.startsWith("apt-get "));
      expect(apt).toHaveLength(2);
      for (const call of apt) {
        expect(call).toMatch(/ Acquire::http::Timeout=\d+( |$)/);
        expect(call).toMatch(/ Acquire::https::Timeout=\d+( |$)/);
      }
      expect(has(apt[0], "--download-only")).toBe(true);
      expect(has(apt[1], "--download-only")).toBe(false);
      expect(has(apt[1], "Dpkg::Options::=--force-confold")).toBe(true);
      // Exactly one limit, and it wraps the download.
      const limits = r.calls.filter((c) => c.startsWith("timeout "));
      expect(limits).toHaveLength(1);
      expect(limits[0]).toContain("apt-get ");
      expect(limits[0]).toContain("--download-only");
      // Each limit line comes right before the apt call it wraps.
      expect(r.calls.indexOf(limits[0]) + 1).toBe(r.calls.indexOf(apt[0]));
    });

    it(`${label}: a download that never ends is stopped and nothing is installed`, () => {
      const r = runEarlyoom(
        source,
        `[[ " $* " == *" --download-only "* ]] || exit 0
echo $$ >> "$FIX/pids"
exec sleep ${MARKER}`,
      );
      expect(r.seconds).toBeLessThan(10);
      expect(r.stdout).toMatch(/RC=[1-9]/);
      const apt = r.calls.filter((c) => c.startsWith("apt-get "));
      expect(apt).toHaveLength(1);
      expect(has(apt[0], "--download-only")).toBe(true);
    });
  }
});
