// An isolated member's schedule runs (part 3a of task b94dfd25). The
// properties:
// - a member's job stores `~` as their home; an office job as before;
// - a member's session run is recorded running at once and holds its slot
//   while its checks run through their host (a send is busy, a tick in the
//   gap records a skip, a delete ends it and starts nothing, a server stop
//   starts nothing and leaves the row to the next boot), then starts;
//   an office run starts at once, with no member check;
// - a member run whose runner is not connected, whose folder is missing, or
//   whose checks throw ends failed, starts nothing and frees its slot;
// - a member command run whose checks throw ends failed, not running;
// - a send into a member run claims first and frees the claim on a refusal;
// - the folder limits resolve a member's links as the member.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { FakeBackend } from "./fake-backend.ts";
import { MENTION_BODY, claudeFileMentions } from "./claude-file-mentions.ts";
import { makeFakeCronPersistence } from "./fake-cron-persistence.ts";
import { createCronjobManager } from "../cronjob-manager.ts";
import { createMember, deleteUserById } from "../users.ts";
import { forgetMemberOsUser, recordMemberOsUser } from "../member-os-users.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";
import { folderInsideFor } from "../cron-agent-limits.ts";
import { spawnExceedsAgentFor } from "../spawn-agent-limits.ts";
import { english } from "../i18n.ts";
import { renderLogText } from "../../shared/i18n/log-message.ts";
import { msg } from "../../shared/i18n/log-message.ts";
import type { LogText } from "../../shared/i18n/log-message.ts";
import type { AskRunResult } from "../ask-command-runner.ts";
import { ownOsUserLine } from "../system-prompt.ts";
import { STATE_ROOT } from "../config.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  buildEnvForUserId,
  setPersonalProviderActiveProvider,
} from "../env-loader.ts";
import { effectiveProviderDirectory } from "../provider-folders.ts";
import { personalProviderHome } from "../provider-homes.ts";
import type { OfficeAuth, OfficeLoginSync } from "../office-login-sync.ts";

type CronDeps = Parameters<typeof createCronjobManager>[0];
type AddCronjobInput = Parameters<
  ReturnType<typeof createCronjobManager>["addCronjob"]
>[0];

const FIXED_NOW = 1_000_000;
const settle = () => new Promise((r) => setTimeout(r, 25));

async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const scratch: string[] = [];
function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeScheduler() {
  const intervals: { fn: () => void }[] = [];
  const scheduler: CronDeps["scheduler"] = {
    setTimeout: (() => 0) as unknown as typeof setTimeout,
    clearTimeout: () => {},
    setInterval: ((fn: () => void) => {
      intervals.push({ fn });
      return intervals.length;
    }) as unknown as typeof setInterval,
    clearInterval: () => {},
  };
  return { scheduler, intervals };
}

let iso: IsolatedMember;
let alice: string;
beforeEach(async () => {
  const made = createMember(`CronAlice${Date.now()}`, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  alice = made.user.id;
  iso = await isolateMember(alice);
});
afterEach(() => {
  iso.dispose();
  deleteUserById(alice);
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function manager(over: Partial<CronDeps> = {}) {
  const fake = new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.completeTurn({ text: "done" }),
    },
  });
  const sched = fakeScheduler();
  let now = FIXED_NOW;
  const calls = { memberLimit: 0, officeLimit: 0, skills: 0 };
  const mgr = createCronjobManager({
    resolveBackend: () => fake,
    resolveEnv: () => ({}),
    resolveEnvironmentKey: () => "test-environment",
    resolveEnvironmentRevision: () => "test-revision",
    resolveUser: () => undefined,
    persistence: makeFakeCronPersistence(),
    clock: { now: () => now },
    scheduler: sched.scheduler,
    renderMemoryForPrompt: () => null,
    limitRefusal: () => {
      calls.officeLimit++;
      return null;
    },
    memberLimitRefusal: async () => {
      calls.memberLimit++;
      return null;
    },
    prepareSkillFolder: async () => {
      calls.skills++;
      return true;
    },
    ...over,
  });
  return {
    mgr,
    fake,
    calls,
    sched,
    setNow: (t: number) => {
      now = t;
    },
  };
}

function input(over: Partial<AddCronjobInput> = {}): AddCronjobInput {
  return {
    name: "Member job",
    schedule: { type: "interval", minutes: 60 },
    prompt: "do the thing",
    cwd: tmp("member-job-"),
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    username: "Alice",
    userId: alice,
    ...over,
  };
}

const closeAll = (fake: FakeBackend) => fake.sessions.forEach((s) => s.close());

describe("the stored folder of a member's job", () => {
  // MUTANT: jobFolder as resolveCwd for everyone (dies on her `~`).
  it("stores her `~` as her home, and an office job's as the office home", () => {
    const { mgr } = manager();
    expect(mgr.addCronjob(input({ cwd: "~" })).cwd).toBe(iso.home);
    expect(
      mgr.addCronjob(input({ cwd: "~", userId: undefined, username: "Nil" }))
        .cwd,
    ).toBe(homedir());
    const job = mgr.addCronjob(input());
    expect(mgr.updateCronjob(job.id, { cwd: "~/sub" })?.cwd).toBe(
      join(iso.home, "sub"),
    );
  });
});

describe("the start of a member's session run", () => {
  // MUTANT: fire() without the member branch (dies on the office limit and
  // the session started before the checks).
  it("is recorded running at once and holds its slot while its checks run; then it starts", async () => {
    const gate = deferred<LogText | null>();
    const { mgr, fake, calls } = manager({
      memberLimitRefusal: () => gate.promise,
    });
    const job = mgr.addCronjob(input());
    const run = mgr.runCronjobNow(job.id, "Alice")!;
    expect(run.status).toBe("running");
    await settle();
    // The enabling condition: the checks wait in the gap.
    expect([fake.createSessionCount, calls.officeLimit]).toEqual([0, 0]);
    const busy = await mgr.sendRunMessage(job.id, run.id, "hello", "Alice");
    expect(busy).toMatchObject({ ok: false, code: "run_busy" });
    gate.resolve(null);
    await waitFor(() => fake.createSessionCount === 1, "session start");
    expect(calls.skills).toBe(1);
    closeAll(fake);
  });

  // MUTANT: memberFolderHost check in fire() inverted for an office job.
  it("starts an office job's run at once, with the office limit and no member check", () => {
    const { mgr, fake, calls } = manager();
    const job = mgr.addCronjob(input({ userId: undefined, username: "Nil" }));
    mgr.runCronjobNow(job.id, "Nil");
    expect([
      fake.createSessionCount,
      calls.officeLimit,
      calls.memberLimit,
    ]).toEqual([1, 1, 0]);
    closeAll(fake);
  });

  // MUTANT: scheduledInFlight without the preparing owner (dies: the second
  // tick starts a second run instead of a skip).
  it("makes a tick in the gap a skip", async () => {
    const gate = deferred<LogText | null>();
    const { mgr, fake, sched, setNow } = manager({
      memberLimitRefusal: () => gate.promise,
    });
    const job = mgr.addCronjob(input());
    mgr.startCronjobScheduler();
    const tick = sched.intervals[0].fn;
    setNow(job.nextFireAt! + 1);
    tick();
    setNow(mgr.listCronjobs()[0].nextFireAt! + 1);
    tick();
    expect(
      mgr
        .getRunsForCronjob(job.id)
        .map((r) => r.status)
        .sort(),
    ).toEqual(["running", "skipped"]);
    gate.resolve(null);
    await waitFor(() => fake.createSessionCount === 1, "session start");
    closeAll(fake);
  });

  // MUTANT: deleteCronjob without the preparing owners (dies on the status),
  // or goOn() without owns() (dies on the session count).
  it("ends a run deleted in the gap as failed and starts nothing", async () => {
    const gate = deferred<LogText | null>();
    const { mgr, fake } = manager({ memberLimitRefusal: () => gate.promise });
    const job = mgr.addCronjob(input());
    const run = mgr.runCronjobNow(job.id, "Alice")!;
    await settle();
    expect(mgr.deleteCronjob(job.id)).toBe(true);
    gate.resolve(null);
    await settle();
    expect(fake.createSessionCount).toBe(0);
    const ended = mgr.findRun(job.id, run.id);
    expect(ended === null || ended.status === "failed").toBe(true);
  });

  // MUTANT: goOn() without the stop check (dies on the session count).
  it("starts nothing when the server stops in the gap, and leaves the row for the next boot", async () => {
    const gate = deferred<LogText | null>();
    let stopping = false;
    const { mgr, fake } = manager({
      memberLimitRefusal: () => gate.promise,
      isStopping: () => stopping,
    });
    const job = mgr.addCronjob(input());
    const run = mgr.runCronjobNow(job.id, "Alice")!;
    await settle();
    stopping = true;
    gate.resolve(null);
    await settle();
    expect(fake.createSessionCount).toBe(0);
    expect(mgr.findRun(job.id, run.id)?.status).toBe("running");
  });

  // MUTANT: no memberHostConnected check (dies on the reason: the folder
  // check answers first with the host's error).
  it("ends the run failed with the not-ready reason while her runner is not connected", async () => {
    const made = createMember(`CronBob${Date.now()}`, { role: "member" });
    if (!made.ok) throw new Error(made.error);
    const bob = made.user.id;
    recordMemberOsUser(bob, { name: "isomux-test-bob", uid: 4747 });
    try {
      const { mgr, fake, calls } = manager();
      const job = mgr.addCronjob(
        input({ userId: bob, username: "Bob", cwd: tmp("bob-job-") }),
      );
      const run = mgr.runCronjobNow(job.id, "Bob")!;
      await waitFor(
        () => mgr.findRun(job.id, run.id)?.status !== "running",
        "run end",
      );
      const ended = mgr.findRun(job.id, run.id)!;
      expect([
        ended.status,
        fake.createSessionCount,
        calls.memberLimit,
      ]).toEqual(["failed", 0, 0]);
      expect(ended.errorReason).toBe(
        renderLogText(
          english,
          msg("systemEntries.scheduleRun.startNotReady", { member: "Bob" }),
        ),
      );
    } finally {
      forgetMemberOsUser(bob);
      deleteUserById(bob);
    }
  });

  // MUTANT: the member start without agentCwdProblem (dies: a session
  // starts in a missing folder).
  it("ends the run failed in a missing folder, and frees its slot", async () => {
    const { mgr, fake } = manager();
    const dir = tmp("member-gone-");
    const job = mgr.addCronjob(input({ cwd: dir }));
    rmSync(dir, { recursive: true, force: true });
    const run = mgr.runCronjobNow(job.id, "Alice")!;
    await waitFor(
      () => mgr.findRun(job.id, run.id)?.status !== "running",
      "run end",
    );
    const ended = mgr.findRun(job.id, run.id)!;
    expect([ended.status, fake.createSessionCount]).toEqual(["failed", 0]);
    expect(ended.errorReason).toContain(dir);
    // The slot is free: the next fire records a new run, not a skip.
    mkdirSync(dir);
    const next = mgr.runCronjobNow(job.id, "Alice")!;
    expect(next.id).not.toBe(run.id);
    await waitFor(() => fake.createSessionCount === 1, "session start");
    closeAll(fake);
  });

  // MUTANT: startMemberRun without its catch (the row stays running and
  // the tick records a skip).
  it("ends the run failed when a check throws, and frees its slot", async () => {
    const { mgr, fake, sched, setNow } = manager({
      memberLimitRefusal: async () => {
        throw new Error("check broke");
      },
    });
    const job = mgr.addCronjob(input());
    const run = mgr.runCronjobNow(job.id, "Alice")!;
    await waitFor(
      () => mgr.findRun(job.id, run.id)?.status !== "running",
      "run end",
    );
    expect(mgr.findRun(job.id, run.id)?.status).toBe("failed");
    mgr.startCronjobScheduler();
    setNow(job.nextFireAt! + 1);
    sched.intervals[0].fn();
    expect(
      mgr.getRunsForCronjob(job.id).filter((r) => r.status === "skipped"),
    ).toEqual([]);
    expect(fake.createSessionCount).toBe(0);
  });

  // MUTANT: a webhook fire that skips the member branch.
  it("takes the same path for a webhook fire", async () => {
    const gate = deferred<LogText | null>();
    const { mgr, fake } = manager({ memberLimitRefusal: () => gate.promise });
    const job = mgr.addCronjob(input());
    const run = mgr.runCronjobFromWebhook(
      job.id,
      {
        webhookId: "wh_0123456789abcdef",
        webhookName: "hook",
        deliveryRowId: "d_00000001",
      },
      "block",
    )!;
    expect(run.status).toBe("running");
    await settle();
    expect(fake.createSessionCount).toBe(0);
    gate.resolve(null);
    await waitFor(() => fake.createSessionCount === 1, "session start");
    closeAll(fake);
  });
});

describe("the first prompt of a member's session run", () => {
  // Task 300166c2: the prompt (any agent can edit it) and a webhook's data
  // block reach the engine with every file mention defused.
  it("reaches the engine defused, while the run keeps the prompt as written", async () => {
    const { mgr, fake } = manager();
    const job = mgr.addCronjob(
      input({ prompt: `summarize this\n${MENTION_BODY}` }),
    );
    const run = mgr.runCronjobFromWebhook(
      job.id,
      {
        webhookId: "wh_0123456789abcdef",
        webhookName: "hook",
        deliveryRowId: "d_00000001",
      },
      '<webhook-data>\n{"file":"@/srv/canary/hook.json"}\n</webhook-data>',
    )!;
    await waitFor(() => fake.createSessionCount === 1, "session start");
    await waitFor(() => !!fake.lastSession?.sent.length, "first prompt");
    const sent = fake.lastSession!.sent[0].text;
    expect(sent).toContain("session.json");
    expect(sent).toContain("hook.json");
    expect(claudeFileMentions(sent)).toEqual([]);
    expect(mgr.findRun(job.id, run.id)?.promptSnapshot).toContain(MENTION_BODY);
    closeAll(fake);
  });
});

describe("a member's command run", () => {
  // The member's command-run checks, when one throws: the run must end, not
  // stay running with its slot held.
  it("ends failed when a check throws, and frees its slot", async () => {
    const commands: string[] = [];
    const { mgr } = manager({
      memberLimitRefusal: async () => {
        throw new Error("check broke");
      },
      runCommand: (job) => {
        commands.push(job.command ?? "");
        return Promise.resolve({
          done: Promise.resolve({
            exitCode: 0,
            signal: null,
            timedOut: false,
            durationMs: 1,
            output: "",
          } as AskRunResult),
        });
      },
      deliverToAgent: async () => ({
        ok: true,
        messageId: "m-1",
        agentName: "Pat",
      }),
    });
    const job = mgr.addCronjob(
      input({
        target: { kind: "agent", agentId: "agent-1700000000000-abcd" },
        command: "true",
      }),
    );
    const run = mgr.runCronjobNow(job.id, "Alice")!;
    await settle();
    expect([mgr.findRun(job.id, run.id)?.status, commands]).toEqual([
      "failed",
      [],
    ]);
  });
});

describe("a send into a member's run", () => {
  // MUTANT: memberRunFolderCheck without the release on a refusal (dies:
  // the second send is busy).
  it("claims first, refuses a missing folder, and frees the claim", async () => {
    const { mgr, fake } = manager();
    const dir = tmp("member-send-");
    const job = mgr.addCronjob(input({ cwd: dir }));
    const run = mgr.runCronjobNow(job.id, "Alice")!;
    await waitFor(
      () => mgr.findRun(job.id, run.id)?.status === "completed",
      "run done",
    );
    rmSync(dir, { recursive: true, force: true });
    const [first, second] = await Promise.all([
      mgr.sendRunMessage(job.id, run.id, "again", "Alice"),
      mgr.sendRunMessage(job.id, run.id, "again", "Alice"),
    ]);
    // One claim at a time: the second, sent while the first checks, is busy.
    expect([first.ok, second]).toMatchObject([
      false,
      { ok: false, code: "run_busy" },
    ]);
    const third = await mgr.sendRunMessage(job.id, run.id, "again", "Alice");
    expect(third).toMatchObject({ ok: false });
    expect((third as { code?: string }).code).not.toBe("run_busy");
    closeAll(fake);
  });
});

describe("the folder limits of a member", () => {
  // MUTANT: folderInsideFor with the office's realpath (dies: the office
  // cannot see her link the same way) or without the host (dies on the
  // not-ready member).
  it("resolve her links as her: a link out of the agent folder is outside", async () => {
    const agentDir = join(iso.home, "work");
    mkdirSync(join(agentDir, "sub"), { recursive: true });
    const outside = tmp("member-outside-");
    symlinkSync(outside, join(agentDir, "out"));
    expect(await folderInsideFor(join(agentDir, "sub"), agentDir, alice)).toBe(
      true,
    );
    expect(await folderInsideFor("~/work/sub", "~/work", alice)).toBe(true);
    expect(await folderInsideFor(join(agentDir, "out"), agentDir, alice)).toBe(
      false,
    );
    const child = {
      agentType: "claude" as const,
      permissionMode: "default" as const,
      cwd: join(agentDir, "out"),
    };
    const spawner = { ...child, cwd: agentDir };
    expect(await spawnExceedsAgentFor(child, spawner, alice)).not.toBeNull();
    expect(
      await spawnExceedsAgentFor(
        { ...child, cwd: join(agentDir, "sub") },
        spawner,
        alice,
      ),
    ).toBeNull();
  });

  it("is outside for a member whose host is not ready, never the office's answer", async () => {
    const made = createMember(`CronCarol${Date.now()}`, { role: "member" });
    if (!made.ok) throw new Error(made.error);
    const carol = made.user.id;
    recordMemberOsUser(carol, { name: "isomux-test-carol2", uid: 4848 });
    try {
      const dir = tmp("carol-");
      mkdirSync(join(dir, "sub"));
      expect(await folderInsideFor(join(dir, "sub"), dir, carol)).toBe(false);
      // The enabling condition: the office's own answer is inside.
      expect(await folderInsideFor(join(dir, "sub"), dir, null)).toBe(true);
    } finally {
      forgetMemberOsUser(carol);
      deleteUserById(carol);
    }
  });
});

// Task b94dfd25 4b: a schedule run of a member with their own OS user runs as
// that user, and its prompt says so in one line. No run's prompt names the
// office's files: a run reads no schedule (a cron run identity has no
// cron:read), and a member's run cannot read the office's state root.
describe("the prompt of a schedule run", () => {
  const line = ownOsUserLine("the member");
  const stateRoot = STATE_ROOT.replace(/\/+$/, "");

  it("of a member with their own OS user has the line; an office run's does not", () => {
    const { mgr } = manager();
    const hers = mgr.addCronjob(input());
    const office = mgr.addCronjob(
      input({ userId: undefined, username: "Nil", cwd: tmp("office-job-") }),
    );
    const herPrompt = mgr.buildCronjobSystemPrompt(hers);
    const officePrompt = mgr.buildCronjobSystemPrompt(office);
    expect(herPrompt.split(line)).toHaveLength(2);
    expect(officePrompt).not.toContain(line);
    for (const [who, prompt] of [
      ["member", herPrompt],
      ["office", officePrompt],
    ] as const) {
      expect({ who, files: /\.isomux\//.test(prompt) }).toEqual({
        who,
        files: false,
      });
      expect({ who, root: prompt.includes(stateRoot) }).toEqual({
        who,
        root: false,
      });
    }
  });
});

// Task 56b68f0f: a schedule run of an isolated member with no sign-in of
// her own runs on the office sign-in in her own space, as her agents do
// (server/office-login-sync.ts): a Claude run after a sync of her file, a
// Codex run with the office login. With a sign-in of her own, neither.
describe("a member's run on the office sign-in", () => {
  const AUTH: OfficeAuth = {
    tokens: async () => ({
      accessToken: "office-codex-access",
      chatgptAccountId: "acct-office",
      chatgptPlanType: "plus",
    }),
    refresh: async () => {
      throw new Error("not used");
    },
  };
  function recordingSync(fake: () => FakeBackend | undefined) {
    const calls: { op: string; userId: string; sessions: number }[] = [];
    const sessions = () => fake()?.createSessionCount ?? 0;
    const sync: OfficeLoginSync = {
      syncClaude: async (userId) => {
        calls.push({ op: "claude", userId, sessions: sessions() });
      },
      prepareCodex: async (userId) => {
        calls.push({ op: "codex", userId, sessions: sessions() });
      },
      codexOfficeAuth: () => AUTH,
      start: () => {},
      close: () => {},
    };
    return { sync, calls };
  }
  let restore: ReturnType<typeof setPersonalProviderActiveProvider>;
  const personal = { claude: false, codex: false };
  beforeEach(() => {
    personal.claude = false;
    personal.codex = false;
    restore = setPersonalProviderActiveProvider(
      (userId, provider) => userId === alice && personal[provider] === true,
    );
  });
  afterEach(() => setPersonalProviderActiveProvider(restore));

  for (const agentType of ["claude", "codex"] as const)
    for (const own of [false, true])
      it(`${agentType}, ${own ? "with" : "with no"} sign-in of her own: ${own ? "her own, with no office login" : "her member office folder, after the office login is ready"}`, async () => {
        personal[agentType] = own;
        const ref: { fake?: FakeBackend } = {};
        const rec = recordingSync(() => ref.fake);
        const made = manager({
          resolveEnv: buildEnvForUserId,
          officeLoginSync: rec.sync,
        });
        ref.fake = made.fake;
        const job = made.mgr.addCronjob(
          input({
            agentType,
            modelFamily: agentType === "codex" ? "gpt" : "opus",
          }),
        );
        made.mgr.runCronjobNow(job.id, "Alice");
        await waitFor(
          () => made.fake.createSessionCount === 1,
          "session start",
        );
        const s = made.fake.sessions[0]!;
        const officeFolder =
          agentType === "claude"
            ? join(iso.home, ".claude")
            : join(iso.member.host.agentRoot(), "codex-home");
        expect({
          dir: effectiveProviderDirectory(agentType, s.opts.env ?? {}),
          login: s.opts.officeAuth === AUTH,
          prepared: rec.calls.some(
            (c) => c.op === agentType && c.userId === alice && c.sessions === 0,
          ),
        }).toEqual({
          dir: own ? personalProviderHome(alice, agentType) : officeFolder,
          login: !own && agentType === "codex",
          prepared: !own,
        });
        closeAll(made.fake);
      });

  // A follow-up resumes a finished run in her member office folder: the
  // file is written (Claude) or her own auth.json moved out (Codex) before
  // the session resumes, as at the run's start.
  for (const agentType of ["claude", "codex"] as const)
    it(`${agentType}: a follow-up into her run resumes after the office login is ready`, async () => {
      const ref: { fake?: FakeBackend } = {};
      const calls: { op: string; resumes: number }[] = [];
      const sync: OfficeLoginSync = {
        syncClaude: async () => {
          calls.push({ op: "claude", resumes: ref.fake!.resumeSessionCount });
        },
        prepareCodex: async () => {
          calls.push({ op: "codex", resumes: ref.fake!.resumeSessionCount });
        },
        codexOfficeAuth: () => AUTH,
        start: () => {},
        close: () => {},
      };
      const made = manager({
        resolveEnv: buildEnvForUserId,
        officeLoginSync: sync,
      });
      ref.fake = made.fake;
      const job = made.mgr.addCronjob(
        input({
          agentType,
          modelFamily: agentType === "codex" ? "gpt" : "opus",
        }),
      );
      const run = made.mgr.runCronjobNow(job.id, "Alice")!;
      await waitFor(
        () => made.mgr.findRun(job.id, run.id)?.status === "completed",
        "run done",
      );
      // The conversation on disk in her member office folder, as the engine
      // writes it.
      const sid = made.fake.sessions[0]!.sessionId;
      const file =
        agentType === "claude"
          ? join(
              claudeProjectDir(job.cwd, {
                CLAUDE_CONFIG_DIR: join(iso.home, ".claude"),
              }),
              `${sid}.jsonl`,
            )
          : join(
              iso.member.host.agentRoot(),
              "codex-home",
              "sessions",
              "2026",
              "11",
              "17",
              `rollout-2026-11-17T10-00-00-${sid}.jsonl`,
            );
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "{}\n");
      calls.length = 0;
      const sent = await made.mgr.sendRunMessage(
        job.id,
        run.id,
        "again",
        "Alice",
      );
      // The enabling condition: the follow-up resumed the run's session.
      expect(sent.ok).toBe(true);
      await waitFor(() => made.fake.resumeSessionCount === 1, "resumed");
      expect(calls.some((c) => c.op === agentType && c.resumes === 0)).toBe(
        true,
      );
      closeAll(made.fake);
    });
});
