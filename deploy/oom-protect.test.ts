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
      expect(line).toContain("MainPID");
      expect(line).not.toContain("OOMScoreAdjust");
    }
  });

  it("reads every score back through the seam, never a hardcoded /proc", () => {
    const body = SRC.split("\n").filter((l) => !l.trim().startsWith("#"));
    const hardcoded = body.filter((l) => /\/proc\/\$/.test(l));
    expect(hardcoded).toEqual([]);
  });
});
