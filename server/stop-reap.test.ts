// Ending what outlives the office's stop (task 44f7b101). A process in the
// unit's cgroup that ignores SIGTERM held a restart for systemd's full stop
// timeout (90 s). The office now SIGKILLs such leftovers a short grace after
// the signal - but only the unit's own office: an office an agent starts
// inherits the same cgroup and systemd variables, and arming there would end
// the live office's agents.

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  OFFICE_PID_ENV,
  type ProcInfo,
  markOfficeProcess,
  reapLeftovers,
  stopReapCgroup,
} from "./stop-reap.ts";

const UNIT_PATH =
  "/user.slice/user-1001.slice/user@1001.service/app.slice/isomux.service";
const CGROUP = `0::${UNIT_PATH}\n`;
const UNIT_DIR = `/sys/fs/cgroup${UNIT_PATH}`;

/** readProc over a fixed process table. */
function table(rows: Record<number, ProcInfo>) {
  return (pid: number): ProcInfo | null => rows[pid] ?? null;
}

describe("stopReapCgroup: which office reaps", () => {
  // The office renames itself to "isomux" (setProcessName), so the process
  // under test carries that name in every row below.
  const SELF = 4000;

  test("the unit's own office, started directly (install.sh): armed, keeps only itself", () => {
    const got = stopReapCgroup(
      { SYSTEMD_EXEC_PID: String(SELF) },
      SELF,
      CGROUP,
      table({ [SELF]: { ppid: 1035, comm: "isomux" } }),
    );
    expect(got).toEqual({ dir: UNIT_DIR, keep: [SELF] });
  });

  test("an office under a wrapper (ExecStart=bun run dev): armed, keeps every wrapper up to the exec pid", () => {
    // The wrappers wait for the office to exit, so killing them would only
    // cost the grace at every stop.
    const got = stopReapCgroup(
      { SYSTEMD_EXEC_PID: "3990" },
      SELF,
      CGROUP,
      table({
        [SELF]: { ppid: 3995, comm: "isomux" },
        3995: { ppid: 3990, comm: "sh" },
        3990: { ppid: 1035, comm: "bun" },
      }),
    );
    expect(got).toEqual({ dir: UNIT_DIR, keep: [SELF, 3995, 3990] });
  });

  // An office an agent starts from its Bash tool: the shape measured on
  // 2026-11-04 (bash -> claude -> the live office, which is the exec pid).
  const NESTED = {
    [SELF]: { ppid: 3999, comm: "isomux" },
    3999: { ppid: 3998, comm: "bash" },
    3998: { ppid: 1000, comm: "claude" },
    1000: { ppid: 1035, comm: "isomux" },
  };

  test("an office started inside the live office's tree: not armed, even without the marker", () => {
    // Before the live office runs this code, its agents carry no marker, so
    // the ancestor named "isomux" is the only guard.
    expect(
      stopReapCgroup({ SYSTEMD_EXEC_PID: "1000" }, SELF, CGROUP, table(NESTED)),
    ).toBeNull();
    // The same tree whose top is not an office arms: the name is what decides.
    expect(
      stopReapCgroup(
        { SYSTEMD_EXEC_PID: "1000" },
        SELF,
        CGROUP,
        table({ ...NESTED, 1000: { ppid: 1035, comm: "bun" } }),
      ),
    ).toEqual({ dir: UNIT_DIR, keep: [SELF, 3999, 3998, 1000] });
  });

  test("an office between the exec pid and this one: not armed", () => {
    // A nested office under a `bun run dev` unit: the exec pid is the outer
    // bun, and the live office sits between.
    const got = stopReapCgroup(
      { SYSTEMD_EXEC_PID: "3990" },
      SELF,
      CGROUP,
      table({
        [SELF]: { ppid: 3999, comm: "isomux" },
        3999: { ppid: 3991, comm: "bash" },
        3991: { ppid: 3990, comm: "isomux" },
        3990: { ppid: 1035, comm: "bun" },
      }),
    );
    expect(got).toBeNull();
  });

  test("the inherited marker alone disarms", () => {
    expect(
      stopReapCgroup(
        { SYSTEMD_EXEC_PID: String(SELF), [OFFICE_PID_ENV]: "1000" },
        SELF,
        CGROUP,
        table({ [SELF]: { ppid: 1035, comm: "isomux" } }),
      ),
    ).toBeNull();
  });

  test("markOfficeProcess sets the marker that disarms every office started below", () => {
    const env: Record<string, string | undefined> = {};
    markOfficeProcess(env, 1000);
    expect(env[OFFICE_PID_ENV]).toBe("1000");
    // What an agent shell of that office inherits, started directly as the
    // unit would be: armed but for the marker.
    expect(
      stopReapCgroup(
        { ...env, SYSTEMD_EXEC_PID: String(SELF) },
        SELF,
        CGROUP,
        table({ [SELF]: { ppid: 1035, comm: "isomux" } }),
      ),
    ).toBeNull();
  });

  test("a walk that never reaches the exec pid: not armed", () => {
    // An orphaned agent shell (its CLI was released) hangs under the user
    // manager; a PID namespace ends at its own pid 1.
    const orphan = table({
      [SELF]: { ppid: 3999, comm: "isomux" },
      3999: { ppid: 1035, comm: "bash" },
      1035: { ppid: 1, comm: "systemd" },
      1: { ppid: 0, comm: "systemd" },
    });
    expect(
      stopReapCgroup({ SYSTEMD_EXEC_PID: "1000" }, SELF, CGROUP, orphan),
    ).toBeNull();
    // A process that exits mid-walk.
    expect(
      stopReapCgroup(
        { SYSTEMD_EXEC_PID: "1000" },
        SELF,
        CGROUP,
        table({ [SELF]: { ppid: 3999, comm: "isomux" } }),
      ),
    ).toBeNull();
    // A ppid loop (pid reuse between reads) ends the walk instead of hanging.
    expect(
      stopReapCgroup(
        { SYSTEMD_EXEC_PID: "1000" },
        SELF,
        CGROUP,
        table({
          [SELF]: { ppid: 3999, comm: "isomux" },
          3999: { ppid: 3998, comm: "bash" },
          3998: { ppid: 3999, comm: "bash" },
        }),
      ),
    ).toBeNull();
  });

  test("an office under another service (a GitHub Actions runner): not armed", () => {
    // The job inherits the runner unit's exec pid and group, and no process
    // on the walk is named isomux: only the unit name tells it apart.
    const runner = table({
      [SELF]: { ppid: 3999, comm: "bun" },
      3999: { ppid: 3998, comm: "bun" },
      3998: { ppid: 3997, comm: "bash" },
      3997: { ppid: 3990, comm: "Runner.Worker" },
      3990: { ppid: 1, comm: "Runner.Listener" },
    });
    const env = { SYSTEMD_EXEC_PID: "3990" };
    const runnerUnit = "/system.slice/actions.runner.org-repo.runner-1.service";
    expect(stopReapCgroup(env, SELF, `0::${runnerUnit}\n`, runner)).toBeNull();
    // The same tree in the office's unit arms: the unit name is what decides.
    expect(stopReapCgroup(env, SELF, CGROUP, runner)).toEqual({
      dir: UNIT_DIR,
      keep: [SELF, 3999, 3998, 3997, 3990],
    });
  });

  test("not a systemd service on cgroup v2: not armed", () => {
    const self = table({ [SELF]: { ppid: 1035, comm: "isomux" } });
    const env = { SYSTEMD_EXEC_PID: String(SELF) };
    // No systemd exec pid: a foreground run, a container.
    expect(stopReapCgroup({}, SELF, CGROUP, self)).toBeNull();
    expect(
      stopReapCgroup({ SYSTEMD_EXEC_PID: "x" }, SELF, CGROUP, self),
    ).toBeNull();
    // A scope or a sub-group, not a service.
    expect(
      stopReapCgroup(
        env,
        SELF,
        "0::/user.slice/user-1001.slice/user@1001.service/app.slice/run-u5.scope\n",
        self,
      ),
    ).toBeNull();
    expect(
      stopReapCgroup(env, SELF, `0::${UNIT_PATH}/payload\n`, self),
    ).toBeNull();
    // cgroup v1 only.
    expect(
      stopReapCgroup(
        env,
        SELF,
        `12:pids:${UNIT_PATH}\n1:name=systemd:${UNIT_PATH}\n`,
        self,
      ),
    ).toBeNull();
  });
});

// A fake cgroup and clock. Time moves only through sleep() and, by one ms,
// through each now() call, so a loop that never sleeps still ends.
function fakeGroup(initial: number[], comms: Record<number, string> = {}) {
  const live = new Set(initial);
  const kills: { pid: number; signal: string; at: number }[] = [];
  const lines: string[] = [];
  let t = 0;
  let sleeps = 0;
  // Called after each sleep with the new time.
  let onTick: (t: number) => void = () => {};
  // Called on each kill before it applies; may throw.
  let onKill: (pid: number) => void = () => {};
  const deps = {
    now: () => t++,
    sleep: async (ms: number) => {
      sleeps++;
      t += ms;
      onTick(t);
    },
    pollMs: 50,
    readProcs: () => [...live],
    kill: (pid: number, signal: NodeJS.Signals) => {
      onKill(pid);
      kills.push({ pid, signal, at: t });
      live.delete(pid);
    },
    comm: (pid: number) => comms[pid] ?? null,
    log: (line: string) => lines.push(line),
  };
  return {
    live,
    kills,
    lines,
    deps,
    time: () => t,
    sleeps: () => sleeps,
    tick: (fn: (t: number) => void) => (onTick = fn),
    onKill: (fn: (pid: number) => void) => (onKill = fn),
  };
}

const SELF = 4000;
const PARENT = 3990;
// The two leftovers of the 2026-11-04 restart.
const SH = 3337123;
const SLEEP = 3444453;

describe("reapLeftovers", () => {
  test("nothing but the kept pids: returns at once and kills nothing", async () => {
    const g = fakeGroup([SELF, PARENT]);
    const killed = await reapLeftovers(UNIT_DIR, [SELF, PARENT], {
      ...g.deps,
      deadline: 5_000,
    });
    expect({ killed, kills: g.kills, sleeps: g.sleeps() }).toEqual({
      killed: [],
      kills: [],
      sleeps: 0,
    });
  });

  test("leftovers that exit within the grace: waits for them, kills nothing", async () => {
    // A backend that dies by the stop signal, as the Claude CLI does.
    const g = fakeGroup([SELF, 4100, 4101]);
    g.tick((t) => {
      if (t >= 300) g.live.delete(4100);
      if (t >= 800) g.live.delete(4101);
    });
    const killed = await reapLeftovers(UNIT_DIR, [SELF], {
      ...g.deps,
      deadline: 5_000,
    });
    expect({ killed, kills: g.kills }).toEqual({ killed: [], kills: [] });
    // Returned when the group emptied, not at the deadline.
    expect(g.time()).toBeGreaterThanOrEqual(800);
    expect(g.time()).toBeLessThan(5_000);
  });

  test("a leftover that ignores SIGTERM: SIGKILLed at the deadline, kept pids never", async () => {
    const g = fakeGroup([SELF, PARENT, SH, SLEEP], {
      [SH]: "sh",
      [SLEEP]: "sleep",
    });
    const killed = await reapLeftovers(UNIT_DIR, [SELF, PARENT], {
      ...g.deps,
      deadline: 5_000,
    });
    expect(killed.toSorted()).toEqual([SH, SLEEP].toSorted());
    expect(g.kills.map((k) => k.pid).toSorted()).toEqual(
      [SH, SLEEP].toSorted(),
    );
    expect(g.kills.every((k) => k.signal === "SIGKILL")).toBe(true);
    // Not before the deadline: the grace is what normal backends exit in.
    expect(Math.min(...g.kills.map((k) => k.at))).toBeGreaterThanOrEqual(5_000);
    expect([...g.live].toSorted()).toEqual([PARENT, SELF].toSorted());
    // One log line names every killed pid with its program, so the culprit
    // is known next time.
    const line = g.lines.find((l) => l.includes(String(SH)));
    expect(line).toBeDefined();
    for (const part of [String(SH), "sh", String(SLEEP), "sleep"])
      expect(line).toContain(part);
  });

  test("a loop that forks between the read and the kill: the new child is killed too", async () => {
    const NEXT = SLEEP + 1;
    const g = fakeGroup([SELF, SH, SLEEP], {
      [SH]: "sh",
      [SLEEP]: "sleep",
      [NEXT]: "sleep",
    });
    let forked = false;
    g.onKill((pid) => {
      // The shell starts its next sleep just before it dies.
      if (pid === SH && !forked) {
        forked = true;
        g.live.add(NEXT);
      }
    });
    const killed = await reapLeftovers(UNIT_DIR, [SELF], {
      ...g.deps,
      deadline: 1_000,
    });
    expect(forked).toBe(true);
    expect(killed.toSorted()).toEqual([SH, SLEEP, NEXT].toSorted());
    expect([...g.live]).toEqual([SELF]);
  });

  test("a kill that fails never throws: a pid gone (ESRCH) and a pid not ours (EPERM)", async () => {
    const GONE = 4200;
    const OTHER_USER = 4201;
    const g = fakeGroup([SELF, GONE, OTHER_USER, SH], { [SH]: "sh" });
    g.onKill((pid) => {
      if (pid === GONE) {
        g.live.delete(GONE);
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }
      if (pid === OTHER_USER)
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    const killed = await reapLeftovers(UNIT_DIR, [SELF], {
      ...g.deps,
      deadline: 1_000,
    });
    // The killable leftover is still killed, whatever order the pids come in.
    expect(killed).toContain(SH);
    expect(killed).not.toContain(OTHER_USER);
    expect(g.live.has(SH)).toBe(false);
    // The pass gives up on what it cannot kill instead of holding the stop.
    expect(g.time()).toBeLessThan(1_000 + 10_000);
    // The refusal is logged by pid.
    expect(g.lines.some((l) => l.includes(String(OTHER_USER)))).toBe(true);
  });

  test("a cgroup that cannot be read: resolves and logs", async () => {
    const g = fakeGroup([SELF]);
    const killed = await reapLeftovers(UNIT_DIR, [SELF], {
      ...g.deps,
      readProcs: () => {
        throw Object.assign(new Error("ENOENT cgroup.procs"), {
          code: "ENOENT",
        });
      },
      deadline: 1_000,
    });
    expect(killed).toEqual([]);
    expect(g.kills).toEqual([]);
    expect(g.lines.length).toBeGreaterThan(0);
  });

  describe("the production cgroup reader", () => {
    let dir = "";
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = "";
    });

    test("reads the group and every sub-group", async () => {
      dir = mkdtempSync(join(tmpdir(), "stop-reap-"));
      writeFileSync(join(dir, "cgroup.procs"), `${SELF}\n${SH}\n`);
      mkdirSync(join(dir, "payload", "inner"), { recursive: true });
      writeFileSync(join(dir, "payload", "cgroup.procs"), `${SLEEP}\n`);
      writeFileSync(join(dir, "payload", "inner", "cgroup.procs"), "4300\n");
      const g = fakeGroup([]);
      const { readProcs: _fake, ...deps } = g.deps;
      const killed = await reapLeftovers(dir, [SELF], {
        ...deps,
        // The kill empties the files, as the kernel does.
        kill: (pid, signal) => {
          g.deps.kill(pid, signal);
          for (const file of [
            "cgroup.procs",
            "payload/cgroup.procs",
            "payload/inner/cgroup.procs",
          ]) {
            const path = join(dir, file);
            const rest = readFileSync(path, "utf8")
              .split("\n")
              .filter((l) => l !== "" && l !== String(pid));
            writeFileSync(path, rest.map((l) => `${l}\n`).join(""));
          }
        },
        deadline: 1_000,
      });
      expect(killed.toSorted()).toEqual([SH, SLEEP, 4300].toSorted());
      expect(g.kills.map((k) => k.pid)).not.toContain(SELF);
    });
  });
});

// The whole path on a real systemd: the office boots as a service's main
// process (the install.sh unit's shape), a shell loop that ignores SIGTERM
// shares its cgroup as the 2026-11-04 leftover did, and `systemctl stop`
// must finish within the grace, not at the unit's stop timeout. Its own
// transient unit with systemd's own environment: never the live office's.
const REPO = join(import.meta.dir, "..");
const ENTRY = join(import.meta.dir, "isomux-office.ts");
const HAS_USER_SYSTEMD =
  process.platform === "linux" &&
  Bun.spawnSync(["systemd-run", "--user", "--wait", "-q", "true"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;
// The unit's own stop timeout. A stop that waits for it is the bug.
const UNIT_STOP_TIMEOUT_S = 30;
// Grace (5 s) plus the hooks and the kill pass, with room for a loaded box.
const STOP_BUDGET_MS = 15_000;
const BOOT_BUDGET_MS = 20_000;

function run(cmd: string[]) {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString().trim(),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("a systemd stop of the office", () => {
  test.skipIf(!HAS_USER_SYSTEMD)(
    "ends a leftover that ignores SIGTERM within the grace, and logs it",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "stop-reap-unit-"));
      const unit = `isomux-stop-reap-test-${process.pid}-${Date.now()}`;
      const log = join(dir, "office.log");
      const pidFile = join(dir, "leftover.pid");
      const home = join(dir, "home");
      mkdirSync(home, { recursive: true });
      let leftover = 0;
      try {
        // The subshell exits at once, so the loop is an orphan in the unit's
        // cgroup, like an agent shell whose CLI was released.
        const script = `( sh -c 'trap "" TERM; while :; do sleep 0.2; done' & echo $! > "$LEFTOVER_PID_FILE" ); exec "$OFFICE_BUN" run "$OFFICE_ENTRY"`;
        const started = run([
          "systemd-run",
          "--user",
          "-q",
          `--unit=${unit}`,
          `--working-directory=${REPO}`,
          "-p",
          `TimeoutStopSec=${UNIT_STOP_TIMEOUT_S}`,
          "-p",
          `StandardOutput=append:${log}`,
          "-p",
          `StandardError=append:${log}`,
          "-E",
          `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
          "-E",
          `HOME=${home}`,
          "-E",
          `ISOMUX_HOME=${join(home, ".isomux")}`,
          "-E",
          `ISOMUX_BACKUP_DIR=${join(dir, "backups")}`,
          "-E",
          `XDG_CONFIG_HOME=${join(home, ".config")}`,
          // The stop can land while the boot's Codex preparation runs; the
          // scratch dirs it leaves go with this test's dir.
          "-E",
          `TMPDIR=${dir}`,
          "-E",
          "PORT=0",
          "-E",
          `LEFTOVER_PID_FILE=${pidFile}`,
          "-E",
          `OFFICE_BUN=${process.execPath}`,
          "-E",
          `OFFICE_ENTRY=${ENTRY}`,
          "/bin/sh",
          "-c",
          script,
        ]);
        expect(started).toMatchObject({ code: 0 });

        // Ready: the office printed its address, and the leftover runs.
        const bootDeadline = performance.now() + BOOT_BUDGET_MS;
        const logText = () => {
          try {
            return readFileSync(log, "utf8");
          } catch {
            return "";
          }
        };
        while (
          !/localhost:\d+/.test(logText()) &&
          performance.now() < bootDeadline
        )
          await Bun.sleep(100);
        try {
          leftover = Number(readFileSync(pidFile, "utf8").trim());
        } catch {}
        const ready = {
          booted: /localhost:\d+/.test(logText()),
          state: run(["systemctl", "--user", "is-active", unit]).out,
          leftoverAlive: leftover > 0 && alive(leftover),
        };
        if (!ready.booted) console.error(logText().slice(-3000));
        expect(ready).toEqual({
          booted: true,
          state: "active",
          leftoverAlive: true,
        });

        const stopAt = performance.now();
        expect(
          run(["systemctl", "--user", "stop", "--no-block", unit]).code,
        ).toBe(0);
        let state = "";
        while (performance.now() - stopAt < STOP_BUDGET_MS) {
          state = run(["systemctl", "--user", "is-active", unit]).out;
          if (
            !["active", "deactivating", "activating", "reloading"].includes(
              state,
            )
          )
            break;
          await Bun.sleep(100);
        }
        const elapsedMs = Math.round(performance.now() - stopAt);
        // "inactive": stopped cleanly. "failed" or still "deactivating": the
        // stop waited for systemd's timeout.
        expect({ state, withinBudget: elapsedMs < STOP_BUDGET_MS }).toEqual({
          state: "inactive",
          withinBudget: true,
        });
        expect(alive(leftover)).toBe(false);
        // The office named the leftover it killed.
        const killLine = logText()
          .split("\n")
          .find((line) => line.includes(String(leftover)));
        expect(killLine).toBeDefined();
      } finally {
        run(["systemctl", "--user", "kill", "--signal=SIGKILL", unit]);
        run(["systemctl", "--user", "stop", unit]);
        run(["systemctl", "--user", "reset-failed", unit]);
        if (leftover > 0 && alive(leftover)) {
          try {
            process.kill(leftover, "SIGKILL");
          } catch {}
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
