// The owner's Run on the Members page (task b94dfd25 4c-iii,
// server/member-os-user-run.ts), through its deps: a stand-in sudo start, a
// stand-in probe and a fake clock. The properties:
// - Run shows only on the installer's install, off Hosted, where the office's
//   account may use sudo: with a password, or without one;
// - the probe runs once per 5 minutes, and once for many reads at a time;
// - the refusals come in order, and none starts sudo; a run for a member is
//   held from the first check, so two clicks at once start one run, and a
//   run of another member is not held;
// - the command is the root command's path, the verb and the checked id;
//   root's home, "/" and the root command's longest move plus 10 minutes;
// - 3 wrong passwords lock that member for 15 minutes; another member is not
//   held; a run that starts clears the count;
// - the end: exit 0 clears the attempt; another end fails it with the
//   output's tail (at most 500 characters), unless the root command's verb
//   failed it after the start, whose message is more exact.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createMemberOsUserRun,
  MEMBER_USER_LOCK_MS,
  MEMBER_USER_RUN_TIMEOUT_MS,
  resetRunModeCache,
  runMode,
  type MemberOsUserRunDeps,
} from "./member-os-user-run.ts";
import {
  MEMBER_USER_COMMAND_PATH,
  memberOsUserView,
  noteMemberUserAttempt,
  resetMemberUserAttempts,
  type MemberUserSupport,
} from "./member-os-user-view.ts";
import type {
  SudoProbe,
  SudoRunResult,
  SudoStart,
  SudoStartOptions,
} from "./sudo-runner.ts";

const INSTALLER: MemberUserSupport = { ok: true, shape: "installer" };
const MIA = { id: "0a1b2c3d", role: "member" as const };
const BO = { id: "4e5f6a7b", role: "member" as const };
const OWNER = { id: "99aa88bb", role: "owner" as const };
const PASSWORD = "c0rrect-h0rse";

// A run that the test ends.
interface Pending {
  opts: SudoStartOptions;
  end(result: Partial<SudoRunResult>): void;
}

let clock: number;
let probes: number;
let probeAnswer: SudoProbe;
let starts: Pending[];
// What the next start answers: "start", an auth failure's line, or a throw.
let nextStart: "start" | { refuse: string } | "throw";
let releaseProbe: (() => void) | null;

function deps(over: Partial<MemberOsUserRunDeps> = {}): MemberOsUserRunDeps {
  return {
    support: () => INSTALLER,
    hosted: () => false,
    probe: async () => {
      probes++;
      if (releaseProbe === null) return probeAnswer;
      await new Promise<void>((resolve) => {
        const before = releaseProbe!;
        releaseProbe = () => {
          before();
          resolve();
        };
      });
      return probeAnswer;
    },
    start: async (opts): Promise<SudoStart> => {
      if (nextStart === "throw") throw new Error("spawn failed");
      if (nextStart !== "start") {
        // A refused password is no start.
        starts.push({ opts, end: () => {} });
        return { kind: "auth_failed", reason: nextStart.refuse };
      }
      let finish!: (r: SudoRunResult) => void;
      const done = new Promise<SudoRunResult>((r) => (finish = r));
      starts.push({
        opts,
        end: (result) =>
          finish({
            exitCode: 0,
            signal: null,
            timedOut: false,
            durationMs: 1,
            output: "",
            ...result,
          }),
      });
      return { kind: "started", done };
    },
    now: () => clock,
    ...over,
  };
}

const attemptOf = (user: { id: string; role: "member" }) =>
  memberOsUserView(user, { support: INSTALLER }).attempt;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  clock = 1_790_000_000_000;
  probes = 0;
  probeAnswer = "available";
  starts = [];
  nextStart = "start";
  releaseProbe = null;
  resetRunModeCache();
  resetMemberUserAttempts();
});
afterEach(() => {
  resetRunModeCache();
  resetMemberUserAttempts();
});

describe("where Run shows", () => {
  it("is the installer's install off Hosted, with or without a password by the probe", () => {
    expect(runMode(INSTALLER, false, "available")).toBe("password");
    expect(runMode(INSTALLER, false, "no_password_needed")).toBe("no_password");
    expect(runMode(INSTALLER, false, "unavailable")).toBeNull();
    expect(runMode(INSTALLER, true, "available")).toBeNull();
    for (const support of [
      { ok: true, shape: "container" },
      { ok: true, shape: "docker", container: "0123456789ab" },
      { ok: false, reason: "no_system_install" },
    ] as MemberUserSupport[])
      expect({ support, mode: runMode(support, false, "available") }).toEqual({
        support,
        mode: null,
      });
  });

  it("probes once for many reads at a time, keeps the answer for minutes, and probes again later", async () => {
    const run = createMemberOsUserRun(deps());
    releaseProbe = () => {};
    const reads = [run.mode(), run.mode(), run.mode()];
    await flush();
    releaseProbe();
    expect(await Promise.all(reads)).toEqual([
      "password",
      "password",
      "password",
    ]);
    expect(probes).toBe(1);
    releaseProbe = null;
    clock += 4 * 60_000;
    probeAnswer = "no_password_needed";
    expect(await run.mode()).toBe("password");
    expect(probes).toBe(1);
    clock += 2 * 60_000;
    expect(await run.mode()).toBe("no_password");
    expect(probes).toBe(2);
  });

  it("answers the mode of the office's support and Hosted", async () => {
    expect(
      await createMemberOsUserRun(deps({ hosted: () => true })).mode(),
    ).toBeNull();
    resetRunModeCache();
    expect(
      await createMemberOsUserRun(
        deps({ support: () => ({ ok: true, shape: "container" }) }),
      ).mode(),
    ).toBeNull();
    // Neither one starts sudo for the probe.
    expect(probes).toBe(0);
  });
});

describe("the refusals", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    action: "enable",
    password: PASSWORD,
    ...over,
  });
  const refusal = (
    r: Awaited<ReturnType<ReturnType<typeof createMemberOsUserRun>["run"]>>,
  ) => (r.ok ? "started" : `${r.status} ${r.code}`);

  it("come in order: the action, an owner, no Run here or no id, and none starts sudo", async () => {
    const run = createMemberOsUserRun(deps());
    for (const action of ["", "Enable", "delete", undefined, 7])
      expect({
        action,
        r: refusal(await run.run(OWNER, body({ action }))),
      }).toEqual({ action, r: "400 invalid_action" });
    expect(refusal(await run.run(OWNER, body()))).toBe("409 member_owner");
    // An owner before the id check.
    expect(
      refusal(await run.run({ id: "not-an-id", role: "owner" }, body())),
    ).toBe("409 member_owner");
    probeAnswer = "unavailable";
    expect(refusal(await run.run(MIA, body()))).toBe("409 run_unavailable");
    resetRunModeCache();
    probeAnswer = "available";
    for (const id of ["0A1B2C3D", "0a1b2c3", "0a1b2c3d; id", "../0a1b2c"])
      expect({
        id,
        r: refusal(await run.run({ id, role: "member" }, body())),
      }).toEqual({ id, r: "409 run_unavailable" });
    expect(starts).toEqual([]);
    for (const body of [null, "enable", [], 3])
      expect(refusal(await run.run(MIA, body))).toMatch(/^400 /);
    expect(starts).toEqual([]);
  });

  it("refuse a password sudo would not take, and take one of 1024 characters", async () => {
    const run = createMemberOsUserRun(deps());
    for (const password of [
      "",
      "a".repeat(1025),
      "pass\nword",
      "pass\rword",
      "pass\0word",
      undefined,
      42,
    ])
      expect({
        password: String(password).slice(0, 12),
        r: refusal(await run.run(MIA, body({ password }))),
      }).toEqual({
        password: String(password).slice(0, 12),
        r: "400 invalid_password",
      });
    expect(starts).toEqual([]);
    const long = "a".repeat(1024);
    expect(refusal(await run.run(MIA, body({ password: long })))).toBe(
      "started",
    );
    expect(starts.map((s) => s.opts.password)).toEqual([long]);
  });

  it("read no password where sudo asks for none", async () => {
    probeAnswer = "no_password_needed";
    const run = createMemberOsUserRun(deps());
    expect(refusal(await run.run(MIA, { action: "enable" }))).toBe("started");
    starts[0].end({});
    await flush();
    expect(
      refusal(await run.run(MIA, { action: "disable", password: PASSWORD })),
    ).toBe("started");
    expect(starts.map((s) => s.opts.password.includes(PASSWORD))).toEqual([
      false,
      false,
    ]);
  });

  it("hold the member from the first check: two clicks at once start one run, and another member's run is not held", async () => {
    // A cold probe: the first awaits inside the route.
    releaseProbe = () => {};
    const run = createMemberOsUserRun(deps());
    const first = run.run(MIA, body());
    const second = run.run(MIA, body());
    const other = run.run(BO, body());
    await flush();
    releaseProbe();
    const answers = (await Promise.all([first, second, other])).map(refusal);
    expect(answers.filter((a) => a === "started")).toHaveLength(2);
    expect(answers).toContain("409 run_in_progress");
    expect(starts.map((s) => s.opts.command.split(" ").at(-1)).sort()).toEqual(
      [BO.id, MIA.id].sort(),
    );
  });

  it("puts a lock before the password check and the run in progress before it", async () => {
    const run = createMemberOsUserRun(deps());
    expect(refusal(await run.run(MIA, body()))).toBe("started");
    expect(refusal(await run.run(MIA, body({ password: "" })))).toBe(
      "409 run_in_progress",
    );
    nextStart = { refuse: "sudo: 1 incorrect password attempt" };
    for (let i = 0; i < 3; i++) await run.run(BO, body({ password: "wrong" }));
    expect(refusal(await run.run(BO, body({ password: "" })))).toBe(
      "429 locked_out",
    );
  });
});

describe("the command", () => {
  it("is the root command's path, the verb and the id, as root in /, for the longest move plus 10 minutes", async () => {
    const run = createMemberOsUserRun(deps());
    for (const action of ["enable", "disable"] as const) {
      await run.run(MIA, { action, password: PASSWORD });
      const { opts } = starts.at(-1)!;
      expect(opts.command.split(" ")).toEqual([
        MEMBER_USER_COMMAND_PATH,
        action,
        MIA.id,
      ]);
      expect([opts.cwd, opts.home, opts.timeoutMs]).toEqual([
        "/",
        "/root",
        MEMBER_USER_RUN_TIMEOUT_MS,
      ]);
      starts.at(-1)!.end({});
      await flush();
    }
    // The root command waits this long for go-on and disable.
    const limit = Number(
      /^MOVE_VERB_LIMIT_S=(\d+)$/m.exec(
        readFileSync(
          join(import.meta.dir, "..", "deploy", "isomux-member-user.sh"),
          "utf8",
        ),
      )?.[1],
    );
    expect(MEMBER_USER_RUN_TIMEOUT_MS).toBe((limit + 600) * 1000);
  });

  it("answers 500 when sudo cannot start, and frees the member for the next run", async () => {
    const run = createMemberOsUserRun(deps());
    nextStart = "throw";
    const failed = await run.run(MIA, { action: "enable", password: PASSWORD });
    expect(failed.ok ? 0 : [failed.status, failed.code]).toEqual([
      500,
      "run_failed",
    ]);
    nextStart = "start";
    expect(
      (await run.run(MIA, { action: "enable", password: PASSWORD })).ok,
    ).toBe(true);
  });
});

describe("wrong passwords", () => {
  const wrong = { action: "enable", password: "wrong" };
  const right = { action: "enable", password: PASSWORD };

  it("lock that member for 15 minutes after the third, before sudo runs, and hold no other member", async () => {
    const run = createMemberOsUserRun(deps());
    nextStart = { refuse: "sudo: 1 incorrect password attempt" };
    const left: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await run.run(MIA, wrong);
      expect(r.ok ? 0 : [r.status, r.code]).toEqual([422, "not_started"]);
      if (!r.ok) {
        left.push(r.detail?.attemptsLeft);
        expect(r.detail?.reason).toBe("sudo: 1 incorrect password attempt");
      }
    }
    expect(left).toEqual([2, 1, 0]);
    expect(starts).toHaveLength(3);
    nextStart = "start";
    const locked = await run.run(MIA, right);
    expect(locked.ok ? 0 : [locked.status, locked.code]).toEqual([
      429,
      "locked_out",
    ]);
    const retry = locked.ok ? 0 : Number(locked.detail?.retryAfterS);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(MEMBER_USER_LOCK_MS / 1000);
    // The 4th try never reached sudo.
    expect(starts).toHaveLength(3);
    // Another member runs.
    expect((await run.run(BO, right)).ok).toBe(true);
    expect(starts).toHaveLength(4);
    // Still locked a minute before the end, free after it.
    clock += MEMBER_USER_LOCK_MS - 60_000;
    expect((await run.run(MIA, right)).ok).toBe(false);
    clock += 61_000;
    // After the lock, the member has all their tries again.
    nextStart = { refuse: "sudo: 1 incorrect password attempt" };
    const after = await run.run(MIA, wrong);
    expect(after.ok ? 0 : after.detail?.attemptsLeft).toBe(2);
    nextStart = "start";
    expect((await run.run(MIA, right)).ok).toBe(true);
  });

  it("count again from zero after a run starts", async () => {
    const run = createMemberOsUserRun(deps());
    nextStart = { refuse: "sudo: 1 incorrect password attempt" };
    await run.run(MIA, wrong);
    await run.run(MIA, wrong);
    nextStart = "start";
    expect((await run.run(MIA, right)).ok).toBe(true);
    starts.at(-1)!.end({});
    await flush();
    nextStart = { refuse: "sudo: 1 incorrect password attempt" };
    const r = await run.run(MIA, wrong);
    expect(r.ok ? 0 : r.detail?.attemptsLeft).toBe(2);
  });
});

describe("the end of a run", () => {
  const right = { action: "enable", password: PASSWORD };

  it("reads running from the start, holds the member until the end, and clears the attempt on exit 0", async () => {
    const run = createMemberOsUserRun(deps());
    expect(await run.run(MIA, right)).toEqual({ ok: true, action: "enable" });
    expect(attemptOf(MIA)).toMatchObject({
      action: "enable",
      status: "running",
    });
    // The root command's verbs note the steps meanwhile.
    noteMemberUserAttempt(MIA.id, "enable", "prepared");
    starts[0].end({ exitCode: 0 });
    await flush();
    expect(attemptOf(MIA)).toBeUndefined();
    expect((await run.run(MIA, { ...right, action: "disable" })).ok).toBe(true);
    expect(attemptOf(MIA)).toMatchObject({ action: "disable" });
  });

  it("fails the attempt with the output's last lines on any other end", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i} of the run`);
    const output = `${lines.join("\n")}\nisomux-member-user: the last word\n\n`;
    for (const end of [
      { exitCode: 1 },
      { exitCode: null, signal: "SIGTERM" },
      { exitCode: null, signal: "SIGKILL", timedOut: true },
    ]) {
      resetMemberUserAttempts();
      const run = createMemberOsUserRun(deps());
      await run.run(MIA, right);
      starts.at(-1)!.end({ ...end, output });
      await flush();
      const attempt = attemptOf(MIA);
      expect({ end, status: attempt?.status }).toEqual({
        end,
        status: "failed",
      });
      expect(attempt?.message?.trimEnd().endsWith("the last word")).toBe(true);
      expect(attempt?.message?.length).toBeLessThanOrEqual(500);
      expect(attempt?.message).not.toContain("line 0 of the run");
      // It starts at a whole line.
      expect(attempt?.message).toMatch(/^line \d+ of the run\n/);
    }
  });

  // Slice 5c-3 (task 78733adf, C3): the enable of a member who came with an
  // office move runs the office's place job, which goes on when the run
  // reaches its time limit. That end is not a failed move: the attempt is
  // cleared, and the page keeps her moved-in line; the next enable collects
  // the job's outcome. `placeRunning` is the new dep (member-user-admin.ts
  // memberPlaceRunning).
  it("clears the attempt of a run cut at its time limit while the member's place job runs; fails it as before when none runs", async () => {
    const out =
      "isomux-member-user: Placing the home of isomux-mia: 3 of 9 entries.";
    for (const placing of [true, false]) {
      resetMemberUserAttempts();
      const asked: string[] = [];
      const run = createMemberOsUserRun(
        deps(
          // `now` keeps the object a Partial of the deps (the new dep is
          // not in the type until the code commit).
          Object.assign(
            { now: () => clock },
            {
              placeRunning: (id: string) => {
                asked.push(id);
                return placing;
              },
            },
          ),
        ),
      );
      await run.run(MIA, right);
      starts.at(-1)!.end({
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        output: out,
      });
      await flush();
      expect({ placing, asked, attempt: attemptOf(MIA)?.status }).toEqual({
        placing,
        asked: [MIA.id],
        attempt: placing ? undefined : "failed",
      });
      // The member is free for the next run either way.
      expect((await run.run(MIA, right)).ok).toBe(true);
      starts.at(-1)!.end({ exitCode: 0 });
      await flush();
    }
    // A run that failed on its own (not the time limit) fails, job or not.
    resetMemberUserAttempts();
    const run = createMemberOsUserRun(
      deps(Object.assign({ now: () => clock }, { placeRunning: () => true })),
    );
    await run.run(MIA, right);
    starts.at(-1)!.end({ exitCode: 1, output: out });
    await flush();
    expect(attemptOf(MIA)?.status).toBe("failed");
  });

  it("keeps the message of a verb that failed after the start, and not one from before it", async () => {
    const run = createMemberOsUserRun(deps());
    noteMemberUserAttempt(MIA.id, "enable", "failed", "an earlier failure");
    await run.run(MIA, right);
    starts.at(-1)!.end({ exitCode: 1, output: "the run's own tail\n" });
    await flush();
    expect(attemptOf(MIA)?.message).toContain("the run's own tail");

    await run.run(MIA, right);
    noteMemberUserAttempt(MIA.id, "enable", "failed", "the office's reason");
    starts.at(-1)!.end({ exitCode: 1, output: "the run's own tail\n" });
    await flush();
    expect(attemptOf(MIA)?.message).toBe("the office's reason");
  });

  it("ends each member's run on that member's attempt only", async () => {
    const run = createMemberOsUserRun(deps());
    await run.run(MIA, right);
    await run.run(BO, right);
    starts[0].end({ exitCode: 1, output: "mia failed\n" });
    await flush();
    expect(attemptOf(MIA)?.status).toBe("failed");
    expect(attemptOf(BO)?.status).toBe("running");
  });
});
