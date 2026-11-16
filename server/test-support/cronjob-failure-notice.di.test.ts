// A failing schedule tells someone (task 420faed7), driven through the
// manager with a fake backend, a fake clock and an in-memory store: an
// unattended run that fails reports at the first failure in a row and after
// every 5 more, a completed run clears, and a run a usage limit stopped makes
// the job wait for the reset, also across a restart. The notice text and its
// route are in ../cronjob-failure-notice.test.ts.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { makeFakeCronPersistence } from "./fake-cron-persistence.ts";
import { _testResetTokens } from "../identity/tokens.ts";
import { STATE_ROOT } from "../config.ts";
import { expectWordedText } from "./worded.ts";
import type { Cronjob, CronjobRun } from "../../shared/types.ts";
import { createCronjobManager } from "../cronjob-manager.ts";
import type { FailureNotice } from "../cronjob-failure-notice.ts";
type CronDeps = Parameters<typeof createCronjobManager>[0];
type CronEvent = Parameters<NonNullable<CronDeps["eventSink"]>>[0];
type Manager = ReturnType<typeof createCronjobManager>;
type AddCronjobInput = Parameters<Manager["addCronjob"]>[0];
type Deliver = NonNullable<CronDeps["deliverToAgent"]>;

const T0 = 1_000_000;
const HOUR = 3_600_000;
const AGENT = "agent-1700000000000-abcd";
const LINK = {
  webhookId: "wh_0123456789abcdef",
  webhookName: "pr-review",
  deliveryRowId: "d_00000001",
};
const BLOCK = "Webhook block";

async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out: ${label}`);
}
const settle = () => new Promise((r) => setTimeout(r, 25));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// What each prompt send of the fake does, in order. A send with no step
// left stays in flight.
type Step = "fail" | "ok" | { limitResetsAt: number };

function fakeScheduler() {
  const intervals: (() => void)[] = [];
  const scheduler: CronDeps["scheduler"] = {
    setTimeout: (() => 0) as unknown as typeof setTimeout,
    clearTimeout: () => {},
    setInterval: ((fn: () => void) => {
      intervals.push(fn);
      return intervals.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: () => {},
  };
  return { scheduler, tick: () => intervals[0]() };
}

function jobInput(over: Partial<AddCronjobInput> = {}): AddCronjobInput {
  return {
    name: "Mark main",
    schedule: { type: "interval", minutes: 60 },
    prompt: "do the thing",
    cwd: STATE_ROOT,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    username: "Nil",
    ...over,
  };
}

const sessions: FakeSession[][] = [];
afterEach(() => {
  for (const list of sessions.splice(0)) list.forEach((s) => s.close());
  _testResetTokens();
});

// One office: a manager on `persistence`, started like a boot. `clock` is
// shared so a reboot keeps the time.
function office(opts: {
  persistence?: CronDeps["persistence"];
  clock?: { t: number };
  steps?: Step[];
  over?: Partial<CronDeps>;
}) {
  const persistence = opts.persistence ?? makeFakeCronPersistence();
  const clock = opts.clock ?? { t: T0 };
  const steps = opts.steps ?? [];
  const reports: { jobId: string; notice: FailureNotice }[] = [];
  const clears: string[] = [];
  const events: CronEvent[] = [];
  const fake = new FakeBackend({
    session: {
      onSend: (_text, _att, s) => {
        const step = steps.shift();
        if (step === undefined) return;
        if (step === "ok") s.completeTurn({ text: "done" });
        else if (step === "fail")
          s.completeTurn({ status: "failed", error: "boom" });
        else {
          s.push({ kind: "usage_limit_stop", resetsAtMs: step.limitResetsAt });
          s.completeTurn({ status: "failed" });
        }
      },
    },
  });
  sessions.push(fake.sessions);
  const sched = fakeScheduler();
  const mgr = createCronjobManager({
    resolveBackend: () => fake,
    resolveEnv: () => ({}),
    resolveEnvironmentKey: () => "test-environment",
    resolveEnvironmentRevision: () => "test-revision",
    resolveUser: () => undefined,
    persistence,
    clock: { now: () => clock.t },
    scheduler: sched.scheduler,
    renderMemoryForPrompt: () => null,
    eventSink: (e) => events.push(clone(e)),
    reportFailure: (job, notice) => reports.push({ jobId: job.id, notice }),
    clearFailure: (job) => clears.push(job.id),
    ...opts.over,
  });
  mgr.startCronjobScheduler();
  const jobNow = (id: string): Cronjob =>
    mgr.listCronjobs().find((j) => j.id === id)!;
  const runs = (id: string): CronjobRun[] => mgr.getRunsForCronjob(id);
  const lastRun = (id: string) => runs(id).at(-1)!;
  // Moves the clock just past the job's next slot and ticks; waits for the
  // run that tick started to end.
  async function fireScheduled(id: string) {
    const before = runs(id).length;
    clock.t = jobNow(id).nextFireAt! + 1;
    sched.tick();
    expect(runs(id).length).toBe(before + 1);
    expect(lastRun(id).trigger).toBe("scheduled");
    await waitFor(() => lastRun(id).status !== "running", "run ended");
    await settle();
    return lastRun(id);
  }
  // Like a restart: a new manager on a copy of the stored state.
  // `persistenceOver` replaces store functions for the new manager only (it
  // binds them at construction).
  function reboot(
    more: Omit<Parameters<typeof office>[0], "persistence" | "clock"> & {
      persistenceOver?: Partial<CronDeps["persistence"]>;
    } = {},
  ) {
    persistence.saveCronjobs(clone(persistence.loadCronjobs()));
    for (const id of persistence.listAllCronjobIdsOnDisk())
      persistence.saveRuns(id, clone(persistence.loadRuns(id)));
    const { persistenceOver, ...rest } = more;
    return office({
      ...rest,
      persistence: { ...persistence, ...persistenceOver },
      clock,
    });
  }
  return {
    mgr,
    fake,
    persistence,
    clock,
    steps,
    reports,
    clears,
    events,
    tick: sched.tick,
    jobNow,
    runs,
    lastRun,
    fireScheduled,
    reboot,
  };
}

describe("a failing schedule reports, then every 5 failures in a row", () => {
  it("reports the 1st and the 6th scheduled failure, not the 2nd to 5th", async () => {
    const o = office({ steps: Array(7).fill("fail") });
    const job = o.mgr.addCronjob(jobInput());
    const counts: number[] = [];
    for (let i = 0; i < 7; i++) {
      const run = await o.fireScheduled(job.id);
      expect(run.status).toBe("failed");
      counts.push(o.reports.length);
    }
    expect(counts).toEqual([1, 1, 1, 1, 1, 2, 2]);
    expect(o.reports.map((r) => r.jobId)).toEqual([job.id, job.id]);
    expect(o.reports[0].notice.body).toContain("boom");
    expect(o.clears.length).toBe(0);
  });

  it("a completed scheduled run clears and starts the count again", async () => {
    const o = office({ steps: ["fail", "fail", "ok", "fail"] });
    const job = o.mgr.addCronjob(jobInput());
    await o.fireScheduled(job.id);
    await o.fireScheduled(job.id);
    expect(o.reports.length).toBe(1);
    expect((await o.fireScheduled(job.id)).status).toBe("completed");
    expect(o.clears).toEqual([job.id]);
    await o.fireScheduled(job.id);
    expect(o.reports.length).toBe(2);
  });

  it("a Run now that fails reports nothing; one that completes clears and starts the count again", async () => {
    const o = office({ steps: ["fail", "fail", "ok", "fail"] });
    const job = o.mgr.addCronjob(jobInput());
    await o.fireScheduled(job.id);
    expect(o.reports.length).toBe(1);
    const manualFail = o.mgr.runCronjobNow(job.id, "Nil")!;
    await waitFor(
      () => o.mgr.findRun(job.id, manualFail.id)?.status === "failed",
      "manual run failed",
    );
    await settle();
    expect(o.reports.length).toBe(1);
    const manualOk = o.mgr.runCronjobNow(job.id, "Nil")!;
    await waitFor(
      () => o.mgr.findRun(job.id, manualOk.id)?.status === "completed",
      "manual run completed",
    );
    await settle();
    expect(o.clears).toEqual([job.id]);
    await o.fireScheduled(job.id);
    expect(o.reports.length).toBe(2);
  });

  it("a webhook run that fails reports", async () => {
    const o = office({ steps: ["fail"] });
    const job = o.mgr.addCronjob(jobInput());
    const run = o.mgr.runCronjobFromWebhook(job.id, LINK, BLOCK)!;
    await waitFor(
      () => o.mgr.findRun(job.id, run.id)?.status === "failed",
      "webhook run failed",
    );
    await settle();
    expect(o.reports.map((r) => r.jobId)).toEqual([job.id]);
  });

  it("a run that fails at its start (missing folder) reports", async () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-cron-notice-"));
    try {
      const o = office({});
      const job = o.mgr.addCronjob(jobInput({ cwd: join(root, "gone") }));
      const run = await o.fireScheduled(job.id);
      expect(run.status).toBe("failed");
      expect(o.fake.createSessionCount).toBe(0);
      expect(o.reports.map((r) => r.jobId)).toEqual([job.id]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a scheduled message to an agent that is gone reports", async () => {
    let sends = 0;
    const deliverToAgent: Deliver = async () => {
      sends++;
      return { ok: false, reason: "That agent no longer exists." };
    };
    const o = office({ over: { deliverToAgent } });
    const job = o.mgr.addCronjob(
      jobInput({ target: { kind: "agent", agentId: AGENT } }),
    );
    const run = await o.fireScheduled(job.id);
    expect(sends).toBe(1);
    expect(run.status).toBe("failed");
    expect(o.reports.map((r) => r.jobId)).toEqual([job.id]);
  });
});

describe("every way a run fails at its start reports", () => {
  it("a session whose environment cannot be read reports", async () => {
    const o = office({
      over: {
        resolveEnv: () => {
          throw new Error("bad env file");
        },
      },
    });
    const job = o.mgr.addCronjob(jobInput());
    const run = await o.fireScheduled(job.id);
    expect(run.status).toBe("failed");
    expect(o.fake.createSessionCount).toBe(0);
    expect(o.reports.map((r) => r.jobId)).toEqual([job.id]);
  });

  it("a session that cannot be created reports", async () => {
    const broken = Object.create(new FakeBackend()) as FakeBackend;
    broken.createSession = () => {
      throw new Error("spawn failed");
    };
    const b = office({ over: { resolveBackend: () => broken } });
    const job = b.mgr.addCronjob(jobInput());
    const run = await b.fireScheduled(job.id);
    expect(run.status).toBe("failed");
    expect(b.reports.map((r) => r.jobId)).toEqual([job.id]);
  });

  it("a command job the limits refuse reports", async () => {
    const o = office({
      over: { limitRefusal: () => "Refused by the limits." },
    });
    const job = o.mgr.addCronjob(
      jobInput({ target: { kind: "agent", agentId: AGENT }, command: "true" }),
    );
    const run = await o.fireScheduled(job.id);
    expect(run.status).toBe("failed");
    expect(run.commandSnapshot).toBe("true");
    expect(o.reports.map((r) => r.jobId)).toEqual([job.id]);
  });
});

describe("a run end reports once, and only at its first end", () => {
  it("a follow-up on a failed scheduled run that fails again reports nothing more", async () => {
    const o = office({ steps: ["fail", "fail"] });
    const job = o.mgr.addCronjob(jobInput());
    const run = await o.fireScheduled(job.id);
    expect(o.reports.length).toBe(1);
    o.clock.t += 1_000;
    const sent = await o.mgr.sendRunMessage(job.id, run.id, "again", "Nil");
    expect(sent.ok).toBe(true);
    // The ENABLING CONDITION: the follow-up resumed the run, and the row
    // ended again, still a scheduled row.
    expect(o.fake.resumeSessionCount).toBe(1);
    await waitFor(
      () =>
        o.events.filter(
          (e) =>
            e.type === "cronjob_run_updated" &&
            e.run.id === run.id &&
            e.run.status === "failed",
        ).length === 2,
      "the follow-up ended the run",
    );
    await settle();
    expect(o.lastRun(job.id).trigger).toBe("scheduled");
    expect(o.reports.length).toBe(1);
  });

  it("after a restart, a refused follow-up that puts a failed scheduled run back reports nothing", async () => {
    const a = office({ steps: ["fail"] });
    const job = a.mgr.addCronjob(jobInput());
    const run = await a.fireScheduled(job.id);
    expect(a.reports.length).toBe(1);

    // The restarted office cannot write the follow-up to the transcript.
    const b = a.reboot({ persistenceOver: { appendRunLog: () => false } });
    b.clock.t += 1_000;
    const sent = await b.mgr.sendRunMessage(job.id, run.id, "again", "Nil");
    // The ENABLING CONDITION: the run was reopened and then put back to
    // its failed end, and both were announced.
    expect(sent.ok).toBe(false);
    expect(
      b.events
        .filter((e) => e.type === "cronjob_run_updated" && e.run.id === run.id)
        .map((e) => (e as { run: CronjobRun }).run.status),
    ).toEqual(["running", "failed"]);
    await settle();
    expect(b.reports.length).toBe(0);
    expect(b.clears.length).toBe(0);
  });

  it("a run a restart cut does not shift the count: the next failure is the first", async () => {
    // Office A starts a run that never ends; the restart ends it.
    const a = office({});
    const job = a.mgr.addCronjob(jobInput());
    a.clock.t = a.jobNow(job.id).nextFireAt! + 1;
    a.tick();
    expect(a.lastRun(job.id).status).toBe("running");

    const b = a.reboot({ steps: ["fail"] });
    // The ENABLING CONDITION: the boot ended the cut run as failed.
    const cut = b.runs(job.id)[0];
    expect(cut.status).toBe("failed");
    expectWordedText(
      cut.errorReason ?? undefined,
      cut.errorReasonMessage,
      "systemEntries.scheduleRun.serverRestarted",
    );
    expect(b.reports.length).toBe(0);
    await b.fireScheduled(job.id);
    expect(b.reports.map((r) => r.jobId)).toEqual([job.id]);
  });

  it("deleting a job with a scheduled run in flight reports nothing", async () => {
    const o = office({});
    const job = o.mgr.addCronjob(jobInput());
    o.clock.t = o.jobNow(job.id).nextFireAt! + 1;
    o.tick();
    await settle();
    const run = o.lastRun(job.id);
    expect(run.status).toBe("running");
    expect(o.mgr.deleteCronjob(job.id)).toBe(true);
    await settle();
    // The ENABLING CONDITION: the deletion ended the run failed.
    expect(o.mgr.findRun(job.id, run.id)?.status).toBe("failed");
    expect(o.reports.length).toBe(0);
    expect(o.clears.length).toBe(0);
  });
});

describe("a notice that throws does not break the run's end", () => {
  it("a throwing reportFailure leaves one error line, and the start-failure tick does not throw", async () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-cron-notice-"));
    try {
      let calls = 0;
      const o = office({
        steps: ["fail"],
        over: {
          reportFailure: () => {
            calls++;
            throw new Error("pager down");
          },
        },
      });
      const job = o.mgr.addCronjob(jobInput());
      const run = await o.fireScheduled(job.id);
      expect(calls).toBe(1);
      expect(run.status).toBe("failed");
      // Only the turn's own error line. The stream consumer drops a throw
      // after the run's end, so this part cannot see a missing catch; the
      // tick below is where such a throw escapes (to the setInterval).
      const errorLines = o.events.filter(
        (e) => e.type === "log_entry" && e.entry.kind === "error",
      );
      expect(errorLines.length).toBe(1);

      const gone = o.mgr.addCronjob(
        jobInput({ name: "Gone", cwd: join(root, "gone") }),
      );
      o.clock.t = o.jobNow(gone.id).nextFireAt! + 1;
      // A throw out of the tick fails the test here.
      o.tick();
      await settle();
      expect(calls).toBe(2);
      expect(o.lastRun(gone.id).status).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a throwing clearFailure leaves the completed run as it is", async () => {
    let calls = 0;
    const o = office({
      steps: ["ok"],
      over: {
        clearFailure: () => {
          calls++;
          throw new Error("asks down");
        },
      },
    });
    const job = o.mgr.addCronjob(jobInput());
    const run = await o.fireScheduled(job.id);
    expect(calls).toBe(1);
    expect(run.status).toBe("completed");
    expect(
      o.events.filter((e) => e.type === "log_entry" && e.entry.kind === "error")
        .length,
    ).toBe(0);
  });
});

describe("a run a usage limit stopped makes the job wait for the reset", () => {
  // Hourly job; the limit resets 5.5 hours after the fire, so the first
  // slot at or after the reset is the 6th hour after the fire.
  async function stoppedByLimit() {
    const o = office({});
    const job = o.mgr.addCronjob(jobInput());
    const firedAt = o.jobNow(job.id).nextFireAt! + 1;
    const resetsAt = firedAt + 5.5 * HOUR;
    o.steps.push({ limitResetsAt: resetsAt });
    const run = await o.fireScheduled(job.id);
    expect(run.status).toBe("failed");
    expect(o.clock.t).toBe(firedAt);
    return { o, job, firedAt, resetsAt, waitSlot: firedAt + 6 * HOUR };
  }

  it("moves the next run to the first slot after the reset, and the notice names the reset", async () => {
    const { o, job, resetsAt, waitSlot } = await stoppedByLimit();
    expect(o.jobNow(job.id).nextFireAt).toBe(waitSlot);
    expect(o.jobNow(job.id).limitWaitUntil).toBe(resetsAt);
    // The UI hears about the new slot.
    const announced = o.events
      .filter((e) => e.type === "cronjob_updated")
      .map((e) => (e as { cronjob: Cronjob }).cronjob.nextFireAt);
    expect(announced.at(-1)).toBe(waitSlot);
    expect(o.reports.length).toBe(1);
    expect(o.reports[0].notice.body).toContain(
      new Date(resetsAt).toISOString(),
    );
  });

  it("the slots before the reset fire nothing, the wait slot fires, and the wait is then dropped", async () => {
    const { o, job, firedAt, waitSlot } = await stoppedByLimit();
    const before = o.runs(job.id).length;
    for (let h = 1; h <= 5; h++) {
      o.clock.t = firedAt + h * HOUR + 1;
      o.tick();
    }
    expect(o.runs(job.id).length).toBe(before);
    o.steps.push("ok");
    const run = await o.fireScheduled(job.id);
    expect(run.startedAt).toBe(waitSlot + 1);
    expect(o.jobNow(job.id).limitWaitUntil).toBeUndefined();
    expect(o.jobNow(job.id).nextFireAt).toBe(waitSlot + 1 + HOUR);
  });

  it("the wait survives a restart", async () => {
    const { o, job, firedAt, waitSlot } = await stoppedByLimit();
    const b = o.reboot();
    expect(b.jobNow(job.id).nextFireAt).toBe(waitSlot);
    const before = b.runs(job.id).length;
    b.clock.t = firedAt + HOUR + 1;
    b.tick();
    expect(b.runs(job.id).length).toBe(before);
  });

  it("a member's change of the schedule drops the wait", async () => {
    const { o, job, firedAt } = await stoppedByLimit();
    o.mgr.updateCronjob(job.id, {
      schedule: { type: "interval", minutes: 30 },
    });
    expect(o.jobNow(job.id).limitWaitUntil).toBeUndefined();
    expect(o.jobNow(job.id).nextFireAt!).toBeLessThan(firedAt + HOUR);
  });

  it("a Run now that a usage limit stops also moves the next scheduled run", async () => {
    const o = office({});
    const job = o.mgr.addCronjob(jobInput());
    const slot = o.jobNow(job.id).nextFireAt!;
    const resetsAt = slot + 2.5 * HOUR;
    o.steps.push({ limitResetsAt: resetsAt });
    const run = o.mgr.runCronjobNow(job.id, "Nil")!;
    await waitFor(
      () => o.mgr.findRun(job.id, run.id)?.status === "failed",
      "manual run failed",
    );
    await settle();
    expect(o.jobNow(job.id).nextFireAt!).toBeGreaterThanOrEqual(resetsAt);
    expect(o.jobNow(job.id).limitWaitUntil).toBe(resetsAt);
    // A manual failure tells nobody.
    expect(o.reports.length).toBe(0);
  });
});
