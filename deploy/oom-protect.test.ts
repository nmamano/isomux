// deploy/oom-protect.sh - the kill-order logic, exercised against a fake /proc.
//
// This task (c5b4e89e) exists because the original verification trusted
// `systemctl show`, which reports the value that was ASKED for. The kernel held
// something else for a week and nobody noticed. So the behaviour that has to be
// pinned here is not "the tool writes a number" but "the tool reads the number
// back and says so when it did not take" - a later refactor that quietly drops
// the readback would recreate the July bug exactly.
//
// Real pids cannot be used: the interesting cases are a refused write and a pid
// that gets recycled mid-stamp, neither of which is reproducible on demand
// against a live /proc. The script therefore reads and writes through a
// PROC_ROOT variable, and these tests point it at a directory tree they build.
// `main "$@"` is stripped from the copy under test so the functions can be
// sourced; a separate test pins that the real script still calls it.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  chmodSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = new URL("./oom-protect.sh", import.meta.url).pathname;
const SRC = readFileSync(SCRIPT, "utf8");

let dir = "";
let testable = "";
let mainable = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "oom-protect-test-"));
  testable = join(dir, "sourceable.sh");
  // Everything except the entry point call, so sourcing runs no side effects.
  const body = SRC.replace(/\nmain "\$@"\n$/, "\n");
  expect(body).not.toBe(SRC);
  writeFileSync(testable, body);
  // A second copy that CAN be run as an unprivileged user: the root guard
  // removed, and the /proc seam taken from the environment. The exit status of
  // `--restamp` is what the timer's unit reports to systemd, so it has to be
  // exercised through main itself and not through the function underneath.
  // (`deploy/harden-ssh.test.ts` strips that script's root guard the same way;
  // the guard is pinned separately below so stripping it cannot hide a
  // removal.)
  mainable = join(dir, "mainable.sh");
  const unguarded = SRC.replace(
    /^ {2}\[\[ \$EUID -eq 0 \]\] \|\| \{\n[^}]*\}\n/m,
    "",
  ).replace("\nPROC_ROOT=/proc\n", "\nPROC_ROOT=${PROC_ROOT:-/proc}\n");
  expect(unguarded).not.toContain("EUID");
  expect(unguarded).toContain("PROC_ROOT:-/proc");
  writeFileSync(mainable, unguarded);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake /proc holding one process: a start time, a score, and a cgroup. */
function fakeProc(
  procRoot: string,
  pid: number,
  opts: {
    starttime?: number;
    score?: string;
    comm?: string;
    cgroup?: string;
    ppid?: number;
    readOnlyScore?: boolean;
  } = {},
): string {
  const d = join(procRoot, String(pid));
  mkdirSync(d, { recursive: true });
  const comm = opts.comm ?? "bun";
  // Laid out as the kernel does: field 1 the pid, field 2 the name in parens,
  // field 3 the state, then filler up to the start time at field 22. Tests pass
  // names containing spaces and parens, which is what breaks naive splitting.
  const pad = Array(18).fill("0").join(" ");
  writeFileSync(
    join(d, "stat"),
    `${pid} (${comm}) S ${pad} ${opts.starttime ?? 12345} 0 0\n`,
  );
  const score = join(d, "oom_score_adj");
  writeFileSync(score, `${opts.score ?? "0"}\n`);
  if (opts.readOnlyScore) chmodSync(score, 0o444);
  writeFileSync(join(d, "cgroup"), `${opts.cgroup ?? "0::/init.scope"}\n`);
  writeFileSync(
    join(d, "status"),
    `Name:\t${comm}\nPPid:\t${opts.ppid ?? 1}\n`,
  );
  return d;
}

/** Source the script with PROC_ROOT pointed at `procRoot`, then run `code`. */
async function run(
  procRoot: string,
  code: string,
): Promise<{ out: string; exit: number }> {
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      // `set +e` AFTER sourcing: the script sets `-e` itself, and every case
      // here deliberately provokes a non-zero return we then want to inspect.
      `source ${testable}; set +e; PROC_ROOT=${procRoot}; DRY_RUN=""; ${code}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { out: out + err, exit: await proc.exited };
}

describe("stamp_pid: the readback that this task exists for", () => {
  it("confirms a value it can actually verify in the kernel", async () => {
    const root = mkdtempSync(join(dir, "proc-ok-"));
    fakeProc(root, 42, { score: "0" });
    const { out } = await run(
      root,
      `stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).toContain("confirmed");
    expect(out).toContain("oom_score_adj=-500");
    expect(out).toContain("rc=0");
    expect(readFileSync(join(root, "42", "oom_score_adj"), "utf8").trim()).toBe(
      "-500",
    );
  });

  it("reports the REAL value, loudly, when the write is refused", async () => {
    // The July failure in miniature: the ask is -500, the kernel keeps 100, and
    // the tool must say so rather than report the value it wanted.
    const root = mkdtempSync(join(dir, "proc-refused-"));
    fakeProc(root, 42, { score: "100", readOnlyScore: true });
    const { out } = await run(
      root,
      `stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).toContain("kill order NOT applied");
    expect(out).toContain("asked for -500");
    expect(out).toContain("the kernel reports 100");
    expect(out).toContain("rc=1");
    expect(out).not.toContain("confirmed");
  });

  it("does not claim success when the pid was recycled mid-stamp", async () => {
    // The identity check has to bracket the READBACK, not just the write: a
    // stranger that happens to hold the requested value would otherwise be
    // reported as a confirmed success. Start times differ, so it must not be.
    const root = mkdtempSync(join(dir, "proc-recycled-"));
    fakeProc(root, 42, { score: "0" });
    // A marker file, not a shell variable: stamp_pid calls this inside a
    // command substitution, so a counter kept in a variable would be lost with
    // the subshell and both reads would return the same value.
    const { out } = await run(
      root,
      `proc_starttime() {
         if [[ -e ${root}/seen ]]; then echo 999; else touch ${root}/seen; echo 111; fi
       }
       stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).toContain("exited mid-write");
    expect(out).toContain("rc=1");
    expect(out).not.toContain("confirmed");
  });

  it("authenticates the READBACK, not just the write", async () => {
    // Pins the ordering, which the case above cannot: there, the two start
    // times differ, so any ordering warns. The real hole was narrower - a
    // process that exits AFTER the identity check and before the value is read.
    // Both start times then come from the original while the value comes from
    // whatever inherited the pid, and a stranger holding the asked-for value by
    // coincidence reads as a confirmed success.
    //
    // Simulated by a stub that keeps the identity stable but rewrites the score
    // to the requested value on its second call, standing in for the stranger.
    // The write itself is refused, so the only way -500 can appear is from the
    // impostor. Read the value before the second identity check and this
    // reports success against the wrong process; read it after and it does not.
    const root = mkdtempSync(join(dir, "proc-impostor-"));
    fakeProc(root, 42, { score: "100", readOnlyScore: true });
    const score = join(root, "42", "oom_score_adj");
    const { out } = await run(
      root,
      `proc_starttime() {
         if [[ -e ${root}/seen ]]; then chmod 644 ${score}; echo -500 > ${score}
         else touch ${root}/seen; fi
         echo 111
       }
       stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).not.toContain("confirmed");
    expect(out).toContain("kill order NOT applied");
    expect(out).toContain("the kernel reports 100");
    expect(out).toContain("rc=1");
  });

  it("treats a vanished process as unconfirmed, not as success", async () => {
    const root = mkdtempSync(join(dir, "proc-gone-"));
    fakeProc(root, 42, { score: "0" });
    const { out } = await run(
      root,
      `proc_starttime() { echo ""; }
       stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).toContain("exited mid-write");
    expect(out).toContain("rc=1");
  });

  it("is a silent no-op for a pid that is not there at all", async () => {
    const root = mkdtempSync(join(dir, "proc-empty-"));
    mkdirSync(root, { recursive: true });
    const { out } = await run(root, `stamp_pid 999 -500 "gone"; echo "rc=$?"`);
    expect(out).toContain("rc=1");
    expect(out).not.toContain("warning");
    expect(out).not.toContain("confirmed");
  });

  it("changes nothing under --dry-run", async () => {
    const root = mkdtempSync(join(dir, "proc-dry-"));
    fakeProc(root, 42, { score: "7" });
    const { out } = await run(
      root,
      `DRY_RUN=1; stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).toContain("DRY-RUN");
    expect(out).toContain("rc=0");
    expect(readFileSync(join(root, "42", "oom_score_adj"), "utf8").trim()).toBe(
      "7",
    );
  });

  it("reads the start time past a process name containing spaces", async () => {
    const root = mkdtempSync(join(dir, "proc-spacey-"));
    fakeProc(root, 42, { comm: "we ird (name", starttime: 8675309 });
    const { out } = await run(root, `proc_starttime 42`);
    expect(out.trim()).toBe("8675309");
  });
});

describe("find_user_isomux_pid: the server, not the agents beside it", () => {
  const USER_CG =
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice/isomux.service";

  it("picks the service root over its own descendants", async () => {
    // The office and everything it spawns share one cgroup. Stamping an agent
    // instead of the server would protect exactly the wrong process, so the
    // one whose parent sits outside the cgroup is the one that counts.
    const root = mkdtempSync(join(dir, "proc-user-"));
    fakeProc(root, 500, { cgroup: USER_CG, ppid: 1 });
    fakeProc(root, 501, { cgroup: USER_CG, ppid: 500, comm: "claude" });
    fakeProc(root, 502, { cgroup: USER_CG, ppid: 501, comm: "bun" });
    const { out } = await run(root, `find_user_isomux_pid`);
    expect(out.trim()).toBe("500");
  });

  it("finds nothing on a box with no user-level office", async () => {
    const root = mkdtempSync(join(dir, "proc-system-"));
    fakeProc(root, 600, { cgroup: "0::/system.slice/isomux.service" });
    const { out, exit } = await run(root, `find_user_isomux_pid`);
    expect(out.trim()).toBe("");
    expect(exit).not.toBe(0);
  });

  it("leaves the user-level branch a no-op when there is no match", async () => {
    const root = mkdtempSync(join(dir, "proc-none-"));
    fakeProc(root, 600, { cgroup: "0::/system.slice/isomux.service" });
    const { out } = await run(
      root,
      `configure_user_level_office; echo "rc=$?"`,
    );
    expect(out).not.toContain("found a user-level office");
    expect(out).toContain("rc=0");
  });

  it("stamps and confirms a user-level office when there is one", async () => {
    const root = mkdtempSync(join(dir, "proc-user2-"));
    fakeProc(root, 500, { cgroup: USER_CG, ppid: 1, score: "100" });
    const { out } = await run(root, `configure_user_level_office`);
    expect(out).toContain("found a user-level office (pid 500)");
    expect(out).toContain("oom_score_adj=-500 confirmed");
    // The old advice was "re-run this tool after restarts". A timer does it now
    // (task b584901d), and telling an operator to do it by hand again would be
    // both wrong and, per Nil, not an acceptable answer in the first place.
    expect(out).not.toContain("re-run this tool");
  });
});

describe("--restamp: what the timer runs every minute", () => {
  const USER_CG =
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice/isomux.service";

  it("says nothing at all when the office already has the right score", async () => {
    // The whole point of the mode. This fires once a minute forever, so a line
    // per run would be ~3000 journal entries a day saying nothing happened.
    const root = mkdtempSync(join(dir, "proc-restamp-quiet-"));
    fakeProc(root, 500, { cgroup: USER_CG, ppid: 1, score: "-500" });
    const { out } = await run(
      root,
      `RESTAMP=1; configure_user_level_office; echo "rc=$?"`,
    );
    expect(out).not.toContain("found a user-level office");
    expect(out).not.toContain("confirmed");
    expect(out).toContain("rc=0");
  });

  it("re-applies the score, and speaks up, after the office restarted", async () => {
    // A restarted office comes back at whatever its user manager gives it (100
    // on Ubuntu), because the stamp was written to a process, not to a config.
    const root = mkdtempSync(join(dir, "proc-restamp-"));
    fakeProc(root, 500, { cgroup: USER_CG, ppid: 1, score: "100" });
    const { out } = await run(root, `RESTAMP=1; configure_user_level_office`);
    expect(out).toContain("found a user-level office (pid 500)");
    expect(out).toContain("oom_score_adj=-500 confirmed");
    expect(
      readFileSync(join(root, "500", "oom_score_adj"), "utf8").trim(),
    ).toBe("-500");
  });

  /** Drive the real `main --restamp`, exactly as the timer's unit does. */
  async function runRestamp(
    procRoot: string,
  ): Promise<{ out: string; exit: number }> {
    const proc = Bun.spawn(["bash", mainable, "--restamp"], {
      env: { ...process.env, PROC_ROOT: procRoot },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { out: out + err, exit: await proc.exited };
  }

  it("fails the run when the stamp could not be verified", async () => {
    // systemd is the only thing watching this. Exiting 0 on a refused write
    // would write a minute-by-minute history of success for protection that is
    // not there - the same lie about a written-but-ineffective value that
    // started all of this (task c5b4e89e).
    const root = mkdtempSync(join(dir, "proc-restamp-refused-"));
    fakeProc(root, 500, {
      cgroup: USER_CG,
      ppid: 1,
      score: "100",
      readOnlyScore: true,
    });
    const { out, exit } = await runRestamp(root);
    expect(out).toContain("kill order NOT applied");
    expect(exit).toBe(1);
  });

  it("succeeds, through main, when it really did re-apply the score", async () => {
    const root = mkdtempSync(join(dir, "proc-restamp-main-"));
    fakeProc(root, 500, { cgroup: USER_CG, ppid: 1, score: "100" });
    const { out, exit } = await runRestamp(root);
    expect(out).toContain("oom_score_adj=-500 confirmed");
    expect(exit).toBe(0);
  });

  it("succeeds silently, through main, when there is nothing to do", async () => {
    const root = mkdtempSync(join(dir, "proc-restamp-main-quiet-"));
    fakeProc(root, 500, { cgroup: USER_CG, ppid: 1, score: "-500" });
    const { out, exit } = await runRestamp(root);
    expect(out.trim()).toBe("");
    expect(exit).toBe(0);
  });

  it("leaves a full run best-effort when a stamp is refused", async () => {
    // The opposite call from the timer's: an interactive run has earlyoom, the
    // tiers, swappiness and swap still to do, and aborting over one refused
    // write would cost the operator all of it. The warning is the signal there.
    const root = mkdtempSync(join(dir, "proc-full-refused-"));
    fakeProc(root, 500, {
      cgroup: USER_CG,
      ppid: 1,
      score: "100",
      readOnlyScore: true,
    });
    const { out } = await run(
      root,
      `configure_user_level_office; echo "rc=$?"`,
    );
    expect(out).toContain("kill order NOT applied");
    expect(out).toContain("rc=0");
  });

  it("stays quiet on a box with no user-level office at all", async () => {
    // Every hosted box: the office is a system unit and carries -500 from its
    // unit file. The timer is installed there anyway and must cost nothing.
    const root = mkdtempSync(join(dir, "proc-restamp-none-"));
    fakeProc(root, 600, { cgroup: "0::/system.slice/isomux.service" });
    const { out } = await run(
      root,
      `RESTAMP=1; configure_user_level_office; echo "rc=$?"`,
    );
    expect(out).not.toContain("found a user-level office");
    expect(out).toContain("rc=0");
  });
});

describe("the re-stamp timer", () => {
  it("installs units that run THIS copy of the tool, once a minute", async () => {
    const root = mkdtempSync(join(dir, "proc-timer-"));
    const { out } = await run(root, `DRY_RUN=1; install_restamp_timer`);
    // A box set up before --restamp existed has an older copy at the canonical
    // path, and the unit points there. Refreshing it is not optional: the old
    // copy would answer --restamp with a usage error every single minute.
    expect(out).toContain("install -D -m 755");
    expect(out).toContain("/usr/local/sbin/isomux-oom-protect");
    expect(out).toContain(
      "ExecStart=/usr/local/sbin/isomux-oom-protect --restamp",
    );
    expect(out).toContain("OnUnitActiveSec=1min");
    expect(out).toContain("OnBootSec=1min");
    expect(out).toContain("systemctl enable --now isomux-oom-restamp.timer");
  });

  it("swaps the copy in by rename, never writing it in place", async () => {
    // The timer may be starting a run from that exact path right now, and
    // truncating the file underneath it would hand the shell half a script.
    const root = mkdtempSync(join(dir, "proc-timer-atomic-"));
    const { out } = await run(root, `DRY_RUN=1; install_restamp_timer`);
    const staged = out.match(
      /install -D -m 755 \S+ (\/usr\/local\/sbin\/isomux-oom-protect\.new\.\d+)/,
    );
    expect(staged).not.toBeNull();
    // Staged first, then renamed onto the real name, in that order.
    const stagedPath = staged?.[1] as string;
    expect(out).toContain(
      `mv -f ${stagedPath} /usr/local/sbin/isomux-oom-protect`,
    );
    expect(out.indexOf("install -D -m 755")).toBeLessThan(
      out.indexOf("mv -f "),
    );
  });

  it("does not copy the tool over itself when it IS the installed copy", async () => {
    // The hosted path: deploy/install.sh writes the tool to the canonical path
    // and runs it from there, so there is nothing to refresh.
    const root = mkdtempSync(join(dir, "proc-timer-self-"));
    const { out } = await run(
      root,
      `DRY_RUN=1; OOM_TOOL_PATH=${testable}; install_restamp_timer`,
    );
    expect(out).not.toContain("install -D -m 755");
    expect(out).not.toContain("mv -f");
    expect(out).toContain(`ExecStart=${testable} --restamp`);
  });

  it("keeps the journal quiet without hiding a failure", async () => {
    // A oneshot on a one-minute timer costs a Starting/Finished pair per run
    // unless PID 1's own messages about it are filtered too. LogLevelMax does
    // that; SyslogLevel is what keeps the tool's output from falling below the
    // same ceiling and disappearing with them.
    const root = mkdtempSync(join(dir, "proc-timer2-"));
    const { out } = await run(root, `DRY_RUN=1; install_restamp_timer`);
    expect(out).toContain("LogLevelMax=notice");
    expect(out).toContain("SyslogLevel=notice");
  });
});

describe("the kill-order tiers", () => {
  /**
   * configure_kill_order with everything that touches the box stubbed out, so
   * the tier table itself can be read off its output: which unit got a drop-in,
   * and what score went into it.
   */
  async function tiers(): Promise<string> {
    const root = mkdtempSync(join(dir, "proc-tiers-"));
    const { out } = await run(
      root,
      [
        // write_file's stdin is the drop-in body; label each line with its
        // destination so unit and score can be asserted together.
        `write_file() { local p=$1; sed "s|^|${"$"}{p}: |"; }`,
        `systemctl() { echo 0; }`,
        `run() { :; }`,
        `configure_user_level_office() { :; }`,
        `install_restamp_timer() { :; }`,
        `configure_kill_order`,
      ].join("; "),
    );
    return out;
  }

  it("keeps the box reachable: ssh and tailscaled last of all", async () => {
    const out = await tiers();
    expect(out).toContain(
      "/etc/systemd/system/ssh.service.d/isomux-oom.conf: OOMScoreAdjust=-900",
    );
    expect(out).toContain(
      "/etc/systemd/system/tailscaled.service.d/isomux-oom.conf: OOMScoreAdjust=-900",
    );
  });

  // Task 193b8d38. During the capacity benchmark earlyoom killed systemd-resolved
  // off a box under memory pressure and it never came back; the box answered ssh
  // and every liveness probe for three hours while nothing on it could resolve a
  // hostname. earlyoom's --avoid did not save it, and cannot: it is a 300-point
  // bias, and every small daemon on a box sits at the same oom_score of 666, so
  // the ordering among them is arbitrary. A negative score is what moves them
  // off the list, and it applies to the kernel's own killer too.
  it("keeps the box usable: the daemons whose death is silent", async () => {
    const out = await tiers();
    // Ubuntu already ships dbus at -900 and journald at -250, so neither is
    // here; every unit below was measured running at 0 on a real box.
    for (const unit of [
      "systemd-resolved",
      "systemd-networkd",
      "systemd-logind",
    ]) {
      expect(out).toContain(
        `/etc/systemd/system/${unit}.service.d/isomux-oom.conf: OOMScoreAdjust=-900`,
      );
    }
  });

  // The three-hour half of the same incident. resolved was killed five times in
  // two seconds (it restarts at RestartSec=0), hit systemd's default limit of
  // five starts per ten seconds, and stayed `failed` long after the pressure
  // was gone. Protecting a daemon from being chosen while leaving it unable to
  // come back fixes the cheaper half of the outage.
  it("lets a unit it protects come back, however often it is killed", async () => {
    const out = await tiers();
    // Every unit oom_tier touches, so the invariant this test states is the one
    // it pins: a later change that made the guard conditional on the tier, or
    // skipped the units nobody thinks about, would otherwise pass here.
    for (const unit of [
      "ssh",
      "tailscaled",
      "systemd-resolved",
      "systemd-networkd",
      "systemd-logind",
      "caddy",
      "isomux",
    ]) {
      const file = `/etc/systemd/system/${unit}.service.d/isomux-oom.conf`;
      expect(out).toContain(`${file}: StartLimitIntervalSec=0`);
      // Retrying forever without a backoff would spin on a unit that cannot
      // start at all, which is what the rate limit used to prevent.
      expect(out).toContain(`${file}: RestartSec=5s`);
    }
  });

  it("keeps the office above the agents it starts, not below them", async () => {
    const out = await tiers();
    expect(out).toContain(
      "/etc/systemd/system/isomux.service.d/isomux-oom.conf: OOMScoreAdjust=-500",
    );
    expect(out).toContain(
      "/etc/systemd/system/caddy.service.d/isomux-oom.conf: OOMScoreAdjust=-500",
    );
  });
});

describe("office memory cap", () => {
  async function runCap(opts: {
    memMib: number;
    dryRun?: boolean;
    running?: boolean;
    mismatch?: boolean;
  }) {
    const root = mkdtempSync(join(dir, "memory-cap-"));
    const meminfo = join(root, "meminfo");
    const dropin = join(root, "20-memory.conf");
    const cgroupRoot = join(root, "cgroup");
    const cgroup = "/system.slice/isomux.service";
    const cgroupDir = join(cgroupRoot, cgroup);
    writeFileSync(meminfo, `MemTotal:       ${opts.memMib * 1024} kB\n`);
    if (opts.running) {
      mkdirSync(cgroupDir, { recursive: true });
      const maxMib = opts.memMib - 1024;
      const highMib = Math.floor((maxMib * 85) / 100);
      writeFileSync(
        join(cgroupDir, "memory.max"),
        `${opts.mismatch ? 1 : maxMib * 1024 * 1024}\n`,
      );
      writeFileSync(
        join(cgroupDir, "memory.high"),
        `${highMib * 1024 * 1024}\n`,
      );
      writeFileSync(
        join(cgroupDir, "memory.swap.max"),
        `${6144 * 1024 * 1024}\n`,
      );
    }
    const script = `
source ${testable}
MEMINFO_PATH=${meminfo}
OFFICE_MEMORY_DROPIN=${dropin}
CGROUP_ROOT=${cgroupRoot}
DRY_RUN=${opts.dryRun ? "1" : '""'}
systemctl() {
  if [[ $1 == daemon-reload ]]; then echo daemon-reload; return 0; fi
  if [[ $1 == show ]]; then ${opts.running ? `echo ${cgroup}` : "return 1"}; return 0; fi
  return 1
}
configure_office_memory_cap
`;
    const proc = Bun.spawn(["bash", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const out = stdout + stderr;
    const exit = await proc.exited;
    return {
      out,
      exit,
      dropin: existsSync(dropin) ? readFileSync(dropin, "utf8") : null,
    };
  }

  it("writes the measured entry-box values and a fixed 6 GiB swap cap", async () => {
    const r = await runCap({ memMib: 7941 });
    expect(r.exit).toBe(0);
    expect(r.dropin).toContain("MemoryMax=6917M");
    expect(r.dropin).toContain("MemoryHigh=5879M");
    expect(r.dropin).toContain("MemorySwapMax=6144M");
    expect(r.out).toContain("daemon-reload");
  });

  it("does not make a previously usable box below 4 GiB smaller", async () => {
    const r = await runCap({ memMib: 2048 });
    expect(r.exit).toBe(0);
    expect(r.dropin).toBeNull();
    expect(r.out).toContain("leaving the office uncapped");
    expect(r.out).toContain("below 4096 MiB");
  });

  it("keeps dry-run non-mutating and prints the generated unit file", async () => {
    const r = await runCap({ memMib: 7941, dryRun: true });
    expect(r.exit).toBe(0);
    expect(r.dropin).toBeNull();
    expect(r.out).toContain("would write");
    expect(r.out).toContain("MemoryMax=6917M");
    expect(r.out).toContain("MemorySwapMax=6144M");
  });

  it("reads all three effective cgroup values back", async () => {
    const ok = await runCap({ memMib: 7941, running: true });
    expect(ok.out).toContain(
      "office memory cap confirmed in the running cgroup",
    );
    const bad = await runCap({
      memMib: 7941,
      running: true,
      mismatch: true,
    });
    expect(bad.out).toContain("office memory cap NOT confirmed");
    expect(bad.out).toContain("kernel reports 1/");
  });
});

describe("swap sizing", () => {
  /**
   * A box with a given swap situation, as /proc reports it. `devices` is what
   * /proc/swaps lists; the sizes are MiB.
   */
  /**
   * Where the tool's own swapfile lives for these tests: a path that does not
   * exist, so the create branch cannot be short-circuited by whatever
   * /swapfile the machine running the tests happens to have.
   */
  const swapPath = () => join(dir, "swapfile-under-test");

  function fakeSwap(opts: {
    totalMib: number;
    usedMib?: number;
    availMib?: number;
    devices?: string[];
  }): string {
    const root = mkdtempSync(join(dir, "proc-swap-"));
    const used = opts.usedMib ?? 0;
    writeFileSync(
      join(root, "meminfo"),
      [
        `MemTotal:       ${8 * 1024 * 1024} kB`,
        `MemAvailable:   ${(opts.availMib ?? 6144) * 1024} kB`,
        `SwapTotal:      ${opts.totalMib * 1024} kB`,
        `SwapFree:       ${(opts.totalMib - used) * 1024} kB`,
        "",
      ].join("\n"),
    );
    const devices = opts.devices ?? (opts.totalMib > 0 ? [swapPath()] : []);
    writeFileSync(
      join(root, "swaps"),
      ["Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority"]
        .concat(
          devices.map((d) => `${d}\tfile\t\t${opts.totalMib * 1024}\t0\t-2`),
        )
        .join("\n") + "\n",
    );
    return root;
  }

  /**
   * configure_swap against that box, always dry: every case here is about the
   * decision, and the do-it path runs swapoff and mkswap for real. `diskMib` is
   * what the filesystem reports free, stubbed for the same reason /proc is -
   * otherwise the answers would depend on the machine running the tests.
   */
  const decide = (root: string, diskMib = 40960, extra = "") =>
    run(
      root,
      // Every command that could change this machine's swap is stubbed to
      // announce itself instead of running. That is what makes "leaves it
      // alone" testable as behaviour rather than as the absence of a word:
      // the advice text below deliberately CONTAINS "swapoff" and "mkswap",
      // so matching on the prose would prove nothing.
      `DRY_RUN=1; SWAPFILE=${swapPath()}; swap_fs_avail_mib() { echo ${diskMib}; };` +
        ` swapoff() { echo "RAN: swapoff $*"; }; swapon() { echo "RAN: swapon $*"; };` +
        ` mkswap() { echo "RAN: mkswap $*"; }; fallocate() { echo "RAN: fallocate $*"; };` +
        ` ${extra} configure_swap`,
    );

  it("creates 8 GiB on a box that has no swap at all", async () => {
    const { out } = await decide(fakeSwap({ totalMib: 0 }));
    expect(out).toContain("would create a 8192 MiB swap file");
  });

  // The load-bearing safety property, and the one an earlier draft of this got
  // wrong. Replacing live swap means swapoff, then a window where the old file
  // is deleted and the new one is not yet proven; a failure anywhere in it
  // leaves a running box with NO swap, unattended, mid-install. And /swapfile
  // is the conventional path on Ubuntu and cloud images, so finding swap there
  // does not make it ours to replace. Every case below asserts the same thing
  // from a different angle: existing swap is never touched.
  const destructive = /^RAN: /m;
  /** The advisory line the tool prints only when existing swap is undersized. */
  const TOO_SMALL = "this tool makes on a box with no swap";

  it("leaves the 2 GiB file an earlier install left behind exactly where it is", async () => {
    const { out } = await decide(fakeSwap({ totalMib: 2048, usedMib: 100 }));
    expect(out).toContain("swap already set up: 2048 MiB");
    expect(out).not.toMatch(destructive);
  });

  // Left alone is not the same as unmentioned: 2 GiB exhausted is the worst
  // configuration measured, so the operator is told what this tool would make
  // and how to do it themselves when the box is quiet.
  it("tells the operator how to change a swap file that is too small", async () => {
    const { out } = await decide(fakeSwap({ totalMib: 2048 }));
    expect(out).toContain(TOO_SMALL);
    expect(out).toContain("8192 MiB");
    expect(out).toContain(`swapoff ${swapPath()}`);
    expect(out).toContain(`mkswap ${swapPath()}`);
  });

  it("says nothing about resizing when the box already has enough", async () => {
    const { out } = await decide(fakeSwap({ totalMib: 16384 }));
    expect(out).toContain("swap already set up: 16384 MiB");
    expect(out).not.toContain(TOO_SMALL);
  });

  // What an 8192 MiB file actually reports, measured: mkswap takes a page for
  // its header and SwapTotal is kB, so it comes back 1 MiB short. Compared
  // exactly, the tool would nag about its own correctly-sized swap file on
  // every single run.
  it("does not nag about the file it made itself", async () => {
    const { out } = await decide(fakeSwap({ totalMib: 8191 }));
    expect(out).not.toContain(TOO_SMALL);
  });

  // The advice is only right for a box whose swap IS the file this tool would
  // have made. Handing the swapfile recipe to someone running on a partition
  // tells them to swapoff a path that is not their swap and then to fallocate
  // over whatever is sitting there - the same unfounded /swapfile assumption
  // that kept the automatic resize out, pointed at the operator instead.
  it("leaves a swap partition alone, and does not prescribe a swapfile recipe", async () => {
    const { out } = await decide(
      fakeSwap({ totalMib: 2048, devices: ["/dev/sda2"] }),
    );
    expect(out).toContain("/dev/sda2");
    expect(out).toContain("depends on how this box's swap is set up");
    expect(out).not.toContain(`swapoff ${swapPath()}`);
    expect(out).not.toContain(`fallocate`);
    expect(out).not.toMatch(destructive);
  });

  // meminfo says there is swap and /proc/swaps lists nothing usable. The device
  // list is then not $SWAPFILE either, so the same rule keeps a command that
  // could target the wrong path from being printed on the strength of a number
  // alone.
  it("prescribes nothing when it cannot tell where the swap is", async () => {
    const { out } = await decide(fakeSwap({ totalMib: 2048, devices: [] }));
    expect(out).toContain("an unreadable device list");
    expect(out).not.toContain(`swapoff ${swapPath()}`);
    expect(out).not.toContain("fallocate");
  });

  it("says the same to a box with several swap devices", async () => {
    const { out } = await decide(
      fakeSwap({ totalMib: 2048, devices: [swapPath(), "/dev/zram0"] }),
    );
    expect(out).toContain("/dev/zram0");
    expect(out).toContain("depends on how this box's swap is set up");
    expect(out).not.toContain(`swapoff ${swapPath()}`);
    expect(out).not.toMatch(destructive);
  });

  // 8 GiB plus the headroom asks for 12 GiB of disk where the old 2 GiB default
  // asked for 6. Without a fallback this change would hand a small-disk box no
  // swap at all, which is worse than the 2 GiB it used to get.
  it("takes what fits when the disk is too small for the full size", async () => {
    const { out } = await decide(fakeSwap({ totalMib: 0 }), 9000);
    expect(out).toContain("would create a 4096 MiB swap file");
    expect(out).toContain("instead of 8192 MiB");
  });

  it("creates nothing when not even the old size fits", async () => {
    const { out } = await decide(fakeSwap({ totalMib: 0 }), 5000);
    expect(out).toContain("not creating a swap file");
  });

  it("does not touch a box that has swap, whatever the disk looks like", async () => {
    const { out } = await decide(fakeSwap({ totalMib: 2048 }), 5000);
    expect(out).toContain("swap already set up");
    expect(out).not.toMatch(destructive);
  });
});

describe("the command line", () => {
  /** Run the real script (not the sourceable copy) as an unprivileged user. */
  async function runScript(
    ...args: string[]
  ): Promise<{ out: string; exit: number }> {
    const proc = Bun.spawn(["bash", SCRIPT, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { out: out + err, exit: await proc.exited };
  }

  it("takes --restamp and --dry-run together", async () => {
    // Both reach the root check, which is as far as an unprivileged run gets.
    // If either had been rejected we would see the usage text instead.
    const { out, exit } = await runScript("--restamp", "--dry-run");
    expect(out).toContain("must run as root");
    expect(out).not.toContain("Usage:");
    expect(exit).toBe(3);
  });

  it("still refuses an unknown flag", async () => {
    const { out, exit } = await runScript("--nope");
    expect(out).toContain("Usage:");
    expect(exit).toBe(3);
  });

  it("documents --restamp in its own help", async () => {
    const { out, exit } = await runScript("--help");
    expect(out).toContain("--restamp");
    expect(exit).toBe(0);
  });
});

describe("the shipped script", () => {
  it("still calls main, which the sourceable copy strips", () => {
    expect(SRC.endsWith('\nmain "$@"\n')).toBe(true);
  });

  it("still refuses to run as anyone but root", () => {
    // The `--restamp` tests above run a copy with this guard stripped out, so
    // it gets pinned here: stripping it in a test must never be able to hide
    // its removal from the real script.
    expect(SRC).toContain("[[ $EUID -eq 0 ]] ||");
    expect(SRC).toContain("must run as root");
  });

  it("never verifies a score with systemctl show", () => {
    // systemctl reports the configured value, not the effective one. Resolving
    // MainPID with it is fine; believing it about a score is the original bug.
    for (const line of SRC.split("\n")) {
      if (line.trim().startsWith("#")) continue;
      if (!line.includes("systemctl show")) continue;
      expect(line).toMatch(/MainPID|ControlGroup/);
      expect(line).not.toContain("OOMScoreAdjust");
    }
  });

  it("reads every score back through the seam, never a hardcoded /proc", () => {
    const body = SRC.split("\n").filter((l) => !l.trim().startsWith("#"));
    const hardcoded = body.filter((l) => /\/proc\/\$/.test(l));
    expect(hardcoded).toEqual([]);
  });
});
